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
import { ImageWriteService } from '../../storage/image-write.service.js';
import type { CreateGarmentDto } from './dto/create-garment.dto.js';
import type { UpdateGarmentDto } from './dto/update-garment.dto.js';
import type { GarmentVariantDto } from './dto/garment-variant.dto.js';
import { validatePrintArea } from './print-area.js';

export interface GarmentImages {
  image?: Express.Multer.File;
  frontImage?: Express.Multer.File;
  backImage?: Express.Multer.File;
}

const variantOrder = [
  { sortOrder: 'asc' },
  { colorName: 'asc' },
  { size: 'asc' },
  { id: 'asc' },
] satisfies Prisma.GarmentVariantOrderByWithRelationInput[];

const garmentOrder = [
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.GarmentOrderByWithRelationInput[];

const json = (
  value: Prisma.InputJsonObject | undefined | null,
  provided: boolean,
) => (!provided ? undefined : value ? value : Prisma.DbNull);

@Injectable()
export class GarmentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ImageWriteService) private readonly images: ImageWriteService,
  ) {}

  /** Garments customers can design on: active garments with their active variants. */
  async findByCategory(categoryId: string) {
    await this.requireCategory(categoryId);
    return this.query(() =>
      this.prisma.garment.findMany({
        where: { categoryId, isActive: true },
        orderBy: garmentOrder,
        include: {
          variants: { where: { isActive: true }, orderBy: variantOrder },
        },
      }),
    );
  }

  /** Admin view: all garments of a category with all their variants. */
  async findAll(categoryId: string) {
    await this.requireCategory(categoryId);
    return this.query(() =>
      this.prisma.garment.findMany({
        where: { categoryId },
        orderBy: garmentOrder,
        include: { variants: { orderBy: variantOrder } },
      }),
    );
  }

  async findOne(id: string) {
    const garment = await this.query(() =>
      this.prisma.garment.findUnique({
        where: { id },
        include: { variants: { orderBy: variantOrder } },
      }),
    );
    if (!garment) throw new NotFoundException('Garment not found');
    return garment;
  }

  async create(dto: CreateGarmentDto, files: GarmentImages) {
    await this.requireApparelCategory(dto.categoryId);
    const front = validatePrintArea(dto.frontPrintArea, 'front');
    const back = validatePrintArea(dto.backPrintArea, 'back');
    return this.images.saveMany(
      [
        { file: files.image, folder: 'garments' },
        { file: files.frontImage, folder: 'garments' },
        { file: files.backImage, folder: 'garments' },
      ],
      async ([imageKey, frontImageKey, backImageKey]) => ({
        result: await this.query(() =>
          this.prisma.garment.create({
            data: {
              categoryId: dto.categoryId,
              name: dto.name,
              description: dto.description,
              basePrice: dto.basePrice,
              silhouette: dto.silhouette,
              frontPrintArea: front,
              backPrintArea: back,
              imageKey,
              frontImageKey,
              backImageKey,
              isActive: dto.isActive,
              sortOrder: dto.sortOrder,
            },
            include: { variants: { orderBy: variantOrder } },
          }),
        ),
      }),
    );
  }

  async update(id: string, dto: UpdateGarmentDto, files: GarmentImages) {
    const previous = await this.findOne(id);
    if (dto.categoryId !== undefined && dto.categoryId !== previous.categoryId)
      await this.requireApparelCategory(dto.categoryId);
    const front = validatePrintArea(dto.frontPrintArea, 'front');
    const back = validatePrintArea(dto.backPrintArea, 'back');
    return this.images.saveMany(
      [
        { file: files.image, folder: 'garments' },
        { file: files.frontImage, folder: 'garments' },
        { file: files.backImage, folder: 'garments' },
      ],
      async ([imageKey, frontImageKey, backImageKey]) => ({
        result: await this.query(() =>
          this.prisma.garment.update({
            where: { id },
            data: {
              categoryId: dto.categoryId,
              name: dto.name,
              description: dto.description,
              basePrice: dto.basePrice,
              silhouette: dto.silhouette,
              frontPrintArea: json(front, dto.frontPrintArea !== undefined),
              backPrintArea: json(back, dto.backPrintArea !== undefined),
              imageKey,
              frontImageKey,
              backImageKey,
              isActive: dto.isActive,
              sortOrder: dto.sortOrder,
            },
            include: { variants: { orderBy: variantOrder } },
          }),
        ),
        // Replaced images are removed only after the database write succeeds.
        oldKeys: [
          imageKey ? previous.imageKey : undefined,
          frontImageKey ? previous.frontImageKey : undefined,
          backImageKey ? previous.backImageKey : undefined,
        ],
      }),
    );
  }

  async remove(id: string): Promise<void> {
    const ordered = await this.query(() =>
      this.prisma.product.count({
        where: { garmentVariant: { garmentId: id } },
      }),
    );
    if (ordered)
      throw new ConflictException(
        'Customers have designs on this garment; deactivate it instead of deleting it',
      );
    const record = await this.query(() =>
      this.prisma.garment.delete({
        where: { id },
        select: { imageKey: true, frontImageKey: true, backImageKey: true },
      }),
    );
    await this.images.cleanup([
      record.imageKey,
      record.frontImageKey,
      record.backImageKey,
    ]);
  }

  /**
   * Replaces the size × colour matrix. Rows are matched by (size, colorValue) so a
   * variant keeps its id, and the designs that reference it, across edits. Rows left
   * out are deleted, or deactivated when a customer design already uses them.
   */
  async replaceVariants(id: string, variants: GarmentVariantDto[]) {
    const keyOf = (variant: { size: string; colorValue: string }) =>
      variant.size + '\u0000' + variant.colorValue.toLowerCase();
    const seen = new Set<string>();
    for (const variant of variants) {
      const key = keyOf(variant);
      if (seen.has(key))
        throw new BadRequestException(
          `Duplicate variant: ${variant.colorName} / ${variant.size}`,
        );
      seen.add(key);
    }
    const skus = variants
      .map((variant) => variant.sku)
      .filter((sku): sku is string => !!sku);
    if (new Set(skus).size !== skus.length)
      throw new BadRequestException('Variant SKUs must be unique');
    await this.query(() =>
      this.prisma.$transaction(async (tx) => {
        const garment = await tx.garment.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!garment) throw new NotFoundException('Garment not found');
        const existing = await tx.garmentVariant.findMany({
          where: { garmentId: id },
          select: {
            id: true,
            size: true,
            colorValue: true,
            _count: { select: { products: true } },
          },
        });
        const byKey = new Map(
          existing.map((variant) => [keyOf(variant), variant]),
        );
        for (const [index, variant] of variants.entries()) {
          const data = {
            size: variant.size,
            colorName: variant.colorName,
            colorValue: variant.colorValue,
            sku: variant.sku || null,
            stock: variant.stock,
            price: variant.price ?? null,
            isActive: variant.isActive ?? true,
            sortOrder: variant.sortOrder ?? index,
          };
          const match = byKey.get(keyOf(variant));
          if (match)
            await tx.garmentVariant.update({ where: { id: match.id }, data });
          else
            await tx.garmentVariant.create({
              data: { ...data, garmentId: id },
            });
        }
        for (const variant of existing) {
          if (seen.has(keyOf(variant))) continue;
          if (variant._count.products)
            await tx.garmentVariant.update({
              where: { id: variant.id },
              data: { isActive: false },
            });
          else await tx.garmentVariant.delete({ where: { id: variant.id } });
        }
      }),
    );
    return this.findOne(id);
  }

  private async requireCategory(categoryId: string) {
    const category = await this.query(() =>
      this.prisma.category.findUnique({
        where: { id: categoryId },
        select: { id: true },
      }),
    );
    if (!category) throw new NotFoundException('Category not found');
  }

  private async requireApparelCategory(categoryId: string) {
    const category = await this.query(() =>
      this.prisma.category.findUnique({
        where: { id: categoryId },
        select: { builderType: true },
      }),
    );
    if (!category) throw new NotFoundException('Category not found');
    if (category.builderType !== 'APPAREL')
      throw new BadRequestException(
        'Garments can only be added to APPAREL categories',
      );
  }

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025')
          throw new NotFoundException('Garment not found');
        if (error.code === 'P2002')
          throw new ConflictException(
            'A variant with this SKU or size and colour already exists',
          );
        if (error.code === 'P2003')
          throw new ConflictException(
            'This garment is still referenced by customer designs',
          );
      }
      throw new InternalServerErrorException(
        'Unable to complete garment operation',
      );
    }
  }
}
