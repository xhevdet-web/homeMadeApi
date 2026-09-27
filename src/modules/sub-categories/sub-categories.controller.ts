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
import { SubCategoriesService } from './sub-categories.service.js';
import { CreateSubCategoryDto } from './dto/create-sub-category.dto.js';
import { UpdateSubCategoryDto } from './dto/update-sub-category.dto.js';

@ApiTags('sub-categories')
@Controller('sub-categories')
export class SubCategoriesController {
  constructor(
    @Inject(SubCategoriesService)
    private readonly service: SubCategoriesService,
  ) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }

  @ImageUpload('subCategory')
  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(
    @Body() dto: CreateSubCategoryDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.create(dto, file);
  }

  @ImageUpload('subCategory', true)
  @Patch(':id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSubCategoryDto,
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
