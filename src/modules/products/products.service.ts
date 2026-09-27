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
  category: { select: { id: true, name: true, imageUrl: true } },
  items: productItemsSelect,
} satisfies Prisma.ProductInclude;

@Injectable()
export class ProductsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  create(dto: CreateProductDto, user: AuthenticatedUser) {
    return this.query(() =>
      this.prisma.$transaction(async (tx) => {
        const calculated = await this.calculateItems(
          tx,
          dto.categoryId,
          dto.items,
        );
        return tx.product.create({
          data: {
            createdById: user.id,
            categoryId: dto.categoryId,
            name: dto.name,
            description: dto.description,
            imageUrl: dto.imageUrl,
            isActive: dto.isActive,
            price: calculated.price,
            itemCount: calculated.itemCount,
            items: { create: calculated.items },
          },
          include: productInclude,
        });
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

  update(id: string, dto: UpdateProductDto, user: AuthenticatedUser) {
    this.requireAdmin(user);
    return this.query(() =>
      this.prisma.$transaction(async (tx) => {
        // Shared lock protocol with order creation: a design cannot change underneath an order.
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
        const product = await tx.product.findUnique({
          where: { id },
          include: { items: true, _count: { select: { orders: true } } },
        });
        if (!product) throw new NotFoundException('Product not found');
        const data: Prisma.ProductUpdateInput = {
          name: dto.name,
          description: dto.description,
          imageUrl: dto.imageUrl,
          isActive: dto.isActive,
        };
        if (product._count.orders > 0) {
          // Orders reference this design. Preserve quantities and unit-price snapshots for order history.
          if (
            dto.items !== undefined ||
            (dto.categoryId !== undefined &&
              dto.categoryId !== product.categoryId)
          )
            throw new ConflictException(
              'Ordered product components cannot be changed; create a new product design',
            );
        } else {
          const categoryId = dto.categoryId ?? product.categoryId;
          const items =
            dto.items ??
            product.items.map((item) => ({
              subCategoryId: item.subCategoryId,
              quantity: item.quantity,
              position: item.position ?? undefined,
            }));
          const calculated = await this.calculateItems(tx, categoryId, items);
          data.category = { connect: { id: categoryId } };
          data.price = calculated.price;
          data.itemCount = calculated.itemCount;
          data.items = { deleteMany: {}, create: calculated.items };
        }
        return tx.product.update({
          where: { id },
          data,
          include: productInclude,
        });
      }),
    );
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    this.requireAdmin(user);
    await this.query(() =>
      this.prisma.product.delete({ where: { id }, select: { id: true } }),
    );
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
