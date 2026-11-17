import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * An apparel side's printable area, as fractions (0–1) of its canvas image, with an
 * optional real print size in centimetres so placements can be converted to exact
 * production measurements:
 *
 * { "x": 0.3, "y": 0.28, "width": 0.4, "height": 0.42, "widthCm": 30, "heightCm": 40 }
 *
 * Phone cases round the area's corners: `radius` is a fraction (0–0.5) of its width, or
 * `radii` sets each corner ({ tl, tr, br, bl }, same unit) and wins over `radius`. The
 * printable area of a case may also have a `bleed` (how far artwork runs past its edge so
 * no unprinted rim shows, 0–0.1) and a `safe` area ({ top, right, bottom, left } insets
 * where important artwork stays), both fractions of the area's width so every side gets
 * the same physical distance. Old templates without them keep working: radii fall back to
 * `radius`, bleed is 0 and there is no safe area.
 * The blank mug gives its print size in whole millimetres, with the safe margins that
 * important artwork stays inside: { ..., "widthMm": 200, "heightMm": 80,
 * "safeMm": { "top": 5, "right": 5, "bottom": 5, "left": 5 } }.
 */
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fraction = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

/** Largest bleed, as a fraction of the printable width (10%). */
export const MAX_BLEED = 0.1;
/** Largest safe-area inset on one side, as a fraction of the printable width. */
export const MAX_SAFE_INSET = 0.45;
const CORNERS = ['tl', 'tr', 'br', 'bl'] as const;
const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** An object with exactly these keys, each a fraction from 0 to max. */
function fractions<K extends string>(
  value: unknown,
  keys: readonly K[],
  max: number,
): Record<K, number> | null {
  if (!object(value)) return null;
  if (Object.keys(value).some((key) => !keys.includes(key as K))) return null;
  if (!keys.every((key) => fraction(value[key]) && value[key] <= max))
    return null;
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Record<
    K,
    number
  >;
}

