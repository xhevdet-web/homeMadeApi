import { argon2id, hash } from 'argon2';

// One password policy and one hashing configuration for registration and password
// changes. The mobile app mirrors these limits in src/helper/passwordPolicy.ts.
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function hashPassword(password: string | Buffer) {
  return hash(password, { type: argon2id });
}
