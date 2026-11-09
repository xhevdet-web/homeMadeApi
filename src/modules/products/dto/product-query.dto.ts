import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ProductOrigin } from '../../../generated/prisma/client.js';

const defined = (_object: unknown, value: unknown) => value !== undefined;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export const PRODUCT_TYPES = ['ready', 'custom'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];
export const DEFAULT_PRODUCT_LIMIT = 12;
export const MAX_PRODUCT_LIMIT = 48;

/**
 * GET /products filters, e.g. ?categoryId=…&origin=COMPANY&search=hoodie.
 *
 * Without `page` the response is the plain array it has always been. With `page` it is
 * one page `{ data, meta }`, and `limit`, `sort`, `type` and `inStock` apply too.
 */
export class ProductQueryDto {
  @ValidateIf(defined)
  @IsUUID()
  categoryId?: string;

  @ValidateIf(defined)
  @IsEnum(ProductOrigin)
  origin?: ProductOrigin;

  /** Only products of one creator, e.g. a customer's designs. */
  @ValidateIf(defined)
  @IsUUID()
  createdById?: string;

  @ValidateIf(defined)
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;

  /**
   * Matches the product name, description or colour; in paginated mode also the
   * category name.
   */
  @ValidateIf(defined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  search?: string;

  /** Turns on paginated mode. */
  @ValidateIf(defined)
  @Type(() => Number)
  @IsInt({ message: 'page must be a whole number of at least 1' })
  @Min(1, { message: 'page must be a whole number of at least 1' })
  @Max(1000000)
  page?: number;

  /** Page size, 12 by default. Paginated mode only. */
  @ValidateIf(defined)
  @Type(() => Number)
  @IsInt({
    message: `limit must be a whole number from 1 to ${MAX_PRODUCT_LIMIT}`,
  })
  @Min(1, {
    message: `limit must be a whole number from 1 to ${MAX_PRODUCT_LIMIT}`,
  })
  @Max(MAX_PRODUCT_LIMIT, {
    message: `limit must be a whole number from 1 to ${MAX_PRODUCT_LIMIT}`,
  })
  limit?: number;

  /** newest (default), price_asc or price_desc. Paginated mode only. */
  @ValidateIf(defined)
  @IsIn(PRODUCT_SORTS, {
    message: `sort must be one of: ${PRODUCT_SORTS.join(', ')}`,
  })
  sort?: ProductSort;

  /** ready (ready-made) or custom (made to order). Paginated mode only. */
  @ValidateIf(defined)
  @IsIn(PRODUCT_TYPES, {
    message: `type must be one of: ${PRODUCT_TYPES.join(', ')}`,
  })
  type?: ProductType;

  /** true hides sold-out products. Paginated mode only. */
  @ValidateIf(defined)
  @Transform(toBoolean)
  @IsBoolean({ message: 'inStock must be true or false' })
  inStock?: boolean;
}
