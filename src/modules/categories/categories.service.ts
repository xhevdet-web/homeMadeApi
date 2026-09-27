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
import type { CreateCategoryDto } from './dto/create-category.dto.js';
import type { UpdateCategoryDto } from './dto/update-category.dto.js';

const orderBy = [
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.CategoryOrderByWithRelationInput[];

@Injectable()
export class CategoriesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ImageWriteService) private readonly images: ImageWriteService,
  ) {}

  create(dto: CreateCategoryDto, file?: Express.Multer.File) {
    return this.images.save(file, 'categories', async (key) => ({
      result: await this.query(() =>
        this.prisma.category.create({
          data: {
            name: dto.name,
            description: dto.description,

            imageKey: key,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
        }),
      ),
    }));
  }

  findAll() {
    return this.query(() => this.prisma.category.findMany({ orderBy }));
  }

  async findOne(id: string) {
    const record = await this.query(() =>
      this.prisma.category.findUnique({
        where: { id },
        include: { subCategories: { orderBy } },
      }),
    );
    if (!record) throw new NotFoundException('Category not found');
    return record;
  }

  async findSubCategories(id: string) {
    const category = await this.query(() =>
      this.prisma.category.findUnique({
        where: { id },
        select: { subCategories: { orderBy, include: { category: true } } },
      }),
    );
    if (!category) throw new NotFoundException('Category not found');
    return category.subCategories;
  }

  async update(id: string, dto: UpdateCategoryDto, file?: Express.Multer.File) {
    const previous = file ? await this.findOne(id) : undefined;
    return this.images.save(file, 'categories', async (key) => ({
      result: await this.query(() =>
        this.prisma.category.update({
          where: {
            id,
            ...(key ? { imageKey: previous?.imageKey ?? null } : {}),
          },
          data: {
            name: dto.name,
            description: dto.description,

            imageKey: key,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
        }),
      ),
      oldKeys: key ? [previous?.imageKey] : [],
    }));
  }

  async remove(id: string): Promise<void> {
    const record = await this.query(() =>
      this.prisma.$transaction(
        async (tx) => {
          const deleted = await tx.category.delete({
            where: { id },
            select: {
              imageKey: true,
              subCategories: { select: { imageKey: true } },
            },
          });
          return deleted;
        },
        { isolationLevel: 'Serializable' },
      ),
    );
    await this.images.cleanup([
      record.imageKey,
      ...(record.subCategories ?? []).map((child) => child.imageKey),
    ]);
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
          throw new ConflictException('Category name is already in use');
        if (error.code === 'P2025')
          throw new NotFoundException('Category not found');
        if (error.code === 'P2003')
          throw new ConflictException('Category is still referenced');
      }
      throw new InternalServerErrorException(
        'Unable to complete category operation',
      );
    }
  }
}
