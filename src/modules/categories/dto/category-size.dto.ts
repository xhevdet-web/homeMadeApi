import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsInt,
  Max,
  ValidateIf,
} from 'class-validator';
import { MAX_MEASUREMENT_MM } from '../jewelry-measurement.js';

const present = (_object: unknown, value: unknown) => value !== undefined;

/**
 * One studio size. Jewelry (bracelets and necklaces) uses a length range in millimetres;
 * the legacy measurement / unit / maxItems remains readable for sizes saved before. The
 * service checks that the category's sizes use the shape its studio needs (see
 * normalizeCategorySizes).
 */
export class CategorySizeDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  // ---- Jewelry: length range, whole millimetres ----

  @ValidateIf(present)
  @IsInt()
  @IsPositive()
  @Max(MAX_MEASUREMENT_MM)
  minMeasurementMm?: number;

  @ValidateIf(present)
  @IsInt()
  @IsPositive()
  @Max(MAX_MEASUREMENT_MM)
  maxMeasurementMm?: number;

  @ValidateIf(present)
  @IsInt()
  @IsPositive()
  @Max(MAX_MEASUREMENT_MM)
  defaultMeasurementMm?: number;

  // ---- Legacy: one measurement and a component count ----

  @ValidateIf(present)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  measurement?: number;

  @ValidateIf(present)
  @IsString()
  @IsNotEmpty()
  unit?: string;

  @ValidateIf(present)
  @IsInt()
  @IsPositive()
  maxItems?: number;
}
