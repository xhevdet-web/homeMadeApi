import { resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { WorkerError } from './worker-error.js';

const SIZE = 1024;
const PLANE = SIZE * SIZE;

export interface SegmenterOptions {
  modelPath?: string;
  threads?: number;
}

/**
 * BiRefNet General Lite saliency segmentation, using rembg's model normalization.
 * Runs only inside the background-removal job process, never in the API.
 */
export class ForegroundSegmenter {
  private session?: Promise<ort.InferenceSession>;

  constructor(private readonly options: SegmenterOptions = {}) {}

  private getSession() {
    if (!this.session) {
      const threads = Math.max(1, Math.floor(this.options.threads ?? 2));
      this.session = ort.InferenceSession.create(
        resolve(this.options.modelPath || '.models/birefnet-general-lite.onnx'),
        {
          executionProviders: ['cpu'],
          intraOpNumThreads: threads,
          interOpNumThreads: 1,
          executionMode: 'sequential',
          // BiRefNet's input is fixed at 1024², which alone needs ~5.4–6 GB per run. Measured
          // peaks (2 threads): 'all' 6.0 GB / 39 s, 'disabled' 5.4 GB / 45 s. Memory is the
          // constraint on small servers, so trade a little speed for the lower peak.
          graphOptimizationLevel: 'disabled',
          // The arena and memory pattern keep peak-sized buffers alive between runs.
          enableCpuMemArena: false,
          enableMemPattern: false,
        },
      ).catch(() => {
        this.session = undefined;
        throw new WorkerError(
          503,
          'Background removal model is unavailable; run images:prepare-model on the server',
        );
      });
    }
    return this.session;
  }

  /** Loads the model ahead of the first job. */
  async load(): Promise<void> {
    await this.getSession();
  }

  async mask(rgb: Buffer, width: number, height: number): Promise<Buffer> {
    const session = await this.getSession();
    const pixels = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer();
    let maximum = 1;
    for (const value of pixels) maximum = Math.max(maximum, value);
    const input = new Float32Array(3 * PLANE);
    const mean = [0.485, 0.456, 0.406];
    const deviation = [0.229, 0.224, 0.225];
    for (let pixel = 0; pixel < PLANE; pixel++)
      for (let channel = 0; channel < 3; channel++)
        input[channel * PLANE + pixel] =
          (pixels[pixel * 3 + channel] / maximum - mean[channel]) /
          deviation[channel];
    const outputs = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', input, [
        1,
        3,
        SIZE,
        SIZE,
      ]),
    });
    const logits = outputs[session.outputNames[0]].data as Float32Array;
    if (logits.length !== PLANE)
      throw new WorkerError(
        503,
        'Background removal model returned an invalid mask',
      );
    // BiRefNet exports logits. Apply sigmoid in place, then normalize the alpha mask.
    let minimum = Infinity;
    let max = -Infinity;
    for (let pixel = 0; pixel < PLANE; pixel++) {
      const value = 1 / (1 + Math.exp(-logits[pixel]));
      logits[pixel] = value;
      minimum = Math.min(minimum, value);
      max = Math.max(max, value);
    }
    if (
      !Number.isFinite(minimum) ||
      !Number.isFinite(max) ||
      max - minimum < 1e-6
    )
      throw new WorkerError(
        400,
        'Unable to identify the foreground; please try another photo',
      );
    const alpha = Buffer.alloc(PLANE);
    for (let pixel = 0; pixel < PLANE; pixel++)
      alpha[pixel] = Math.round(
        Math.max(0, Math.min(1, (logits[pixel] - minimum) / (max - minimum))) *
          255,
      );
    // Undo the input's square stretch without cover-cropping the mask on portrait/landscape photos.
    return sharp(alpha, { raw: { width: SIZE, height: SIZE, channels: 1 } })
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
      .toColourspace('b-w')
      .raw()
      .toBuffer();
  }

  async release(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await (await session.catch(() => undefined))?.release();
  }
}
