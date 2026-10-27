import type { TestingModuleBuilder } from '@nestjs/testing';
import { MailService } from '../../src/mail/mail.service.js';
import {
  MAIL_CONFIG,
  MAIL_TRANSPORT,
  type OutgoingMail,
} from '../../src/mail/mail.types.js';
import type { MailConfig } from '../../src/mail/mail.config.js';

// The real .env is loaded in tests, so every suite that loads MailModule replaces its
// transport: nothing may ever reach Gmail from a test.
export const testMailConfig: MailConfig = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'shop@example.test',
  password: 'test-only-app-password',
  from: { name: 'HomeMade Creator', address: 'shop@example.test' },
};

/** A transport that records messages instead of sending them. */
export function fakeTransport() {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    sendMail: vi.fn(async (message: OutgoingMail) => {
      sent.push(message);
      return { messageId: 'test' };
    }),
    verify: vi.fn(async () => true),
  };
}

/** Replaces MailModule's config and transport in a testing module. */
export function withFakeMail(
  builder: TestingModuleBuilder,
  transport: { sendMail: unknown; verify: unknown },
) {
  return builder
    .overrideProvider(MAIL_CONFIG)
    .useValue(testMailConfig)
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(transport);
}

/** A MailService for code that builds services by hand. */
export const fakeMailService = () =>
  new MailService(testMailConfig, fakeTransport());
