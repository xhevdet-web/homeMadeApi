import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Sticker shapes are options of the Stickers category, not categories of their own. A new
 * shape (e.g. a die-cut outline later) is added here and drawn by the app.
 */
export const STICKER_SHAPES = [
  'SQUARE',
  'CIRCLE',
  'RECTANGLE',
  'OVAL',
] as const;
export type StickerShape = (typeof STICKER_SHAPES)[number];

/** Shapes whose width and height are always equal (side, or diameter). */
const EQUAL_SIDES: readonly StickerShape[] = ['SQUARE', 'CIRCLE'];

/** The largest sticker that can be produced: 7 × 7 cm. Millimetres are authoritative. */
export const MAX_STICKER_MM = 70;
/** One sticker set holds 1 to 5 different designs, all in the same shape and size. */
export const MAX_STICKER_DESIGNS = 5;
/** The fewest stickers in one order: of a ready-made sticker, or in a whole set. */
export const MIN_STICKERS_PER_ORDER = 5;
/** Physical stickers of one design in one set. */
export const MAX_STICKERS_PER_DESIGN = 1000;

/**
 * A size the admin offers, e.g. "5 × 5 cm" square or "7 × 4 cm" oval, with its price per
 * printed sticker in cents. The customer's design keeps this as its size snapshot.
 */
export interface StickerSize {
  id: string;
  name: string;
  shape: StickerShape;
  widthMm: number;
  heightMm: number;
  price: number;
}

const millimetres = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= MAX_STICKER_MM;

/** Why a stored or submitted size cannot be a sticker size, or null when it is valid. */
function stickerSizeProblem(size: Record<string, unknown>): string | null {
  const { id, name, shape, widthMm, heightMm, price } = size;
  if (typeof id !== 'string' || !id.trim()) return 'needs an id';
  if (typeof name !== 'string' || !name.trim()) return 'needs a name';
  if (!STICKER_SHAPES.includes(shape as StickerShape))
    return 'needs a shape: ' + STICKER_SHAPES.join(', ');
  if (!millimetres(widthMm) || !millimetres(heightMm))
    return `width and height must be whole millimetres from 1 to ${MAX_STICKER_MM}`;
  if (EQUAL_SIDES.includes(shape as StickerShape) && widthMm !== heightMm)
    return 'a square or circle needs the same width and height';
  if (!Number.isInteger(price) || (price as number) < 0)
    return 'needs a price per sticker in cents (0 or more)';
  return null;
}

/** The size as a sticker size, or null when it is not one (or not valid). */
export function stickerSize(value: unknown): StickerSize | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const size = value as Record<string, unknown>;
  if (stickerSizeProblem(size)) return null;
  return {
    id: size.id as string,
    name: size.name as string,
    shape: size.shape as StickerShape,
    widthMm: size.widthMm as number,
    heightMm: size.heightMm as number,
    price: size.price as number,
  };
}

/** Admin input for a Stickers category: every size must be a valid sticker size. */
export function normalizeStickerSizes(
  sizes: Record<string, unknown>[],
): Prisma.InputJsonArray {
  return sizes.map((size, index) => {
    const problem = stickerSizeProblem(size);
    if (problem)
      throw new BadRequestException(`Sticker size ${index + 1}: ${problem}`);
    return { ...stickerSize(size)! };
  });
}
