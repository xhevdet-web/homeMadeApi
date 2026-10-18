import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs';
import { StorageService } from './storage.service.js';

@Injectable()
export class ImageResponseInterceptor implements NestInterceptor {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map((value: unknown) => this.images(value)));
  }
  private images(value: unknown): unknown {
    if (Array.isArray(value))
      return value.map((item: unknown) => this.images(item));
    if (
      !value ||
      typeof value !== 'object' ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return value;
    const record = value as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, this.images(item)]),
    );
    // imageKey, frontImageKey, originalImageKey, designPreviewKey, backDesignPreviewKey…
    for (const [key, item] of Object.entries(record))
      if (
        /^(?:imageKey|[a-z][A-Za-z]*(?:ImageKey|PreviewKey))$/.test(key) &&
        (item === null || typeof item === 'string')
      )
        result[key.replace(/Key$/, 'Url')] = this.storage.getPublicUrl(item);
    return result;
  }
}
