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
import type { ProductQueryDto } from './dto/product-query.dto.js';
import {
  baseProductSelect,
  productItemsSelect,
} from './product-items.select.js';
import {
  normalizeSizes,
  parseSizes,
  selectedSizeId,
  type SizeStock,
} from './product-sizes.js';
import { validatePrintAreas } from './print-area.js';
import {
  assertNotOverfilled,
  measuredSize,
  selectedMeasuredSize,
  selectMeasurement,
  usedLengthMm,
  type Piece,
} from '../categories/jewelry-measurement.js';
import {
  isCanvasBuilder,
  TEXT_BUILDERS,
} from '../categories/builder-config.js';
import type { TextLayerDto } from './dto/text-layer.dto.js';
import {
  giftPackagingColorSelect,
  giftPackagingFields,
  giftPackagingSelect,
} from '../gift-packaging/gift-packaging.selection.js';

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
      builderConfig: true,
      designCategoryId: true,
    },
  },
  baseProduct: { select: baseProductSelect },
  giftPackaging: { select: giftPackagingSelect },
  giftPackagingColor: { select: giftPackagingColorSelect },
  items: productItemsSelect,
} satisfies Prisma.ProductInclude;

// Fields only an admin sets on a COMPANY product; CUSTOMER prices are calculated.
const COMPANY_FIELDS = [
  'price',
  'stock',
  'sizes',
  'color',
  'colorHex',
  'printAreas',
] as const;
const CUSTOMER_INVENTORY =
  'Customer design price is calculated; inventory belongs to its components and base product';

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
    backImage?: Express.Multer.File,
  ) {
    const company = dto.origin === 'COMPANY';
    if (company) {
      this.requireAdmin(user);
      if (customDesigns.length || dto.baseProductId !== undefined)
        throw new BadRequestException(
          'Company products cannot include uploaded designs or a base product',
        );
      if (!file)
        throw new BadRequestException(
          'Company products require an uploaded image',
        );
    } else if (
      COMPANY_FIELDS.some((field) => dto[field] !== undefined) ||
      backImage
    ) {
      throw new BadRequestException(CUSTOMER_INVENTORY);
    }
    // Printed artwork must keep transparency, so customer uploads are PNG only (the
    // signature is checked against the declared type when the file is stored).
    if (customDesigns.some((upload) => upload.mimetype !== 'image/png'))
      throw new BadRequestException('Uploaded designs must be PNG images');
    const inventory = company ? this.companyInventory(dto) : undefined;
    const printAreas = company ? validatePrintAreas(dto.printAreas) : undefined;
    return this.images.saveMany(
      [
        { file, folder: 'products' },
        { file: designPreview, folder: 'designs' },
        { file: backDesignPreview, folder: 'designs' },
        { file: backImage, folder: 'products' },
        // Customer artwork is stored untouched: it is printed as uploaded.
        ...customDesigns.map((upload) => ({
          file: upload,
          folder: 'custom-designs',
          process: false,
        })),
      ],
      async ([
        key,
        previewKey,
        backPreviewKey,
        backImageKey,
        ...customKeys
      ]) => ({
        result: await this.query(() =>
          this.prisma.$transaction(async (tx) => {
            const category = await this.categoryConfiguration(
              tx,
              dto.categoryId,
            );
            const calculated = company
              ? await this.readyMadeItems(tx, dto.categoryId, dto.items)
              : await this.calculateCustomItems(
                  tx,
                  category,
                  dto.items ?? [],
                  customKeys,
                );
            const textLayers = this.textLayers(category, dto.textLayers);
            const base = company
              ? undefined
              : await this.resolveBaseProduct(tx, category, dto.baseProductId);
            const basePrice = base?.price ?? 0;
            const packaging = await giftPackagingFields(
              tx,
              { builderType: category.builderType, company },
              dto.giftPackagingId,
              dto.giftPackagingColorId,
            );
            if (
              calculated.price + basePrice + packaging.packagingPrice >
              2147483647
            )
              throw new BadRequestException(
                'Product quantity or price exceeds the supported integer range',
              );
            const selectedSize = base?.sizes.length
              ? this.resolveBaseSize(base, dto.selectedSizeId)
              : dto.selectedSizeId === undefined
                ? undefined
                : await this.resolveSize(
                    tx,
                    dto.categoryId,
                    dto.selectedSizeId,
                    dto.items ?? [],
                    dto.selectedMeasurementMm,
                  );
            if (
              dto.selectedMeasurementMm !== undefined &&
              dto.selectedSizeId === undefined
            )
              throw new BadRequestException('Choose a size for the length');
            return tx.product.create({
              data: {
                origin: dto.origin ?? 'CUSTOMER',
                selectedSize,
                textLayers: textLayers ?? undefined,
                createdById: user.id,
                categoryId: dto.categoryId,
                baseProductId: base?.id,
                name: dto.name,
                description: dto.description,

                imageKey: key,
                backImageKey,
                designPreviewKey: previewKey,
                backDesignPreviewKey: backPreviewKey,
                color: company ? dto.color : undefined,
                colorHex: company ? dto.colorHex : undefined,
                printAreas,
                sizes: inventory?.sizes ?? undefined,
                stock: inventory?.stock ?? 0,
                basePrice,
                ...packaging,
                isActive: dto.isActive,
                price: company
                  ? dto.price
                  : calculated.price + basePrice + packaging.packagingPrice,
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

  /** Filtered by category, origin, creator, status and a name/description/colour search. */
  findAll(query: ProductQueryDto = {}) {
    const search = query.search
      ? { contains: query.search, mode: 'insensitive' as const }
      : undefined;
    return this.list({
      categoryId: query.categoryId,
      origin: query.origin,
      createdById: query.createdById,
      isActive: query.isActive,
      ...(search
        ? {
            OR: [{ name: search }, { description: search }, { color: search }],
          }
        : {}),
    });
  }

  /** Completed customer designs of other users, optionally of one category. */
  async findCompletedCreationsFromOthers(
    user: AuthenticatedUser,
    categoryId?: string,
  ) {
    const orders = await this.query(() =>
      this.prisma.order.findMany({
        where: {
          status: 'COMPLETED',
          product: {
            createdById: { not: user.id },
            origin: 'CUSTOMER',
            categoryId,
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
    backImage?: Express.Multer.File,
  ) {
    this.requireAdmin(user);
    const printAreas = validatePrintAreas(dto.printAreas);
    return this.images.saveMany(
      [
        { file, folder: 'products' },
        { file: designPreview, folder: 'designs' },
        { file: backDesignPreview, folder: 'designs' },
        { file: backImage, folder: 'products' },
      ],
      async ([key, previewKey, backPreviewKey, backImageKey]) => {
        let oldKey: string | null | undefined;
        let oldPreviewKey: string | null | undefined;
        let oldBackPreviewKey: string | null | undefined;
        let oldBackImageKey: string | null | undefined;
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
            const textLayers =
              dto.textLayers === undefined
                ? undefined
                : this.textLayers(category, dto.textLayers);
            const company = product.origin === 'COMPANY';
            if (
              !company &&
              (COMPANY_FIELDS.some((field) => dto[field] !== undefined) ||
                backImageKey)
            )
              throw new BadRequestException(CUSTOMER_INVENTORY);
            if (
              product.baseProductId &&
              dto.categoryId !== undefined &&
              dto.categoryId !== product.categoryId
            )
              throw new BadRequestException(
                'A design made on a base product stays in its category',
              );
            oldKey = product.imageKey;
            oldPreviewKey = product.designPreviewKey;
            oldBackPreviewKey = product.backDesignPreviewKey;
            oldBackImageKey = product.backImageKey;
            const data: Prisma.ProductUpdateInput = {
              name: dto.name,
              description: dto.description,

              imageKey: key,
              backImageKey,
              designPreviewKey: previewKey,
              backDesignPreviewKey: backPreviewKey,
              isActive: dto.isActive,
              textLayers:
                textLayers === undefined
                  ? undefined
                  : textLayers === null
                    ? Prisma.DbNull
                    : textLayers,
            };
            if (company) {
              const sizes =
                dto.sizes === undefined ? parseSizes(product.sizes) : dto.sizes;
              const inventory = this.companyInventory({
                price: dto.price ?? product.price,
                stock: dto.stock ?? (sizes?.length ? undefined : product.stock),
                sizes,
              });
              data.price = dto.price;
              data.stock = inventory.stock;
              if (dto.sizes !== undefined)
                data.sizes = inventory.sizes ?? Prisma.DbNull;
              data.color = dto.color;
              data.colorHex = dto.colorHex;
              if (dto.printAreas !== undefined)
                data.printAreas = printAreas ?? Prisma.DbNull;
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
                dto.selectedSizeId !== undefined ||
                dto.selectedMeasurementMm !== undefined ||
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
              // Base product and packaging prices were snapshotted when the design was created.
              data.price =
                calculated.price +
                (product.basePrice ?? 0) +
                (product.packagingPrice ?? 0);
              data.itemCount = calculated.itemCount;
              data.items = { deleteMany: {}, create: calculated.items };
            }
            const base = product.baseProductId
              ? await tx.product.findUnique({
                  where: { id: product.baseProductId },
                  select: { name: true, sizes: true },
                })
              : null;
            const baseSizes = parseSizes(base?.sizes);
            if (dto.selectedSizeId !== undefined && base && baseSizes.length) {
              data.selectedSize = this.resolveBaseSize(
                { name: base.name, sizes: baseSizes },
                dto.selectedSizeId,
              );
            } else if (
              dto.selectedSizeId !== undefined ||
              dto.selectedMeasurementMm !== undefined
            ) {
              // A new length alone keeps the stored size; a new size alone keeps the
              // stored length only when it still belongs to that size.
              const stored = selectedMeasuredSize(product.selectedSize);
              const sizeId =
                dto.selectedSizeId ?? selectedSizeId(product.selectedSize);
              if (!sizeId)
                throw new BadRequestException('Choose a size for the length');
              data.selectedSize = await this.resolveSize(
                tx,
                dto.categoryId ?? product.categoryId,
                sizeId,
                dto.items ?? product.items,
                dto.selectedMeasurementMm ??
                  (stored?.id === sizeId
                    ? stored.selectedMeasurementMm
                    : undefined),
              );
            } else if (
              !base &&
              (dto.items !== undefined || dto.categoryId !== undefined)
            ) {
              // Preserve the stored size snapshot; never accept frontend limits.
              const category = await tx.category.findUnique({
                where: { id: dto.categoryId ?? product.categoryId },
                select: { sizes: true },
              });
              if (Array.isArray(category?.sizes) && category.sizes.length > 0)
                await this.validateStoredSize(
                  tx,
                  product.selectedSize,
                  dto.items ?? product.items,
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
          oldKeys: await this.unsharedKeys(
            [
              key ? oldKey : undefined,
              previewKey ? oldPreviewKey : undefined,
              backPreviewKey ? oldBackPreviewKey : undefined,
              backImageKey ? oldBackImageKey : undefined,
            ],
            id,
          ),
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
          backImageKey: true,
          designPreviewKey: true,
          backDesignPreviewKey: true,
          items: { select: { customImageKey: true } },
        },
      }),
    );
    await this.images.cleanup(
      await this.unsharedKeys(
        [
          record.imageKey,
          record.backImageKey,
          record.designPreviewKey,
          record.backDesignPreviewKey,
          ...record.items.map((item) => item.customImageKey),
        ],
        id,
      ),
    );
  }

  /**
   * Keys no other product still uses. Garments sold in several colours were migrated
   * to one product per colour sharing the garment's images, so an image is removed
   * from storage only when its last product lets go of it.
   */
  private async unsharedKeys(
    keys: (string | null | undefined)[],
    productId: string,
  ) {
    const candidates = keys.filter((key): key is string => !!key);
    if (!candidates.length) return [];
    const shared = await this.query(() =>
      this.prisma.product.findMany({
        where: {
          id: { not: productId },
          OR: [
            { imageKey: { in: candidates } },
            { backImageKey: { in: candidates } },
          ],
        },
        select: { imageKey: true, backImageKey: true },
      }),
    );
    const used = new Set(
      shared.flatMap((product) => [product.imageKey, product.backImageKey]),
    );
    return candidates.filter((key) => !used.has(key));
  }

  /**
   * COMPANY inventory is either one `stock` or stock per size, never both. Returns the
   * values to store; sizes is null for an unsized product.
   */
  private companyInventory(dto: {
    price?: number;
    stock?: number;
    sizes?: SizeStock[] | null;
  }) {
    const sizes = dto.sizes?.length ? normalizeSizes(dto.sizes) : null;
    if (sizes && dto.stock !== undefined && dto.stock !== 0)
      throw new BadRequestException(
        'Sized products keep their stock per size; leave stock empty',
      );
    this.validateInventory(dto.price, sizes ? 0 : dto.stock);
    return {
      sizes: sizes as unknown as Prisma.InputJsonArray | null,
      stock: sizes ? 0 : (dto.stock as number),
    };
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

  /**
   * The category size a design is made in, as the snapshot to store. Jewelry sizes are
   * length ranges: the customer's exact length must lie within it, and the components may
   * not measure longer (a design may be unfinished; orders need the minimum price). Legacy
   * sizes keep their component-count limit.
   */
  private async resolveSize(
    tx: Prisma.TransactionClient,
    categoryId: string,
    sizeId: string,
    items: { subCategoryId: string; quantity: number }[],
    selectedMeasurementMm?: number,
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
    const measured = measuredSize(size);
    if (measured) {
      const selected = selectMeasurement(measured, selectedMeasurementMm);
      assertNotOverfilled(
        usedLengthMm(await this.piecesOf(tx, items)),
        selected.selectedMeasurementMm,
      );
      return selected as unknown as Prisma.InputJsonObject;
    }
    if (selectedMeasurementMm !== undefined)
      throw new BadRequestException(
        'This size has no adjustable length; it is set by its number of components',
      );
    this.validateSizeLimit(
      size,
      items.reduce((sum, item) => sum + item.quantity, 0),
    );
    return size as Prisma.InputJsonObject;
  }

  /** Checks changed components against the design's stored size (length or count). */
  private async validateStoredSize(
    tx: Prisma.TransactionClient,
    stored: Prisma.JsonValue | null,
    items: { subCategoryId: string; quantity: number }[],
  ) {
    const measured = selectedMeasuredSize(stored);
    if (measured)
      assertNotOverfilled(
        usedLengthMm(await this.piecesOf(tx, items)),
        measured.selectedMeasurementMm,
      );
    else
      this.validateSizeLimit(
        stored ?? undefined,
        items.reduce((sum, item) => sum + item.quantity, 0),
      );
  }

  /** Each item with its component's physical length, read from the database. */
  private async piecesOf(
    tx: Prisma.TransactionClient,
    items: { subCategoryId: string; quantity: number }[],
  ): Promise<Piece[]> {
    const components = await tx.subCategory.findMany({
      where: {
        id: { in: [...new Set(items.map((item) => item.subCategoryId))] },
      },
      select: { id: true, name: true, effectiveLengthMm: true },
    });
    const byId = new Map(
      components.map((component) => [component.id, component]),
    );
    return items.map((item) => {
      const component = byId.get(item.subCategoryId);
      if (!component)
        throw new NotFoundException(
          'SubCategory not found: ' + item.subCategoryId,
        );
      return {
        name: component.name,
        quantity: item.quantity,
        effectiveLengthMm: component.effectiveLengthMm,
      };
    });
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

  /**
   * Personalised text (gift, bouquet and apparel studios); it is not priced. Apparel text
   * is printed on one side, so it must name it; other studios have one canvas.
   */
  private textLayers(
    category: { builderType: string | null },
    layers: TextLayerDto[] | null | undefined,
  ): Prisma.InputJsonArray | null | undefined {
    if (layers === undefined || layers === null) return layers;
    if (!layers.length) return null;
    if (
      !(TEXT_BUILDERS as readonly string[]).includes(category.builderType ?? '')
    )
      throw new BadRequestException(
        'Only gift, bouquet and apparel designs can include text',
      );
    if (new Set(layers.map((layer) => layer.id)).size !== layers.length)
      throw new BadRequestException('Text layer ids must be unique');
    const apparel = category.builderType === 'APPAREL';
    if (apparel && layers.some((layer) => !layer.side))
      throw new BadRequestException(
        'Apparel text must say which side it is printed on',
      );
    return layers.map((layer) => ({
      id: layer.id,
      text: layer.text,
      x: layer.x,
      y: layer.y,
      scale: layer.scale,
      rotation: layer.rotation,
      ...(apparel ? { side: layer.side } : {}),
      ...(layer.color ? { color: layer.color } : {}),
      ...(layer.font ? { font: layer.font } : {}),
      ...(layer.weight && layer.weight !== 'REGULAR'
        ? { weight: layer.weight }
        : {}),
      ...(layer.italic ? { italic: true } : {}),
    }));
  }

  /**
   * The COMPANY product a design is made on, in the same category. APPAREL designs
   * are always printed on one; other studios may build from components only. Stock is
   * checked here but never taken: it only changes when an order is placed.
   */
  private async resolveBaseProduct(
    tx: Prisma.TransactionClient,
    category: { id: string; builderType: string | null },
    baseProductId: string | undefined,
  ) {
    if (!baseProductId) {
      if (category.builderType === 'APPAREL')
        throw new BadRequestException('Choose the piece to design on');
      return undefined;
    }
    const base = await tx.product.findUnique({
      where: { id: baseProductId },
      select: {
        id: true,
        name: true,
        origin: true,
        categoryId: true,
        isActive: true,
        price: true,
        stock: true,
        sizes: true,
      },
    });
    if (!base || base.origin !== 'COMPANY' || base.categoryId !== category.id)
      throw new BadRequestException('Base product not found in this category');
    if (!base.isActive)
      throw new BadRequestException(`${base.name} is no longer available`);
    const sizes = parseSizes(base.sizes);
    if (!sizes.length && base.stock < 1)
      throw new BadRequestException(`${base.name} is sold out`);
    return { ...base, sizes };
  }

  /** A sized base product needs one of its sizes, in stock right now. */
  private resolveBaseSize(
    base: { name: string; sizes: SizeStock[] },
    sizeId: string | undefined,
  ): Prisma.InputJsonObject {
    if (sizeId === undefined)
      throw new BadRequestException(`Choose a size of ${base.name}`);
    const size = base.sizes.find((entry) => entry.size === sizeId);
    if (!size)
      throw new BadRequestException(
        `${base.name} is not available in size ${sizeId}`,
      );
    if (size.stock < 1)
      throw new BadRequestException(
        `${base.name} in size ${sizeId} is sold out`,
      );
    return { id: size.size, name: size.size };
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
            'A related record no longer exists, or this product is still used by orders or customer designs; deactivate it instead',
          );
      }
      throw new InternalServerErrorException(
        'Unable to complete product operation',
      );
    }
  }
}
