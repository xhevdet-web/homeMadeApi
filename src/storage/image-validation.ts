import { BadRequestException } from '@nestjs/common';
import { extname } from 'node:path';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function validateImage(file: Express.Multer.File | undefined): string {
  if (!file?.buffer?.length)
    throw new BadRequestException('An image file is required');
  const buffer = file.buffer;
  if (buffer.length > MAX_IMAGE_BYTES || file.size > MAX_IMAGE_BYTES)
    throw new BadRequestException('Image must be at most 5 MB');
  // Check signatures as well as declared MIME: a renamed text/SVG file is not an image upload.
  const png =
    buffer.length >= 33 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString('ascii', 12, 16) === 'IHDR' &&
    buffer.toString('ascii', buffer.length - 8, buffer.length - 4) === 'IEND';
  const jpeg =
    buffer.length >= 4 &&
    buffer[0] === 255 &&
    buffer[1] === 216 &&
    buffer[2] === 255 &&
    buffer[buffer.length - 2] === 255 &&
    buffer[buffer.length - 1] === 217;
  const webp =
    buffer.length >= 20 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16)) &&
    buffer.readUInt32LE(4) + 8 === buffer.length;
  if (file.mimetype === 'image/png' && png) return '.png';
  if (file.mimetype === 'image/webp' && webp) return '.webp';
  if (file.mimetype === 'image/jpeg' && jpeg)
    return extname(file.originalname).toLowerCase() === '.jpeg'
      ? '.jpeg'
      : '.jpg';
  throw new BadRequestException(
    'Only valid JPEG, PNG and WebP image files are accepted',
  );
}
