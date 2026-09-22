import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AddressesModule } from './modules/addresses/addresses.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { CategoriesModule } from './modules/categories/categories.module.js';
import { CustomizationItemsModule } from './modules/customization-items/customization-items.module.js';
import { DesignsModule } from './modules/designs/designs.module.js';
import { DesignItemsModule } from './modules/design-items/design-items.module.js';
import { DiscoverModule } from './modules/discover/discover.module.js';
import { FavoritesModule } from './modules/favorites/favorites.module.js';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';


@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    UsersModule,
    AddressesModule,
    ProductsModule,
    CategoriesModule,
    CustomizationItemsModule,
    DesignsModule,
    DesignItemsModule,
    DiscoverModule,
    FavoritesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
