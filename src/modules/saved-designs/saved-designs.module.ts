import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SavedDesignsController } from './saved-designs.controller.js';
import { SavedDesignsService } from './saved-designs.service.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [SavedDesignsController],
  providers: [SavedDesignsService],
})
export class SavedDesignsModule {}
