import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

describe('Notifications HTTP', () => {
  let app: INestApplication<App>;
  let token: string;
  const userA = 'aa78a80a-ce2b-4c45-8076-fca001c71418';
  const userB = 'bb78a80a-ce2b-4c45-8076-fca001c71418';
  const id = 'c1dfc7b7-2a71-46c6-bfba-a453d847044f';
  const user = { findUnique: vi.fn() };
  const notification = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  };
  const prisma = { user, notification };
  const base = '/api/v1/notifications';
  const auth = () => 'Bearer ' + token;
  const record = {
    id,
    orderId: null,
    type: 'ORDER_STATUS',
    title: 'Ready for the courier',
    message:
      'Your order HM-2026-000000123 is ready to be handed over to the courier.',
    isRead: false,
    readAt: null,
    createdAt: new Date('2026-10-27T10:00:00Z'),
  };

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'test-only-jwt-secret-at-least-32-characters',
    );
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
    const module = await Test.createTestingModule({
      imports: [NotificationsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    // Every request is signed in as user A.
    token = await module
      .get(JwtService)
      .signAsync({ sub: userA, tokenUse: 'access' });
  });
  beforeEach(() => {
    vi.resetAllMocks();
    user.findUnique.mockResolvedValue({
      id: userA,
      firstName: 'Ana',
      lastName: 'Customer',
      email: 'ana@example.com',
      role: 'CUSTOMER',
      isActive: true,
      notificationsEnabled: true,
    });
    notification.findMany.mockResolvedValue([record]);
    notification.count.mockResolvedValue(3);
    notification.updateMany.mockResolvedValue({ count: 3 });
    notification.findFirstOrThrow.mockResolvedValue({
      ...record,
      isRead: true,
    });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('requires a signed-in customer', async () => {
    await request(app.getHttpServer()).get(base).expect(401);
    await request(app.getHttpServer())
      .get(base + '/unread-count')
      .expect(401);
    await request(app.getHttpServer())
      .patch(base + '/read-all')
      .expect(401);
    expect(notification.findMany).not.toHaveBeenCalled();
  });

  it('lists only the signed-in customer’s notifications, whatever the request asks', async () => {
    const response = await request(app.getHttpServer())
      .get(base + '?userId=' + userB)
      .set('Authorization', auth())
      .expect(200);
    expect(response.body).toHaveLength(1);
    expect(notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: userA } }),
    );
  });

  it('counts only the customer’s own unread notifications', async () => {
    const response = await request(app.getHttpServer())
      .get(base + '/unread-count')
      .set('Authorization', auth())
      .expect(200);
    expect(response.body).toEqual({ count: 3 });
    expect(notification.count).toHaveBeenCalledWith({
      where: { userId: userA, isRead: false },
    });
  });

  it('marks the customer’s own notification read', async () => {
    notification.findFirst.mockResolvedValue({ id, isRead: false });
    const response = await request(app.getHttpServer())
      .patch(`${base}/${id}/read`)
      .set('Authorization', auth())
      .expect(200);
    expect(response.body.isRead).toBe(true);
    expect(notification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id, userId: userA } }),
    );
    expect(notification.updateMany).toHaveBeenCalledWith({
      where: { id, userId: userA, isRead: false },
      data: { isRead: true, readAt: expect.any(Date) },
    });
  });

  it('never marks another customer’s notification: it is simply not found', async () => {
    // The lookup is scoped to user A, so user B's notification does not exist for them.
    notification.findFirst.mockResolvedValue(null);
    await request(app.getHttpServer())
      .patch(`${base}/${id}/read`)
      .set('Authorization', auth())
      .expect(404);
    expect(notification.updateMany).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .patch(`${base}/not-a-uuid/read`)
      .set('Authorization', auth())
      .expect(400);
  });

  it('marks all of the customer’s notifications read, and only theirs', async () => {
    const response = await request(app.getHttpServer())
      .patch(base + '/read-all')
      .set('Authorization', auth())
      .expect(200);
    expect(response.body).toEqual({ updated: 3 });
    expect(notification.updateMany).toHaveBeenCalledWith({
      where: { userId: userA, isRead: false },
      data: { isRead: true, readAt: expect.any(Date) },
    });
  });
});
