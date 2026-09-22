import { Module } from '@nestjs/common';
import { CustomizationItemsController } from './customization-items.controller.js';
import { CustomizationItemsService } from './customization-items.service.js';

@Module({
  controllers: [CustomizationItemsController],
  providers: [CustomizationItemsService],
  exports: [CustomizationItemsService],
})
export class CustomizationItemsModule {}

