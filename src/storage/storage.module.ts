import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { StorageService } from './storage.service.js';
import { ImageWriteService } from './image-write.service.js';
import { ImageResponseInterceptor } from './image-response.interceptor.js';
import { BackgroundRemovalService } from './background-removal.service.js';
import { ImagesController } from './images.controller.js';

@Module({
  imports: [ConfigModule],
  controllers: [ImagesController],
  providers: [
    // A worker client only: ONNX inference runs in the separate background-removal worker.
    BackgroundRemovalService,
    StorageService,
    ImageWriteService,
    { provide: APP_INTERCEPTOR, useClass: ImageResponseInterceptor },
  ],
  exports: [StorageService, ImageWriteService, BackgroundRemovalService],
})
export class StorageModule {}
