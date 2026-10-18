import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsArray,
  ArrayUnique,
  ValidateNested,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  IsIn,
  IsUUID,
} from 'class-validator';

import { CategorySizeDto } from './category-size.dto.js';

// Multipart cannot carry null, so clients send "" to clear nullable fields.
export const emptyToNull = ({ value }: { value: unknown }) =>
  value === '' ? null : value;

export class CreateCategoryDto {
  // Shared design library: use another category's designs (validated in the service).
  @Transform(emptyToNull)
  @IsOptional()
  @IsUUID()
  designCategoryId?: string | null;

  @IsOptional()
  options?: unknown[] | null;

  // Validated in the service by validateBuilderConfig.
  @IsOptional()
  builderConfig?: Record<string, unknown> | null;

  @Transform(emptyToNull)
  @IsOptional()
  @IsIn(['JEWELRY', 'BOUQUET', 'GIFT', 'APPAREL'])
  builderType?: 'JEWELRY' | 'BOUQUET' | 'GIFT' | 'APPAREL' | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique((size: CategorySizeDto) => size?.id)
  @ValidateNested({ each: true })
  @Type(() => CategorySizeDto)
  sizes?: CategorySizeDto[] | null;

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

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}
