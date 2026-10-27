import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  IsUUID,
} from 'class-validator';
import { MAX_MEASUREMENT_MM } from '../../categories/jewelry-measurement.js';

export class UpdateSubCategoryDto {
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

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  color?: string | null;

  @IsOptional()
  @IsString()
  type?: string | null;

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

  /**
   * Jewelry components: the length one piece occupies on the cord, in whole millimetres (an
   * 8 mm round bead is 8). Required for new jewelry components; "" or null clears it.
   */
  @Transform(({ value }: { value: unknown }) => (value === '' ? null : value))
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsInt()
  @Min(1)
  @Max(MAX_MEASUREMENT_MM)
  effectiveLengthMm?: number | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;

  /** false for unlimited printed designs; physical items (beads, patches) keep stock. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  trackStock?: boolean;

  /** Upload option. false keeps fine logos and lettering exactly as uploaded. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  removeBackground?: boolean;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}
