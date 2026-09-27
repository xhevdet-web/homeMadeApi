import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { CategoriesModule } from './modules/categories/categories.module.js';
import { SubCategoriesModule } from './modules/sub-categories/sub-categories.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from './storage/storage.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    StorageModule,
    DatabaseModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    OrdersModule,
    CategoriesModule,
    SubCategoriesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
