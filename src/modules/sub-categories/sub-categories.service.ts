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
import type { CreateSubCategoryDto } from './dto/create-sub-category.dto.js';
import type { UpdateSubCategoryDto } from './dto/update-sub-category.dto.js';
import { isJewelryCategory } from '../categories/jewelry-measurement.js';

const PHYSICAL_SIZE_REQUIRED =
  'Jewelry components need a physical size (effectiveLengthMm): the length one piece occupies on the cord, in millimetres';

// The display image gets background removal unless disabled; when it is processed, the
// untouched upload is also kept so production can print from the original file.
function uploads(
  file: Express.Multer.File | undefined,
  removeBackground?: boolean,
) {
  const process = removeBackground !== false;
  return [
    { file, folder: 'subcategories', process },
    { file: process ? file : undefined, folder: 'originals', process: false },
  ];
}

const orderBy = [
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.SubCategoryOrderByWithRelationInput[];

@Injectable()
export class SubCategoriesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ImageWriteService) private readonly images: ImageWriteService,
  ) {}

  async create(dto: CreateSubCategoryDto, file?: Express.Multer.File) {
    const category = await this.requireCategory(dto.categoryId);
    // New jewelry components are measured from the start; the studio sizes by length.
    if (isJewelryCategory(category) && dto.effectiveLengthMm == null)
      throw new BadRequestException(PHYSICAL_SIZE_REQUIRED);
    return this.images.saveMany(
      uploads(file, dto.removeBackground),
      async ([key, originalKey]) => ({
        result: await this.query(() =>
          this.prisma.subCategory.create({
            data: {
              categoryId: dto.categoryId,
              name: dto.name,
              description: dto.description,

              imageKey: key,
              originalImageKey: originalKey,
              color: dto.color,
              type: dto.type,
              price: dto.price,
              stock: dto.stock,
              effectiveLengthMm: dto.effectiveLengthMm,
              trackStock: dto.trackStock,
              isActive: dto.isActive,
              sortOrder: dto.sortOrder,
            },
            include: { category: true },
          }),
        ),
      }),
    );
  }

  /** All components, or one category's own components with ?categoryId=. */
  findAll(categoryId?: string) {
    return this.query(() =>
      this.prisma.subCategory.findMany({
        where: { categoryId },
        orderBy,
        include: { category: true },
      }),
    );
  }

  async findOne(id: string) {
    const record = await this.query(() =>
      this.prisma.subCategory.findUnique({
        where: { id },
        include: { category: true },
      }),
    );
    if (!record) throw new NotFoundException('SubCategory not found');
    return record;
  }

  private async requireCategory(id: string) {
    const category = await this.query(() =>
      this.prisma.category.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          builderType: true,
          builderConfig: true,
        },
      }),
    );
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  async update(
    id: string,
    dto: UpdateSubCategoryDto,
    file?: Express.Multer.File,
  ) {
    const previous = await this.findOne(id);
    const category =
      dto.categoryId !== undefined
        ? await this.requireCategory(dto.categoryId)
        : previous.category;
    // Existing jewelry components may still be unmeasured (sizes are entered over time),
    // but a measured one cannot lose its size, and one moved into jewelry needs one.
    const length =
      dto.effectiveLengthMm !== undefined
        ? dto.effectiveLengthMm
        : previous.effectiveLengthMm;
    if (
      isJewelryCategory(category) &&
      length == null &&
      (dto.effectiveLengthMm === null ||
        (dto.categoryId !== undefined &&
          dto.categoryId !== previous.categoryId))
    )
      throw new BadRequestException(PHYSICAL_SIZE_REQUIRED);
    return this.images.saveMany(
      uploads(file, dto.removeBackground),
      async ([key, originalKey]) => ({
        result: await this.query(() =>
          this.prisma.subCategory.update({
            where: {
              id,
              ...(key ? { imageKey: previous?.imageKey ?? null } : {}),
            },
            data: {
              categoryId: dto.categoryId,
              name: dto.name,
              description: dto.description,

              imageKey: key,
              // A new upload replaces the production original too (null when unprocessed).
              originalImageKey: key ? (originalKey ?? null) : undefined,
              color: dto.color,
              type: dto.type,
              price: dto.price,
              stock: dto.stock,
              effectiveLengthMm: dto.effectiveLengthMm,
              trackStock: dto.trackStock,
              isActive: dto.isActive,
              sortOrder: dto.sortOrder,
            },
            include: { category: true },
          }),
        ),
        oldKeys: key ? [previous?.imageKey, previous?.originalImageKey] : [],
      }),
    );
  }

  async remove(id: string): Promise<void> {
    const record = await this.query(() =>
      this.prisma.subCategory.delete({
        where: { id },
        select: { imageKey: true, originalImageKey: true },
      }),
    );
    await this.images.cleanup([record.imageKey, record.originalImageKey]);
  }

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2034')
          throw new ConflictException(
            'Record changed concurrently; please retry',
          );
        if (error.code === 'P2002')
          throw new ConflictException('SubCategory already exists');
        if (error.code === 'P2025')
          throw new NotFoundException('SubCategory not found');
        if (error.code === 'P2003')
          throw new ConflictException('Parent category no longer exists');
      }
      throw new InternalServerErrorException(
        'Unable to complete subcategory operation',
      );
    }
  }
}
