import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { OrdersModule } from '../../src/modules/orders/orders.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { setupApp } from '../../src/config/setup-app.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { ORDER_STATUS_COPY } from '../../src/mail/order-status-copy.js';
import {
  fakeTransport,
  testMailConfig,
  withFakeMail,
} from '../mail/fake-mail.js';

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
    basePrice: 0,
    origin: 'CUSTOMER',
    baseProductId: null,
    category: {
      id: otherId,
      builderType: null,
    },
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
  const product = { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() };
  const order = {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const subCategory = { updateMany: vi.fn(), findUnique: vi.fn() };
  const category = { updateMany: vi.fn() };
  const storage = {
    copy: vi.fn(),
    delete: vi.fn(),
    getPublicUrl: (key?: string | null) =>
      key ? 'https://images.example.test/' + key : null,
  };
  const prisma = {
    user,
    product,
    order,
    subCategory,
    category,
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  const mail = fakeTransport();
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
    const module = await withFakeMail(
      Test.createTestingModule({ imports: [OrdersModule] }),
      mail,
    )
      .overrideProvider(StorageService)
      .useValue(storage)
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
    storage.copy.mockImplementation(async (key: string, folder: string) => ({
      key: folder + '/' + key.replaceAll('/', '-'),
    }));
    storage.delete.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(
      (operation: (tx: typeof prisma) => Promise<unknown>) => operation(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([]);
    subCategory.updateMany.mockResolvedValue({ count: 1 });
    category.updateMany.mockResolvedValue({ count: 1 });
    product.update.mockImplementation(async ({ data }) => data);
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

  /** Serves each product by id, as the ordered product, its base and the size re-read. */
  const products = (...records: ({ id: string } & Record<string, unknown>)[]) =>
    product.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        records.find((entry) => entry.id === where.id) ?? null,
    );

  it("orders another admin's company product at the admin price without consuming components", async () => {
    product.findUnique.mockResolvedValue({
      ...productRecord,
      createdById: otherId,
      createdBy: { role: 'ADMIN' },
      origin: 'COMPANY',
      isActive: true,
      stock: 2,
      price: 4500,
    });
    product.updateMany.mockResolvedValue({ count: 1 });
    await post(body).expect(201);
    expect(product.updateMany).toHaveBeenCalledWith({
      where: {
        id: productId,
        origin: 'COMPANY',
        isActive: true,
        stock: { gte: 1 },
      },
      data: { stock: { decrement: 1 } },
    });
    expect(subCategory.updateMany).not.toHaveBeenCalled();
    expect(order.create.mock.calls[0][0].data).toMatchObject({
      totalPrice: 4500,
      designSnapshot: {
        version: 2,
        product: { origin: 'COMPANY', price: 4500 },
      },
    });
  });

  describe('sticker quantities', () => {
    const stickerCategory = {
      ...productRecord.category,
      builderType: 'STICKER',
    };
    const readyMade = {
      ...productRecord,
      createdById: otherId,
      createdBy: { role: 'ADMIN' },
      origin: 'COMPANY',
      isActive: true,
      stock: 9,
      price: 100,
      items: [],
      category: stickerCategory,
    };

    it('orders a ready-made sticker in a quantity of at least five', async () => {
      product.findUnique.mockResolvedValue(readyMade);
      product.updateMany.mockResolvedValue({ count: 1 });
      await post({ ...body, quantity: 6 }).expect(201);
      expect(product.updateMany).toHaveBeenCalledWith({
        where: {
          id: productId,
          origin: 'COMPANY',
          isActive: true,
          stock: { gte: 6 },
        },
        data: { stock: { decrement: 6 } },
      });
      expect(order.create.mock.calls[0][0].data).toMatchObject({
        quantity: 6,
        totalPrice: 600,
      });
    });

    it('defaults a ready-made sticker to five and rejects fewer or too many', async () => {
      product.findUnique.mockResolvedValue(readyMade);
      product.updateMany.mockResolvedValue({ count: 1 });
      await post(body).expect(201);
      expect(order.create.mock.calls[0][0].data).toMatchObject({
        quantity: 5,
        totalPrice: 500,
      });
      await post({ ...body, quantity: 4 }).expect(400);
      await post({ ...body, quantity: 1001 }).expect(400);
      expect(order.create).toHaveBeenCalledTimes(1);
    });

    it('keeps every other product at one per order', async () => {
      product.findUnique.mockResolvedValue({
        ...readyMade,
        category: productRecord.category,
      });
      product.updateMany.mockResolvedValue({ count: 1 });
      await post({ ...body, quantity: 2 }).expect(400);
      expect(order.create).not.toHaveBeenCalled();
    });

    it('needs at least five stickers in a studio set', async () => {
      const set = (quantities: number[]) => ({
        ...productRecord,
        category: stickerCategory,
        items: quantities.map((quantity, index) => ({
          ...productRecord.items[0],
          id: 'item-' + index,
          quantity,
          position: index,
          unitPrice: 100,
          subCategory: {
            id: productRecord.items[0].subCategoryId,
            name: 'Your own artwork',
            stock: 0,
            trackStock: false,
            isActive: true,
          },
        })),
      });
      product.findUnique.mockResolvedValue(set([1, 1, 1, 1]));
      await post(body).expect(400);
      expect(order.create).not.toHaveBeenCalled();
      product.findUnique.mockResolvedValue(set([2, 1, 1, 1]));
      await post(body).expect(201);
      expect(order.create.mock.calls[0][0].data).toMatchObject({
        quantity: 1,
        totalPrice: 500,
      });
    });
  });

  const baseId = 'c7d1f0a4-2a71-46c6-bfba-a453d847044f';
  const printAreas = {
    front: {
      x: 0.3,
      y: 0.28,
      width: 0.4,
      height: 0.42,
      widthCm: 30,
      heightCm: 40,
    },
  };
  // Black Essential Hoodie: one colour, one price, stock per size.
  const hoodie = (overrides: object = {}) => ({
    ...productRecord,
    id: baseId,
    name: 'Black Essential Hoodie',
    origin: 'COMPANY',
    createdById: otherId,
    createdBy: { role: 'ADMIN' },
    isActive: true,
    price: 3500,
    stock: 0,
    color: 'Black',
    colorHex: '#111111',
    imageKey: 'products/black-hoodie.png',
    backImageKey: null,
    printAreas,
    sizes: [
      { size: 'L', stock: 35 },
      { size: 'XL', stock: 0 },
    ],
    items: [],
    category: { ...productRecord.category, builderType: 'APPAREL' },
    ...overrides,
  });
  // A customer's design printed on the hoodie, in size L.
  const design = (overrides: object = {}) => ({
    ...productRecord,
    basePrice: 3500,
    baseProductId: baseId,
    selectedSize: { id: 'L', name: 'L' },
    category: { ...productRecord.category, builderType: 'APPAREL' },
    ...overrides,
  });
  const sizesWritten = () =>
    product.update.mock.calls.map(([call]) => call.data.sizes);

  it('orders a sized company product in the chosen size, decrementing only that size', async () => {
    products(hoodie({ id: productId }));
    await post({ ...body, size: 'L' }).expect(201);
    expect(sizesWritten()).toEqual([
      [
        { size: 'L', stock: 34 },
        { size: 'XL', stock: 0 },
      ],
    ]);
    expect(product.updateMany).not.toHaveBeenCalled();
    expect(order.create.mock.calls[0][0].data).toMatchObject({
      totalPrice: 3500,
      designSnapshot: {
        product: {
          origin: 'COMPANY',
          selectedSize: { id: 'L', name: 'L' },
          color: 'Black',
        },
      },
    });
  });

  it.each([
    [undefined, 'Choose a size of Black Essential Hoodie'],
    ['XL', 'Black Essential Hoodie in size XL is sold out'],
    ['XXL', 'Black Essential Hoodie is no longer available in size XXL'],
  ])(
    'rejects a company size %s that cannot be bought',
    async (size, message) => {
      products(hoodie({ id: productId }));
      const response = await post({
        ...body,
        ...(size ? { size } : {}),
      }).expect(400);
      expect(response.body.message).toBe(message);
      expect(order.create).not.toHaveBeenCalled();
      expect(product.update).not.toHaveBeenCalled();
    },
  );

  it('rejects a size for unsized products and for designs', async () => {
    products({
      ...productRecord,
      origin: 'COMPANY',
      createdBy: { role: 'ADMIN' },
      isActive: true,
      stock: 3,
    });
    await post({ ...body, size: 'L' }).expect(400);
    products(design(), hoodie());
    await post({ ...body, size: 'L' }).expect(400);
    expect(order.create).not.toHaveBeenCalled();
  });

  it('orders a design on its base product: base size and component stock, base price included', async () => {
    products(design(), hoodie());
    await post(body).expect(201);
    // The design and its base are both row-locked, like ordering the base directly.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(sizesWritten()).toEqual([
      [
        { size: 'L', stock: 34 },
        { size: 'XL', stock: 0 },
      ],
    ]);
    expect(subCategory.updateMany).toHaveBeenCalledTimes(1);
    expect(category.updateMany).not.toHaveBeenCalled();
    const { data } = order.create.mock.calls[0][0];
    expect(data.totalPrice).toBe(3500 + 2999);
    expect(data.designSnapshot.product).toMatchObject({
      origin: 'CUSTOMER',
      selectedSize: { id: 'L', name: 'L' },
      basePrice: 3500,
      // Production needs the canvas and print area as they were when the order was placed.
      baseProduct: {
        id: baseId,
        name: 'Black Essential Hoodie',
        color: 'Black',
        printAreas,
        imageKey: 'orders/' + data.id + '/products-black-hoodie.png',
      },
    });
  });

  it('orders an unsized base product by its own stock', async () => {
    products(design({ selectedSize: null }), hoodie({ sizes: null, stock: 4 }));
    product.updateMany.mockResolvedValue({ count: 1 });
    await post(body).expect(201);
    expect(product.updateMany).toHaveBeenCalledWith({
      where: { id: baseId, isActive: true, stock: { gte: 1 } },
      data: { stock: { decrement: 1 } },
    });
    expect(product.update).not.toHaveBeenCalled();
  });

  it('rejects a design whose base size sold out', async () => {
    products(design({ selectedSize: { id: 'XL', name: 'XL' } }), hoodie());
    const response = await post(body).expect(400);
    expect(response.body.message).toBe(
      'Black Essential Hoodie in size XL is sold out',
    );
    expect(product.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      { baseProductId: null },
      {},
      'Choose the piece to design on before ordering this design',
    ],
    [{}, { isActive: false }, 'Black Essential Hoodie is no longer available'],
    [
      { selectedSize: null },
      {},
      'Choose a size of Black Essential Hoodie before ordering this design',
    ],
  ])(
    'rejects a design without an available base %j %j',
    async (designFields, baseFields, message) => {
      products(design(designFields), hoodie(baseFields));
      const response = await post(body).expect(400);
      expect(response.body.message).toBe(message);
      expect(order.create).not.toHaveBeenCalled();
      expect(product.update).not.toHaveBeenCalled();
    },
  );

  it('never decrements unlimited printed designs', async () => {
    products(
      design({
        items: productRecord.items.map((item) => ({
          ...item,
          side: 'FRONT',
          x: 0.5,
          y: 0.4,
          scale: 1.2,
          rotation: 15,
          subCategory: { ...item.subCategory, stock: 0, trackStock: false },
        })),
      }),
      hoodie(),
    );
    await post(body).expect(201);
    expect(subCategory.updateMany).not.toHaveBeenCalled();
    expect(
      order.create.mock.calls[0][0].data.designSnapshot.product.items[0],
    ).toMatchObject({
      side: 'FRONT',
      x: 0.5,
      y: 0.4,
      scale: 1.2,
      rotation: 15,
    });
  });

  it.each([
    { isActive: false, createdBy: { role: 'ADMIN' }, count: 1 },
    { isActive: true, createdBy: { role: 'CUSTOMER' }, count: 1 },
    { isActive: true, createdBy: { role: 'ADMIN' }, count: 0 },
  ])(
    'rejects unavailable company products %j',
    async ({ count, ...fields }) => {
      product.findUnique.mockResolvedValue({
        ...productRecord,
        origin: 'COMPANY',
        stock: 0,
        ...fields,
      });
      product.updateMany.mockResolvedValue({ count });
      await post(body).expect(400);
      expect(order.create).not.toHaveBeenCalled();
      expect(subCategory.updateMany).not.toHaveBeenCalled();
    },
  );

  it('presents legacy garment snapshots as base product and size', async () => {
    order.findUnique.mockResolvedValue({
      ...record,
      designSnapshot: {
        version: 1,
        product: {
          productType: 'CUSTOM_DESIGN',
          selectedOptions: {},
          garmentVariant: {
            size: 'XXL',
            colorName: 'Red',
            colorValue: '#FF0000',
            garment: {
              id: otherId,
              name: 'Hoodie',
              frontImageKey: 'orders/x/front.png',
              frontPrintArea: printAreas.front,
            },
          },
        },
      },
    });
    const response = await get('/' + id).expect(200);
    expect(response.body.product).toEqual({
      origin: 'CUSTOMER',
      selectedSize: { id: 'XXL', name: 'XXL' },
      baseProduct: {
        id: otherId,
        name: 'Hoodie',
        color: 'Red',
        colorHex: '#FF0000',
        imageKey: 'orders/x/front.png',
        imageUrl: 'https://images.example.test/orders/x/front.png',
        backImageKey: null,
        backImageUrl: null,
        printAreas: { front: printAreas.front },
      },
    });
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

        imageKey: true,
        originalImageKey: true,
        color: true,
        type: true,
        price: true,
        effectiveLengthMm: true,
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
    'designSnapshot',
    'designPreviewKey',
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

  it('returns the five newest completed orders requested by the frontend', async () => {
    const response = await get('?status=COMPLETED&page=1&limit=5').expect(200);
    expect(response.body.meta).toEqual({
      page: 1,
      limit: 5,
      total: 1,
      totalPages: 1,
    });
    expect(order.findMany.mock.calls[0][0]).toMatchObject({
      where: { userId, status: 'COMPLETED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: 0,
      take: 5,
    });
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
        '&orderNumber=HM-2026&page=3&limit=5&categoryId=' +
        otherId +
        '&origin=CUSTOMER&productId=' +
        productId,
    ).expect(200);
    expect(order.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        userId: otherId,
        status: 'CREATING',
        paymentStatus: 'PAID',
        paymentType: 'CARD',
        orderNumber: { contains: 'HM-2026', mode: 'insensitive' },
        product: { categoryId: otherId, origin: 'CUSTOMER' },
        // A company product's orders include the designs made on it.
        OR: [{ productId }, { product: { baseProductId: productId } }],
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
    'categoryId=bad',
    'productId=bad',
    'origin=READY_MADE',
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
      // Only completion is timestamped; it orders the community gallery.
      if (to === 'COMPLETED')
        expect(order.update.mock.calls[0][0].data.completedAt).toBeInstanceOf(
          Date,
        );
      else
        expect(order.update.mock.calls[0][0].data).not.toHaveProperty(
          'completedAt',
        );
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
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  describe('status emails', () => {
    const customer = {
      ...account,
      email: 'kate@example.com',
      firstName: 'Kate',
    };
    const saved = (status: string) => ({
      ...record,
      status,
      user: customer,
      product: { id: productId, name: 'My Hoodie' },
    });

    it('emails the order’s own customer when the status changes', async () => {
      admin();
      order.update.mockResolvedValue(saved('READY_FOR_COURIER'));
      order.findUnique.mockResolvedValue({ ...record, status: 'CREATED' });
      // A recipient in the request is not even accepted.
      await patch('/status', {
        status: 'READY_FOR_COURIER',
        email: 'attacker@example.com',
      }).expect(400);
      expect(mail.sendMail).not.toHaveBeenCalled();
      await patch('/status', { status: 'READY_FOR_COURIER' }).expect(200);
      expect(mail.sendMail).toHaveBeenCalledTimes(1);
      const message = mail.sendMail.mock.calls[0][0];
      expect(message.to).toBe('kate@example.com');
      expect(message.from).toEqual({
        name: 'HomeMade Creator',
        address: testMailConfig.from.address,
      });
      expect(message.subject).toBe(
        'Your order HM-2026-000000123 is ready for the courier',
      );
      for (const content of [message.html, message.text]) {
        expect(content).toContain('Hi Kate,');
        expect(content).toContain('HM-2026-000000123');
        expect(content).toContain('My Hoodie');
        expect(content).toContain('Ready for the courier');
        expect(content).toContain('€29.99');
        expect(content).not.toContain('READY_FOR_COURIER');
        // Internal data never reaches the customer.
        for (const internal of [id, userId, productId, 'Internal note'])
          expect(content).not.toContain(internal);
      }
    });

    it('sends nothing when the saved status did not change', async () => {
      admin();
      order.findUnique.mockResolvedValue({ ...record, status: 'ORDERED' });
      // e.g. a concurrent request already saved this status
      order.update.mockResolvedValue(saved('ORDERED'));
      await patch('/status', { status: 'CREATING' }).expect(200);
      expect(mail.sendMail).not.toHaveBeenCalled();
    });

    it('sends nothing for payment, notes or image updates', async () => {
      admin();
      order.update.mockResolvedValue(saved('ORDERED'));
      await patch('/payment-status', { paymentStatus: 'PAID' }).expect(200);
      await patch('', {
        adminNotes: 'Packed',
        finalImageUrl: 'https://images.example.test/final.png',
      }).expect(200);
      expect(mail.sendMail).not.toHaveBeenCalled();
    });

    it('keeps the new status when the email cannot be sent', async () => {
      admin();
      order.update.mockResolvedValue(saved('CREATING'));
      mail.sendMail.mockRejectedValue(
        new Error(
          'Invalid login: 535-5.7.8 Username and Password not accepted',
        ),
      );
      const response = await patch('/status', { status: 'CREATING' }).expect(
        200,
      );
      expect(response.body.status).toBe('CREATING');
      expect(mail.sendMail).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(response.body)).not.toMatch(
        /535|Password not accepted/,
      );
      expect(JSON.stringify(response.body)).not.toContain(
        testMailConfig.password,
      );
    });

    it.each(
      workflow.slice(1).map((status, index) => [workflow[index], status]),
    )('emails once for %s → %s', async (from, to) => {
      admin();
      order.findUnique.mockResolvedValue({ ...record, status: from });
      order.update.mockResolvedValue(saved(to));
      await patch('/status', { status: to }).expect(200);
      expect(mail.sendMail).toHaveBeenCalledTimes(1);
      const message = mail.sendMail.mock.calls[0][0];
      const copy = ORDER_STATUS_COPY[to as keyof typeof ORDER_STATUS_COPY];
      expect(message.to).toBe('kate@example.com');
      expect(message.subject).toBe(copy.subject(record.orderNumber));
      expect(message.text).toContain(copy.message);
      expect(message.text).toContain(copy.label);
    });

    it('sends nothing when the requested status is the current one', async () => {
      admin();
      order.findUnique.mockResolvedValue({ ...record, status: 'CREATING' });
      await patch('/status', { status: 'CREATING' }).expect(400);
      expect(order.update).not.toHaveBeenCalled();
      expect(mail.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('order confirmation email', () => {
    const placed = (email = 'kate@example.com') => ({
      ...record,
      user: { ...account, email, firstName: 'Kate' },
      product: { id: productId, name: 'My Bracelet' },
    });

    it('sends exactly one confirmation to the customer once the order is saved', async () => {
      order.create.mockResolvedValue(placed());
      await post(body).expect(201);
      // One placement, one email: no separate "status changed" email for ORDERED.
      expect(mail.sendMail).toHaveBeenCalledTimes(1);
      const message = mail.sendMail.mock.calls[0][0];
      expect(message.to).toBe('kate@example.com');
      expect(message.subject).toBe('Order HM-2026-000000123 received');
      for (const content of [message.html, message.text]) {
        expect(content).toContain('Hi Kate,');
        expect(content).toContain('Thank you for your order!');
        expect(content).toContain(
          'We’ve received your order HM-2026-000000123 and will start preparing it soon.',
        );
        expect(content).toContain('Order received');
        expect(content).toContain('€29.99');
        expect(content).toContain('My Bracelet');
        expect(content).not.toContain('ORDERED');
        expect(content).not.toContain('Internal note');
      }
      // The order is saved before anything is sent.
      expect(order.create.mock.invocationCallOrder[0]).toBeLessThan(
        mail.sendMail.mock.invocationCallOrder[0],
      );
    });

    it('keeps the order when the confirmation cannot be sent, without leaking SMTP details', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      order.create.mockResolvedValue(placed());
      mail.sendMail.mockRejectedValue(
        new Error(
          'Invalid login: 535-5.7.8 Username and Password not accepted',
        ),
      );
      const response = await post(body).expect(201);
      expect(response.body.orderNumber).toBe(record.orderNumber);
      // Nothing was rolled back or retried because of the email.
      expect(order.create).toHaveBeenCalledTimes(1);
      expect(storage.delete).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toMatch(
        /535|Password not accepted/,
      );
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('Failed to send order created email');
      expect(logged).not.toContain(testMailConfig.password);
      warn.mockRestore();
    });

    it('places the order without email when the customer has no valid address', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      order.create.mockResolvedValue(placed(''));
      await post(body).expect(201);
      expect(mail.sendMail).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.map((call) => String(call[0])).join('\n'),
      ).toContain('email skipped');
      warn.mockRestore();
    });
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
      select: { id: true, designSnapshot: true, designPreviewKey: true },
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

  it('places an Order with its own preview and immutable component metadata', async () => {
    product.findUnique.mockResolvedValue({
      ...productRecord,
      name: 'Original bracelet',
      description: null,
      imageKey: null,
      designPreviewKey: 'designs/preview.png',
      category: {
        id: otherId,
        name: 'Bracelets',
        description: null,
        imageKey: null,
      },
      items: productRecord.items.map((item, index) => ({
        ...item,
        id: otherId + index,
        position: index,
        subCategory: {
          ...item.subCategory,
          categoryId: otherId,
          description: null,
          color: 'gold',
          type: 'glass',
          price: 999,
          imageKey: 'subcategories/bead.png',
        },
      })),
    });
    order.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...record,
        ...data,
        product: { name: 'Live relation must not be used' },
      }),
    );
    const response = await post(body).expect(201);
    expect(response.body.product.name).toBe('Original bracelet');
    expect(response.body.product.items[0]).toMatchObject({
      quantity: 3,
      unitPrice: 999,
      position: 0,
      subCategory: { name: 'Bead', color: 'gold', type: 'glass' },
    });
    expect(response.body.product.items[0].subCategory).not.toHaveProperty(
      'stock',
    );
    expect(response.body.designPreviewKey).toMatch(/^orders\//);
    expect(response.body.product.designPreviewUrl).toBe(
      'https://images.example.test/' + response.body.designPreviewKey,
    );
    expect(storage.copy).toHaveBeenCalledTimes(2);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  const purchasedSize = {
    id: 'medium',
    name: 'Medium',
    measurement: 18,
    unit: 'cm',
    maxItems: 18,
  };
  it('copies the selected product size into the immutable snapshot at placement', async () => {
    product.findUnique.mockResolvedValue({
      ...productRecord,
      selectedSize: purchasedSize,
    });
    order.create.mockImplementation(async ({ data }) => ({
      ...record,
      ...data,
    }));
    const response = await post(body).expect(201);
    expect(product.findUnique.mock.calls[0][0].select.selectedSize).toBe(true);
    expect(
      order.create.mock.calls[0][0].data.designSnapshot.product.selectedSize,
    ).toEqual(purchasedSize);
    expect(response.body.product.selectedSize).toEqual(purchasedSize);
    expect(response.body.totalPrice).toBe(2999);
    expect(subCategory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { stock: { decrement: 4 } } }),
    );
  });
  it.each([true, false])(
    'returns only the saved size in details and lists (recorded: %s)',
    async (recorded) => {
      const saved = {
        ...record,
        designSnapshot: {
          version: 1,
          product: {
            id: productId,
            ...(recorded ? { selectedSize: purchasedSize } : {}),
          },
        },
        product: {
          selectedSize: { ...purchasedSize, name: 'Changed', measurement: 99 },
        },
      };
      order.findUnique.mockResolvedValue(saved);
      order.findMany.mockResolvedValue([saved]);
      order.count.mockResolvedValue(1);
      expect(
        (await get('/' + id).expect(200)).body.product.selectedSize,
      ).toEqual(recorded ? purchasedSize : null);
      expect(
        (await get().expect(200)).body.data[0].product.selectedSize,
      ).toEqual(recorded ? purchasedSize : null);
    },
  );
  it('does not infer a size from the live product for legacy orders without a snapshot', async () => {
    order.findUnique.mockResolvedValue({
      ...record,
      designSnapshot: null,
      product: { id: productId, selectedSize: purchasedSize },
    });
    expect(
      (await get('/' + id).expect(200)).body.product.selectedSize,
    ).toBeNull();
  });

  it('returns the saved Order snapshot even when the live Product changes', async () => {
    const preview = 'orders/' + id + '/preview.png';
    const saved = {
      ...record,
      designPreviewKey: preview,
      designSnapshot: {
        version: 1,
        ownedImageKeys: [preview],
        product: {
          id: productId,
          name: 'Original design',
          designPreviewKey: preview,
          items: [
            {
              quantity: 3,
              unitPrice: 999,
              subCategory: { name: 'Original bead', color: 'gold' },
            },
          ],
        },
      },
      product: {
        id: productId,
        name: 'Changed live Product',
        designPreviewKey: 'designs/new.png',
      },
    };
    order.findUnique.mockResolvedValue(saved);
    const details = await get('/' + id).expect(200);
    expect(details.body.product.name).toBe('Original design');
    expect(details.body.product.designPreviewUrl).toBe(
      'https://images.example.test/' + preview,
    );
    expect(details.body.product.items[0].subCategory.name).toBe(
      'Original bead',
    );
    admin();
    order.update.mockResolvedValue(saved);
    expect(
      (await patch('/status', { status: 'CREATING' }).expect(200)).body.product
        .name,
    ).toBe('Original design');
    expect(
      (await patch('/payment-status', { paymentStatus: 'PAID' }).expect(200))
        .body.product.name,
    ).toBe('Original design');
    expect(storage.copy).not.toHaveBeenCalled();
  });

  it('cleans copied images when order creation fails without deleting sources', async () => {
    product.findUnique.mockResolvedValue({
      ...productRecord,
      designPreviewKey: 'designs/preview.png',
    });
    order.create.mockRejectedValue(dbError('P1001'));
    await post(body).expect(500);
    expect(storage.copy).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^orders\//),
    );
    expect(storage.delete).not.toHaveBeenCalledWith('designs/preview.png');
  });

  it('deletes only Order-owned snapshot images after the Order is deleted', async () => {
    admin();
    const preview = 'orders/' + id + '/preview.png';
    order.delete.mockResolvedValue({
      id,
      designPreviewKey: preview,
      designSnapshot: {
        version: 1,
        product: {},
        ownedImageKeys: [
          preview,
          'orders/' + id + '/bead.png',
          'designs/source.png',
        ],
      },
    });
    await remove().expect(204);
    expect(storage.delete.mock.calls).toEqual([
      [preview],
      ['orders/' + id + '/bead.png'],
    ]);
  });
});
