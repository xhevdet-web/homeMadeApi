import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsInt,
} from 'class-validator';

export class CategorySizeDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  measurement!: number;

  @IsString()
  @IsNotEmpty()
  unit!: string;

  @IsInt()
  @IsPositive()
  maxItems!: number;
}
