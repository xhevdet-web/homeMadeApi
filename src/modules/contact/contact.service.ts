import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MailService } from '../../mail/mail.service.js';
import type { CreateContactMessageDto } from './dto/create-contact-message.dto.js';

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(@Inject(MailService) private readonly mail: MailService) {}

  /**
   * Sending is the whole job here, so a failure is reported (the customer can retry);
   * the SMTP error itself stays in the server log.
   */
  async send(dto: CreateContactMessageDto) {
    try {
      await this.mail.sendContactMessage({
        name: dto.name,
        email: dto.email,
        subject: dto.subject,
        message: dto.message,
        ...(dto.orderNumber
          ? { orderNumber: dto.orderNumber.replace(/^#/, '') }
          : {}),
      });
    } catch (error) {
      this.logger.error(
        `Contact message could not be delivered: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new ServiceUnavailableException(
        'Unable to send your message right now. Please try again later.',
      );
    }
    return { success: true, message: 'Your message has been sent.' };
  }
}
