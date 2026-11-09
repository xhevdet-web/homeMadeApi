import sharp from 'sharp';
import { ForegroundProcessor, type Segmenter } from './foreground-processor.js';
import { WorkerError } from './worker-error.js';

describe('Foreground image processing', () => {
  const mask = vi.fn<Segmenter['mask']>();
  const processor = new ForegroundProcessor({ mask });
  beforeEach(() => {
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
      const { image } = await processor.process(original);
      const { data, info } = await sharp(image!)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect((await sharp(image!).metadata()).format).toBe('png');
      expect(info).toMatchObject({ width: 20, height: 20, channels: 4 });
      expect(data[3]).toBe(0);
      const edge = (2 * info.width + 2) * 4;
      expect([...data.subarray(edge, edge + 4)]).toEqual([255, 255, 255, 128]);
      const center = (10 * info.width + 10) * 4;
      expect([...data.subarray(center, center + 4)]).toEqual([
        255, 255, 255, 255,
      ]);
      expect(mask).toHaveBeenCalledOnce();
    },
  );
  it.each(['png', 'webp'] as const)(
    'keeps existing %s transparency by returning no replacement image',
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
      expect(await processor.process(buffer)).toEqual({ image: null });
      expect(mask).not.toHaveBeenCalled();
    },
  );
  it('rejects an undecodable PNG before inference with a 400 error', async () => {
    const buffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=',
      'base64',
    );
    await expect(processor.process(buffer)).rejects.toMatchObject({
      status: 400,
    });
    expect(mask).not.toHaveBeenCalled();
  });
  it('rejects an empty mask instead of producing an invisible product', async () => {
    mask.mockResolvedValue(Buffer.alloc(32 * 32));
    const buffer = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const error = await processor.process(buffer).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerError);
    expect(error).toMatchObject({
      status: 400,
      message: 'No foreground detected; please upload another photo',
    });
  });
});
