import 'dotenv/config';
import type { JwtModuleOptions } from '@nestjs/jwt';

export function accessTokenSeconds(): number {
  const value = process.env.JWT_ACCESS_EXPIRES_IN?.trim() ?? '60m';
  const match = /^(\d+)(s|m|h|d)?$/.exec(value);
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = match ? Number(match[1]) * units[match[2] ?? 's'] : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2147483647)
    throw new Error(
      'JWT_ACCESS_EXPIRES_IN must be a positive duration such as 15m or 60m',
    );
  return seconds;
}

export function jwtConfig(): JwtModuleOptions {
  // Preserve existing deployments and already issued tokens during config migration.
  const secret = process.env.JWT_ACCESS_SECRET ?? process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new Error(
      'JWT_ACCESS_SECRET must contain at least 32 bytes (JWT_SECRET is supported as a legacy fallback)',
    );
  return {
    secret,
    signOptions: {
      algorithm: 'HS256',
      expiresIn: accessTokenSeconds(),
      issuer: 'homemade-api',
      audience: 'homemade-mobile',
    },
    verifyOptions: {
      algorithms: ['HS256'],
      issuer: 'homemade-api',
      audience: 'homemade-mobile',
    },
  };
}
