import type { OrderStatus } from '../generated/prisma/client.js';

/**
 * Customer-facing wording for every order status: the only place it is written, so emails
 * never show raw values such as READY_FOR_COURIER. `label` is the friendly status name,
 * `step` its name in the progress tracker, `title` the email heading, and `subject`
 * receives the order number; `inApp` is the notification-centre version. The keys are in
 * workflow order.
 */
export const ORDER_STATUS_COPY: Record<
  OrderStatus,
  {
    label: string;
    /** One or two words for the progress tracker. */
    step: string;
    title: string;
    message: string;
    subject: (orderNumber: string) => string;
    /** The in-app notification: a short title and a line naming the order. */
    inApp: { title: string; message: (orderNumber: string) => string };
  }
> = {
  ORDERED: {
    label: 'Order received',
    step: 'Ordered',
    title: 'Order received',
    message: 'We’ve received your order and will start preparing it soon.',
    subject: (number) => `We’ve received your order ${number}`,
    inApp: {
      title: 'Order received',
      message: (number) => `We’ve received your order ${number}.`,
    },
  },
  CREATING: {
    label: 'Being created',
    step: 'Creating',
    title: 'We’re creating your order',
    message: 'Good news! We’ve started creating your order.',
    subject: (number) => `We’re creating your order ${number}`,
    inApp: {
      title: 'We’re creating your order',
      message: (number) => `We’ve started creating your order ${number}.`,
    },
  },
  CREATED: {
    label: 'Created',
    step: 'Created',
    title: 'Your order has been created',
    message:
      'Your order has been created and is being prepared for the next step.',
    subject: (number) => `Your order ${number} has been created`,
    inApp: {
      title: 'Your order is ready',
      message: (number) =>
        `Your order ${number} has been created and is being prepared for the next step.`,
    },
  },
  READY_FOR_COURIER: {
    label: 'Ready for the courier',
    step: 'Ready',
    title: 'Ready for the courier',
    message:
      'Your order is ready and waiting to be handed over to the courier.',
    subject: (number) => `Your order ${number} is ready for the courier`,
    inApp: {
      title: 'Ready for the courier',
      message: (number) =>
        `Your order ${number} is ready to be handed over to the courier.`,
    },
  },
  PICKED_UP_BY_COURIER: {
    label: 'Picked up by the courier',
    step: 'On its way',
    title: 'Your order is on its way',
    message:
      'Your order has been picked up by the courier and is on its way to you.',
    subject: (number) =>
      `Your order ${number} has been picked up by the courier`,
    inApp: {
      title: 'Your order is on its way',
      message: (number) =>
        `Your order ${number} has been picked up by the courier.`,
    },
  },
  COMPLETED: {
    label: 'Completed',
    step: 'Completed',
    title: 'Order completed',
    message:
      'Your order has been completed. Thank you for choosing HomeMade Creator.',
    subject: (number) => `Your order ${number} has been completed`,
    inApp: {
      title: 'Order completed',
      message: (number) =>
        `Your order ${number} has been completed. Thank you for choosing HomeMade Creator.`,
    },
  },
};

/** Cents as euros for customers: 4200 → "€42.00". */
export const formatEuro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
