import { ImageWriteService } from '../../storage/image-write.service.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import type { CreateProductDto } from './dto/create-product.dto.js';
import type { UpdateProductDto } from './dto/update-product.dto.js';
import type { ProductItemDto } from './dto/product-item.dto.js';
import { productItemsSelect } from './product-items.select.js';

const productInclude = {
  createdBy: {
    select: { id: true, firstName: true, lastName: true, userName: true },
  },
  category: {
    select: { id: true, name: true, imageKey: true, sizes: true },
  },
  items: productItemsSelect,
} satisfies Prisma.ProductInclude;

@Injectable()
export class ProductsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ImageWriteService) private readonly images: ImageWriteService,
  ) {}

  create(
    dto: CreateProductDto,
    user: AuthenticatedUser,
    file?: Express.Multer.File,
    designPreview?: Express.Multer.File,
  ) {
    const readyMade = dto.productType === 'READY_MADE';
    if (readyMade) {
      this.requireAdmin(user);
      this.validateInventory(dto.price, dto.stock);
      if (!file)
        throw new BadRequestException(
          'Ready-made products require an uploaded image',
        );
    } else if (dto.price !== undefined || dto.stock !== undefined) {
      throw new BadRequestException(
        'Custom design price is calculated and inventory uses component stock',
      );
    }
    return this.images.saveMany(
      [
        { file, folder: 'products' },
        { file: designPreview, folder: 'designs' },
      ],
      async ([key, previewKey]) => ({
        result: await this.query(() =>
          this.prisma.$transaction(async (tx) => {
            const calculated = readyMade
              ? await this.readyMadeItems(tx, dto.categoryId, dto.items)
              : await this.calculateItems(tx, dto.categoryId, dto.items ?? []);
            const selectedSize =
              dto.selectedSizeId === undefined
                ? undefined
                : await this.resolveSize(
                    tx,
                    dto.categoryId,
                    dto.selectedSizeId,
                    calculated.itemCount,
                  );
            return tx.product.create({
              data: {
                selectedSize,
                createdById: user.id,
                categoryId: dto.categoryId,
                name: dto.name,
                description: dto.description,

                imageKey: key,
                designPreviewKey: previewKey,
                isActive: dto.isActive,
                productType: dto.productType ?? 'CUSTOM_DESIGN',
                stock: readyMade ? dto.stock : 0,
                price: readyMade ? dto.price : calculated.price,
                itemCount: calculated.itemCount,
                items: { create: calculated.items },
              },
              include: productInclude,
            });
          }),
        ),
      }),
    );
  }

  findAll() {
    return this.list({});
  }

  async findOne(id: string) {
    const product = await this.query(() =>
      this.prisma.product.findUnique({
        where: { id },
        include: productInclude,
      }),
    );
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async findByCategory(categoryId: string) {
    const category = await this.query(() =>
      this.prisma.category.findUnique({
        where: { id: categoryId },
        select: { id: true },
      }),
    );
    if (!category) throw new NotFoundException('Category not found');
    return this.list({ categoryId });
  }

  async findBySubCategory(subCategoryId: string) {
    const subCategory = await this.query(() =>
      this.prisma.subCategory.findUnique({
        where: { id: subCategoryId },
        select: { id: true },
      }),
    );
    if (!subCategory) throw new NotFoundException('SubCategory not found');
    return this.list({ items: { some: { subCategoryId } } });
  }

  async findByUser(createdById: string) {
    const user = await this.query(() =>
      this.prisma.user.findUnique({
        where: { id: createdById },
        select: { id: true },
      }),
    );
    if (!user) throw new NotFoundException('User not found');
    return this.list({ createdById });
  }

  update(
    id: string,
    dto: UpdateProductDto,
    user: AuthenticatedUser,
    file?: Express.Multer.File,
    designPreview?: Express.Multer.File,
  ) {
    this.requireAdmin(user);
    return this.images.saveMany(
      [
        { file, folder: 'products' },
        { file: designPreview, folder: 'designs' },
      ],
      async ([key, previewKey]) => {
        let oldKey: string | null | undefined;
        let oldPreviewKey: string | null | undefined;
        const result = await this.query(() =>
          this.prisma.$transaction(async (tx) => {
            // Shared lock protocol with order creation: a design cannot change underneath an order.
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
            const product = await tx.product.findUnique({
              where: { id },
              include: { items: true, _count: { select: { orders: true } } },
            });
            if (!product) throw new NotFoundException('Product not found');
            if (
              dto.productType !== undefined &&
              dto.productType !== (product.productType ?? 'CUSTOM_DESIGN')
            )
              throw new BadRequestException('Product type cannot be changed');
            if (
              product.productType !== 'READY_MADE' &&
              (dto.price !== undefined || dto.stock !== undefined)
            )
              throw new BadRequestException(
                'Custom design price is calculated and inventory uses component stock',
              );
            if (product.productType !== 'READY_MADE' && dto.items?.length === 0)
              throw new BadRequestException(
                'Product must contain at least one component',
              );
            oldKey = product.imageKey;
            oldPreviewKey = product.designPreviewKey;
            const data: Prisma.ProductUpdateInput = {
              name: dto.name,
              description: dto.description,

              imageKey: key,
              designPreviewKey: previewKey,
              isActive: dto.isActive,
            };
            if (product.productType === 'READY_MADE') {
              this.validateInventory(
                dto.price ?? product.price,
                dto.stock ?? product.stock,
              );
              data.price = dto.price;
              data.stock = dto.stock;
              if (dto.items !== undefined || dto.categoryId !== undefined) {
                const categoryId = dto.categoryId ?? product.categoryId;
                const calculated = await this.readyMadeItems(
                  tx,
                  categoryId,
                  dto.items ??
                    product.items.map((item) => ({
                      subCategoryId: item.subCategoryId,
                      quantity: item.quantity,
                      position: item.position ?? undefined,
                    })),
                );
                data.category = { connect: { id: categoryId } };
                data.itemCount = calculated.itemCount;
                data.items = { deleteMany: {}, create: calculated.items };
              }
            } else if (product._count.orders > 0) {
              // Orders reference this design. Preserve quantities and unit-price snapshots for order history.
              if (
                dto.items !== undefined ||
                (dto.categoryId !== undefined &&
                  dto.categoryId !== product.categoryId)
              )
                throw new ConflictException(
                  'Ordered product components cannot be changed; create a new product design',
                );
            } else if (
              (!file && !designPreview) ||
              dto.items !== undefined ||
              dto.categoryId !== undefined
            ) {
              const categoryId = dto.categoryId ?? product.categoryId;
              const items =
                dto.items ??
                product.items.map((item) => ({
                  subCategoryId: item.subCategoryId,
                  quantity: item.quantity,
                  position: item.position ?? undefined,
                }));
              const calculated = await this.calculateItems(
                tx,
                categoryId,
                items,
              );
              data.category = { connect: { id: categoryId } };
              data.price = calculated.price;
              data.itemCount = calculated.itemCount;
              data.items = { deleteMany: {}, create: calculated.items };
            }
            if (dto.selectedSizeId !== undefined) {
              data.selectedSize = await this.resolveSize(
                tx,
                dto.categoryId ?? product.categoryId,
                dto.selectedSizeId,
                (dto.items ?? product.items).reduce(
                  (sum, item) => sum + item.quantity,
                  0,
                ),
              );
            } else if (
              dto.items !== undefined ||
              dto.categoryId !== undefined
            ) {
              // Preserve the stored size snapshot; never accept frontend limits.
              const category = await tx.category.findUnique({
                where: { id: dto.categoryId ?? product.categoryId },
                select: { sizes: true },
              });
              if (Array.isArray(category?.sizes) && category.sizes.length > 0)
                this.validateSizeLimit(
                  product.selectedSize,
                  (dto.items ?? product.items).reduce(
                    (sum, item) => sum + item.quantity,
                    0,
                  ),
                );
            }
            return tx.product.update({
              where: { id },
              data,
              include: productInclude,
            });
          }),
        );
        return {
          result,
          oldKeys: [
            key ? oldKey : undefined,
            previewKey ? oldPreviewKey : undefined,
          ],
        };
      },
    );
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    this.requireAdmin(user);
    const record = await this.query(() =>
      this.prisma.product.delete({
        where: { id },
        select: { imageKey: true, designPreviewKey: true },
      }),
    );
    await this.images.cleanup([record.imageKey, record.designPreviewKey]);
  }

  private requireAdmin(user: AuthenticatedUser) {
    if (user.role !== 'ADMIN')
      throw new ForbiddenException('Only admins can edit or delete products');
  }

  private list(where: Prisma.ProductWhereInput) {
    return this.query(() =>
      this.prisma.product.findMany({
        where,
        include: productInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
  }

  private async resolveSize(
    tx: Prisma.TransactionClient,
    categoryId: string,
    sizeId: string,
    itemCount: number,
  ) {
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: { sizes: true },
    });
    if (!category) throw new NotFoundException('Category not found');
    const size = Array.isArray(category.sizes)
      ? category.sizes.find(
          (size) =>
            size !== null &&
            typeof size === 'object' &&
            !Array.isArray(size) &&
            size.id === sizeId,
        )
      : undefined;
    if (!size)
      throw new BadRequestException(
        'Selected size does not exist in the selected category',
      );
    this.validateSizeLimit(size, itemCount);
    return size as Prisma.InputJsonObject;
  }

  private validateSizeLimit(
    size: Prisma.JsonValue | undefined,
    itemCount: number,
  ) {
    if (
      size &&
      typeof size === 'object' &&
      !Array.isArray(size) &&
      typeof size.maxItems === 'number' &&
      itemCount > size.maxItems
    )
      throw new BadRequestException(
        'Total component quantity exceeds selected size maxItems (' +
          size.maxItems +
          ')',
      );
  }

  private validateInventory(price: unknown, stock: unknown) {
    for (const [field, value] of [
      ['price', price],
      ['stock', stock],
    ] as const)
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 2147483647
      )
        throw new BadRequestException(
          field + ' must be a nonnegative integer within the supported range',
        );
  }

  private async readyMadeItems(
    tx: Prisma.TransactionClient,
    categoryId: string,
    items?: ProductItemDto[],
  ) {
    if (items?.length) return this.calculateItems(tx, categoryId, items);
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found');
    return { price: 0, itemCount: 0, items: [] };
  }

  private async calculateItems(
    tx: Prisma.TransactionClient,
    categoryId: string,
    input: ProductItemDto[],
  ) {
    if (!input.length)
      throw new BadRequestException(
        'Product must contain at least one component',
      );
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found');
    const components = await tx.subCategory.findMany({
      where: {
        id: { in: [...new Set(input.map((item) => item.subCategoryId))] },
      },
      select: {
        id: true,
        categoryId: true,
        name: true,
        isActive: true,
        price: true,
      },
    });
    const byId = new Map(
      components.map((component) => [component.id, component]),
    );
    let itemCount = 0;
    let price = 0;
    const items = input.map((item) => {
      const component = byId.get(item.subCategoryId);
      if (!component)
        throw new NotFoundException(
          'SubCategory not found: ' + item.subCategoryId,
        );
      if (!component.isActive)
        throw new BadRequestException(
          'SubCategory is inactive: ' + component.name,
        );
      if (component.categoryId !== categoryId)
        throw new BadRequestException(
          'SubCategory does not belong to the selected Category: ' +
            component.name,
        );
      if (!Number.isInteger(item.quantity) || item.quantity <= 0)
        throw new BadRequestException(
          'Component quantities must be positive integers',
        );
      if (!Number.isInteger(component.price) || component.price < 0)
        throw new BadRequestException(
          'Invalid component price: ' + component.name,
        );
      itemCount += item.quantity;
      price += component.price * item.quantity;
      if (itemCount > 2147483647 || price > 2147483647)
        throw new BadRequestException(
          'Product quantity or price exceeds the supported integer range',
        );
      return {
        subCategoryId: component.id,
        quantity: item.quantity,
        position: item.position,
        unitPrice: component.price,
      };
    });
    return { items, itemCount, price };
  }

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2025')
          throw new NotFoundException('Product not found');
        if (error.code === 'P2002')
          throw new ConflictException('Product already exists');
        if (error.code === 'P2034')
          throw new ConflictException(
            'Product changed concurrently; please retry',
          );
        if (error.code === 'P2003')
          throw new ConflictException(
            'A related record no longer exists or the product is still referenced',
          );
      }
      throw new InternalServerErrorException(
        'Unable to complete product operation',
      );
    }
  }
}
