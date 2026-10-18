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
  const garmentVariant = delegate();
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
    garmentVariant,
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
  const apparelOptions = [
    {
      key: 'size',
      name: 'Size',
      type: 'select',
      required: true,
      values: ['S', 'M', 'L'],
    },
    {
      key: 'color',
      name: 'Color',
      type: 'color',
      required: true,
      values: [
        { name: 'Black', value: '#000000' },
        { name: 'White', value: '#FFFFFF' },
      ],
    },
  ];
  const variantId = 'c7d1f0a4-2a71-46c6-bfba-a453d847044f';
  const libraryId = 'e1d1f0a4-2a71-46c6-bfba-a453d847044f';
  const variant = (overrides: object = {}) => ({
    id: variantId,
    size: 'S',
    colorName: 'Red',
    stock: 1,
    price: null,
    isActive: true,
    garment: { categoryId, isActive: true, basePrice: 3500, name: 'Classic Hoodie' },
    ...overrides,
  });
  const apparelCategory = (overrides: object = {}) => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      builderType: 'APPAREL',
      options: [],
      designCategoryId: null,
      ...overrides,
    });
  };
  const placed = { side: 'FRONT', x: 0.5, y: 0.4, scale: 1.2, rotation: 15 };

  it('creates an option-only apparel product priced from its garment variant', async () => {
    apparelCategory({ options: apparelOptions });
    garmentVariant.findUnique.mockResolvedValue(variant());
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', 'Bearer ' + token)
      .field('name', 'Custom Hoodie')
      .field('categoryId', categoryId)
      .field('garmentVariantId', variantId)
      .field('selectedOptions', JSON.stringify({ size: 'L', color: '#000000' }))
      .expect(201);
    expect(product.create.mock.calls[0][0].data).toMatchObject({
      selectedOptions: { size: 'L', color: { name: 'Black', value: '#000000' } },
      garmentVariantId: variantId,
      basePrice: 3500,
      price: 3500,
      itemCount: 0,
      items: { create: [] },
    });
  });

  it('adds the garment price (or variant override) to design prices and stores placements', async () => {
    apparelCategory();
    garmentVariant.findUnique.mockResolvedValue(variant({ price: 3900 }));
    await save({ ...body, garmentVariantId: variantId, items: [{ subCategoryId, quantity: 20, ...placed }] })
      .expect(201);
    const data = product.create.mock.calls[0][0].data;
    expect(data.price).toBe(3900 + 20 * 75);
    expect(data.basePrice).toBe(3900);
    expect(data.items.create[0]).toMatchObject(placed);
  });

  it.each([
    [undefined, 'Choose a garment size and colour for this design'],
    ['missing', 'Garment size and colour not found in this category'],
    ['other-category', 'Garment size and colour not found in this category'],
    ['inactive', 'Classic Hoodie in Red / S is no longer available'],
    ['sold-out', 'Classic Hoodie in Red / S is sold out'],
  ])('rejects apparel with an unavailable garment (%s)', async (state, message) => {
    apparelCategory();
    garmentVariant.findUnique.mockResolvedValue(
      state === 'missing' ? null
        : state === 'other-category' ? variant({ garment: { ...variant().garment, categoryId: otherId } })
          : state === 'inactive' ? variant({ isActive: false })
            : state === 'sold-out' ? variant({ stock: 0 }) : variant(),
    );
    const response = await save({
      ...body,
      ...(state ? { garmentVariantId: variantId } : {}),
      items: [{ subCategoryId, quantity: 1, ...placed }],
    }).expect(400);
    expect(response.body.message).toBe(message);
    expect(product.create).not.toHaveBeenCalled();
  });

  it('requires a placement for every apparel design', async () => {
    apparelCategory();
    garmentVariant.findUnique.mockResolvedValue(variant());
    await save({ ...body, garmentVariantId: variantId }).expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  it('accepts designs from the shared design library and rejects unrelated designs', async () => {
    apparelCategory({ designCategoryId: libraryId });
    garmentVariant.findUnique.mockResolvedValue(variant());
    subCategory.findMany.mockResolvedValue([
      { ...record.subCategory, categoryId: libraryId, price: 75, isActive: true },
    ]);
    await save({ ...body, garmentVariantId: variantId, items: [{ subCategoryId, quantity: 1, ...placed }] })
      .expect(201);
    subCategory.findMany.mockResolvedValue([
      { ...record.subCategory, categoryId: otherId, price: 75, isActive: true },
    ]);
    await save({ ...body, garmentVariantId: variantId, items: [{ subCategoryId, quantity: 1, ...placed }] })
      .expect(400);
  });

  it('never stores placements or garments on jewelry designs', async () => {
    category.findUnique.mockResolvedValue({ ...record.category, builderType: 'JEWELRY', options: null });
    await save({ ...body, garmentVariantId: variantId }).expect(400);
    await save({ ...body, items: [{ subCategoryId, quantity: 20, ...placed }] }).expect(201);
    const item = product.create.mock.calls[0][0].data.items.create[0];
    expect(item.side).toBeUndefined();
    expect(item.x).toBeUndefined();
  });

  it.each(['BOUQUET', 'GIFT'])('stores one-canvas placements and layer order for %s designs', async (builderType) => {
    category.findUnique.mockResolvedValue({ ...record.category, builderType, options: null });
    await save({ ...body, items: [
      { subCategoryId, quantity: 1, position: 0, ...placed },
      { subCategoryId, quantity: 1, position: 1, x: 0.3, y: 0.6, scale: 0.8, rotation: 0 },
    ] }).expect(201);
    const items = product.create.mock.calls[0][0].data.items.create;
    expect(items[0]).toMatchObject({ x: 0.5, y: 0.4, scale: 1.2, rotation: 15, position: 0 });
    expect(items[0].side).toBeUndefined();
    expect(items[1]).toMatchObject({ x: 0.3, y: 0.6, position: 1 });
    product.create.mockClear();
    await save({ ...body, items: [{ subCategoryId, quantity: 1 }] }).expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  const text = { id: 't1', text: '  Thank you ', x: 0.5, y: 0.7, scale: 1, rotation: 0, color: '#2D3250', font: 'SCRIPT' };

  it('stores personalised text on gift designs only', async () => {
    category.findUnique.mockResolvedValue({ ...record.category, builderType: 'GIFT', options: null });
    await save({ ...body, items: [{ subCategoryId, quantity: 1, ...placed }], textLayers: [text] })
      .expect(201);
    expect(product.create.mock.calls[0][0].data.textLayers).toEqual([{ ...text, text: 'Thank you' }]);
    for (const builderType of ['BOUQUET', 'JEWELRY']) {
      category.findUnique.mockResolvedValue({ ...record.category, builderType, options: null });
      const response = await save({ ...body, items: [{ subCategoryId, quantity: 1, ...placed }], textLayers: [text] })
        .expect(400);
      expect(response.body.message).toBe('Only gift designs can include text');
    }
  });

  it.each([
    [{ ...text, text: '' }],
    [{ ...text, x: 1.5 }],
    [{ ...text, color: 'red' }],
    [{ ...text, font: 'COMIC' }],
    [text, text],
    Array.from({ length: 7 }, (_, index) => ({ ...text, id: 't' + index })),
  ])('rejects invalid text layers %#', async (...layers) => {
    category.findUnique.mockResolvedValue({ ...record.category, builderType: 'GIFT', options: null });
    await save({ ...body, items: [{ subCategoryId, quantity: 1, ...placed }], textLayers: layers }).expect(400);
    expect(product.create).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { size: 'XL', color: '#000000' },
    { size: 'L', color: '#BADBAD' },
    { size: 'L', color: '#000000', adminMax: 99999 },
  ])('rejects invalid selected apparel options %j', async (selectedOptions) => {
    category.findUnique.mockResolvedValue({
      ...record.category,
      builderType: 'APPAREL',
      options: apparelOptions,
    });
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', 'Bearer ' + token)
      .send({ name: 'Custom Hoodie', categoryId, selectedOptions })
      .expect(400);
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
    order.findMany.mockResolvedValue([
      { id: otherId, updatedAt: completedAt, product: record },
    ]);
    const response = await request(app.getHttpServer())
      .get(base + '/creations/from-others')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    expect(order.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        status: 'COMPLETED',
        product: {
          createdById: { not: userId },
          productType: 'CUSTOM_DESIGN',
        },
      },
      distinct: ['productId'],
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: 5,
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
    }
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
