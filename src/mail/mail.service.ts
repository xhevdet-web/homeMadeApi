import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MailConfig } from './mail.config.js';
import {
  MAIL_CONFIG,
  MAIL_TRANSPORT,
  type ContactMessage,
  type MailTransport,
  type OrderStatusEmail,
  type OutgoingMail,
  type RenderedEmail,
} from './mail.types.js';
import { orderStatusEmail } from './templates/order-status.template.js';
import { contactMessageEmail } from './templates/contact-message.template.js';

/** Header values are single lines: no CR/LF or other control characters can add headers. */
export const singleLine = (value: string) =>
  value
    // oxlint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The application's only SMTP client. Callers use the feature methods; the transport and
 * credentials never leave this service. Send failures are thrown for the caller to handle:
 * order updates log and continue, the contact form reports them.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(MAIL_CONFIG) private readonly config: MailConfig,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {
    this.logger.log('Mail service initialized');
  }

  /** "HomeMade Creator <homemadecreator.shop@gmail.com>": the sender of every email. */
  get sender() {
    return { name: this.config.from.name, address: this.config.from.address };
  }

  /** Checks the SMTP connection and login without sending anything. */
  async verifyConnection(): Promise<void> {
    await this.transport.verify();
  }

  async sendOrderStatusChangedEmail(input: OrderStatusEmail): Promise<void> {
    await this.sendMail(input.customer.email, orderStatusEmail(input));
    this.logger.log(
      `Order status email sent orderId=${input.orderId} status=${input.status}`,
    );
  }

  /** Delivered to the HomeMade Creator inbox; Reply goes straight to the customer. */
  async sendContactMessage(input: ContactMessage): Promise<void> {
    await this.sendMail(this.config.from.address, contactMessageEmail(input), {
      name: singleLine(input.name),
      address: input.email,
    });
    this.logger.log('Contact message delivered');
  }

  /** Sends one email to `to`; used by the feature methods and the SMTP test script. */
  async sendMail(
    to: string,
    email: RenderedEmail,
    replyTo?: { name: string; address: string },
  ): Promise<void> {
    const message: OutgoingMail = {
      from: this.sender,
      to,
      ...(replyTo ? { replyTo } : {}),
      subject: singleLine(email.subject),
      text: email.text,
      html: email.html,
    };
    await this.transport.sendMail(message);
  }
}
