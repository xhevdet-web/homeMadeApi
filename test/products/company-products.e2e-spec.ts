import { ProductsService } from '../../src/modules/products/products.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import type { ImageWriteService } from '../../src/storage/image-write.service.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';

describe('Company product management', () => {
  const product = {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  };
  const category = { findUnique: vi.fn() };
  const subCategory = { findMany: vi.fn() };
  const tx = { product, category, subCategory, $queryRaw: vi.fn() };
  const prisma = {
    $transaction: vi.fn((callback) => callback(tx)),
    product,
  };
  const images = {
    saveMany: vi.fn(
      async (_files, callback) =>
        (await callback(['products/photo.png', undefined])).result,
    ),
  };
  const service = new ProductsService(
    prisma as unknown as PrismaService,
    images as unknown as ImageWriteService,
  );
  const admin = { id: 'admin', role: 'ADMIN' } as AuthenticatedUser;
  const file = {} as Express.Multer.File;
  const dto = {
    categoryId: 'category',
    name: 'Bracelet',
    origin: 'COMPANY' as const,
    price: 4200,
    stock: 3,
  };
  const hoodie = {
    categoryId: 'category',
    name: 'Black Essential Hoodie',
    origin: 'COMPANY' as const,
    price: 3500,
    color: 'Black',
    colorHex: '#111111',
    sizes: [
      { size: 'S', stock: 20 },
      { size: 'M', stock: 28 },
      { size: 'L', stock: 35 },
      { size: 'XL', stock: 12 },
    ],
  };
  beforeEach(() => {
    vi.clearAllMocks();
    category.findUnique.mockResolvedValue({ id: 'category' });
    product.create.mockImplementation(async ({ data }) => data);
    product.update.mockImplementation(async ({ data }) => data);
    product.findMany.mockResolvedValue([]);
    product.findUnique.mockResolvedValue({
      ...dto,
      id: 'product',
      sizes: null,
      items: [],
      _count: { orders: 1 },
    });
  });
  it('supports an optional size for company products without changing price or stock', async () => {
    const size = {
      id: 'small',
      name: 'Small',
      measurement: 16,
      unit: 'cm',
      maxItems: 16,
    };
    category.findUnique.mockResolvedValue({ id: 'category', sizes: [size] });
    expect(
      await service.create({ ...dto, selectedSizeId: 'small' }, admin, file),
    ).toMatchObject({ selectedSize: size, price: 4200, stock: 3 });
  });
  it('creates without components and preserves admin-set price and stock', async () => {
    expect(await service.create(dto, admin, file)).toMatchObject({
      price: 4200,
      stock: 3,
      origin: 'COMPANY',
      itemCount: 0,
    });
    expect(subCategory.findMany).not.toHaveBeenCalled();
  });
  it('creates one apparel colour with stock per size and one price', async () => {
    const created = await service.create(hoodie, admin, file);
    expect(created).toMatchObject({
      origin: 'COMPANY',
      color: 'Black',
      colorHex: '#111111',
      price: 3500,
      stock: 0,
      sizes: hoodie.sizes,
    });
  });
  it('rejects duplicate sizes and a global stock on a sized product', () => {
    expect(() =>
      service.create(
        {
          ...hoodie,
          sizes: [
            { size: 'M', stock: 1 },
            { size: 'm', stock: 2 },
          ],
        },
        admin,
        file,
      ),
    ).toThrow('listed twice');
    expect(() => service.create({ ...hoodie, stock: 5 }, admin, file)).toThrow(
      'per size',
    );
  });
  it('rejects customer creation before saving images', () => {
    expect(() =>
      service.create(dto, { ...admin, role: 'CUSTOMER' }, file),
    ).toThrow('Only admins');
    expect(images.saveMany).not.toHaveBeenCalled();
  });
  it('requires an uploaded image', () => {
    expect(() => service.create(dto, admin)).toThrow('uploaded image');
  });
  it.each([-1, 1.5, 2147483648, null, undefined])(
    'rejects invalid company price and stock %s',
    (value) => {
      expect(() =>
        service.create({ ...dto, price: value as number }, admin, file),
      ).toThrow('price');
      expect(() =>
        service.create({ ...dto, stock: value as number }, admin, file),
      ).toThrow('stock');
    },
  );
  it('allows price and inventory edits after purchase', async () => {
    expect(
      await service.update(
        'product',
        { price: 5000, stock: 0, items: [] },
        admin,
      ),
    ).toMatchObject({ price: 5000, stock: 0 });
  });
  it('replaces size inventory and keeps stock on the sizes', async () => {
    product.findUnique.mockResolvedValue({
      ...hoodie,
      id: 'product',
      stock: 0,
      items: [],
      _count: { orders: 3 },
    });
    expect(
      await service.update(
        'product',
        { sizes: [{ size: 'L', stock: 34 }], color: 'Black' },
        admin,
      ),
    ).toMatchObject({ sizes: [{ size: 'L', stock: 34 }], stock: 0 });
  });
  it('rejects company-only fields on customer designs', () => {
    expect(() =>
      service.create(
        { categoryId: 'category', name: 'Mine', price: 1 },
        { ...admin, role: 'CUSTOMER' },
      ),
    ).toThrow('calculated');
    expect(() =>
      service.create(
        { categoryId: 'category', name: 'Mine', sizes: hoodie.sizes },
        { ...admin, role: 'CUSTOMER' },
      ),
    ).toThrow('calculated');
  });
  it('rejects price and stock edits on customer designs', async () => {
    product.findUnique.mockResolvedValue({
      ...dto,
      origin: 'CUSTOMER',
      id: 'product',
      items: [],
      _count: { orders: 0 },
    });
    await expect(
      service.update('product', { price: 10 }, admin),
    ).rejects.toThrow('calculated');
  });
  it('keeps an image another colour product still shares', async () => {
    const cleanup = vi.fn();
    const shared = new ProductsService(
      {
        ...prisma,
        product: {
          ...product,
          delete: vi.fn().mockResolvedValue({
            imageKey: 'products/hoodie.png',
            backImageKey: 'products/back.png',
            designPreviewKey: null,
            backDesignPreviewKey: null,
            items: [],
          }),
          findMany: vi
            .fn()
            .mockResolvedValue([
              { imageKey: 'products/hoodie.png', backImageKey: null },
            ]),
        },
      } as unknown as PrismaService,
      { cleanup } as unknown as ImageWriteService,
    );
    await shared.remove('product', admin);
    expect(cleanup).toHaveBeenCalledWith(['products/back.png']);
  });
});
