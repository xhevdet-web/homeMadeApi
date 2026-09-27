import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { CategoriesModule } from '../../src/modules/categories/categories.module.js';
import { SubCategoriesModule } from '../../src/modules/sub-categories/sub-categories.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { setupApp } from '../../src/config/setup-app.js';

const delegate = () => ({
  create: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
});
const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Private SQL detail', {
    code,
    clientVersion: '7.10.0',
  });

describe('Categories and SubCategories HTTP CRUD', () => {
  let app: INestApplication<App>;
  const id = 'ac78a80a-ce2b-4c45-8076-fca001c71418';
  const childId = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const category = delegate();
  const subCategory = delegate();
  const parent = { id, name: 'Clothes' };
  const child = {
    id: childId,
    categoryId: id,
    name: 'Shirts',
    category: parent,
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [CategoriesModule, SubCategoriesModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ category, subCategory })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    for (const [model, record] of [
      [category, { ...parent, subCategories: [child] }],
      [subCategory, child],
    ] as const) {
      model.create.mockResolvedValue(record);
      model.findMany.mockResolvedValue([record]);
      model.findUnique.mockResolvedValue(record);
      model.update.mockResolvedValue(record);
      model.delete.mockResolvedValue({ id: record.id });
    }
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each(['categories', 'sub-categories'])(
    'serves CRUD for %s under /api/v1',
    async (route) => {
      const base = '/api/v1/' + route;
      const body =
        route === 'categories'
          ? { name: ' Clothes ' }
          : { name: ' Shirts ', categoryId: id, price: 1500, stock: 2 };
      const model = route === 'categories' ? category : subCategory;
      await request(app.getHttpServer()).post(base).send(body).expect(201);
      expect(model.create.mock.calls[0][0].data.name).toBe(body.name.trim());
      await request(app.getHttpServer()).get(base).expect(200);
      const details = await request(app.getHttpServer())
        .get(base + '/' + id)
        .expect(200);
      expect(details.body).toHaveProperty(
        route === 'categories' ? 'subCategories' : 'category',
      );
      await request(app.getHttpServer())
        .patch(base + '/' + id)
        .send({ isActive: false, description: null })
        .expect(200);
      expect(model.update.mock.calls[0][0].data).toMatchObject({
        isActive: false,
        description: null,
      });
      const deleted = await request(app.getHttpServer())
        .delete(base + '/' + id)
        .expect(204);
      expect(deleted.text).toBe('');
    },
  );

  it('returns children with their parent and distinguishes an empty category from a missing one', async () => {
    const path = '/api/v1/categories/' + id + '/sub-categories';
    const response = await request(app.getHttpServer()).get(path).expect(200);
    expect(response.body).toEqual([child]);
    expect(
      category.findUnique.mock.calls[0][0].select.subCategories.include,
    ).toEqual({ category: true });
    category.findUnique.mockResolvedValue({ subCategories: [] });
    expect(
      (await request(app.getHttpServer()).get(path).expect(200)).body,
    ).toEqual([]);
    category.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer()).get(path).expect(404);
  });

  for (const route of ['categories', 'sub-categories']) {
    const body = {
      name: 'Valid',
      ...(route === 'sub-categories' ? { categoryId: id } : {}),
    };
    it.each(['id', 'createdAt', 'updatedAt'])(
      `${route} rejects client supplied %s on create and update`,
      async (field) => {
        await request(app.getHttpServer())
          .post('/api/v1/' + route)
          .send({ ...body, [field]: id })
          .expect(400);
        await request(app.getHttpServer())
          .patch('/api/v1/' + route + '/' + id)
          .send({ [field]: id })
          .expect(400);
      },
    );
    it.each([
      { name: ' ' },
      { name: null },
      { isActive: null },
      { isActive: 'false' },
      { sortOrder: 1.5 },
      { sortOrder: 2147483648 },
      { imageUrl: 'invalid' },
    ])(`${route} validates fields %j`, async (invalid) => {
      await request(app.getHttpServer())
        .post('/api/v1/' + route)
        .send({ ...body, ...invalid })
        .expect(400);
      await request(app.getHttpServer())
        .patch('/api/v1/' + route + '/' + id)
        .send(invalid)
        .expect(400);
    });
    it(`${route} rejects malformed UUIDs on every ID route`, async () => {
      const path = '/api/v1/' + route + '/invalid';
      await request(app.getHttpServer()).get(path).expect(400);
      await request(app.getHttpServer()).patch(path).send({}).expect(400);
      await request(app.getHttpServer()).delete(path).expect(400);
      expect(category.findUnique).not.toHaveBeenCalled();
      expect(subCategory.findUnique).not.toHaveBeenCalled();
    });
    it(`${route} handles missing records and database failures`, async () => {
      const model = route === 'categories' ? category : subCategory;
      const path = '/api/v1/' + route + '/' + id;
      model.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer()).get(path).expect(404);
      model.update.mockRejectedValue(prismaError('P2025'));
      await request(app.getHttpServer())
        .patch(path)
        .send({ name: 'New' })
        .expect(404);
      model.delete.mockRejectedValue(prismaError('P2025'));
      await request(app.getHttpServer()).delete(path).expect(404);
      model.findMany.mockRejectedValue(new Error('Private SQL detail'));
      const response = await request(app.getHttpServer())
        .get('/api/v1/' + route)
        .expect(500);
      expect(response.text).not.toContain('Private SQL detail');
    });
  }

  it.each([
    { categoryId: 'bad' },
    { categoryId: null },
    { price: -1 },
    { price: 1.5 },
    { price: null },
    { stock: -1 },
    { stock: '2' },
    { color: 123 },
    { type: 123 },
  ])('validates subcategory fields %j', async (invalid) => {
    await request(app.getHttpServer())
      .post('/api/v1/sub-categories')
      .send({ name: 'Shirts', categoryId: id, ...invalid })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/api/v1/sub-categories/' + childId)
      .send(invalid)
      .expect(400);
    expect(subCategory.create).not.toHaveBeenCalled();
    expect(subCategory.update).not.toHaveBeenCalled();
  });

  it('checks parent existence on both create and reassignment', async () => {
    category.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .post('/api/v1/sub-categories')
      .send({ name: 'Shirts', categoryId: id })
      .expect(404);
    await request(app.getHttpServer())
      .patch('/api/v1/sub-categories/' + childId)
      .send({ categoryId: id })
      .expect(404);
    expect(subCategory.create).not.toHaveBeenCalled();
    expect(subCategory.update).not.toHaveBeenCalled();
  });

  it('allows reassignment to an existing parent and includes that parent in the result', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/sub-categories/' + childId)
      .send({ categoryId: id })
      .expect(200);
    expect(category.findUnique).toHaveBeenCalledWith({
      where: { id },
      select: { id: true },
    });
    expect(subCategory.update.mock.calls[0][0]).toMatchObject({
      data: { categoryId: id },
      include: { category: true },
    });
  });

  it('maps duplicate category names to 409 on create and update', async () => {
    category.create.mockRejectedValue(prismaError('P2002'));
    category.update.mockRejectedValue(prismaError('P2002'));
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Clothes' })
      .expect(409);
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .send({ name: 'Clothes' })
      .expect(409);
  });

  it('handles a parent deleted between validation and writing', async () => {
    subCategory.create.mockRejectedValue(prismaError('P2003'));
    await request(app.getHttpServer())
      .post('/api/v1/sub-categories')
      .send({ name: 'Shirts', categoryId: id })
      .expect(409);
  });
});
