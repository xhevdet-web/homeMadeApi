import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaymentType } from '../../../generated/prisma/client.js';

export class CreateOrderDto {
  @IsUUID()
  productId!: string;

  @IsEnum(PaymentType)
  paymentType!: PaymentType;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  customerNotes?: string | null;
}
