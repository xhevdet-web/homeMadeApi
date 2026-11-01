import type { CookieOptions } from 'express';

/**
 * Website sessions. The browser keeps the access token in an httpOnly cookie instead of
 * script-readable storage, so a page reload stays signed in. The mobile app is unchanged:
 * it never sends the client header below and keeps using the Bearer token.
 */
export const SESSION_COOKIE = 'hc_session';

/** Sent by the website on every request. Asks login for a cookie session and, on
 * cookie-authenticated writes, proves the request passed CORS (a custom header always
 * needs a preflight, which only allowed origins pass). */
export const WEB_CLIENT_HEADER = 'x-homemade-client';
export const WEB_CLIENT = 'web';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type SameSite = 'lax' | 'strict' | 'none';

function sameSite(): SameSite {
  const value = process.env.AUTH_COOKIE_SAMESITE?.trim().toLowerCase() ?? 'lax';
  if (value !== 'lax' && value !== 'strict' && value !== 'none')
    throw new Error('AUTH_COOKIE_SAMESITE must be lax, strict or none');
  return value;
}

/** Options shared by setting and clearing, so the browser matches the same cookie. */
function baseOptions(): CookieOptions {
  const site = sameSite();
  const flag = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  // SameSite=None is only accepted on Secure cookies.
  const secure =
    site === 'none' ||
    (flag ? flag === 'true' : process.env.NODE_ENV === 'production');
  const domain = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;
  return { httpOnly: true, secure, sameSite: site, path: '/api/v1', domain };
}

export function sessionCookieOptions(expiresInSeconds: number): CookieOptions {
  return { ...baseOptions(), maxAge: expiresInSeconds * 1000 };
}

export function clearedSessionCookieOptions(): CookieOptions {
  return baseOptions();
}

export function isWebClient(headers: Record<string, unknown>) {
  return headers[WEB_CLIENT_HEADER] === WEB_CLIENT;
}

/** The session token from a raw Cookie header, without a cookie-parser dependency. */
export function readSessionCookie(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const isSafeMethod = (method: string) =>
  SAFE_METHODS.has(method.toUpperCase());
