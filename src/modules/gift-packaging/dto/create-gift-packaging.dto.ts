import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  GiftPackagingShape,
  GiftPackagingType,
} from '../../../generated/prisma/client.js';
import { GiftBundleDto, MAX_BUNDLES } from './gift-bundle.dto.js';

export const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
// Multipart cannot carry null, so clients send "" to clear nullable fields.
export const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class CreateGiftPackagingDto {
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name!: string;

  @Transform(emptyToNull)
  @IsOptional()
  @IsString()
  @Length(1, 300)
  description?: string | null;

  /** TRANSPARENT shows the contents and has no colours; OPAQUE is closed and may have colours. */
  @IsEnum(GiftPackagingType)
  type!: GiftPackagingType;

  /** SQUARE (default) or RECTANGULAR: the box drawn in the Gift Studio. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(GiftPackagingShape)
  shape?: GiftPackagingShape;

  /** Price in cents, e.g. 400 = €4.00. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  price?: number;

  /** Stock of packaging without colours; coloured packaging keeps stock per colour. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  stock?: number;

  /** How many items fit inside (the Gift Studio's slots). null or "" (multipart): no limit. */
  @Transform(emptyToNull)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  capacity?: number | null;

  /** Item types (SubCategory.type) it accepts, e.g. ["Treats", "Decor"]. []: every type. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 60, { each: true })
  allowedTypes?: string[];

  /** Suggested combinations shown in the Gift Studio; null removes them. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BUNDLES)
  @ValidateNested({ each: true })
  @Type(() => GiftBundleDto)
  suggestedBundles?: GiftBundleDto[] | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}
