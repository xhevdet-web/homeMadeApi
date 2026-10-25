import { OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import { CreateProductDto } from './create-product.dto.js';

// Origin and base product are fixed at creation; a different base is a new design.
// Optional create fields keep their rules; the required ones may be omitted but never null.
export class UpdateProductDto extends OmitType(CreateProductDto, [
  'origin',
  'baseProductId',
  'categoryId',
  'name',
] as const) {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  categoryId?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 200)
  name?: string;
}
