import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { GiftPackagingModule } from '../../src/modules/gift-packaging/gift-packaging.module.js';
import { ProductsModule } from '../../src/modules/products/products.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { setupApp } from '../../src/config/setup-app.js';

const delegate = () => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
});
const dbError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Private query data', {
    code,
    clientVersion: '7.10.0',
  });

describe('Gift packaging HTTP', () => {
  let app: INestApplication<App>;
  let token: string;
  const userId = 'ac78a80a-ce2b-4c45-8076-fca001c71418';
  const boxId = 'b1dfc7b7-2a71-46c6-bfba-a453d847044f';
  const transparentId = 'a1dfc7b7-2a71-46c6-bfba-a453d847044f';
  const pinkId = 'c1dfc7b7-2a71-46c6-bfba-a453d847044f';
  const categoryId = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const subCategoryId = 'f5cf6f87-2a71-46c6-bfba-a453d847044f';
  const pink = {
    id: pinkId,
    packagingId: boxId,
    name: 'Pink',
    hex: '#E8B4BC',
    imageKey: null,
    priceAdjustment: 50,
    stock: 5,
    isActive: true,
  };
  const box = {
    id: boxId,
    name: 'Classic Closed Box',
    description: 'Keep it a surprise',
    type: 'OPAQUE',
    imageKey: 'packaging/box.png',
    price: 500,
    stock: 0,
    isActive: true,
    sortOrder: 1,
    colors: [pink],
  };
  const transparent = {
    ...box,
    id: transparentId,
    name: 'Transparent Box',
    type: 'TRANSPARENT',
    price: 400,
    stock: 20,
    imageKey: null,
    colors: [],
  };
  const giftPackaging = delegate();
  const giftPackagingColor = delegate();
  const user = delegate();
  const product = delegate();
  const category = delegate();
  const subCategory = delegate();
  const prisma = {
    giftPackaging,
    giftPackagingColor,
    user,
    product,
    category,
    subCategory,
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  const base = '/api/v1/gift-packaging';
  const signedIn = (role: 'ADMIN' | 'CUSTOMER') =>
    user.findUnique.mockResolvedValue({
      id: userId,
      firstName: 'Test',
      lastName: 'User',
      isActive: true,
      role,
    });

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'test-only-jwt-secret-at-least-32-characters',
    );
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
    const module = await Test.createTestingModule({
      imports: [GiftPackagingModule, ProductsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    token = await module
      .get(JwtService)
      .signAsync({ sub: userId, tokenUse: 'access' });
  });
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.$transaction.mockImplementation(
      (operation: (tx: typeof prisma) => Promise<unknown>) => operation(prisma),
    );
    signedIn('ADMIN');
    giftPackaging.findMany.mockResolvedValue([transparent, box]);
    giftPackaging.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === boxId
            ? box
            : where.id === transparentId
              ? transparent
              : null,
        ),
    );
    giftPackaging.create.mockImplementation(({ data }: { data: object }) =>
      Promise.resolve({ ...transparent, ...data, colors: [] }),
    );
    giftPackaging.update.mockResolvedValue(box);
    giftPackagingColor.findFirst.mockResolvedValue(pink);
    giftPackagingColor.create.mockImplementation(({ data }: { data: object }) =>
      Promise.resolve({ ...pink, ...data }),
    );
    giftPackagingColor.update.mockResolvedValue(pink);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('lists packaging with colours publicly, with image URLs instead of keys', async () => {
    const response = await request(app.getHttpServer()).get(base).expect(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[1].colors[0]).toMatchObject({
      name: 'Pink',
      hex: '#E8B4BC',
    });
    expect(response.body[1]).toHaveProperty('imageUrl');
    expect(giftPackaging.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { colors: { orderBy: expect.any(Array) } },
      }),
    );
  });

  it('requires an admin for every change', async () => {
    await request(app.getHttpServer())
      .post(base)
      .send({ name: 'Box', type: 'OPAQUE' })
      .expect(401);
    signedIn('CUSTOMER');
    const auth = 'Bearer ' + token;
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', auth)
      .send({ name: 'Box', type: 'OPAQUE' })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`${base}/${boxId}`)
      .set('Authorization', auth)
      .send({ isActive: false })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`${base}/${boxId}`)
      .set('Authorization', auth)
      .expect(403);
    await request(app.getHttpServer())
      .post(`${base}/${boxId}/colors`)
      .set('Authorization', auth)
      .send({ name: 'Red', hex: '#FF0000' })
      .expect(403);
    expect(giftPackaging.create).not.toHaveBeenCalled();
    expect(giftPackagingColor.create).not.toHaveBeenCalled();
  });

  it('creates transparent and opaque packaging and validates the type', async () => {
    const auth = 'Bearer ' + token;
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', auth)
      .send({
        name: ' Transparent Box ',
        type: 'TRANSPARENT',
        price: 400,
        stock: 20,
      })
      .expect(201);
    expect(giftPackaging.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Transparent Box',
          type: 'TRANSPARENT',
          price: 400,
        }),
      }),
    );
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', auth)
      .send({ name: 'Classic Closed Box', type: 'OPAQUE', price: 500 })
      .expect(201);
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', auth)
      .send({ name: 'Basket', type: 'WICKER' })
      .expect(400);
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', auth)
      .send({ name: 'Slim Closed Box', type: 'OPAQUE', shape: 'RECTANGULAR' })
      .expect(201);
    expect(giftPackaging.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shape: 'RECTANGULAR' }),
      }),
    );
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', auth)
      .send({ name: 'Round Box', type: 'OPAQUE', shape: 'ROUND' })
      .expect(400);
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', auth)
      .send({ name: 'Box', type: 'OPAQUE', price: -1 })
      .expect(400);
  });

  it('updates and deactivates packaging', async () => {
    await request(app.getHttpServer())
      .patch(`${base}/${boxId}`)
      .set('Authorization', 'Bearer ' + token)
      .send({ isActive: false, price: 450 })
      .expect(200);
    expect(giftPackaging.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: boxId },
        data: expect.objectContaining({ isActive: false, price: 450 }),
      }),
    );
  });

  it('keeps colours on closed packaging only', async () => {
    const auth = 'Bearer ' + token;
    await request(app.getHttpServer())
      .post(`${base}/${boxId}/colors`)
      .set('Authorization', auth)
      .send({ name: 'Beige', hex: '#e5d3b3', stock: 0 })
      .expect(201);
    expect(giftPackagingColor.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        packagingId: boxId,
        name: 'Beige',
        hex: '#E5D3B3',
        stock: 0,
      }),
    });
    await request(app.getHttpServer())
      .post(`${base}/${transparentId}/colors`)
      .set('Authorization', auth)
      .send({ name: 'Clear', hex: '#FFFFFF' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`${base}/${boxId}/colors`)
      .set('Authorization', auth)
      .send({ name: 'Red', hex: 'red' })
      .expect(400);
    // A box with colours cannot quietly become transparent.
    await request(app.getHttpServer())
      .patch(`${base}/${boxId}`)
      .set('Authorization', auth)
      .send({ type: 'TRANSPARENT' })
      .expect(400);
  });

  it('edits and removes a colour of its own packaging only', async () => {
    const auth = 'Bearer ' + token;
    await request(app.getHttpServer())
      .patch(`${base}/${boxId}/colors/${pinkId}`)
      .set('Authorization', auth)
      .send({ stock: 9 })
      .expect(200);
    expect(giftPackagingColor.update).toHaveBeenCalledWith({
      where: { id: pinkId, packagingId: boxId },
      data: expect.objectContaining({ stock: 9 }),
    });
    giftPackagingColor.findFirst.mockResolvedValue(null);
    await request(app.getHttpServer())
      .delete(`${base}/${transparentId}/colors/${pinkId}`)
      .set('Authorization', auth)
      .expect(404);
  });

  it('refuses to delete packaging used by designs and suggests deactivating', async () => {
    giftPackaging.delete.mockRejectedValue(dbError('P2003'));
    const response = await request(app.getHttpServer())
      .delete(`${base}/${boxId}`)
      .set('Authorization', 'Bearer ' + token)
      .expect(409);
    expect(response.body.message).toContain('deactivate it instead');
    expect(JSON.stringify(response.body)).not.toContain('Private query data');
  });

  describe('gift designs', () => {
    const products = '/api/v1/products';
    const design = {
      categoryId,
      name: 'Birthday Gift',
      items: [{ subCategoryId, quantity: 1, position: 0, x: 0.5, y: 0.5 }],
    };
    beforeEach(() => {
      signedIn('CUSTOMER');
      prisma.$queryRaw.mockResolvedValue([]);
      category.findUnique.mockResolvedValue({
        id: categoryId,
        builderType: 'GIFT',
        builderConfig: null,
        designCategoryId: null,
      });
      subCategory.findMany.mockResolvedValue([
        {
          id: subCategoryId,
          categoryId,
          name: 'Mug',
          isActive: true,
          price: 800,
          type: 'ITEM',
        },
      ]);
      product.create.mockImplementation(({ data }: { data: object }) =>
        Promise.resolve({
          id: 'e1dfc7b7-2a71-46c6-bfba-a453d847044f',
          ...data,
        }),
      );
    });

    it('prices the packaging and colour from the database, never the client', async () => {
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send({
          ...design,
          giftPackagingId: boxId,
          giftPackagingColorId: pinkId,
        })
        .expect(201);
      expect(product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            giftPackagingId: boxId,
            giftPackagingColorId: pinkId,
            packagingPrice: 550,
            price: 800 + 550,
          }),
        }),
      );
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send({ ...design, giftPackagingId: boxId, packagingPrice: 0 })
        .expect(400);
    });

    it('saves transparent packaging without a colour and never takes stock', async () => {
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send({ ...design, giftPackagingId: transparentId })
        .expect(201);
      expect(product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            giftPackagingColorId: null,
            packagingPrice: 400,
            price: 1200,
          }),
        }),
      );
      expect(giftPackaging.updateMany).not.toHaveBeenCalled();
      expect(giftPackagingColor.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a missing colour, a colour of other packaging, and non-gift designs', async () => {
      const auth = 'Bearer ' + token;
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', auth)
        .send({ ...design, giftPackagingId: boxId })
        .expect(400);
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', auth)
        .send({
          ...design,
          giftPackagingId: transparentId,
          giftPackagingColorId: pinkId,
        })
        .expect(400);
      category.findUnique.mockResolvedValue({
        id: categoryId,
        builderType: 'BOUQUET',
        builderConfig: null,
        designCategoryId: null,
      });
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', auth)
        .send({ ...design, giftPackagingId: transparentId })
        .expect(400);
      expect(product.create).not.toHaveBeenCalled();
    });

    it('keeps designs without packaging unchanged', async () => {
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send(design)
        .expect(201);
      expect(giftPackaging.findUnique).not.toHaveBeenCalled();
      expect(product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ packagingPrice: 0, price: 800 }),
        }),
      );
    });
  });
});
