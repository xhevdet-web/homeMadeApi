import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StorageService } from './storage.service.js';

@Injectable()
export class ImageWriteService {
  private readonly logger = new Logger(ImageWriteService.name);
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** Whether a request's `removeBackground` value actually turns background removal on. */
  removesBackground(requested: unknown): boolean {
    return this.storage.removesBackground(requested);
  }

  async save<T>(
    file: Express.Multer.File | undefined,
    folder: string,
    write: (
      key?: string,
    ) => Promise<{ result: T; oldKeys?: (string | null | undefined)[] }>,
    process = false,
  ): Promise<T> {
    return this.saveMany([{ file, folder, process }], ([key]) => write(key));
  }

  async saveMany<T>(
    // `process` requests background removal; it is never applied unless set to true.
    uploads: {
      file?: Express.Multer.File;
      folder: string;
      process?: boolean;
    }[],
    write: (keys: (string | undefined)[]) => Promise<{
      result: T;
      oldKeys?: (string | null | undefined)[];
    }>,
  ): Promise<T> {
    const keys: (string | undefined)[] = [];
    let saved: Awaited<ReturnType<typeof write>>;
    try {
      for (const { file, folder, process } of uploads)
        keys.push(
          file
            ? (await this.storage.upload(file, folder, process === true)).key
            : undefined,
        );
      saved = await write(keys);
    } catch (error) {
      try {
        await this.cleanup(keys);
      } catch {
        // The cleanup helper logs only object keys, never SDK errors or credentials.
        this.logger.error('Write failed and uploaded images need cleanup');
      }
      throw error;
    }
    await this.cleanup(saved.oldKeys ?? []);
    return saved.result;
  }

  async cleanup(keys: (string | null | undefined)[]): Promise<void> {
    const failed: string[] = [];
    for (const key of new Set(
      keys.filter((value): value is string => !!value),
    )) {
      let removed = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.storage.delete(key);
          removed = true;
          break;
        } catch {
          /* Retry idempotent object deletion once. */
        }
      }
      if (!removed) failed.push(key);
    }
    if (failed.length) {
      this.logger.error('R2 objects require cleanup: ' + failed.join(', '));
      throw new ServiceUnavailableException({
        message:
          'Database operation completed, but image cleanup failed. Do not repeat the mutation; contact an administrator.',
        databaseCommitted: true,
      });
    }
  }
}
