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
import {
  garmentVariantSelect,
  productItemsSelect,
} from './product-items.select.js';
import { validateSelectedOptions } from '../categories/category-options.js';
import {
  isCanvasBuilder,
  TEXT_BUILDERS,
} from '../categories/builder-config.js';
import type { TextLayerDto } from './dto/text-layer.dto.js';

// The "Your own design" SubCategory: the customer uploads the image and its price is
// charged once per design, however many own images are placed.
const CUSTOM_UPLOAD = 'CUSTOM_UPLOAD';
// Admin edits rebuild items from stored rows; this carries an existing upload along.
type StoredItem = ProductItemDto & { customImageKey?: string };

const productInclude = {
  createdBy: {
    select: { id: true, firstName: true, lastName: true, userName: true },
  },
  category: {
    select: {
      id: true,
      name: true,
      imageKey: true,
      sizes: true,
      builderType: true,
      options: true,
      builderConfig: true,
      designCategoryId: true,
    },
  },
  garmentVariant: { select: garmentVariantSelect },
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
    backDesignPreview?: Express.Multer.File,
    customDesigns: Express.Multer.File[] = [],
  ) {
    const readyMade = dto.productType === 'READY_MADE';
    if (readyMade && customDesigns.length)
      throw new BadRequestException(
        'Ready-made products cannot include uploaded designs',
      );
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
        { file: backDesignPreview, folder: 'designs' },
        // Customer artwork is stored untouched: it is printed as uploaded.
        ...customDesigns.map((upload) => ({
          file: upload,
          folder: 'custom-designs',
          process: false,
        })),
      ],
      async ([key, previewKey, backPreviewKey, ...customKeys]) => ({
        result: await this.query(() =>
          this.prisma.$transaction(async (tx) => {
            const category = await this.categoryConfiguration(
              tx,
              dto.categoryId,
            );
            const calculated = readyMade
              ? await this.readyMadeItems(tx, dto.categoryId, dto.items)
              : await this.calculateCustomItems(
                  tx,
                  category,
                  dto.items ?? [],
                  customKeys,
                );
            const selectedOptions = validateSelectedOptions(
              category.options,
              dto.selectedOptions,
            );
            const textLayers = this.textLayers(category, dto.textLayers);
            const garment = readyMade
              ? { garmentVariantId: undefined, basePrice: 0 }
              : await this.resolveGarmentVariant(
                  tx,
                  category,
                  dto.garmentVariantId,
                );
            if (calculated.price + garment.basePrice > 2147483647)
              throw new BadRequestException(
                'Product quantity or price exceeds the supported integer range',
              );
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
                selectedOptions:
                  selectedOptions === null ? Prisma.DbNull : selectedOptions,
                textLayers: textLayers ?? undefined,
                createdById: user.id,
                categoryId: dto.categoryId,
                name: dto.name,
                description: dto.description,

                imageKey: key,
                designPreviewKey: previewKey,
                backDesignPreviewKey: backPreviewKey,
                garmentVariantId: garment.garmentVariantId,
                basePrice: garment.basePrice,
                isActive: dto.isActive,
                productType: dto.productType ?? 'CUSTOM_DESIGN',
                stock: readyMade ? dto.stock : 0,
                price: readyMade
                  ? dto.price
                  : calculated.price + garment.basePrice,
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

  async findCompletedCreationsFromOthers(user: AuthenticatedUser) {
    const orders = await this.query(() =>
      this.prisma.order.findMany({
        where: {
          status: 'COMPLETED',
          product: {
            createdById: { not: user.id },
            productType: 'CUSTOM_DESIGN',
          },
        },
        select: {
          id: true,
          updatedAt: true,
          product: { include: productInclude },
        },
        distinct: ['productId'],
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: 5,
      }),
    );
    return {
      data: orders.map(({ id, updatedAt, product }) => ({
        completedOrderId: id,
        completedOrderUpdatedAt: updatedAt,
        product,
      })),
    };
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
    backDesignPreview?: Express.Multer.File,
  ) {
    this.requireAdmin(user);
    return this.images.saveMany(
      [
        { file, folder: 'products' },
        { file: designPreview, folder: 'designs' },
        { file: backDesignPreview, folder: 'designs' },
      ],
      async ([key, previewKey, backPreviewKey]) => {
        let oldKey: string | null | undefined;
        let oldPreviewKey: string | null | undefined;
        let oldBackPreviewKey: string | null | undefined;
        const result = await this.query(() =>
          this.prisma.$transaction(async (tx) => {
            // Shared lock protocol with order creation: a design cannot change underneath an order.
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
            const product = await tx.product.findUnique({
              where: { id },
              include: { items: true, _count: { select: { orders: true } } },
            });
            if (!product) throw new NotFoundException('Product not found');
            const categoryId = dto.categoryId ?? product.categoryId;
            const category = await this.categoryConfiguration(tx, categoryId);
            const selectedOptions = validateSelectedOptions(
              category.options,
              dto.selectedOptions === undefined
                ? product.selectedOptions
                : dto.selectedOptions,
            );
            const textLayers =
              dto.textLayers === undefined
                ? undefined
                : this.textLayers(category, dto.textLayers);
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
            oldKey = product.imageKey;
            oldPreviewKey = product.designPreviewKey;
            oldBackPreviewKey = product.backDesignPreviewKey;
            const data: Prisma.ProductUpdateInput = {
              name: dto.name,
              description: dto.description,

              imageKey: key,
              designPreviewKey: previewKey,
              backDesignPreviewKey: backPreviewKey,
              isActive: dto.isActive,
              selectedOptions:
                dto.selectedOptions === undefined
                  ? undefined
                  : selectedOptions === null
                    ? Prisma.DbNull
                    : selectedOptions,
              textLayers:
                textLayers === undefined
                  ? undefined
                  : textLayers === null
                    ? Prisma.DbNull
                    : textLayers,
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
                dto.selectedOptions !== undefined ||
                dto.textLayers !== undefined ||
                (dto.categoryId !== undefined &&
                  dto.categoryId !== product.categoryId)
              )
                throw new ConflictException(
                  'Ordered product components cannot be changed; create a new product design',
                );
            } else if (
              (!file && !designPreview && !backDesignPreview) ||
              dto.items !== undefined ||
              dto.categoryId !== undefined
            ) {
              const items =
                dto.items ??
                product.items.map((item) => ({
                  subCategoryId: item.subCategoryId,
                  quantity: item.quantity,
                  position: item.position ?? undefined,
                  side: (item.side as ProductItemDto['side']) ?? undefined,
                  x: item.x ?? undefined,
                  y: item.y ?? undefined,
                  scale: item.scale ?? undefined,
                  rotation: item.rotation ?? undefined,
                  customImageKey: item.customImageKey ?? undefined,
                }));
              const calculated = await this.calculateCustomItems(
                tx,
                category,
                items,
              );
              data.category = { connect: { id: categoryId } };
              // The garment price was snapshotted when the design was created.
              data.price = calculated.price + (product.basePrice ?? 0);
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
            backPreviewKey ? oldBackPreviewKey : undefined,
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
        select: {
          imageKey: true,
          designPreviewKey: true,
          backDesignPreviewKey: true,
          items: { select: { customImageKey: true } },
        },
      }),
    );
    await this.images.cleanup([
      record.imageKey,
      record.designPreviewKey,
      record.backDesignPreviewKey,
      ...record.items.map((item) => item.customImageKey),
    ]);
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

  private async categoryConfiguration(
    tx: Prisma.TransactionClient,
    categoryId: string,
  ) {
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: {
        id: true,
        builderType: true,
        options: true,
        builderConfig: true,
        designCategoryId: true,
      },
    });
    if (!category) throw new NotFoundException('Category not found');
    // The requested ID is authoritative; this also keeps mocked adapters honest.
    return { ...category, id: categoryId };
  }

  private async calculateCustomItems(
    tx: Prisma.TransactionClient,
    category: {
      id: string;
      builderType: string | null;
      designCategoryId: string | null;
    },
    items: StoredItem[],
    customKeys: (string | undefined)[] = [],
  ) {
    if (
      !items.length &&
      category.builderType &&
      category.builderType !== 'JEWELRY'
    ) {
      if (customKeys.length)
        throw new BadRequestException(
          'Place every uploaded design on your piece',
        );
      return { price: 0, itemCount: 0, items: [] };
    }
    const apparel = category.builderType === 'APPAREL';
    const canvas = isCanvasBuilder(category.builderType);
    if (apparel)
      for (const item of items)
        if (
          item.side === undefined ||
          item.x === undefined ||
          item.y === undefined
        )
          throw new BadRequestException(
            'Apparel designs require side, x and y for every placed design',
          );
    if (canvas && !apparel)
      for (const item of items)
        if (item.x === undefined || item.y === undefined)
          throw new BadRequestException(
            'Canvas designs require x and y for every placed component',
          );
    // Designs may come from the category itself or from its shared design library.
    const allowed = [
      category.id,
      ...(category.designCategoryId ? [category.designCategoryId] : []),
    ];
    if (
      !apparel &&
      (customKeys.length ||
        items.some((item) => item.customDesignIndex !== undefined))
    )
      throw new BadRequestException(
        'Only apparel designs can include uploaded images',
      );
    const calculated = await this.calculateItems(
      tx,
      allowed,
      items,
      customKeys,
    );
    if (!canvas)
      // Strand builders order by position only; never persist stray placement data.
      for (const item of calculated.items)
        Object.assign(item, {
          side: undefined,
          x: undefined,
          y: undefined,
          scale: undefined,
          rotation: undefined,
        });
    else if (!apparel)
      // Bouquets and gifts have one canvas; position is the layer order (back → front).
      for (const item of calculated.items)
        Object.assign(item, { side: undefined });
    return calculated;
  }

  /** Personalised text is only offered by GIFT builders; it is not priced. */
  private textLayers(
    category: { builderType: string | null },
    layers: TextLayerDto[] | null | undefined,
  ): Prisma.InputJsonArray | null | undefined {
    if (layers === undefined || layers === null) return layers;
    if (!layers.length) return null;
    if (
      !(TEXT_BUILDERS as readonly string[]).includes(category.builderType ?? '')
    )
      throw new BadRequestException('Only gift designs can include text');
    if (new Set(layers.map((layer) => layer.id)).size !== layers.length)
      throw new BadRequestException('Text layer ids must be unique');
    return layers.map((layer) => ({
      id: layer.id,
      text: layer.text,
      x: layer.x,
      y: layer.y,
      scale: layer.scale,
      rotation: layer.rotation,
      ...(layer.color ? { color: layer.color } : {}),
      ...(layer.font ? { font: layer.font } : {}),
    }));
  }

  /**
   * APPAREL designs are printed on one garment size × colour. Returns the variant and
   * its price (variant override, else the garment's basePrice) to snapshot.
   */
  private async resolveGarmentVariant(
    tx: Prisma.TransactionClient,
    category: { id: string; builderType: string | null },
    garmentVariantId: string | undefined,
  ) {
    if (category.builderType !== 'APPAREL') {
      if (garmentVariantId !== undefined)
        throw new BadRequestException(
          'Only APPAREL designs can choose a garment',
        );
      return { garmentVariantId: undefined, basePrice: 0 };
    }
    if (!garmentVariantId)
      throw new BadRequestException(
        'Choose a garment size and colour for this design',
      );
    const variant = await tx.garmentVariant.findUnique({
      where: { id: garmentVariantId },
      select: {
        id: true,
        size: true,
        colorName: true,
        stock: true,
        price: true,
        isActive: true,
        garment: {
          select: {
            categoryId: true,
            isActive: true,
            basePrice: true,
            name: true,
          },
        },
      },
    });
    if (!variant || variant.garment.categoryId !== category.id)
      throw new BadRequestException(
        'Garment size and colour not found in this category',
      );
    if (!variant.isActive || !variant.garment.isActive)
      throw new BadRequestException(
        `${variant.garment.name} in ${variant.colorName} / ${variant.size} is no longer available`,
      );
    if (variant.stock < 1)
      throw new BadRequestException(
        `${variant.garment.name} in ${variant.colorName} / ${variant.size} is sold out`,
      );
    return {
      garmentVariantId: variant.id,
      basePrice: variant.price ?? variant.garment.basePrice,
    };
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
    if (items?.length) return this.calculateItems(tx, [categoryId], items);
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found');
    return { price: 0, itemCount: 0, items: [] };
  }

  private async calculateItems(
    tx: Prisma.TransactionClient,
    categoryIds: string[],
    input: StoredItem[],
    customKeys: (string | undefined)[] = [],
  ) {
    if (!input.length)
      throw new BadRequestException(
        'Product must contain at least one component',
      );
    const [categoryId] = categoryIds;
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
        type: true,
      },
    });
    const byId = new Map(
      components.map((component) => [component.id, component]),
    );
    let itemCount = 0;
    let price = 0;
    let customCharged = false;
    const usedUploads = new Set<number>();
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
      if (!categoryIds.includes(component.categoryId))
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
      const custom = component.type === CUSTOM_UPLOAD;
      let customImageKey: string | undefined;
      if (custom) {
        const index = item.customDesignIndex;
        if (index !== undefined) {
          if (usedUploads.has(index))
            throw new BadRequestException(
              'Each uploaded design can be placed only once',
            );
          usedUploads.add(index);
          customImageKey = customKeys[index];
        } else customImageKey = item.customImageKey;
        if (!customImageKey)
          throw new BadRequestException(
            'Upload an image for ' + component.name,
          );
        if (item.quantity !== 1)
          throw new BadRequestException('Each uploaded design is placed once');
      } else if (item.customDesignIndex !== undefined)
        throw new BadRequestException(
          component.name +
            ' cannot carry an uploaded image; use the own-design option',
        );
      // Own designs cost the configured price once per design, however many are placed.
      const unitPrice = custom && customCharged ? 0 : component.price;
      if (custom) customCharged = true;
      itemCount += item.quantity;
      price += unitPrice * item.quantity;
      if (itemCount > 2147483647 || price > 2147483647)
        throw new BadRequestException(
          'Product quantity or price exceeds the supported integer range',
        );
      return {
        subCategoryId: component.id,
        quantity: item.quantity,
        position: item.position,
        unitPrice,
        customImageKey,
        side: item.side,
        x: item.x,
        y: item.y,
        scale: item.scale,
        rotation: item.rotation,
      };
    });
    if (customKeys.some((_key, index) => !usedUploads.has(index)))
      throw new BadRequestException(
        'Place every uploaded design on your piece',
      );
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
