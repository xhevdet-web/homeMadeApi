import sharp, { type OutputInfo } from 'sharp';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../storage/image-limits.js';
import { WorkerError } from './worker-error.js';

export interface Segmenter {
  mask(rgb: Buffer, width: number, height: number): Promise<Buffer>;
}

/** `image: null` means the upload must be stored unchanged (it already has transparency). */
export interface ForegroundResult {
  image: Buffer | null;
}

/** Turns an opaque photo into a cropped, lossless transparent PNG of its foreground. */
export class ForegroundProcessor {
  constructor(private readonly segmenter: Segmenter) {}

  async process(input: Buffer): Promise<ForegroundResult> {
    let decoded: { data: Buffer; info: OutputInfo };
    try {
      const image = sharp(input, {
        limitInputPixels: MAX_IMAGE_PIXELS,
        failOn: 'error',
      });
      const metadata = await image.metadata();
      if ((metadata.pages ?? 1) > 1) throw new Error('Animated image');
      decoded = await image
        .autoOrient()
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new WorkerError(
        400,
        'Image cannot be decoded; upload a static JPEG, PNG or WebP of at most 16 megapixels',
      );
    }
    const { data, info } = decoded;
    const { width, height } = info;
    for (let pixel = 3; pixel < data.length; pixel += 4)
      // Existing alpha is authoritative: keep source PNG/WebP bytes, including soft edges and holes.
      if (data[pixel] < 255) return { image: null };

    const rgb = Buffer.alloc(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel++)
      for (let channel = 0; channel < 3; channel++)
        rgb[pixel * 3 + channel] = data[pixel * 4 + channel];
    const alpha = await this.segmenter.mask(rgb, width, height);
    if (alpha.length !== width * height)
      throw new Error('Invalid segmentation mask');
    let left = width,
      top = height,
      right = -1,
      bottom = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x;
        data[pixel * 4 + 3] = alpha[pixel];
        if (alpha[pixel] > 0) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    if (right < left)
      throw new WorkerError(
        400,
        'No foreground detected; please upload another photo',
      );
    // Crop only fully transparent margins; keep a two-pixel guard around antialiased edges.
    left = Math.max(0, left - 2);
    top = Math.max(0, top - 2);
    right = Math.min(width - 1, right + 2);
    bottom = Math.min(height - 1, bottom + 2);
    const buffer = await sharp(data, { raw: { width, height, channels: 4 } })
      .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
    if (buffer.length > MAX_IMAGE_BYTES)
      throw new WorkerError(
        400,
        'Processed image exceeds 5 MB; please upload a smaller image',
      );
    return { image: buffer };
  }
}
