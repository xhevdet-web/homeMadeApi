import { Prisma } from '../../generated/prisma/client.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { CASE_BUILDER } from '../categories/builder-config.js';
import {
  DEFAULT_PRODUCT_LIMIT,
  type ProductQueryDto,
  type ProductSort,
} from './dto/product-query.dto.js';

/**
 * SQL for the paginated GET /products (?page=…). Every condition is built with
 * Prisma.sql, so user input only ever reaches the database as a bound parameter.
 * Columns are read from `products p JOIN categories c`.
 */

type Viewer = Pick<AuthenticatedUser, 'id' | 'role'> | undefined;

// Categories whose COMPANY products are always blanks to design on.
const MADE_TO_ORDER_BUILDERS = ['APPAREL', CASE_BUILDER];

/**
 * Made to order: the product has a print area to design on (`printAreas.front` is set),
 * or its category is an apparel or phone case studio. Every other product is ready-made.
 * Always true or false, never NULL, so `NOT` selects exactly the ready-made products.
 */
export const IS_CUSTOM = Prisma.sql`(
  COALESCE(jsonb_typeof(p."print_areas" -> 'front'), 'null') <> 'null'
  OR COALESCE(c."builder_type", '') IN (${Prisma.join(MADE_TO_ORDER_BUILDERS)})
)`;

/**
 * Sold out. Sized products (a non-empty `sizes` array) are sold out when no size has a
 * stock above 0; unsized products, including `sizes: []`, when their own `stock` is.
 * The CASEs keep Postgres from casting a non-numeric stock or expanding a non-array.
 */
export const IS_SOLD_OUT = Prisma.sql`(
  CASE
    WHEN jsonb_typeof(p."sizes") = 'array' AND jsonb_array_length(p."sizes") > 0
    THEN NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p."sizes") AS size(entry)
      WHERE CASE
        WHEN jsonb_typeof(size.entry -> 'stock') = 'number'
        THEN (size.entry ->> 'stock')::numeric > 0
        ELSE false
      END
    )
    ELSE p."stock" <= 0
  END
)`;

/**
 * The same rule as `visibleTo` in the service: a customer's phone case design is seen
 * only by its creator and admins.
 */
function visibility(viewer: Viewer) {
  if (viewer?.role === 'ADMIN') return null;
  const privateCase = Prisma.sql`p."origin" = 'CUSTOMER'::"ProductOrigin" AND COALESCE(c."builder_type", '') = ${CASE_BUILDER}`;
  return viewer
    ? Prisma.sql`NOT (${privateCase} AND p."created_by_id" <> ${viewer.id})`
    : Prisma.sql`NOT (${privateCase})`;
}

/** `%`, `_` and `\` match themselves, like the website's plain text search. */
const likePattern = (search: string) =>
  `%${search.replace(/[\\%_]/g, (character) => '\\' + character)}%`;

/** Every filter except `type`, which the type counts leave out. */
function conditions(query: ProductQueryDto, viewer: Viewer) {
  const where: Prisma.Sql[] = [
    // Products of a hidden category are hidden too.
    Prisma.sql`c."is_active" = true`,
  ];
  if (query.categoryId)
    where.push(Prisma.sql`p."category_id" = ${query.categoryId}`);
  if (query.origin)
    where.push(
      Prisma.sql`p."origin" = CAST(${query.origin} AS "ProductOrigin")`,
    );
  if (query.createdById)
    where.push(Prisma.sql`p."created_by_id" = ${query.createdById}`);
  if (query.isActive !== undefined)
    where.push(Prisma.sql`p."is_active" = ${query.isActive}`);
  if (query.inStock === true) where.push(Prisma.sql`NOT ${IS_SOLD_OUT}`);
  if (query.search) {
    const pattern = likePattern(query.search);
    where.push(Prisma.sql`(
      p."name" ILIKE ${pattern}
      OR p."description" ILIKE ${pattern}
      OR p."color" ILIKE ${pattern}
      OR c."name" ILIKE ${pattern}
    )`);
  }
  const visible = visibility(viewer);
  if (visible) where.push(visible);
  return Prisma.join(where, ' AND ');
}

// Always ends in the unique id, so a page never repeats or skips a product.
const ORDER_BY: Record<ProductSort, Prisma.Sql> = {
  newest: Prisma.sql`p."created_at" DESC, p."sort_order" ASC, p."id" ASC`,
  price_asc: Prisma.sql`p."price" ASC, p."created_at" DESC, p."id" ASC`,
  price_desc: Prisma.sql`p."price" DESC, p."created_at" DESC, p."id" ASC`,
};

const FROM = Prisma.sql`products p JOIN categories c ON c."id" = p."category_id"`;

export interface ListingPage {
  page: number;
  limit: number;
  /** How many ready-made and made-to-order products match every filter but `type`. */
  counts: Prisma.Sql;
  /** The ids of the requested page, in order. */
  ids: Prisma.Sql;
}

/** The two queries behind one page: the type counts and the page's ids. */
export function listingQueries(
  query: ProductQueryDto,
  viewer: Viewer,
): ListingPage {
  const page = query.page ?? 1;
  const limit = query.limit ?? DEFAULT_PRODUCT_LIMIT;
  const where = conditions(query, viewer);
  const type =
    query.type === 'custom'
      ? Prisma.sql`AND ${IS_CUSTOM}`
      : query.type === 'ready'
        ? Prisma.sql`AND NOT ${IS_CUSTOM}`
        : Prisma.empty;
  return {
    page,
    limit,
    counts: Prisma.sql`
      SELECT
        COUNT(*) FILTER (WHERE NOT ${IS_CUSTOM})::int AS "ready",
        COUNT(*) FILTER (WHERE ${IS_CUSTOM})::int AS "custom"
      FROM ${FROM}
      WHERE ${where}`,
    ids: Prisma.sql`
      SELECT p."id" FROM ${FROM}
      WHERE ${where} ${type}
      ORDER BY ${ORDER_BY[query.sort ?? 'newest']}
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
  };
}
