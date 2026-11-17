/** The website customers open from emails; local development uses the Vite dev server. */
const DEV_WEB_APP_URL = 'http://localhost:5173';

/**
 * The website's base URL from WEB_APP_URL (e.g. https://hm-craft.com), without a trailing
 * slash. Outside production it defaults to the local dev server. In production a missing or
 * invalid value gives null: emails then go out without links rather than with a wrong one.
 */
export function webAppUrl(
  get: (key: string) => string | undefined,
): string | null {
  const raw = get('WEB_APP_URL')?.trim();
  if (!raw) return get('NODE_ENV') === 'production' ? null : DEV_WEB_APP_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * The customer's order page on the website. It is private: signed-out visitors get the login
 * pop-up there and land on the order once signed in; other accounts see "not found".
 */
export const orderUrl = (base: string, orderId: string) =>
  `${base}/#/orders/${encodeURIComponent(orderId)}`;
