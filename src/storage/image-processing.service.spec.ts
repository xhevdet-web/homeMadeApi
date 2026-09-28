import sharp from 'sharp';
import { ImageProcessingService } from './image-processing.service.js';
import { ForegroundSegmentationService } from './foreground-segmentation.service.js';

const upload = (buffer: Buffer, mimetype: string) =>
  ({
    buffer,
    size: buffer.length,
    mimetype,
    originalname: 'original',
  }) as Express.Multer.File;
describe('Foreground image processing', () => {
  const segmentation = new ForegroundSegmentationService();
  const mask = vi.spyOn(segmentation, 'mask');
  let processor: ImageProcessingService;
  beforeEach(() => {
    processor = new ImageProcessingService(segmentation);
    mask.mockReset().mockImplementation(async (_rgb, width, height) => {
      const result = Buffer.alloc(width * height);
      for (let y = 8; y < height - 8; y++)
        for (let x = 8; x < width - 8; x++)
          result[y * width + x] = x === 8 ? 128 : 255;
      return result;
    });
  });
  it.each(['jpeg', 'png', 'webp'] as const)(
    'turns opaque %s into lossless transparent PNG while preserving white foreground and soft edges',
    async (format) => {
      const original = await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#ffffff' },
      })
        .toFormat(format)
        .toBuffer();
      const result = await processor.process(
        upload(original, format === 'jpeg' ? 'image/jpeg' : 'image/' + format),
      );
      expect(result.mimetype).toBe('image/png');
      const { data, info } = await sharp(result.buffer)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(info).toMatchObject({ width: 20, height: 20, channels: 4 });
      expect(data[3]).toBe(0);
      const edge = (2 * info.width + 2) * 4;
      expect([...data.subarray(edge, edge + 4)]).toEqual([255, 255, 255, 128]);
      const center = (10 * info.width + 10) * 4;
      expect([...data.subarray(center, center + 4)]).toEqual([
        255, 255, 255, 255,
      ]);
      expect(result.size).toBe(result.buffer.length);
      expect(mask).toHaveBeenCalledOnce();
    },
  );
  it.each(['png', 'webp'] as const)(
    'preserves existing %s transparency and pixels byte for byte',
    async (format) => {
      const buffer = await sharp({
        create: {
          width: 32,
          height: 32,
          channels: 4,
          background: { r: 255, g: 250, b: 240, alpha: 0.5 },
        },
      })
        .toFormat(format)
        .toBuffer();
      const file = upload(buffer, 'image/' + format);
      expect(await processor.process(file)).toBe(file);
      expect(mask).not.toHaveBeenCalled();
    },
  );
  it('rejects an undecodable signed PNG before inference', async () => {
    const buffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=',
      'base64',
    );
    await expect(
      processor.process(upload(buffer, 'image/png')),
    ).rejects.toMatchObject({ status: 400 });
    expect(mask).not.toHaveBeenCalled();
  });
  it('returns a sanitized processing failure and lets the next upload proceed', async () => {
    const buffer = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    mask.mockRejectedValueOnce(new Error('private-native-detail'));
    await expect(
      processor.process(upload(buffer, 'image/png')),
    ).rejects.toThrow('Image processing failed');
    expect(
      (await processor.process(upload(buffer, 'image/png'))).mimetype,
    ).toBe('image/png');
  });
  it('rejects an empty mask instead of uploading an invisible product', async () => {
    mask.mockResolvedValue(Buffer.alloc(32 * 32));
    const buffer = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await expect(
      processor.process(upload(buffer, 'image/png')),
    ).rejects.toThrow('No foreground detected');
  });
});
