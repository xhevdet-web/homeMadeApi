import { OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import { CreateProductDto } from './create-product.dto.js';

// Origin, base product and gift packaging are fixed at creation; customers save an edited
// design as a new Product. Optional create fields keep their rules; the required ones may be
// omitted but never null.
export class UpdateProductDto extends OmitType(CreateProductDto, [
  'origin',
  'baseProductId',
  'giftPackagingId',
  'giftPackagingColorId',
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
