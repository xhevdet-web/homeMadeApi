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
      !['x', 'y', 'width', 'height', 'widthCm', 'heightCm', 'radius'].includes(
        key,
      )
    )
      invalid(`unknown field ${key}`);
  const { x, y, width, height, widthCm, heightCm, radius } = value;
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
