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
    product.create.mockResolvedValue(record);
    product.update.mockResolvedValue(record);
    product.delete.mockResolvedValue({ id });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
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
        imageUrl: null,
        isActive: false,
      })
      .expect(200);
    expect(product.update.mock.calls[0][0].data).toMatchObject({
      description: null,
      imageUrl: null,
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
