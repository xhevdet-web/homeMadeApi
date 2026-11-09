import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { ProductsModule } from '../../src/modules/products/products.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { setupApp } from '../../src/config/setup-app.js';

/**
 * GET /products filtering, sorting and pagination.
 *
 * Part 1 runs on the mocked database like the other suites: validation and how the SQL
 * is built. Part 2 seeds a real, throwaway PostgreSQL database (created next to the
 * DATABASE_URL one, migrated, and dropped afterwards) so the SQL rules themselves are
 * checked. It is skipped, with a warning, when no database is reachable.
 */

const base = '/api/v1/products';
const JWT_SECRET = 'test-only-jwt-secret-at-least-32-characters';
const stubJwt = () => {
  vi.stubEnv('JWT_ACCESS_SECRET', JWT_SECRET);
  vi.stubEnv('JWT_ACCESS_EXPIRES_IN', '60m');
};

describe('GET /products paginated mode: validation and SQL (mocked database)', () => {
  let app: INestApplication<App>;
  const prisma = {
    product: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };

  beforeAll(async () => {
    stubJwt();
    const module = await Test.createTestingModule({ imports: [ProductsModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.$transaction.mockImplementation((operations: unknown[]) =>
      Promise.all(operations),
    );
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it.each([
    ['page=0', 'page must be a whole number of at least 1'],
    ['page=-2', 'page must be a whole number of at least 1'],
    ['page=abc', 'page must be a whole number of at least 1'],
    ['page=1.5', 'page must be a whole number of at least 1'],
    ['page=', 'page must be a whole number of at least 1'],
    ['page=1&limit=0', 'limit must be a whole number from 1 to 48'],
    ['page=1&limit=49', 'limit must be a whole number from 1 to 48'],
    ['page=1&limit=ten', 'limit must be a whole number from 1 to 48'],
    [
      'page=1&sort=oldest',
      'sort must be one of: newest, price_asc, price_desc',
    ],
    [
      'page=1&sort=PRICE_ASC',
      'sort must be one of: newest, price_asc, price_desc',
    ],
    ['page=1&type=all', 'type must be one of: ready, custom'],
    ['page=1&inStock=yes', 'inStock must be true or false'],
    ['page=1&perPage=10', 'property perPage should not exist'],
  ])('rejects %s with a clear message', async (query, message) => {
    const response = await request(app.getHttpServer())
      .get(base + '?' + query)
      .expect(400);
    expect(response.body.message).toContain(message);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('keeps the plain array and its Prisma query without page', async () => {
    const response = await request(app.getHttpServer())
      .get(base + '?origin=COMPANY')
      .expect(200);
    expect(response.body).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.product.findMany.mock.calls[0][0]).toMatchObject({
      where: { origin: 'COMPANY' },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  });

  it('passes every user value to the database as a parameter', async () => {
    const search = "x'; DROP TABLE products; --";
    const response = await request(app.getHttpServer())
      .get(base)
      .query({ page: 3, limit: 5, origin: 'COMPANY', search })
      .expect(200);
    expect(response.body).toEqual({
      data: [],
      meta: {
        page: 3,
        limit: 5,
        total: 0,
        totalPages: 0,
        counts: { all: 0, ready: 0, custom: 0 },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    for (const [query] of prisma.$queryRaw.mock.calls) {
      expect(query.sql).not.toContain('DROP TABLE');
      expect(query.values).toContain(`%${search}%`);
      expect(query.values).toContain('COMPANY');
    }
    const ids = prisma.$queryRaw.mock.calls[1][0];
    expect(ids.values).toEqual(expect.arrayContaining([5, 10]));
    // Nothing to load for an empty page.
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  // Ties on the database can come back in any order, so the full ORDER BY is pinned here.
  it.each([
    ['newest', 'p."created_at" DESC, p."sort_order" ASC, p."id" ASC'],
    ['price_asc', 'p."price" ASC, p."created_at" DESC, p."id" ASC'],
    ['price_desc', 'p."price" DESC, p."created_at" DESC, p."id" ASC'],
  ])('orders %s fully deterministically', async (sort, orderBy) => {
    await request(app.getHttpServer())
      .get(base)
      .query({ page: 1, sort })
      .expect(200);
    const ids = prisma.$queryRaw.mock.calls[1][0].sql.replace(/\s+/g, ' ');
    expect(ids).toContain(`ORDER BY ${orderBy} LIMIT`);
  });
});

/* ---------------------------------------------------------------- real database ---- */

const adminUrl = process.env.DATABASE_URL;
const client = (connectionString: string) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/** A reachable server where this user may create the throwaway database. */
async function reachable(url: string | undefined) {
  if (!url) return false;
  const db = client(url);
  try {
    const [role] = await db.$queryRaw<{ allowed: boolean }[]>`
      SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname = current_user`;
    return role?.allowed === true;
  } catch {
    return false;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

const databaseReady = await reachable(adminUrl);
if (!databaseReady)
  console.warn(
    'Skipping the GET /products database tests: no PostgreSQL at DATABASE_URL where this user can create a test database',
  );

// Readable fixed ids; their order is the last tie-break of every sort.
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (d: number) => new Date(Date.UTC(2026, 0, d, 12));

const users = {
  admin: uuid(901),
  alice: uuid(902),
  bob: uuid(903),
};
const categories = {
  jewelry: uuid(801),
  mugs: uuid(802),
  cases: uuid(803),
  apparel: uuid(804),
  retired: uuid(805),
};
const area = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };

/**
 * The catalog. type: ready / custom. sold out: the rule that makes it sold out.
 *  01 Gold Ring          ready   2000  T10  sizes [] → stock 3: in stock
 *  02 Silver Bracelet    ready   2000  T10  stock 5 (same price and date as 01)
 *  03 Pearl Necklace     ready   3500  T9   sold out by stock 0
 *  04 Empty Sizes Charm  ready   1500  T7   sizes [] → stock 0: sold out
 *  05 White Mug          custom  1200  T6   printAreas.front, sortOrder 1
 *  06 Ceramic Coaster    ready    800  T6   printAreas.front is null, sortOrder 0
 *  07 iPhone 15 Case     custom  2500  T5   CASE category
 *  08 Black Hoodie       custom  3500  T4   APPAREL, every size 0: sold out despite stock 9
 *  09 White Tee          custom  2000  T3   APPAREL, stock 0 but size M has 3: in stock
 *  10 Old Brooch         ready   1000  T2   inactive category
 *  11 Hidden Pendant     ready    999  T1   inactive product
 */
const company = [
  // 02 is created before 01, so only the id can put 01 first.
  {
    id: uuid(2),
    categoryId: categories.jewelry,
    name: 'Silver Bracelet',
    description: 'Handmade chain',
    price: 2000,
    stock: 5,
    createdAt: day(10),
  },
  {
    id: uuid(1),
    categoryId: categories.jewelry,
    name: 'Gold Ring',
    price: 2000,
    stock: 3,
    sizes: [],
    createdAt: day(10),
  },
  {
    id: uuid(3),
    categoryId: categories.jewelry,
    name: 'Pearl Necklace',
    price: 3500,
    stock: 0,
    createdAt: day(9),
  },
  {
    id: uuid(4),
    categoryId: categories.jewelry,
    name: 'Empty Sizes Charm',
    price: 1500,
    stock: 0,
    sizes: [],
    createdAt: day(7),
  },
  {
    id: uuid(5),
    categoryId: categories.mugs,
    name: 'White Mug',
    price: 1200,
    stock: 10,
    printAreas: { front: area },
    sortOrder: 1,
    createdAt: day(6),
  },
  {
    id: uuid(6),
    categoryId: categories.mugs,
    name: 'Ceramic Coaster',
    price: 800,
    stock: 4,
    printAreas: { front: null, back: area },
    sortOrder: 0,
    createdAt: day(6),
  },
  {
    id: uuid(7),
    categoryId: categories.cases,
    name: 'iPhone 15 Case',
    price: 2500,
    stock: 7,
    createdAt: day(5),
  },
  {
    id: uuid(8),
    categoryId: categories.apparel,
    name: 'Black Hoodie',
    color: 'Midnight Black',
    price: 3500,
    stock: 9,
    sizes: [
      { size: 'S', stock: 0 },
      { size: 'M', stock: 0 },
    ],
    createdAt: day(4),
  },
  {
    id: uuid(9),
    categoryId: categories.apparel,
    name: 'White Tee',
    description: '100% cotton',
    color: 'Snow',
    price: 2000,
    stock: 0,
    sizes: [
      { size: 'S', stock: 0 },
      { size: 'M', stock: 3 },
    ],
    createdAt: day(3),
  },
  {
    id: uuid(10),
    categoryId: categories.retired,
    name: 'Old Brooch',
    price: 1000,
    stock: 5,
    createdAt: day(2),
  },
  {
    id: uuid(11),
    categoryId: categories.jewelry,
    name: 'Hidden Pendant',
    price: 999,
    stock: 5,
    isActive: false,
    createdAt: day(1),
  },
];
const designs = [
  // Phone case designs are private to their creator and admins.
  {
    id: uuid(21),
    categoryId: categories.cases,
    createdById: users.alice,
    name: 'Alice Photo Case',
    price: 3000,
    createdAt: day(11),
  },
  {
    id: uuid(22),
    categoryId: categories.jewelry,
    createdById: users.bob,
    name: 'Bob Beaded Bracelet',
    price: 1800,
    createdAt: day(12),
  },
  {
    id: uuid(23),
    categoryId: categories.cases,
    createdById: users.bob,
    name: 'Bob Photo Case',
    price: 3000,
    createdAt: day(12),
  },
];

const NEWEST = [
  'Gold Ring',
  'Silver Bracelet',
  'Pearl Necklace',
  'Empty Sizes Charm',
  'Ceramic Coaster',
  'White Mug',
  'iPhone 15 Case',
  'Black Hoodie',
  'White Tee',
];
// What the website asks for: the active COMPANY catalog.
const CATALOG = { origin: 'COMPANY', isActive: 'true' };

describe.skipIf(!databaseReady)(
  'GET /products paginated mode (PostgreSQL)',
  () => {
    const testDatabase = `homemade_listing_test_${process.pid}_${Date.now()}`;
    let testUrl: string;
    let admin: PrismaClient;
    let db: PrismaClient;
    let app: INestApplication<App>;
    const tokens: Record<keyof typeof users, string> = {
      admin: '',
      alice: '',
      bob: '',
    };

    beforeAll(async () => {
      admin = client(adminUrl!);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${testDatabase}"`);
      const url = new URL(adminUrl!);
      url.pathname = '/' + testDatabase;
      testUrl = url.toString();
      execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              '../../node_modules/prisma/build/index.js',
              import.meta.url,
            ),
          ),
          'migrate',
          'deploy',
        ],
        {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: { ...process.env, DATABASE_URL: testUrl },
          stdio: 'pipe',
        },
      );
      db = client(testUrl);
      await seed(db);

      stubJwt();
      vi.stubEnv('DATABASE_URL', testUrl);
      const module = await Test.createTestingModule({
        imports: [ProductsModule],
      }).compile();
      app = module.createNestApplication();
      setupApp(app);
      await app.init();
      const jwt = module.get(JwtService);
      for (const name of Object.keys(users) as (keyof typeof users)[])
        tokens[name] = await jwt.signAsync({
          sub: users[name],
          tokenUse: 'access',
        });
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await db?.$disconnect();
      await admin
        ?.$executeRawUnsafe(
          `DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`,
        )
        .finally(() => admin.$disconnect());
      vi.unstubAllEnvs();
    }, 60_000);

    async function seed(prisma: PrismaClient) {
      await prisma.user.createMany({
        data: [
          {
            id: users.admin,
            firstName: 'Ada',
            lastName: 'Admin',
            email: 'admin@test.local',
            role: 'ADMIN',
          },
          {
            id: users.alice,
            firstName: 'Alice',
            lastName: 'Customer',
            email: 'alice@test.local',
          },
          {
            id: users.bob,
            firstName: 'Bob',
            lastName: 'Customer',
            email: 'bob@test.local',
          },
        ],
      });
      await prisma.category.createMany({
        data: [
          { id: categories.jewelry, name: 'Jewelry', builderType: 'JEWELRY' },
          { id: categories.mugs, name: 'Mugs', builderType: 'MUG' },
          { id: categories.cases, name: 'Phone cases', builderType: 'CASE' },
          { id: categories.apparel, name: 'Apparel', builderType: 'APPAREL' },
          {
            id: categories.retired,
            name: 'Retired',
            builderType: 'JEWELRY',
            isActive: false,
          },
        ],
      });
      // One at a time, so creation order differs from id order where it matters.
      for (const product of company)
        await prisma.product.create({
          data: { ...product, origin: 'COMPANY', createdById: users.admin },
        });
      for (const product of designs)
        await prisma.product.create({
          data: { ...product, origin: 'CUSTOMER' },
        });
    }

    const get = (query: Record<string, unknown>, token?: string) => {
      const call = request(app.getHttpServer()).get(base).query(query);
      return (
        token ? call.set('Authorization', 'Bearer ' + token) : call
      ).expect(200);
    };
    const page = async (query: Record<string, unknown>, token?: string) => {
      const { body } = await get({ page: 1, limit: 48, ...query }, token);
      return {
        names: (body.data as { name: string }[]).map(({ name }) => name),
        meta: body.meta,
      };
    };

    describe('without page (backward compatible)', () => {
      it('returns the same plain array as before, in the same order', async () => {
        const { body } = await get({ origin: 'COMPANY' });
        expect(Array.isArray(body)).toBe(true);
        const before = await db.product.findMany({
          where: { origin: 'COMPANY' },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: { id: true },
        });
        expect(body.map(({ id }: { id: string }) => id)).toEqual(
          before.map(({ id }) => id),
        );
        // Inactive categories and products are still listed, as before.
        expect(body.map(({ name }: { name: string }) => name)).toEqual(
          expect.arrayContaining(['Old Brooch', 'Hidden Pendant']),
        );
        expect(body[0]).toMatchObject({
          category: { id: categories.jewelry, name: 'Jewelry' },
          createdBy: { id: users.admin },
        });
      });

      it('ignores the paginated-only parameters and keeps the old search', async () => {
        const plain = await get({ origin: 'COMPANY' });
        const withParams = await get({
          origin: 'COMPANY',
          limit: 2,
          sort: 'price_asc',
          type: 'custom',
          inStock: 'true',
        });
        expect(withParams.body).toEqual(plain.body);
        // Array mode does not search category names.
        expect(
          (await get({ origin: 'COMPANY', search: 'apparel' })).body,
        ).toEqual([]);
      });
    });

    describe('pagination', () => {
      it('pages through the catalog with totals', async () => {
        const first = await page({ ...CATALOG, limit: 4 });
        expect(first.names).toEqual(NEWEST.slice(0, 4));
        expect(first.meta).toEqual({
          page: 1,
          limit: 4,
          total: 9,
          totalPages: 3,
          counts: { all: 9, ready: 5, custom: 4 },
        });
        const second = await page({ ...CATALOG, limit: 4, page: 2 });
        expect(second.names).toEqual(NEWEST.slice(4, 8));
        const last = await page({ ...CATALOG, limit: 4, page: 3 });
        expect(last.names).toEqual(['White Tee']);
        expect(last.meta).toMatchObject({ page: 3, total: 9, totalPages: 3 });
      });

      it('returns an empty page beyond the end, not an error', async () => {
        const beyond = await page({ ...CATALOG, limit: 4, page: 7 });
        expect(beyond.names).toEqual([]);
        expect(beyond.meta).toEqual({
          page: 7,
          limit: 4,
          total: 9,
          totalPages: 3,
          counts: { all: 9, ready: 5, custom: 4 },
        });
      });

      it('defaults to 12 per page', async () => {
        const { body } = await get({ ...CATALOG, page: 1 });
        expect(body.meta.limit).toBe(12);
        expect(body.data).toHaveLength(9);
        expect(body.data[0]).toMatchObject({
          id: uuid(1),
          category: { name: 'Jewelry' },
          createdBy: { id: users.admin },
        });
      });

      it('never repeats or skips a product across pages, for every sort', async () => {
        for (const sort of ['newest', 'price_asc', 'price_desc']) {
          const all = (await page({ ...CATALOG, sort })).names;
          const paged: string[] = [];
          for (let n = 1; n <= 5; n++)
            paged.push(
              ...(await page({ ...CATALOG, sort, limit: 2, page: n })).names,
            );
          expect(paged).toEqual(all);
          expect(new Set(paged).size).toBe(9);
        }
      });

      it('hides products of inactive categories', async () => {
        const { names } = await page({ origin: 'COMPANY' });
        expect(names).not.toContain('Old Brooch');
        // Without isActive the inactive product is listed, like the array mode.
        expect(names).toContain('Hidden Pendant');
      });
    });

    describe('sorting', () => {
      it('newest: date, then sortOrder, then id', async () => {
        expect((await page(CATALOG)).names).toEqual(NEWEST);
        expect((await page({ ...CATALOG, sort: 'newest' })).names).toEqual(
          NEWEST,
        );
      });

      it('price_asc: price, then newest, then id', async () => {
        expect((await page({ ...CATALOG, sort: 'price_asc' })).names).toEqual([
          'Ceramic Coaster',
          'White Mug',
          'Empty Sizes Charm',
          'Gold Ring',
          'Silver Bracelet',
          'White Tee',
          'iPhone 15 Case',
          'Pearl Necklace',
          'Black Hoodie',
        ]);
      });

      it('price_desc: price, then newest, then id', async () => {
        expect((await page({ ...CATALOG, sort: 'price_desc' })).names).toEqual([
          'Pearl Necklace',
          'Black Hoodie',
          'iPhone 15 Case',
          'Gold Ring',
          'Silver Bracelet',
          'White Tee',
          'Empty Sizes Charm',
          'White Mug',
          'Ceramic Coaster',
        ]);
      });
    });

    describe('type', () => {
      it('ready: no print area, not apparel or phone case', async () => {
        const { names, meta } = await page({ ...CATALOG, type: 'ready' });
        expect(names).toEqual([
          'Gold Ring',
          'Silver Bracelet',
          'Pearl Necklace',
          'Empty Sizes Charm',
          'Ceramic Coaster',
        ]);
        expect(meta).toMatchObject({
          total: 5,
          totalPages: 1,
          counts: { all: 9, ready: 5, custom: 4 },
        });
      });

      it('custom: a print area front, or an APPAREL / CASE category', async () => {
        const { names, meta } = await page({ ...CATALOG, type: 'custom' });
        expect(names).toEqual([
          'White Mug',
          'iPhone 15 Case',
          'Black Hoodie',
          'White Tee',
        ]);
        // counts ignore type.
        expect(meta).toMatchObject({
          total: 4,
          counts: { all: 9, ready: 5, custom: 4 },
        });
      });
    });

    describe('inStock', () => {
      it('hides products sold out by stock, by sizes, and with empty sizes', async () => {
        const { names, meta } = await page({ ...CATALOG, inStock: 'true' });
        expect(names).toEqual([
          'Gold Ring', // sizes [] with stock 3
          'Silver Bracelet',
          'Ceramic Coaster',
          'White Mug',
          'iPhone 15 Case',
          'White Tee', // stock 0, but one size in stock
        ]);
        expect(names).not.toContain('Pearl Necklace'); // stock 0
        expect(names).not.toContain('Empty Sizes Charm'); // sizes [] with stock 0
        expect(names).not.toContain('Black Hoodie'); // every size 0, stock 9
        expect(meta).toMatchObject({
          total: 6,
          counts: { all: 6, ready: 3, custom: 3 },
        });
      });

      it('inStock=false filters nothing', async () => {
        expect((await page({ ...CATALOG, inStock: 'false' })).names).toEqual(
          NEWEST,
        );
      });
    });

    describe('search', () => {
      it.each([
        ['name', 'pEaRl', ['Pearl Necklace']],
        ['description', 'HANDMADE chain', ['Silver Bracelet']],
        ['colour', 'midnight', ['Black Hoodie']],
        ['category name', 'APPAREL', ['Black Hoodie', 'White Tee']],
        ['literal %', '100%', ['White Tee']],
        ['literal _', '_', []],
        ['inactive category name', 'retired', []],
      ])(
        'matches the %s, case-insensitively',
        async (_field, search, expected) => {
          expect((await page({ ...CATALOG, search })).names).toEqual(expected);
        },
      );
    });

    describe('combined filters', () => {
      it('type, inStock, search and sort together', async () => {
        const { names, meta } = await page({
          ...CATALOG,
          type: 'custom',
          inStock: 'true',
          search: 'white',
          sort: 'price_desc',
        });
        expect(names).toEqual(['White Tee', 'White Mug']);
        expect(meta).toMatchObject({
          total: 2,
          counts: { all: 2, ready: 0, custom: 2 },
        });
      });

      it('category, inStock and price sort', async () => {
        const { names, meta } = await page({
          ...CATALOG,
          categoryId: categories.jewelry,
          inStock: 'true',
          sort: 'price_asc',
          limit: 1,
          page: 2,
        });
        expect(names).toEqual(['Silver Bracelet']);
        expect(meta).toEqual({
          page: 2,
          limit: 1,
          total: 2,
          totalPages: 2,
          counts: { all: 2, ready: 2, custom: 0 },
        });
      });
    });

    describe('visibility (unchanged)', () => {
      const designNames = (names: string[]) =>
        names.filter(
          (name) => name.startsWith('Alice') || name.startsWith('Bob'),
        );

      it('signed out: no private phone case designs', async () => {
        const { names, meta } = await page({});
        expect(designNames(names)).toEqual(['Bob Beaded Bracelet']);
        expect(meta.total).toBe(names.length);
      });

      it('a customer also sees their own phone case designs', async () => {
        const alice = await page({}, tokens.alice);
        expect(designNames(alice.names)).toEqual([
          'Bob Beaded Bracelet',
          'Alice Photo Case',
        ]);
        expect(alice.meta.total).toBe(alice.names.length);
        const bob = await page({ origin: 'CUSTOMER' }, tokens.bob);
        expect(bob.names).toEqual(['Bob Beaded Bracelet', 'Bob Photo Case']);
      });

      it('an admin sees every design', async () => {
        const { names, meta } = await page(
          { origin: 'CUSTOMER' },
          tokens.admin,
        );
        expect(names).toEqual([
          'Bob Beaded Bracelet',
          'Bob Photo Case',
          'Alice Photo Case',
        ]);
        expect(meta.counts).toEqual({ all: 3, ready: 1, custom: 2 });
      });

      it('matches the array mode for each viewer', async () => {
        for (const token of [undefined, tokens.alice, tokens.admin]) {
          const array = (await get({ origin: 'CUSTOMER' }, token)).body as {
            name: string;
          }[];
          const paged = await page({ origin: 'CUSTOMER' }, token);
          expect(paged.names).toEqual(array.map(({ name }) => name));
        }
      });
    });
  },
);
