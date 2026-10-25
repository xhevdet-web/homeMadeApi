import { Length, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password.js';

// One rule per field (Length also rejects non-strings), so each problem is reported once.
/** Body of PATCH /auth/change-password. The user always comes from the JWT. */
export class ChangePasswordDto {
  @Length(1, PASSWORD_MAX_LENGTH, { message: 'Current password is required' })
  currentPassword!: string;

  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, {
    message: 'New password does not meet the password requirements',
  })
  newPassword!: string;

  /** Must equal newPassword (checked by the service, so its limits apply); never stored. */
  @MinLength(1, { message: 'Please confirm your new password' })
  confirmPassword!: string;
}
