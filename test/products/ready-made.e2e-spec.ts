import { ProductsService } from '../../src/modules/products/products.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import type { ImageWriteService } from '../../src/storage/image-write.service.js';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.type.js';

describe('Ready-made product management', () => {
  const product = { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() };
  const category = { findUnique: vi.fn() };
  const subCategory = { findMany: vi.fn() };
  const tx = { product, category, subCategory, $queryRaw: vi.fn() };
  const prisma = { $transaction: vi.fn((callback) => callback(tx)) };
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
    productType: 'READY_MADE' as const,
    price: 4200,
    stock: 3,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    category.findUnique.mockResolvedValue({ id: 'category' });
    product.create.mockImplementation(async ({ data }) => data);
    product.update.mockImplementation(async ({ data }) => data);
    product.findUnique.mockResolvedValue({
      ...dto,
      id: 'product',
      items: [],
      _count: { orders: 1 },
    });
  });
  it('supports an optional size for ready-made products without changing price or stock', async () => {
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
      productType: 'READY_MADE',
      itemCount: 0,
    });
    expect(subCategory.findMany).not.toHaveBeenCalled();
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
    'rejects invalid ready-made price and stock %s',
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
  it('prevents switching product type', async () => {
    await expect(
      service.update('product', { productType: 'CUSTOM_DESIGN' }, admin),
    ).rejects.toThrow('cannot be changed');
  });
  it('rejects admin-set custom-design price and finished stock', () => {
    expect(() =>
      service.create({ ...dto, productType: 'CUSTOM_DESIGN' }, admin),
    ).toThrow('calculated');
  });
});
