import { OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { trim } from './create-gift-packaging.dto.js';

const HEX = /^#[0-9A-Fa-f]{6}$/;

export class CreateGiftPackagingColorDto {
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  name!: string;

  /** Swatch shown in the app, e.g. "#E8B4BC". */
  @Transform(trim)
  @Matches(HEX, { message: 'hex must look like #E8B4BC' })
  hex!: string;

  /** Added to the packaging price, in cents. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  priceAdjustment?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  stock?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class UpdateGiftPackagingColorDto extends OmitType(
  CreateGiftPackagingColorDto,
  ['name', 'hex'] as const,
) {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 60)
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trim)
  @Matches(HEX, { message: 'hex must look like #E8B4BC' })
  hex?: string;
}
