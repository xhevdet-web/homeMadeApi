import { ForegroundSegmentationService } from './foreground-segmentation.service.js';

const runtime = vi.hoisted(() => ({ run: vi.fn(), release: vi.fn() }));
vi.mock('onnxruntime-node', () => ({
  InferenceSession: {
    create: vi.fn(async () => ({
      inputNames: ['input'],
      outputNames: ['mask'],
      ...runtime,
    })),
  },
  Tensor: class {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  },
}));

describe('Segmentation geometry', () => {
  it.each([
    [482, 637],
    [637, 482],
  ])(
    'maps a square model mask back to the complete %s × %s photo without cropping',
    async (width, height) => {
      // A narrow foreground feature left of center must stay aligned in both aspect ratios.
      const logits = new Float32Array(1024 * 1024).fill(-12);
      for (let y = 450; y < 575; y++)
        for (let x = 190; x < 270; x++) logits[y * 1024 + x] = 12;
      runtime.run.mockResolvedValue({ mask: { data: logits } });
      const segmentation = new ForegroundSegmentationService();
      try {
        const mask = await segmentation.mask(
          Buffer.alloc(width * height * 3, 128),
          width,
          height,
        );
        expect(mask.length).toBe(width * height);
        expect(
          mask[Math.floor(height * 0.5) * width + Math.floor(width * 0.22)],
        ).toBeGreaterThan(240);
        expect(
          mask[Math.floor(height * 0.5) * width + Math.floor(width * 0.5)],
        ).toBe(0);
        expect(
          mask[Math.floor(height * 0.1) * width + Math.floor(width * 0.22)],
        ).toBe(0);
      } finally {
        await segmentation.onModuleDestroy();
      }
    },
  );
});
