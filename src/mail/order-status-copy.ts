import type { OrderStatus } from '../generated/prisma/client.js';

/**
 * Customer-facing wording for every order status: the only place it is written, so emails
 * never show raw values such as READY_FOR_COURIER. `subject` receives the order number.
 */
export const ORDER_STATUS_COPY: Record<
  OrderStatus,
  {
    label: string;
    title: string;
    message: string;
    subject: (orderNumber: string) => string;
  }
> = {
  ORDERED: {
    label: 'Order received',
    title: 'Order received',
    message: 'We’ve received your order and will start working on it soon.',
    subject: (number) => `Order received – #${number}`,
  },
  CREATING: {
    label: 'Being made',
    title: 'We’re creating your order',
    message: 'Your handmade piece is currently being created.',
    subject: (number) => `We’re creating your order – #${number}`,
  },
  CREATED: {
    label: 'Created',
    title: 'Your order is ready',
    message:
      'Your handmade piece has been created and is being prepared for delivery.',
    subject: (number) => `Your order has been created – #${number}`,
  },
  READY_FOR_COURIER: {
    label: 'Ready for courier',
    title: 'Ready for courier',
    message: 'Your order is ready to be handed over to the courier.',
    subject: (number) => `Your order is ready for delivery – #${number}`,
  },
  PICKED_UP_BY_COURIER: {
    label: 'On the way',
    title: 'Your order is on the way',
    message:
      'Your order has been picked up by the courier and is on its way to you.',
    subject: (number) =>
      `Your HomeMade Creator order is on the way – #${number}`,
  },
  COMPLETED: {
    label: 'Completed',
    title: 'Order completed',
    message:
      'Your HomeMade Creator order has been completed. We hope you love it.',
    subject: (number) => `Your HomeMade Creator order is complete – #${number}`,
  },
};
