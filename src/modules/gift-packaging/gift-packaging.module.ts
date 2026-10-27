import { AuthModule } from '../auth/auth.module.js';
import { AdminGuard } from '../../common/guards/admin.guard.js';
import { StorageModule } from '../../storage/storage.module.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { GiftPackagingController } from './gift-packaging.controller.js';
import { GiftPackagingService } from './gift-packaging.service.js';

@Module({
  imports: [DatabaseModule, AuthModule, StorageModule],
  controllers: [GiftPackagingController],
  providers: [GiftPackagingService, AdminGuard],
  exports: [GiftPackagingService],
})
export class GiftPackagingModule {}
