import { IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';

export class ProductItemDto {
  @IsUUID()
  subCategoryId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  quantity!: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  position?: number;
}
