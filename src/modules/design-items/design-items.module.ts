import { Module } from '@nestjs/common';
import { DesignItemsController } from './design-items.controller.js';
import { DesignItemsService } from './design-items.service.js';

@Module({
  controllers: [DesignItemsController],
  providers: [DesignItemsService],
  exports: [DesignItemsService],
})
export class DesignItemsModule {}

