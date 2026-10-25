import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';
import { ProductOrigin } from '../../../generated/prisma/client.js';

const defined = (_object: unknown, value: unknown) => value !== undefined;

/** GET /products filters, e.g. ?categoryId=…&origin=COMPANY&search=hoodie */
export class ProductQueryDto {
  @ValidateIf(defined)
  @IsUUID()
  categoryId?: string;

  @ValidateIf(defined)
  @IsEnum(ProductOrigin)
  origin?: ProductOrigin;

  /** Only products of one creator, e.g. a customer's designs. */
  @ValidateIf(defined)
  @IsUUID()
  createdById?: string;

  @ValidateIf(defined)
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  isActive?: boolean;

  /** Matches the product name, description or colour. */
  @ValidateIf(defined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  search?: string;
}
