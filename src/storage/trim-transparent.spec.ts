import sharp from 'sharp';
import { contentBounds, trimTransparent } from './trim-transparent.js';

const multer = (
  buffer: Buffer,
  mimetype = 'image/png',
  originalname = 'bead.png',
) =>
  ({
    fieldname: 'file',
    originalname,
    mimetype,
    buffer,
    size: buffer.length,
  }) as Express.Multer.File;

/** Transparent RGBA canvas with an opaque red circle and optional 1–2 px specks. */
function canvas(
  width: number,
  height: number,
  {
    diameter = 175,
    centre = [width / 2, height / 2],
    specks = [] as [number, number, number][],
  } = {},
) {
  const rgba = Buffer.alloc(width * height * 4);
  const radius = diameter / 2;
  const [cx, cy] = centre;
  const paint = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    rgba[offset] = 200;
    rgba[offset + 3] = 255;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius ** 2) paint(x, y);
  for (const [x, y, size] of specks)
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) paint(x + dx, y + dy);
  return rgba;
}

const png = (rgba: Buffer, width: number, height: number) =>
  sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

async function pixels(buffer: Buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, ...info };
}

const corners: [number, number, number][] = [
  [10, 12, 1],
  [1185, 20, 2],
  [30, 1580, 2],
  [1190, 1590, 1],
  [600, 40, 2],
];

describe('contentBounds', () => {
  it('finds the visible piece in a raw RGBA buffer', () => {
    const rgba = canvas(200, 100, { diameter: 40, centre: [60, 50] });
    expect(contentBounds(rgba, 200, 100)).toEqual({
      left: 40,
      top: 30,
      width: 40,
      height: 40,
    });
  });

  it('ignores isolated specks and faint pixels below the alpha threshold', () => {
    const rgba = canvas(1200, 1600, { specks: corners });
    // A large but nearly invisible haze (alpha 10) is not content either.
    for (let offset = 3; offset < 400 * 4; offset += 4) rgba[offset] = 10;
    const box = contentBounds(rgba, 1200, 1600)!;
    expect(box.left).toBeGreaterThanOrEqual(511);
    expect(box.top).toBeGreaterThanOrEqual(711);
    expect(box.left + box.width).toBeLessThanOrEqual(689);
    expect(box.top + box.height).toBeLessThanOrEqual(889);
    expect(box.width).toBeGreaterThanOrEqual(172);
    expect(box.height).toBeGreaterThanOrEqual(172);
  });

  it('returns null when nothing is visible', () => {
    expect(contentBounds(Buffer.alloc(50 * 40 * 4), 50, 40)).toBeNull();
    // A single speck is never enough to count as content.
    const speck = Buffer.alloc(50 * 40 * 4);
    speck[(10 * 50 + 10) * 4 + 3] = 255;
    expect(contentBounds(speck, 50, 40)).toBeNull();
  });

  it('rejects a buffer that does not match the dimensions', () => {
    expect(() => contentBounds(Buffer.alloc(10), 5, 5)).toThrow(RangeError);
  });
});

