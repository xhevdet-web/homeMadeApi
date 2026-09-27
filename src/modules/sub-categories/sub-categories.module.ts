import { AuthModule } from '../auth/auth.module.js';
import { AdminGuard } from '../../common/guards/admin.guard.js';
import { StorageModule } from '../../storage/storage.module.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { SubCategoriesController } from './sub-categories.controller.js';
import { SubCategoriesService } from './sub-categories.service.js';

@Module({
  imports: [DatabaseModule, AuthModule, StorageModule],
  controllers: [SubCategoriesController],
  providers: [SubCategoriesService, AdminGuard],
  exports: [SubCategoriesService],
})
export class SubCategoriesModule {}
