import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import sharp from 'sharp';
import { ProductsModule } from '../../src/modules/products/products.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

// Stickers: a customer set is one CUSTOMER product in one shape and size (a category
// size), with 1–5 designs from their own artwork, each printed `quantity` times.
describe('Sticker studio HTTP', () => {
  let app: INestApplication<App>;
  let token: string;
  const ownerId = 'b0000000-2a71-46c6-bfba-a453d847044f';
  const categoryId = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const artworkId = 'e5cf6f87-2a71-46c6-bfba-a453d847044f';
  const libraryId = 'f5cf6f87-2a71-46c6-bfba-a453d847044f';
  const delegate = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  });
  const category = delegate();
  const subCategory = delegate();
  const product = delegate();
  const tx = { category, subCategory, product, $queryRaw: vi.fn() };
  const send = vi.spyOn(S3Client.prototype, 'send');
  const putKeys = () =>
    send.mock.calls
      .map(([command]) => command as unknown)
      .filter((command) => command instanceof PutObjectCommand)
      .map((command) => (command as PutObjectCommand).input.Key);
  const config = new ConfigService({
    NODE_ENV: 'test',
    R2_ENDPOINT: 'https://test.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'fake',
    R2_SECRET_ACCESS_KEY: 'fake',
    R2_BUCKET_NAME: 'test',
    R2_PUBLIC_URL: 'https://images.test',
  });
  const square = {
    id: 'square-5',
    name: '5 × 5 cm',
    shape: 'SQUARE',
    widthMm: 50,
    heightMm: 50,
    price: 120,
  };
  const oval = {
    id: 'oval-7x4',
    name: '7 × 4 cm',
    shape: 'OVAL',
    widthMm: 70,
    heightMm: 40,
    price: 150,
  };
  const placed = { x: 0.5, y: 0.48, scale: 1.2, rotation: 0 };
  let jpeg: Buffer;

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'sticker-tests-only-secret-at-least-32-characters',
    );
    const module = await Test.createTestingModule({ imports: [ProductsModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(PrismaService)
      .useValue({
        ...tx,
        $transaction: (callback: (db: typeof tx) => Promise<unknown>) =>
          callback(tx),
        user: {
          findUnique: async ({ where }: { where: { id: string } }) => ({
            id: where.id,
            role: 'CUSTOMER',
            isActive: true,
          }),
        },
      })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    token = await module
      .get(JwtService)
      .signAsync({ sub: ownerId, tokenUse: 'access' });
    jpeg = await sharp({
      create: { width: 16, height: 16, channels: 3, background: 'teal' },
    })
      .jpeg()
      .toBuffer();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    send.mockImplementation(async () => ({}) as never);
    category.findUnique.mockResolvedValue({
      id: categoryId,
      builderType: 'STICKER',
      designCategoryId: null,
      sizes: [square, oval],
    });
    product.create.mockImplementation(async ({ data }) => ({
      id: 'new',
      ...data,
    }));
    subCategory.findMany.mockResolvedValue([
      {
        id: artworkId,
        categoryId,
        name: 'Your own artwork',
        isActive: true,
        // Not used: stickers are priced per sticker by their size.
        price: 999,
        type: 'CUSTOM_UPLOAD',
      },
      {
        id: libraryId,
        categoryId,
        name: 'Heart',
        isActive: true,
        price: 100,
        type: 'ILLUSTRATION',
      },
    ]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  const design = (quantity: number, index: number) => ({
    subCategoryId: artworkId,
    quantity,
    position: index,
    customDesignIndex: index,
    ...placed,
  });
  const set = (items: object[], sizeId: string | null = square.id) => {
    const call = request(app.getHttpServer())
      .post('/api/v1/products')
      .auth(token, { type: 'bearer' })
      .field('name', 'My stickers')
      .field('categoryId', categoryId)
      .field('items', JSON.stringify(items));
    return sizeId === null ? call : call.field('selectedSizeId', sizeId);
  };

  it('saves a set of designs priced per sticker by its size, with the size snapshot', async () => {
    await set([design(10, 0), design(5, 1), design(20, 2)])
      .attach('customDesigns', jpeg, 'a.jpg')
      .attach('customDesigns', jpeg, 'b.jpg')
      .attach('customDesigns', jpeg, 'c.jpg')
      .attach('designPreview', jpeg, 'set.jpg')
      .expect(201);
    const data = product.create.mock.calls[0][0].data;
    // 35 stickers × €1.20, whatever the artwork component costs.
    expect(data).toMatchObject({
      origin: 'CUSTOMER',
      price: 35 * 120,
      itemCount: 35,
      selectedSize: square,
    });
    const items = data.items.create;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      subCategoryId: artworkId,
      quantity: 10,
      position: 0,
      unitPrice: 120,
      x: 0.5,
      y: 0.48,
      scale: 1.2,
      rotation: 0,
    });
    expect(items[0].side).toBeUndefined();
    // Each design keeps its own stored artwork.
    const keys = items.map(
      (item: { customImageKey: string }) => item.customImageKey,
    );
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(putKeys()).toContain(key);
  });

  it('accepts five designs and rejects six or none', async () => {
    let five = set([0, 1, 2, 3, 4].map((index) => design(1, index)));
    for (let index = 0; index < 5; index++)
      five = five.attach('customDesigns', jpeg, `${index}.jpg`);
    await five.expect(201);
    expect(product.create.mock.calls[0][0].data.items.create).toHaveLength(5);

    let six = set([0, 1, 2, 3, 4, 5].map((index) => design(1, index)));
    for (let index = 0; index < 6; index++)
      six = six.attach('customDesigns', jpeg, `${index}.jpg`);
    await six.expect(400);
    await set([]).expect(400);
    expect(product.create).toHaveBeenCalledTimes(1);
  });

  it('requires an existing size of the category, never trusting a sent price or shape', async () => {
    await set([design(1, 0)], null)
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    await set([design(1, 0)], 'giant-9x9')
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    await set([design(1, 0)])
      .field('selectedMeasurementMm', '60')
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  it('mixes the category designs with uploads, priced per sticker by size alone', async () => {
    // Uploads are numbered among uploads only: design 2 is upload 0.
    await set([
      { subCategoryId: libraryId, quantity: 4, position: 0, ...placed },
      { ...design(6, 1), customDesignIndex: 0 },
    ])
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(201);
    const data = product.create.mock.calls[0][0].data;
    // The design's own price (100) is not added: 10 stickers × €1.20.
    expect(data.price).toBe(10 * 120);
    const [library, upload] = data.items.create;
    expect(library).toMatchObject({
      subCategoryId: libraryId,
      quantity: 4,
      unitPrice: 120,
      x: 0.5,
    });
    expect(library.customImageKey).toBeUndefined();
    expect(upload).toMatchObject({ subCategoryId: artworkId, quantity: 6 });
    expect(upload.customImageKey).toEqual(expect.any(String));
  });

  it('rejects designs of another category, inactive designs and images on a library design', async () => {
    subCategory.findMany.mockResolvedValue([
      {
        id: libraryId,
        categoryId: 'a1dfc7b7-2a71-46c6-bfba-a453d847044f',
        name: 'Heart',
        isActive: true,
        price: 100,
        type: 'ILLUSTRATION',
      },
    ]);
    await set([
      { subCategoryId: libraryId, quantity: 1, position: 0, ...placed },
    ]).expect(400);
    subCategory.findMany.mockResolvedValue([
      {
        id: libraryId,
        categoryId,
        name: 'Heart',
        isActive: false,
        price: 100,
        type: 'ILLUSTRATION',
      },
    ]);
    await set([
      { subCategoryId: libraryId, quantity: 1, position: 0, ...placed },
    ]).expect(400);
    subCategory.findMany.mockResolvedValue([
      {
        id: libraryId,
        categoryId,
        name: 'Heart',
        isActive: true,
        price: 100,
        type: 'ILLUSTRATION',
      },
    ]);
    await set([
      {
        subCategoryId: libraryId,
        quantity: 1,
        position: 0,
        customDesignIndex: 0,
        ...placed,
      },
    ])
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  it('rejects missing artwork, shared positions and too many stickers', async () => {
    await set([
      { subCategoryId: artworkId, quantity: 3, position: 0, ...placed },
    ]).expect(400);
    await set([design(1, 0), { ...design(1, 1), position: 0 }])
      .attach('customDesigns', jpeg, 'a.jpg')
      .attach('customDesigns', jpeg, 'b.jpg')
      .expect(400);
    await set([design(1001, 0)])
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    await set([
      {
        subCategoryId: artworkId,
        quantity: 1,
        position: 0,
        customDesignIndex: 0,
      },
    ])
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  it('accepts JPEG artwork for stickers', async () => {
    await set([design(2, 0)])
      .attach('customDesigns', jpeg, 'photo.jpg')
      .expect(201);
  });
});
