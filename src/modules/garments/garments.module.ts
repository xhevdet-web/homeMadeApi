import { AuthModule } from '../auth/auth.module.js';
import { AdminGuard } from '../../common/guards/admin.guard.js';
import { StorageModule } from '../../storage/storage.module.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { GarmentsController } from './garments.controller.js';
import { GarmentsService } from './garments.service.js';

@Module({
  imports: [DatabaseModule, AuthModule, StorageModule],
  controllers: [GarmentsController],
  providers: [GarmentsService, AdminGuard],
  exports: [GarmentsService],
})
export class GarmentsModule {}
