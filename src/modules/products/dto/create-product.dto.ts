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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ProductType } from '../../../generated/prisma/client.js';
import { ProductItemDto } from './product-item.dto.js';

export class CreateProductDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 200)
  selectedSizeId?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(ProductType)
  productType?: ProductType;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  price?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  stock?: number;

  @IsUUID()
  categoryId!: string;

  @ValidateIf(
    (object: CreateProductDto, value: unknown) =>
      object.productType !== 'READY_MADE' || value !== undefined,
  )
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ProductItemDto)
  items?: ProductItemDto[];

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
