import {
  IsIn,
  IsInt,
  IsNumber,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  DESIGN_SIDES,
  type DesignSide,
} from '../../categories/builder-config.js';

export class ProductItemDto {
  @IsUUID()
  subCategoryId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  quantity!: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  position?: number;

  // Free placement for canvas builders (APPAREL). Jewelry strands omit these.
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(DESIGN_SIDES)
  side?: DesignSide;

  /** Design centre, normalised 0–1 within the side's print area. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  x?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  y?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.1)
  @Max(5)
  scale?: number;

  /**
   * For the "Your own design" (CUSTOM_UPLOAD) design: index of the customer's image in
   * the multipart `customDesigns` files.
   */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(4)
  customDesignIndex?: number;

  /** Degrees, clockwise. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-360)
  @Max(360)
  rotation?: number;
}
