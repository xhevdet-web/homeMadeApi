import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { AdminGuard } from '../../common/guards/admin.guard.js';
import { ImageUpload } from '../../storage/image-upload.decorator.js';
import { ApiTags } from '@nestjs/swagger';
import {
  Body,
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
  Put,
  Query,
  UploadedFiles,
  UseGuards,
} from '@nestjs/common';
import { GarmentsService } from './garments.service.js';
import { CreateGarmentDto } from './dto/create-garment.dto.js';
import { UpdateGarmentDto } from './dto/update-garment.dto.js';
import { ReplaceGarmentVariantsDto } from './dto/garment-variant.dto.js';

type GarmentFiles = {
  image?: Express.Multer.File[];
  frontImage?: Express.Multer.File[];
  backImage?: Express.Multer.File[];
};
const firstFiles = (files?: GarmentFiles) => ({
  image: files?.image?.[0],
  frontImage: files?.frontImage?.[0],
  backImage: files?.backImage?.[0],
});

@ApiTags('garments')
@Controller()
export class GarmentsController {
  constructor(
    @Inject(GarmentsService) private readonly service: GarmentsService,
  ) {}

  /** Active garments with their active size × colour variants and stock. */
  @Get('categories/:categoryId/garments')
  findByCategory(@Param('categoryId', new ParseUUIDPipe()) categoryId: string) {
    return this.service.findByCategory(categoryId);
  }

  /** Admin list: every garment of a category, including inactive garments and variants. */
  @Get('garments')
  @UseGuards(JwtAuthGuard, AdminGuard)
  findAll(@Query('categoryId', new ParseUUIDPipe()) categoryId: string) {
    return this.service.findAll(categoryId);
  }

  @Get('garments/:id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }

  @ImageUpload('garment')
  @Post('garments')
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(@Body() dto: CreateGarmentDto, @UploadedFiles() files?: GarmentFiles) {
    return this.service.create(dto, firstFiles(files));
  }

  @ImageUpload('garment', true)
  @Patch('garments/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGarmentDto,
    @UploadedFiles() files?: GarmentFiles,
  ) {
    return this.service.update(id, dto, firstFiles(files));
  }

  /** Replaces the whole size × colour matrix in one request. */
  @Put('garments/:id/variants')
  @UseGuards(JwtAuthGuard, AdminGuard)
  replaceVariants(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReplaceGarmentVariantsDto,
  ) {
    return this.service.replaceVariants(id, dto.variants);
  }

  @Delete('garments/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.remove(id);
  }
}
