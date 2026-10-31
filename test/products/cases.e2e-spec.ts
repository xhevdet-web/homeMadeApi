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
import { ForegroundSegmentationService } from '../../src/storage/foreground-segmentation.service.js';

// Phone cases: COMPANY products are the phone models (template, overlay, print area,
// stock); a customer design is one library design or own photo placed on a model.
describe('Phone case studio HTTP', () => {
  let app: INestApplication<App>;
  const tokens: Record<string, string> = {};
  const adminId = 'a0000000-2a71-46c6-bfba-a453d847044f';
  const ownerId = 'b0000000-2a71-46c6-bfba-a453d847044f';
  const strangerId = 'c0000000-2a71-46c6-bfba-a453d847044f';
  const categoryId = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const modelId = 'c7d1f0a4-2a71-46c6-bfba-a453d847044f';
  const designId = 'f5cf6f87-2a71-46c6-bfba-a453d847044f';
  const photoId = 'e5cf6f87-2a71-46c6-bfba-a453d847044f';
  const designProductId = 'a4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const roles: Record<string, string> = {
    [adminId]: 'ADMIN',
    [ownerId]: 'CUSTOMER',
    [strangerId]: 'CUSTOMER',
  };
  const delegate = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    groupBy: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  });
  const category = delegate();
  const subCategory = delegate();
  const product = delegate();
  const order = delegate();
  const tx = { category, subCategory, product, order, $queryRaw: vi.fn() };
  const send = vi.spyOn(S3Client.prototype, 'send');
  const segment = vi.spyOn(ForegroundSegmentationService.prototype, 'mask');
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
  let jpeg: Buffer;
  let png: Buffer;

  const model = (overrides: object = {}) => ({
    id: modelId,
    name: 'iPhone 14',
    origin: 'COMPANY',
    categoryId,
    isActive: true,
    price: 1500,
    stock: 20,
    sizes: null,
    ...overrides,
  });
  const caseDesign = {
    id: designProductId,
    origin: 'CUSTOMER',
    createdById: ownerId,
    categoryId,
    name: 'My case',
    price: 1500,
    category: { id: categoryId, name: 'Cases', builderType: 'CASE' },
    items: [{ subCategoryId: photoId, customImageKey: 'custom-designs/x.jpg' }],
  };
  const bracelet = {
    ...caseDesign,
    id: 'b4dfc7b7-2a71-46c6-bfba-a453d847044f',
    category: { id: 'other', name: 'Bracelets', builderType: 'JEWELRY' },
  };
  const placed = { x: 0.5, y: 0.48, scale: 1.25, rotation: 15 };

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'case-tests-only-secret-at-least-32-characters',
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
    for (const userId of [adminId, ownerId, strangerId])
      tokens[userId] = await jwt.signAsync({ sub: userId, tokenUse: 'access' });
    jpeg = await sharp({
      create: { width: 16, height: 16, channels: 3, background: 'teal' },
    })
      .jpeg()
      .toBuffer();
    png = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    send.mockImplementation(async () => ({}) as never);
    segment.mockImplementation(async (_rgb, width, height) =>
      Buffer.alloc(width * height, 255),
    );
    category.findUnique.mockResolvedValue({
      id: categoryId,
      builderType: 'CASE',
      designCategoryId: null,
    });
    product.findUnique.mockResolvedValue(model());
    product.create.mockImplementation(async ({ data }) => ({
      id: 'new',
      ...data,
    }));
    subCategory.findMany.mockResolvedValue([
      {
        id: designId,
        categoryId,
        name: 'Albanian Eagle',
        isActive: true,
        price: 200,
        type: 'ILLUSTRATION',
      },
      {
        id: photoId,
        categoryId,
        name: 'Your own photo',
        isActive: true,
        price: 0,
        type: 'CUSTOM_UPLOAD',
      },
    ]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  const design = (items: object[], user = ownerId) =>
    request(app.getHttpServer())
      .post('/api/v1/products')
      .auth(tokens[user], { type: 'bearer' })
      .field('name', 'My case')
      .field('categoryId', categoryId)
      .field('baseProductId', modelId)
      .field('items', JSON.stringify(items));

  describe('phone models (admin)', () => {
    it('creates a model with brand, order, print area, camera and an untouched overlay', async () => {
      const printAreas = {
        front: { x: 0.04, y: 0.02, width: 0.92, height: 0.96, radius: 0.16 },
        camera: { x: 0.08, y: 0.03, width: 0.42, height: 0.2, radius: 0.2 },
      };
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .auth(tokens[adminId], { type: 'bearer' })
        .field('origin', 'COMPANY')
        .field('categoryId', categoryId)
        .field('name', 'iPhone 14')
        .field('deviceBrand', 'apple')
        .field('sortOrder', '3')
        .field('price', '1500')
        .field('stock', '20')
        .field('removeBackground', 'false')
        .field('printAreas', JSON.stringify(printAreas))
        .attach('file', jpeg, 'template.jpg')
        .attach('overlayImage', png, 'overlay.png')
        .expect(201);
      // Template and overlay must stay aligned: neither is background-processed.
      expect(segment).not.toHaveBeenCalled();
      const [templateKey, overlayKey] = putKeys();
      const data = product.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        origin: 'COMPANY',
        name: 'iPhone 14',
        deviceBrand: 'APPLE',
        sortOrder: 3,
        price: 1500,
        stock: 20,
        imageKey: templateKey,
        overlayImageKey: overlayKey,
        printAreas,
      });
    });

    it('rejects an invalid corner radius and unknown print area fields', async () => {
      for (const front of [
        { x: 0, y: 0, width: 1, height: 1, radius: 0.8 },
        { x: 0, y: 0, width: 1, height: 1, bleed: 2 },
      ])
        await request(app.getHttpServer())
          .post('/api/v1/products')
          .auth(tokens[adminId], { type: 'bearer' })
          .field('origin', 'COMPANY')
          .field('categoryId', categoryId)
          .field('name', 'iPhone 14')
          .field('price', '1500')
          .field('stock', '20')
          .field('printAreas', JSON.stringify({ front }))
          .attach('file', png, 'template.png')
          .expect(400);
      expect(putKeys()).toEqual([]);
    });

    it('keeps model fields and overlays admin-only', async () => {
      await design([{ subCategoryId: designId, quantity: 1, ...placed }])
        .field('deviceBrand', 'APPLE')
        .expect(400);
      await design([{ subCategoryId: designId, quantity: 1, ...placed }])
        .attach('overlayImage', png, 'overlay.png')
        .expect(400);
      expect(product.create).not.toHaveBeenCalled();
    });
  });

  describe('overlays', () => {
    const overlay = (image: Buffer, name = 'overlay.png') =>
      request(app.getHttpServer())
        .post('/api/v1/products')
        .auth(tokens[adminId], { type: 'bearer' })
        .field('origin', 'COMPANY')
        .field('categoryId', categoryId)
        .field('name', 'iPhone 14')
        .field('price', '1500')
        .field('stock', '20')
        .attach('file', png, 'template.png')
        .attach('overlayImage', image, name);

    it('rejects an opaque overlay, which would hide the customer image', async () => {
      const opaque = await sharp({
        create: { width: 16, height: 16, channels: 4, background: '#FFFFFF' },
      })
        .png()
        .toBuffer();
      const response = await overlay(opaque).expect(400);
      expect(response.body.message).toContain('mostly transparent');
      const response2 = await overlay(jpeg, 'overlay.jpg').expect(400);
      expect(response2.body.message).toContain('transparent PNG');
      expect(putKeys()).toEqual([]);
    });

    it('removes an overlay on request and deletes its file', async () => {
      product.findUnique.mockResolvedValue({
        ...model(),
        imageKey: 'products/t.png',
        overlayImageKey: 'products/old-overlay.png',
        items: [],
        _count: { orders: 0 },
      });
      product.update.mockImplementation(async ({ data }) => data);
      product.findMany.mockResolvedValue([]);
      await request(app.getHttpServer())
        .patch('/api/v1/products/' + modelId)
        .auth(tokens[adminId], { type: 'bearer' })
        .field('removeOverlay', 'true')
        .expect(200);
      expect(product.update.mock.calls[0][0].data.overlayImageKey).toBeNull();
      const deleted = send.mock.calls
        .map(([command]) => command as { input?: { Key?: string } })
        .map((command) => command.input?.Key);
      expect(deleted).toContain('products/old-overlay.png');
    });
  });

  describe('customer designs', () => {
    it('saves a library design on the model with its transform; price comes from the database', async () => {
      await design([
        { subCategoryId: designId, quantity: 1, position: 0, ...placed },
      ]).expect(201);
      const data = product.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        origin: 'CUSTOMER',
        baseProductId: modelId,
        basePrice: 1500,
        price: 1500 + 200,
        itemCount: 1,
      });
      expect(data.items.create[0]).toMatchObject({
        subCategoryId: designId,
        unitPrice: 200,
        side: undefined,
        ...placed,
      });
      // Saving never touches stock.
      expect(product.update).not.toHaveBeenCalled();
    });

    it('stores an own JPEG photo untouched and privately in custom-designs', async () => {
      await design([
        {
          subCategoryId: photoId,
          quantity: 1,
          customDesignIndex: 0,
          ...placed,
        },
      ])
        .attach('customDesigns', jpeg, 'photo.jpg')
        .expect(201);
      const keys = putKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^custom-designs\/.+\.jpg$/);
      expect(segment).not.toHaveBeenCalled();
      const data = product.create.mock.calls[0][0].data;
      expect(data.items.create[0]).toMatchObject({
        customImageKey: keys[0],
        unitPrice: 0,
      });
      expect(data.price).toBe(1500);
    });

    it('rejects a file that only claims to be an image', async () => {
      await design([
        {
          subCategoryId: photoId,
          quantity: 1,
          customDesignIndex: 0,
          ...placed,
        },
      ])
        .attach('customDesigns', Buffer.from('<svg/>'), {
          filename: 'photo.jpg',
          contentType: 'image/jpeg',
        })
        .expect(400);
      expect(putKeys()).toEqual([]);
    });

    it.each([
      ['no design', [], 'exactly one design or photo'],
      [
        'two designs',
        [
          { subCategoryId: designId, quantity: 1, ...placed },
          { subCategoryId: designId, quantity: 1, ...placed },
        ],
        'exactly one design or photo',
      ],
      [
        'a design without a position',
        [{ subCategoryId: designId, quantity: 1 }],
        'require x and y',
      ],
    ])('rejects %s', async (_case, items, message) => {
      const response = await design(items).expect(400);
      expect(response.body.message).toContain(message);
      expect(product.create).not.toHaveBeenCalled();
    });

    it.each([
      [undefined, 'Choose your phone model'],
      [{ isActive: false }, 'iPhone 14 is no longer available'],
      [{ stock: 0 }, 'iPhone 14 is sold out'],
      [{ origin: 'CUSTOMER' }, 'Base product not found in this category'],
    ])('rejects an unavailable model (%o)', async (state, message) => {
      product.findUnique.mockResolvedValue(state ? model(state) : null);
      const req = state
        ? design([{ subCategoryId: designId, quantity: 1, ...placed }])
        : request(app.getHttpServer())
            .post('/api/v1/products')
            .auth(tokens[ownerId], { type: 'bearer' })
            .field('name', 'My case')
            .field('categoryId', categoryId)
            .field(
              'items',
              JSON.stringify([
                { subCategoryId: designId, quantity: 1, ...placed },
              ]),
            );
      const response = await req.expect(400);
      expect(response.body.message).toBe(message);
    });

    it('rejects personalised text, which cases do not offer yet', async () => {
      await design([{ subCategoryId: designId, quantity: 1, ...placed }])
        .field(
          'textLayers',
          JSON.stringify([
            { id: 't', text: 'Hi', x: 0.5, y: 0.5, scale: 1, rotation: 0 },
          ]),
        )
        .expect(400);
    });
  });

  describe('privacy of customer photos', () => {
    beforeEach(() => {
      product.findUnique.mockResolvedValue(caseDesign);
      product.findMany.mockResolvedValue([caseDesign, bracelet]);
    });
    const get = (path: string, user?: string) => {
      const req = request(app.getHttpServer()).get('/api/v1' + path);
      return user ? req.auth(tokens[user], { type: 'bearer' }) : req;
    };

    it('shows a case design only to its creator and admins', async () => {
      await get('/products/' + designProductId, ownerId).expect(200);
      await get('/products/' + designProductId, adminId).expect(200);
      await get('/products/' + designProductId, strangerId).expect(404);
      await get('/products/' + designProductId).expect(404);
      // An expired or forged session reads anonymously.
      await request(app.getHttpServer())
        .get('/api/v1/products/' + designProductId)
        .set('Authorization', 'Bearer not-a-token')
        .expect(404);
    });

    it.each([
      '/products',
      '/users/' + ownerId + '/products',
      '/categories/' + categoryId + '/products',
      '/sub-categories/' + photoId + '/products',
    ])('leaves other customers’ cases out of %s', async (path) => {
      product.findUnique.mockResolvedValue({ id: 'parent' });
      category.findUnique.mockResolvedValue({ id: categoryId });
      subCategory.findUnique.mockResolvedValue({ id: photoId });
      tx.category.findUnique = category.findUnique;
      const ids = async (user?: string) =>
        (await get(path, user).expect(200)).body.map(
          (entry: { id: string }) => entry.id,
        );
      expect(await ids()).toEqual([bracelet.id]);
      expect(await ids(strangerId)).toEqual([bracelet.id]);
      expect(await ids(ownerId)).toEqual([designProductId, bracelet.id]);
      expect(await ids(adminId)).toEqual([designProductId, bracelet.id]);
    });

    it('never shows cases among other customers’ completed creations', async () => {
      order.groupBy.mockResolvedValue([
        { productId: caseDesign.id },
        { productId: bracelet.id },
      ]);
      order.findMany.mockResolvedValue([
        {
          id: 'o1',
          productId: caseDesign.id,
          updatedAt: new Date(),
          product: caseDesign,
        },
        {
          id: 'o2',
          productId: bracelet.id,
          updatedAt: new Date(),
          product: bracelet,
        },
      ]);
      const response = await get(
        '/products/creations/from-others',
        strangerId,
      ).expect(200);
      // The query itself leaves cases out, so five results stay five.
      expect(order.groupBy.mock.calls[0][0].where.product.category).toEqual({
        isActive: true,
        OR: [{ builderType: null }, { builderType: { not: 'CASE' } }],
      });
      expect(
        response.body.data.map(
          (entry: { product: { id: string } }) => entry.product.id,
        ),
      ).toEqual([bracelet.id]);
    });
  });
});
