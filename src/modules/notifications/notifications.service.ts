import {
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type OrderStatus } from '../../generated/prisma/client.js';
import { ORDER_STATUS_COPY } from '../../mail/order-status-copy.js';

/** The newest notifications a customer sees; older ones stay stored. */
const PAGE_SIZE = 50;

/** A read notification is deleted this long after it was read (48 hours). */
export const READ_RETENTION_MS = 48 * 60 * 60 * 1000;
/** How often expired read notifications are swept for every customer. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;

/** Read notifications whose 48 hours have passed. */
const expiredRead = (now = Date.now()) => ({
  isRead: true,
  readAt: { lt: new Date(now - READ_RETENTION_MS) },
});

const notificationSelect = {
  id: true,
  orderId: true,
  type: true,
  title: true,
  message: true,
  isRead: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

/**
 * A customer's in-app notification centre. Every read and change is scoped to the user id
 * the caller passes from the authenticated session, so one customer can never see or
 * change another's notifications. Notifications are written here by backend events only.
 * Read notifications are deleted 48 hours after they were read: hourly for everyone, and
 * for a customer whenever they open their list, so an expired one is never shown.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private sweep?: ReturnType<typeof setInterval>;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.sweep = setInterval(
      () => void this.deleteExpiredRead(),
      SWEEP_EVERY_MS,
    );
    // Never keeps the process (or a test run) alive on its own.
    this.sweep.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweep);
  }

  /** Deletes every read notification older than 48 hours since reading; never throws. */
  async deleteExpiredRead() {
    try {
      const { count } = await this.prisma.notification.deleteMany({
        where: expiredRead(),
      });
      return count;
    } catch {
      this.logger.error('Could not delete expired read notifications');
      return 0;
    }
  }

  async findMine(userId: string) {
    await this.query(() =>
      this.prisma.notification.deleteMany({
        where: { userId, ...expiredRead() },
      }),
    );
    return this.query(() =>
      this.prisma.notification.findMany({
        where: { userId },
        select: notificationSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE,
      }),
    );
  }

  async unreadCount(userId: string) {
    const count = await this.query(() =>
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    );
    return { count };
  }

  /** Marks one of the user's own notifications read; someone else's is "not found". */
  async markRead(userId: string, id: string) {
    const notification = await this.query(() =>
      this.prisma.notification.findFirst({
        where: { id, userId },
        select: { id: true, isRead: true },
      }),
    );
    if (!notification) throw new NotFoundException('Notification not found');
    if (!notification.isRead)
      await this.query(() =>
        this.prisma.notification.updateMany({
          where: { id, userId, isRead: false },
          data: { isRead: true, readAt: new Date() },
        }),
      );
    return this.query(() =>
      this.prisma.notification.findFirstOrThrow({
        where: { id, userId },
        select: notificationSelect,
      }),
    );
  }

  async markAllRead(userId: string) {
    const { count } = await this.query(() =>
      this.prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true, readAt: new Date() },
      }),
    );
    return { updated: count };
  }

  /**
   * Records an order update for the order's owner, unless they turned in-app notifications
   * off (their earlier notifications stay). Returns whether one was created.
   */
  async createOrderStatus(order: {
    id: string;
    userId: string;
    orderNumber: string;
    status: OrderStatus;
  }) {
    const owner = await this.prisma.user.findUnique({
      where: { id: order.userId },
      select: { notificationsEnabled: true },
    });
    if (!owner?.notificationsEnabled) return false;
    const copy = ORDER_STATUS_COPY[order.status].inApp;
    await this.prisma.notification.create({
      data: {
        userId: order.userId,
        orderId: order.id,
        type: 'ORDER_STATUS',
        title: copy.title,
        message: copy.message(order.orderNumber),
      },
      select: { id: true },
    });
    return true;
  }

  private async query<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      )
        throw new NotFoundException('Notification not found');
      throw new InternalServerErrorException(
        'Unable to complete notification operation',
      );
    }
  }
}
