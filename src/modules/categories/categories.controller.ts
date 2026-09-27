import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { AdminGuard } from '../../common/guards/admin.guard.js';
import { ImageUpload } from '../../storage/image-upload.decorator.js';
import { ApiTags } from '@nestjs/swagger';
import {
  UseGuards,
  Body,
  UploadedFile,
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
} from '@nestjs/common';
import { CategoriesService } from './categories.service.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(
    @Inject(CategoriesService) private readonly service: CategoriesService,
  ) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }

  @Get(':id/sub-categories')
  findSubCategories(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findSubCategories(id);
  }

  @ImageUpload('category')
  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(
    @Body() dto: CreateCategoryDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.create(dto, file);
  }

  @ImageUpload('category', true)
  @Patch(':id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCategoryDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.update(id, dto, file);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.remove(id);
  }
}
