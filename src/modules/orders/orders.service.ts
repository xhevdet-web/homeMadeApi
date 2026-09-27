import { randomInt } from 'node:crypto';
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
        imageUrl: true,
        itemCount: true,
        price: true,
        category: {
          select: { id: true, name: true, description: true, imageUrl: true },
        },
        items: productItemsSelect,
      },
    },
  } satisfies Prisma.OrderSelect;
}

@Injectable()
export class OrdersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // ProductsService.update uses the same lock before editing components.
            await tx.$queryRaw`SELECT id FROM products WHERE id = ${dto.productId} FOR UPDATE`;
            const product = await tx.product.findUnique({
              where: { id: dto.productId },
              select: {
                id: true,
                createdById: true,
                items: {
                  select: {
                    subCategoryId: true,
                    quantity: true,
                    unitPrice: true,
                    subCategory: {
                      select: {
                        id: true,
                        name: true,
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

            const order = await tx.order.create({
              data: {
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
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
      } catch (error) {
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
      data,
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
    return order;
  }

  update(id: string, dto: UpdateOrderDto, user: AuthenticatedUser) {
    this.requireAdmin(user);
    return this.query(() =>
      this.prisma.order.update({
        where: { id },
        data: { adminNotes: dto.adminNotes, finalImageUrl: dto.finalImageUrl },
        select: orderSelect(user),
      }),
    );
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
    );
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
    );
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    this.requireAdmin(user);
    await this.query(() =>
      this.prisma.order.delete({ where: { id }, select: { id: true } }),
    );
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
