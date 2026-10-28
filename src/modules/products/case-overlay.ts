import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

// An overlay shows only the case edges and the camera island; everything else must be
// see-through, or it hides the customer's image in the studio and the preview.
const MIN_CLEAR_SHARE = 0.5;

/** Rejects a phone case overlay that is not a mostly transparent PNG. */
export async function assertSeeThroughOverlay(file?: Express.Multer.File) {
  if (!file) return;
  if (file.mimetype !== 'image/png')
    throw new BadRequestException('The case overlay must be a transparent PNG');
  let alpha: { data: Buffer; info: { width: number; height: number } };
  try {
    alpha = await sharp(file.buffer, { limitInputPixels: 16_000_000 })
      .ensureAlpha()
      .extractChannel('alpha')
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new BadRequestException(
      'The case overlay cannot be read; upload a PNG image',
    );
  }
  let clear = 0;
  for (const value of alpha.data) if (value < 128) clear++;
  if (clear / (alpha.info.width * alpha.info.height) < MIN_CLEAR_SHARE)
    throw new BadRequestException(
      'The case overlay must be mostly transparent: only the case edges and camera may be visible, so the customer’s image shows through. Leave the overlay empty if you do not have one.',
    );
}
