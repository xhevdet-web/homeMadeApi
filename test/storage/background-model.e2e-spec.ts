import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { ForegroundSegmentationService } from '../../src/storage/foreground-segmentation.service.js';
import { ImageProcessingService } from '../../src/storage/image-processing.service.js';

// Opt in: requires the provisioned BiRefNet General Lite model and real CPU inference, never contacts R2.
describe.skipIf(process.env.RUN_BACKGROUND_MODEL_TESTS !== '1')(
  'Real BiRefNet foreground segmentation',
  () => {
    const segmentation = new ForegroundSegmentationService();
    const processor = new ImageProcessingService(segmentation);
    afterAll(async () => segmentation.onModuleDestroy());
    it.each(['jpeg', 'png'] as const)(
      'keeps the real bracelet beads and clasp while removing the textured center (%s)',
      async (format) => {
        const source = await readFile(
          new URL(
            './fixtures/bracelet-on-textured-background.jpg',
            import.meta.url,
          ),
        );
        const buffer =
          format === 'jpeg' ? source : await sharp(source).png().toBuffer();
        const capture = vi.spyOn(segmentation, 'mask');
        try {
          const result = await processor.process({
            buffer,
            size: buffer.length,
            originalname: 'bracelet.' + format,
            mimetype: format === 'jpeg' ? 'image/jpeg' : 'image/png',
          } as Express.Multer.File);
          const alpha = (await capture.mock.results.at(-1)!.value) as Buffer;
          const { width, height } = await sharp(buffer).metadata();
          expect([width, height]).toEqual([482, 637]);
          // Bead centers across the black, red and amber sections, plus the silver clasp.
          for (const [x, y] of [
            [62, 300],
            [100, 188],
            [205, 132],
            [261, 139],
            [398, 299],
            [229, 508],
            [110, 452],
          ])
            expect(
              alpha[y * width! + x],
              `Foreground at ${x},${y}`,
            ).toBeGreaterThan(200);
          // The center of the bracelet and the surrounding tabletop must be transparent.
          for (const [x, y] of [
            [241, 318],
            [180, 280],
            [300, 350],
            [20, 20],
            [460, 600],
          ])
            expect(
              alpha[y * width! + x],
              `Background at ${x},${y}`,
            ).toBeLessThan(10);
          expect(result.mimetype).toBe('image/png');
          await mkdir('.temp/background-verification', { recursive: true });
          await writeFile(
            '.temp/background-verification/bracelet-' +
              format +
              '-processed.png',
            result.buffer,
          );
          await sharp(result.buffer)
            .flatten({ background: '#ffffff' })
            .png()
            .toFile(
              '.temp/background-verification/bracelet-' +
                format +
                '-white-preview.png',
            );
        } finally {
          capture.mockRestore();
        }
      },
      120000,
    );

    it.each(['jpeg', 'png', 'webp'] as const)(
      'segments a white pearl from its background for %s input',
      async (format) => {
        const svg =
          Buffer.from(`<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <defs><radialGradient id="pearl" cx="0.35" cy="0.3"><stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#eeeeeb"/><stop offset="1" stop-color="#aaaab8"/></radialGradient></defs>
      <rect width="512" height="512" fill="#7d91a8"/>
      <ellipse cx="266" cy="388" rx="122" ry="25" fill="#61748b"/>
      <circle cx="256" cy="250" r="125" fill="url(#pearl)"/>
      <ellipse cx="256" cy="147" rx="16" ry="6" fill="#555560"/>
    </svg>`);
        const buffer = await sharp(svg).toFormat(format).toBuffer();
        const result = await processor.process({
          buffer,
          size: buffer.length,
          originalname: 'pearl.' + format,
          mimetype: format === 'jpeg' ? 'image/jpeg' : 'image/' + format,
        } as Express.Multer.File);
        expect(result.mimetype).toBe('image/png');
        const { data, info } = await sharp(result.buffer)
          .raw()
          .toBuffer({ resolveWithObject: true });
        expect(info.channels).toBe(4);
        let transparent = 0,
          opaque = 0,
          soft = 0,
          lightForeground = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 10) transparent++;
          if (data[i + 3] > 240) opaque++;
          if (data[i + 3] > 10 && data[i + 3] < 240) soft++;
          if (
            data[i + 3] > 240 &&
            data[i] > 220 &&
            data[i + 1] > 220 &&
            data[i + 2] > 220
          )
            lightForeground++;
        }
        expect(transparent).toBeGreaterThan(1000);
        expect(opaque).toBeGreaterThan(10000);
        expect(soft).toBeGreaterThan(200);
        expect(lightForeground).toBeGreaterThan(5000);
        await mkdir('.temp/background-verification', { recursive: true });
        await writeFile(
          '.temp/background-verification/pearl-' + format + '-source.' + format,
          buffer,
        );
        await writeFile(
          '.temp/background-verification/pearl-' + format + '-processed.png',
          result.buffer,
        );
      },
      60000,
    );
  },
);
