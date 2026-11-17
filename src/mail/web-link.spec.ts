import { orderUrl, webAppUrl } from './web-link.js';
import { orderStatusEmail } from './templates/order-status.template.js';

const env =
  (values: Record<string, string>) =>
  (key: string): string | undefined =>
    values[key];

describe('order links in emails', () => {
  it('reads WEB_APP_URL without a trailing slash, and defaults to the live site or the dev server', () => {
    expect(webAppUrl(env({ WEB_APP_URL: 'https://hm-craft.com/' }))).toBe(
      'https://hm-craft.com',
    );
    expect(webAppUrl(env({ WEB_APP_URL: 'https://hm-craft.com/shop//' }))).toBe(
      'https://hm-craft.com/shop',
    );
    expect(webAppUrl(env({}))).toBe('http://localhost:5173');
    expect(webAppUrl(env({ NODE_ENV: 'production' }))).toBe(
      'https://hm-craft.com',
    );
    expect(webAppUrl(env({ WEB_APP_URL: 'javascript:alert(1)' }))).toBeNull();
    expect(webAppUrl(env({ WEB_APP_URL: 'not a url' }))).toBeNull();
  });

  it('links to the order page of the website', () => {
    expect(
      orderUrl('http://localhost:5173', '019f5ec0-9788-4273-85b1-5eb46703cac7'),
    ).toBe(
      'http://localhost:5173/#/orders/019f5ec0-9788-4273-85b1-5eb46703cac7',
    );
  });

  const input = {
    orderNumber: 'HM-2026-000000123',
    status: 'READY_FOR_COURIER' as const,
    totalPrice: 1060,
    productName: 'My Gifts',
    customer: { firstName: 'Kate' },
  };

  it('shows a "View your order" button and text link when the order has a URL', () => {
    const url = 'https://hm-craft.com/#/orders/a1000000';
    const email = orderStatusEmail({ ...input, orderUrl: url });
    expect(email.html).toContain(`href="${url}"`);
    expect(email.html).toContain('View your order');
    expect(email.text).toContain(`View your order: ${url}`);
    // The sentence under the receipt names the link too, for mail apps that hide buttons.
    expect(email.html).toContain(
      `You can follow your order on our website: <a href="${url}"`,
    );
    expect(email.text).toContain(
      `You can follow your order on our website: ${url}`,
    );
    expect(email.html).not.toContain('in the HomeMade Creator app');
  });

  it('leaves the link out when no website is configured', () => {
    const email = orderStatusEmail(input);
    expect(email.html).not.toContain('View your order');
    expect(email.html).not.toContain('href=');
    expect(email.text).not.toContain('View your order');
  });
});
