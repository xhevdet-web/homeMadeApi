import { ImageWriteService } from '../../storage/image-write.service.js';
import {
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
    await this.requireCategory(dto.categoryId);
    return this.images.save(file, 'subcategories', async (key) => ({
      result: await this.query(() =>
        this.prisma.subCategory.create({
          data: {
            categoryId: dto.categoryId,
            name: dto.name,
            description: dto.description,

            imageKey: key,
            color: dto.color,
            type: dto.type,
            price: dto.price,
            stock: dto.stock,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
          include: { category: true },
        }),
      ),
    }));
  }

  findAll() {
    return this.query(() =>
      this.prisma.subCategory.findMany({
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
        select: { id: true },
      }),
    );
    if (!category) throw new NotFoundException('Category not found');
  }

  async update(
    id: string,
    dto: UpdateSubCategoryDto,
    file?: Express.Multer.File,
  ) {
    const previous = await this.findOne(id);
    if (dto.categoryId !== undefined)
      await this.requireCategory(dto.categoryId);
    return this.images.save(file, 'subcategories', async (key) => ({
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
            color: dto.color,
            type: dto.type,
            price: dto.price,
            stock: dto.stock,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
          include: { category: true },
        }),
      ),
      oldKeys: key ? [previous?.imageKey] : [],
    }));
  }

  async remove(id: string): Promise<void> {
    const record = await this.query(() =>
      this.prisma.subCategory.delete({
        where: { id },
        select: { imageKey: true },
      }),
    );
    await this.images.cleanup([record.imageKey]);
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
