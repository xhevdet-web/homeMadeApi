import { OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';
import { CreateProductDto, emptyToNull } from './create-product.dto.js';

// Origin and gift packaging are fixed at creation, and so is a design's base product;
// customers save an edited design as a new Product. Optional create fields keep their rules;
// the required ones may be omitted but never null.
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

  /**
   * Ready-made phone cases (COMPANY): the phone model the case fits. Designs keep their
   * base product. "" (multipart) or null unlinks it.
   */
  @Transform(emptyToNull)
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsUUID()
  baseProductId?: string | null;

  /** Phone case models: true deletes the overlay drawn above the customer's image. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  removeOverlay?: boolean;
}
