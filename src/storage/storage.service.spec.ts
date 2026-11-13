import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { ServiceUnavailableException } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import { BackgroundRemovalService } from './background-removal.service.js';
import { MAX_IMAGE_BYTES } from './image-validation.js';
import sharp from 'sharp';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=',
  'base64',
);
const file = (changes: Partial<Express.Multer.File> = {}) =>
  ({
    originalname: '../../unsafe.exe',
    mimetype: 'image/png',
    buffer: image,
    size: image.length,
    ...changes,
  }) as Express.Multer.File;

describe('StorageService', () => {
  let storage: StorageService;
  const send = vi.spyOn(S3Client.prototype, 'send');
  beforeEach(() => {
    send.mockReset().mockResolvedValue({} as never);
    storage = new StorageService(
      new ConfigService({
        R2_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
        R2_ACCESS_KEY_ID: 'test-access-key',
        R2_SECRET_ACCESS_KEY: 'test-secret-key',
        R2_BUCKET_NAME: 'test-bucket',
      }),
    );
  });
  afterEach(() => storage.onModuleDestroy());

  it('uploads bytes with content type, a UUID safe extension, and no public URL', async () => {
    const result = await storage.upload(file(), 'test');
    expect(result).toEqual({
      key: expect.stringMatching(/^test\/[0-9a-f-]{36}\.png$/),
    });
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: 'test-bucket',
      Key: result.key,
      Body: image,
      ContentType: 'image/png',
    });
  });

  it('defaults to uploads and generates unique filenames', async () => {
    const first = await storage.upload(file());
    const second = await storage.upload(file());
    expect(first.key).toMatch(/^uploads\//);
    expect(first.key).not.toBe(second.key);
  });

  it('deletes the exact key in the configured bucket', async () => {
    await storage.delete('test/example.png');
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect((command as DeleteObjectCommand).input).toEqual({
      Bucket: 'test-bucket',
      Key: 'test/example.png',
    });
  });

  it.each([
    file({ buffer: Buffer.alloc(0) }),
    file({ mimetype: 'image/svg+xml' }),
    file({ buffer: Buffer.from('not an image') }),
    file({ mimetype: 'image/jpeg' }),
    file({ size: MAX_IMAGE_BYTES + 1 }),
    file({ buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1) }),
  ])('rejects invalid input before contacting R2', async (input) => {
    await expect(storage.upload(input)).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects missing files', async () => {
    await expect(
      storage.upload(undefined as unknown as Express.Multer.File),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each(['../private', '/test', 'test/../other', 'test?key=secret'])(
    'rejects unsafe folders %s',
    async (folder) => {
      await expect(storage.upload(file(), folder)).rejects.toMatchObject({
        status: 400,
      });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    '../file.png',
    '/test/file.png',
    'https://example.com/image.png',
  ])('rejects unsafe keys %s', async (key) => {
    await expect(storage.delete(key)).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns a sanitized configuration error', async () => {
    const unconfigured = new StorageService(new ConfigService({}));
    await expect(unconfigured.upload(file())).rejects.toThrow(
      'Image storage is not configured',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('copies an image to a new UUID object without changing the source', async () => {
    const result = await storage.copy('designs/source.png', 'orders/order-id');
    expect(result.key).toMatch(/^orders\/order-id\/[a-f0-9-]{36}\.png$/);
    const command = send.mock.calls[0][0] as CopyObjectCommand;
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'test-bucket',
      CopySource: 'test-bucket/designs/source.png',
      Key: result.key,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe copy paths and sanitizes R2 copy failures', async () => {
    await expect(
      storage.copy('../source.png', 'orders/id'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      storage.copy('designs/source.png', '../orders'),
    ).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
    send.mockRejectedValueOnce(new Error('private R2 credentials'));
    await expect(
      storage.copy('designs/source.png', 'orders/id'),
    ).rejects.toThrow('Image copy failed; please try again');
  });

  it.each(['upload', 'delete'])(
    'sanitizes upstream errors for %s',
    async (operation) => {
      send.mockRejectedValueOnce(
        new Error('test-access-key test-secret-key private endpoint'),
      );
      try {
        if (operation === 'upload') await storage.upload(file());
        else await storage.delete('test/example.png');
        expect.fail('Expected an exception');
      } catch (error) {
        expect(error).toMatchObject({ status: 503 });
        expect(String(error)).not.toContain('test-secret-key');
        expect(String(error)).not.toContain('test-access-key');
      }
    },
  );
});

describe('Public image URLs', () => {
  it('handles absent keys, private buckets and normalized public base URLs', () => {
    const config = new ConfigService({
      R2_PUBLIC_URL: 'https://images.example.test/base/',
    });
    const storage = new StorageService(config);
    expect(storage.getPublicUrl()).toBeNull();
    expect(storage.getPublicUrl(null)).toBeNull();
    expect(storage.getPublicUrl('products/image.png')).toBe(
      'https://images.example.test/base/products/image.png',
    );
    config.set('R2_PUBLIC_URL', '');
    expect(storage.getPublicUrl('products/image.png')).toBeNull();
    config.set('R2_PUBLIC_URL', 'https://secret:password@example.test');
    expect(storage.getPublicUrl('products/image.png')).toBeNull();
  });
});

describe('Image delivery preference', () => {
  const key = 'products/a b.png';
  it('returns the direct R2 URL when IMAGE_PROXY_URL is empty or unset', () => {
    for (const proxy of [undefined, '', '   ']) {
      const storage = new StorageService(
        new ConfigService({
          R2_PUBLIC_URL: 'https://cdn.example.test',
          ...(proxy === undefined ? {} : { IMAGE_PROXY_URL: proxy }),
        }),
      );
      expect(storage.getPublicUrl(key)).toBe(
        'https://cdn.example.test/products/a%20b.png',
      );
    }
  });
  it('never routes images through the API while direct R2/CDN delivery is configured', () => {
    const storage = new StorageService(
      new ConfigService({
        R2_PUBLIC_URL: 'https://cdn.example.test',
        IMAGE_PROXY_URL: 'https://api.example.test/api/v1/images',
      }),
    );
    expect(storage.getPublicUrl(key)).toBe(
      'https://cdn.example.test/products/a%20b.png',
    );
  });
  it('falls back to the optional proxy only without a usable R2_PUBLIC_URL', () => {
    const config = new ConfigService({
      IMAGE_PROXY_URL: 'https://api.example.test/api/v1/images',
    });
    const storage = new StorageService(config);
    expect(storage.getPublicUrl(key)).toBe(
      'https://api.example.test/api/v1/images?key=products%2Fa+b.png',
    );
    config.set('R2_PUBLIC_URL', 'https://user:pass@cdn.example.test');
    expect(storage.getPublicUrl(key)).toBe(
      'https://api.example.test/api/v1/images?key=products%2Fa+b.png',
    );
    config.set('IMAGE_PROXY_URL', 'ftp://api.example.test');
    expect(storage.getPublicUrl(key)).toBeNull();
  });
});

describe('Opt-in background removal on upload', () => {
  const send = vi.spyOn(S3Client.prototype, 'send');
  const jpeg = Buffer.from([255, 216, 255, 0, 255, 217]);
  const photo = () =>
    ({
      originalname: 'photo.jpg',
      mimetype: 'image/jpeg',
      buffer: jpeg,
      size: jpeg.length,
    }) as Express.Multer.File;
  const storageWith = (enabled: string | undefined) => {
    const config = new ConfigService({
      R2_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
      R2_ACCESS_KEY_ID: 'test-access-key',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
      R2_BUCKET_NAME: 'test-bucket',
      ...(enabled === undefined ? {} : { BACKGROUND_REMOVAL_ENABLED: enabled }),
    });
    const removal = new BackgroundRemovalService(config);
    return { storage: new StorageService(config, removal), removal };
  };
  beforeEach(() => {
    send.mockReset().mockResolvedValue({} as never);
  });

  it.each([undefined, 'false'])(
    'stores the upload unchanged when BACKGROUND_REMOVAL_ENABLED=%s, even if requested',
    async (enabled) => {
      const { storage, removal } = storageWith(enabled);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        expect(storage.removesBackground(true)).toBe(false);
        const { key } = await storage.upload(photo(), 'products', true);
        expect(key).toMatch(/^products\/[0-9a-f-]{36}\.jpg$/);
        const put = send.mock.calls[0][0] as PutObjectCommand;
        expect(put.input.Body).toEqual(jpeg);
        expect(put.input.ContentType).toBe('image/jpeg');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(removal.enabled).toBe(false);
      } finally {
        fetchSpy.mockRestore();
        storage.onModuleDestroy();
      }
    },
  );

  it('defaults to no background removal when the caller does not ask for it', async () => {
    const { storage, removal } = storageWith('true');
    const remove = vi.spyOn(removal, 'remove');
    try {
      await storage.upload(photo(), 'products');
      expect(remove).not.toHaveBeenCalled();
      expect(storage.removesBackground(undefined)).toBe(false);
      expect(storage.removesBackground(true)).toBe(true);
    } finally {
      storage.onModuleDestroy();
    }
  });

  it('uploads the worker result when removal is requested and writes nothing when it fails', async () => {
    const { storage, removal } = storageWith('true');
    const remove = vi.spyOn(removal, 'remove');
    try {
      remove.mockResolvedValueOnce({
        ...photo(),
        buffer: image,
        size: image.length,
        mimetype: 'image/png',
      });
      const { key } = await storage.upload(photo(), 'subcategories', true);
      expect(key).toMatch(/\.png$/);
      expect((send.mock.calls[0][0] as PutObjectCommand).input.Body).toBe(
        image,
      );

      send.mockClear();
      remove.mockRejectedValueOnce(
        new ServiceUnavailableException('Background removal timed out'),
      );
      await expect(
        storage.upload(photo(), 'subcategories', true),
      ).rejects.toMatchObject({ status: 503 });
      expect(send).not.toHaveBeenCalled();
    } finally {
      storage.onModuleDestroy();
    }
  });
});

describe('Opt-in trimming of transparent padding on upload', () => {
  const send = vi.spyOn(S3Client.prototype, 'send');
  let storage: StorageService;
  // A 400×400 transparent canvas with an opaque 100×100 square in the middle.
  const padded = async () => {
    const rgba = Buffer.alloc(400 * 400 * 4);
    for (let y = 150; y < 250; y++)
      for (let x = 150; x < 250; x++) rgba[(y * 400 + x) * 4 + 3] = 255;
    const buffer = await sharp(rgba, {
      raw: { width: 400, height: 400, channels: 4 },
    })
      .png()
      .toBuffer();
    return file({ originalname: 'bead.png', buffer, size: buffer.length });
  };
  const body = () => (send.mock.calls[0][0] as PutObjectCommand).input.Body;
  beforeEach(() => {
    send.mockReset().mockResolvedValue({} as never);
    storage = new StorageService(
      new ConfigService({
        R2_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
        R2_ACCESS_KEY_ID: 'test-access-key',
        R2_SECRET_ACCESS_KEY: 'test-secret-key',
        R2_BUCKET_NAME: 'test-bucket',
      }),
    );
  });
  afterEach(() => storage.onModuleDestroy());

  it('uploads the trimmed square for components when trim is requested', async () => {
    const { key } = await storage.upload(
      await padded(),
      'subcategories',
      false,
      true,
    );
    expect(key).toMatch(/^subcategories\/[0-9a-f-]{36}\.png$/);
    const { width, height } = await sharp(body() as Buffer).metadata();
    expect([width, height]).toEqual([104, 104]);
    expect((send.mock.calls[0][0] as PutObjectCommand).input.ContentType).toBe(
      'image/png',
    );
  });

  it.each([
    ['by default', 'subcategories', false],
    ['for originals', 'originals', true],
    ['for products', 'products', true],
    ['for designs', 'designs', true],
    ['for categories', 'categories', true],
  ])('stores the upload byte for byte %s', async (_case, folder, trim) => {
    const input = await padded();
    await storage.upload(input, folder, false, trim);
    expect(body()).toBe(input.buffer);
  });

  it('writes nothing to R2 when trimming fails', async () => {
    // Valid PNG signature, header and IEND (so validation passes) but corrupt pixel data.
    const input = await padded();
    const buffer = Buffer.from(input.buffer);
    const idat = buffer.indexOf('IDAT');
    buffer.fill(0xa5, idat + 8, idat + 40);
    await expect(
      storage.upload(
        { ...input, buffer, size: buffer.length },
        'subcategories',
        false,
        true,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  });
});
