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
  UseGuards,
} from '@nestjs/common';
import { ProductsService } from './products.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';

@ApiTags('products')
@Controller('products')
export class ProductsController {
  constructor(
    @Inject(ProductsService) private readonly service: ProductsService,
  ) {}
  @Get()
  findAll() {
    return this.service.findAll();
  }
  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
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
    },
  ) {
    return this.service.create(
      dto,
      user,
      files?.file?.[0],
      files?.designPreview?.[0],
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
    },
  ) {
    return this.service.update(
      id,
      dto,
      user,
      files?.file?.[0],
      files?.designPreview?.[0],
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
