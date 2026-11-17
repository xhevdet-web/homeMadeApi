import { BadRequestException } from '@nestjs/common';
import { validatePrintAreas } from './print-area.js';

// Phone case templates: printable area (corners, bleed, safe area) and camera opening.
describe('validatePrintAreas for phone case templates', () => {
  const front = { x: 0.03, y: 0.015, width: 0.94, height: 0.97, radius: 0.14 };
  const camera = { x: 0.07, y: 0.025, width: 0.4, height: 0.19, radius: 0.22 };
  const rejects = (value: unknown) =>
    expect(() => validatePrintAreas(value)).toThrow(BadRequestException);

  it('keeps an existing single-radius template exactly as it was', () => {
    expect(validatePrintAreas({ front, camera })).toEqual({ front, camera });
  });

  it('accepts four corner radii, a bleed and a safe area on the printable area', () => {
    const advanced = {
      ...front,
      radii: { tl: 0.18, tr: 0.18, br: 0.12, bl: 0.12 },
      bleed: 0.03,
      safe: { top: 0.2, right: 0.05, bottom: 0.05, left: 0.05 },
    };
    const cam = { ...camera, radii: { tl: 0.3, tr: 0.1, br: 0.1, bl: 0.3 } };
    expect(validatePrintAreas({ front: advanced, camera: cam })).toEqual({
      front: advanced,
      camera: cam,
    });
  });

  it('rejects negative, empty or out-of-bounds geometry', () => {
    rejects({ front: { ...front, width: 0 } });
    rejects({ front: { ...front, height: -0.2 } });
    rejects({ front: { ...front, x: -0.1 } });
    rejects({ front: { ...front, x: 0.5, width: 0.6 } });
    rejects({ front: { ...front, y: 1.2 } });
    rejects({ front: { ...front, width: Number.NaN } });
  });

  it('rejects invalid corner radii', () => {
    rejects({ front: { ...front, radius: 0.6 } });
    rejects({ front: { ...front, radii: { tl: 0.1, tr: 0.1, br: 0.1 } } });
    rejects({
      front: { ...front, radii: { tl: 0.1, tr: 0.1, br: 0.1, bl: -0.1 } },
    });
    rejects({
      front: { ...front, radii: { tl: 0.1, tr: 0.1, br: 0.1, bl: 0.7 } },
    });
    rejects({
      front: { ...front, radii: { tl: 0.1, tr: 0.1, br: 0.1, bl: 0.1, x: 0 } },
    });
    rejects({ front: { ...front, radii: [0.1, 0.1, 0.1, 0.1] } });
  });

  it('rejects an invalid bleed', () => {
    rejects({ front: { ...front, bleed: -0.01 } });
    rejects({ front: { ...front, bleed: 0.2 } });
    rejects({ front: { ...front, bleed: '0.03' } });
  });

  it('rejects an invalid safe area', () => {
    rejects({ front: { ...front, safe: 0.05 } });
    rejects({
      front: { ...front, safe: { top: 0.05, right: 0.05, bottom: 0.05 } },
    });
    rejects({
      front: {
        ...front,
        safe: { top: 0.5, right: 0.05, bottom: 0.05, left: 0.05 },
      },
    });
    rejects({
      front: { ...front, safe: { top: -0.1, right: 0, bottom: 0, left: 0 } },
    });
    rejects({
      front: { ...front, safe: { top: 0, right: 0.46, bottom: 0, left: 0 } },
    });
  });

  it('rejects bleed or a safe area on the camera opening', () => {
    rejects({ front, camera: { ...camera, bleed: 0.02 } });
    rejects({
      front,
      camera: { ...camera, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    });
  });

  it('rejects invalid camera dimensions or a camera outside the printable area', () => {
    rejects({ front, camera: { ...camera, width: 0 } });
    rejects({ front, camera: { ...camera, height: 0.9, y: 0.5 } });
    rejects({
      front: { x: 0.5, y: 0.5, width: 0.4, height: 0.4 },
      camera: { x: 0.05, y: 0.05, width: 0.2, height: 0.2 },
    });
  });
});
