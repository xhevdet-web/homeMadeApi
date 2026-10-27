import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Jewelry (bracelets and necklaces) is sized by real length, not by how many pieces it
 * holds: a size is a length range, the customer picks an exact length within it, and every
 * component occupies its physical length (an 8 mm bead takes 8 mm). Millimetres are the
 * canonical unit throughout.
 */

/**
 * How far a finished piece may differ from the chosen length. Components come in fixed
 * sizes, so an exact match is not always possible: a 200 mm bracelet is complete at
 * 198–202 mm and may never pass 202 mm.
 */
export const JEWELRY_LENGTH_TOLERANCE_MM = 2;
/** Upper bound for any length, as a sanity limit on input (1 m). */
export const MAX_MEASUREMENT_MM = 1000;

export interface MeasuredSize {
  id: string;
  name: string;
  minMeasurementMm: number;
  maxMeasurementMm: number;
  defaultMeasurementMm: number;
}
export type SelectedMeasuredSize = MeasuredSize & {
  selectedMeasurementMm: number;
};

/** A placed component as far as length goes: one entry per ProductItem. */
export interface Piece {
  name: string;
  quantity: number;
  effectiveLengthMm: number | null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const length = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) > 0 &&
  (value as number) <= MAX_MEASUREMENT_MM;

/** Jewelry (bracelets and necklaces) is sized by length; its components are measured. */
export function isJewelryCategory(
  category: { builderType?: string | null } | null | undefined,
) {
  return category?.builderType === 'JEWELRY';
}

/**
 * A jewelry category is a necklace when its builderConfig says so; categories configured
 * before the shape setting existed are recognised by name, exactly as the app does.
 * Every other jewelry category is a bracelet.
 */
export function isNecklaceCategory(
  category:
    | {
        builderType?: string | null;
        builderConfig?: unknown;
        name?: string | null;
      }
    | null
    | undefined,
) {
  if (category?.builderType !== 'JEWELRY') return false;
  const silhouette = object(category.builderConfig)
    ? category.builderConfig.silhouette
    : undefined;
  return typeof silhouette === 'string'
    ? silhouette === 'NECKLACE'
    : /neck/i.test(category.name ?? '');
}

/** A stored size in the measurement format, or null for legacy and malformed entries. */
export function measuredSize(value: unknown): MeasuredSize | null {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !length(value.minMeasurementMm) ||
    !length(value.maxMeasurementMm) ||
    !length(value.defaultMeasurementMm) ||
    value.maxMeasurementMm <= value.minMeasurementMm ||
    value.defaultMeasurementMm < value.minMeasurementMm ||
    value.defaultMeasurementMm > value.maxMeasurementMm
  )
    return null;
  return {
    id: value.id,
    name: value.name,
    minMeasurementMm: value.minMeasurementMm,
    maxMeasurementMm: value.maxMeasurementMm,
    defaultMeasurementMm: value.defaultMeasurementMm,
  };
}

/** The chosen size and exact length, as stored on a design; null for other sizes. */
export function selectedMeasuredSize(
  value: Prisma.JsonValue | null | undefined,
): SelectedMeasuredSize | null {
  const size = measuredSize(value);
  if (!size || !object(value) || !length(value.selectedMeasurementMm))
    return null;
  return { ...size, selectedMeasurementMm: value.selectedMeasurementMm };
}

const cm = (mm: number) => `${Math.round(mm) / 10} cm`;

/** Checks the customer's exact length against the size and returns the snapshot to store. */
export function selectMeasurement(
  size: MeasuredSize,
  selectedMeasurementMm: number | undefined,
): SelectedMeasuredSize {
  if (selectedMeasurementMm === undefined)
    throw new BadRequestException(`Choose the length for size ${size.name}`);
  if (
    !Number.isInteger(selectedMeasurementMm) ||
    selectedMeasurementMm < size.minMeasurementMm ||
    selectedMeasurementMm > size.maxMeasurementMm
  )
    throw new BadRequestException(
      `Size ${size.name} is ${cm(size.minMeasurementMm)} to ${cm(size.maxMeasurementMm)} long`,
    );
  return { ...size, selectedMeasurementMm };
}

/**
 * Total length the pieces occupy, from the database's component sizes (never a
 * client value). A component without a configured size cannot be measured, so it fails
 * clearly instead of counting as 0 mm.
 */
export function usedLengthMm(pieces: Piece[]) {
  let total = 0;
  for (const piece of pieces) {
    if (!length(piece.effectiveLengthMm))
      throw new BadRequestException(
        `${piece.name} does not have a physical size configured`,
      );
    if (!Number.isInteger(piece.quantity) || piece.quantity <= 0)
      throw new BadRequestException(
        'Component quantities must be positive integers',
      );
    total += piece.effectiveLengthMm * piece.quantity;
  }
  return total;
}

export const remainingLengthMm = (usedMm: number, selectedMm: number) =>
  selectedMm - usedMm;

/** Whether one more piece of `pieceMm` still fits the chosen length. */
export const canComponentFit = (
  usedMm: number,
  pieceMm: number,
  selectedMm: number,
) => usedMm + pieceMm <= selectedMm + JEWELRY_LENGTH_TOLERANCE_MM;

export const isLengthComplete = (usedMm: number, selectedMm: number) =>
  Math.abs(usedMm - selectedMm) <= JEWELRY_LENGTH_TOLERANCE_MM;

/** A saved design may be unfinished, but never longer than its chosen length. */
export function assertNotOverfilled(usedMm: number, selectedMm: number) {
  if (usedMm > selectedMm + JEWELRY_LENGTH_TOLERANCE_MM)
    throw new BadRequestException(
      `Your components measure ${cm(usedMm)}, longer than the chosen ${cm(selectedMm)}. Remove some components or choose a longer length.`,
    );
}

/** The lowest price, in cents, a jewelry design can be ordered at (€5.00). */
export const MIN_JEWELRY_PRICE_CENTS = 500;

/**
 * Jewelry designs may be ordered before they fill their chosen length; what they need is
 * the minimum price. `price` is the design's price in cents, before delivery.
 */
export function assertJewelryMinimumPrice(price: number, necklace = false) {
  if (price < MIN_JEWELRY_PRICE_CENTS)
    throw new BadRequestException(
      `${necklace ? 'Necklaces' : 'Bracelets'} start at €${(MIN_JEWELRY_PRICE_CENTS / 100).toFixed(2)}. Add a few more components to continue.`,
    );
}

/**
 * Validates the sizes an admin saves for a category. Jewelry sizes must be length ranges
 * (min < max, default within); every other category keeps the legacy shape. Returns only
 * the fields of the matching shape, so stale fields never linger in the stored JSON.
 */
export function normalizeCategorySizes(
  sizes: Record<string, unknown>[],
  measured: boolean,
): Prisma.InputJsonArray {
  return sizes.map((size, index) => {
    const label = `Size ${index + 1}`;
    if (measured) {
      const measured = measuredSize(size);
      if (!measured)
        throw new BadRequestException(
          `${label}: jewelry sizes need a minimum, maximum and default length in millimetres, with minimum < maximum and the default within them`,
        );
      return { ...measured };
    }
    const { id, name, measurement, unit, maxItems } = size;
    if (
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      typeof measurement !== 'number' ||
      !(measurement > 0) ||
      typeof unit !== 'string' ||
      !unit.trim() ||
      !Number.isInteger(maxItems) ||
      (maxItems as number) <= 0
    )
      throw new BadRequestException(
        `${label}: sizes need a measurement, unit and maxItems`,
      );
    return { id, name, measurement, unit, maxItems: maxItems as number };
  });
}
