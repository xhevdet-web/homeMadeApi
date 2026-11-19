import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const MAX_BUNDLES = 12;

export class GiftBundleItemDto {
  /** A component (SubCategory) of a GIFT category. */
  @IsUUID()
  subCategoryId!: string;

  @IsInt()
  @Min(1)
  @Max(100)
  quantity!: number;
}

/** A suggested combination, e.g. "Cozy night in": tea, candle and cookies in one tap. */
export class GiftBundleDto {
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => GiftBundleItemDto)
  items!: GiftBundleItemDto[];
}
