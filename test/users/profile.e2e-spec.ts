import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { UsersModule } from '../../src/modules/users/users.module.js';
import { OrdersModule } from '../../src/modules/orders/orders.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { setupApp } from '../../src/config/setup-app.js';

describe('Customer delivery profile and checkout', () => {
  let app: INestApplication<App>;
  let token: string;
  const id = 'ac78a80a-ce2b-4c45-8076-fca001c71418';
  const productId = 'bc78a80a-ce2b-4c45-8076-fca001c71418';
  const componentId = 'cc78a80a-ce2b-4c45-8076-fca001c71418';
  const initial = {
    id,
    firstName: 'Test',
    lastName: 'Customer',
    email: 'test@example.com',
    phone: null,
    country: null,
    address: null,
    postalCode: null,
    role: 'CUSTOMER',
    isActive: true,
  };
  let account: Record<string, unknown>;
  const user = {
    findUnique: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  };
  const product = { findUnique: vi.fn() };
  const order = { create: vi.fn() };
  const subCategory = { updateMany: vi.fn() };
  const prisma = {
    user,
    product,
    order,
    subCategory,
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  const delivery = {
    firstName: ' John ',
    lastName: ' Doe ',
    phone: '12345',
    country: ' Kosovo ',
    address: ' Main Street ',
    postalCode: '10000',
  };
  const patch = (body: object) =>
    request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Authorization', 'Bearer ' + token)
      .send(body);

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'test-only-profile-secret-at-least-32-characters',
    );
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
    const module = await Test.createTestingModule({
      imports: [UsersModule, OrdersModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    token = await module
      .get(JwtService)
      .signAsync({ sub: id, tokenUse: 'access' });
  });
  beforeEach(() => {
    vi.resetAllMocks();
    account = { ...initial };
    user.findUnique.mockImplementation(() => Promise.resolve(account));
    user.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => {
        account = {
          ...account,
          ...Object.fromEntries(
            Object.entries(data).filter(([, value]) => value !== undefined),
          ),
        };
        return Promise.resolve(account);
      },
    );
    prisma.$transaction.mockImplementation(
      (operation: (tx: typeof prisma) => Promise<unknown>) => operation(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([]);
    product.findUnique.mockResolvedValue({
      id: productId,
      createdById: id,
      items: [
        {
          subCategoryId: componentId,
          quantity: 2,
          unitPrice: 150,
          subCategory: {
            id: componentId,
            name: 'Bead',
            isActive: true,
            stock: 10,
          },
        },
      ],
    });
    subCategory.updateMany.mockResolvedValue({ count: 1 });
    order.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'order-id', ...data }),
    );
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('allows a CUSTOMER to save their own delivery details and then place an order', async () => {
    const profile = await patch(delivery).expect(200);
    expect(profile.body).toMatchObject({
      id,
      firstName: 'John',
      address: 'Main Street',
      role: 'CUSTOMER',
    });
    expect(user.update.mock.calls[0][0].where).toEqual({ id });
    expect(user.update.mock.calls[0][0].select).not.toHaveProperty(
      'passwordHash',
    );
    const placed = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', 'Bearer ' + token)
      .send({ productId, paymentType: 'CASH_ON_DELIVERY' })
      .expect(201);
    expect(placed.body).toMatchObject({
      userId: id,
      firstName: 'John',
      lastName: 'Doe',
      phone: '12345',
      country: 'Kosovo',
      address: 'Main Street',
      totalPrice: 300,
    });
    expect(subCategory.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: componentId, isActive: true, stock: { gte: 2 } },
      data: { stock: { decrement: 2 } },
    });
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .send(delivery)
      .expect(401);
    expect(user.update).not.toHaveBeenCalled();
  });

  it.each([
    'id',
    'userId',
    'role',
    'isActive',
    'password',
    'passwordHash',
    'email',
    'createdAt',
    'updatedAt',
  ])('rejects privileged or unrelated field %s', async (field) => {
    await patch({ ...delivery, [field]: 'untrusted' }).expect(400);
    expect(user.update).not.toHaveBeenCalled();
  });

  it.each([
    { firstName: ' ' },
    { phone: 123 },
    { country: null },
    { address: '' },
    { postalCode: 'a'.repeat(21) },
  ])('validates profile %j', async (input) => {
    await patch(input).expect(400);
    expect(user.update).not.toHaveBeenCalled();
  });

  it('supports partial changes and clearing an optional postal code', async () => {
    await patch({ postalCode: null }).expect(200);
    expect(user.update.mock.calls[0][0].data.postalCode).toBeNull();
    expect(account.firstName).toBe(initial.firstName);
  });

  it('does not allow customers to access admin user-management routes even for their own ID', async () => {
    for (const target of [id, productId]) {
      await request(app.getHttpServer())
        .patch('/api/v1/users/' + target)
        .set('Authorization', 'Bearer ' + token)
        .send(delivery)
        .expect(403);
      await request(app.getHttpServer())
        .delete('/api/v1/users/' + target)
        .set('Authorization', 'Bearer ' + token)
        .expect(403);
    }
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', 'Bearer ' + token)
      .expect(403);
    expect(user.update).not.toHaveBeenCalled();
    expect(user.delete).not.toHaveBeenCalled();
  });
});
