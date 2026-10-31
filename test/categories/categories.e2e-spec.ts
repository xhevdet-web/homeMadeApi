import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard.js';
import { AdminGuard } from '../../src/common/guards/admin.guard.js';
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
    vi.stubEnv('JWT_ACCESS_SECRET', 'category-tests-only-secret-32-characters');
    const module = await Test.createTestingModule({
      imports: [CategoriesModule, SubCategoriesModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        category,
        subCategory,
        $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
          callback({ category, subCategory }),
      })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
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
    vi.unstubAllEnvs();
  });

  const size = {
    id: 'medium',
    name: 'Medium',
    measurement: 18,
    unit: 'cm',
    maxItems: 18,
  };
  it('saves builderType and the studio silhouette from JSON and FormData', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({
        name: 'Hoodie',
        builderType: 'APPAREL',
        builderConfig: { silhouette: 'HOODIE' },
      })
      .expect(201);
    expect(category.create.mock.calls[0][0].data).toMatchObject({
      builderType: 'APPAREL',
      builderConfig: { silhouette: 'HOODIE' },
    });
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .field('builderType', 'APPAREL')
      .field('builderConfig', JSON.stringify({ silhouette: 'TSHIRT' }))
      .expect(200);
    expect(category.update.mock.calls[0][0].data.builderConfig).toEqual({
      silhouette: 'TSHIRT',
    });
  });
  it.each([
    { builderType: 'CLOTHING' },
    { builderConfig: [] },
    { builderConfig: { silhouette: 'hoodie' } },
    { builderConfig: { shape: 'HOODIE' } },
    // Category options were retired: colour and size live on each product.
    { options: [] },
  ])('rejects invalid builder configuration %j', async (invalid) => {
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Invalid', ...invalid })
      .expect(400);
    expect(category.create).not.toHaveBeenCalled();
  });
  it('supports clearing the builder configuration', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .send({ builderType: null, builderConfig: null })
      .expect(200);
    expect(category.update.mock.calls[0][0].data).toMatchObject({
      builderType: null,
      builderConfig: Prisma.DbNull,
    });
  });
  const libraryId = 'e1d1f0a4-2a71-46c6-bfba-a453d847044f';
  it('gives every APPAREL category a "Your own design" upload design, once', async () => {
    category.create.mockResolvedValue({
      id,
      name: 'Hoodies',
      builderType: 'APPAREL',
    });
    subCategory.findMany.mockResolvedValue([]);
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Hoodies', builderType: 'APPAREL' })
      .expect(201);
    expect(subCategory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        categoryId: id,
        type: 'CUSTOM_UPLOAD',
        price: 500,
        trackStock: false,
      }),
    });
    subCategory.create.mockClear();
    subCategory.findMany.mockResolvedValue([{ id: 'own' }]);
    category.update.mockResolvedValue({
      id,
      name: 'Hoodies',
      builderType: 'APPAREL',
    });
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .send({ name: 'Hoodies' })
      .expect(200);
    expect(subCategory.create).not.toHaveBeenCalled();
  });
  it('gives a CASE category a free "Your own photo" upload design', async () => {
    category.create.mockResolvedValue({
      id,
      name: 'Cases',
      builderType: 'CASE',
    });
    subCategory.findMany.mockResolvedValue([]);
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Cases', builderType: 'CASE' })
      .expect(201);
    expect(subCategory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        categoryId: id,
        name: 'Your own photo',
        type: 'CUSTOM_UPLOAD',
        price: 0,
        trackStock: false,
      }),
    });
  });
  it('gives a STICKER category a "Your own artwork" upload design', async () => {
    category.create.mockResolvedValue({
      id,
      name: 'Stickers',
      builderType: 'STICKER',
    });
    subCategory.findMany.mockResolvedValue([]);
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Stickers', builderType: 'STICKER' })
      .expect(201);
    expect(subCategory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        categoryId: id,
        name: 'Your own artwork',
        type: 'CUSTOM_UPLOAD',
        price: 0,
        trackStock: false,
      }),
    });
  });

  describe('sticker sizes', () => {
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

    it('stores shape, whole millimetres and the price per sticker', async () => {
      category.create.mockResolvedValue({ id, builderType: 'STICKER' });
      subCategory.findMany.mockResolvedValue([{ id: 'own' }]);
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .send({
          name: 'Stickers',
          builderType: 'STICKER',
          sizes: [square, oval],
        })
        .expect(201);
      expect(category.create.mock.calls[0][0].data.sizes).toEqual([
        square,
        oval,
      ]);
    });

    it.each([
      [{ ...square, widthMm: 71, heightMm: 71 }],
      [{ ...oval, widthMm: 80 }],
      [{ ...square, heightMm: 40 }],
      [{ ...square, shape: 'CIRCLE', heightMm: 30 }],
      [{ ...square, shape: 'STAR' }],
      [{ ...square, widthMm: 50.5, heightMm: 50.5 }],
      [{ ...square, price: undefined }],
    ])('rejects sticker size %j', async (size) => {
      category.findUnique.mockResolvedValue({
        id,
        builderType: 'STICKER',
        subCategories: [],
      });
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .send({ name: 'Stickers', builderType: 'STICKER', sizes: [size] })
        .expect(400);
      // An update takes the studio from the stored category when the request omits it.
      await request(app.getHttpServer())
        .patch('/api/v1/categories/' + id)
        .send({ sizes: [size] })
        .expect(400);
      expect(category.create).not.toHaveBeenCalled();
      expect(category.update).not.toHaveBeenCalled();
    });
  });
  it('lets jewelry share a jewelry library, but not another kind of studio', async () => {
    category.findUnique.mockResolvedValue({
      id: libraryId,
      designCategoryId: null,
      builderType: 'JEWELRY',
    });
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({
        name: 'Necklace',
        builderType: 'JEWELRY',
        designCategoryId: libraryId,
      })
      .expect(201);
    expect(category.create.mock.calls[0][0].data).toMatchObject({
      builderType: 'JEWELRY',
      designCategoryId: libraryId,
    });
    category.findUnique.mockResolvedValue({
      id: libraryId,
      designCategoryId: null,
      builderType: 'APPAREL',
    });
    const response = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({
        name: 'Necklace',
        builderType: 'JEWELRY',
        designCategoryId: libraryId,
      })
      .expect(400);
    expect(response.body.message).toContain('same kind of studio');
  });
  it('keeps a library that others use from taking a library itself', async () => {
    category.findUnique.mockResolvedValue({
      id: libraryId,
      designCategoryId: null,
      builderType: 'JEWELRY',
    });
    category.findMany.mockResolvedValue([{ name: 'Bracelet' }]);
    const response = await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .send({ designCategoryId: libraryId })
      .expect(400);
    expect(response.body.message).toContain('Bracelet uses this category');
    expect(category.update).not.toHaveBeenCalled();
  });
  it('links a shared design library from JSON and FormData, and clears it', async () => {
    category.findUnique.mockResolvedValue({
      id: libraryId,
      designCategoryId: null,
    });
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .field('name', 'Hoodies')
      .field('builderType', 'APPAREL')
      .field('designCategoryId', libraryId)
      .expect(201);
    expect(category.create.mock.calls[0][0].data).toMatchObject({
      builderType: 'APPAREL',
      designCategoryId: libraryId,
    });
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .field('name', 'Rings')
      .field('builderType', '')
      .field('designCategoryId', '')
      .expect(200);
    expect(category.update.mock.calls[0][0].data).toMatchObject({
      builderType: null,
      designCategoryId: null,
    });
  });
  it.each([
    [{ designCategoryId: 'not-a-uuid' }, null],
    [{ designCategoryId: libraryId }, null],
    [{ designCategoryId: libraryId }, { id: libraryId, designCategoryId: id }],
  ])('rejects an invalid design library %j', async (invalid, library) => {
    category.findUnique.mockResolvedValue(library);
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Invalid library', ...invalid })
      .expect(400);
    expect(category.create).not.toHaveBeenCalled();
  });
  it('rejects a category that uses itself as its design library', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .send({ designCategoryId: id })
      .expect(400);
    expect(category.update).not.toHaveBeenCalled();
  });
  it("offers shared library designs alongside the category's own", async () => {
    category.findUnique.mockResolvedValue({
      subCategories: [{ id: 'own' }],
      designCategory: { subCategories: [{ id: 'shared' }] },
    });
    const response = await request(app.getHttpServer())
      .get('/api/v1/categories/' + id + '/sub-categories')
      .expect(200);
    expect(response.body.map((item: { id: string }) => item.id)).toEqual([
      'own',
      'shared',
    ]);
  });
  it.each([null, [], [size]])('saves optional sizes %j', async (sizes) => {
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Sized', sizes })
      .expect(201);
    expect(category.create.mock.calls[0][0].data.sizes).toEqual(
      sizes === null ? Prisma.DbNull : sizes,
    );
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .send({ sizes })
      .expect(200);
    expect(category.update.mock.calls[0][0].data.sizes).toEqual(
      sizes === null ? Prisma.DbNull : sizes,
    );
  });
  it('parses FormData sizes and rejects malformed JSON', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .field('name', 'Sized')
      .field('sizes', JSON.stringify([size]))
      .expect(201);
    expect(category.create.mock.calls[0][0].data.sizes).toEqual([size]);
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .field('sizes', 'null')
      .expect(200);
    expect(category.update.mock.calls[0][0].data.sizes).toBe(Prisma.DbNull);
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .field('name', 'Sized')
      .field('sizes', '[bad')
      .expect(400);
  });
  it.each([
    {},
    'bad',
    [null],
    [size, size],
    [{ ...size, id: '' }],
    [{ ...size, name: 3 }],
    [{ ...size, measurement: 0 }],
    [{ ...size, measurement: '18' }],
    [{ ...size, unit: '' }],
    [{ ...size, maxItems: 1.5 }],
    [{ ...size, maxItems: -1 }],
    [{ id: 'small', name: 'Small', unit: 'cm', maxItems: 16 }],
  ])('rejects invalid category sizes %j', async (sizes) => {
    await request(app.getHttpServer())
      .post('/api/v1/categories')
      .send({ name: 'Sized', sizes })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/api/v1/categories/' + id)
      .send({ sizes })
      .expect(400);
    expect(category.create).not.toHaveBeenCalled();
    expect(category.update).not.toHaveBeenCalled();
  });

  describe('jewelry sizes and component physical sizes', () => {
    const bracelet = {
      id,
      name: 'Bracelet',
      builderType: 'JEWELRY',
      builderConfig: null,
    };
    const medium = {
      id: 'medium',
      name: 'Medium',
      minMeasurementMm: 180,
      maxMeasurementMm: 240,
      defaultMeasurementMm: 200,
    };

    it('stores bracelet sizes as length ranges and drops legacy fields', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .send({
          name: 'Bracelet',
          builderType: 'JEWELRY',
          sizes: [{ ...medium, maxItems: 32 }],
        })
        .expect(201);
      expect(category.create.mock.calls[0][0].data.sizes).toEqual([medium]);
    });

    it.each([
      [[size]],
      [[{ ...medium, maxMeasurementMm: 170 }]],
      [[{ ...medium, defaultMeasurementMm: 260 }]],
      [[{ ...medium, minMeasurementMm: 18.5 }]],
    ])(
      'rejects bracelet sizes that are not valid length ranges %j',
      async (sizes) => {
        category.findUnique.mockResolvedValue({
          ...bracelet,
          subCategories: [],
        });
        await request(app.getHttpServer())
          .post('/api/v1/categories')
          .send({ name: 'Bracelet', builderType: 'JEWELRY', sizes })
          .expect(400);
        // An update takes the studio from the stored category when the request omits it.
        await request(app.getHttpServer())
          .patch('/api/v1/categories/' + id)
          .send({ sizes })
          .expect(400);
        expect(category.create).not.toHaveBeenCalled();
        expect(category.update).not.toHaveBeenCalled();
      },
    );

    it('sizes necklaces by length too, and keeps other studios in the legacy shape', async () => {
      const necklace = {
        ...medium,
        minMeasurementMm: 400,
        maxMeasurementMm: 600,
        defaultMeasurementMm: 450,
      };
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .send({
          name: 'Necklace',
          builderType: 'JEWELRY',
          builderConfig: { silhouette: 'NECKLACE' },
          sizes: [necklace],
        })
        .expect(201);
      expect(category.create.mock.calls[0][0].data.sizes).toEqual([necklace]);
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .send({ name: 'Necklace', builderType: 'JEWELRY', sizes: [size] })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .send({ name: 'Sized', sizes: [size] })
        .expect(201);
    });

    it('requires a physical size for new jewelry components only', async () => {
      category.findUnique.mockResolvedValue(bracelet);
      const component = {
        categoryId: id,
        name: 'Black Onyx',
        price: 20,
        stock: 500,
      };
      await request(app.getHttpServer())
        .post('/api/v1/sub-categories')
        .send(component)
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/sub-categories')
        .send({ ...component, effectiveLengthMm: 8.5 })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/sub-categories')
        .send({ ...component, effectiveLengthMm: 8 })
        .expect(201);
      expect(subCategory.create.mock.calls[0][0].data).toMatchObject({
        effectiveLengthMm: 8,
      });
      // Necklace components are measured as well.
      category.findUnique.mockResolvedValue({
        id,
        name: 'Necklace',
        builderType: 'JEWELRY',
      });
      await request(app.getHttpServer())
        .post('/api/v1/sub-categories')
        .send({ ...component, name: 'Pearl' })
        .expect(400);
      category.findUnique.mockResolvedValue({
        id,
        name: 'Gifts',
        builderType: 'GIFT',
      });
      await request(app.getHttpServer())
        .post('/api/v1/sub-categories')
        .send({ ...component, name: 'Mug' })
        .expect(201);
    });

    it('lets unmeasured bracelet components be edited, but never loses a size', async () => {
      subCategory.findUnique.mockResolvedValue({
        ...child,
        effectiveLengthMm: null,
        category: bracelet,
      });
      // Existing components are measured over time: other edits still work meanwhile.
      await request(app.getHttpServer())
        .patch('/api/v1/sub-categories/' + childId)
        .send({ stock: 40 })
        .expect(200);
      await request(app.getHttpServer())
        .patch('/api/v1/sub-categories/' + childId)
        .send({ effectiveLengthMm: 10 })
        .expect(200);
      await request(app.getHttpServer())
        .patch('/api/v1/sub-categories/' + childId)
        .send({ effectiveLengthMm: null })
        .expect(400);
    });
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
    // The parent's studio decides whether the component needs a physical size.
    expect(category.findUnique).toHaveBeenCalledWith({
      where: { id },
      select: { id: true, name: true, builderType: true, builderConfig: true },
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
