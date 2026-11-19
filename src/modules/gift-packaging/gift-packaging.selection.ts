import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

const packagingSelect = {
  id: true,
  name: true,
  description: true,
  type: true,
  shape: true,
  imageKey: true,
  price: true,
  stock: true,
  capacity: true,
  allowedTypes: true,
  isActive: true,
  colors: {
    select: {
      id: true,
      name: true,
      hex: true,
      imageKey: true,
      priceAdjustment: true,
      stock: true,
      isActive: true,
    },
  },
} satisfies Prisma.GiftPackagingSelect;

type Packaging = Prisma.GiftPackagingGetPayload<{
  select: typeof packagingSelect;
}>;

// Shared by product and order responses: what a gift design arrives in, as it is now.
export const giftPackagingSelect = {
  id: true,
  name: true,
  description: true,
  type: true,
  shape: true,
  imageKey: true,
  price: true,
  capacity: true,
  isActive: true,
} satisfies Prisma.GiftPackagingSelect;

export const giftPackagingColorSelect = {
  id: true,
  name: true,
  hex: true,
  imageKey: true,
  priceAdjustment: true,
  isActive: true,
} satisfies Prisma.GiftPackagingColorSelect;

/**
 * The packaging and colour a GIFT design arrives in, checked against the database: it
 * exists and is active, a transparent one has no colour, a closed one with colours gets
 * one of its own active colours, and something is in stock. Stock is checked but never
 * taken here; orders take it. The price always comes from the database.
 */
async function resolve(
  tx: Prisma.TransactionClient,
  packagingId: string,
  colorId: string | null | undefined,
) {
  const packaging = await tx.giftPackaging.findUnique({
    where: { id: packagingId },
    select: packagingSelect,
  });
  if (!packaging) throw new BadRequestException('Gift packaging not found');
  if (!packaging.isActive)
    throw new BadRequestException(`${packaging.name} is no longer available`);
  if (packaging.type === 'TRANSPARENT' || !packaging.colors.length) {
    if (colorId)
      throw new BadRequestException(`${packaging.name} has no colours`);
    return { packaging, color: null };
  }
  if (!colorId)
    throw new BadRequestException(`Choose a colour of ${packaging.name}`);
  const color = packaging.colors.find((entry) => entry.id === colorId);
  if (!color)
    throw new BadRequestException(
      `This colour is not available for ${packaging.name}`,
    );
  if (!color.isActive)
    throw new BadRequestException(
      `${packaging.name} in ${color.name} is no longer available`,
    );
  return { packaging, color };
}

const stockOf = ({ packaging, color }: Awaited<ReturnType<typeof resolve>>) =>
  color ? color.stock : packaging.stock;

const label = ({ packaging, color }: Awaited<ReturnType<typeof resolve>>) =>
  color ? `${packaging.name} in ${color.name}` : packaging.name;

const items = (count: number) => `${count} item${count === 1 ? '' : 's'}`;

/** Item types are free text typed by the admin, so they match without regard to case or spaces. */
export const typeKey = (type: string | null | undefined) =>
  (type ?? '').trim().toLowerCase();

export interface GiftFit {
  name: string;
  capacity: number | null;
  allowedTypes: string[];
}

/**
 * What goes inside must fit the packaging: no more items than its capacity (quantities add
 * up; text is not an item) and, when it names allowed types, only items of those types.
 */
export async function assertGiftContents(
  tx: Prisma.TransactionClient,
  packaging: GiftFit,
  contents: { subCategoryId: string; quantity: number }[],
) {
  const count = contents.reduce((sum, item) => sum + item.quantity, 0);
  if (packaging.capacity !== null && count > packaging.capacity)
    throw new BadRequestException(
      `${packaging.name} holds up to ${items(packaging.capacity)}; remove ${items(count - packaging.capacity)} to fit`,
    );
  const allowed = new Set(packaging.allowedTypes.map(typeKey));
  if (!allowed.size || !contents.length) return;
  const components = await tx.subCategory.findMany({
    where: {
      id: { in: [...new Set(contents.map((item) => item.subCategoryId))] },
    },
    select: { name: true, type: true },
    orderBy: { name: 'asc' },
  });
  const misfit = components.find(
    (component) => !allowed.has(typeKey(component.type)),
  );
  if (misfit)
    throw new BadRequestException(
      `${misfit.name} does not fit in ${packaging.name}`,
    );
}

/**
 * Fields a new design stores. Only CUSTOMER GIFT designs may have packaging; every other
 * product keeps all three empty. The design's items must fit the chosen packaging.
 */
export async function giftPackagingFields(
  tx: Prisma.TransactionClient,
  design: { builderType: string | null; company: boolean },
  packagingId: string | undefined,
  colorId: string | undefined,
  contents: { subCategoryId: string; quantity: number }[] = [],
) {
  if (!packagingId) {
    if (colorId)
      throw new BadRequestException('Choose the packaging of this colour');
    return {
      giftPackagingId: null,
      giftPackagingColorId: null,
      packagingPrice: 0,
    };
  }
  if (design.company || design.builderType !== 'GIFT')
    throw new BadRequestException(
      'Only customer gift designs can have gift packaging',
    );
  const selection = await resolve(tx, packagingId, colorId);
  if (stockOf(selection) < 1)
    throw new BadRequestException(`${label(selection)} is sold out`);
  await assertGiftContents(tx, selection.packaging, contents);
  return {
    giftPackagingId: selection.packaging.id,
    giftPackagingColorId: selection.color?.id ?? null,
    packagingPrice:
      selection.packaging.price + (selection.color?.priceAdjustment ?? 0),
  };
}

/**
 * Re-checks the design's packaging when it is ordered and takes one from stock: the
 * colour's stock for coloured packaging, else the packaging's. The conditional update
 * is safe against concurrent orders, like component stock.
 */
export async function takeGiftPackagingStock(
  tx: Prisma.TransactionClient,
  packagingId: string,
  colorId: string | null,
): Promise<Packaging & { color: Packaging['colors'][number] | null }> {
  const selection = await resolve(tx, packagingId, colorId);
  const reserved = selection.color
    ? await tx.giftPackagingColor.updateMany({
        where: { id: selection.color.id, isActive: true, stock: { gte: 1 } },
        data: { stock: { decrement: 1 } },
      })
    : await tx.giftPackaging.updateMany({
        where: { id: packagingId, isActive: true, stock: { gte: 1 } },
        data: { stock: { decrement: 1 } },
      });
  if (reserved.count !== 1)
    throw new BadRequestException(`${label(selection)} is sold out`);
  return { ...selection.packaging, color: selection.color };
}
