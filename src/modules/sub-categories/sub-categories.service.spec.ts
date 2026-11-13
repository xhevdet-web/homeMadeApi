import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../storage/storage.service.js';
import { ImageWriteService } from '../../storage/image-write.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { SubCategoriesService } from './sub-categories.service.js';

const jewelry = { id: 'jewelry', name: 'Bracelets', builderType: 'JEWELRY' };
const apparel = { id: 'apparel', name: 'Hoodies', builderType: 'APPAREL' };
const file = { originalname: 'bead.png' } as Express.Multer.File;

describe('SubCategoriesService image trimming', () => {
  const categories: Record<string, object> = {
    jewelry,
    apparel,
  };
  const prisma = {
    category: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return categories[where.id] ?? null;
      }),
    },
    subCategory: {
      findUnique: vi.fn(),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 's',
        ...data,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 's',
        ...data,
      })),
    },
  };
  const storage = new StorageService(new ConfigService());
  const images = new ImageWriteService(storage);
  const service = new SubCategoriesService(
    prisma as unknown as PrismaService,
    images,
  );
  const upload = vi.spyOn(storage, 'upload');
  const remove = vi.spyOn(storage, 'delete');
  const uploads = () =>
    upload.mock.calls.map(([, folder, process, trim]) => ({
      folder,
      process,
      trim,
    }));
  const existing = (category: typeof jewelry) => ({
    id: 's',
    categoryId: category.id,
    category,
    imageKey: 'subcategories/old.png',
    originalImageKey: null,
    effectiveLengthMm: 8,
  });
  beforeEach(() => {
    let count = 0;
    upload.mockReset().mockImplementation(async (_file, folder) => ({
      key: `${folder}/new-${++count}.png`,
    }));
    remove.mockReset().mockResolvedValue();
    prisma.subCategory.create.mockClear();
    prisma.subCategory.update.mockClear();
  });

  it('trims a new jewelry component and keeps the untouched upload as the original', async () => {
    await service.create(
      { categoryId: 'jewelry', name: 'Pearl', effectiveLengthMm: 8 },
      file,
    );
    expect(uploads()).toEqual([
      { folder: 'subcategories', process: false, trim: true },
      { folder: 'originals', process: false, trim: false },
    ]);
    expect(upload.mock.calls[1][0]).toBe(file);
    expect(prisma.subCategory.create.mock.calls[0][0].data).toMatchObject({
      imageKey: 'subcategories/new-1.png',
      originalImageKey: 'originals/new-2.png',
    });
  });

  it('does not trim components of other categories', async () => {
    await service.create({ categoryId: 'apparel', name: 'Logo' }, file);
    expect(uploads()).toEqual([
      { folder: 'subcategories', process: false, trim: false },
    ]);
    expect(
      prisma.subCategory.create.mock.calls[0][0].data.originalImageKey,
    ).toBeUndefined();
  });

  it('trims a replaced jewelry image and stores the new original', async () => {
    prisma.subCategory.findUnique.mockResolvedValue(existing(jewelry));
    await service.update('s', {}, file);
    expect(uploads()).toEqual([
      { folder: 'subcategories', process: false, trim: true },
      { folder: 'originals', process: false, trim: false },
    ]);
    expect(prisma.subCategory.update.mock.calls[0][0].data).toMatchObject({
      imageKey: 'subcategories/new-1.png',
      originalImageKey: 'originals/new-2.png',
    });
    expect(remove).toHaveBeenCalledExactlyOnceWith('subcategories/old.png');
  });

  it('decides on the final category when a component is moved', async () => {
    prisma.subCategory.findUnique.mockResolvedValue(existing(apparel));
    await service.update('s', { categoryId: 'jewelry' }, file);
    expect(uploads()[0]).toEqual({
      folder: 'subcategories',
      process: false,
      trim: true,
    });

    upload.mockClear();
    prisma.subCategory.findUnique.mockResolvedValue(existing(jewelry));
    await service.update('s', { categoryId: 'apparel' }, file);
    expect(uploads()).toEqual([
      { folder: 'subcategories', process: false, trim: false },
    ]);
  });

  it('uploads nothing when no file is supplied', async () => {
    prisma.subCategory.findUnique.mockResolvedValue(existing(jewelry));
    await service.update('s', { name: 'Renamed' });
    expect(upload).not.toHaveBeenCalled();
    expect(
      prisma.subCategory.update.mock.calls[0][0].data.originalImageKey,
    ).toBeUndefined();
  });
});
