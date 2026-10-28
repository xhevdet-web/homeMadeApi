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
import type { CreateCategoryDto } from './dto/create-category.dto.js';
import type { UpdateCategoryDto } from './dto/update-category.dto.js';
import {
  acceptsUploads,
  CASE_BUILDER,
  validateBuilderConfig,
} from './builder-config.js';
import {
  isJewelryCategory,
  normalizeCategorySizes,
} from './jewelry-measurement.js';

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

  async create(dto: CreateCategoryDto, file?: Express.Multer.File) {
    await this.validateDesignLibrary(
      undefined,
      dto.designCategoryId,
      dto.builderType,
    );
    const created = await this.images.save(file, 'categories', async (key) => ({
      result: await this.query(() =>
        this.prisma.category.create({
          data: {
            builderType: dto.builderType,
            designCategoryId: dto.designCategoryId,
            builderConfig:
              dto.builderConfig === null
                ? Prisma.DbNull
                : validateBuilderConfig(dto.builderConfig),
            sizes:
              dto.sizes === null
                ? Prisma.DbNull
                : dto.sizes &&
                  normalizeCategorySizes(
                    dto.sizes as unknown as Record<string, unknown>[],
                    isJewelryCategory(dto),
                  ),
            name: dto.name,
            description: dto.description,

            imageKey: key,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
        }),
      ),
    }));
    if (acceptsUploads(created.builderType))
      await this.ensureOwnDesign(created.id, created.builderType);
    return created;
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
        select: {
          subCategories: { orderBy, include: { category: true } },
          // Designs shared from a library category are offered alongside the category's own.
          designCategory: {
            select: { subCategories: { orderBy, include: { category: true } } },
          },
        },
      }),
    );
    if (!category) throw new NotFoundException('Category not found');
    return [
      ...category.subCategories,
      ...(category.designCategory?.subCategories ?? []),
    ];
  }

  // APPAREL categories always offer "Your own design": customers upload their artwork
  // for this design's price (charged once per design). CASE categories offer "Your own
  // photo", free by default. Admins may edit, reprice or deactivate it.
  private async ensureOwnDesign(
    categoryId: string,
    builderType: string | null,
  ) {
    const phoneCase = builderType === CASE_BUILDER;
    const existing = await this.query(() =>
      this.prisma.subCategory.findMany({
        where: { categoryId, type: 'CUSTOM_UPLOAD' },
        select: { id: true },
        take: 1,
      }),
    );
    if (existing.length) return;
    await this.query(() =>
      this.prisma.subCategory.create({
        data: {
          categoryId,
          name: phoneCase ? 'Your own photo' : 'Your own design',
          description: phoneCase
            ? 'Upload your own photo to print on your phone case.'
            : 'Upload your own artwork to print on your piece.',
          type: 'CUSTOM_UPLOAD',
          price: phoneCase ? 0 : 500,
          stock: 0,
          trackStock: false,
        },
      }),
    );
  }

  // A design library must exist, cannot be the category itself and cannot chain to
  // another library, so a design always has exactly one owner category. It must also be
  // the same kind of studio (e.g. a shared "Beads" category for Bracelets and Necklaces),
  // or one without a builder type.
  private async validateDesignLibrary(
    id: string | undefined,
    libraryId?: string | null,
    builderType?: string | null,
  ) {
    if (!libraryId) return;
    if (libraryId === id)
      throw new BadRequestException(
        'A category cannot use itself as its design library',
      );
    const library = await this.query(() =>
      this.prisma.category.findUnique({
        where: { id: libraryId },
        select: { id: true, designCategoryId: true, builderType: true },
      }),
    );
    if (!library)
      throw new BadRequestException('Design library category not found');
    if (library.designCategoryId)
      throw new BadRequestException(
        'A design library cannot itself use another design library',
      );
    // Nor may a category that other categories use as their library take one itself.
    if (id) {
      const users = await this.query(() =>
        this.prisma.category.findMany({
          where: { designCategoryId: id },
          select: { name: true },
          take: 1,
        }),
      );
      if (users.length)
        throw new BadRequestException(
          `${users[0].name} uses this category as its design library, so it cannot use one itself`,
        );
    }
    // An update that keeps its builder type is compared with the stored one.
    const own =
      builderType !== undefined || !id
        ? builderType
        : (
            await this.query(() =>
              this.prisma.category.findUnique({
                where: { id },
                select: { builderType: true },
              }),
            )
          )?.builderType;
    if (own && library.builderType && own !== library.builderType)
      throw new BadRequestException(
        'A design library must be the same kind of studio as the category, e.g. jewelry for jewelry',
      );
  }

  async update(id: string, dto: UpdateCategoryDto, file?: Express.Multer.File) {
    await this.validateDesignLibrary(id, dto.designCategoryId, dto.builderType);
    const previous = file || dto.sizes ? await this.findOne(id) : undefined;
    const updated = await this.images.save(file, 'categories', async (key) => ({
      result: await this.query(() =>
        this.prisma.category.update({
          where: {
            id,
            ...(key ? { imageKey: previous?.imageKey ?? null } : {}),
          },
          data: {
            builderType: dto.builderType,
            designCategoryId: dto.designCategoryId,
            builderConfig:
              dto.builderConfig === null
                ? Prisma.DbNull
                : validateBuilderConfig(dto.builderConfig),
            // Jewelry sizes are length ranges; the studio may come from the request or,
            // when it leaves the studio out, from the stored category.
            sizes:
              dto.sizes === null
                ? Prisma.DbNull
                : dto.sizes &&
                  normalizeCategorySizes(
                    dto.sizes as unknown as Record<string, unknown>[],
                    isJewelryCategory({
                      builderType:
                        dto.builderType !== undefined
                          ? dto.builderType
                          : previous?.builderType,
                    }),
                  ),
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
    if (acceptsUploads(updated.builderType))
      await this.ensureOwnDesign(updated.id, updated.builderType);
    return updated;
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
