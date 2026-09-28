import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { StorageService } from './storage.service.js';
import { ImageWriteService } from './image-write.service.js';
import { ImageResponseInterceptor } from './image-response.interceptor.js';
import { ForegroundSegmentationService } from './foreground-segmentation.service.js';
import { ImageProcessingService } from './image-processing.service.js';

@Module({
  imports: [ConfigModule],
  providers: [
    ForegroundSegmentationService,
    ImageProcessingService,
    StorageService,
    ImageWriteService,
    { provide: APP_INTERCEPTOR, useClass: ImageResponseInterceptor },
  ],
  exports: [StorageService, ImageWriteService],
})
export class StorageModule {}
