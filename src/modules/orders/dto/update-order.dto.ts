import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  adminNotes?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  finalImageUrl?: string | null;
}
