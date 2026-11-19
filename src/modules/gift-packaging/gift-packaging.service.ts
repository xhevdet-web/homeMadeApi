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
import type { CreateGiftPackagingDto } from './dto/create-gift-packaging.dto.js';
import type { UpdateGiftPackagingDto } from './dto/update-gift-packaging.dto.js';
import type {
  CreateGiftPackagingColorDto,
  UpdateGiftPackagingColorDto,
} from './dto/gift-packaging-color.dto.js';
import { typeKey } from './gift-packaging.selection.js';

// Packaging photos are stored as uploaded: a transparent box must keep its own look.
const FOLDER = 'packaging';

const sortOrder = [
  { sortOrder: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.GiftPackagingOrderByWithRelationInput[];

const include = {
  colors: { orderBy: sortOrder },
} satisfies Prisma.GiftPackagingInclude;

const IN_USE =
  'is used by customer gift designs; deactivate it instead so those designs stay intact';

type Bundle = {
  name: string;
  items: { subCategoryId: string; quantity: number }[];
};

const plural = (count: number) => `${count} item${count === 1 ? '' : 's'}`;

/** Admin-typed types, trimmed and listed once each (compared without regard to case). */
function cleanTypes(types: string[]) {
  const seen = new Set<string>();
  return types
    .map((type) => type.trim())
    .filter((type) => {
      const key = typeKey(type);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Each item once per bundle: repeated rows of the same item add up. */
const mergeBundles = (bundles: Bundle[]): Bundle[] =>
  bundles.map((bundle) => {
    const quantities = new Map<string, number>();
    for (const item of bundle.items)
      quantities.set(
        item.subCategoryId,
        (quantities.get(item.subCategoryId) ?? 0) + item.quantity,
      );
    return {
      name: bundle.name.trim(),
      items: [...quantities].map(([subCategoryId, quantity]) => ({
        subCategoryId,
        quantity,
      })),
    };
  });

/** Bundles as stored; anything malformed is left out rather than failing an unrelated edit. */
function storedBundles(value: Prisma.JsonValue | null | undefined): Bundle[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): Bundle[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const { name, items } = raw as Record<string, unknown>;
    if (typeof name !== 'string' || !Array.isArray(items)) return [];
    return [
      {
        name,
        items: items.flatMap((item) => {
          const { subCategoryId, quantity } = (item ?? {}) as Record<
            string,
            unknown
          >;
          return typeof subCategoryId === 'string' &&
            Number.isInteger(quantity) &&
            (quantity as number) > 0
            ? [{ subCategoryId, quantity: quantity as number }]
            : [];
        }),
      },
    ];
  });
}

@Injectable()
export class GiftPackagingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ImageWriteService) private readonly images: ImageWriteService,
  ) {}

  /** Every packaging with its colours; clients hide the inactive ones. */
  findAll() {
    return this.query(() =>
      this.prisma.giftPackaging.findMany({ orderBy: sortOrder, include }),
    );
  }

  async findOne(id: string) {
    const record = await this.query(() =>
      this.prisma.giftPackaging.findUnique({ where: { id }, include }),
    );
    if (!record) throw new NotFoundException('Gift packaging not found');
    return record;
  }

  async create(dto: CreateGiftPackagingDto, file?: Express.Multer.File) {
    // Checked before the image is stored, so a rejected form uploads nothing.
    const contents = await this.contentRules(dto);
    return this.images.save(file, FOLDER, async (key) => ({
      result: await this.query(() =>
        this.prisma.giftPackaging.create({
          data: {
            name: dto.name,
            description: dto.description,
            type: dto.type,
            shape: dto.shape,
            imageKey: key,
            price: dto.price,
            stock: dto.stock,
            ...contents,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
          include,
        }),
      ),
    }));
  }

  async update(
    id: string,
    dto: UpdateGiftPackagingDto,
    file?: Express.Multer.File,
  ) {
    const previous = await this.findOne(id);
    // Transparency is a type, not a colour: a see-through box never keeps colours.
    if (dto.type === 'TRANSPARENT' && previous.colors.length)
      throw new BadRequestException(
        'Remove the colours of ' +
          previous.name +
          ' before making it transparent',
      );
    const contents = await this.contentRules(dto, previous);
    return this.images.save(file, FOLDER, async (key) => ({
      result: await this.query(() =>
        this.prisma.giftPackaging.update({
          where: { id },
          data: {
            name: dto.name,
            description: dto.description,
            type: dto.type,
            shape: dto.shape,
            imageKey: key,
            price: dto.price,
            stock: dto.stock,
            ...contents,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
          include,
        }),
      ),
      oldKeys: key ? [previous.imageKey] : [],
    }));
  }

  async remove(id: string): Promise<void> {
    const record = await this.findOne(id);
    await this.query(
      () => this.prisma.giftPackaging.delete({ where: { id } }),
      record.name + ' ' + IN_USE,
    );
    await this.images.cleanup([
      record.imageKey,
      ...record.colors.map((color) => color.imageKey),
    ]);
  }

  async addColor(
    packagingId: string,
    dto: CreateGiftPackagingColorDto,
    file?: Express.Multer.File,
  ) {
    const packaging = await this.findOne(packagingId);
    if (packaging.type !== 'OPAQUE')
      throw new BadRequestException(
        'Only closed (opaque) packaging can have colours',
      );
    return this.images.save(file, FOLDER, async (key) => ({
      result: await this.query(() =>
        this.prisma.giftPackagingColor.create({
          data: {
            packagingId,
            name: dto.name,
            hex: dto.hex.toUpperCase(),
            imageKey: key,
            priceAdjustment: dto.priceAdjustment,
            stock: dto.stock,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
        }),
      ),
    }));
  }

  async updateColor(
    packagingId: string,
    colorId: string,
    dto: UpdateGiftPackagingColorDto,
    file?: Express.Multer.File,
  ) {
    const previous = await this.findColor(packagingId, colorId);
    return this.images.save(file, FOLDER, async (key) => ({
      result: await this.query(() =>
        this.prisma.giftPackagingColor.update({
          where: { id: colorId, packagingId },
          data: {
            name: dto.name,
            hex: dto.hex?.toUpperCase(),
            imageKey: key,
            priceAdjustment: dto.priceAdjustment,
            stock: dto.stock,
            isActive: dto.isActive,
            sortOrder: dto.sortOrder,
          },
        }),
      ),
      oldKeys: key ? [previous.imageKey] : [],
    }));
  }

  async removeColor(packagingId: string, colorId: string): Promise<void> {
    const record = await this.findColor(packagingId, colorId);
    await this.query(
      () =>
        this.prisma.giftPackagingColor.delete({
          where: { id: colorId, packagingId },
        }),
      record.name + ' ' + IN_USE,
    );
    await this.images.cleanup([record.imageKey]);
  }

  /**
   * Capacity, allowed types and suggested bundles must agree: every bundle holds only gift
   * items of an allowed type and fits the capacity. Stored bundles are checked again when
   * the capacity or types change; items deleted since are skipped, as the clients skip them.
   * Returns the fields to write (undefined = unchanged).
   */
  private async contentRules(
    dto: CreateGiftPackagingDto | UpdateGiftPackagingDto,
    previous?: {
      name: string;
      capacity: number | null;
      allowedTypes: string[];
      suggestedBundles: Prisma.JsonValue;
    },
  ) {
    const allowedTypes =
      dto.allowedTypes === undefined ? undefined : cleanTypes(dto.allowedTypes);
    const given = dto.suggestedBundles !== undefined;
    const fields = {
      capacity: dto.capacity,
      allowedTypes,
      suggestedBundles: undefined as
        Prisma.InputJsonValue | typeof Prisma.DbNull | undefined,
    };
    if (!given && dto.capacity === undefined && allowedTypes === undefined)
      return fields;

    const name = dto.name ?? previous?.name ?? 'This packaging';
    const capacity =
      dto.capacity === undefined ? (previous?.capacity ?? null) : dto.capacity;
    const allowed = new Set(
      (allowedTypes ?? previous?.allowedTypes ?? []).map(typeKey),
    );
    const bundles = given
      ? mergeBundles(dto.suggestedBundles ?? [])
      : storedBundles(previous?.suggestedBundles);
    const ids = [
      ...new Set(
        bundles.flatMap((bundle) =>
          bundle.items.map((item) => item.subCategoryId),
        ),
      ),
    ];
    const components = ids.length
      ? await this.query(() =>
          this.prisma.subCategory.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              name: true,
              type: true,
              category: { select: { builderType: true } },
            },
          }),
        )
      : [];
    const byId = new Map(components.map((c) => [c.id, c]));
    const names = new Set<string>();
    for (const bundle of bundles) {
      const key = bundle.name.toLowerCase();
      if (names.has(key))
        throw new BadRequestException(
          `Two bundles are called "${bundle.name}"; give each its own name`,
        );
      names.add(key);
      let count = 0;
      for (const item of bundle.items) {
        const component = byId.get(item.subCategoryId);
        if (!component) {
          if (given)
            throw new BadRequestException(
              `An item of "${bundle.name}" no longer exists; remove it from the bundle`,
            );
          continue;
        }
        if (given && component.category.builderType !== 'GIFT')
          throw new BadRequestException(
            `${component.name} is not a gift item, so it cannot be in "${bundle.name}"`,
          );
        if (allowed.size && !allowed.has(typeKey(component.type)))
          throw new BadRequestException(
            `"${bundle.name}" includes ${component.name} (type ${component.type?.trim() || 'not set'}), which ${name} does not accept`,
          );
        count += item.quantity;
      }
      if (capacity !== null && count > capacity)
        throw new BadRequestException(
          `"${bundle.name}" has ${plural(count)}, but ${name} holds ${plural(capacity)}`,
        );
    }
    if (given)
      fields.suggestedBundles = bundles.length
        ? (bundles as Prisma.InputJsonValue)
        : Prisma.DbNull;
    return fields;
  }

  private async findColor(packagingId: string, colorId: string) {
    const record = await this.query(() =>
      this.prisma.giftPackagingColor.findFirst({
        where: { id: colorId, packagingId },
      }),
    );
    if (!record) throw new NotFoundException('Packaging colour not found');
    return record;
  }

  private async query<T>(
    operation: () => Promise<T>,
    inUse = 'Packaging ' + IN_USE,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002')
          throw new ConflictException(
            'A packaging or colour with this name already exists',
          );
        if (error.code === 'P2025')
          throw new NotFoundException('Gift packaging not found');
        if (error.code === 'P2003') throw new ConflictException(inUse);
      }
      throw new InternalServerErrorException(
        'Unable to complete gift packaging operation',
      );
    }
  }
}
