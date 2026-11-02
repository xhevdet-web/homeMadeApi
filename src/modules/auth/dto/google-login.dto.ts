import { IsString, Length, ValidateIf } from 'class-validator';

export class GoogleLoginDto {
  // The Google ID token (a JWT). Identity comes only from its verified claims.
  @IsString()
  @Length(1, 4096)
  idToken!: string;

  // Only when connecting Google to an existing password account: proves the account is theirs.
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 128)
  password?: string;
}
