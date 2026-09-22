import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class LoginDto {
  // Preserve the original email-only API for existing clients.
  @ValidateIf(
    (dto: LoginDto) => dto.email !== undefined || dto.identifier === undefined,
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(1, 254)
  identifier?: string;

  @IsString()
  @Length(1, 128)
  password!: string;
}
