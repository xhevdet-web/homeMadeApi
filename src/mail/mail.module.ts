import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { mailConfig } from './mail.config.js';
import { MAIL_CONFIG, MAIL_TRANSPORT } from './mail.types.js';
import { createMailTransport } from './mail.transport.js';
import { MailService } from './mail.service.js';

/**
 * Reusable email infrastructure: import MailModule and inject MailService. SMTP settings
 * are validated at startup; no email is sent and no connection is opened until needed.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MAIL_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        mailConfig((key) => config.get<string>(key)),
    },
    {
      provide: MAIL_TRANSPORT,
      inject: [MAIL_CONFIG],
      useFactory: createMailTransport,
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
