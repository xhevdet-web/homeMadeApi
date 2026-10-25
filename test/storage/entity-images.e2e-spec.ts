import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { CategoriesModule } from '../../src/modules/categories/categories.module.js';
import { SubCategoriesModule } from '../../src/modules/sub-categories/sub-categories.module.js';
import { ProductsModule } from '../../src/modules/products/products.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { setupApp } from '../../src/config/setup-app.js';
import { setupSwagger } from '../../src/config/setup-swagger.js';
import sharp from 'sharp';
import { ForegroundSegmentationService } from '../../src/storage/foreground-segmentation.service.js';
import { MAX_IMAGE_BYTES } from '../../src/storage/image-validation.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQYlWP4//9/Az7MMDIUAABUZd9Bgp/b1QAAAABJRU5ErkJggg==',
  'base64',
);
const id = 'ac78a80a-ce2b-4c45-8076-fca001c71418';
const childId = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
const oldKey = 'categories/550e8400-e29b-41d4-a716-446655440000.png';
const delegate = () => ({
  create: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
});

// Design (sub-category) uploads also keep the untouched original for production.
const originalUploads = (route: string) =>
  route === 'sub-categories' ? ['upload'] : [];

describe('Entity images HTTP', () => {
  let app: INestApplication<App>;
  let token: string;
  let role = 'ADMIN';
  let publicUrl = '';
  const category = delegate();
  const subCategory = delegate();
  const product = delegate();
  const send = vi.spyOn(S3Client.prototype, 'send');
  const events: string[] = [];
  const commands = () => send.mock.calls.map(([command]) => command as unknown);
  const putKeys = () =>
    commands()
      .filter((command) => command instanceof PutObjectCommand)
      .map((command) => (command as PutObjectCommand).input.Key);
  const deleteKeys = () =>
    commands()
      .filter((command) => command instanceof DeleteObjectCommand)
      .map((command) => (command as DeleteObjectCommand).input.Key);
  const segment = vi.spyOn(ForegroundSegmentationService.prototype, 'mask');
  const config = new ConfigService({
    NODE_ENV: 'test',
    R2_ENDPOINT: 'https://test.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'fake',
    R2_SECRET_ACCESS_KEY: 'fake',
    R2_BUCKET_NAME: 'test',
  });
  const originalGet = config.get.bind(config);
  const tx = {
    category,
    subCategory,
    product,
    $queryRaw: vi.fn(),
  };
  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'image-tests-only-secret-at-least-32-characters',
    );
    vi.spyOn(config, 'get').mockImplementation((key: string) =>
      key === 'R2_PUBLIC_URL' ? publicUrl : originalGet(key),
    );
    const module = await Test.createTestingModule({
      imports: [CategoriesModule, SubCategoriesModule, ProductsModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(PrismaService)
      .useValue({
        ...tx,
        $transaction: (callback: (db: typeof tx) => Promise<unknown>) =>
          callback(tx),
        user: { findUnique: async () => ({ id, role, isActive: true }) },
      })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    setupSwagger(app);
    await app.init();
    token = await module
      .get(JwtService)
      .signAsync({ sub: id, tokenUse: 'access' });
  });
  beforeEach(() => {
    role = 'ADMIN';
    publicUrl = '';
    events.length = 0;
    segment.mockReset().mockImplementation(async (_rgb, width, height) => {
      events.push('process');
      const mask = Buffer.alloc(width * height);
      for (let y = 8; y < height - 8; y++)
        for (let x = 8; x < width - 8; x++) mask[y * width + x] = 255;
      return mask;
    });
    send.mockReset().mockImplementation(async (command) => {
      events.push(command instanceof PutObjectCommand ? 'upload' : 'delete');
      return {} as never;
    });
    for (const model of [category, subCategory, product]) {
      for (const mock of Object.values(model)) mock.mockReset();
      model.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => {
          events.push('create');
          return { id, ...data };
        },
      );
      model.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => {
          events.push('update');
          return { id, ...data };
        },
      );
      model.delete.mockImplementation(async () => {
        events.push('remove');
        return { id, imageKey: oldKey, subCategories: [], items: [] };
      });
      model.findUnique.mockResolvedValue({
        id,
        categoryId: id,
        imageKey: oldKey,
        items: [{ subCategoryId: childId, quantity: 8, unitPrice: 200 }],
        _count: { orders: 0 },
      });
    }
    // No other product shares an image unless a test says so.
    product.findMany.mockResolvedValue([]);
    subCategory.findMany.mockResolvedValue([
      { id: childId, categoryId: id, name: 'Bead', isActive: true, price: 200 },
    ]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it.each(['categories', 'sub-categories', 'products'])(
    'processes JPEG/PNG/WebP for %s creation and replacement before R2 upload',
    async (route) => {
      publicUrl = 'https://images.example.test';
      for (const format of ['jpeg', 'png', 'webp'] as const)
        for (const replace of [false, true]) {
          events.length = 0;
          send.mockClear();
          const source = await sharp({
            create: { width: 32, height: 32, channels: 3, background: 'white' },
          })
            .toFormat(format)
            .toBuffer();
          const base = '/api/v1/' + route;
          const req = (
            replace
              ? request(app.getHttpServer()).patch(base + '/' + id)
              : request(app.getHttpServer()).post(base)
          ).auth(token, { type: 'bearer' });
          if (!replace) {
            req.field('name', 'White pearl');
            if (route !== 'categories') req.field('categoryId', id);
            if (route === 'products')
              req.field(
                'items',
                JSON.stringify([{ subCategoryId: childId, quantity: 8 }]),
              );
          }
          const response = await req
            .attach('file', source, {
              filename: 'original.' + format,
              contentType: 'image/' + format,
            })
            .expect(replace ? 200 : 201);
          expect(events).toEqual(
            replace
              ? [
                  'process',
                  'upload',
                  ...originalUploads(route),
                  'update',
                  'delete',
                ]
              : ['process', 'upload', ...originalUploads(route), 'create'],
          );
          const command = send.mock.calls[0][0] as PutObjectCommand;
          expect(command.input.ContentType).toBe('image/png');
          expect(command.input.Body).not.toEqual(source);
          const { data, info } = await sharp(command.input.Body as Buffer)
            .raw()
            .toBuffer({ resolveWithObject: true });
          expect(info.channels).toBe(4);
          expect(data[3]).toBe(0);
          expect(data[(10 * info.width + 10) * 4 + 3]).toBe(255);
          expect(response.body.imageUrl).toBe(
            publicUrl + '/' + response.body.imageKey,
          );
          if (replace) expect(deleteKeys()).toEqual([oldKey]);
        }
    },
  );
  it('keeps the untouched design upload as the production original', async () => {
    const source = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'white' },
    })
      .jpeg()
      .toBuffer();
    const response = await request(app.getHttpServer())
      .post('/api/v1/sub-categories')
      .auth(token, { type: 'bearer' })
      .field('name', 'Logo')
      .field('categoryId', id)
      .attach('file', source, 'logo.jpg')
      .expect(201);
    const [display, original] = commands() as PutObjectCommand[];
    expect(display.input.Key).toMatch(/^subcategories\//);
    expect(original.input.Key).toMatch(/^originals\//);
    expect(original.input.Body).toEqual(source);
    expect(subCategory.create.mock.calls[0][0].data.originalImageKey).toBe(
      original.input.Key,
    );
    expect(response.body.originalImageUrl).toBeNull();
  });
  it('skips background removal for designs uploaded with removeBackground=false', async () => {
    const source = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'white' },
    })
      .jpeg()
      .toBuffer();
    await request(app.getHttpServer())
      .post('/api/v1/sub-categories')
      .auth(token, { type: 'bearer' })
      .field('name', 'Lettering')
      .field('categoryId', id)
      .field('removeBackground', 'false')
      .field('trackStock', 'false')
      .attach('file', source, 'lettering.jpg')
      .expect(201);
    expect(events).toEqual(['upload', 'create']);
    expect((send.mock.calls[0][0] as PutObjectCommand).input.Body).toEqual(
      source,
    );
    expect(subCategory.create.mock.calls[0][0].data).toMatchObject({
      trackStock: false,
      originalImageKey: undefined,
    });
  });
  describe('customer artwork for "Your own design"', () => {
    const ownId = 'c1d1f0a4-2a71-46c6-bfba-a453d847044f';
    const baseId = 'c7d1f0a4-2a71-46c6-bfba-a453d847044f';
    const placed = { side: 'FRONT', x: 0.5, y: 0.5 };
    beforeEach(() => {
      category.findUnique.mockResolvedValue({
        id,
        builderType: 'APPAREL',
        options: [],
        designCategoryId: null,
      });
      // The COMPANY hoodie the design is printed on.
      product.findUnique.mockResolvedValue({
        id: baseId,
        name: 'Black Essential Hoodie',
        origin: 'COMPANY',
        categoryId: id,
        isActive: true,
        price: 2500,
        stock: 0,
        sizes: [{ size: 'M', stock: 4 }],
      });
      subCategory.findMany.mockResolvedValue([
        {
          id: ownId,
          categoryId: id,
          name: 'Your own design',
          isActive: true,
          price: 500,
          type: 'CUSTOM_UPLOAD',
        },
        {
          id: childId,
          categoryId: id,
          name: 'Logo',
          isActive: true,
          price: 200,
          type: 'LOGO',
        },
      ]);
    });
    const post = (items: object[], uploads: number) => {
      const req = request(app.getHttpServer())
        .post('/api/v1/products')
        .auth(token, { type: 'bearer' })
        .field('name', 'My hoodie')
        .field('categoryId', id)
        .field('baseProductId', baseId)
        .field('selectedSizeId', 'M')
        .field('items', JSON.stringify(items));
      for (let index = 0; index < uploads; index++)
        req.attach('customDesigns', png, `artwork-${index}.png`);
      return req;
    };

    it('stores each upload untouched and charges the own-design price once', async () => {
      await post(
        [
          {
            subCategoryId: ownId,
            quantity: 1,
            customDesignIndex: 0,
            ...placed,
          },
          {
            subCategoryId: ownId,
            quantity: 1,
            customDesignIndex: 1,
            ...placed,
            side: 'BACK',
          },
          { subCategoryId: childId, quantity: 1, ...placed },
        ],
        2,
      ).expect(201);
      const keys = putKeys();
      expect(keys).toHaveLength(2);
      for (const key of keys) expect(key).toMatch(/^custom-designs\//);
      expect(segment).not.toHaveBeenCalled();
      const data = product.create.mock.calls[0][0].data;
      expect(
        data.items.create.map(
          (item: { customImageKey?: string }) => item.customImageKey,
        ),
      ).toEqual([keys[0], keys[1], undefined]);
      expect(
        data.items.create.map((item: { unitPrice: number }) => item.unitPrice),
      ).toEqual([500, 0, 200]);
      expect(data.price).toBe(2500 + 500 + 200);
    });

    it('accepts PNG artwork only', async () => {
      const jpeg = await sharp({
        create: { width: 8, height: 8, channels: 3, background: 'white' },
      })
        .jpeg()
        .toBuffer();
      const response = await request(app.getHttpServer())
        .post('/api/v1/products')
        .auth(token, { type: 'bearer' })
        .field('name', 'My hoodie')
        .field('categoryId', id)
        .field('baseProductId', baseId)
        .field('selectedSizeId', 'M')
        .field(
          'items',
          JSON.stringify([
            {
              subCategoryId: ownId,
              quantity: 1,
              customDesignIndex: 0,
              ...placed,
            },
          ]),
        )
        .attach('customDesigns', jpeg, 'artwork.jpg')
        .expect(400);
      expect(response.body.message).toBe('Uploaded designs must be PNG images');
      expect(putKeys()).toEqual([]);
      expect(product.create).not.toHaveBeenCalled();
    });

    it.each([
      [
        'an own design without an upload',
        [{ subCategoryId: ownId, quantity: 1, ...placed }],
        0,
      ],
      [
        'an upload that is never placed',
        [{ subCategoryId: childId, quantity: 1, ...placed }],
        1,
      ],
      [
        'one upload placed twice',
        [
          {
            subCategoryId: ownId,
            quantity: 1,
            customDesignIndex: 0,
            ...placed,
          },
          {
            subCategoryId: ownId,
            quantity: 1,
            customDesignIndex: 0,
            ...placed,
          },
        ],
        1,
      ],
      [
        'an upload on a catalog design',
        [
          {
            subCategoryId: childId,
            quantity: 1,
            customDesignIndex: 0,
            ...placed,
          },
        ],
        1,
      ],
      [
        'a client-supplied storage key',
        [
          {
            subCategoryId: ownId,
            quantity: 1,
            customImageKey: 'custom-designs/someone-else.png',
            ...placed,
          },
        ],
        0,
      ],
    ])(
      'rejects %s and leaves no orphaned files',
      async (_case, items, uploads) => {
        await post(items, uploads).expect(400);
        expect(product.create).not.toHaveBeenCalled();
        expect(deleteKeys()).toEqual(putKeys());
      },
    );

    it('rejects uploads on non-apparel designs', async () => {
      category.findUnique.mockResolvedValue({
        id,
        builderType: 'JEWELRY',
        options: [],
        designCategoryId: null,
      });
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .auth(token, { type: 'bearer' })
        .field('name', 'Bracelet')
        .field('categoryId', id)
        .field(
          'items',
          JSON.stringify([{ subCategoryId: childId, quantity: 1 }]),
        )
        .attach('customDesigns', png, 'artwork.png')
        .expect(400);
      expect(deleteKeys()).toEqual(putKeys());
    });
  });

  it('does not process customer designPreview bytes', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/products')
      .auth(token, { type: 'bearer' })
      .field('name', 'Design')
      .field('categoryId', id)
      .field('items', JSON.stringify([{ subCategoryId: childId, quantity: 8 }]))
      .attach('designPreview', png, 'preview.png')
      .expect(201);
    expect((send.mock.calls[0][0] as PutObjectCommand).input.Body).toEqual(png);
    expect(segment).not.toHaveBeenCalled();
  });
  it.each(['sub-categories', 'products'])(
    'cleans only the newly processed image when %s replacement fails',
    async (route) => {
      (route === 'products' ? product : subCategory).update.mockRejectedValue(
        new Error('DB failure'),
      );
      const source = await sharp({
        create: { width: 32, height: 32, channels: 3, background: 'white' },
      })
        .jpeg()
        .toBuffer();
      await request(app.getHttpServer())
        .patch('/api/v1/' + route + '/' + id)
        .auth(token, { type: 'bearer' })
        .attach('file', source, 'original.jpg')
        .expect(500);
      expect(events).toEqual([
        'process',
        'upload',
        ...originalUploads(route),
        'delete',
        ...originalUploads(route).map(() => 'delete'),
      ]);
      const uploaded = (send.mock.calls[0][0] as PutObjectCommand).input;
      expect(uploaded.ContentType).toBe('image/png');
      expect(uploaded.Body).not.toEqual(source);
      expect(deleteKeys()).toEqual(putKeys());
      expect(uploaded.Key).not.toBe(oldKey);
    },
  );
  it.each(['sub-categories', 'products'])(
    'preserves transparent %s uploads byte for byte on create and replace',
    async (route) => {
      for (const replace of [false, true]) {
        send.mockClear();
        const base = '/api/v1/' + route;
        const req = (
          replace
            ? request(app.getHttpServer()).patch(base + '/' + id)
            : request(app.getHttpServer()).post(base)
        ).auth(token, { type: 'bearer' });
        if (!replace) {
          req.field('name', 'Transparent pearl').field('categoryId', id);
          if (route === 'products')
            req.field(
              'items',
              JSON.stringify([{ subCategoryId: childId, quantity: 8 }]),
            );
        }
        await req
          .attach('file', png, 'transparent.png')
          .expect(replace ? 200 : 201);
        expect((send.mock.calls[0][0] as PutObjectCommand).input.Body).toEqual(
          png,
        );
        expect(segment).not.toHaveBeenCalled();
      }
    },
  );

  it('does not upload or update the database when processing fails', async () => {
    segment.mockRejectedValue(new Error('private-native-detail'));
    const source = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'white' },
    })
      .jpeg()
      .toBuffer();
    const response = await request(app.getHttpServer())
      .patch('/api/v1/products/' + id)
      .auth(token, { type: 'bearer' })
      .attach('file', source, 'original.jpg')
      .expect(503);
    expect(response.text).not.toContain('private-native-detail');
    expect(send).not.toHaveBeenCalled();
    expect(product.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      'jpeg',
      'image/jpeg',
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==',
    ],
    [
      'webp',
      'image/webp',
      'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
    ],
  ])('accepts valid %s bytes', async (extension, contentType, base64) => {
    // The 1×1 fixtures are too small for the default mask's 8px inset.
    segment.mockImplementation(async (_rgb, width, height) =>
      Buffer.alloc(width * height, 255),
    );
    const response = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .auth(token, { type: 'bearer' })
      .field('name', 'Test')
      .attach('file', Buffer.from(base64, 'base64'), {
        filename: 'image.' + extension,
        contentType,
      })
      .expect(201);
    // Category images are background-processed, so opaque sources are stored as PNG.
    expect(response.body.imageKey.endsWith('.png')).toBe(true);
  });

  it.each(['categories', 'sub-categories', 'products'])(
    'creates %s with an image and trusted folder',
    async (route) => {
      const req = request(app.getHttpServer())
        .post('/api/v1/' + route)
        .auth(token, { type: 'bearer' })
        .field('name', 'Test')
        .field('isActive', 'false');
      if (route !== 'categories') req.field('categoryId', id);
      if (route === 'sub-categories')
        req.field('price', '200').field('stock', '30').field('sortOrder', '1');
      if (route === 'products')
        req.field(
          'items',
          JSON.stringify([
            { subCategoryId: childId, quantity: 8, position: 1 },
          ]),
        );
      const response = await req.attach('file', png, 'image.png').expect(201);
      expect(response.body.imageKey).toMatch(
        new RegExp(
          '^' +
            route.replace('sub-categories', 'subcategories') +
            '/[a-f0-9-]{36}\\.png$',
        ),
      );
      expect(response.body.imageUrl).toBeNull();
      expect(response.body.isActive).toBe(false);
      expect(events).toEqual(['upload', ...originalUploads(route), 'create']);
      if (route === 'sub-categories')
        expect(response.body).toMatchObject({
          price: 200,
          stock: 30,
          sortOrder: 1,
        });
      if (route === 'products')
        expect(response.body).toMatchObject({
          price: 1600,
          itemCount: 8,
          createdById: id,
        });
    },
  );

  it.each(['categories', 'sub-categories', 'products'])(
    'preserves JSON create without image for %s',
    async (route) => {
      const body = {
        name: 'Test',
        ...(route !== 'categories' ? { categoryId: id } : {}),
        ...(route === 'products'
          ? { items: [{ subCategoryId: childId, quantity: 8 }] }
          : {}),
      };
      await request(app.getHttpServer())
        .post('/api/v1/' + route)
        .auth(token, { type: 'bearer' })
        .send(body)
        .expect(201);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(['categories', 'sub-categories', 'products'])(
    'replaces %s image only after DB success',
    async (route) => {
      publicUrl = 'https://images.example.test/';
      const response = await request(app.getHttpServer())
        .patch('/api/v1/' + route + '/' + id)
        .auth(token, { type: 'bearer' })
        .attach('file', png, 'new.png')
        .expect(200);
      expect(events).toEqual([
        'upload',
        ...originalUploads(route),
        'update',
        'delete',
      ]);
      expect(deleteKeys()).toEqual([oldKey]);
      expect(response.body.imageUrl).toBe(
        'https://images.example.test/' + response.body.imageKey,
      );
      if (route === 'products') {
        const data = product.update.mock.calls[0][0].data;
        for (const field of ['items', 'price', 'itemCount', 'category'])
          expect(data).not.toHaveProperty(field);
        expect(subCategory.findMany).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['categories', 'sub-categories', 'products'])(
    'cleans new upload and retains old image when %s DB update fails',
    async (route) => {
      const model =
        route === 'categories'
          ? category
          : route === 'sub-categories'
            ? subCategory
            : product;
      model.update.mockRejectedValue(new Error('private database details'));
      const response = await request(app.getHttpServer())
        .patch('/api/v1/' + route + '/' + id)
        .auth(token, { type: 'bearer' })
        .attach('file', png, 'new.png')
        .expect(500);
      const uploaded = (send.mock.calls[0][0] as PutObjectCommand).input.Key;
      expect(deleteKeys()).toEqual(putKeys());
      expect(uploaded).not.toBe(oldKey);
      expect(response.text).not.toContain('private database');
    },
  );

  it.each(['categories', 'sub-categories', 'products'])(
    'cleans new upload when %s creation fails',
    async (route) => {
      const model =
        route === 'categories'
          ? category
          : route === 'sub-categories'
            ? subCategory
            : product;
      model.create.mockRejectedValue(new Error('private database details'));
      const req = request(app.getHttpServer())
        .post('/api/v1/' + route)
        .auth(token, { type: 'bearer' })
        .field('name', 'Test');
      if (route !== 'categories') req.field('categoryId', id);
      if (route === 'products')
        req.field(
          'items',
          JSON.stringify([{ subCategoryId: childId, quantity: 8 }]),
        );
      await req.attach('file', png, 'new.png').expect(500);
      expect(deleteKeys()).toEqual(putKeys());
    },
  );

  it.each(['categories', 'sub-categories', 'products'])(
    'deletes %s object after DB deletion',
    async (route) => {
      await request(app.getHttpServer())
        .delete('/api/v1/' + route + '/' + id)
        .auth(token, { type: 'bearer' })
        .expect(204);
      expect(events).toEqual(['remove', 'delete']);
    },
  );

  it('cleans cascaded subcategory images after category deletion', async () => {
    category.delete.mockResolvedValue({
      imageKey: oldKey,
      subCategories: [{ imageKey: 'subcategories/child.png' }],
    });
    await request(app.getHttpServer())
      .delete('/api/v1/categories/' + id)
      .auth(token, { type: 'bearer' })
      .expect(204);
    expect(
      send.mock.calls.map(
        ([command]) => (command as DeleteObjectCommand).input.Key,
      ),
    ).toEqual([oldKey, 'subcategories/child.png']);
  });

  it('retains image when foreign key prevents deletion', async () => {
    subCategory.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('details', {
        code: 'P2003',
        clientVersion: '7',
      }),
    );
    await request(app.getHttpServer())
      .delete('/api/v1/sub-categories/' + id)
      .auth(token, { type: 'bearer' })
      .expect(409);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['fake.png', 'image/png', Buffer.from('not a png')],
    ['image.gif', 'image/gif', Buffer.from('GIF89a')],
    ['image.png', 'image/png', Buffer.alloc(MAX_IMAGE_BYTES + 1)],
  ])(
    'rejects invalid or oversized %s before upload',
    async (filename, contentType, buffer) => {
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .auth(token, { type: 'bearer' })
        .field('name', 'Test')
        .attach('file', buffer, { filename, contentType })
        .expect(400);
      expect(send).not.toHaveBeenCalled();
      expect(category.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['isActive', 'yes'],
    ['price', '2xx'],
    ['stock', '1.5'],
    ['sortOrder', ''],
  ])('rejects invalid multipart %s', async (field, value) => {
    await request(app.getHttpServer())
      .post('/api/v1/sub-categories')
      .auth(token, { type: 'bearer' })
      .field('name', 'Test')
      .field('categoryId', id)
      .field(field, value)
      .expect(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not trust client imageKey or product price', async () => {
    for (const field of [
      'imageKey',
      'imageUrl',
      'price',
      'itemCount',
      'createdById',
      'unitPrice',
      'stock',
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .auth(token, { type: 'bearer' })
        .field('name', 'Test')
        .field('categoryId', id)
        .field(
          'items',
          JSON.stringify([{ subCategoryId: childId, quantity: 8 }]),
        )
        .field(field, '123')
        .expect(400);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('requires admin for category/component mutations and allows customer product creation', async () => {
    role = 'CUSTOMER';
    for (const route of ['categories', 'sub-categories']) {
      await request(app.getHttpServer())
        .post('/api/v1/' + route)
        .auth(token, { type: 'bearer' })
        .send({ name: 'Test' })
        .expect(403);
      await request(app.getHttpServer())
        .patch('/api/v1/' + route + '/' + id)
        .auth(token, { type: 'bearer' })
        .send({ name: 'Test' })
        .expect(403);
      await request(app.getHttpServer())
        .delete('/api/v1/' + route + '/' + id)
        .auth(token, { type: 'bearer' })
        .expect(403);
    }
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Test' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/products')
      .auth(token, { type: 'bearer' })
      .field('name', 'Test')
      .field('categoryId', id)
      .field('items', JSON.stringify([{ subCategoryId: childId, quantity: 1 }]))
      .attach('file', png, 'image.png')
      .expect(201);
    send.mockClear();
    await request(app.getHttpServer())
      .patch('/api/v1/products/' + id)
      .auth(token, { type: 'bearer' })
      .attach('file', png, 'image.png')
      .expect(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps existing image when no file is supplied', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .auth(token, { type: 'bearer' })
      .send({ name: 'Updated' })
      .expect(200);
    expect(category.update.mock.calls[0][0].data.imageKey).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('derives nested URLs and returns null for missing images while preserving dates', async () => {
    publicUrl = 'https://images.example.test';
    const date = new Date('2026-01-01T00:00:00Z');
    product.findUnique.mockResolvedValue({
      id,
      imageKey: null,
      createdAt: date,
      items: [
        { subCategory: { imageKey: 'subcategories/a.png', imageUrl: null } },
      ],
    });
    const response = await request(app.getHttpServer())
      .get('/api/v1/products/' + id)
      .expect(200);
    expect(response.body.imageUrl).toBeNull();
    expect(response.body.createdAt).toBe(date.toISOString());
    expect(response.body.items[0].subCategory.imageUrl).toBe(
      publicUrl + '/subcategories/a.png',
    );
  });

  it('documents multipart CRUD and removes temporary storage endpoints', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    const schema =
      response.body.paths['/api/v1/sub-categories'].post.requestBody.content[
        'multipart/form-data'
      ].schema;
    expect(schema.properties.file).toMatchObject({
      type: 'string',
      format: 'binary',
    });
    for (const field of [
      'categoryId',
      'name',
      'description',
      'color',
      'type',
      'price',
      'stock',
      'isActive',
      'sortOrder',
    ])
      expect(schema.properties).toHaveProperty(field);
    await request(app.getHttpServer())
      .post('/api/v1/storage/test-upload')
      .expect(404);
    await request(app.getHttpServer())
      .delete('/api/v1/storage/test-upload')
      .expect(404);
  });

  it('creates a Product with both images while retaining calculated items and pricing', async () => {
    publicUrl = 'https://images.example.test';
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .auth(token, { type: 'bearer' })
      .field('name', 'Bracelet')
      .field('categoryId', id)
      .field(
        'items',
        JSON.stringify([{ subCategoryId: childId, quantity: 8, position: 1 }]),
      )
      .attach('file', png, 'product.png')
      .attach('designPreview', png, 'preview.png')
      .expect(201);
    expect(response.body).toMatchObject({
      itemCount: 8,
      price: 1600,
      createdById: id,
      imageUrl: 'https://images.example.test/' + response.body.imageKey,
      designPreviewUrl:
        'https://images.example.test/' + response.body.designPreviewKey,
    });
    expect(response.body.imageKey).toMatch(/^products\/[a-f0-9-]{36}\.png$/);
    expect(response.body.designPreviewKey).toMatch(
      /^designs\/[a-f0-9-]{36}\.png$/,
    );
    expect(product.create.mock.calls[0][0].data.items.create).toEqual([
      { subCategoryId: childId, quantity: 8, position: 1, unitPrice: 200 },
    ]);
    expect(events).toEqual(['upload', 'upload', 'create']);
    expect(subCategory.update).not.toHaveBeenCalled();
  });

  it('creates a Product with only a design preview and no normal image', async () => {
    role = 'CUSTOMER';
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .auth(token, { type: 'bearer' })
      .field('name', 'Bracelet')
      .field('categoryId', id)
      .field('items', JSON.stringify([{ subCategoryId: childId, quantity: 2 }]))
      .attach('designPreview', png, 'preview.png')
      .expect(201);
    expect(response.body.designPreviewKey).toMatch(
      /^designs\/[a-f0-9-]{36}\.png$/,
    );
    expect(response.body.designPreviewUrl).toBeNull();
    expect(response.body.imageKey).toBeUndefined();
    expect(events).toEqual(['upload', 'create']);
  });

  it('replaces only the design preview after DB success, leaving components untouched', async () => {
    publicUrl = 'https://images.example.test';
    product.findUnique.mockResolvedValue({
      id,
      categoryId: id,
      imageKey: 'products/old.png',
      designPreviewKey: 'designs/old.png',
      items: [{ subCategoryId: childId, quantity: 8, unitPrice: 200 }],
      _count: { orders: 0 },
    });
    const response = await request(app.getHttpServer())
      .patch('/api/v1/products/' + id)
      .auth(token, { type: 'bearer' })
      .attach('designPreview', png, 'new.png')
      .expect(200);
    expect(events).toEqual(['upload', 'update', 'delete']);
    expect((send.mock.calls[1][0] as DeleteObjectCommand).input.Key).toBe(
      'designs/old.png',
    );
    const data = product.update.mock.calls[0][0].data;
    expect(data.designPreviewKey).toBe(response.body.designPreviewKey);
    expect(data.imageKey).toBeUndefined();
    for (const field of ['items', 'price', 'itemCount', 'category'])
      expect(data).not.toHaveProperty(field);
    expect(response.body.designPreviewUrl).toBe(
      'https://images.example.test/' + response.body.designPreviewKey,
    );
  });

  it('cleans both new files and keeps prior images if Product update fails', async () => {
    product.findUnique.mockResolvedValue({
      id,
      categoryId: id,
      imageKey: 'products/old.png',
      designPreviewKey: 'designs/old.png',
      items: [],
      _count: { orders: 0 },
    });
    product.update.mockRejectedValue(new Error('private database details'));
    await request(app.getHttpServer())
      .patch('/api/v1/products/' + id)
      .auth(token, { type: 'bearer' })
      .attach('file', png, 'new-product.png')
      .attach('designPreview', png, 'new-preview.png')
      .expect(500);
    expect(events).toEqual(['upload', 'upload', 'delete', 'delete']);
    expect((send.mock.calls[2][0] as DeleteObjectCommand).input.Key).toBe(
      (send.mock.calls[0][0] as PutObjectCommand).input.Key,
    );
    expect((send.mock.calls[3][0] as DeleteObjectCommand).input.Key).toBe(
      (send.mock.calls[1][0] as PutObjectCommand).input.Key,
    );
  });

  it('deletes normal and preview objects after Product deletion', async () => {
    product.delete.mockImplementation(async () => {
      events.push('remove');
      return {
        imageKey: 'products/old.png',
        designPreviewKey: 'designs/old.png',
        items: [
          { customImageKey: 'custom-designs/old.png' },
          { customImageKey: null },
        ],
      };
    });
    await request(app.getHttpServer())
      .delete('/api/v1/products/' + id)
      .auth(token, { type: 'bearer' })
      .expect(204);
    // Customer artwork is removed with the design.
    expect(events).toEqual(['remove', 'delete', 'delete', 'delete']);
    expect(
      send.mock.calls.map(
        ([command]) => (command as DeleteObjectCommand).input.Key,
      ),
    ).toEqual([
      'products/old.png',
      'designs/old.png',
      'custom-designs/old.png',
    ]);
  });

  it.each([
    ['unsupported MIME', Buffer.from('GIF89a'), 'image/gif'],
    ['invalid PNG', Buffer.from('not a png'), 'image/png'],
    ['oversized image', Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/png'],
  ])(
    'rejects %s in designPreview before storage or DB writes',
    async (_description, bytes, contentType) => {
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .auth(token, { type: 'bearer' })
        .field('name', 'Bracelet')
        .field('categoryId', id)
        .field(
          'items',
          JSON.stringify([{ subCategoryId: childId, quantity: 2 }]),
        )
        .attach('designPreview', bytes, {
          filename: 'preview.png',
          contentType,
        })
        .expect(400);
      expect(send).not.toHaveBeenCalled();
      expect(product.create).not.toHaveBeenCalled();
    },
  );

  it('shows both Product file fields in Swagger', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/docs-json')
      .expect(200);
    for (const method of ['post', 'patch']) {
      const route =
        method === 'post' ? '/api/v1/products' : '/api/v1/products/{id}';
      const properties =
        response.body.paths[route][method].requestBody.content[
          'multipart/form-data'
        ].schema.properties;
      expect(properties.file).toMatchObject({
        type: 'string',
        format: 'binary',
      });
      expect(properties.designPreview).toMatchObject({
        type: 'string',
        format: 'binary',
      });
      expect(properties).toHaveProperty('items');
    }
  });
});
