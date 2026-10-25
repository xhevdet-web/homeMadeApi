import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ProductSizeDto } from './dto/product-size.dto.js';

/** One size of a COMPANY product with its own stock, stored in Product.sizes. */
export interface SizeStock {
  size: string;
  stock: number;
}

/** Admin input → stored sizes; size labels are unique ignoring case. */
export function normalizeSizes(sizes: ProductSizeDto[]): SizeStock[] {
  const seen = new Set<string>();
  return sizes.map(({ size, stock }) => {
    const label = size.trim();
    if (seen.has(label.toLowerCase()))
      throw new BadRequestException(`Size ${label} is listed twice`);
    seen.add(label.toLowerCase());
    return { size: label, stock };
  });
}

/** Stored sizes; malformed entries are ignored. Empty when the product is unsized. */
export function parseSizes(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    typeof entry.size === 'string' &&
    typeof entry.stock === 'number'
      ? [{ size: entry.size, stock: entry.stock }]
      : [],
  );
}

/** The size id a customer design stores, e.g. { id: 'L', name: 'L' } → 'L'. */
export function selectedSizeId(value: Prisma.JsonValue | null | undefined) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.id === 'string'
    ? value.id
    : undefined;
}

/**
 * Takes one unit of a size from a sized COMPANY product. The caller must hold the
 * product's row lock (SELECT … FOR UPDATE) so concurrent orders cannot both take the
 * last unit; the read and the write below then see the same sizes.
 */
export async function takeSizeStock(
  tx: Prisma.TransactionClient,
  product: { id: string; name: string },
  size: string,
) {
  const current = await tx.product.findUnique({
    where: { id: product.id },
    select: { sizes: true },
  });
  const sizes = parseSizes(current?.sizes);
  const entry = sizes.find((candidate) => candidate.size === size);
  if (!entry)
    throw new BadRequestException(
      `${product.name} is no longer available in size ${size}`,
    );
  if (entry.stock < 1)
    throw new BadRequestException(
      `${product.name} in size ${size} is sold out`,
    );
  entry.stock -= 1;
  await tx.product.update({
    where: { id: product.id },
    data: { sizes: sizes as unknown as Prisma.InputJsonArray },
  });
}
