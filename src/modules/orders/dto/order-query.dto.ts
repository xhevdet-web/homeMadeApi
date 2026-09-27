import { Type, Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  OrderStatus,
  PaymentStatus,
  PaymentType,
} from '../../../generated/prisma/client.js';

export class OrderQueryDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(PaymentType)
  paymentType?: PaymentType;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  userId?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  orderNumber?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;
}
