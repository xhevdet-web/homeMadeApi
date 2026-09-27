import { AuthModule } from '../auth/auth.module.js';
import { AdminGuard } from '../../common/guards/admin.guard.js';
import { StorageModule } from '../../storage/storage.module.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';

@Module({
  imports: [DatabaseModule, AuthModule, StorageModule],
  controllers: [CategoriesController],
  providers: [CategoriesService, AdminGuard],
  exports: [CategoriesService],
})
export class CategoriesModule {}
