import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { MAX_IMAGE_PIXELS } from './image-limits.js';

/**
 * Jewelry components are drawn edge to edge into a square of their physical size, so the
 * stored image must be the piece itself. Desktop background removal keeps the original
 * canvas, leaving a small piece in a large transparent area; this crops it back to the
 * visible piece as a centred square. One decode, no model, no worker.
 */

export interface TrimOptions {
  /** Pixels with alpha above this count as visible (0–255). */
  alphaThreshold?: number;
  /** Transparent margin around the piece, as a share of its longest side. */
  marginRatio?: number;
  /** Longest side of the output, in pixels. */
  maxSide?: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DEFAULT_ALPHA_THRESHOLD = 16;
const DEFAULT_MARGIN_RATIO = 0.02;
const DEFAULT_MAX_SIDE = 1024;
// Below this share removed on every side the image is already tight: keep it as uploaded.
const MIN_TRIM_SHARE = 0.02;

/**
 * Bounding box of the visible content in a raw RGBA buffer, or null when nothing is
 * visible. A row (column) counts as content only when at least max(2, 0.5% of its length)
 * of its pixels are above the alpha threshold, so isolated specks left by manual
 * background removal (dust, fibres, shadow remnants) do not stretch the box.
 */
export function contentBounds(
  rgba: Uint8Array,
  width: number,
  height: number,
  alphaThreshold = DEFAULT_ALPHA_THRESHOLD,
): Box | null {
  if (rgba.length < width * height * 4)
    throw new RangeError('RGBA buffer is smaller than width × height × 4');
  const rows = new Uint32Array(height);
  const columns = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    let offset = y * width * 4 + 3;
    for (let x = 0; x < width; x++, offset += 4)
      if (rgba[offset] > alphaThreshold) {
        rows[y]++;
        columns[x]++;
      }
  }
  // A row spans the image width; a column spans its height.
  const rowMin = Math.max(2, Math.ceil(width * 0.005));
  const columnMin = Math.max(2, Math.ceil(height * 0.005));
  const top = rows.findIndex((count) => count >= rowMin);
  const left = columns.findIndex((count) => count >= columnMin);
  if (top < 0 || left < 0) return null;
  const bottom = rows.findLastIndex((count) => count >= rowMin);
  const right = columns.findLastIndex((count) => count >= columnMin);
  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

/** Whether every pixel of a raw RGBA buffer is fully opaque. */
function fullyOpaque(rgba: Uint8Array) {
  for (let offset = 3; offset < rgba.length; offset += 4)
    if (rgba[offset] !== 255) return false;
  return true;
}

/**
 * Crops a transparent image to its visible piece as a centred square PNG (≤ maxSide px).
 * Returns the file unchanged when it has no transparency, nothing visible, or is already
 * tight; validation decides about the unchanged file as before.
 */
export async function trimTransparent(
  file: Express.Multer.File,
  options: TrimOptions = {},
): Promise<Express.Multer.File> {
  const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  const marginRatio = options.marginRatio ?? DEFAULT_MARGIN_RATIO;
  const maxSide = options.maxSide ?? DEFAULT_MAX_SIDE;
  let data: Buffer;
  let width: number;
  let height: number;
  try {
    const input = { limitInputPixels: MAX_IMAGE_PIXELS };
    // Header only: images without an alpha channel (JPEG) are never decoded.
    if (!(await sharp(file.buffer, input).metadata()).hasAlpha) return file;
    ({
      data,
      info: { width, height },
    } = await sharp(file.buffer, input)
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch {
    throw new BadRequestException('The image cannot be read');
  }
  if (fullyOpaque(data)) return file;
  const box = contentBounds(data, width, height, alphaThreshold);
  if (!box) return file;
  const gaps = [
    box.left / width,
    (width - box.left - box.width) / width,
    box.top / height,
    (height - box.top - box.height) / height,
  ];
  if (gaps.every((gap) => gap < MIN_TRIM_SHARE)) return file;

  const longest = Math.max(box.width, box.height);
  const side = Math.round(longest * (1 + 2 * marginRatio));
  const margin = Math.floor((side - longest) / 2);
  // The output square in source coordinates, with the piece centred in it.
  const squareLeft = box.left - Math.floor((side - box.width) / 2);
  const squareTop = box.top - Math.floor((side - box.height) / 2);
  // Copy the piece plus its margin (keeping soft, anti-aliased edges) but nothing further:
  // specks elsewhere in the square stay out. The rest is transparent padding.
  const x0 = Math.max(0, squareLeft, box.left - margin);
  const y0 = Math.max(0, squareTop, box.top - margin);
  const x1 = Math.min(width, squareLeft + side, box.left + box.width + margin);
  const y1 = Math.min(height, squareTop + side, box.top + box.height + margin);
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  let output: Buffer;
  try {
    // sharp always extends after resizing, so pad first and resize in a second step.
    const square = sharp(data, { raw: { width, height, channels: 4 } })
      .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
      .extend({
        left: x0 - squareLeft,
        top: y0 - squareTop,
        right: squareLeft + side - x1,
        bottom: squareTop + side - y1,
        background: transparent,
      });
    output =
      side > maxSide
        ? await sharp(await square.raw().toBuffer(), {
            raw: { width: side, height: side, channels: 4 },
          })
            .resize(maxSide, maxSide, { fit: 'inside' })
            .png()
            .toBuffer()
        : await square.png().toBuffer();
  } catch {
    throw new BadRequestException('The image cannot be processed');
  }
  return {
    ...file,
    buffer: output,
    size: output.length,
    mimetype: 'image/png',
    originalname: pngName(file.originalname),
  };
}

function pngName(name: string | undefined) {
  const base = (name || 'image').replace(/\.[^./\\]*$/, '');
  return (base || 'image') + '.png';
}
