import { Module } from '@nestjs/common';
import { DesignsController } from './designs.controller.js';
import { DesignsService } from './designs.service.js';
import { DesignPricingService } from './design-pricing.service.js';

@Module({
  controllers: [DesignsController],
  providers: [DesignsService, DesignPricingService],
  exports: [DesignsService],
})
export class DesignsModule {}

