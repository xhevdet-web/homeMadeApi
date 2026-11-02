import { Controller, Get, Inject, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { StorageService } from './storage.service.js';

/** Public image delivery through the API origin, for browsers where R2 CORS is unavailable. */
@Controller('images')
export class ImagesController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  @Get()
  async get(@Query('key') key: string, @Res({ passthrough: true }) response: Response) {
    const image = await this.storage.download(key);
    response.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    if (image.contentType) response.setHeader('Content-Type', image.contentType);
    if (image.contentLength !== undefined)
      response.setHeader('Content-Length', image.contentLength);
    return new StreamableFile(image.body);
  }
}
