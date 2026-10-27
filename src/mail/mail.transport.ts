import { createTransport } from 'nodemailer';
import type { MailConfig } from './mail.config.js';
import type { MailTransport } from './mail.types.js';

/**
 * The SMTP transport. Port 587 with secure=false must upgrade with STARTTLS (requireTLS);
 * certificates are always verified. No connection is opened until the first send/verify.
 */
export function createMailTransport(config: MailConfig): MailTransport {
  return createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.password },
  });
}
