import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * An apparel side's printable area, as fractions (0–1) of its canvas image, with an
 * optional real print size in centimetres so placements can be converted to exact
 * production measurements:
 *
 * { "x": 0.3, "y": 0.28, "width": 0.4, "height": 0.42, "widthCm": 30, "heightCm": 40 }
 *
 * Phone cases round the area's corners: `radius` is a fraction (0–0.5) of its width.
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

export function validatePrintArea(
  value: unknown,
  side: string,
): Prisma.InputJsonObject | undefined {
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
  } = value;
  if (![x, y, width, height].every(fraction))
    invalid('x, y, width and height must be fractions from 0 to 1');
  const area = { x, y, width, height } as Record<string, number>;
  if (
    area.width <= 0 ||
    area.height <= 0 ||
    area.x + area.width > 1 ||
    area.y + area.height > 1
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
    if (area.widthMm === undefined || area.heightMm === undefined)
      invalid('safeMm needs widthMm and heightMm');
    if (!object(safeMm))
      invalid('safeMm must be { top, right, bottom, left } in millimetres');
    for (const key of Object.keys(safeMm))
      if (!['top', 'right', 'bottom', 'left'].includes(key))
        invalid(`unknown safeMm field ${key}`);
    const { top = 0, right = 0, bottom = 0, left = 0 } = safeMm;
    if (
      ![top, right, bottom, left].every((mm) => millimetres(mm, 2000)) ||
      (left as number) + (right as number) >= area.widthMm ||
      (top as number) + (bottom as number) >= area.heightMm
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
  return {
    ...(front ? { front } : {}),
    ...(back ? { back } : {}),
    ...(camera ? { camera } : {}),
  };
}
