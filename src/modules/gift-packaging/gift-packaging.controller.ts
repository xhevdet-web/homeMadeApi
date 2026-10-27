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
import { GiftPackagingService } from './gift-packaging.service.js';
import { CreateGiftPackagingDto } from './dto/create-gift-packaging.dto.js';
import { UpdateGiftPackagingDto } from './dto/update-gift-packaging.dto.js';
import {
  CreateGiftPackagingColorDto,
  UpdateGiftPackagingColorDto,
} from './dto/gift-packaging-color.dto.js';

@ApiTags('gift-packaging')
@Controller('gift-packaging')
export class GiftPackagingController {
  constructor(
    @Inject(GiftPackagingService)
    private readonly service: GiftPackagingService,
  ) {}

  /** Every packaging option with its colours; the Gift Studio shows the active ones. */
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.findOne(id);
  }

  @ImageUpload('giftPackaging')
  @Post()
  @UseGuards(JwtAuthGuard, AdminGuard)
  create(
    @Body() dto: CreateGiftPackagingDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.create(dto, file);
  }

  @ImageUpload('giftPackaging', true)
  @Patch(':id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGiftPackagingDto,
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

  @ImageUpload('giftPackagingColor')
  @Post(':id/colors')
  @UseGuards(JwtAuthGuard, AdminGuard)
  addColor(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateGiftPackagingColorDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.addColor(id, dto, file);
  }

  @ImageUpload('giftPackagingColor', true)
  @Patch(':id/colors/:colorId')
  @UseGuards(JwtAuthGuard, AdminGuard)
  updateColor(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('colorId', new ParseUUIDPipe()) colorId: string,
    @Body() dto: UpdateGiftPackagingColorDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.updateColor(id, colorId, dto, file);
  }

  @Delete(':id/colors/:colorId')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeColor(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('colorId', new ParseUUIDPipe()) colorId: string,
  ) {
    return this.service.removeColor(id, colorId);
  }
}
