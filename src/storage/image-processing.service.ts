import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import sharp, { type OutputInfo } from 'sharp';
import { ForegroundSegmentationService } from './foreground-segmentation.service.js';
import { MAX_IMAGE_BYTES, validateImage } from './image-validation.js';

const MAX_PIXELS = 16_000_000;

@Injectable()
export class ImageProcessingService {
  // Serialize decoding/inference, with a bounded queue to keep native memory usage predictable.
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    @Inject(ForegroundSegmentationService)
    private readonly segmentation = new ForegroundSegmentationService(),
  ) {}

  async process(file: Express.Multer.File): Promise<Express.Multer.File> {
    validateImage(file);
    if (this.pending >= 4)
      throw new ServiceUnavailableException(
        'Image processing is busy; please try again',
      );
    this.pending++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.processImage(file);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException(
        'Image processing failed; please try another photo',
      );
    } finally {
      this.pending--;
      release();
    }
  }

  private async processImage(
    file: Express.Multer.File,
  ): Promise<Express.Multer.File> {
    let decoded: { data: Buffer; info: OutputInfo };
    try {
      const image = sharp(file.buffer, {
        limitInputPixels: MAX_PIXELS,
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
      throw new BadRequestException(
        'Image cannot be decoded; upload a static JPEG, PNG or WebP of at most 16 megapixels',
      );
    }
    const { data, info } = decoded;
    const { width, height } = info;
    let transparent = false;
    for (let pixel = 3; pixel < data.length; pixel += 4)
      if (data[pixel] < 255) {
        transparent = true;
        break;
      }

    // Existing alpha is authoritative: preserve source PNG/WebP bytes, including soft edges and holes.
    if (transparent) return file;

    const rgb = Buffer.alloc(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel++)
      for (let channel = 0; channel < 3; channel++)
        rgb[pixel * 3 + channel] = data[pixel * 4 + channel];
    const alpha = await this.segmentation.mask(rgb, width, height);
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
      throw new BadRequestException(
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
      throw new BadRequestException(
        'Processed image exceeds 5 MB; please upload a smaller image',
      );
    return {
      ...file,
      buffer,
      size: buffer.length,
      mimetype: 'image/png',
      originalname: 'foreground.png',
    };
  }
}
