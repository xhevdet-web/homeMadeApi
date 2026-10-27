import { ImageWriteService } from '../../storage/image-write.service.js';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { CreateGiftPackagingDto } from './dto/create-gift-packaging.dto.js';
import type { UpdateGiftPackagingDto } from './dto/update-gift-packaging.dto.js';
import type {
  CreateGiftPackagingColorDto,
  UpdateGiftPackagingColorDto,
} from './dto/gift-packaging-color.dto.js';

// Packaging photos are stored as uploaded: a transparent box must keep its own look.
const FOLDER = 'packaging';

const sortOrder = [
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.GiftPackagingOrderByWithRelationInput[];

const include = {
  colors: { orderBy: sortOrder },
} satisfies Prisma.GiftPackagingInclude;

const IN_USE =
  'is used by customer gift designs; deactivate it instead so those designs stay intact';

@Injectable()
export class GiftPackagingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ImageWriteService) private readonly images: ImageWriteService,
  ) {}

  /** Every packaging with its colours; clients hide the inactive ones. */
  findAll() {
    return this.query(() =>
      this.prisma.giftPackaging.findMany({ orderBy: sortOrder, include }),
    );
  }

  async findOne(id: string) {
    const record = await this.query(() =>
      this.prisma.giftPackaging.findUnique({ where: { id }, include }),
    );
    if (!record) throw new NotFoundException('Gift packaging not found');
    return record;
  }

  create(dto: CreateGiftPackagingDto, file?: Express.Multer.File) {
    return this.images.save(file, FOLDER, async (key) => ({
      result: await this.query(() =>
        this.prisma.giftPackaging.create({
          data: {
            name: dto.name,
            description: dto.description,
            type: dto.type,
            shape: dto.shape,
            imageKey: key,
            price: dto.price,
            stock: dto.stock,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
          include,
        }),
      ),
    }));
  }

  async update(
    id: string,
    dto: UpdateGiftPackagingDto,
    file?: Express.Multer.File,
  ) {
    const previous = await this.findOne(id);
    // Transparency is a type, not a colour: a see-through box never keeps colours.
    if (dto.type === 'TRANSPARENT' && previous.colors.length)
      throw new BadRequestException(
        'Remove the colours of ' +
          previous.name +
          ' before making it transparent',
      );
    return this.images.save(file, FOLDER, async (key) => ({
      result: await this.query(() =>
        this.prisma.giftPackaging.update({
          where: { id },
          data: {
            name: dto.name,
            description: dto.description,
            type: dto.type,
            shape: dto.shape,
            imageKey: key,
            price: dto.price,
            stock: dto.stock,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
          include,
        }),
      ),
      oldKeys: key ? [previous.imageKey] : [],
    }));
  }

  async remove(id: string): Promise<void> {
    const record = await this.findOne(id);
    await this.query(
      () => this.prisma.giftPackaging.delete({ where: { id } }),
      record.name + ' ' + IN_USE,
    );
    await this.images.cleanup([
      record.imageKey,
      ...record.colors.map((color) => color.imageKey),
    ]);
  }

  async addColor(
    packagingId: string,
    dto: CreateGiftPackagingColorDto,
    file?: Express.Multer.File,
  ) {
    const packaging = await this.findOne(packagingId);
    if (packaging.type !== 'OPAQUE')
      throw new BadRequestException(
        'Only closed (opaque) packaging can have colours',
      );
    return this.images.save(file, FOLDER, async (key) => ({
      result: await this.query(() =>
        this.prisma.giftPackagingColor.create({
          data: {
            packagingId,
            name: dto.name,
            hex: dto.hex.toUpperCase(),
            imageKey: key,
            priceAdjustment: dto.priceAdjustment,
            stock: dto.stock,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
        }),
      ),
    }));
  }

  async updateColor(
    packagingId: string,
    colorId: string,
    dto: UpdateGiftPackagingColorDto,
    file?: Express.Multer.File,
  ) {
    const previous = await this.findColor(packagingId, colorId);
    return this.images.save(file, FOLDER, async (key) => ({
      result: await this.query(() =>
        this.prisma.giftPackagingColor.update({
          where: { id: colorId, packagingId },
          data: {
            name: dto.name,
            hex: dto.hex?.toUpperCase(),
            imageKey: key,
            priceAdjustment: dto.priceAdjustment,
            stock: dto.stock,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
        }),
      ),
      oldKeys: key ? [previous.imageKey] : [],
    }));
  }

  async removeColor(packagingId: string, colorId: string): Promise<void> {
    const record = await this.findColor(packagingId, colorId);
    await this.query(
      () =>
        this.prisma.giftPackagingColor.delete({
          where: { id: colorId, packagingId },
        }),
      record.name + ' ' + IN_USE,
    );
    await this.images.cleanup([record.imageKey]);
  }

  private async findColor(packagingId: string, colorId: string) {
    const record = await this.query(() =>
      this.prisma.giftPackagingColor.findFirst({
        where: { id: colorId, packagingId },
      }),
    );
    if (!record) throw new NotFoundException('Packaging colour not found');
    return record;
  }

  private async query<T>(
    operation: () => Promise<T>,
    inUse = 'Packaging ' + IN_USE,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002')
          throw new ConflictException(
            'A packaging or colour with this name already exists',
          );
        if (error.code === 'P2025')
          throw new NotFoundException('Gift packaging not found');
        if (error.code === 'P2003') throw new ConflictException(inUse);
      }
      throw new InternalServerErrorException(
        'Unable to complete gift packaging operation',
      );
    }
  }
}
