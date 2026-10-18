import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { UsersModule } from '../../src/modules/users/users.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

describe('Public registration HTTP', () => {
  let app: INestApplication<App>;
  const safe = {
    id: 'ac78a80a-ce2b-4c45-8076-fca001c71418',
    firstName: 'Mila',
    lastName: 'Stone',
    email: 'mila@example.com',
    phone: null,
    role: 'CUSTOMER',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const user = { create: vi.fn(), findUnique: vi.fn() };
  const body = {
    firstName: 'Mila',
    lastName: 'Stone',
    email: ' MILA@example.com ',
    password: 'StrongPassword123!',
  };

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'test-only-registration-secret-at-least-32-chars',
    );
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
    const module = await Test.createTestingModule({ imports: [UsersModule] })
      .overrideProvider(PrismaService)
      .useValue({ user })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    user.create.mockResolvedValue(safe);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('lets a visitor register without a session, always as a customer', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(body)
      .expect(201);
    expect(response.body).not.toHaveProperty('passwordHash');
    const data = user.create.mock.calls[0][0].data;
    expect(data.email).toBe('mila@example.com');
    expect(data.role).toBe('CUSTOMER');
    expect(data.passwordHash).not.toBe(body.password);
  });

  it.each(['role', 'isActive', 'passwordHash'])(
    'rejects privileged field %s',
    async (field) => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ ...body, [field]: field === 'isActive' ? false : 'ADMIN' })
        .expect(400);
      expect(user.create).not.toHaveBeenCalled();
    },
  );

  it('validates the password length', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...body, password: 'short' })
      .expect(400);
    expect(user.create).not.toHaveBeenCalled();
  });

  it('keeps admin user creation protected', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .send(body)
      .expect(401);
    expect(user.create).not.toHaveBeenCalled();
  });
});
