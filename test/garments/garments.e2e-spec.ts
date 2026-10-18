import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard.js';
import { AdminGuard } from '../../src/common/guards/admin.guard.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { GarmentsModule } from '../../src/modules/garments/garments.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

const delegate = () => ({
  create: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
});

describe('Garments HTTP', () => {
  let app: INestApplication<App>;
  let admin = true;
  const categoryId = 'ac78a80a-ce2b-4c45-8076-fca001c71418';
  const id = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const category = delegate();
  const garment = delegate();
  const garmentVariant = delegate();
  const product = delegate();
  const tx = { category, garment, garmentVariant, product };
  const record = {
    id,
    categoryId,
    name: 'Classic Hoodie',
    basePrice: 3500,
    imageKey: null,
    frontImageKey: null,
    backImageKey: null,
    variants: [],
  };
  const area = {
    x: 0.3,
    y: 0.28,
    width: 0.4,
    height: 0.42,
    widthCm: 30,
    heightCm: 40,
  };

  beforeAll(async () => {
    vi.stubEnv('JWT_ACCESS_SECRET', 'garment-tests-only-secret-32-characters');
    const module = await Test.createTestingModule({ imports: [GarmentsModule] })
      .overrideProvider(PrismaService)
      .useValue({
        ...tx,
        $transaction: (callback: (client: unknown) => Promise<unknown>) =>
          callback(tx),
      })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => admin })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    admin = true;
    category.findUnique.mockResolvedValue({
      id: categoryId,
      builderType: 'APPAREL',
    });
    garment.findUnique.mockResolvedValue(record);
    garment.findMany.mockResolvedValue([record]);
    garment.create.mockResolvedValue(record);
    garment.update.mockResolvedValue(record);
    garment.delete.mockResolvedValue(record);
    garmentVariant.findMany.mockResolvedValue([]);
    product.count.mockResolvedValue(0);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('lists only active garments and active variants of a category', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/categories/${categoryId}/garments`)
      .expect(200);
    const query = garment.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ categoryId, isActive: true });
    expect(query.include.variants.where).toEqual({ isActive: true });
  });

  it('lets the dashboard origin send the PUT variants request (CORS preflight)', async () => {
    const response = await request(app.getHttpServer())
      .options(`/api/v1/garments/${id}/variants`)
      .set('Origin', 'http://localhost:8081')
      .set('Access-Control-Request-Method', 'PUT')
      .expect(204);
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
  });

  it('lists every garment and variant of a category for admins only', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/garments?categoryId=${categoryId}`)
      .expect(200);
    const query = garment.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ categoryId });
    expect(query.include.variants.where).toBeUndefined();
    await request(app.getHttpServer()).get('/api/v1/garments').expect(400);
    admin = false;
    await request(app.getHttpServer())
      .get(`/api/v1/garments?categoryId=${categoryId}`)
      .expect(403);
  });

  it('creates a garment with print areas from FormData', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/garments')
      .field('categoryId', categoryId)
      .field('name', ' Classic Hoodie ')
      .field('basePrice', '3500')
      .field('silhouette', 'HOODIE')
      .field('frontPrintArea', JSON.stringify(area))
      .expect(201);
    expect(garment.create.mock.calls[0][0].data).toMatchObject({
      categoryId,
      name: 'Classic Hoodie',
      basePrice: 3500,
      silhouette: 'HOODIE',
      frontPrintArea: area,
    });
  });

  it.each([
    [{ basePrice: -1 }],
    [{ basePrice: 12.5 }],
    [{ silhouette: 'hoodie' }],
    [{ frontPrintArea: { ...area, x: 0.8 } }],
    [{ frontPrintArea: { ...area, width: 0 } }],
    [{ backPrintArea: { ...area, widthCm: 999 } }],
    [{ backPrintArea: { ...area, bleed: 2 } }],
  ])('rejects invalid garment data %j', async (invalid) => {
    await request(app.getHttpServer())
      .post('/api/v1/garments')
      .send({ categoryId, name: 'Hoodie', basePrice: 3500, ...invalid })
      .expect(400);
    expect(garment.create).not.toHaveBeenCalled();
  });

  it('only adds garments to APPAREL categories', async () => {
    category.findUnique.mockResolvedValue({
      id: categoryId,
      builderType: 'JEWELRY',
    });
    await request(app.getHttpServer())
      .post('/api/v1/garments')
      .send({ categoryId, name: 'Hoodie', basePrice: 3500 })
      .expect(400);
    expect(garment.create).not.toHaveBeenCalled();
  });

  it('keeps garment mutations admin-only', async () => {
    admin = false;
    await request(app.getHttpServer())
      .post('/api/v1/garments')
      .send({ categoryId, name: 'Hoodie', basePrice: 3500 })
      .expect(403);
    await request(app.getHttpServer())
      .put(`/api/v1/garments/${id}/variants`)
      .send({ variants: [] })
      .expect(403);
  });

  it('replaces the size × colour matrix, keeping ids and protecting ordered variants', async () => {
    garmentVariant.findMany.mockResolvedValue([
      { id: 'keep', size: 'S', colorValue: '#C0392B', _count: { products: 0 } },
      {
        id: 'drop',
        size: 'XL',
        colorValue: '#C0392B',
        _count: { products: 0 },
      },
      { id: 'used', size: 'M', colorValue: '#FFFFFF', _count: { products: 2 } },
    ]);
    await request(app.getHttpServer())
      .put(`/api/v1/garments/${id}/variants`)
      .send({
        variants: [
          { size: 'S', colorName: 'Red', colorValue: '#c0392b', stock: 1 },
          {
            size: 'L',
            colorName: 'White',
            colorValue: '#FFFFFF',
            stock: 5,
            price: 3900,
            sku: 'HD-W-L',
          },
        ],
      })
      .expect(200);
    // Same size and colour (case-insensitive) updates the existing row.
    expect(garmentVariant.update).toHaveBeenCalledWith({
      where: { id: 'keep' },
      data: expect.objectContaining({ stock: 1, colorName: 'Red' }),
    });
    expect(garmentVariant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        garmentId: id,
        size: 'L',
        stock: 5,
        price: 3900,
        sku: 'HD-W-L',
      }),
    });
    expect(garmentVariant.delete).toHaveBeenCalledWith({
      where: { id: 'drop' },
    });
    // A variant customers designed on is deactivated, never deleted.
    expect(garmentVariant.update).toHaveBeenCalledWith({
      where: { id: 'used' },
      data: { isActive: false },
    });
  });

  it.each([
    [
      [
        { size: 'S', colorName: 'Red', colorValue: '#C0392B', stock: 1 },
        { size: 'S', colorName: 'Rouge', colorValue: '#c0392b', stock: 2 },
      ],
    ],
    [
      [
        {
          size: 'S',
          colorName: 'Red',
          colorValue: '#C0392B',
          stock: 1,
          sku: 'A',
        },
        {
          size: 'M',
          colorName: 'Red',
          colorValue: '#C0392B',
          stock: 1,
          sku: 'A',
        },
      ],
    ],
    [[{ size: 'S', colorName: 'Red', colorValue: '#C0392B', stock: -1 }]],
  ])('rejects an invalid variant matrix', async (variants) => {
    await request(app.getHttpServer())
      .put(`/api/v1/garments/${id}/variants`)
      .send({ variants })
      .expect(400);
    expect(garmentVariant.create).not.toHaveBeenCalled();
  });

  it('refuses to delete a garment customers have designed on', async () => {
    product.count.mockResolvedValue(3);
    await request(app.getHttpServer())
      .delete(`/api/v1/garments/${id}`)
      .expect(409);
    expect(garment.delete).not.toHaveBeenCalled();
    product.count.mockResolvedValue(0);
    await request(app.getHttpServer())
      .delete(`/api/v1/garments/${id}`)
      .expect(204);
  });

  it('maps a missing garment to 404', async () => {
    garment.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get(`/api/v1/garments/${id}`)
      .expect(404);
  });
});
