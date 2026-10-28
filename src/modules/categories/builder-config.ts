import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';

export const DESIGN_SIDES = ['FRONT', 'BACK'] as const;
export type DesignSide = (typeof DESIGN_SIDES)[number];

/**
 * Builder-wide category settings shared by every product of the category, e.g.
 * { "silhouette": "NECKLACE" } for a jewelry strand or { "silhouette": "HOODIE" } for
 * the app-drawn apparel fallback. Images, print areas and price live on each Product.
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
 * have one canvas, and x/y are the item centre, normalised 0–1 within it. CASE has one
 * design, its centre normalised 0–1 within the model's printable area.
 */
export const CANVAS_BUILDERS = ['APPAREL', 'BOUQUET', 'GIFT', 'CASE'] as const;

/**
 * Phone cases: the customer picks a model (a COMPANY product with its own template) and
 * puts exactly one design on it, from the library or their own photo.
 */
export const CASE_BUILDER = 'CASE';

/** Builders printed on a COMPANY product chosen first: the garment, or the phone model. */
export const BASE_PRODUCT_BUILDERS = ['APPAREL', 'CASE'] as const;

/** Builders that offer the customer-upload SubCategory (CUSTOM_UPLOAD). */
export const UPLOAD_BUILDERS = ['APPAREL', 'CASE'] as const;

const listed = (list: readonly string[], builderType?: string | null) =>
  list.includes(builderType ?? '');
export const needsBaseProduct = (builderType?: string | null) =>
  listed(BASE_PRODUCT_BUILDERS, builderType);
export const acceptsUploads = (builderType?: string | null) =>
  listed(UPLOAD_BUILDERS, builderType);

export function isCanvasBuilder(builderType: string | null | undefined) {
  return (CANVAS_BUILDERS as readonly string[]).includes(builderType ?? '');
}

/**
 * Builders that may carry personalised text layers, e.g. a gift message, a bouquet card or
 * a name printed on a hoodie. Text is a studio tool: never priced, never stocked.
 */
export const TEXT_BUILDERS = ['GIFT', 'BOUQUET', 'APPAREL'] as const;
