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
    capacity: null as number | null,
    allowedTypes: [] as string[],
    suggestedBundles: null as unknown,
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

  describe('capacity, types and bundles', () => {
    const teddyId = 'f6cf6f87-2a71-46c6-bfba-a453d847044f';
    const teaId = 'f7cf6f87-2a71-46c6-bfba-a453d847044f';
    const giftItem = (id: string, name: string, type: string | null) => ({
      id,
      name,
      type,
      category: { builderType: 'GIFT' },
    });
    const send = (body: object, id?: string) => {
      const call = id
        ? request(app.getHttpServer()).patch(`${base}/${id}`)
        : request(app.getHttpServer()).post(base);
      return call.set('Authorization', 'Bearer ' + token).send(body);
    };
    beforeEach(() => {
      subCategory.findMany.mockResolvedValue([
        giftItem(teddyId, 'Teddy', 'Toys'),
        giftItem(teaId, 'Herbal tea', 'Drinks'),
      ]);
    });

    it('stores capacity, cleaned types and merged bundles', async () => {
      await send({
        name: 'Gift Box',
        type: 'OPAQUE',
        capacity: 6,
        allowedTypes: [' Toys ', 'toys', 'Drinks'],
        suggestedBundles: [
          {
            name: ' Cozy night ',
            items: [
              { subCategoryId: teaId, quantity: 1 },
              { subCategoryId: teaId, quantity: 1 },
              { subCategoryId: teddyId, quantity: 1 },
            ],
          },
        ],
      }).expect(201);
      expect(giftPackaging.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            capacity: 6,
            allowedTypes: ['Toys', 'Drinks'],
            suggestedBundles: [
              {
                name: 'Cozy night',
                items: [
                  { subCategoryId: teaId, quantity: 2 },
                  { subCategoryId: teddyId, quantity: 1 },
                ],
              },
            ],
          }),
        }),
      );
    });

    it('rejects bundles that do not fit, are not gift items or repeat a name', async () => {
      const bundle = (quantity: number, name = 'Big') => ({
        name,
        items: [{ subCategoryId: teddyId, quantity }],
      });
      const tooBig = await send({
        name: 'Gift Box',
        type: 'OPAQUE',
        capacity: 2,
        suggestedBundles: [bundle(3)],
      }).expect(400);
      expect(tooBig.body.message).toBe(
        '"Big" has 3 items, but Gift Box holds 2 items',
      );
      await send({
        name: 'Gift Box',
        type: 'OPAQUE',
        allowedTypes: ['Drinks'],
        suggestedBundles: [bundle(1)],
      }).expect(400);
      await send({
        name: 'Gift Box',
        type: 'OPAQUE',
        suggestedBundles: [bundle(1, 'Same'), bundle(1, 'same')],
      }).expect(400);
      subCategory.findMany.mockResolvedValue([
        {
          ...giftItem(teddyId, 'Teddy', 'Toys'),
          category: { builderType: 'MUG' },
        },
      ]);
      await send({
        name: 'Gift Box',
        type: 'OPAQUE',
        suggestedBundles: [bundle(1)],
      }).expect(400);
      expect(giftPackaging.create).not.toHaveBeenCalled();
    });

    it('checks stored bundles again when the capacity shrinks', async () => {
      giftPackaging.findUnique.mockResolvedValue({
        ...box,
        capacity: 6,
        suggestedBundles: [
          { name: 'Cozy', items: [{ subCategoryId: teddyId, quantity: 4 }] },
        ],
      });
      await send({ capacity: 3 }, boxId).expect(400);
      await send({ capacity: 4 }, boxId).expect(200);
      // Unrelated edits never re-check bundles.
      subCategory.findMany.mockClear();
      await send({ price: 700 }, boxId).expect(200);
      expect(subCategory.findMany).not.toHaveBeenCalled();
    });

    it('clears the capacity and bundles with null', async () => {
      await send({ capacity: null, suggestedBundles: null }, boxId).expect(200);
      expect(giftPackaging.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            capacity: null,
            suggestedBundles: Prisma.DbNull,
          }),
        }),
      );
    });
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

    it('rejects more items than the packaging holds, counting quantities', async () => {
      giftPackaging.findUnique.mockResolvedValue({
        ...transparent,
        capacity: 2,
      });
      const response = await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send({
          ...design,
          giftPackagingId: transparentId,
          items: [{ subCategoryId, quantity: 3, position: 0, x: 0.5, y: 0.5 }],
        })
        .expect(400);
      expect(response.body.message).toBe(
        'Transparent Box holds up to 2 items; remove 1 item to fit',
      );
      expect(product.create).not.toHaveBeenCalled();
    });

    it('accepts only the item types the packaging allows', async () => {
      giftPackaging.findUnique.mockResolvedValue({
        ...transparent,
        allowedTypes: ['Treats'],
      });
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send({ ...design, giftPackagingId: transparentId })
        .expect(400);
      giftPackaging.findUnique.mockResolvedValue({
        ...transparent,
        allowedTypes: ['item'],
      });
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send({ ...design, giftPackagingId: transparentId })
        .expect(201);
    });

    it('stores the gift card trimmed, for gift designs only', async () => {
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send({
          ...design,
          giftPackagingId: transparentId,
          giftRecipient: '  Mom ',
          giftMessage: ' Happy birthday!\r\nLove you ',
        })
        .expect(201);
      expect(product.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            giftRecipient: 'Mom',
            giftMessage: 'Happy birthday!\nLove you',
          }),
        }),
      );
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send({ ...design, giftMessage: 'x'.repeat(201) })
        .expect(400);
      category.findUnique.mockResolvedValue({
        id: categoryId,
        builderType: 'BOUQUET',
        builderConfig: null,
        designCategoryId: null,
      });
      await request(app.getHttpServer())
        .post(products)
        .set('Authorization', 'Bearer ' + token)
        .send({ ...design, giftMessage: 'Hi' })
        .expect(400);
    });

    it('shows the gift card only to its creator and admins', async () => {
      const id = 'e1dfc7b7-2a71-46c6-bfba-a453d847044f';
      const gift = (createdById: string) => ({
        id,
        origin: 'CUSTOMER',
        createdById,
        categoryId,
        name: 'Birthday Gift',
        price: 1200,
        giftRecipient: 'Mom',
        giftMessage: 'Happy birthday!',
        category: { builderType: 'GIFT' },
        items: [],
      });
      product.findUnique.mockResolvedValue(
        gift('9f0e8d7c-2a71-46c6-bfba-a453d847044f'),
      );
      const other = await request(app.getHttpServer())
        .get(`${products}/${id}`)
        .set('Authorization', 'Bearer ' + token)
        .expect(200);
      expect(other.body).toMatchObject({
        giftRecipient: null,
        giftMessage: null,
      });
      const anonymous = await request(app.getHttpServer())
        .get(`${products}/${id}`)
        .expect(200);
      expect(anonymous.body.giftMessage).toBeNull();
      signedIn('ADMIN');
      const admin = await request(app.getHttpServer())
        .get(`${products}/${id}`)
        .set('Authorization', 'Bearer ' + token)
        .expect(200);
      expect(admin.body.giftRecipient).toBe('Mom');
      signedIn('CUSTOMER');
      product.findUnique.mockResolvedValue(gift(userId));
      const own = await request(app.getHttpServer())
        .get(`${products}/${id}`)
        .set('Authorization', 'Bearer ' + token)
        .expect(200);
      expect(own.body).toMatchObject({
        giftRecipient: 'Mom',
        giftMessage: 'Happy birthday!',
      });
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
