import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { OrdersModule } from '../../src/modules/orders/orders.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { setupApp } from '../../src/config/setup-app.js';

const dbError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Private SQL and credentials', {
    code,
    clientVersion: '7.10.0',
  });
const workflow = [
  'ORDERED',
  'CREATING',
  'CREATED',
  'READY_FOR_COURIER',
  'PICKED_UP_BY_COURIER',
  'COMPLETED',
];

describe('Orders HTTP', () => {
  let app: INestApplication<App>;
  let token: string;
  const userId = 'ac78a80a-ce2b-4c45-8076-fca001c71418';
  const productId = 'd4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const id = 'f5cf6f87-2a71-46c6-bfba-a453d847044f';
  const otherId = 'b4dfc7b7-2a71-46c6-bfba-a453d847044f';
  const account = {
    id: userId,
    firstName: 'Test',
    lastName: 'Customer',
    phone: '123456789',
    country: 'Kosovo',
    address: 'Main Street',
    postalCode: '10000',
    email: 'test@example.com',
    role: 'CUSTOMER',
    isActive: true,
  };
  const productRecord = {
    id: productId,
    createdById: userId,
    price: 2999,
    items: [
      {
        subCategoryId: otherId,
        quantity: 3,
        unitPrice: 999,
        subCategory: { id: otherId, name: 'Bead', stock: 100, isActive: true },
      },
      {
        subCategoryId: otherId,
        quantity: 1,
        unitPrice: 2,
        subCategory: { id: otherId, name: 'Bead', stock: 100, isActive: true },
      },
    ],
  };
  const record = {
    id,
    userId,
    productId,
    orderNumber: 'HM-2026-000000123',
    status: 'ORDERED',
    paymentType: 'CARD',
    paymentStatus: 'UNPAID',
    totalPrice: 2999,
    firstName: account.firstName,
    lastName: account.lastName,
    phone: account.phone,
    country: account.country,
    address: account.address,
    postalCode: account.postalCode,
    customerNotes: null,
    adminNotes: 'Internal note',
    finalImageUrl: null,
  };
  const user = { findUnique: vi.fn() };
  const product = { findUnique: vi.fn() };
  const order = {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const subCategory = { updateMany: vi.fn(), findUnique: vi.fn() };
  const prisma = {
    user,
    product,
    order,
    subCategory,
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  const base = '/api/v1/orders';
  const body = { productId, paymentType: 'CARD', customerNotes: 'Please call' };
  const admin = () =>
    user.findUnique.mockResolvedValue({ ...account, role: 'ADMIN' });
  const post = (input: object) =>
    request(app.getHttpServer())
      .post(base)
      .set('Authorization', 'Bearer ' + token)
      .send(input);
  const patch = (suffix: string, input: object) =>
    request(app.getHttpServer())
      .patch(base + '/' + id + suffix)
      .set('Authorization', 'Bearer ' + token)
      .send(input);
  const get = (suffix = '') =>
    request(app.getHttpServer())
      .get(base + suffix)
      .set('Authorization', 'Bearer ' + token);
  const remove = () =>
    request(app.getHttpServer())
      .delete(base + '/' + id)
      .set('Authorization', 'Bearer ' + token);

  beforeAll(async () => {
    vi.stubEnv(
      'JWT_ACCESS_SECRET',
      'test-only-jwt-secret-at-least-32-characters',
    );
    vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
    const module = await Test.createTestingModule({ imports: [OrdersModule] })
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
    subCategory.updateMany.mockResolvedValue({ count: 1 });
    user.findUnique.mockResolvedValue(account);
    product.findUnique.mockResolvedValue({
      ...productRecord,
      items: productRecord.items.map((item) => ({
        ...item,
        subCategory: {
          id: item.subCategoryId,
          name: 'Bead',
          stock: 100,
          isActive: true,
        },
      })),
    });
    order.create.mockResolvedValue(record);
    order.findUnique.mockResolvedValue(record);
    order.findMany.mockResolvedValue([record]);
    order.count.mockResolvedValue(1);
    order.update.mockResolvedValue(record);
    order.delete.mockResolvedValue({ id });
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('returns 400 with component details before creating an insufficient-stock order', async () => {
    product.findUnique.mockResolvedValue({
      ...productRecord,
      items: productRecord.items.map((item) => ({
        ...item,
        subCategory: { ...item.subCategory, stock: 2 },
      })),
    });
    const response = await post(body).expect(400);
    expect(response.body).toMatchObject({
      subCategoryName: 'Bead',
      requestedQuantity: 4,
      availableQuantity: 2,
    });
    expect(order.create).not.toHaveBeenCalled();
    expect(subCategory.updateMany).not.toHaveBeenCalled();
  });

  it('creates first and uses a conditional aggregated decrement within the transaction', async () => {
    await post(body).expect(201);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(subCategory.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: otherId, isActive: true, stock: { gte: 4 } },
      data: { stock: { decrement: 4 } },
    });
    expect(order.create.mock.invocationCallOrder[0]).toBeLessThan(
      subCategory.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('requires JWT on every endpoint', async () => {
    await request(app.getHttpServer()).post(base).send(body).expect(401);
    await request(app.getHttpServer()).get(base).expect(401);
    await request(app.getHttpServer())
      .get(base + '/' + id)
      .expect(401);
    for (const suffix of ['', '/status', '/payment-status'])
      await request(app.getHttpServer())
        .patch(base + '/' + id + suffix)
        .send({})
        .expect(401);
    await request(app.getHttpServer())
      .delete(base + '/' + id)
      .expect(401);
    await request(app.getHttpServer())
      .get(base)
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    expect(order.create).not.toHaveBeenCalled();
  });

  it.each(['CASH_ON_DELIVERY', 'CASH_ON_PICKUP', 'CARD'])(
    'creates %s orders with trusted snapshots, defaults and price',
    async (paymentType) => {
      await post({ ...body, paymentType }).expect(201);
      const { data, select } = order.create.mock.calls[0][0];
      expect(data).toMatchObject({
        userId,
        productId,
        totalPrice: productRecord.price,
        status: 'ORDERED',
        paymentStatus: 'UNPAID',
        paymentType,
        firstName: account.firstName,
        lastName: account.lastName,
        phone: account.phone,
        country: account.country,
        address: account.address,
        postalCode: account.postalCode,
        customerNotes: body.customerNotes,
      });
      expect(data.orderNumber).toMatch(/^HM-\d{4}-\d{9}$/);
      expect(select.adminNotes).toBe(false);
      expect(select.user.select).toEqual({
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
      });
      expect(select.product.select.items.select.subCategory.select).toEqual({
        id: true,
        categoryId: true,
        name: true,
        description: true,
        imageUrl: true,
        color: true,
        type: true,
        price: true,
      });
      expect(JSON.stringify(select)).not.toContain('passwordHash');
    },
  );

  it('lets admins order any product but always uses the authenticated admin as customer', async () => {
    admin();
    product.findUnique.mockResolvedValue({
      ...productRecord,
      createdById: otherId,
    });
    await post(body).expect(201);
    expect(order.create.mock.calls[0][0].data.userId).toBe(userId);
  });

  it('rejects another customer’s product and missing products', async () => {
    product.findUnique.mockResolvedValue({
      ...productRecord,
      createdById: otherId,
    });
    await post(body).expect(403);
    product.findUnique.mockResolvedValue(null);
    await post(body).expect(404);
    expect(order.create).not.toHaveBeenCalled();
  });

  it.each(['firstName', 'lastName', 'phone', 'country', 'address'])(
    'requires profile field %s',
    async (field) => {
      user.findUnique.mockResolvedValue({ ...account, [field]: ' ' });
      await post(body).expect(400);
      expect(order.create).not.toHaveBeenCalled();
    },
  );

  it('allows a missing optional postal code and zero price, but rejects negative prices', async () => {
    user.findUnique.mockResolvedValue({ ...account, postalCode: null });
    product.findUnique.mockResolvedValue({
      ...productRecord,
      price: 0,
      items: [
        {
          subCategoryId: otherId,
          quantity: 1,
          unitPrice: 0,
          subCategory: {
            id: otherId,
            name: 'Bead',
            stock: 100,
            isActive: true,
          },
        },
      ],
    });
    await post(body).expect(201);
    expect(order.create.mock.calls[0][0].data).toMatchObject({
      postalCode: null,
      totalPrice: 0,
    });
    product.findUnique.mockResolvedValue({
      ...productRecord,
      items: [{ subCategoryId: otherId, quantity: 1, unitPrice: -1 }],
    });
    await post(body).expect(400);
  });

  it.each([
    'id',
    'userId',
    'orderNumber',
    'totalPrice',
    'stock',
    'itemCount',
    'unitPrice',
    'status',
    'paymentStatus',
    'adminNotes',
    'finalImageUrl',
    'firstName',
    'createdAt',
    'updatedAt',
  ])('rejects client supplied %s on create', async (field) => {
    await post({ ...body, [field]: 'untrusted' }).expect(400);
    expect(order.create).not.toHaveBeenCalled();
  });

  it.each([
    { productId: 'invalid' },
    { productId: null },
    { paymentType: 'BANK_TRANSFER' },
    { paymentType: null },
    { customerNotes: 12 },
  ])('validates create %j', async (invalid) => {
    await post({ ...body, ...invalid }).expect(400);
  });

  it('retries unique collisions and gives a clean error if retries are exhausted', async () => {
    order.create
      .mockRejectedValueOnce(dbError('P2002'))
      .mockResolvedValueOnce(record);
    await post(body).expect(201);
    expect(order.create).toHaveBeenCalledTimes(2);
    order.create.mockReset().mockRejectedValue(dbError('P2002'));
    await post(body).expect(409);
    expect(order.create).toHaveBeenCalledTimes(5);
  });

  it('scopes both customer lists and counts to the authenticated user', async () => {
    const response = await get('?page=2&limit=10&status=ORDERED').expect(200);
    expect(response.body.meta).toEqual({
      page: 2,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
    expect(order.findMany.mock.calls[0][0]).toMatchObject({
      where: { userId, status: 'ORDERED' },
      skip: 10,
      take: 10,
      select: { adminNotes: false },
    });
    expect(order.count.mock.calls[0][0].where).toEqual(
      order.findMany.mock.calls[0][0].where,
    );
    await get('?userId=' + otherId).expect(403);
  });

  it('queries customer details with ownership and excludes internal notes', async () => {
    await get('/' + id).expect(200);
    expect(order.findUnique.mock.calls[0][0]).toMatchObject({
      where: { id, userId },
      select: { adminNotes: false },
    });
    order.findUnique.mockResolvedValue(null);
    await get('/' + id).expect(404);
  });

  it('supports all admin filters, pagination, and full details', async () => {
    admin();
    await get(
      '?status=CREATING&paymentStatus=PAID&paymentType=CARD&userId=' +
        otherId +
        '&orderNumber=HM-2026&page=3&limit=5',
    ).expect(200);
    expect(order.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        userId: otherId,
        status: 'CREATING',
        paymentStatus: 'PAID',
        paymentType: 'CARD',
        orderNumber: { contains: 'HM-2026', mode: 'insensitive' },
      },
      skip: 10,
      take: 5,
      select: { adminNotes: true },
    });
    await get('/' + id).expect(200);
    expect(order.findUnique.mock.calls[0][0].where).toEqual({ id });
    expect(order.findUnique.mock.calls[0][0].select.adminNotes).toBe(true);
  });

  it.each([
    'page=0',
    'page=1.5',
    'limit=101',
    'limit=0',
    'status=INVALID',
    'paymentStatus=INVALID',
    'paymentType=INVALID',
    'userId=bad',
    'orderNumber=',
    'unknown=1',
  ])('validates query %s', async (query) => {
    await get('?' + query).expect(400);
    expect(order.findMany).not.toHaveBeenCalled();
  });

  it('rejects all customer management operations', async () => {
    await patch('', { adminNotes: 'No' }).expect(403);
    await patch('', { finalImageUrl: 'image-key' }).expect(403);
    await patch('/status', { status: 'CREATING' }).expect(403);
    await patch('/payment-status', { paymentStatus: 'PAID' }).expect(403);
    await remove().expect(403);
    expect(order.update).not.toHaveBeenCalled();
    expect(order.delete).not.toHaveBeenCalled();
  });

  it('allows admins to set/clear notes and final image strings', async () => {
    admin();
    await patch('', {
      adminNotes: 'Make carefully',
      finalImageUrl: 'future/s3/key',
    }).expect(200);
    expect(order.update.mock.calls[0][0].data).toEqual({
      adminNotes: 'Make carefully',
      finalImageUrl: 'future/s3/key',
    });
    await patch('', { adminNotes: null, finalImageUrl: null }).expect(200);
  });

  it.each([
    'userId',
    'productId',
    'totalPrice',
    'status',
    'paymentStatus',
    'orderNumber',
    'customerNotes',
  ])('prevents generic PATCH from changing %s', async (field) => {
    admin();
    await patch('', { [field]: 'untrusted' }).expect(400);
    expect(order.update).not.toHaveBeenCalled();
  });

  it.each(
    workflow.slice(0, -1).map((status, index) => [status, workflow[index + 1]]),
  )(
    'allows transition %s to %s using a conditional write',
    async (from, to) => {
      admin();
      order.findUnique.mockResolvedValue({ ...record, status: from });
      await patch('/status', { status: to }).expect(200);
      expect(order.update.mock.calls[0][0]).toMatchObject({
        where: { id, status: from },
        data: { status: to },
      });
    },
  );

  it.each([
    ['ORDERED', 'CREATED'],
    ['CREATED', 'CREATING'],
    ['CREATING', 'CREATING'],
    ['COMPLETED', 'ORDERED'],
    ['COMPLETED', 'COMPLETED'],
  ])('rejects transition %s to %s', async (from, to) => {
    admin();
    order.findUnique.mockResolvedValue({ ...record, status: from });
    await patch('/status', { status: to }).expect(400);
    expect(order.update).not.toHaveBeenCalled();
  });

  it('reports a conflict when a concurrent transition wins', async () => {
    admin();
    order.update.mockRejectedValue(dbError('P2025'));
    await patch('/status', { status: 'CREATING' }).expect(409);
  });

  it.each(['UNPAID', 'PAID', 'FAILED', 'REFUNDED'])(
    'allows admin payment status %s',
    async (paymentStatus) => {
      admin();
      await patch('/payment-status', { paymentStatus }).expect(200);
      expect(order.update.mock.calls[0][0].data).toEqual({ paymentStatus });
    },
  );

  it('validates statuses and optional string fields', async () => {
    admin();
    await patch('/status', { status: 'CANCELLED' }).expect(400);
    await patch('/status', {}).expect(400);
    await patch('/payment-status', { paymentStatus: 'OTHER' }).expect(400);
    await patch('/payment-status', { paymentStatus: null }).expect(400);
    await patch('', { finalImageUrl: 123 }).expect(400);
    await patch('', { adminNotes: 123 }).expect(400);
  });

  it('deletes only for admins and returns no content', async () => {
    admin();
    expect((await remove().expect(204)).text).toBe('');
    expect(order.delete).toHaveBeenCalledWith({
      where: { id },
      select: { id: true },
    });
  });

  it('validates UUIDs on all ID routes', async () => {
    admin();
    await get('/invalid').expect(400);
    for (const suffix of ['', '/status', '/payment-status'])
      await request(app.getHttpServer())
        .patch(base + '/invalid' + suffix)
        .set('Authorization', 'Bearer ' + token)
        .send({})
        .expect(400);
    await request(app.getHttpServer())
      .delete(base + '/invalid')
      .set('Authorization', 'Bearer ' + token)
      .expect(400);
    expect(order.findUnique).not.toHaveBeenCalled();
    expect(order.update).not.toHaveBeenCalled();
  });

  it('handles missing orders on every operation', async () => {
    admin();
    order.findUnique.mockResolvedValue(null);
    order.update.mockRejectedValue(dbError('P2025'));
    order.delete.mockRejectedValue(dbError('P2025'));
    await get('/' + id).expect(404);
    await patch('', { adminNotes: 'Missing' }).expect(404);
    await patch('/status', { status: 'CREATING' }).expect(404);
    await patch('/payment-status', { paymentStatus: 'PAID' }).expect(404);
    await remove().expect(404);
  });

  it.each([
    ['P2003', 409],
    ['P1001', 500],
  ] as const)('sanitizes create Prisma error %s', async (code, status) => {
    order.create.mockRejectedValue(dbError(code));
    const response = await post(body).expect(status);
    expect(response.text).not.toContain('Private SQL');
  });
});
