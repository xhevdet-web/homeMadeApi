// Development check of the SMTP settings in .env, using the built MailService.
//   pnpm mail:test                     verify the connection and login only
//   pnpm mail:test you@example.com     also send ONE test email to that address
// Never prints credentials. Not exposed over HTTP.
import 'reflect-metadata';
import 'dotenv/config';

const to = process.argv[2];
if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('Usage: pnpm mail:test [recipient@example.com]');
  process.exit(1);
}

const { mailConfig } = await import('../dist/mail/mail.config.js');
const { createMailTransport } = await import('../dist/mail/mail.transport.js');
const { MailService } = await import('../dist/mail/mail.service.js');
const { smtpTestEmail } = await import('../dist/mail/templates/smtp-test.template.js');

try {
  const config = mailConfig((key) => process.env[key]);
  const mail = new MailService(config, createMailTransport(config));
  await mail.verifyConnection();
  console.log(`SMTP OK: logged in to ${config.host}:${config.port} as the configured user.`);
  if (to) {
    await mail.sendMail(to, smtpTestEmail());
    console.log(`Test email sent from ${config.from.name} <${config.from.address}> to ${to}.`);
  }
} catch (error) {
  // Nodemailer messages describe the failure (e.g. a rejected login) without the password.
  console.error(`SMTP check failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
