import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { StatsModule } from '../../src/modules/stats/stats.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

describe('Public stats HTTP', () => {
  let app: INestApplication<App>;
  const prisma = {
    user: { count: vi.fn() },
    order: { count: vi.fn() },
    product: { count: vi.fn() },
    category: { count: vi.fn() },
    $transaction: vi.fn((queries: Promise<number>[]) => Promise.all(queries)),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [StatsModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('returns public counts without a session and caches them', async () => {
    prisma.user.count.mockResolvedValue(52);
    prisma.order.count.mockResolvedValue(130);
    prisma.product.count.mockResolvedValue(24);
    prisma.category.count.mockResolvedValue(7);

    const first = await request(app.getHttpServer())
      .get('/api/v1/stats/public')
      .expect(200);
    expect(first.body).toEqual({
      registeredUsers: 52,
      completedOrders: 130,
      products: 24,
      categories: 7,
    });
    expect(first.headers['cache-control']).toBe('public, max-age=60');
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { role: 'CUSTOMER', isActive: true },
    });
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: { status: 'COMPLETED' },
    });
    expect(prisma.product.count).toHaveBeenCalledWith({
      where: { origin: 'COMPANY', isActive: true },
    });
    expect(prisma.category.count).toHaveBeenCalledWith({
      where: { isActive: true },
    });

    await request(app.getHttpServer()).get('/api/v1/stats/public').expect(200);
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
  });
});
