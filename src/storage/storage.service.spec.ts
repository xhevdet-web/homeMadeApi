import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { StorageService } from './storage.service.js';
import { MAX_IMAGE_BYTES } from './image-validation.js';

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
