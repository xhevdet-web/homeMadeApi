import type { OrderStatusEmail, RenderedEmail } from '../mail.types.js';
import { ORDER_STATUS_COPY } from '../order-status-copy.js';
import {
  COLORS,
  escapeHtml,
  field,
  paragraph,
  renderLayout,
} from './layout.js';

// No "View your order" button: the app has no web page or tested deep link for an order
// yet, and email clients drop custom-scheme links. Add one when a real URL exists.
export function orderStatusEmail(input: OrderStatusEmail): RenderedEmail {
  const copy = ORDER_STATUS_COPY[input.status];
  const greeting = input.customer.firstName.trim()
    ? `Hi ${input.customer.firstName.trim()},`
    : 'Hi,';
  const html = renderLayout({
    preheader: `${copy.title}: ${copy.message}`,
    heading: 'Your order has been updated',
    body: [
      paragraph(escapeHtml(greeting)),
      paragraph('There’s an update on your HomeMade Creator order.'),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.soft};border-radius:12px;"><tr><td style="padding:20px 20px 4px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${field('Order', `#${escapeHtml(input.orderNumber)}<br><span style="color:${COLORS.muted};">${escapeHtml(input.productName)}</span>`)}
${field('Status', `<strong>${escapeHtml(copy.title)}</strong>`)}
</table></td></tr></table>`,
      `<div style="height:20px;line-height:20px;">&nbsp;</div>`,
      paragraph(escapeHtml(copy.message)),
      paragraph('Thank you for creating with us.', COLORS.muted),
    ].join('\n'),
    footer:
      'You’re receiving this email because you placed an order with HomeMade Creator.',
  });
  const text = [
    greeting,
    '',
    'There’s an update on your HomeMade Creator order.',
    '',
    `Order: #${input.orderNumber}`,
    `Product: ${input.productName}`,
    `Status: ${copy.title}`,
    '',
    copy.message,
    '',
    'Thank you for creating with us.',
    'HomeMade Creator',
  ].join('\n');
  return { subject: copy.subject(input.orderNumber), text, html };
}
