import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateImage } from './image-validation.js';

export const BACKGROUND_REMOVAL_UNAVAILABLE =
  'Background removal is unavailable right now; please try again later or upload without background removal';
export const BACKGROUND_REMOVAL_TIMED_OUT =
  'Background removal timed out; please try again or upload without background removal';
export const BACKGROUND_REMOVAL_BUSY =
  'Background removal is busy; please try again in a minute';

/**
 * Sends opt-in background removal to the separate worker (src/background-worker).
 * This process never loads ONNX Runtime or the model, so a heavy or failing job can only
 * fail its own upload: the API stays up and keeps serving other requests meanwhile.
 */
@Injectable()
export class BackgroundRemovalService {
  private readonly logger = new Logger(BackgroundRemovalService.name);
  private pending = 0;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  /** BACKGROUND_REMOVAL_ENABLED=true turns the feature on; it is off when unset. */
  get enabled(): boolean {
    return ['true', '1', 'yes', 'on'].includes(
      String(this.config.get('BACKGROUND_REMOVAL_ENABLED') ?? '')
        .trim()
        .toLowerCase(),
    );
  }

  /** Only an explicit `removeBackground: true` opts in, and only while the feature is enabled. */
  shouldRemove(requested: unknown): boolean {
    return requested === true && this.enabled;
  }

  /**
   * Returns the foreground as PNG, or the original file unchanged when the feature is off
   * or the upload already has transparency. Failures throw clean 400/503 HTTP errors.
   */
  async remove(file: Express.Multer.File): Promise<Express.Multer.File> {
    if (!this.enabled) return file;
    validateImage(file);
    if (this.pending >= this.number('BACKGROUND_REMOVAL_MAX_PENDING', 3))
      throw new ServiceUnavailableException(BACKGROUND_REMOVAL_BUSY);
    this.pending++;
    try {
      return await this.request(file);
    } finally {
      this.pending--;
    }
  }

  /** Whether the admin UI can offer background removal. */
  async status(): Promise<{ enabled: boolean; available: boolean }> {
    if (!this.enabled) return { enabled: false, available: false };
    try {
      const response = await fetch(this.url('/health'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(2000),
      });
      return { enabled: true, available: response.ok };
    } catch {
      return { enabled: true, available: false };
    }
  }

  private async request(
    file: Express.Multer.File,
  ): Promise<Express.Multer.File> {
    // One deadline covers waiting in the worker queue, inference and the response body.
    // Aborting closes the connection, which also cancels the job in the worker.
    const signal = AbortSignal.timeout(
      // Longer than the worker's own job timeout, so its clearer error arrives first.
      this.number('BACKGROUND_REMOVAL_TIMEOUT_MS', 170_000),
    );
    let buffer: Buffer;
    try {
      const response = await fetch(this.url('/v1/remove-background'), {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': file.mimetype },
        // Node's fetch sends Buffers as-is; the DOM typing only lacks ArrayBufferLike support.
        body: file.buffer as unknown as BodyInit,
        signal,
      });
      if (response.status === 204) return file;
      if (!response.ok) throw await this.failure(response);
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      if (signal.aborted) {
        this.logger.warn('Background removal timed out');
        throw new ServiceUnavailableException(BACKGROUND_REMOVAL_TIMED_OUT);
      }
      // Connection refused/reset: the worker is stopped or restarting. Never echo the cause.
      this.logger.warn('Background removal worker is unreachable');
      throw new ServiceUnavailableException(BACKGROUND_REMOVAL_UNAVAILABLE);
    }
    const processed: Express.Multer.File = {
      ...file,
      buffer,
      size: buffer.length,
      mimetype: 'image/png',
      originalname: 'foreground.png',
    };
    try {
      validateImage(processed);
    } catch {
      this.logger.error('Background removal worker returned an invalid image');
      throw new ServiceUnavailableException(BACKGROUND_REMOVAL_UNAVAILABLE);
    }
    return processed;
  }

  private async failure(response: Response): Promise<Error> {
    let message: string | undefined;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === 'string' && body.message.length <= 300)
        message = body.message;
    } catch {
      /* The status alone decides the response. */
    }
    if (response.status === 401 || response.status === 403) {
      this.logger.error(
        'Background removal worker rejected the API; check BACKGROUND_REMOVAL_WORKER_TOKEN',
      );
      return new ServiceUnavailableException(BACKGROUND_REMOVAL_UNAVAILABLE);
    }
    // The photo itself cannot be processed (undecodable, no foreground, too large).
    if ([400, 413, 415, 422].includes(response.status))
      return new BadRequestException(
        message ?? 'Image cannot be processed; please try another photo',
      );
    this.logger.warn(
      'Background removal failed with worker status ' + response.status,
    );
    return new ServiceUnavailableException(
      response.status === 503 || response.status === 504
        ? (message ?? BACKGROUND_REMOVAL_UNAVAILABLE)
        : BACKGROUND_REMOVAL_UNAVAILABLE,
    );
  }

  private url(path: string): URL {
    const base =
      this.config.get<string>('BACKGROUND_REMOVAL_WORKER_URL')?.trim() ||
      'http://127.0.0.1:4100';
    return new URL(path, base);
  }

  private headers(): Record<string, string> {
    const token = this.config
      .get<string>('BACKGROUND_REMOVAL_WORKER_TOKEN')
      ?.trim();
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  private number(name: string, fallback: number): number {
    const value = Number(this.config.get(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
