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
import { fakeOrderNotifications } from '../mail/fake-mail.js';
import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';

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
        fakeOrderNotifications(
          new NotificationsService(db as unknown as PrismaService),
        ),
      );
    }, 30000);

    beforeEach(async () => {
      await db.order.deleteMany();
      await db.product.deleteMany();
      await db.giftPackaging.deleteMany();
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

    it('persists category sizes and product size snapshots without reserving inventory', async () => {
      const size = {
        id: 'medium',
        name: 'Medium',
        measurement: 18,
        unit: 'cm',
        maxItems: 18,
      };
      await db.category.update({
        where: { id: categoryId },
        data: { sizes: [size] },
      });
      const product = await products.create(
        {
          categoryId,
          name: 'Sized bracelet',
          selectedSizeId: 'medium',
          items: [{ subCategoryId: firstId, quantity: 18 }],
        },
        customer,
      );
      expect(product.selectedSize).toEqual(size);
      expect(product.itemCount).toBe(18);
      expect(await stock(firstId)).toBe(10);
      await expect(
        products.create(
          {
            categoryId,
            name: 'Too large',
            selectedSizeId: 'medium',
            items: [{ subCategoryId: firstId, quantity: 20 }],
          },
          customer,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await db.product.count()).toBe(1);
      await db.category.update({
        where: { id: categoryId },
        data: { sizes: [{ ...size, maxItems: 30 }] },
      });
      await products.update(product.id, { name: 'Renamed' }, admin);
      expect((await products.findOne(product.id)).selectedSize).toEqual(size);
      await expect(
        products.update(
          product.id,
          { items: [{ subCategoryId: firstId, quantity: 20 }] },
          admin,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await products.update(
        product.id,
        {
          selectedSizeId: 'medium',
          items: [{ subCategoryId: firstId, quantity: 20 }],
        },
        admin,
      );
      expect((await products.findOne(product.id)).selectedSize).toEqual({
        ...size,
        maxItems: 30,
      });
      expect(await stock(firstId)).toBe(10);
    });

    it('atomically sells the last unit of one size, directly and through a design', async () => {
      const creator = await db.user.create({
        data: {
          firstName: 'Admin',
          lastName: 'Test',
          email: 'sizes-admin@example.test',
          passwordHash: 'test',
          role: 'ADMIN',
        },
      });
      await db.category.update({
        where: { id: categoryId },
        data: { builderType: 'APPAREL' },
      });
      // Image storage is not configured in this suite, so the catalog row is inserted directly.
      const hoodie = await db.product.create({
        data: {
          createdById: creator.id,
          categoryId,
          origin: 'COMPANY',
          name: 'Black Essential Hoodie',
          price: 3500,
          color: 'Black',
          imageKey: 'products/hoodie.png',
          sizes: [
            { size: 'M', stock: 5 },
            { size: 'L', stock: 1 },
          ],
        },
      });
      // A saved design never reserves the size.
      const custom = await products.create(
        {
          categoryId,
          name: 'Custom Black Hoodie',
          baseProductId: hoodie.id,
          selectedSizeId: 'L',
          items: [
            {
              subCategoryId: firstId,
              quantity: 1,
              side: 'FRONT',
              x: 0.5,
              y: 0.5,
            },
          ],
        },
        customer,
      );
      expect(custom).toMatchObject({ price: 3500 + 150, basePrice: 3500 });
      const sizes = async () =>
        (await db.product.findUniqueOrThrow({ where: { id: hoodie.id } }))
          .sizes;
      expect(await sizes()).toEqual([
        { size: 'M', stock: 5 },
        { size: 'L', stock: 1 },
      ]);
      // The last L: a plain order and a design order race for it.
      const results = await Promise.allSettled([
        orders.create(
          { productId: hoodie.id, size: 'L', paymentType: 'CASH_ON_DELIVERY' },
          customer,
        ),
        place(custom.id),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await sizes()).toEqual([
        { size: 'M', stock: 5 },
        { size: 'L', stock: 0 },
      ]);
      expect(await db.order.count()).toBe(1);
      // Other sizes are untouched and still sell.
      await orders.create(
        { productId: hoodie.id, size: 'M', paymentType: 'CASH_ON_DELIVERY' },
        customer,
      );
      expect(await sizes()).toEqual([
        { size: 'M', stock: 4 },
        { size: 'L', stock: 0 },
      ]);
      await expect(
        orders.create(
          { productId: hoodie.id, size: 'L', paymentType: 'CASH_ON_DELIVERY' },
          customer,
        ),
      ).rejects.toThrow('sold out');
    });

    it('takes one phone model from stock only when a case design is ordered', async () => {
      const creator = await db.user.create({
        data: {
          firstName: 'Admin',
          lastName: 'Test',
          email: 'cases-admin@example.test',
          passwordHash: 'test',
          role: 'ADMIN',
        },
      });
      await db.category.update({
        where: { id: categoryId },
        data: { builderType: 'CASE' },
      });
      const iphone = await db.product.create({
        data: {
          createdById: creator.id,
          categoryId,
          origin: 'COMPANY',
          name: 'iPhone 14',
          deviceBrand: 'APPLE',
          price: 1500,
          stock: 1,
          imageKey: 'products/iphone-14.png',
        },
      });
      const stockOf = async () =>
        (await db.product.findUniqueOrThrow({ where: { id: iphone.id } }))
          .stock;
      const design = (name: string) =>
        products.create(
          {
            categoryId,
            name,
            baseProductId: iphone.id,
            items: [
              {
                subCategoryId: firstId,
                quantity: 1,
                x: 0.5,
                y: 0.5,
                scale: 1.2,
              },
            ],
          },
          customer,
        );
      const first = await design('My case');
      const second = await design('Another case');
      expect(first).toMatchObject({ price: 1500 + 150, basePrice: 1500 });
      // Saving designs reserves nothing.
      expect(await stockOf()).toBe(1);
      const results = await Promise.allSettled([
        place(first.id),
        place(second.id),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await stockOf()).toBe(0);
    });

    it('atomically sells the last ready-made unit and keeps the purchased details after edits', async () => {
      const creator = await db.user.create({
        data: {
          firstName: 'Admin',
          lastName: 'Test',
          email: 'admin@example.test',
          passwordHash: 'test',
          role: 'ADMIN',
        },
      });
      const product = await db.product.create({
        data: {
          createdById: creator.id,
          categoryId,
          name: 'Ready bracelet',
          origin: 'COMPANY',
          price: 2500,
          stock: 1,
          imageKey: 'products/ready.png',
          items: {
            create: [{ subCategoryId: firstId, quantity: 2, unitPrice: 150 }],
          },
        },
      });
      const results = await Promise.allSettled([
        place(product.id),
        place(product.id),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(
        (await db.product.findUniqueOrThrow({ where: { id: product.id } }))
          .stock,
      ).toBe(0);
      expect(await stock(firstId)).toBe(10);
      expect(await db.order.count()).toBe(1);
      const purchased = results.find(
        (result) => result.status === 'fulfilled',
      )!;
      if (purchased.status !== 'fulfilled')
        throw new Error('Expected a purchase');
      await products.update(
        product.id,
        { name: 'Changed', price: 9000, stock: 5, items: [] },
        admin,
      );
      const historical = await orders.findOne(purchased.value.id, customer);
      expect(historical.totalPrice).toBe(2500);
      expect(historical.product).toMatchObject({
        name: 'Ready bracelet',
        price: 2500,
        origin: 'COMPANY',
      });
      expect(historical.product.items).toHaveLength(1);
    });

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
      expect(upload).toHaveBeenCalledWith(expect.anything(), 'designs', true);
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
        fakeOrderNotifications(
          new NotificationsService(db as unknown as PrismaService),
        ),
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

    it('prices gift packaging on save and takes its stock only when ordered', async () => {
      await db.category.update({
        where: { id: categoryId },
        data: { builderType: 'GIFT' },
      });
      const box = await db.giftPackaging.create({
        data: {
          name: 'Classic Closed Box',
          type: 'OPAQUE',
          price: 500,
          colors: {
            create: [
              { name: 'Pink', hex: '#E8B4BC', priceAdjustment: 50, stock: 1 },
              { name: 'Beige', hex: '#E5D3B3', stock: 0 },
            ],
          },
        },
        include: { colors: true },
      });
      const transparent = await db.giftPackaging.create({
        data: {
          name: 'Transparent Box',
          type: 'TRANSPARENT',
          price: 400,
          stock: 3,
        },
      });
      const pink = box.colors.find((color) => color.name === 'Pink')!;
      const beige = box.colors.find((color) => color.name === 'Beige')!;
      const item = { subCategoryId: firstId, quantity: 2, x: 0.5, y: 0.5 };
      const gift = await products.create(
        {
          categoryId,
          name: 'Birthday Gift',
          items: [item],
          giftPackagingId: box.id,
          giftPackagingColorId: pink.id,
        },
        customer,
      );
      expect(gift).toMatchObject({ packagingPrice: 550, price: 300 + 550 });
      expect(gift.giftPackagingColor?.name).toBe('Pink');
      // Saving a design never takes stock.
      const color = (id: string) =>
        db.giftPackagingColor.findUniqueOrThrow({ where: { id } });
      expect((await color(pink.id)).stock).toBe(1);
      await expect(
        products.create(
          {
            categoryId,
            name: 'Sold out',
            items: [item],
            giftPackagingId: box.id,
            giftPackagingColorId: beige.id,
          },
          customer,
        ),
      ).rejects.toThrow('sold out');

      const order = await place(gift.id);
      expect(order.totalPrice).toBe(850);
      expect(order.product).toMatchObject({
        packagingPrice: 550,
        giftPackaging: { name: 'Classic Closed Box', type: 'OPAQUE' },
        giftPackagingColor: { name: 'Pink', hex: '#E8B4BC' },
      });
      expect((await color(pink.id)).stock).toBe(0);
      expect(await stock(firstId)).toBe(8);
      // The last pink box is gone: ordering again rolls back components too.
      await expect(place(gift.id)).rejects.toThrow('sold out');
      expect(await stock(firstId)).toBe(8);

      const clear = await products.create(
        {
          categoryId,
          name: 'See-through gift',
          items: [item],
          giftPackagingId: transparent.id,
        },
        customer,
      );
      expect(clear).toMatchObject({ giftPackagingColorId: null, price: 700 });
      await place(clear.id);
      expect(
        (
          await db.giftPackaging.findUniqueOrThrow({
            where: { id: transparent.id },
          })
        ).stock,
      ).toBe(2);
      // Deactivated packaging stops new orders but keeps the saved design intact.
      await db.giftPackaging.update({
        where: { id: transparent.id },
        data: { isActive: false },
      });
      await expect(place(clear.id)).rejects.toThrow('no longer available');
      expect((await products.findOne(clear.id)).giftPackaging?.name).toBe(
        'Transparent Box',
      );
    });
    it('sizes bracelets by length: saves drafts, rejects overfill, orders from the minimum price', async () => {
      // A bracelet measured in millimetres: 4–6 cm keeps the test inside the fixture stock.
      const size = {
        id: 'tiny',
        name: 'Tiny',
        minMeasurementMm: 40,
        maxMeasurementMm: 60,
        defaultMeasurementMm: 50,
      };
      await db.category.update({
        where: { id: categoryId },
        data: { name: 'Bracelet', builderType: 'JEWELRY', sizes: [size] },
      });
      await db.subCategory.update({
        where: { id: firstId },
        data: { effectiveLengthMm: 8 },
      });
      await db.subCategory.update({
        where: { id: secondId },
        data: { effectiveLengthMm: 10 },
      });
      const bracelet = (
        items: { subCategoryId: string; quantity: number }[],
        selectedMeasurementMm = 50,
      ) =>
        products.create(
          {
            categoryId,
            name: 'Bracelet',
            selectedSizeId: 'tiny',
            selectedMeasurementMm,
            items,
          },
          customer,
        );

      // 4 × 8 mm + 1 × 10 mm = 42 mm of 50 mm: an unfinished design still saves.
      const draft = await bracelet([
        { subCategoryId: firstId, quantity: 4 },
        { subCategoryId: secondId, quantity: 1 },
      ]);
      expect(draft.selectedSize).toEqual({
        ...size,
        selectedMeasurementMm: 50,
      });
      expect(draft.price).toBe(4 * 150 + 200);
      expect(await stock(firstId)).toBe(10);
      expect(await stock(secondId)).toBe(5);
      // An unfinished bracelet may be ordered, but not below €5.00: 1 × €1.50 is refused.
      const cheap = await bracelet([{ subCategoryId: firstId, quantity: 1 }]);
      await expect(place(cheap.id)).rejects.toThrow('Bracelets start at €5.00');
      expect(await stock(firstId)).toBe(10);

      // 5 × 8 + 2 × 10 = 60 mm cannot fit a 50 mm bracelet (52 mm with tolerance).
      await expect(
        bracelet([
          { subCategoryId: firstId, quantity: 5 },
          { subCategoryId: secondId, quantity: 2 },
        ]),
      ).rejects.toThrow('longer than the chosen 5 cm');
      await expect(
        bracelet([{ subCategoryId: firstId, quantity: 1 }], 70),
      ).rejects.toThrow('4 cm to 6 cm');
      await expect(
        products.create(
          {
            categoryId,
            name: 'No length',
            selectedSizeId: 'tiny',
            items: [{ subCategoryId: firstId, quantity: 1 }],
          },
          customer,
        ),
      ).rejects.toThrow('Choose the length');

      // 5 × 8 + 1 × 10 = 50 mm, €9.50: ordered, and only then stock is taken.
      const complete = await bracelet([
        { subCategoryId: firstId, quantity: 5 },
        { subCategoryId: secondId, quantity: 1 },
      ]);
      const order = await place(complete.id);
      expect(order.totalPrice).toBe(5 * 150 + 200);
      expect(order.product).toMatchObject({
        selectedSize: { selectedMeasurementMm: 50 },
      });
      expect(await stock(firstId)).toBe(5);
      expect(await stock(secondId)).toBe(4);

      // A component nobody has measured yet cannot be used in a length-sized bracelet.
      await db.subCategory.update({
        where: { id: secondId },
        data: { effectiveLengthMm: null },
      });
      await expect(
        bracelet([{ subCategoryId: secondId, quantity: 1 }]),
      ).rejects.toThrow('Red bead does not have a physical size configured');
    });
    it('records in-app order updates for the owner as they happen, never twice, and respects the preference', async () => {
      const order = await place((await design()).id);
      const titles = async () =>
        (
          await db.notification.findMany({
            where: { userId: customer.id },
            select: { title: true },
          })
        )
          .map((entry) => entry.title)
          .sort();
      // Placing an order: exactly one "Order received", about that order.
      expect(await titles()).toEqual(['Order received']);
      expect(
        await db.notification.findFirst({ where: { userId: customer.id } }),
      ).toMatchObject({
        orderId: order.id,
        type: 'ORDER_STATUS',
        isRead: false,
        message: `We’ve received your order ${order.orderNumber}.`,
      });

      const steps = [
        ['CREATING', 'We’re creating your order'],
        ['CREATED', 'Your order is ready'],
        ['READY_FOR_COURIER', 'Ready for the courier'],
      ] as const;
      for (const [status, title] of steps) {
        await orders.updateStatus(order.id, { status }, admin);
        expect(await titles()).toContain(title);
      }
      expect(await db.notification.count()).toBe(4);
      // The same status again is refused and adds nothing.
      await expect(
        orders.updateStatus(order.id, { status: 'READY_FOR_COURIER' }, admin),
      ).rejects.toThrow();
      expect(await db.notification.count()).toBe(4);

      // Turned off: no new in-app notifications, and the history stays.
      await db.user.update({
        where: { id: customer.id },
        data: { notificationsEnabled: false },
      });
      await orders.updateStatus(
        order.id,
        { status: 'PICKED_UP_BY_COURIER' },
        admin,
      );
      expect(await db.notification.count()).toBe(4);
      // Back on: the next real change is recorded again.
      await db.user.update({
        where: { id: customer.id },
        data: { notificationsEnabled: true },
      });
      await orders.updateStatus(order.id, { status: 'COMPLETED' }, admin);
      expect(await titles()).toContain('Order completed');
      expect(await db.notification.count()).toBe(5);
    });
  },
);
