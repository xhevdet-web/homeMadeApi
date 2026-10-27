/** SMTP settings, validated once when the application starts. */
export interface MailConfig {
  host: string;
  port: number;
  /** true: TLS from the start (port 465). false: STARTTLS upgrade (port 587). */
  secure: boolean;
  user: string;
  password: string;
  /** Every email is sent from this mailbox; contact messages are delivered to it too. */
  from: { name: string; address: string };
}

const REQUIRED = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_APP_PASSWORD',
  'SMTP_FROM_EMAIL',
] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reads SMTP_* settings. Errors name the variable, never its value, so secrets cannot
 * reach logs.
 */
export function mailConfig(
  get: (key: string) => string | undefined,
): MailConfig {
  const value = (key: string) => get(key)?.trim() ?? '';
  const missing = REQUIRED.filter((key) => !value(key));
  if (missing.length)
    throw new Error(`Missing email settings: ${missing.join(', ')}`);
  const port = Number(value('SMTP_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('SMTP_PORT must be a port number such as 587');
  const secure = value('SMTP_SECURE').toLowerCase();
  if (secure && secure !== 'true' && secure !== 'false')
    throw new Error('SMTP_SECURE must be true or false');
  const address = value('SMTP_FROM_EMAIL');
  if (!EMAIL.test(address))
    throw new Error('SMTP_FROM_EMAIL must be an email address');
  // A display name is a header value: no line breaks.
  const name =
    value('SMTP_FROM_NAME').replace(/[\r\n]+/g, ' ') || 'HomeMade Creator';
  return {
    host: value('SMTP_HOST'),
    port,
    secure: secure ? secure === 'true' : port === 465,
    user: value('SMTP_USER'),
    password: value('SMTP_APP_PASSWORD'),
    from: { name, address },
  };
}