describe('trimTransparent', () => {
  it.each([
    ['a clean canvas', []],
    ['specks near the corners', corners],
  ])(
    'crops a small bead on a large canvas to a centred square (%s)',
    async (_case, specks) => {
      const source = await png(
        canvas(1200, 1600, { specks: specks as [number, number, number][] }),
        1200,
        1600,
      );
      const result = await trimTransparent(
        multer(source, 'image/png', 'bead.PNG'),
      );
      expect(result).toMatchObject({
        mimetype: 'image/png',
        originalname: 'bead.png',
        size: result.buffer.length,
      });
      const { data, width, height } = await pixels(result.buffer);
      expect(width).toBe(height);
      expect(Math.abs(width - 182)).toBeLessThanOrEqual(2);
      // The circle is centred: equal transparent gaps on every side.
      const box = contentBounds(data, width, height)!;
      const gaps = [
        box.left,
        box.top,
        width - box.left - box.width,
        height - box.top - box.height,
      ];
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(2);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2);
      expect(Math.abs(box.width - 175)).toBeLessThanOrEqual(2);
      expect(data[((height >> 1) * width + (width >> 1)) * 4 + 3]).toBe(255);
      expect(data[3]).toBe(0);
    },
  );

  it('centres a wide piece vertically inside the square', async () => {
    const rgba = Buffer.alloc(800 * 600 * 4);
    for (let y = 280; y < 320; y++)
      for (let x = 100; x < 500; x++) rgba[(y * 800 + x) * 4 + 3] = 255;
    const result = await trimTransparent(multer(await png(rgba, 800, 600)));
    const { data, width, height } = await pixels(result.buffer);
    expect([width, height]).toEqual([416, 416]);
    expect(contentBounds(data, width, height)).toEqual({
      left: 8,
      top: 188,
      width: 400,
      height: 40,
    });
  });

  it('keeps a piece touching the canvas edge whole and pads the rest', async () => {
    const source = await png(
      canvas(1000, 1000, { diameter: 200, centre: [100, 500] }),
      1000,
      1000,
    );
    const { data, width, height } = await pixels(
      (await trimTransparent(multer(source))).buffer,
    );
    expect([width, height]).toEqual([208, 208]);
    expect(contentBounds(data, width, height)).toMatchObject({
      left: 4,
      width: 200,
    });
  });

  it('downscales large pieces to at most 1024 px', async () => {
    const source = await png(
      canvas(3000, 2400, { diameter: 2000 }),
      3000,
      2400,
    );
    const { width, height } = await pixels(
      (await trimTransparent(multer(source))).buffer,
    );
    expect(width).toBe(height);
    expect(width).toBeLessThanOrEqual(1024);
    expect(width).toBeGreaterThan(1000);
  });

  it('applies EXIF orientation before cropping', async () => {
    const rgba = Buffer.alloc(400 * 200 * 4);
    for (let y = 20; y < 60; y++)
      for (let x = 300; x < 380; x++) rgba[(y * 400 + x) * 4 + 3] = 255;
    // Orientation 6: displayed rotated 90° clockwise, so the bar stands upright.
    const source = await sharp(rgba, {
      raw: { width: 400, height: 200, channels: 4 },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    const { data, width, height } = await pixels(
      (await trimTransparent(multer(source))).buffer,
    );
    const box = contentBounds(data, width, height)!;
    expect(box.height).toBe(80);
    expect(box.width).toBe(40);
  });

  it.each([
    [
      'an opaque JPEG',
      () =>
        sharp({
          create: { width: 300, height: 200, channels: 3, background: 'white' },
        })
          .jpeg()
          .toBuffer(),
      'image/jpeg',
    ],
    [
      'an opaque PNG with an alpha channel',
      () =>
        sharp({
          create: {
            width: 300,
            height: 200,
            channels: 4,
            background: { r: 9, g: 9, b: 9, alpha: 1 },
          },
        })
          .png()
          .toBuffer(),
      'image/png',
    ],
    [
      'a fully transparent PNG',
      () => png(Buffer.alloc(300 * 200 * 4), 300, 200),
      'image/png',
    ],
    [
      'a PNG with only specks',
      () =>
        png(canvas(300, 200, { diameter: 0, specks: [[5, 5, 1]] }), 300, 200),
      'image/png',
    ],
    [
      'a piece that already fills the canvas',
      () => png(canvas(200, 200, { diameter: 199.5 }), 200, 200),
      'image/png',
    ],
  ])('returns %s unchanged', async (_case, make, mimetype) => {
    const input = multer(await make(), mimetype, 'piece.jpg');
    expect(await trimTransparent(input)).toBe(input);
  });

  it('rejects undecodable bytes with a client error', async () => {
    await expect(
      trimTransparent(multer(Buffer.from('not an image'))),
    ).rejects.toMatchObject({ status: 400 });
  });
});
