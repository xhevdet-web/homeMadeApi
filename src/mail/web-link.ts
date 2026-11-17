/** The website customers open from emails: the live site, or the Vite dev server locally. */
const PROD_WEB_APP_URL = 'https://hm-craft.com';
const DEV_WEB_APP_URL = 'http://localhost:5173';

/**
 * The website's base URL, without a trailing slash. WEB_APP_URL overrides it (e.g. a staging
 * site); otherwise it is https://hm-craft.com in production and the local dev server elsewhere.
 * An invalid WEB_APP_URL gives null: emails then go out without links rather than a wrong one.
 */
export function webAppUrl(
  get: (key: string) => string | undefined,
): string | null {
  const raw = get('WEB_APP_URL')?.trim();
  if (!raw)
    return get('NODE_ENV') === 'production'
      ? PROD_WEB_APP_URL
      : DEV_WEB_APP_URL;
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
