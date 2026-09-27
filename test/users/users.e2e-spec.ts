import { JwtService } from '@nestjs/jwt';
import { Prisma } from '../../src/generated/prisma/client.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { UsersModule } from '../../src/modules/users/users.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

describe('Users HTTP CRUD', () => {
  let app: INestApplication<App>;
  let token: string;
  const adminId = 'bc78a80a-ce2b-4c45-8076-fca001c71418';
  let adminRole = 'ADMIN';
  const id = 'ac78a80a-ce2b-4c45-8076-fca001c71418';
  const safe = {
    id,
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    phone: null,
    role: 'CUSTOMER',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const user = {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const body = {
    firstName: 'John',
    lastName: 'Doe',
    email: ' JOHN@example.com ',
    password: 'StrongPassword123!',
  };

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'test-only-users-secret-at-least-32-characters',
    );
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
    const module = await Test.createTestingModule({ imports: [UsersModule] })
      .overrideProvider(PrismaService)
      .useValue({ user })
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    token = await module
      .get(JwtService)
      .signAsync({ sub: adminId, tokenUse: 'access' });
  });
  beforeEach(() => {
    vi.resetAllMocks();
    adminRole = 'ADMIN';
    user.create.mockResolvedValue(safe);
    user.findMany.mockResolvedValue([safe]);
    user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === adminId ? { ...safe, id: adminId, role: adminRole } : safe,
      ),
    );
    user.update.mockResolvedValue(safe);
    user.delete.mockResolvedValue({ id });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('serves all five endpoints under exactly one prefix', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', 'Bearer ' + token)
      .send(body)
      .expect(201);
    expect(created.body).not.toHaveProperty('passwordHash');
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/users/' + id)
      .set('Authorization', 'Bearer ' + token)
      .expect(200);
    await request(app.getHttpServer())
      .patch('/api/v1/users/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({ isActive: false })
      .expect(200);
    const deleted = await request(app.getHttpServer())
      .delete('/api/v1/users/' + id)
      .set('Authorization', 'Bearer ' + token)
      .expect(204);
    expect(deleted.text).toBe('');
    await request(app.getHttpServer())
      .get('/api/v1/api/v1/users')
      .set('Authorization', 'Bearer ' + token)
      .expect(404);
  });

  it.each(['role', 'isActive', 'passwordHash'])(
    'rejects create mass assignment: %s',
    async (field) => {
      await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Authorization', 'Bearer ' + token)
        .send({ ...body, [field]: 'ADMIN' })
        .expect(400);
      expect(user.create).not.toHaveBeenCalled();
    },
  );

  it.each(['password', 'passwordHash', 'role'])(
    'rejects update of %s',
    async (field) => {
      await request(app.getHttpServer())
        .patch('/api/v1/users/' + id)
        .set('Authorization', 'Bearer ' + token)
        .send({ [field]: 'bad' })
        .expect(400);
      expect(user.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    { email: 'bad' },
    { firstName: ' ' },
    { password: 'short' },
    { phone: 123 },
    { email: null },
  ])('validates create fields %j', async (invalid) => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', 'Bearer ' + token)
      .send({ ...body, ...invalid })
      .expect(400);
    expect(user.create).not.toHaveBeenCalled();
  });

  it.each([
    { email: null },
    { isActive: 'false' },
    { firstName: '' },
    { phone: 123 },
  ])('validates supplied patch fields %j', async (invalid) => {
    await request(app.getHttpServer())
      .patch('/api/v1/users/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send(invalid)
      .expect(400);
    expect(user.update).not.toHaveBeenCalled();
  });

  it('rejects malformed UUIDs before querying', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users/bad')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
    expect(user.findUnique).toHaveBeenCalledTimes(1);
    expect(user.findUnique.mock.calls[0][0].where.id).toBe(adminId);
  });

  it('returns 404 for a missing user', async () => {
    user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === adminId ? { ...safe, id: adminId, role: 'ADMIN' } : null,
      ),
    );
    await request(app.getHttpServer())
      .get('/api/v1/users/' + id)
      .set('Authorization', 'Bearer ' + token)
      .expect(404);
  });
  it('accepts and normalizes the new optional registration fields', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', 'Bearer ' + token)
      .send({
        ...body,
        userName: ' John.Doe ',
        phone: '044123456',
        country: ' Kosovo ',
        address: ' Main Street ',
        postalCode: ' 10000 ',
      })
      .expect(201);
    expect(user.create.mock.calls[0][0].data).toMatchObject({
      userName: 'john.doe',
      phone: '044123456',
      country: 'Kosovo',
      address: 'Main Street',
      postalCode: '10000',
    });
    expect(user.create.mock.calls[0][0].select).toMatchObject({
      userName: true,
      country: true,
      address: true,
      postalCode: true,
    });
  });
  it.each([
    { userName: 'ab' },
    { userName: 'bad@name' },
    { userName: 'two words' },
    { country: 123 },
    { address: null },
    { postalCode: 'x'.repeat(21) },
  ])('rejects invalid new registration fields %j', async (invalid) => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
      .set('Authorization', 'Bearer ' + token)
      .send({ ...body, ...invalid })
      .expect(400);
    expect(user.create).not.toHaveBeenCalled();
  });
  it('allows updates of the new optional fields', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/users/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({
        userName: 'NEW.NAME',
        country: 'Kosovo',
        address: 'New address',
        postalCode: '20000',
      })
      .expect(200);
    expect(user.update.mock.calls[0][0].data).toMatchObject({
      userName: 'new.name',
      country: 'Kosovo',
      address: 'New address',
      postalCode: '20000',
    });
  });
  it.each(['post', 'patch', 'delete', 'get'] as const)(
    'requires authentication and ADMIN for %s',
    async (method) => {
      const path =
        '/api/v1/users' +
        (['patch', 'delete'].includes(method) ? '/' + id : '');
      await request(app.getHttpServer())
        [method](path)
        .send(method === 'post' ? body : {})
        .expect(401);
      adminRole = 'CUSTOMER';
      await request(app.getHttpServer())
        [method](path)
        .set('Authorization', 'Bearer ' + token)
        .send(method === 'post' ? body : {})
        .expect(403);
      expect(user.create).not.toHaveBeenCalled();
      expect(user.update).not.toHaveBeenCalled();
      expect(user.delete).not.toHaveBeenCalled();
      expect(user.findMany).not.toHaveBeenCalled();
    },
  );
  it('clears optional profile fields without changing role or password', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/users/' + id)
      .set('Authorization', 'Bearer ' + token)
      .send({
        phone: null,
        userName: null,
        country: null,
        address: null,
        postalCode: null,
      })
      .expect(200);
    expect(user.update.mock.calls[0][0].data).toMatchObject({
      phone: null,
      userName: null,
      country: null,
      address: null,
      postalCode: null,
    });
  });
  it('reports linked records instead of deleting related data', async () => {
    user.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('private details', {
        code: 'P2003',
        clientVersion: '7.10.0',
      }),
    );
    const response = await request(app.getHttpServer())
      .delete('/api/v1/users/' + id)
      .set('Authorization', 'Bearer ' + token)
      .expect(409);
    expect(response.body.message).toContain('Deactivate');
    expect(response.text).not.toContain('private details');
  });
});
