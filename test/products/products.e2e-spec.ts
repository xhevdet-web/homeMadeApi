import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { ProductsModule } from '../../src/modules/products/products.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { setupApp } from '../../src/config/setup-app.js';

const delegate = () => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  groupBy: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
});
const dbError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Private query data', {
    code,
    clientVersion: '7.10.0',
  });

describe('Products HTTP CRUD', () => {
  let app: INestApplication<App>;
  let token: string;
  const userId = 'ac78a80a-ce2b-4c45-8076-fca001c71418';
  const categoryId = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const subCategoryId = 'f5cf6f87-2a71-46c6-bfba-a453d847044f';
  const id = 'a4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const otherId = 'b4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const product = delegate();
  const category = delegate();
  const subCategory = delegate();
  const user = delegate();
  const order = delegate();
  const creator = {
    id: userId,
    firstName: 'Test',
    lastName: 'User',
    userName: 'test',
  };
  const record = {
    id,
    createdById: userId,
    categoryId,
    subCategoryId,
    name: 'Bracelet',
    price: 1500,
    itemCount: 20,
    items: [{ subCategoryId, quantity: 20 }],
    _count: { orders: 0 },
    createdBy: creator,
    category: { id: categoryId, name: 'Jewelry' },
    subCategory: { id: subCategoryId, categoryId, name: 'Beads' },
  };
  const body = {
    categoryId,
    items: [{ subCategoryId, quantity: 20 }],
    name: ' Bracelet ',
  };
  const prisma = {
    product,
    category,
    subCategory,
    user,
    order,
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  const base = '/api/v1/products';

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'test-only-jwt-secret-at-least-32-characters',
    );
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
    const module = await Test.createTestingModule({ imports: [ProductsModule] })
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
    prisma.$queryRaw.mockResolvedValue([]);
    subCategory.findMany.mockResolvedValue([
      { ...record.subCategory, price: 75, isActive: true },
    ]);
    user.findUnique.mockResolvedValue({
      ...creator,
      isActive: true,
      role: 'ADMIN',
    });
    category.findUnique.mockResolvedValue(record.category);
    subCategory.findUnique.mockResolvedValue(record.subCategory);
    product.findUnique.mockResolvedValue(record);
    product.findMany.mockResolvedValue([record]);
    order.findMany.mockResolvedValue([]);
    product.create.mockResolvedValue(record);
    product.update.mockResolvedValue(record);
    product.delete.mockResolvedValue({ id, items: [] });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  const size = {
    id: 'medium',
    name: 'Medium',
    measurement: 18,
    unit: 'cm',
    maxItems: 18,
  };
  const baseId = 'c7d1f0a4-2a71-46c6-bfba-a453d847044f';
  const libraryId = 'e1d1f0a4-2a71-46c6-bfba-a453d847044f';
  // The COMPANY hoodie a customer designs on: one colour, stock per size.
  const baseProduct = (overrides: object = {}) => ({
    id: baseId,
    name: 'Black Essential Hoodie',
    origin: 'COMPANY',
    categoryId,
    isActive: true,
    price: 3500,
    stock: 0,
    sizes: [
      { size: 'L', stock: 35 },
      { size: 'XL', stock: 0 },
    ],
    ...overrides,
  });
  const apparelCategory = (overrides: object = {}) => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      builderType: 'APPAREL',
      designCategoryId: null,
      ...overrides,
    });
  };
  const placed = { side: 'FRONT', x: 0.5, y: 0.4, scale: 1.2, rotation: 15 };

  it('creates a design on a base product priced from it, keeping the chosen size', async () => {
    apparelCategory();
    product.findUnique.mockResolvedValue(baseProduct());
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', 'Bearer ' + token)
      .field('name', 'Custom Hoodie')
      .field('categoryId', categoryId)
      .field('baseProductId', baseId)
      .field('selectedSizeId', 'L')
      .expect(201);
    expect(product.create.mock.calls[0][0].data).toMatchObject({
      origin: 'CUSTOMER',
      baseProductId: baseId,
      selectedSize: { id: 'L', name: 'L' },
      basePrice: 3500,
      price: 3500,
      itemCount: 0,
      items: { create: [] },
    });
    // Saving a design never touches inventory.
    expect(product.update).not.toHaveBeenCalled();
  });

  it('adds the base product price to design prices and stores placements', async () => {
    apparelCategory();
    product.findUnique.mockResolvedValue(baseProduct({ price: 3900 }));
    await save({
      ...body,
      baseProductId: baseId,
      selectedSizeId: 'L',
      items: [{ subCategoryId, quantity: 20, ...placed }],
    }).expect(201);
    const data = product.create.mock.calls[0][0].data;
    expect(data.price).toBe(3900 + 20 * 75);
    expect(data.basePrice).toBe(3900);
    expect(data.items.create[0]).toMatchObject(placed);
  });

  it.each([
    [undefined, 'L', 'Choose the piece to design on'],
    ['missing', 'L', 'Base product not found in this category'],
    ['other-category', 'L', 'Base product not found in this category'],
    ['customer-design', 'L', 'Base product not found in this category'],
    ['inactive', 'L', 'Black Essential Hoodie is no longer available'],
    ['ok', undefined, 'Choose a size of Black Essential Hoodie'],
    ['ok', 'XXL', 'Black Essential Hoodie is not available in size XXL'],
    ['ok', 'XL', 'Black Essential Hoodie in size XL is sold out'],
  ])(
    'rejects apparel on an unavailable base (%s, size %s)',
    async (state, size, message) => {
      apparelCategory();
      product.findUnique.mockResolvedValue(
        state === 'missing'
          ? null
          : state === 'other-category'
            ? baseProduct({ categoryId: otherId })
            : state === 'customer-design'
              ? baseProduct({ origin: 'CUSTOMER' })
              : state === 'inactive'
                ? baseProduct({ isActive: false })
                : baseProduct(),
      );
      const response = await save({
        ...body,
        ...(state ? { baseProductId: baseId } : {}),
        ...(size ? { selectedSizeId: size } : {}),
        items: [{ subCategoryId, quantity: 1, ...placed }],
      }).expect(400);
      expect(response.body.message).toBe(message);
      expect(product.create).not.toHaveBeenCalled();
    },
  );

  it('requires a placement for every apparel design', async () => {
    apparelCategory();
    product.findUnique.mockResolvedValue(baseProduct());
    await save({ ...body, baseProductId: baseId, selectedSizeId: 'L' }).expect(
      400,
    );
    expect(product.create).not.toHaveBeenCalled();
  });

  it('accepts designs from the shared design library and rejects unrelated designs', async () => {
    apparelCategory({ designCategoryId: libraryId });
    product.findUnique.mockResolvedValue(baseProduct());
    subCategory.findMany.mockResolvedValue([
      {
        ...record.subCategory,
        categoryId: libraryId,
        price: 75,
        isActive: true,
      },
    ]);
    const design = {
      ...body,
      baseProductId: baseId,
      selectedSizeId: 'L',
      items: [{ subCategoryId, quantity: 1, ...placed }],
    };
    await save(design).expect(201);
    subCategory.findMany.mockResolvedValue([
      { ...record.subCategory, categoryId: otherId, price: 75, isActive: true },
    ]);
    await save(design).expect(400);
  });

  it('rejects retired garment and option fields', async () => {
    await save({ ...body, garmentVariantId: baseId }).expect(400);
    await save({ ...body, selectedOptions: {} }).expect(400);
    await save({ ...body, productType: 'READY_MADE' }).expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  it('never stores placements on jewelry designs', async () => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      builderType: 'JEWELRY',
      options: null,
    });
    await save({
      ...body,
      items: [{ subCategoryId, quantity: 20, ...placed }],
    }).expect(201);
    const item = product.create.mock.calls[0][0].data.items.create[0];
    expect(item.side).toBeUndefined();
    expect(item.x).toBeUndefined();
  });

  it.each(['BOUQUET', 'GIFT'])(
    'stores one-canvas placements and layer order for %s designs',
    async (builderType) => {
      category.findUnique.mockResolvedValue({
        ...record.category,
        builderType,
        options: null,
      });
      await save({
        ...body,
        items: [
          { subCategoryId, quantity: 1, position: 0, ...placed },
          {
            subCategoryId,
            quantity: 1,
            position: 1,
            x: 0.3,
            y: 0.6,
            scale: 0.8,
            rotation: 0,
          },
        ],
      }).expect(201);
      const items = product.create.mock.calls[0][0].data.items.create;
      expect(items[0]).toMatchObject({
        x: 0.5,
        y: 0.4,
        scale: 1.2,
        rotation: 15,
        position: 0,
      });
      expect(items[0].side).toBeUndefined();
      expect(items[1]).toMatchObject({ x: 0.3, y: 0.6, position: 1 });
      product.create.mockClear();
      await save({ ...body, items: [{ subCategoryId, quantity: 1 }] }).expect(
        400,
      );
      expect(product.create).not.toHaveBeenCalled();
    },
  );

  const text = {
    id: 't1',
    text: '  Thank you ',
    x: 0.5,
    y: 0.7,
    scale: 1,
    rotation: 0,
    color: '#2D3250',
    font: 'SCRIPT',
  };

  it('saves a free bouquet on a base product: any positions, base price included, no size needed', async () => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      builderType: 'BOUQUET',
      options: null,
    });
    product.findUnique.mockResolvedValue(
      baseProduct({
        name: 'Wrapped Bouquet',
        price: 1200,
        sizes: null,
        stock: 3,
      }),
    );
    const pieces = [
      {
        subCategoryId,
        quantity: 1,
        position: 0,
        x: 0.12,
        y: 0.9,
        scale: 2.4,
        rotation: -40,
      },
      {
        subCategoryId,
        quantity: 1,
        position: 1,
        x: 0.88,
        y: 0.08,
        scale: 0.3,
        rotation: 170,
      },
    ];
    await save({ ...body, baseProductId: baseId, items: pieces }).expect(201);
    const data = product.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      baseProductId: baseId,
      basePrice: 1200,
      price: 1200 + 2 * 75,
    });
    expect(data.selectedSize).toBeUndefined();
    expect(
      data.items.create.map(
        ({ x, y, scale, rotation, position }: Record<string, number>) => ({
          x,
          y,
          scale,
          rotation,
          position,
        }),
      ),
    ).toEqual(
      pieces.map(({ x, y, scale, rotation, position }) => ({
        x,
        y,
        scale,
        rotation,
        position,
      })),
    );
  });

  it('stores personalised text on gift and bouquet designs only', async () => {
    for (const [index, builderType] of ['GIFT', 'BOUQUET'].entries()) {
      category.findUnique.mockResolvedValue({
        ...record.category,
        builderType,
        options: null,
      });
      await save({
        ...body,
        items: [{ subCategoryId, quantity: 1, ...placed }],
        textLayers: [text],
      }).expect(201);
      expect(product.create.mock.calls[index][0].data.textLayers).toEqual([
        { ...text, text: 'Thank you' },
      ]);
    }
    category.findUnique.mockResolvedValue({
      ...record.category,
      builderType: 'JEWELRY',
      options: null,
    });
    const response = await save({
      ...body,
      items: [{ subCategoryId, quantity: 1, ...placed }],
      textLayers: [text],
    }).expect(400);
    expect(response.body.message).toBe(
      'Only gift, bouquet and apparel designs can include text',
    );
  });

  it('keeps text weight and italic, dropping the regular defaults', async () => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      builderType: 'GIFT',
      options: null,
    });
    const styled = [
      { ...text, id: 'bold', weight: 'BOLD', italic: true },
      { ...text, id: 'light', weight: 'LIGHT', italic: false },
      { ...text, id: 'plain', weight: 'REGULAR' },
    ];
    await save({
      ...body,
      items: [{ subCategoryId, quantity: 1, ...placed }],
      textLayers: styled,
    }).expect(201);
    expect(product.create.mock.calls[0][0].data.textLayers).toEqual([
      { ...text, text: 'Thank you', id: 'bold', weight: 'BOLD', italic: true },
      { ...text, text: 'Thank you', id: 'light', weight: 'LIGHT' },
      { ...text, text: 'Thank you', id: 'plain' },
    ]);
  });

  it('stores apparel text with the side it is printed on', async () => {
    apparelCategory();
    product.findUnique.mockResolvedValue(baseProduct());
    const design = {
      ...body,
      baseProductId: baseId,
      selectedSizeId: 'L',
      items: [{ subCategoryId, quantity: 1, ...placed }],
    };
    const missing = await save({ ...design, textLayers: [text] }).expect(400);
    expect(missing.body.message).toBe(
      'Apparel text must say which side it is printed on',
    );
    await save({ ...design, textLayers: [{ ...text, side: 'MIDDLE' }] }).expect(
      400,
    );
    await save({ ...design, textLayers: [{ ...text, side: 'BACK' }] }).expect(
      201,
    );
    expect(product.create.mock.calls[0][0].data.textLayers).toEqual([
      { ...text, text: 'Thank you', side: 'BACK' },
    ]);
  });

  it.each([
    [{ ...text, text: '' }],
    [{ ...text, x: 1.5 }],
    [{ ...text, color: 'red' }],
    [{ ...text, font: 'COMIC' }],
    [{ ...text, weight: 'HEAVY' }],
    [{ ...text, italic: 'yes' }],
    [text, text],
    Array.from({ length: 7 }, (_, index) => ({ ...text, id: 't' + index })),
  ])('rejects invalid text layers %#', async (...layers) => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      builderType: 'GIFT',
      options: null,
    });
    await save({
      ...body,
      items: [{ subCategoryId, quantity: 1, ...placed }],
      textLayers: layers,
    }).expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  it('keeps component requirements for jewelry and legacy categories', async () => {
    for (const builderType of ['JEWELRY', null]) {
      category.findUnique.mockResolvedValue({
        ...record.category,
        builderType,
        options: null,
      });
      await request(app.getHttpServer())
        .post(base)
        .set('Authorization', 'Bearer ' + token)
        .send({ name: 'Bracelet', categoryId })
        .expect(400);
    }
    expect(product.create).not.toHaveBeenCalled();
  });
  const save = (input: object) =>
    request(app.getHttpServer())
      .post(base)
      .set('Authorization', 'Bearer ' + token)
      .send(input);
  const edit = (input: object) =>
    request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send(input);
  it('resolves a complete category size and counts summed quantity', async () => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      sizes: [size],
    });
    await save({
      ...body,
      selectedSizeId: 'medium',
      items: [
        { subCategoryId, quantity: 9 },
        { subCategoryId, quantity: 9 },
      ],
    }).expect(201);
    expect(product.create.mock.calls[0][0].data).toMatchObject({
      selectedSize: size,
      itemCount: 18,
      price: 1350,
    });
    expect(subCategory.update).not.toHaveBeenCalled();
    product.create.mockClear();
    await save({ ...body, selectedSizeId: 'medium' }).expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });
  it('keeps size selection optional even in sized categories', async () => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      sizes: [size],
    });
    await save(body).expect(201);
    expect(product.create.mock.calls[0][0].data.selectedSize).toBeUndefined();
  });
  it.each([null, []])('preserves unsized category flow %j', async (sizes) => {
    category.findUnique.mockResolvedValue({ ...record.category, sizes });
    await save(body).expect(201);
    await save({ ...body, selectedSizeId: 'missing' }).expect(400);
  });
  it('rejects unknown sizes and frontend size objects or limits', async () => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      sizes: [size],
    });
    await save({ ...body, selectedSizeId: 'unknown' }).expect(400);
    await save({ ...body, selectedSize: size }).expect(400);
    await save({ ...body, selectedSizeId: 'medium', maxItems: 100 }).expect(
      400,
    );
  });
  it('preserves the size snapshot on edits and validates changed quantities', async () => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      sizes: [{ ...size, maxItems: 100 }],
    });
    product.findUnique.mockResolvedValue({
      ...record,
      selectedSize: size,
      items: [{ subCategoryId, quantity: 18 }],
    });
    await edit({ name: 'Renamed' }).expect(200);
    expect(product.update.mock.calls[0][0].data.selectedSize).toBeUndefined();
    await edit({ items: [{ subCategoryId, quantity: 19 }] }).expect(400);
    await edit({
      selectedSizeId: 'medium',
      items: [{ subCategoryId, quantity: 19 }],
    }).expect(200);
    expect(product.update.mock.calls.at(-1)![0].data.selectedSize).toEqual({
      ...size,
      maxItems: 100,
    });
  });
  it('checks a newly selected size against existing quantities', async () => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      sizes: [size],
    });
    await edit({ selectedSizeId: 'medium' }).expect(400);
  });

  it.each(['ADMIN', 'CUSTOMER'])(
    'allows %s creation using the authenticated creator',
    async (role) => {
      user.findUnique.mockResolvedValue({ ...creator, role, isActive: true });
      const response = await request(app.getHttpServer())
        .post(base)
        .set('Authorization', 'Bearer ' + token)
        .send(body)
        .expect(201);
      expect(product.create.mock.calls[0][0].data).toMatchObject({
        categoryId,
        price: 1500,
        itemCount: 20,
        items: { create: [{ subCategoryId, quantity: 20, unitPrice: 75 }] },
        name: 'Bracelet',
        createdById: userId,
      });
      expect(response.body.createdBy).not.toHaveProperty('passwordHash');
      expect(product.create.mock.calls[0][0].include.createdBy.select).toEqual({
        id: true,
        firstName: true,
        lastName: true,
        userName: true,
      });
    },
  );

  it('requires JWT authentication for all writes', async () => {
    await request(app.getHttpServer()).post(base).send(body).expect(401);
    await request(app.getHttpServer())
      .patch(base + '/' + id)
      .send({ name: 'New' })
      .expect(401);
    await request(app.getHttpServer())
      .delete(base + '/' + id)
      .expect(401);
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', 'Bearer invalid')
      .send(body)
      .expect(401);
    expect(product.create).not.toHaveBeenCalled();
    expect(product.update).not.toHaveBeenCalled();
    expect(product.delete).not.toHaveBeenCalled();
  });

  it('returns five completed custom creations from other users without order customer data', async () => {
    const completedAt = new Date('2026-10-18T12:00:00.000Z');
    order.groupBy.mockResolvedValue([{ productId: id }]);
    order.findMany.mockResolvedValue([
      { id: otherId, productId: id, updatedAt: completedAt, product: record },
    ]);
    const response = await request(app.getHttpServer())
      .get(base + '/creations/from-others')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    // Completed orders placed by someone else, latest completion first, five designs.
    expect(order.groupBy.mock.calls[0][0]).toMatchObject({
      by: ['productId'],
      where: {
        status: 'COMPLETED',
        completedAt: { not: null },
        userId: { not: userId },
        product: {
          createdById: { not: userId },
          origin: 'CUSTOMER',
        },
      },
      orderBy: [{ _max: { completedAt: 'desc' } }, { productId: 'asc' }],
      take: 5,
    });
    expect(order.findMany.mock.calls[0][0]).toMatchObject({
      where: { productId: { in: [id] }, userId: { not: userId } },
      orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
    });
    expect(response.body.data[0]).toMatchObject({
      completedOrderId: otherId,
      completedOrderUpdatedAt: completedAt.toISOString(),
      product: {
        id,
        createdBy: {
          id: userId,
          firstName: 'Test',
          lastName: 'User',
          userName: 'test',
        },
      },
    });
    expect(response.body.data[0]).not.toHaveProperty('user');
    expect(response.body.data[0]).not.toHaveProperty('address');
  });

  it('filters creations from others by category', async () => {
    order.groupBy.mockResolvedValue([]);
    await request(app.getHttpServer())
      .get(base + '/creations/from-others?categoryId=' + categoryId)
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(order.groupBy.mock.calls[0][0].where.product).toMatchObject({
      createdById: { not: userId },
      origin: 'CUSTOMER',
      categoryId,
    });
    // Nothing ranked: no orders are read.
    expect(order.findMany).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .get(base + '/creations/from-others?categoryId=bad')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
  });

  it('shows a design ordered several times once, with its latest order', async () => {
    const productB = 'c4dfc7b7-2a71-46c6-bfba-a453d847044f';
    order.groupBy.mockResolvedValue([
      { productId: productB },
      { productId: id },
    ]);
    order.findMany.mockResolvedValue([
      { id: 'o2', productId: id, updatedAt: new Date(), product: record },
      {
        id: 'o3',
        productId: productB,
        updatedAt: new Date(),
        product: { ...record, id: productB },
      },
      { id: 'o1', productId: id, updatedAt: new Date(), product: record },
    ]);
    const response = await request(app.getHttpServer())
      .get(base + '/creations/from-others')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(
      response.body.data.map(
        (entry: { completedOrderId: string }) => entry.completedOrderId,
      ),
    ).toEqual(['o3', 'o2']);
  });

  describe('community gallery', () => {
    const gifts = { id: categoryId, name: 'Gifts' };
    const keychains = {
      id: 'e4dfc7b7-2a71-46c6-bfba-a453d847044f',
      name: 'Keychains',
    };
    const completedAt = new Date('2026-10-30T09:00:00.000Z');
    const gallery = (query = '') =>
      request(app.getHttpServer())
        .get(base + '/creations/community' + query)
        .set('Authorization', 'Bearer ' + token);

    it('lists categories with creations from others and the latest of the first', async () => {
      category.findMany.mockResolvedValue([gifts, keychains]);
      order.groupBy.mockResolvedValue([{ productId: id }]);
      order.findMany.mockResolvedValue([
        {
          id: otherId,
          productId: id,
          completedAt,
          designPreviewKey: 'orders/' + otherId + '/preview.webp',
          product: {
            id,
            name: 'Birthday Box',
            designPreviewKey: 'products/preview.webp',
          },
        },
      ]);
      const response = await gallery().expect(200);
      // Categories are found through orders the signed-in viewer may see.
      expect(category.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          products: {
            some: {
              orders: {
                some: {
                  status: 'COMPLETED',
                  userId: { not: userId },
                  product: {
                    origin: 'CUSTOMER',
                    category: { isActive: true },
                  },
                },
              },
            },
          },
        },
        select: { id: true, name: true },
      });
      expect(order.groupBy.mock.calls[0][0]).toMatchObject({
        where: {
          status: 'COMPLETED',
          userId: { not: userId },
          product: { categoryId },
        },
        take: 5,
      });
      expect(response.body).toEqual({
        categories: [gifts, keychains],
        categoryId,
        creations: [
          {
            id: otherId,
            productId: id,
            name: 'Birthday Box',
            categoryId,
            categoryName: 'Gifts',
            designPreviewKey: 'orders/' + otherId + '/preview.webp',
            // The order's own copy wins over the design's current preview.
            designPreviewUrl: expect.stringMatching(
              new RegExp('orders/' + otherId + '/preview\\.webp$'),
            ),
            completedAt: completedAt.toISOString(),
          },
        ],
      });
      // A picture card only: nothing about the customer, the order or its price.
      const card = JSON.stringify(response.body.creations[0]);
      for (const field of [
        'user',
        'createdBy',
        'firstName',
        'email',
        'address',
        'orderNumber',
        'totalPrice',
        'price',
      ])
        expect(card).not.toContain('"' + field + '"');
    });

    it('reads the requested category, and falls back when it has nothing to show', async () => {
      category.findMany.mockResolvedValue([gifts, keychains]);
      order.groupBy.mockResolvedValue([]);
      await gallery('?categoryId=' + keychains.id).expect(200);
      expect(order.groupBy.mock.calls[0][0].where.product.categoryId).toBe(
        keychains.id,
      );
      const response = await gallery(
        '?categoryId=f9dfc7b7-2a71-46c6-bfba-a453d847044f',
      ).expect(200);
      expect(order.groupBy.mock.calls[1][0].where.product.categoryId).toBe(
        categoryId,
      );
      expect(response.body.categoryId).toBe(categoryId);
      await gallery('?categoryId=bad').expect(400);
    });

    it('is empty without any eligible category', async () => {
      category.findMany.mockResolvedValue([]);
      const response = await gallery().expect(200);
      expect(response.body).toEqual({
        categories: [],
        categoryId: null,
        creations: [],
      });
      expect(order.groupBy).not.toHaveBeenCalled();
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .get(base + '/creations/community')
        .expect(401);
      expect(category.findMany).not.toHaveBeenCalled();
    });
  });

  it('requires authentication for creations from others', async () => {
    await request(app.getHttpServer())
      .get(base + '/creations/from-others')
      .expect(401);
    expect(order.findMany).not.toHaveBeenCalled();
  });

  it('rejects customer edits and deletes, including their own products', async () => {
    user.findUnique.mockResolvedValue({
      ...creator,
      role: 'CUSTOMER',
      isActive: true,
    });
    await request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({ name: 'New' })
      .expect(403);
    await request(app.getHttpServer())
      .delete(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .expect(403);
    expect(product.update).not.toHaveBeenCalled();
    expect(product.delete).not.toHaveBeenCalled();
  });

  it('allows admins to update and delete products created by other users', async () => {
    product.findUnique.mockResolvedValue({ ...record, createdById: otherId });
    await request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({
        description: null,

        isActive: false,
      })
      .expect(200);
    expect(product.update.mock.calls[0][0].data).toMatchObject({
      description: null,

      isActive: false,
    });
    expect(product.update.mock.calls[0][0].data).not.toHaveProperty(
      'createdById',
    );
    const deleted = await request(app.getHttpServer())
      .delete(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .expect(204);
    expect(deleted.text).toBe('');
  });

  it.each([
    'createdById',
    'id',
    'createdAt',
    'updatedAt',
    'stock',
    'price',
    'unitPrice',
    'itemCount',
    'subCategoryId',
  ])('rejects client field %s', async (field) => {
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', 'Bearer ' + token)
      .send({ ...body, [field]: otherId })
      .expect(400);
    await request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({ [field]: otherId })
      .expect(400);
    expect(product.create).not.toHaveBeenCalled();
    expect(product.update).not.toHaveBeenCalled();
  });

  it.each([
    { items: [] },
    { items: null },
    { items: {} },
    { items: ['bad'] },
    { items: [{ subCategoryId: 'bad', quantity: 1 }] },
    { items: [{ subCategoryId, quantity: 0 }] },
    { items: [{ subCategoryId, quantity: -1 }] },
    { items: [{ subCategoryId, quantity: 1.5 }] },
    { items: [{ subCategoryId, quantity: '2' }] },
    { items: [{ subCategoryId, quantity: 2147483648 }] },
    { items: [{ subCategoryId, quantity: 1, position: -1 }] },
    { items: [{ subCategoryId, quantity: 1, position: null }] },
    { items: [{ subCategoryId, quantity: 1, position: 1.5 }] },
    { items: [{ subCategoryId, quantity: 1, unitPrice: 1 }] },
    { items: [{ subCategoryId, quantity: 1, id }] },
    { items: [{ subCategoryId, quantity: 1, createdAt: '2026-01-01' }] },
    { name: ' ' },
    { name: null },
    { categoryId: 'bad' },
    { subCategoryId: null },
    { price: -1 },
    { price: 1.5 },
    { price: 2147483648 },
    { price: null },
    { itemCount: -1 },
    { itemCount: 1.5 },
    { itemCount: '2' },
    { isActive: 'false' },
    { isActive: null },
    { imageUrl: 'invalid' },
  ])('validates create and patch fields %j', async (invalid) => {
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', 'Bearer ' + token)
      .send({ ...body, ...invalid })
      .expect(400);
    await request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send(invalid)
      .expect(400);
    expect(product.create).not.toHaveBeenCalled();
    expect(product.update).not.toHaveBeenCalled();
  });

  it('requires name and both relations on creation', async () => {
    for (const missing of ['name', 'categoryId', 'items']) {
      const input = Object.fromEntries(
        Object.entries(body).filter(([key]) => key !== missing),
      );
      await request(app.getHttpServer())
        .post(base)
        .set('Authorization', 'Bearer ' + token)
        .send(input)
        .expect(400);
    }
  });

  it('serves lists and details with safe relation selections', async () => {
    for (const path of [base, base + '/' + id]) {
      const response = await request(app.getHttpServer()).get(path).expect(200);
      expect(response.text).not.toContain('passwordHash');
    }
    for (const operation of [product.findMany, product.findUnique]) {
      const include = operation.mock.calls[0][0].include;
      expect(include.createdBy.select).not.toHaveProperty('passwordHash');
      expect(include.category.select.name).toBe(true);
      expect(include.items.select.subCategory.select.categoryId).toBe(true);
      expect(include.baseProduct.select.sizes).toBe(true);
    }
  });

  it('filters products by category, origin, creator, status and search in the database', async () => {
    await request(app.getHttpServer())
      .get(base)
      .query({
        categoryId,
        origin: 'COMPANY',
        createdById: userId,
        isActive: 'true',
        search: ' hoodie ',
      })
      .expect(200);
    const search = { contains: 'hoodie', mode: 'insensitive' };
    expect(product.findMany.mock.calls[0][0].where).toEqual({
      categoryId,
      origin: 'COMPANY',
      createdById: userId,
      isActive: true,
      OR: [{ name: search }, { description: search }, { color: search }],
    });
    for (const query of [
      'categoryId=bad',
      'origin=READY_MADE',
      'isActive=yes',
      'unknown=1',
    ])
      await request(app.getHttpServer())
        .get(base + '?' + query)
        .expect(400);
    expect(product.findMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['categories', 'categoryId', categoryId],
    ['sub-categories', 'subCategoryId', subCategoryId],
    ['users', 'createdById', userId],
  ])(
    'filters by %s and distinguishes missing parents from empty lists',
    async (route, field, parentId) => {
      const path = '/api/v1/' + route + '/' + parentId + '/products';
      await request(app.getHttpServer()).get(path).expect(200);
      expect(product.findMany.mock.calls[0][0].where).toEqual(
        field === 'subCategoryId'
          ? { items: { some: { subCategoryId: parentId } } }
          : { [field]: parentId },
      );
      product.findMany.mockResolvedValue([]);
      expect(
        (await request(app.getHttpServer()).get(path).expect(200)).body,
      ).toEqual([]);
      const parent =
        route === 'categories'
          ? category
          : route === 'sub-categories'
            ? subCategory
            : user;
      parent.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer()).get(path).expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/' + route + '/bad/products')
        .expect(400);
    },
  );

  it('rejects malformed product UUIDs', async () => {
    await request(app.getHttpServer())
      .get(base + '/bad')
      .expect(400);
    await request(app.getHttpServer())
      .patch(base + '/bad')
      .set('Authorization', 'Bearer ' + token)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .delete(base + '/bad')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
    expect(product.findUnique).not.toHaveBeenCalled();
    expect(product.delete).not.toHaveBeenCalled();
  });

  it.each(['category', 'subcategory'])(
    'returns 404 for a missing %s during create and update',
    async (kind) => {
      if (kind === 'category') category.findUnique.mockResolvedValue(null);
      else subCategory.findMany.mockResolvedValue([]);
      await request(app.getHttpServer())
        .post(base)
        .set('Authorization', 'Bearer ' + token)
        .send(body)
        .expect(404);
      await request(app.getHttpServer())
        .patch(base + '/' + id)
        .set('Authorization', 'Bearer ' + token)
        .send({ categoryId, items: body.items })
        .expect(404);
      expect(product.create).not.toHaveBeenCalled();
      expect(product.update).not.toHaveBeenCalled();
    },
  );

  it('rejects a mismatched category/subcategory on create and partial updates', async () => {
    subCategory.findMany.mockResolvedValue([
      { id: subCategoryId, categoryId: otherId, isActive: true, price: 75 },
    ]);
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', 'Bearer ' + token)
      .send(body)
      .expect(400);
    await request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({ items: body.items })
      .expect(400);
    subCategory.findMany.mockResolvedValue([
      { ...record.subCategory, isActive: true, price: 75 },
    ]);
    await request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({ categoryId: otherId })
      .expect(400);
    expect(product.create).not.toHaveBeenCalled();
    expect(product.update).not.toHaveBeenCalled();
  });

  it('allows changing both relation IDs to a matching pair', async () => {
    category.findUnique.mockResolvedValue({ id: otherId });
    subCategory.findMany.mockResolvedValue([
      { id: userId, categoryId: otherId, isActive: true, price: 75 },
    ]);
    await request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({
        categoryId: otherId,
        items: [{ subCategoryId: userId, quantity: 1 }],
      })
      .expect(200);
    expect(product.update.mock.calls[0][0].data).toMatchObject({
      category: { connect: { id: otherId } },
      items: {
        create: [{ subCategoryId: userId, quantity: 1, unitPrice: 75 }],
      },
    });
  });

  it('returns 404 for missing products', async () => {
    product.findUnique.mockResolvedValue(null);
    product.delete.mockRejectedValue(dbError('P2025'));
    await request(app.getHttpServer())
      .get(base + '/' + id)
      .expect(404);
    await request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({ name: 'New' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .expect(404);
  });

  it.each([
    ['P2002', 409],
    ['P2003', 409],
    ['P2025', 404],
    ['P1001', 500],
  ] as const)('sanitizes Prisma error %s', async (code, status) => {
    product.update.mockRejectedValue(dbError(code));
    const response = await request(app.getHttpServer())
      .patch(base + '/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({ name: 'New' })
      .expect(status);
    expect(response.text).not.toContain('Private query data');
  });
});
