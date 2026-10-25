import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PaymentType } from '../../../generated/prisma/client.js';

export class CreateOrderDto {
  @IsUUID()
  productId!: string;

  /** Required for a COMPANY product sold in sizes, e.g. "L". Designs carry their own size. */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 20)
  size?: string;

  @IsEnum(PaymentType)
  paymentType!: PaymentType;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  customerNotes?: string | null;
}