export function validatePrintArea(
  value: unknown,
  side: string,
): Prisma.InputJsonObject | undefined {
  // Bleed and the safe area belong to the printable area, never to the camera opening.
  const printable = side !== 'camera';
  if (value === undefined || value === null) return undefined;
  const invalid: (message: string) => never = (message) => {
    throw new BadRequestException(`Invalid ${side} print area: ${message}`);
  };
  if (!object(value)) invalid('must be an object or null');
  for (const key of Object.keys(value))
    if (
      ![
        'x',
        'y',
        'width',
        'height',
        'widthCm',
        'heightCm',
        'radius',
        'widthMm',
        'heightMm',
        'safeMm',
        'radii',
        ...(printable ? ['bleed', 'safe'] : []),
      ].includes(key)
    )
      invalid(`unknown field ${key}`);
  const {
    x,
    y,
    width,
    height,
    widthCm,
    heightCm,
    radius,
    widthMm,
    heightMm,
    safeMm,
    radii,
    bleed,
    safe,
  } = value;
  if (![x, y, width, height].every(fraction))
    invalid('x, y, width and height must be fractions from 0 to 1');
  const area = { x, y, width, height } as Record<
    string,
    number | Prisma.InputJsonObject
  >;
  if (
    (width as number) <= 0 ||
    (height as number) <= 0 ||
    (x as number) + (width as number) > 1 ||
    (y as number) + (height as number) > 1
  )
    invalid('must have a size and stay inside the mockup');
  for (const [key, cm] of [
    ['widthCm', widthCm],
    ['heightCm', heightCm],
  ] as const) {
    if (cm === undefined) continue;
    if (typeof cm !== 'number' || !Number.isFinite(cm) || cm <= 0 || cm > 200)
      invalid(`${key} must be a number of centimetres from 0 to 200`);
    area[key] = cm;
  }
  if (radius !== undefined) {
    if (!fraction(radius) || radius > 0.5)
      invalid('radius must be a fraction of the width from 0 to 0.5');
    area.radius = radius;
  }
  if (radii !== undefined) {
    const corners = fractions(radii, CORNERS, 0.5);
    if (!corners)
      invalid(
        'radii must be { tl, tr, br, bl }, each a fraction of the width from 0 to 0.5',
      );
    area.radii = corners;
  }
  if (bleed !== undefined) {
    if (!fraction(bleed) || bleed > MAX_BLEED)
      invalid(`bleed must be a fraction of the width from 0 to ${MAX_BLEED}`);
    area.bleed = bleed;
  }
  if (safe !== undefined) {
    // At most 45% per side, so the safe area always keeps some room inside.
    const insets = fractions(safe, SIDES, MAX_SAFE_INSET);
    if (!insets)
      invalid(
        `safe must be { top, right, bottom, left }, each a fraction of the width from 0 to ${MAX_SAFE_INSET}`,
      );
    area.safe = insets;
  }
  const millimetres = (mm: unknown, max: number) =>
    Number.isInteger(mm) && (mm as number) >= 0 && (mm as number) <= max;
  for (const [key, mm] of [
    ['widthMm', widthMm],
    ['heightMm', heightMm],
  ] as const) {
    if (mm === undefined) continue;
    if (!millimetres(mm, 2000) || mm === 0)
      invalid(`${key} must be whole millimetres from 1 to 2000`);
    area[key] = mm as number;
  }
  if (safeMm !== undefined) {
    const sizeMm = area as Record<string, number>;
    if (sizeMm.widthMm === undefined || sizeMm.heightMm === undefined)
      invalid('safeMm needs widthMm and heightMm');
    if (!object(safeMm))
      invalid('safeMm must be { top, right, bottom, left } in millimetres');
    for (const key of Object.keys(safeMm))
      if (!['top', 'right', 'bottom', 'left'].includes(key))
        invalid(`unknown safeMm field ${key}`);
    const { top = 0, right = 0, bottom = 0, left = 0 } = safeMm;
    if (
      ![top, right, bottom, left].every((mm) => millimetres(mm, 2000)) ||
      (left as number) + (right as number) >= sizeMm.widthMm ||
      (top as number) + (bottom as number) >= sizeMm.heightMm
    )
      invalid(
        'safe margins must be whole millimetres that leave room inside the print size',
      );
    return {
      ...area,
      safeMm: { top, right, bottom, left } as Prisma.InputJsonObject,
    };
  }
  return area;
}

/**
 * A product's print areas, keyed by side: { "front": { ... }, "back": { ... } }. Phone
 * case models may add "camera": the camera opening, which artwork never covers.
 * Returns undefined when nothing is configured.
 */
export function validatePrintAreas(
  value: unknown,
): Prisma.InputJsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  if (!object(value))
    throw new BadRequestException('printAreas must be an object or null');
  for (const key of Object.keys(value))
    if (!['front', 'back', 'camera'].includes(key))
      throw new BadRequestException(`Invalid printAreas: unknown side ${key}`);
  const front = validatePrintArea(value.front, 'front');
  const back = validatePrintArea(value.back, 'back');
  const camera = validatePrintArea(value.camera, 'camera');
  if (!front && !back && !camera) return undefined;
  // The camera opening cuts into the printable area; one beside it would protect nothing.
  if (front && camera) {
    const [f, c] = [front, camera] as Record<string, number>[];
    if (
      c.x >= f.x + f.width ||
      c.x + c.width <= f.x ||
      c.y >= f.y + f.height ||
      c.y + c.height <= f.y
    )
      throw new BadRequestException(
        'Invalid camera print area: it must overlap the printable area',
      );
  }
  return {
    ...(front ? { front } : {}),
    ...(back ? { back } : {}),
    ...(camera ? { camera } : {}),
  };
}

/** Stored or validated print areas with a front area, e.g. a phone model or the blank mug. */
export function hasFrontArea(printAreas: unknown) {
  return object(printAreas) && object(printAreas.front);
}
