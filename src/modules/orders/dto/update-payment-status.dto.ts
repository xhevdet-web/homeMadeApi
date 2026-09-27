import { IsEnum } from 'class-validator';
import { PaymentStatus } from '../../../generated/prisma/client.js';

export class UpdatePaymentStatusDto {
  @IsEnum(PaymentStatus)
  paymentStatus!: PaymentStatus;
}
