import { randomInt, randomUUID } from 'node:crypto';
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
import { Prisma, OrderStatus } from '../../generated/prisma/client.js';
import {
  garmentVariantSelect,
  productItemsSelect,
} from '../products/product-items.select.js';
import { StorageService } from '../../storage/storage.service.js';
import { ImageWriteService } from '../../storage/image-write.service.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import type { CreateOrderDto } from './dto/create-order.dto.js';
import type { UpdateOrderDto } from './dto/update-order.dto.js';
import type { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import type { UpdatePaymentStatusDto } from './dto/update-payment-status.dto.js';
import type { OrderQueryDto } from './dto/order-query.dto.js';

const workflow: OrderStatus[] = [
  'ORDERED',
  'CREATING',
  'CREATED',
  'READY_FOR_COURIER',
  'PICKED_UP_BY_COURIER',
  'COMPLETED',
];

function orderSelect(user: AuthenticatedUser) {
  return {
    id: true,
    userId: true,
    productId: true,
    orderNumber: true,
    status: true,
    paymentType: true,
    paymentStatus: true,
    totalPrice: true,
    designSnapshot: true,
    designPreviewKey: true,
    firstName: true,
    lastName: true,
    phone: true,
    country: true,
    address: true,
    postalCode: true,
    customerNotes: true,
    adminNotes: user.role === 'ADMIN',
    finalImageUrl: true,
    createdAt: true,
    updatedAt: true,
    user: {
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
      },
    },
    product: {
      select: {
        id: true,
        name: true,
        description: true,

        imageKey: true,
        designPreviewKey: true,
        backDesignPreviewKey: true,
        itemCount: true,
        price: true,
        basePrice: true,
        productType: true,
        stock: true,
        selectedOptions: true,
        category: {
          select: {
            id: true,
            name: true,
            description: true,

            imageKey: true,
            builderType: true,
            options: true,
            builderConfig: true,
          },
        },
        garmentVariant: { select: garmentVariantSelect },
        items: productItemsSelect,
      },
    },
  } satisfies Prisma.OrderSelect;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ImageWriteService) private readonly images: ImageWriteService,
  ) {}

  async create(dto: CreateOrderDto, user: AuthenticatedUser) {
    const { firstName, lastName, phone, country, address, postalCode } = user;
    if (
      !firstName?.trim() ||
      !lastName?.trim() ||
      !phone?.trim() ||
      !country?.trim() ||
      !address?.trim()
    )
      throw new BadRequestException(
        'Complete firstName, lastName, phone, country and address in your profile before ordering',
      );

    // Retry the ENTIRE transaction after a unique collision or serialization/deadlock error.
    // PostgreSQL cannot continue a transaction after a failed statement.
    for (let attempt = 0; attempt < 5; attempt++) {
      const copiedKeys: string[] = [];
      try {
        const created = await this.prisma.$transaction(
          async (tx) => {
            // ProductsService.update uses the same lock before editing components.
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${dto.productId} FOR UPDATE`;
            const product = await tx.product.findUnique({
              where: { id: dto.productId },
              select: {
                id: true,
                createdById: true,
                createdBy: { select: { role: true } },
                productType: true,
                selectedSize: true,
                selectedOptions: true,
                textLayers: true,
                price: true,
                stock: true,
                isActive: true,
                name: true,
                description: true,
                imageKey: true,
                designPreviewKey: true,
                backDesignPreviewKey: true,
                basePrice: true,
                category: {
                  select: {
                    id: true,
                    name: true,
                    description: true,
                    imageKey: true,
                    builderType: true,
                    options: true,
                    builderConfig: true,
                  },
                },
                garmentVariant: {
                  select: {
                    id: true,
                    size: true,
                    colorName: true,
                    colorValue: true,
                    sku: true,
                    isActive: true,
                    garment: {
                      select: {
                        id: true,
                        name: true,
                        isActive: true,
                        imageKey: true,
                        frontImageKey: true,
                        backImageKey: true,
                        frontPrintArea: true,
                        backPrintArea: true,
                        silhouette: true,
                      },
                    },
                  },
                },
                items: {
                  orderBy: [{ position: 'asc' }, { id: 'asc' }],
                  select: {
                    id: true,
                    subCategoryId: true,
                    quantity: true,
                    unitPrice: true,
                    position: true,
                    customImageKey: true,
                    side: true,
                    x: true,
                    y: true,
                    scale: true,
                    rotation: true,
                    subCategory: {
                      select: {
                        id: true,
                        name: true,
                        categoryId: true,
                        description: true,
                        imageKey: true,
                        originalImageKey: true,
                        color: true,
                        type: true,
                        price: true,
                        stock: true,
                        trackStock: true,
                        isActive: true,
                      },
                    },
                  },
                },
              },
            });
            if (!product) throw new NotFoundException('Product not found');
            const readyMade = product.productType === 'READY_MADE';
            if (readyMade) {
              if (!product.isActive || product.createdBy.role !== 'ADMIN')
                throw new BadRequestException(
                  'Only active ready-made products created by admins can be ordered',
                );
              const reserved = await tx.product.updateMany({
                where: {
                  id: product.id,
                  productType: 'READY_MADE',
                  isActive: true,
                  stock: { gte: 1 },
                },
                data: { stock: { decrement: 1 } },
              });
              if (reserved.count !== 1)
                throw new BadRequestException(
                  'Insufficient finished-product stock',
                );
            }
            if (
              !readyMade &&
              user.role !== 'ADMIN' &&
              product.createdById !== user.id
            )
              throw new ForbiddenException(
                'You can only order your own products',
              );
            if (
              !readyMade &&
              !product.items.length &&
              (!product.category.builderType ||
                product.category.builderType === 'JEWELRY')
            )
              throw new BadRequestException(
                'Product has no components; restore or recreate the design before ordering',
              );
            const apparel = product.category.builderType === 'APPAREL';
            const variant = product.garmentVariant;
            if (apparel && !readyMade) {
              if (!variant)
                throw new BadRequestException(
                  'Choose a garment size and colour before ordering this design',
                );
              if (!variant.isActive || !variant.garment.isActive)
                throw new BadRequestException(
                  `${variant.garment.name} in ${variant.colorName} / ${variant.size} is no longer available`,
                );
            }
            const quantities = new Map<string, number>();
            // Custom designs start from the garment price snapshotted on the design.
            let totalPrice = readyMade
              ? product.price
              : (product.basePrice ?? 0);
            if (!Number.isInteger(totalPrice) || totalPrice < 0)
              throw new BadRequestException('Product has an invalid price');
            for (const item of readyMade ? [] : product.items) {
              if (
                !Number.isInteger(item.quantity) ||
                item.quantity <= 0 ||
                !Number.isInteger(item.unitPrice) ||
                item.unitPrice < 0
              )
                throw new BadRequestException(
                  'Product contains invalid component quantities or prices',
                );
              const quantity =
                (quantities.get(item.subCategoryId) ?? 0) + item.quantity;
              totalPrice += item.unitPrice * item.quantity;
              if (quantity > 2147483647 || totalPrice > 2147483647)
                throw new BadRequestException(
                  'Product quantity or price exceeds the supported integer range',
                );
              // Printed (unlimited) designs never consume inventory.
              if (item.subCategory.trackStock !== false)
                quantities.set(item.subCategoryId, quantity);
              else if (!item.subCategory.isActive)
                throw new BadRequestException(
                  'SubCategory is inactive: ' + item.subCategory.name,
                );
            }
            // Preflight aggregated requirements, including repeated beads at different positions.
            for (const [subCategoryId, requestedQuantity] of quantities) {
              const component = product.items.find(
                (item) => item.subCategoryId === subCategoryId,
              )!.subCategory;
              if (!component.isActive)
                throw new BadRequestException(
                  'SubCategory is inactive: ' + component.name,
                );
              if (component.stock < requestedQuantity)
                this.insufficientStock(component, requestedQuantity);
            }

            const orderId = randomUUID();
            const copies = new Map<string, string>();
            const copyImage = async (source?: string | null) => {
              if (!source) return null;
              const existing = copies.get(source);
              if (existing) return existing;
              const { key } = await this.storage.copy(
                source,
                'orders/' + orderId,
              );
              copiedKeys.push(key);
              copies.set(source, key);
              return key;
            };
            const previewKey = await copyImage(product.designPreviewKey);
            const backPreviewKey = await copyImage(
              product.backDesignPreviewKey,
            );
            const snapshot = {
              id: product.id,
              productType: product.productType ?? 'CUSTOM_DESIGN',
              selectedSize: product.selectedSize ?? null,
              selectedOptions: product.selectedOptions ?? null,
              // Personalised gift text, printed exactly as ordered.
              textLayers: product.textLayers ?? null,
              stock: product.stock ?? 0,
              name: product.name,
              description: product.description,
              imageKey: await copyImage(product.imageKey),
              designPreviewKey: previewKey,
              backDesignPreviewKey: backPreviewKey,
              basePrice: product.basePrice ?? 0,
              price: totalPrice,
              // The exact garment bought, frozen for order history and production.
              garmentVariant: variant
                ? {
                    id: variant.id,
                    size: variant.size,
                    colorName: variant.colorName,
                    colorValue: variant.colorValue,
                    sku: variant.sku,
                    garment: {
                      id: variant.garment.id,
                      name: variant.garment.name,
                      imageKey: await copyImage(variant.garment.imageKey),
                      // Mockups and print areas let production reproduce placements in cm.
                      frontImageKey: await copyImage(
                        variant.garment.frontImageKey,
                      ),
                      backImageKey: await copyImage(
                        variant.garment.backImageKey,
                      ),
                      frontPrintArea: variant.garment.frontPrintArea,
                      backPrintArea: variant.garment.backPrintArea,
                      silhouette: variant.garment.silhouette,
                    },
                  }
                : null,
              itemCount: product.items.reduce(
                (sum, item) => sum + item.quantity,
                0,
              ),
              category: product.category
                ? {
                    ...product.category,
                    imageKey: await copyImage(product.category.imageKey),
                  }
                : null,
              items: [] as {
                id: string;
                subCategoryId: string;
                quantity: number;
                position: number | null;
                unitPrice: number;
                customImageKey: string | null;
                side: string | null;
                x: number | null;
                y: number | null;
                scale: number | null;
                rotation: number | null;
                subCategory: {
                  id: string;
                  categoryId: string;
                  name: string;
                  description: string | null;
                  imageKey: string | null;
                  originalImageKey: string | null;
                  color: string | null;
                  type: string | null;
                  price: number;
                };
              }[],
            };
            for (const item of product.items) {
              const component = item.subCategory;
              snapshot.items.push({
                id: item.id,
                subCategoryId: item.subCategoryId,
                quantity: item.quantity,
                position: item.position,
                unitPrice: item.unitPrice,
                // The customer's own artwork is copied with the order, like every image.
                customImageKey: await copyImage(item.customImageKey),
                side: item.side,
                x: item.x,
                y: item.y,
                scale: item.scale,
                rotation: item.rotation,
                subCategory: {
                  id: component.id,
                  categoryId: component.categoryId,
                  name: component.name,
                  description: component.description,
                  imageKey: await copyImage(component.imageKey),
                  originalImageKey: await copyImage(component.originalImageKey),
                  color: component.color,
                  type: component.type,
                  price: component.price,
                },
              });
            }
            const order = await tx.order.create({
              data: {
                id: orderId,
                userId: user.id,
                productId: product.id,
                orderNumber:
                  'HM-' +
                  new Date().getUTCFullYear() +
                  '-' +
                  randomInt(1, 1000000000).toString().padStart(9, '0'),
                status: 'ORDERED',
                paymentStatus: 'UNPAID',
                paymentType: dto.paymentType,
                totalPrice,
                designPreviewKey: previewKey,
                designSnapshot: {
                  version: 1,
                  product: snapshot,
                  ownedImageKeys: copiedKeys,
                },
                firstName,
                lastName,
                phone,
                country,
                address,
                postalCode,
                customerNotes: dto.customerNotes,
              },
              select: orderSelect(user),
            });
            if (apparel && variant && !readyMade) {
              // Atomic: concurrent orders for the last Red / S cannot both succeed.
              const reserved = await tx.garmentVariant.updateMany({
                where: { id: variant.id, isActive: true, stock: { gte: 1 } },
                data: { stock: { decrement: 1 } },
              });
              if (reserved.count !== 1)
                throw new BadRequestException(
                  `${variant.garment.name} in ${variant.colorName} / ${variant.size} just sold out`,
                );
            }
            // Stable lock order prevents two multi-component orders locking inventory in opposite order.
            for (const [subCategoryId, requestedQuantity] of [
              ...quantities,
            ].sort(([a], [b]) => a.localeCompare(b))) {
              const result = await tx.subCategory.updateMany({
                where: {
                  id: subCategoryId,
                  isActive: true,
                  stock: { gte: requestedQuantity },
                },
                data: { stock: { decrement: requestedQuantity } },
              });
              if (result.count !== 1) {
                const component = await tx.subCategory.findUnique({
                  where: { id: subCategoryId },
                  select: { id: true, name: true, stock: true, isActive: true },
                });
                if (!component)
                  throw new NotFoundException(
                    'SubCategory not found: ' + subCategoryId,
                  );
                if (!component.isActive)
                  throw new BadRequestException(
                    'SubCategory is inactive: ' + component.name,
                  );
                this.insufficientStock(component, requestedQuantity);
              }
            }
            return order;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: 120000,
          },
        );
        return this.snapshotResponse(created);
      } catch (error) {
        // A rolled-back transaction owns no images. Clean every copy before retrying.
        try {
          await this.images.cleanup(copiedKeys);
        } catch {
          /* Cleanup helper logs safe keys for operator recovery; preserve original error. */
        }
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ['P2002', 'P2034'].includes(error.code)
        )
          continue;
        this.handleError(error);
      }
    }
    throw new ConflictException(
      'Unable to create order due to a concurrent change; please retry',
    );
  }

  private insufficientStock(
    component: { id: string; name: string; stock: number },
    requestedQuantity: number,
  ): never {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Insufficient inventory',
      message:
        'Insufficient inventory for ' +
        component.name +
        ': requested ' +
        requestedQuantity +
        ', available ' +
        component.stock,
      subCategoryId: component.id,
      subCategoryName: component.name,
      requestedQuantity,
      availableQuantity: component.stock,
    });
  }

  async findAll(dto: OrderQueryDto, user: AuthenticatedUser) {
    if (
      user.role !== 'ADMIN' &&
      dto.userId !== undefined &&
      dto.userId !== user.id
    )
      throw new ForbiddenException('You can only retrieve your own orders');
    const where: Prisma.OrderWhereInput = {
      userId: user.role === 'ADMIN' ? dto.userId : user.id,
      status: dto.status,
      paymentStatus: dto.paymentStatus,
      paymentType: dto.paymentType,
      orderNumber: dto.orderNumber
        ? { contains: dto.orderNumber, mode: 'insensitive' }
        : undefined,
    };
    const [data, total] = await this.query(() =>
      Promise.all([
        this.prisma.order.findMany({
          where,
          select: orderSelect(user),
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (dto.page - 1) * dto.limit,
          take: dto.limit,
        }),
        this.prisma.order.count({ where }),
      ]),
    );
    return {
      data: data.map((order) => this.snapshotResponse(order)),
      meta: {
        page: dto.page,
        limit: dto.limit,
        total,
        totalPages: Math.ceil(total / dto.limit),
      },
    };
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const order = await this.query(() =>
      this.prisma.order.findUnique({
        where: { id, ...(user.role === 'ADMIN' ? {} : { userId: user.id }) },
        select: orderSelect(user),
      }),
    );
    if (!order) throw new NotFoundException('Order not found');
    return this.snapshotResponse(order);
  }

  update(id: string, dto: UpdateOrderDto, user: AuthenticatedUser) {
    this.requireAdmin(user);
    return this.query(() =>
      this.prisma.order.update({
        where: { id },
        data: { adminNotes: dto.adminNotes, finalImageUrl: dto.finalImageUrl },
        select: orderSelect(user),
      }),
    ).then((order) => this.snapshotResponse(order));
  }

  async updateStatus(
    id: string,
    dto: UpdateOrderStatusDto,
    user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    const order = await this.findOne(id, user);
    if (workflow[workflow.indexOf(order.status) + 1] !== dto.status)
      throw new BadRequestException(
        'Order status must advance exactly one step in the workflow',
      );
    // Include the previous status so a stale request cannot overwrite a concurrent transition.
    return this.query(
      () =>
        this.prisma.order.update({
          where: { id, status: order.status },
          data: { status: dto.status },
          select: orderSelect(user),
        }),
      true,
    ).then((order) => this.snapshotResponse(order));
  }

  updatePaymentStatus(
    id: string,
    dto: UpdatePaymentStatusDto,
    user: AuthenticatedUser,
  ) {
    this.requireAdmin(user);
    return this.query(() =>
      this.prisma.order.update({
        where: { id },
        data: { paymentStatus: dto.paymentStatus },
        select: orderSelect(user),
      }),
    ).then((order) => this.snapshotResponse(order));
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    this.requireAdmin(user);
    const record = await this.query(() =>
      this.prisma.order.delete({
        where: { id },
        select: { id: true, designSnapshot: true, designPreviewKey: true },
      }),
    );
    const snapshot = record.designSnapshot;
    const ownedKeys =
      snapshot &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      Array.isArray(snapshot.ownedImageKeys)
        ? snapshot.ownedImageKeys
        : [];
    await this.images.cleanup(
      [...ownedKeys, record.designPreviewKey].filter(
        (key): key is string =>
          typeof key === 'string' &&
          key.startsWith('orders/' + record.id + '/'),
      ),
    );
  }

  private snapshotResponse<
    T extends { designSnapshot?: Prisma.JsonValue | null; product?: unknown },
  >(order: T): T {
    const snapshot = order.designSnapshot;
    if (
      snapshot &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      snapshot.version === 1 &&
      snapshot.product &&
      typeof snapshot.product === 'object' &&
      !Array.isArray(snapshot.product)
    )
      return {
        ...order,
        product: {
          ...snapshot.product,
          selectedSize: snapshot.product.selectedSize ?? null,
          selectedOptions: snapshot.product.selectedOptions ?? null,
        },
      } as T;
    // A current product size is not evidence of the size bought in a legacy order.
    if (
      order.product &&
      typeof order.product === 'object' &&
      !Array.isArray(order.product)
    )
      return {
        ...order,
        product: {
          ...order.product,
          selectedSize: null,
          selectedOptions: null,
        },
      } as T;
    return order;
  }

  private requireAdmin(user: AuthenticatedUser) {
    if (user.role !== 'ADMIN')
      throw new ForbiddenException('Only admins can manage orders');
  }

  private async query<T>(
    operation: () => Promise<T>,
    staleStatus = false,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.handleError(error, staleStatus);
    }
  }

  private handleError(error: unknown, staleStatus = false): never {
    if (error instanceof HttpException) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        if (staleStatus)
          throw new ConflictException(
            'Order changed or was deleted; reload before updating its status',
          );
        throw new NotFoundException('Order not found');
      }
      if (error.code === 'P2002')
        throw new ConflictException('Order number already exists');
      if (error.code === 'P2003')
        throw new ConflictException(
          'A related record no longer exists or the order is still referenced',
        );
    }
    throw new InternalServerErrorException(
      'Unable to complete order operation',
    );
  }
}
