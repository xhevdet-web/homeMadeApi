import type { OrderStatus } from '../generated/prisma/client.js';

/** Injection tokens; tests replace the transport so nothing reaches a real mailbox. */
export const MAIL_CONFIG = Symbol('MAIL_CONFIG');
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/** The part of a Nodemailer transporter MailService uses. */
export interface MailTransport {
  sendMail(message: OutgoingMail): Promise<unknown>;
  verify(): Promise<unknown>;
}

/** Exactly what is handed to the transport; built only by MailService. */
export interface OutgoingMail {
  from: { name: string; address: string };
  to: string | { name: string; address: string };
  replyTo?: { name: string; address: string };
  subject: string;
  text: string;
  html: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** What an order email may show: never ids, notes, payment internals or image keys. */
export interface OrderEmail {
  orderNumber: string;
  status: OrderStatus;
  /** Cents; shown as euros. */
  totalPrice: number;
  productName: string;
  customer: { firstName: string };
}

export interface ContactMessage {
  name: string;
  email: string;
  subject: string;
  message: string;
  orderNumber?: string;
}
