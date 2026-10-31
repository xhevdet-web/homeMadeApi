import { ImageUpload } from '../../storage/image-upload.decorator.js';
import { ApiTags } from '@nestjs/swagger';
import {
  Body,
  UploadedFiles,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProductsService } from './products.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductQueryDto } from './dto/product-query.dto.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(
    @Inject(ProductsService) private readonly service: ProductsService,
  ) {}
  /** e.g. ?categoryId=…&origin=COMPANY — filtered in the database, not on the client. */
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  findAll(
    @Query() query: ProductQueryDto,
    @CurrentUser() viewer?: AuthenticatedUser,
  ) {
    return this.service.findAll(query, viewer);
  }
  @Get('creations/from-others')
  @UseGuards(JwtAuthGuard)
  findCompletedCreationsFromOthers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('categoryId', new ParseUUIDPipe({ optional: true }))
    categoryId?: string,
  ) {
    return this.service.findCompletedCreationsFromOthers(user, categoryId);
  }
  @Get('creations/community')
  @UseGuards(JwtAuthGuard)
  findCommunityGallery(
    @CurrentUser() user: AuthenticatedUser,
    @Query('categoryId', new ParseUUIDPipe({ optional: true }))
    categoryId?: string,
  ) {
    return this.service.findCommunityGallery(user, categoryId);
  }
  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() viewer?: AuthenticatedUser,
  ) {
    return this.service.findOne(id, viewer);
  }
  @ImageUpload('product')
  @Post()
  @UseGuards(JwtAuthGuard)
  create(
    @Body() dto: CreateProductDto,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFiles()
    files?: {
      file?: Express.Multer.File[];
      designPreview?: Express.Multer.File[];
      backDesignPreview?: Express.Multer.File[];
      customDesigns?: Express.Multer.File[];
      backImage?: Express.Multer.File[];
      overlayImage?: Express.Multer.File[];
    },
  ) {
    return this.service.create(
      dto,
      user,
      files?.file?.[0],
      files?.designPreview?.[0],
      files?.backDesignPreview?.[0],
      files?.customDesigns ?? [],
      files?.backImage?.[0],
      files?.overlayImage?.[0],
    );
  }
  @ImageUpload('product', true)
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFiles()
    files?: {
      file?: Express.Multer.File[];
      designPreview?: Express.Multer.File[];
      backDesignPreview?: Express.Multer.File[];
      backImage?: Express.Multer.File[];
      overlayImage?: Express.Multer.File[];
    },
  ) {
    return this.service.update(
      id,
      dto,
      user,
      files?.file?.[0],
      files?.designPreview?.[0],
      files?.backDesignPreview?.[0],
      files?.backImage?.[0],
      files?.overlayImage?.[0],
    );
  }
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.remove(id, user);
  }
}
