import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../../mail/mail.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrderNotificationService } from './order-notification.service.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    StorageModule,
    MailModule,
    NotificationsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrderNotificationService],
  exports: [OrdersService],
})
export class OrdersModule {}
