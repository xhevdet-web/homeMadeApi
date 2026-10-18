import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const emptyToNull = ({ value }: { value: unknown }) =>
  value === '' ? null : value;

export class CreateGarmentDto {
  @IsUUID()
  categoryId!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name!: string;

  @Transform(trim)
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  @Length(1, 5000)
  description?: string | null;

  /** Blank garment price in cents. */
  @IsInt()
  @Min(0)
  @Max(2147483647)
  basePrice!: number;

  /** App-drawn fallback until mockups are uploaded, e.g. HOODIE or TSHIRT. */
  @Transform(emptyToNull)
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null,
  )
  @Matches(/^[A-Z][A-Z_]{0,39}$/, {
    message: 'silhouette must be an uppercase identifier such as HOODIE',
  })
  silhouette?: string | null;

  // Validated in the service by validatePrintArea.
  @IsOptional()
  frontPrintArea?: Record<string, unknown> | null;

  @IsOptional()
  backPrintArea?: Record<string, unknown> | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}
