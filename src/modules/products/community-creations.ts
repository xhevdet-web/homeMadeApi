import type { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { CASE_BUILDER } from '../categories/builder-config.js';

/** How many creations the community carousels show per request. */
export const COMMUNITY_LIMIT = 5;

/**
 * Orders whose design may be shown to `viewerId` as a community creation: completed,
 * placed by someone else, of a customer design in an active category, with a picture.
 * Phone cases usually carry personal photos, so they are never shown to others. The
 * viewer always comes from the session, never from the request.
 */
export function communityOrderWhere(
  viewerId: string,
  categoryId?: string,
): Prisma.OrderWhereInput {
  return {
    status: 'COMPLETED',
    completedAt: { not: null },
    userId: { not: viewerId },
    product: {
      origin: 'CUSTOMER',
      createdById: { not: viewerId },
      categoryId,
      category: {
        isActive: true,
        // `not` alone would also drop categories without a builder (NULL).
        OR: [{ builderType: null }, { builderType: { not: CASE_BUILDER } }],
      },
    },
    // The order's own copy of the preview, or the design's.
    OR: [
      { designPreviewKey: { not: null } },
      { product: { designPreviewKey: { not: null } } },
    ],
  };
}

/**
 * The latest completed order of each of the five most recently completed designs, newest
 * first. A design ordered several times appears once. The database groups, sorts and
 * limits; only the orders of those five designs are read afterwards.
 */
export async function recentCommunityOrders<S extends Prisma.OrderSelect>(
  prisma: PrismaService,
  viewerId: string,
  categoryId: string | undefined,
  select: S,
) {
  const where = communityOrderWhere(viewerId, categoryId);
  const ranked = await prisma.order.groupBy({
    by: ['productId'],
    where,
    _max: { completedAt: true },
    orderBy: [{ _max: { completedAt: 'desc' } }, { productId: 'asc' }],
    take: COMMUNITY_LIMIT,
  });
  if (!ranked.length) return [];
  const productIds = ranked.map((entry) => entry.productId);
  const orders = await prisma.order.findMany({
    where: { ...where, productId: { in: productIds } },
    select: { ...select, productId: true },
    orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
  });
  // The first (latest) order of each design, in the ranked order.
  type Row = (typeof orders)[number];
  const latest = new Map<string, Row>();
  for (const order of orders) {
    // Always selected above; the generic select hides it from the type.
    const { productId } = order as Row & { productId: string };
    if (!latest.has(productId)) latest.set(productId, order);
  }
  return productIds.flatMap((id) => {
    const order = latest.get(id);
    return order ? [order] : [];
  });
}
