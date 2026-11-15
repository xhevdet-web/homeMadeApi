import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { productInclude } from '../products/products.service.js';
import type {
  CreateSavedDesignDto,
  DuplicateSavedDesignDto,
  UpdateSavedDesignDto,
} from './dto/saved-design.dto.js';

/** A generous cap so one account can't grow the table without bound. */
export const MAX_SAVED_DESIGNS = 500;
const NAME_MAX = 200;

const savedDesignSelect = {
  id: true,
  name: true,
  productId: true,
  createdAt: true,
  updatedAt: true,
  product: { include: productInclude },
} satisfies Prisma.SavedDesignSelect;

/**
 * "My designs": only the designs a customer explicitly saved. Every read and change is
 * scoped to the user id from the authenticated session, so one customer can never see or
 * change another's saved designs; someone else's id reads as "not found".
 *
 * A saved design points at a CUSTOMER Product the same customer created. Products are
 * never changed or deleted here: an ordered design is frozen, so saving changes creates
 * a new Product (POST /products) and moves the link to it. Orders keep their own product.
 */
@Injectable()
export class SavedDesignsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  findMine(userId: string) {
    return this.query(() =>
      this.prisma.savedDesign.findMany({
        where: { userId },
        select: savedDesignSelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    );
  }

  async findOne(userId: string, id: string) {
    const saved = await this.query(() =>
      this.prisma.savedDesign.findFirst({
        where: { id, userId },
        select: savedDesignSelect,
      }),
    );
    if (!saved) throw new NotFoundException('Saved design not found');
    return saved;
  }

  async create(userId: string, dto: CreateSavedDesignDto) {
    const product = await this.ownDesign(userId, dto.productId);
    await this.assertRoom(userId);
    return this.query(() =>
      this.prisma.savedDesign.create({
        data: {
          userId,
          productId: product.id,
          name: dto.name ?? product.name.slice(0, NAME_MAX),
        },
        select: savedDesignSelect,
      }),
    );
  }

  async update(userId: string, id: string, dto: UpdateSavedDesignDto) {
    await this.owned(userId, id);
    if (dto.productId !== undefined) await this.ownDesign(userId, dto.productId);
    return this.query(() =>
      this.prisma.savedDesign.update({
        where: { id },
        data: { name: dto.name, productId: dto.productId },
        select: savedDesignSelect,
      }),
    );
  }

  /**
   * A second saved design on the same version. They stay independent: the version itself
   * never changes, and saving changes to either one moves only that one to a new version.
   */
  async duplicate(userId: string, id: string, dto: DuplicateSavedDesignDto) {
    const original = await this.owned(userId, id);
    await this.assertRoom(userId);
    return this.query(() =>
      this.prisma.savedDesign.create({
        data: {
          userId,
          productId: original.productId,
          name: dto.name ?? `${original.name} (copy)`.slice(0, NAME_MAX),
        },
        select: savedDesignSelect,
      }),
    );
  }

  /** Removes the saved design only; its Product and any orders of it stay. */
  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.query(() =>
      this.prisma.savedDesign.deleteMany({ where: { id, userId } }),
    );
    if (!count) throw new NotFoundException('Saved design not found');
  }

  private async owned(userId: string, id: string) {
    const saved = await this.query(() =>
      this.prisma.savedDesign.findFirst({
        where: { id, userId },
        select: { id: true, name: true, productId: true },
      }),
    );
    if (!saved) throw new NotFoundException('Saved design not found');
    return saved;
  }

  /** The customer's own design: catalog products and other customers' designs are "not found". */
  private async ownDesign(userId: string, productId: string) {
    const product = await this.query(() =>
      this.prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, origin: true, createdById: true },
      }),
    );
    if (
      !product ||
      product.origin !== 'CUSTOMER' ||
      product.createdById !== userId
    )
      throw new NotFoundException('Design not found');
    return product;
  }

  private async assertRoom(userId: string) {
    const count = await this.query(() =>
      this.prisma.savedDesign.count({ where: { userId } }),
    );
    if (count >= MAX_SAVED_DESIGNS)
      throw new BadRequestException(
        `You can keep up to ${MAX_SAVED_DESIGNS} saved designs; delete one to save another`,
      );
  }

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      )
        throw new NotFoundException('Saved design not found');
      throw new InternalServerErrorException(
        'Unable to complete saved design operation',
      );
    }
  }
}
