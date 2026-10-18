import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';

export const DESIGN_SIDES = ['FRONT', 'BACK'] as const;
export type DesignSide = (typeof DESIGN_SIDES)[number];

/**
 * Builder-wide category settings. Garment shape, mockups, print areas and price live
 * on each Garment; this only holds settings shared by a whole category, e.g.
 * { "silhouette": "NECKLACE" } for a jewelry strand.
 */
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(message: string): never {
  throw new BadRequestException('Invalid builderConfig: ' + message);
}

export function validateBuilderConfig(
  value: unknown,
): Prisma.InputJsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) invalid('must be an object or null');
  for (const key of Object.keys(value))
    if (!['silhouette'].includes(key)) invalid(`unknown field ${key}`);
  const result: Record<string, Prisma.InputJsonValue> = {};
  if (value.silhouette !== undefined) {
    if (
      typeof value.silhouette !== 'string' ||
      !/^[A-Z][A-Z_]{0,39}$/.test(value.silhouette)
    )
      invalid('silhouette must be an uppercase identifier such as NECKLACE');
    result.silhouette = value.silhouette;
  }
  return result as Prisma.InputJsonObject;
}

/**
 * Builders whose designs are composed freely on a canvas, so every placed component
 * keeps its x/y/scale/rotation. APPAREL is two-sided (FRONT/BACK); BOUQUET and GIFT
 * have one canvas, and x/y are the item centre, normalised 0–1 within it.
 */
export const CANVAS_BUILDERS = ['APPAREL', 'BOUQUET', 'GIFT'] as const;

export function isCanvasBuilder(builderType: string | null | undefined) {
  return (CANVAS_BUILDERS as readonly string[]).includes(builderType ?? '');
}

/** Builders that may carry personalised text layers (not priced, no stock). */
export const TEXT_BUILDERS = ['GIFT'] as const;
