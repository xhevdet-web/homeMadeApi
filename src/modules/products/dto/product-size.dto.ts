import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';

/** One size of a COMPANY product and its own stock, e.g. { size: 'M', stock: 28 }. */
export class ProductSizeDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 20)
  size!: string;

  @IsInt()
  @Min(0)
  @Max(2147483647)
  stock!: number;
}

export const MAX_PRODUCT_SIZES = 30;
