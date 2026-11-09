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

// COMPANY products of a phone case category are phone models (a print area, no base) or
// ready-made cases (no print area, linked to the model they fit). Never both, never neither.
describe('Ready-made phone cases HTTP', () => {
  let app: INestApplication<App>;
  const tokens: Record<string, string> = {};
  const adminId = 'a0000000-2a71-46c6-bfba-a453d847044f';
  const ownerId = 'b0000000-2a71-46c6-bfba-a453d847044f';
  const categoryId = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const otherCategoryId = 'd5dfc7b7-2a71-46c6-bfba-a453d847044f';
  const modelId = 'c7d1f0a4-2a71-46c6-bfba-a453d847044f';
  const otherModelId = 'c8d1f0a4-2a71-46c6-bfba-a453d847044f';
  const readyId = 'e7d1f0a4-2a71-46c6-bfba-a453d847044f';
  const designId = 'f7d1f0a4-2a71-46c6-bfba-a453d847044f';
  const libraryId = 'f5cf6f87-2a71-46c6-bfba-a453d847044f';
  const roles: Record<string, string> = {
    [adminId]: 'ADMIN',
    [ownerId]: 'CUSTOMER',
  };
  const front = { x: 0.04, y: 0.02, width: 0.92, height: 0.96, radius: 0.16 };
  const delegate = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  });
  const category = delegate();
  const subCategory = delegate();
  const product = delegate();
  const tx = { category, subCategory, product, $queryRaw: vi.fn() };
  const send = vi.spyOn(S3Client.prototype, 'send');
  const putKeys = () =>
    send.mock.calls
      .map(([command]) => command as unknown)
      .filter((command) => command instanceof PutObjectCommand);
  const config = new ConfigService({
    NODE_ENV: 'test',
    R2_ENDPOINT: 'https://test.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'fake',
    R2_SECRET_ACCESS_KEY: 'fake',
    R2_BUCKET_NAME: 'test',
    R2_PUBLIC_URL: 'https://images.test',
  });
  let jpeg: Buffer;

  const record = (id: string, overrides: object = {}) => ({
    id,
    name: 'iPhone 15',
    origin: 'COMPANY',
    categoryId,
    isActive: true,
    price: 1500,
    stock: 20,
    sizes: null,
    printAreas: { front },
    baseProductId: null,
    items: [],
    _count: { orders: 0 },
    ...overrides,
  });
  let products: Record<string, ReturnType<typeof record>>;

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'ready-case-tests-only-secret-at-least-32-chars',
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
    products = {
      [modelId]: record(modelId),
      [otherModelId]: record(otherModelId, { name: 'iPhone 16' }),
      [readyId]: record(readyId, {
        name: 'iPhone 15 – Marble',
        printAreas: null,
        baseProductId: modelId,
      }),
    };
    category.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        builderType: where.id === categoryId ? 'CASE' : 'JEWELRY',
        designCategoryId: null,
      }),
    );
    product.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        products[where.id] ?? null,
    );
    product.create.mockImplementation(async ({ data }) => ({
      id: 'new',
      ...data,
    }));
    product.update.mockImplementation(async ({ data }) => data);
    product.findMany.mockResolvedValue([]);
    product.count.mockResolvedValue(0);
    subCategory.findMany.mockResolvedValue([
      {
        id: libraryId,
        categoryId,
        name: 'Albanian Eagle',
        isActive: true,
        price: 200,
        type: 'ILLUSTRATION',
      },
    ]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  const createCompany = (fields: Record<string, string>) => {
    const call = request(app.getHttpServer())
      .post('/api/v1/products')
      .auth(tokens[adminId], { type: 'bearer' })
      .field('origin', 'COMPANY')
      .field('name', 'iPhone 15 – Marble')
      .field('price', '2700')
      .field('stock', '3')
      // Like the admin panel: case photos are stored untouched.
      .field('removeBackground', 'false');
    for (const [key, value] of Object.entries({ categoryId, ...fields }))
      call.field(key, value);
    return call.attach('file', jpeg, 'marble.jpg');
  };
  const patch = (
    id: string,
    fields: Record<string, string>,
    user = adminId,
  ) => {
    const call = request(app.getHttpServer())
      .patch('/api/v1/products/' + id)
      .auth(tokens[user], { type: 'bearer' });
    for (const [key, value] of Object.entries(fields)) call.field(key, value);
    return call;
  };

  describe('create', () => {
    it('creates a ready-made case linked to the phone model it fits', async () => {
      await createCompany({ baseProductId: modelId }).expect(201);
      const data = product.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        origin: 'COMPANY',
        name: 'iPhone 15 – Marble',
        baseProductId: modelId,
        price: 2700,
        stock: 3,
      });
      expect(data.printAreas).toBeUndefined();
      // The response carries the model, as every product response does.
      expect(product.create.mock.calls[0][0].include.baseProduct).toBeTruthy();
    });

    it('still creates phone models with a print area and no base', async () => {
      await createCompany({ printAreas: JSON.stringify({ front }) }).expect(
        201,
      );
      expect(product.create.mock.calls[0][0].data).toMatchObject({
        printAreas: { front },
      });
      expect(
        product.create.mock.calls[0][0].data.baseProductId,
      ).toBeUndefined();
    });

    it.each([
      [
        'both a print area and a phone model',
        { baseProductId: modelId, printAreas: JSON.stringify({ front }) },
        'A ready-made case has no print area',
      ],
      [
        'neither a print area nor a phone model',
        {},
        'Give a phone model its printable area',
      ],
      [
        'a ready-made case as its phone model',
        { baseProductId: readyId },
        'Phone model not found in this category',
      ],
      [
        'a missing phone model',
        { baseProductId: designId },
        'Phone model not found in this category',
      ],
    ])('rejects a case with %s', async (_case, fields, message) => {
      const response = await createCompany(fields).expect(400);
      expect(response.body.message).toContain(message);
      expect(product.create).not.toHaveBeenCalled();
    });

    it('rejects a phone model of another category or a customer design', async () => {
      products[otherModelId] = record(otherModelId, {
        categoryId: otherCategoryId,
      });
      products[designId] = record(designId, { origin: 'CUSTOMER' });
      for (const baseProductId of [otherModelId, designId])
        await createCompany({ baseProductId }).expect(400);
      expect(product.create).not.toHaveBeenCalled();
    });

    it('rejects an inactive phone model', async () => {
      products[modelId] = record(modelId, { isActive: false });
      const response = await createCompany({ baseProductId: modelId }).expect(
        400,
      );
      expect(response.body.message).toContain('no longer available');
    });

    it('links only phone case products to a base', async () => {
      const response = await createCompany({
        categoryId: otherCategoryId,
        baseProductId: modelId,
      }).expect(400);
      expect(response.body.message).toContain(
        'Only ready-made phone cases are linked to a phone model',
      );
    });
  });

  describe('update', () => {
    it('moves a ready-made case to another phone model', async () => {
      await patch(readyId, { baseProductId: otherModelId }).expect(200);
      expect(product.update.mock.calls[0][0].data.baseProduct).toEqual({
        connect: { id: otherModelId },
      });
    });

    it('turns a ready-made case into a phone model', async () => {
      await patch(readyId, {
        baseProductId: '',
        printAreas: JSON.stringify({ front }),
      }).expect(200);
      const data = product.update.mock.calls[0][0].data;
      expect(data.baseProduct).toEqual({ disconnect: true });
      expect(data.printAreas).toEqual({ front });
    });

    it('keeps the kinds apart', async () => {
      // A model linked to another model would be both kinds.
      await patch(modelId, { baseProductId: otherModelId }).expect(400);
      // A ready-made case given a print area.
      await patch(readyId, { printAreas: JSON.stringify({ front }) }).expect(
        400,
      );
      // A ready-made case unlinked without becoming a model.
      await patch(readyId, { baseProductId: '' }).expect(400);
      // Its own phone model.
      await patch(readyId, {
        baseProductId: readyId,
      }).expect(400);
      expect(product.update).not.toHaveBeenCalled();
    });

    it('keeps a phone model that products are made on', async () => {
      product.count.mockResolvedValue(2);
      const response = await patch(modelId, {
        printAreas: 'null',
        baseProductId: otherModelId,
      }).expect(400);
      expect(response.body.message).toContain(
        '2 products are made on this phone model',
      );
      expect(product.count).toHaveBeenCalledWith({
        where: { baseProductId: modelId },
      });
      expect(product.update).not.toHaveBeenCalled();
    });

    it('does not recheck the kind on unrelated edits', async () => {
      await patch(readyId, { price: '2900', stock: '5' }).expect(200);
      expect(product.update.mock.calls[0][0].data).toMatchObject({
        price: 2900,
        stock: 5,
      });
      expect(product.update.mock.calls[0][0].data.baseProduct).toBeUndefined();
    });

    it('never moves a customer design to another base', async () => {
      products[designId] = record(designId, {
        origin: 'CUSTOMER',
        createdById: ownerId,
        printAreas: null,
        baseProductId: modelId,
      });
      const response = await patch(designId, {
        baseProductId: otherModelId,
      }).expect(400);
      expect(response.body.message).toContain('keeps its base product');
    });
  });

  it('never makes a customer design on a ready-made case', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .auth(tokens[ownerId], { type: 'bearer' })
      .field('name', 'My case')
      .field('categoryId', categoryId)
      .field('baseProductId', readyId)
      .field(
        'items',
        JSON.stringify([
          {
            subCategoryId: libraryId,
            quantity: 1,
            x: 0.5,
            y: 0.5,
            scale: 1,
            rotation: 0,
          },
        ]),
      )
      .expect(400);
    expect(response.body.message).toContain(
      'Base product not found in this category',
    );
    expect(product.create).not.toHaveBeenCalled();
    expect(putKeys()).toEqual([]);
  });
});
