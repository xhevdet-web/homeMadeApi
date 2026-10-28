import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { ProductsService } from './products.service.js';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';

// Keep product listing routes together without coupling the parent modules to ProductsModule.
// The viewer, when signed in, decides whether private customer designs are listed.
@Controller()
@UseGuards(OptionalJwtAuthGuard)
export class ProductRelationsController {
  constructor(
    @Inject(ProductsService) private readonly service: ProductsService,
  ) {}

  @Get('categories/:categoryId/products')
  findByCategory(
    @Param('categoryId', new ParseUUIDPipe()) categoryId: string,
    @CurrentUser() viewer?: AuthenticatedUser,
  ) {
    return this.service.findByCategory(categoryId, viewer);
  }

  @Get('sub-categories/:subCategoryId/products')
  findBySubCategory(
    @Param('subCategoryId', new ParseUUIDPipe()) subCategoryId: string,
    @CurrentUser() viewer?: AuthenticatedUser,
  ) {
    return this.service.findBySubCategory(subCategoryId, viewer);
  }

  @Get('users/:userId/products')
  findByUser(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @CurrentUser() viewer?: AuthenticatedUser,
  ) {
    return this.service.findByUser(userId, viewer);
  }
}
