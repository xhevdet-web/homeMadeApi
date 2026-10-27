import type { ContactMessage, RenderedEmail } from '../mail.types.js';
import {
  COLORS,
  escapeHtml,
  field,
  multiline,
  paragraph,
  renderLayout,
} from './layout.js';

/** A customer's Contact us message, delivered to the HomeMade Creator inbox. */
export function contactMessageEmail(input: ContactMessage): RenderedEmail {
  const html = renderLayout({
    preheader: `${input.name}: ${input.subject}`,
    heading: 'New customer message',
    body: [
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`,
      field('Name', escapeHtml(input.name)),
      field('Email', escapeHtml(input.email)),
      input.orderNumber ? field('Order', escapeHtml(input.orderNumber)) : '',
      field('Subject', escapeHtml(input.subject)),
      field(
        'Message',
        `<div style="padding:14px 16px;background-color:${COLORS.soft};border-radius:12px;">${multiline(input.message)}</div>`,
      ),
      `</table>`,
      paragraph(
        'Reply directly to this email to respond to the customer.',
        COLORS.muted,
      ),
    ].join('\n'),
    footer: 'Sent from the Contact us form in the HomeMade Creator app.',
  });
  const text = [
    'New customer message',
    '',
    `Name: ${input.name}`,
    `Email: ${input.email}`,
    ...(input.orderNumber ? [`Order: ${input.orderNumber}`] : []),
    `Subject: ${input.subject}`,
    '',
    'Message:',
    input.message,
    '',
    'Reply directly to this email to respond to the customer.',
  ].join('\n');
  return { subject: `[HomeMade Creator] ${input.subject}`, text, html };
}
