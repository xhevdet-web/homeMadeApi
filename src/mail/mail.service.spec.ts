import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OrderStatus } from '../generated/prisma/client.js';
import { mailConfig } from './mail.config.js';
import { MailModule } from './mail.module.js';
import { MailService, singleLine } from './mail.service.js';
import { MAIL_TRANSPORT, type OutgoingMail } from './mail.types.js';
import { ORDER_STATUS_COPY } from './order-status-copy.js';
import { orderStatusEmail } from './templates/order-status.template.js';

const SECRET = 'app-password-never-shown';
const env: Record<string, string> = {
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_USER: 'homemadecreator.shop@gmail.com',
  SMTP_APP_PASSWORD: SECRET,
  SMTP_FROM_NAME: 'HomeMade Creator',
  SMTP_FROM_EMAIL: 'homemadecreator.shop@gmail.com',
};
const from = (values: Record<string, string>) => (key: string) => values[key];

describe('mail config', () => {
  it('reads the SMTP settings', () => {
    expect(mailConfig(from(env))).toEqual({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      user: 'homemadecreator.shop@gmail.com',
      password: SECRET,
      from: {
        name: 'HomeMade Creator',
        address: 'homemadecreator.shop@gmail.com',
      },
    });
  });

  it('names missing settings without revealing any values', () => {
    const { SMTP_HOST: _host, SMTP_FROM_EMAIL: _email, ...partial } = env;
    expect(() => mailConfig(from(partial))).toThrow(
      'Missing email settings: SMTP_HOST, SMTP_FROM_EMAIL',
    );
    for (const broken of <Record<string, string>[]>[
      { SMTP_PORT: 'abc' },
      { SMTP_SECURE: 'maybe' },
      { SMTP_FROM_EMAIL: 'not-an-email' },
    ]) {
      let message = '';
      try {
        mailConfig(from({ ...env, ...broken }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^SMTP_/);
      expect(message).not.toContain(SECRET);
    }
  });

  it('defaults to TLS only on port 465 and keeps the sender name on one line', () => {
    const { SMTP_SECURE: _secure, ...rest } = env;
    expect(mailConfig(from({ ...rest, SMTP_PORT: '465' })).secure).toBe(true);
    expect(mailConfig(from(rest)).secure).toBe(false);
    expect(
      mailConfig(from({ ...env, SMTP_FROM_NAME: 'Home\r\nBcc: x@example.com' }))
        .from.name,
    ).toBe('Home Bcc: x@example.com');
  });
});

describe('MailModule', () => {
  it('builds a verified STARTTLS transport from the environment and sends from the shop', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const module = await Test.createTestingModule({ imports: [MailModule] })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => env[key] })
      .compile();
    const transport = module.get<{ options: Record<string, unknown> }>(
      MAIL_TRANSPORT,
    );
    expect(transport.options).toMatchObject({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'homemadecreator.shop@gmail.com', pass: SECRET },
    });
    // Certificate checks are never switched off.
    expect(transport.options.tls).toBeUndefined();
    const mail = module.get(MailService);
    expect(mail.sender).toEqual({
      name: 'HomeMade Creator',
      address: 'homemadecreator.shop@gmail.com',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    log.mockRestore();
    // Compiling a Nest module is slow on a cold start.
  }, 30_000);
});

describe('MailService', () => {
  const sent: OutgoingMail[] = [];
  const transport = {
    sendMail: vi.fn(async (message: OutgoingMail) => sent.push(message)),
    verify: vi.fn(async () => true),
  };
  const service = new MailService(mailConfig(from(env)), transport);

  it('verifies the connection without sending', async () => {
    await service.verifyConnection();
    expect(transport.verify).toHaveBeenCalled();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('never lets a subject add headers', async () => {
    await service.sendMail('dev@example.com', {
      subject: 'Hello\r\nBcc: victim@example.com',
      text: 'x',
      html: 'x',
    });
    expect(sent[0].subject).toBe('Hello Bcc: victim@example.com');
    expect(singleLine('a\nb\tc\u0000d')).toBe('a b c d');
  });
});

describe('order status email', () => {
  it.each(Object.values(OrderStatus))(
    'uses friendly wording for %s',
    (status) => {
      const email = orderStatusEmail({
        orderNumber: 'HM-2026-627079642',
        status,
        totalPrice: 4200,
        productName: 'My <Hoodie>',
        customer: { firstName: 'Kate' },
      });
      expect(email.subject).toContain('HM-2026-627079642');
      // The raw value (e.g. READY_FOR_COURIER, CREATED) never appears, in any form.
      for (const content of [email.subject, email.text, email.html])
        expect(content).not.toMatch(new RegExp(`\\b${status}\\b`));
      expect(email.text).toContain(ORDER_STATUS_COPY[status].title);
      expect(email.text).toContain(ORDER_STATUS_COPY[status].label);
      expect(email.text).toContain('€42.00');
      expect(email.html).toContain('My &lt;Hoodie&gt;');
      expect(email.html).not.toContain('<script');
    },
  );
});
