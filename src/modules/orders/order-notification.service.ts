import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OrderStatus } from '../../generated/prisma/client.js';
import { MailService } from '../../mail/mail.service.js';
import type { OrderEmail, RenderedEmail } from '../../mail/mail.types.js';
import {
  orderCreatedEmail,
  orderStatusEmail,
} from '../../mail/templates/order-status.template.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { orderUrl, webAppUrl } from '../../mail/web-link.js';

/** The saved order as notifications read it; the recipient is always its own customer. */
export interface NotifiableOrder {
  id: string;
  userId: string;
  orderNumber: string;
  status: OrderStatus;
  totalPrice: number;
  user: { email: string; firstName: string } | null;
  product: { name: string } | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Tells customers about their orders. Called only after the database change succeeded;
 * one event feeds every channel: the email (always, it is transactional) and the in-app
 * notification centre (when the customer has it on). Push can join here later. Each
 * channel is a side effect: a failure is logged, the order stands and the other channels
 * still go out.
 */
@Injectable()
export class OrderNotificationService {
  private readonly logger = new Logger(OrderNotificationService.name);
  /** The website emails link to (WEB_APP_URL); null leaves the "View your order" link out. */
  private readonly webUrl: string | null;

  constructor(
    @Inject(MailService) private readonly mail: MailService,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
    @Optional() @Inject(ConfigService) config?: ConfigService,
  ) {
    this.webUrl = webAppUrl(
      (key) => config?.get<string>(key) ?? process.env[key],
    );
    if (!this.webUrl)
      this.logger.warn(
        'WEB_APP_URL is missing or invalid: order emails go out without a link to the order',
      );
  }

  /** One confirmation per placed order: one email and one "Order received" notification. */
  async notifyOrderCreated(order: NotifiableOrder): Promise<void> {
    await this.email(order, 'created', orderCreatedEmail);
    await this.inApp(order);
  }

  /** Only a real change of status is announced; repeating the same status sends nothing. */
  async notifyOrderStatusChanged(
    order: NotifiableOrder,
    previousStatus: OrderStatus,
  ): Promise<void> {
    if (order.status === previousStatus) return;
    await this.email(order, 'status', orderStatusEmail);
    await this.inApp(order);
  }

  /** The notification-centre entry, for the order's own customer only. */
  private async inApp(order: NotifiableOrder) {
    try {
      await this.notifications.createOrderStatus(order);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
      this.logger.warn(
        `Failed to save order notification orderId=${order.id} status=${order.status}: ${reason}`,
      );
    }
  }

  private async email(
    order: NotifiableOrder,
    kind: 'created' | 'status',
    render: (input: OrderEmail) => RenderedEmail,
  ) {
    const to = order.user?.email?.trim();
    if (!to || !EMAIL.test(to)) {
      this.logger.warn(
        `Order ${kind} email skipped: the customer has no valid email orderId=${order.id}`,
      );
      return;
    }
    // Rendering is not wrapped: a template bug should surface, not hide as a send failure.
    const email = render({
      orderNumber: order.orderNumber,
      status: order.status,
      totalPrice: order.totalPrice,
      productName: order.product?.name ?? 'Your HomeMade Creator order',
      customer: { firstName: order.user?.firstName ?? '' },
      ...(this.webUrl ? { orderUrl: orderUrl(this.webUrl, order.id) } : {}),
    });
    try {
      await this.mail.sendMail(to, email);
      this.logger.log(
        `Order ${kind} email sent orderId=${order.id} status=${order.status}`,
      );
    } catch (error) {
      // SMTP errors carry server replies, never credentials; only their first line is kept.
      const reason =
        error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
      this.logger.warn(
        `Failed to send order ${kind} email orderId=${order.id} status=${order.status}: ${reason}`,
      );
    }
  }
}
