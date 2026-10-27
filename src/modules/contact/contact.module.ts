import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { MailModule } from '../../mail/mail.module.js';
import { ContactController } from './contact.controller.js';
import { ContactService } from './contact.service.js';

/** Contact limit per client: 5 messages per 15 minutes. */
export const CONTACT_RATE_LIMIT = { ttl: 15 * 60_000, limit: 5 };

@Module({
  // The throttler guard is applied to ContactController only, not app-wide.
  imports: [MailModule, ThrottlerModule.forRoot([CONTACT_RATE_LIMIT])],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
