import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { ProductsService } from './products.service.js';

// Keep product listing routes together without coupling the parent modules to ProductsModule.
@Controller()
export class ProductRelationsController {
  constructor(
    @Inject(ProductsService) private readonly service: ProductsService,
  ) {}

  @Get('categories/:categoryId/products')
  findByCategory(@Param('categoryId', new ParseUUIDPipe()) categoryId: string) {
    return this.service.findByCategory(categoryId);
  }

  @Get('sub-categories/:subCategoryId/products')
  findBySubCategory(
    @Param('subCategoryId', new ParseUUIDPipe()) subCategoryId: string,
  ) {
    return this.service.findBySubCategory(subCategoryId);
  }

  @Get('users/:userId/products')
  findByUser(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.service.findByUser(userId);
  }
}
