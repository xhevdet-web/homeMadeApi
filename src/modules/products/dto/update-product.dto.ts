import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ProductItemDto } from './product-item.dto.js';

export class UpdateProductDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  categoryId?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ProductItemDto)
  items?: ProductItemDto[];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
