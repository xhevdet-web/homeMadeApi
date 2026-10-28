import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  Min,
  Max,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ProductOrigin } from '../../../generated/prisma/client.js';
import { ProductItemDto } from './product-item.dto.js';
import { MAX_PRODUCT_SIZES, ProductSizeDto } from './product-size.dto.js';
import { MAX_TEXT_LAYERS, TextLayerDto } from './text-layer.dto.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
// Multipart cannot carry null, so clients send "" to clear nullable fields.
export const emptyToNull = ({ value }: { value: unknown }) =>
  value === '' ? null : value;

export class CreateProductDto {
  /** COMPANY is the admin catalog; CUSTOMER (default) is a Creative Studio design. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(ProductOrigin)
  origin?: ProductOrigin;

  @IsUUID()
  categoryId!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;

  // ---- COMPANY ----

  /** Admin-set price in cents. CUSTOMER prices are calculated. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  price?: number;

  /** Stock of an unsized product. Sized products keep stock per size instead. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  stock?: number;

  /** Sizes with their own stock, e.g. [{ size: 'S', stock: 20 }]; null removes sizes. */
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCT_SIZES)
  @ValidateNested({ each: true })
  @Type(() => ProductSizeDto)
  sizes?: ProductSizeDto[] | null;

  /** Apparel colour name; one Product is one colour. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  @Length(1, 60)
  color?: string | null;

  /** Swatch shown in the app, e.g. "#1F2937". */
  @Transform(emptyToNull)
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'colorHex must look like #1F2937' })
  colorHex?: string | null;

  /** { front?, back?, camera? } print areas; validated in the service by validatePrintAreas. */
  @IsOptional()
  printAreas?: Record<string, unknown> | null;

  /** Phone case models: the device maker, e.g. APPLE or SAMSUNG; "" clears it. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() || null : value,
  )
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @Matches(/^[A-Z][A-Z0-9_]{0,39}$/, {
    message: 'deviceBrand must be an uppercase name such as APPLE',
  })
  deviceBrand?: string | null;

  /** Catalog order within the category, lower first. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(1000000)
  sortOrder?: number;

  /**
   * Upload only: false stores the product images untouched, e.g. phone case templates
   * whose overlay must stay aligned with them pixel for pixel.
   */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  removeBackground?: boolean;

  // ---- CUSTOMER ----

  /** The COMPANY product a design is made on; required by APPAREL studios. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  baseProductId?: string;

  /** GIFT designs: the packaging the gift arrives in; priced from the database. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  giftPackagingId?: string;

  /** A colour of the chosen closed packaging; never sent for transparent packaging. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  giftPackagingColorId?: string;

  /** A size of the base product, or of the category's studio size presets. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 200)
  selectedSizeId?: string;

  /**
   * Bracelet sizes are length ranges: the exact length chosen within the selected size, in
   * whole millimetres (20 cm = 200).
   */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(1000)
  selectedMeasurementMm?: number;

  /** Personalised text for GIFT designs; null clears it on update. */
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsArray()
  @ArrayMaxSize(MAX_TEXT_LAYERS)
  @ValidateNested({ each: true })
  @Type(() => TextLayerDto)
  textLayers?: TextLayerDto[] | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ProductItemDto)
  items?: ProductItemDto[];
}
