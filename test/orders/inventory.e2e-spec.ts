import { CategoriesService } from '../../src/modules/categories/categories.service.js';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../src/storage/storage.service.js';
import { ImageWriteService } from '../../src/storage/image-write.service.js';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { BadRequestException } from '@nestjs/common';
import {
  PrismaClient,
  type OrderStatus,
} from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ProductsService } from '../../src/modules/products/products.service.js';
import { OrdersService } from '../../src/modules/orders/orders.service.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';

// Opt in because these tests require PostgreSQL. Every write is in a disposable,
// randomly named schema; existing application tables and records are never changed.
describe.skipIf(process.env.RUN_INVENTORY_DB_TESTS !== '1')(
  'PostgreSQL inventory transactions',
  () => {
    const schema = 'inventory_test_' + randomUUID().replaceAll('-', '');
    let db: PrismaClient;
    let bootstrap: PrismaClient;
    let products: ProductsService;
    let orders: OrdersService;
    let customer: AuthenticatedUser;
    let admin: AuthenticatedUser;
    let categoryId: string;
    const firstId = 'a1000000-0000-4000-8000-000000000001';
    const secondId = 'b1000000-0000-4000-8000-000000000002';
    let schemaCreated = false;

    beforeAll(async () => {
      if (!/^inventory_test_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe test schema name');
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString)
        throw new Error(
          'DATABASE_URL is required for inventory integration tests',
        );
      bootstrap = new PrismaClient({
        adapter: new PrismaPg({ connectionString }),
      });
      await bootstrap.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
      schemaCreated = true;
      const config = { connectionString, options: '-c search_path=' + schema };
      const migrationAdapter = await new PrismaPg(config, { schema }).connect();
      try {
        const root = new URL('../../prisma/migrations/', import.meta.url);
        const names = (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
        for (const name of names)
          await migrationAdapter.executeScript(
            await readFile(new URL(name + '/migration.sql', root), 'utf8'),
          );
      } finally {
        await migrationAdapter.dispose();
      }
      db = new PrismaClient({ adapter: new PrismaPg(config, { schema }) });
      products = new ProductsService(
        db as unknown as PrismaService,
        new ImageWriteService(new StorageService(new ConfigService())),
      );
      const orderStorage = new StorageService(new ConfigService());
      vi.spyOn(orderStorage, 'copy').mockImplementation(
        async (key, folder) => ({
          key: folder + '/' + randomUUID() + key.slice(key.lastIndexOf('.')),
        }),
      );
      vi.spyOn(orderStorage, 'delete').mockResolvedValue();
      orders = new OrdersService(
        db as unknown as PrismaService,
        orderStorage,
        new ImageWriteService(orderStorage),
      );
    }, 30000);

    beforeEach(async () => {
      await db.order.deleteMany();
      await db.product.deleteMany();
      await db.subCategory.deleteMany();
      await db.category.deleteMany();
      await db.user.deleteMany();
      customer = await db.user.create({
        data: {
          firstName: 'Inventory',
          lastName: 'Test',
          email: 'inventory@example.test',
          passwordHash: 'never-expose-this',
          phone: '12345',
          country: 'Test',
          address: 'Test Street',
          postalCode: '12345',
        },
      });
      admin = { ...customer, role: 'ADMIN' };
      categoryId = (
        await db.category.create({ data: { name: 'Test category' } })
      ).id;
      await db.subCategory.createMany({
        data: [
          {
            id: firstId,
            categoryId,
            name: 'Gold bead',
            color: 'gold',
            type: 'glass',
            imageKey: 'subcategories/gold.png',
            price: 150,
            stock: 10,
          },
          {
            id: secondId,
            categoryId,
            name: 'Red bead',
            color: 'red',
            type: 'wood',
            price: 200,
            stock: 5,
          },
        ],
      });
    });

    afterAll(async () => {
      await db?.$disconnect();
      if (schemaCreated && /^inventory_test_[a-f0-9]{32}$/.test(schema))
        await bootstrap.$executeRawUnsafe(
          'DROP SCHEMA "' + schema + '" CASCADE',
        );
      await bootstrap?.$disconnect();
    });

    const design = (
      items = [
        { subCategoryId: firstId, quantity: 2 },
        { subCategoryId: secondId, quantity: 3 },
      ],
    ) => products.create({ categoryId, name: 'Bracelet', items }, customer);
    const stock = async (id: string) =>
      (await db.subCategory.findUniqueOrThrow({ where: { id } })).stock;
    const place = (productId: string, customerNotes?: string) =>
      orders.create(
        { productId, paymentType: 'CASH_ON_DELIVERY', customerNotes },
        customer,
      );

    it('calculates and snapshots components without reserving stock when saving a design', async () => {
      const product = await design();
      expect(product).toMatchObject({ price: 900, itemCount: 5 });
      expect(
        product.items.map((item) => item.unitPrice).sort((a, b) => a - b),
      ).toEqual([150, 200]);
      expect(await stock(firstId)).toBe(10);
      expect(await stock(secondId)).toBe(5);
      await db.subCategory.update({
        where: { id: firstId },
        data: { price: 175 },
      });
      const updated = await products.update(
        product.id,
        { items: [{ subCategoryId: firstId, quantity: 4, position: 1 }] },
        admin,
      );
      expect(updated).toMatchObject({ price: 700, itemCount: 4 });
      expect(updated.items).toHaveLength(1);
      expect(updated.items[0]).toMatchObject({
        unitPrice: 175,
        quantity: 4,
        position: 1,
      });
      expect(await stock(firstId)).toBe(10);
      expect(await stock(secondId)).toBe(5);
    });

    it('allows saved designs exceeding stock, then rejects ordering without side effects', async () => {
      const product = await design([{ subCategoryId: firstId, quantity: 11 }]);
      await expect(place(product.id)).rejects.toMatchObject({
        response: {
          subCategoryId: firstId,
          subCategoryName: 'Gold bead',
          requestedQuantity: 11,
          availableQuantity: 10,
        },
      });
      expect(await stock(firstId)).toBe(10);
      expect(await db.order.count()).toBe(0);
    });

    it('creates an order, decrements each component and returns detailed safe relations', async () => {
      const product = await design();
      await db.subCategory.update({
        where: { id: firstId },
        data: { price: 999 },
      });
      const order = await place(product.id);
      expect(order.totalPrice).toBe(900);
      expect(await stock(firstId)).toBe(8);
      expect(await stock(secondId)).toBe(2);
      expect(await db.order.count()).toBe(1);
      expect(order).not.toHaveProperty('adminNotes');
      expect(order.user).not.toHaveProperty('passwordHash');
      const details = await orders.findOne(order.id, admin);
      expect(details.product.items).toHaveLength(2);
      expect(
        details.product.items.find((item) => item.subCategoryId === firstId),
      ).toMatchObject({
        quantity: 2,
        unitPrice: 150,
        subCategory: {
          name: 'Gold bead',
          color: 'gold',
          type: 'glass',
          imageKey: expect.stringMatching(/^orders\//),
          price: 999,
        },
      });
    });

    it('deducts the requested 12 and 8 beads from stocks of 30 and 40', async () => {
      await db.subCategory.update({
        where: { id: firstId },
        data: { stock: 30 },
      });
      await db.subCategory.update({
        where: { id: secondId },
        data: { stock: 40 },
      });
      const product = await design([
        { subCategoryId: firstId, quantity: 12 },
        { subCategoryId: secondId, quantity: 8 },
      ]);
      await place(product.id);
      expect(await stock(firstId)).toBe(18);
      expect(await stock(secondId)).toBe(32);
    });

    it('does not deduct stock again through any workflow status', async () => {
      const product = await design();
      const order = await place(product.id);
      const statuses: OrderStatus[] = [
        'CREATING',
        'CREATED',
        'READY_FOR_COURIER',
        'PICKED_UP_BY_COURIER',
        'COMPLETED',
      ];
      for (const status of statuses) {
        await orders.updateStatus(order.id, { status }, admin);
        expect(await stock(firstId)).toBe(8);
        expect(await stock(secondId)).toBe(2);
      }
    });

    it('does not deduct stock again when payment becomes PAID, including repeated updates', async () => {
      const product = await design();
      const order = await place(product.id);
      await orders.updatePaymentStatus(
        order.id,
        { paymentStatus: 'PAID' },
        admin,
      );
      await orders.updatePaymentStatus(
        order.id,
        { paymentStatus: 'PAID' },
        admin,
      );
      expect(await stock(firstId)).toBe(8);
      expect(await stock(secondId)).toBe(2);
      expect(await db.order.count()).toBe(1);
    });

    it('calculates authoritative price from items even when the cached product total is stale', async () => {
      const product = await design();
      await db.product.update({
        where: { id: product.id },
        data: { price: 1 },
      });
      expect((await place(product.id)).totalPrice).toBe(900);
    });

    it('rolls back the inserted order and prior decrements when a conditional update fails after preflight', async () => {
      const product = await design();
      // Force inventory to change AFTER preflight to exercise the conditional-write failure branch.
      // The trigger and all fixture writes live only in this disposable test schema.
      await db.$executeRawUnsafe(`CREATE FUNCTION inventory_race() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE sub_categories SET stock = 0 WHERE id = '${secondId}';
          RETURN NEW;
        END $$`);
      await db.$executeRawUnsafe(
        'CREATE TRIGGER inventory_race AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION inventory_race()',
      );
      try {
        await expect(place(product.id)).rejects.toMatchObject({
          response: {
            statusCode: 400,
            subCategoryId: secondId,
            requestedQuantity: 3,
            availableQuantity: 0,
          },
        });
        expect(await db.order.count()).toBe(0);
        expect(await stock(firstId)).toBe(10);
        expect(await stock(secondId)).toBe(5);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER inventory_race ON orders');
        await db.$executeRawUnsafe('DROP FUNCTION inventory_race()');
      }
    });

    it('aggregates repeated component rows before checking inventory', async () => {
      const product = await design([
        { subCategoryId: firstId, quantity: 6 },
        { subCategoryId: firstId, quantity: 5 },
      ]);
      await expect(place(product.id)).rejects.toMatchObject({
        response: { requestedQuantity: 11, availableQuantity: 10 },
      });
      expect(await stock(firstId)).toBe(10);
      expect(await db.order.count()).toBe(0);
      const valid = await design([
        { subCategoryId: firstId, quantity: 3 },
        { subCategoryId: firstId, quantity: 2 },
      ]);
      await place(valid.id);
      expect(await stock(firstId)).toBe(5);
    });

    it('rejects insufficient inventory before creation and leaves all stocks unchanged', async () => {
      const product = await design([
        { subCategoryId: firstId, quantity: 2 },
        { subCategoryId: secondId, quantity: 6 },
      ]);
      await expect(place(product.id)).rejects.toMatchObject({
        response: {
          subCategoryId: secondId,
          requestedQuantity: 6,
          availableQuantity: 5,
        },
      });
      expect(await stock(firstId)).toBe(10);
      expect(await stock(secondId)).toBe(5);
      expect(await db.order.count()).toBe(0);
    });

    it('rolls back all inventory if inserting the order fails', async () => {
      const product = await design();
      await db.$executeRawUnsafe(
        "ALTER TABLE orders ADD CONSTRAINT inventory_test_failure CHECK (customer_notes IS DISTINCT FROM '__force_failure__')",
      );
      try {
        await expect(place(product.id, '__force_failure__')).rejects.toThrow(
          'Unable to complete order operation',
        );
        expect(await stock(firstId)).toBe(10);
        expect(await stock(secondId)).toBe(5);
        expect(await db.order.count()).toBe(0);
      } finally {
        await db.$executeRawUnsafe(
          'ALTER TABLE orders DROP CONSTRAINT inventory_test_failure',
        );
      }
    });

    it('prevents concurrent orders for different designs from overselling shared stock', async () => {
      const first = await design([{ subCategoryId: firstId, quantity: 7 }]);
      const second = await design([{ subCategoryId: firstId, quantity: 7 }]);
      const results = await Promise.allSettled([
        place(first.id),
        place(second.id),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
        BadRequestException,
      );
      if (rejected?.status === 'rejected')
        expect(rejected.reason.getResponse()).toMatchObject({
          requestedQuantity: 7,
          availableQuantity: 3,
        });
      expect(await stock(firstId)).toBe(3);
      expect(await db.order.count()).toBe(1);
    });

    it('prevents concurrent orders for the same design from overselling stock', async () => {
      const product = await design([{ subCategoryId: firstId, quantity: 7 }]);
      const results = await Promise.allSettled([
        place(product.id),
        place(product.id),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await stock(firstId)).toBe(3);
      expect(await db.order.count()).toBe(1);
    });

    it('preserves ordered quantities and price snapshots against later design edits', async () => {
      const product = await design();
      await place(product.id);
      await expect(
        products.update(
          product.id,
          { items: [{ subCategoryId: firstId, quantity: 1 }] },
          admin,
        ),
      ).rejects.toThrow('Ordered product components cannot be changed');
      await db.subCategory.update({
        where: { id: firstId },
        data: { price: 999 },
      });
      const updated = await products.update(
        product.id,
        { name: 'New label' },
        admin,
      );
      expect(updated.price).toBe(900);
      expect(
        updated.items.find((item) => item.subCategoryId === firstId)?.unitPrice,
      ).toBe(150);
    });

    it('category deletion cleans both parent and cascaded component images after commit', async () => {
      const storage = new StorageService(new ConfigService());
      const remove = vi
        .spyOn(storage, 'delete')
        .mockImplementation(async () => {
          expect(
            await db.category.findUnique({ where: { id: categoryId } }),
          ).toBeNull();
          expect(await db.subCategory.count({ where: { categoryId } })).toBe(0);
        });
      const service = new CategoriesService(
        db as unknown as PrismaService,
        new ImageWriteService(storage),
      );
      await db.category.update({
        where: { id: categoryId },
        data: { imageKey: 'categories/parent.png' },
      });
      await db.subCategory.update({
        where: { id: firstId },
        data: { imageKey: 'subcategories/child.png' },
      });
      await service.remove(categoryId);
      expect(remove.mock.calls).toEqual([
        ['categories/parent.png'],
        ['subcategories/child.png'],
      ]);
    });

    it('concurrent category image replacements never delete the winning image', async () => {
      const storage = new StorageService(new ConfigService());
      let uploads = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(storage, 'upload').mockImplementation(async () => {
        const key = 'categories/new-' + ++uploads + '.png';
        if (uploads === 2) release();
        await barrier;
        return { key };
      });
      const remove = vi.spyOn(storage, 'delete').mockResolvedValue();
      const service = new CategoriesService(
        db as unknown as PrismaService,
        new ImageWriteService(storage),
      );
      await db.category.update({
        where: { id: categoryId },
        data: { imageKey: 'categories/old.png' },
      });
      const results = await Promise.allSettled([
        service.update(categoryId, {}, {} as Express.Multer.File),
        service.update(categoryId, {}, {} as Express.Multer.File),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const saved = await db.category.findUniqueOrThrow({
        where: { id: categoryId },
      });
      expect(remove).not.toHaveBeenCalledWith(saved.imageKey);
      expect(remove).toHaveBeenCalledWith('categories/old.png');
      expect(remove).toHaveBeenCalledTimes(2);
    });

    it('image-only updates preserve item IDs, price snapshots and stock even after catalog changes', async () => {
      const storage = new StorageService(new ConfigService());
      vi.spyOn(storage, 'upload').mockResolvedValue({
        key: 'products/new.png',
      });
      vi.spyOn(storage, 'delete').mockResolvedValue();
      const service = new ProductsService(
        db as unknown as PrismaService,
        new ImageWriteService(storage),
      );
      const product = await design();
      const items = await db.productItem.findMany({
        where: { productId: product.id },
        orderBy: { id: 'asc' },
      });
      await db.subCategory.update({
        where: { id: firstId },
        data: { price: 999 },
      });
      const updated = await service.update(
        product.id,
        {},
        admin,
        {} as Express.Multer.File,
      );
      expect(updated.imageKey).toBe('products/new.png');
      expect(updated.price).toBe(product.price);
      expect(updated.itemCount).toBe(product.itemCount);
      expect(
        await db.productItem.findMany({
          where: { productId: product.id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(items);
      expect(await stock(firstId)).toBe(10);
      expect(await stock(secondId)).toBe(5);
    });

    it('stores a design preview alongside ProductItems and exposes it on Order details', async () => {
      const storage = new StorageService(new ConfigService());
      const upload = vi
        .spyOn(storage, 'upload')
        .mockResolvedValueOnce({ key: 'designs/first.png' })
        .mockResolvedValueOnce({ key: 'designs/second.png' });
      const remove = vi.spyOn(storage, 'delete').mockResolvedValue();
      const service = new ProductsService(
        db as unknown as PrismaService,
        new ImageWriteService(storage),
      );
      const product = await service.create(
        {
          categoryId,
          name: 'Bracelet',
          items: [{ subCategoryId: firstId, quantity: 2 }],
        },
        customer,
        undefined,
        {} as Express.Multer.File,
      );
      expect(product.designPreviewKey).toBe('designs/first.png');
      expect(product.imageKey).toBeNull();
      expect(product.price).toBe(300);
      expect(product.itemCount).toBe(2);
      expect(upload).toHaveBeenCalledWith(expect.anything(), 'designs');
      expect(await stock(firstId)).toBe(10);
      const item = await db.productItem.findFirstOrThrow({
        where: { productId: product.id },
      });

      const order = await place(product.id);
      const orderPreviewKey = order.product?.designPreviewKey;
      expect(orderPreviewKey).toMatch(/^orders\//);
      expect(
        (await orders.findOne(order.id, admin)).product?.designPreviewKey,
      ).toBe(orderPreviewKey);
      expect(await stock(firstId)).toBe(8);

      const updated = await service.update(
        product.id,
        {},
        admin,
        undefined,
        {} as Express.Multer.File,
      );
      expect(updated.designPreviewKey).toBe('designs/second.png');
      expect(updated.imageKey).toBeNull();
      expect(updated.price).toBe(product.price);
      expect(updated.itemCount).toBe(product.itemCount);
      expect(
        await db.productItem.findFirstOrThrow({
          where: { productId: product.id },
        }),
      ).toEqual(item);
      expect(await stock(firstId)).toBe(8);
      expect(remove).toHaveBeenCalledWith('designs/first.png');
      expect(
        (await orders.findOne(order.id, admin)).product?.designPreviewKey,
      ).toBe(orderPreviewKey);
    });

    it('keeps Order product/category/component labels and images immutable after catalog edits', async () => {
      const product = await design();
      const order = await place(product.id);
      const before = await orders.findOne(order.id, admin);
      expect(
        before.product.items.find((item) => item.subCategoryId === firstId)
          ?.subCategory.imageKey,
      ).toMatch(/^orders\//);
      await products.update(
        product.id,
        { name: 'Renamed design', description: 'Changed' },
        admin,
      );
      await db.category.update({
        where: { id: categoryId },
        data: { name: 'Renamed category' },
      });
      await db.subCategory.update({
        where: { id: firstId },
        data: {
          name: 'Renamed bead',
          description: 'New description',
          color: 'purple',
          type: 'metal',
          price: 999,
          imageKey: 'subcategories/replacement.png',
        },
      });
      const details = await orders.findOne(order.id, admin);
      expect(details.product).toEqual(before.product);
      expect(details.designSnapshot).toEqual(before.designSnapshot);
      expect(details.totalPrice).toBe(900);
      expect(
        (await orders.updateStatus(order.id, { status: 'CREATING' }, admin))
          .product,
      ).toEqual(before.product);
      expect(
        (
          await orders.updatePaymentStatus(
            order.id,
            { paymentStatus: 'PAID' },
            admin,
          )
        ).product,
      ).toEqual(before.product);
      expect(await stock(firstId)).toBe(8);
      expect(await stock(secondId)).toBe(2);
    });

    it('rolls back order placement and cleans earlier copies when an image copy fails', async () => {
      const product = await design();
      await db.product.update({
        where: { id: product.id },
        data: { designPreviewKey: 'designs/source.png' },
      });
      const storage = new StorageService(new ConfigService());
      vi.spyOn(storage, 'copy')
        .mockResolvedValueOnce({ key: 'orders/test/copied.png' })
        .mockRejectedValueOnce(new BadRequestException('copy unavailable'));
      const remove = vi.spyOn(storage, 'delete').mockResolvedValue();
      const service = new OrdersService(
        db as unknown as PrismaService,
        storage,
        new ImageWriteService(storage),
      );
      await expect(
        service.create(
          { productId: product.id, paymentType: 'CARD' },
          customer,
        ),
      ).rejects.toThrow('copy unavailable');
      expect(remove).toHaveBeenCalledWith('orders/test/copied.png');
      expect(await db.order.count()).toBe(0);
      expect(await stock(firstId)).toBe(10);
      expect(await stock(secondId)).toBe(5);
    });

    it('rejects componentless legacy designs and inactive components', async () => {
      const legacy = await db.product.create({
        data: {
          createdById: customer.id,
          categoryId,
          name: 'Legacy design',
          price: 100,
        },
      });
      await expect(place(legacy.id)).rejects.toThrow(
        'Product has no components',
      );
      const product = await design();
      await db.subCategory.update({
        where: { id: secondId },
        data: { isActive: false },
      });
      await expect(place(product.id)).rejects.toThrow(
        'SubCategory is inactive',
      );
      expect(await stock(firstId)).toBe(10);
      expect(await db.order.count()).toBe(0);
    });

    it('validates active components, categories and integer limits before saving', async () => {
      await db.subCategory.update({
        where: { id: firstId },
        data: { isActive: false },
      });
      await expect(design()).rejects.toThrow('SubCategory is inactive');
      await db.subCategory.update({
        where: { id: firstId },
        data: { isActive: true },
      });
      const anotherCategory = await db.category.create({
        data: { name: 'Another' },
      });
      await expect(
        products.create(
          {
            categoryId: anotherCategory.id,
            name: 'Invalid',
            items: [{ subCategoryId: firstId, quantity: 1 }],
          },
          customer,
        ),
      ).rejects.toThrow('does not belong');
      await expect(
        design([{ subCategoryId: firstId, quantity: 2147483647 }]),
      ).rejects.toThrow('integer range');
      await expect(
        design([{ subCategoryId: randomUUID(), quantity: 1 }]),
      ).rejects.toThrow('SubCategory not found');
      expect(await db.product.count()).toBe(0);
    });
  },
);
