import type { RenderedEmail } from '../mail.types.js';
import { paragraph, renderLayout } from './layout.js';

/** The one email sent by `pnpm mail:test <address>` to check the SMTP setup. */
export function smtpTestEmail(): RenderedEmail {
  const line = 'Your HomeMade Creator email configuration is working.';
  return {
    subject: 'HomeMade Creator SMTP Test',
    text: line,
    html: renderLayout({
      preheader: line,
      heading: 'SMTP test',
      body: paragraph(line),
      footer: 'Sent by the HomeMade Creator API mail test.',
    }),
  };
}
