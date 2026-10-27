import { OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsString, Length, ValidateIf } from 'class-validator';
import { GiftPackagingType } from '../../../generated/prisma/client.js';
import { CreateGiftPackagingDto, trim } from './create-gift-packaging.dto.js';

// The required create fields may be omitted on update, but never set to null.
export class UpdateGiftPackagingDto extends OmitType(CreateGiftPackagingDto, [
  'name',
  'type',
] as const) {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(GiftPackagingType)
  type?: GiftPackagingType;
}
