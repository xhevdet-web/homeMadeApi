import { StorageModule } from '../../storage/storage.module.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProductsController } from './products.controller.js';
import { ProductRelationsController } from './product-relations.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [DatabaseModule, AuthModule, StorageModule],
  controllers: [ProductsController, ProductRelationsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
