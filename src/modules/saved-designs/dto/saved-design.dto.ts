import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Studio → "Save design": keep a design the customer just saved as a product. */
export class CreateSavedDesignDto {
  @IsUUID()
  productId!: string;

  /** Defaults to the product's name. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name?: string;
}

/** Rename, and/or point at a newer version of the design (saved changes). */
export class UpdateSavedDesignDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name?: string;
}

/** An independent copy; the name defaults to "<name> (copy)". */
export class DuplicateSavedDesignDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  name?: string;
}
