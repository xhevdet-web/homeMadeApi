import {
  Controller,
  Get,
  Inject,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { StorageService } from './storage.service.js';
import { BackgroundRemovalService } from './background-removal.service.js';

@Controller('images')
export class ImagesController {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(BackgroundRemovalService)
    private readonly backgroundRemoval: BackgroundRemovalService,
  ) {}

  /**
   * Fallback image delivery through the API origin, used only when IMAGE_PROXY_URL points
   * here and R2_PUBLIC_URL is not configured. Normal images are served directly by R2/CDN.
   */
  @Get()
  async get(
    @Query('key') key: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const image = await this.storage.download(key);
    response.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    if (image.contentType)
      response.setHeader('Content-Type', image.contentType);
    if (image.contentLength !== undefined)
      response.setHeader('Content-Length', image.contentLength);
    return new StreamableFile(image.body);
  }

  /** Lets the admin UI show whether "Remove background" can be used: { enabled, available }. */
  @Get('background-removal')
  backgroundRemovalStatus() {
    return this.backgroundRemoval.status();
  }
}
