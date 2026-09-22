import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { UsersModule } from '../../src/modules/users/users.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

describe('Users HTTP CRUD', () => {
  let app: INestApplication<App>;
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
    user.findMany.mockResolvedValue([safe]);
    user.findUnique.mockResolvedValue(safe);
    user.update.mockResolvedValue(safe);
    user.delete.mockResolvedValue({ id });
  });
  afterAll(async () => {
    await app?.close();
  });

  it('serves all five endpoints under exactly one prefix', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .send(body)
      .expect(201);
    expect(created.body).not.toHaveProperty('passwordHash');
    await request(app.getHttpServer()).get('/api/v1/users').expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/users/' + id)
      .expect(200);
    await request(app.getHttpServer())
      .patch('/api/v1/users/' + id)
      .send({ isActive: false })
      .expect(200);
    const deleted = await request(app.getHttpServer())
      .delete('/api/v1/users/' + id)
      .expect(204);
    expect(deleted.text).toBe('');
    await request(app.getHttpServer()).get('/api/v1/api/v1/users').expect(404);
  });

  it.each(['role', 'isActive', 'passwordHash'])(
    'rejects create mass assignment: %s',
    async (field) => {
      await request(app.getHttpServer())
        .post('/api/v1/users')
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
      .send(invalid)
      .expect(400);
    expect(user.update).not.toHaveBeenCalled();
  });

  it('rejects malformed UUIDs before querying', async () => {
    await request(app.getHttpServer()).get('/api/v1/users/bad').expect(400);
    expect(user.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing user', async () => {
    user.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer())
      .get('/api/v1/users/' + id)
      .expect(404);
  });
  it('accepts and normalizes the new optional registration fields', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/users')
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
      .send({ ...body, ...invalid })
      .expect(400);
    expect(user.create).not.toHaveBeenCalled();
  });
  it('allows updates of the new optional fields', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/users/' + id)
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
});
