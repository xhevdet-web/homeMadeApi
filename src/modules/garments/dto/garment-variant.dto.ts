import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** One sellable size × colour; (size, colorValue) identifies it within a garment. */
export class GarmentVariantDto {
  @Transform(trim)
  @IsString()
  @Length(1, 20)
  size!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 60)
  colorName!: string;

  /** Swatch value shown in the app, e.g. "#1F2937". */
  @Transform(trim)
  @IsString()
  @Length(1, 30)
  colorValue!: string;

  @Transform(trim)
  @ValidateIf(
    (_object, value: unknown) =>
      value !== undefined && value !== null && value !== '',
  )
  @IsString()
  @Length(1, 64)
  sku?: string | null;

  @IsInt()
  @Min(0)
  @Max(2147483647)
  stock!: number;

  /** Optional price override in cents; null uses the garment's basePrice. */
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsInt()
  @Min(0)
  @Max(2147483647)
  price?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

/** The complete size × colour matrix of a garment. */
export class ReplaceGarmentVariantsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GarmentVariantDto)
  variants!: GarmentVariantDto[];
}
