import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { SubCategoriesController } from './sub-categories.controller.js';
import { SubCategoriesService } from './sub-categories.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [SubCategoriesController],
  providers: [SubCategoriesService],
  exports: [SubCategoriesService],
})
export class SubCategoriesModule {}
