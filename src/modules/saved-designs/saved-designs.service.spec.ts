import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../database/prisma.service.js';
import {
  MAX_SAVED_DESIGNS,
  SavedDesignsService,
} from './saved-designs.service.js';

const ME = 'a1000000-0000-4000-8000-000000000001';
const OTHER = 'b1000000-0000-4000-8000-000000000002';
const PRODUCT = 'c1000000-0000-4000-8000-000000000003';
const SAVED = 'd1000000-0000-4000-8000-000000000004';

const myDesign = {
  id: PRODUCT,
  name: 'My Bracelet',
  origin: 'CUSTOMER',
  createdById: ME,
};

function setup() {
  const prisma = {
    product: { findUnique: vi.fn().mockResolvedValue(myDesign) },
    savedDesign: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(({ data }) => ({ id: SAVED, ...data })),
      update: vi.fn().mockImplementation(({ data }) => ({ id: SAVED, ...data })),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const service = new SavedDesignsService(prisma as unknown as PrismaService);
  return { prisma, service };
}

describe('SavedDesignsService', () => {
  it('lists only the signed-in customer’s saved designs', async () => {
    const { prisma, service } = setup();
    await service.findMine(ME);
    expect(prisma.savedDesign.findMany.mock.calls[0][0].where).toEqual({
      userId: ME,
    });
  });

  it('saves the customer’s own design, named after it by default', async () => {
    const { prisma, service } = setup();
    await service.create(ME, { productId: PRODUCT });
    expect(prisma.savedDesign.create.mock.calls[0][0].data).toEqual({
      userId: ME,
      productId: PRODUCT,
      name: 'My Bracelet',
    });
  });

  it.each([
    ['another customer’s design', { ...myDesign, createdById: OTHER }],
    ['a catalog product', { ...myDesign, origin: 'COMPANY' }],
    ['a missing product', null],
  ])('refuses to save %s', async (_label, product) => {
    const { prisma, service } = setup();
    prisma.product.findUnique.mockResolvedValue(product);
    await expect(
      service.create(ME, { productId: PRODUCT }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.savedDesign.create).not.toHaveBeenCalled();
  });

  it('stops at the saved design limit', async () => {
    const { prisma, service } = setup();
    prisma.savedDesign.count.mockResolvedValue(MAX_SAVED_DESIGNS);
    await expect(
      service.create(ME, { productId: PRODUCT }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('treats someone else’s saved design as not found', async () => {
    const { prisma, service } = setup();
    await expect(
      service.update(ME, SAVED, { name: 'Mine now' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.duplicate(ME, SAVED, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.savedDesign.findFirst.mock.calls[0][0].where).toEqual({
      id: SAVED,
      userId: ME,
    });
    expect(prisma.savedDesign.update).not.toHaveBeenCalled();
  });

  it('moves a saved design to a newer version of the customer’s own design', async () => {
    const { prisma, service } = setup();
    prisma.savedDesign.findFirst.mockResolvedValue({
      id: SAVED,
      name: 'Gift',
      productId: 'old',
    });
    await service.update(ME, SAVED, { productId: PRODUCT });
    expect(prisma.savedDesign.update.mock.calls[0][0].data).toEqual({
      name: undefined,
      productId: PRODUCT,
    });
  });

  it('duplicates as an independent saved design on the same version', async () => {
    const { prisma, service } = setup();
    prisma.savedDesign.findFirst.mockResolvedValue({
      id: SAVED,
      name: 'Gift',
      productId: PRODUCT,
    });
    await service.duplicate(ME, SAVED, {});
    expect(prisma.savedDesign.create.mock.calls[0][0].data).toEqual({
      userId: ME,
      productId: PRODUCT,
      name: 'Gift (copy)',
    });
  });

  it('deletes only the customer’s own saved design, never its product', async () => {
    const { prisma, service } = setup();
    await service.remove(ME, SAVED);
    expect(prisma.savedDesign.deleteMany).toHaveBeenCalledWith({
      where: { id: SAVED, userId: ME },
    });
    prisma.savedDesign.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.remove(ME, SAVED)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
