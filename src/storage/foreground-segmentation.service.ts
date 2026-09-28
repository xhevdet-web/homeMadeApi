import {
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

/** Local U²-Net saliency segmentation, using rembg's model normalization. */
@Injectable()
export class ForegroundSegmentationService implements OnModuleDestroy {
  private session?: Promise<ort.InferenceSession>;

  private getSession() {
    if (!this.session) {
      this.session = ort.InferenceSession.create(
        resolve(
          process.env.BACKGROUND_REMOVAL_MODEL_PATH ||
            '.models/birefnet-general-lite.onnx',
        ),
        {
          executionProviders: ['cpu'],
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
        },
      ).catch(() => {
        this.session = undefined;
        throw new ServiceUnavailableException(
          'Background removal model is unavailable; run images:prepare-model on the server',
        );
      });
    }
    return this.session;
  }

  async mask(rgb: Buffer, width: number, height: number): Promise<Buffer> {
    const session = await this.getSession();
    const pixels = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .resize(1024, 1024, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer();
    let maximum = 1;
    for (const value of pixels) maximum = Math.max(maximum, value);
    const plane = 1024 * 1024;
    const input = new Float32Array(3 * plane);
    const mean = [0.485, 0.456, 0.406];
    const deviation = [0.229, 0.224, 0.225];
    for (let pixel = 0; pixel < plane; pixel++)
      for (let channel = 0; channel < 3; channel++)
        input[channel * plane + pixel] =
          (pixels[pixel * 3 + channel] / maximum - mean[channel]) /
          deviation[channel];
    const outputs = await session.run({
      [session.inputNames[0]]: new ort.Tensor(
        'float32',
        input,
        [1, 3, 1024, 1024],
      ),
    });
    const logits = outputs[session.outputNames[0]].data as Float32Array;
    if (logits.length !== plane)
      throw new ServiceUnavailableException(
        'Background removal model returned an invalid mask',
      );
    // BiRefNet exports logits. Apply sigmoid before normalizing the alpha mask.
    const predictions = Float32Array.from(
      logits,
      (value) => 1 / (1 + Math.exp(-value)),
    );
    let minimum = Infinity;
    let max = -Infinity;
    for (const value of predictions) {
      minimum = Math.min(minimum, value);
      max = Math.max(max, value);
    }
    if (
      !Number.isFinite(minimum) ||
      !Number.isFinite(max) ||
      max - minimum < 1e-6
    )
      throw new ServiceUnavailableException(
        'Unable to identify the foreground; please try another photo',
      );
    const alpha = Buffer.alloc(plane);
    for (let pixel = 0; pixel < plane; pixel++)
      alpha[pixel] = Math.round(
        Math.max(
          0,
          Math.min(1, (predictions[pixel] - minimum) / (max - minimum)),
        ) * 255,
      );
    // Undo the input's square stretch without cover-cropping the mask on portrait/landscape photos.
    return sharp(alpha, { raw: { width: 1024, height: 1024, channels: 1 } })
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
      .toColourspace('b-w')
      .raw()
      .toBuffer();
  }

  async onModuleDestroy() {
    if (this.session)
      await (await this.session.catch(() => undefined))?.release();
  }
}
