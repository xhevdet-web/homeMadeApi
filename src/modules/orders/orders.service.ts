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
import { productItemsSelect } from '../products/product-items.select.js';
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
        itemCount: true,
        price: true,
        category: {
          select: {
            id: true,
            name: true,
            description: true,

            imageKey: true,
          },
        },
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
                name: true,
                description: true,
                imageKey: true,
                designPreviewKey: true,
                category: {
                  select: {
                    id: true,
                    name: true,
                    description: true,
                    imageKey: true,
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
                    subCategory: {
                      select: {
                        id: true,
                        name: true,
                        categoryId: true,
                        description: true,
                        imageKey: true,
                        color: true,
                        type: true,
                        price: true,
                        stock: true,
                        isActive: true,
                      },
                    },
                  },
                },
              },
            });
            if (!product) throw new NotFoundException('Product not found');
            if (user.role !== 'ADMIN' && product.createdById !== user.id)
              throw new ForbiddenException(
                'You can only order your own products',
              );
            if (!product.items.length)
              throw new BadRequestException(
                'Product has no components; restore or recreate the design before ordering',
              );
            const quantities = new Map<string, number>();
            let totalPrice = 0;
            for (const item of product.items) {
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
              quantities.set(item.subCategoryId, quantity);
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
            const snapshot = {
              id: product.id,
              name: product.name,
              description: product.description,
              imageKey: await copyImage(product.imageKey),
              designPreviewKey: previewKey,
              price: totalPrice,
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
                subCategory: {
                  id: string;
                  categoryId: string;
                  name: string;
                  description: string | null;
                  imageKey: string | null;
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
                subCategory: {
                  id: component.id,
                  categoryId: component.categoryId,
                  name: component.name,
                  description: component.description,
                  imageKey: await copyImage(component.imageKey),
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
      return { ...order, product: snapshot.product } as T;
    // Legacy orders have no verifiable historical snapshot. Preserve existing behavior.
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
