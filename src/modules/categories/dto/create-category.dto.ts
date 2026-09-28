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
} from 'class-validator';

import { CategorySizeDto } from './category-size.dto.js';

export class CreateCategoryDto {
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
