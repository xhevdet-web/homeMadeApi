import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { S3Client } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import sharp from 'sharp';
import { ProductsModule } from '../../src/modules/products/products.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

// Mugs: a customer mug is ONE design, a single image printed on the company's blank mug
// (a COMPANY product with a print area in mm); its price is the blank mug's price.
describe('Mug studio HTTP', () => {
  let app: INestApplication<App>;
  const tokens: Record<string, string> = {};
  const adminId = 'a0000000-2a71-46c6-bfba-a453d847044f';
  const ownerId = 'b0000000-2a71-46c6-bfba-a453d847044f';
  const categoryId = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const blankId = 'c7d1f0a4-2a71-46c6-bfba-a453d847044f';
  const printedId = 'c8d1f0a4-2a71-46c6-bfba-a453d847044f';
  const ownId = 'e5cf6f87-2a71-46c6-bfba-a453d847044f';
  const heartId = 'f5cf6f87-2a71-46c6-bfba-a453d847044f';
  const roles: Record<string, string> = {
    [adminId]: 'ADMIN',
    [ownerId]: 'CUSTOMER',
  };
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
  const config = new ConfigService({
    NODE_ENV: 'test',
    R2_ENDPOINT: 'https://test.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'fake',
    R2_SECRET_ACCESS_KEY: 'fake',
    R2_BUCKET_NAME: 'test',
    R2_PUBLIC_URL: 'https://images.test',
  });
  const printArea = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    widthMm: 200,
    heightMm: 80,
    safeMm: { top: 5, right: 8, bottom: 5, left: 8 },
  };
  const blank = {
    id: blankId,
    name: 'White Mug',
    origin: 'COMPANY',
    categoryId,
    isActive: true,
    price: 1200,
    stock: 30,
    sizes: null,
    printAreas: { front: printArea },
  };
  const placed = { x: 0.3, y: 0.5, scale: 1.1, rotation: 0 };
  let jpeg: Buffer;

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'mug-tests-only-secret-at-least-32-characters',
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
            role: roles[where.id],
            isActive: true,
          }),
        },
      })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    const jwt = module.get(JwtService);
    for (const userId of [adminId, ownerId])
      tokens[userId] = await jwt.signAsync({ sub: userId, tokenUse: 'access' });
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
      builderType: 'MUG',
      designCategoryId: null,
    });
    product.findUnique.mockResolvedValue(blank);
    product.create.mockImplementation(async ({ data }) => ({
      id: 'new',
      ...data,
    }));
    subCategory.findMany.mockResolvedValue([
      {
        id: ownId,
        categoryId,
        name: 'Your own image',
        isActive: true,
        price: 0,
        type: 'CUSTOM_UPLOAD',
      },
      {
        id: heartId,
        categoryId,
        name: 'Heart',
        isActive: true,
        price: 300,
        type: 'ILLUSTRATION',
      },
    ]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  const mug = (items: object[], base: string | null = blankId) => {
    const call = request(app.getHttpServer())
      .post('/api/v1/products')
      .auth(tokens[ownerId], { type: 'bearer' })
      .field('name', 'My mug')
      .field('categoryId', categoryId)
      .field('items', JSON.stringify(items));
    return base ? call.field('baseProductId', base) : call;
  };
  const upload = (index: number, position: number) => ({
    subCategoryId: ownId,
    quantity: 1,
    position,
    customDesignIndex: index,
    ...placed,
  });

  it('saves the one image, an upload, at the blank mug price with both previews', async () => {
    await mug([upload(0, 0)])
      .attach('customDesigns', jpeg, 'a.jpg')
      .attach('designPreview', jpeg, 'mug.jpg')
      .attach('backDesignPreview', jpeg, 'print.jpg')
      .expect(201);
    const data = product.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      origin: 'CUSTOMER',
      baseProductId: blankId,
      basePrice: 1200,
      price: 1200,
      itemCount: 1,
    });
    expect(data.items.create[0]).toMatchObject({
      subCategoryId: ownId,
      unitPrice: 0,
      position: 0,
      x: 0.3,
    });
    expect(data.items.create[0].customImageKey).toEqual(expect.any(String));
    expect(data.designPreviewKey).toEqual(expect.any(String));
    expect(data.backDesignPreviewKey).toEqual(expect.any(String));
  });

  it('uses one of our designs at the blank mug price, whatever the design costs', async () => {
    await mug([
      { subCategoryId: heartId, quantity: 1, position: 0, ...placed },
    ]).expect(201);
    // €12.00: the €3.00 heart is included in the mug's price.
    expect(product.create.mock.calls[0][0].data).toMatchObject({
      price: 1200,
      items: { create: [{ subCategoryId: heartId, unitPrice: 0 }] },
    });
  });

  it('allows exactly one image, placed once', async () => {
    await mug([]).expect(400);
    await mug([{ ...upload(0, 0), quantity: 2 }])
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    await mug([
      upload(0, 0),
      { subCategoryId: heartId, quantity: 1, position: 1, ...placed },
    ])
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  it('prints text, alone or with the image, but never a blank mug', async () => {
    const text = {
      id: 'text-1',
      text: 'Best Dad',
      x: 0.5,
      y: 0.4,
      scale: 1,
      rotation: 0,
      font: 'SCRIPT',
      weight: 'BOLD',
      italic: true,
      color: '#1E1E1E',
    };
    await mug([])
      .field('textLayers', JSON.stringify([text]))
      .expect(201);
    expect(product.create.mock.calls[0][0].data).toMatchObject({
      price: 1200,
      itemCount: 0,
      textLayers: [text],
    });
    await mug([upload(0, 0)])
      .field('textLayers', JSON.stringify([text]))
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(201);
    expect(product.create.mock.calls[1][0].data.textLayers).toEqual([text]);
    await mug([]).field('textLayers', '[]').expect(400);
    expect(product.create).toHaveBeenCalledTimes(2);
  });

  it('prints only on the blank mug, never on a ready-made one', async () => {
    await mug([upload(0, 0)], null)
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    product.findUnique.mockResolvedValue({
      ...blank,
      id: printedId,
      name: 'Birthday Mug',
      printAreas: null,
    });
    await mug([upload(0, 0)], printedId)
      .attach('customDesigns', jpeg, 'a.jpg')
      .expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  it('stores the blank mug print size and safe margins in millimetres', async () => {
    const admin = (printAreas: object) =>
      request(app.getHttpServer())
        .post('/api/v1/products')
        .auth(tokens[adminId], { type: 'bearer' })
        .field('origin', 'COMPANY')
        .field('categoryId', categoryId)
        .field('name', 'White Mug')
        .field('price', '1200')
        .field('stock', '30')
        .field('removeBackground', 'false')
        .field('printAreas', JSON.stringify(printAreas))
        .attach('file', jpeg, 'mug.jpg');
    await admin({ front: printArea }).expect(201);
    expect(product.create.mock.calls[0][0].data.printAreas).toEqual({
      front: printArea,
    });
    for (const front of [
      { ...printArea, widthMm: 200.5 },
      { ...printArea, safeMm: { top: 40, bottom: 40 } },
      { ...printArea, safeMm: { inside: 3 } },
      { x: 0, y: 0, width: 1, height: 1, safeMm: { top: 5 } },
    ])
      await admin({ front }).expect(400);
    expect(product.create).toHaveBeenCalledTimes(1);
  });
});
