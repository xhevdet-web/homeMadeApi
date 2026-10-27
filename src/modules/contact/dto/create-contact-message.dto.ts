import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
// Names, subjects and order numbers end up in single-line headers or labels.
const SINGLE_LINE = /^[^\r\n]*$/;

/** A Contact us message from the app. The text is plain: it is escaped, never rendered. */
export class CreateContactMessageDto {
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  @Matches(SINGLE_LINE, { message: 'name must be a single line' })
  name!: string;

  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 150)
  @Matches(SINGLE_LINE, { message: 'subject must be a single line' })
  subject!: string;

  @Transform(trim)
  @IsString()
  @Length(10, 5000, {
    message: 'message must be between 10 and 5000 characters',
  })
  message!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== '')
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  @Matches(/^#?[A-Za-z0-9-]+$/, {
    message: 'orderNumber must look like HM-2026-000000123',
  })
  orderNumber?: string;
}
