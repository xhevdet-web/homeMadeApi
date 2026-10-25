import { Transform } from 'class-transformer';
import {
  DESIGN_SIDES,
  type DesignSide,
} from '../../categories/builder-config.js';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export const TEXT_FONTS = ['SERIF', 'SANS', 'SCRIPT'] as const;
export const TEXT_WEIGHTS = ['LIGHT', 'REGULAR', 'BOLD'] as const;
export const MAX_TEXT_LAYERS = 6;

/**
 * Personalised text, e.g. "Thank you" on a gift, "Kate & Mike" on a bouquet card or a
 * name printed on a hoodie. Never priced and never stocked.
 */
export class TextLayerDto {
  @IsString()
  @Length(1, 64)
  id!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 80)
  text!: string;

  /** APPAREL only: the garment side it is printed on. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(DESIGN_SIDES)
  side?: DesignSide;

  /** Text centre, normalised 0–1 within the canvas (APPAREL: within the side's print area). */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  x!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1)
  y!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.1)
  @Max(5)
  scale!: number;

  /** Degrees, clockwise. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-360)
  @Max(360)
  rotation!: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a #RRGGBB hex colour',
  })
  color?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(TEXT_FONTS)
  font?: (typeof TEXT_FONTS)[number];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(TEXT_WEIGHTS)
  weight?: (typeof TEXT_WEIGHTS)[number];

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  italic?: boolean;
}
