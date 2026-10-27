import type { MailService } from '../../mail/mail.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import {
  OrderNotificationService,
  type NotifiableOrder,
} from './order-notification.service.js';

const order: NotifiableOrder = {
  id: 'a1000000-0000-4000-8000-000000000001',
  userId: 'b1000000-0000-4000-8000-000000000002',
  orderNumber: 'HM-2026-000000123',
  status: 'CREATED',
  totalPrice: 1060,
  user: { email: 'kate@example.com', firstName: 'Kate' },
  product: { name: 'My Gifts' },
};

function setup() {
  const mail = { sendMail: vi.fn().mockResolvedValue(undefined) };
  // false: the customer turned in-app notifications off.
  const notifications = { createOrderStatus: vi.fn().mockResolvedValue(false) };
  const service = new OrderNotificationService(
    mail as unknown as MailService,
    notifications as unknown as NotificationsService,
  );
  return { mail, notifications, service };
}

describe('OrderNotificationService', () => {
  it('emails and records an in-app update for one real status change', async () => {
    const { mail, notifications, service } = setup();
    await service.notifyOrderStatusChanged(order, 'CREATING');
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(mail.sendMail.mock.calls[0][0]).toBe('kate@example.com');
    expect(notifications.createOrderStatus).toHaveBeenCalledWith(order);
  });

  it('announces nothing when the status did not change', async () => {
    const { mail, notifications, service } = setup();
    await service.notifyOrderStatusChanged(order, 'CREATED');
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(notifications.createOrderStatus).not.toHaveBeenCalled();
  });

  it('always emails: the in-app preference never stops order emails', async () => {
    const { mail, service } = setup();
    await service.notifyOrderCreated({ ...order, status: 'ORDERED' });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('keeps each channel independent of the other’s failure', async () => {
    const { mail, notifications, service } = setup();
    notifications.createOrderStatus.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(
      service.notifyOrderStatusChanged(order, 'CREATING'),
    ).resolves.toBeUndefined();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);

    mail.sendMail.mockRejectedValue(
      new Error('Invalid login: 535 not accepted'),
    );
    notifications.createOrderStatus.mockResolvedValue(true);
    await expect(
      service.notifyOrderStatusChanged(order, 'CREATING'),
    ).resolves.toBeUndefined();
    expect(notifications.createOrderStatus).toHaveBeenCalledTimes(2);
  });
});
