import type { OrderStatus } from '../../generated/prisma/client.js';
import type { OrderEmail, RenderedEmail } from '../mail.types.js';
import { formatEuro, ORDER_STATUS_COPY } from '../order-status-copy.js';
import {
  COLORS,
  escapeHtml,
  paragraph,
  renderLayout,
  SANS,
  spacer,
} from './layout.js';

// No "View your order" button: the app has no web page or tested deep link for an order
// yet, and email clients drop custom-scheme links. Add one when a real URL exists.
const FOLLOW = 'You can follow your order in the HomeMade Creator app.';
const THANKS = 'Thank you for choosing HomeMade Creator.';
const FOOTER =
  'You’re receiving this email because you placed an order with HomeMade Creator.';
const STEPS = Object.keys(ORDER_STATUS_COPY) as OrderStatus[];

const greeting = (input: OrderEmail) =>
  input.customer.firstName.trim()
    ? `Hi ${input.customer.firstName.trim()},`
    : 'Hi,';

/**
 * Where the order is: one step per status, done ones ticked, the current one highlighted.
 * Plain table cells, so it holds up in Outlook as well as Gmail and Apple Mail.
 */
function tracker(status: OrderStatus) {
  const current = STEPS.indexOf(status);
  const cells = STEPS.map((step, index) => {
    const done = index < current;
    const active = index === current;
    const dot = done || active ? COLORS.accent : COLORS.card;
    const ring = done || active ? COLORS.accent : COLORS.border;
    const mark = done ? '✓' : active ? '●' : '';
    const label = active ? COLORS.text : done ? COLORS.accent : COLORS.muted;
    return `<td align="center" valign="top" width="${Math.floor(100 / STEPS.length)}%" style="padding:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td align="center" width="22" height="22" style="width:22px;height:22px;border-radius:50%;background-color:${dot};border:2px solid ${ring};font-family:${SANS};font-size:11px;line-height:22px;color:${COLORS.onNavy};">${mark}</td></tr></table>
<div style="font-family:${SANS};font-size:10px;line-height:13px;color:${label};padding-top:7px;${active ? 'font-weight:bold;' : ''}">${escapeHtml(ORDER_STATUS_COPY[step].step)}</div>
</td>`;
  }).join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.soft};border-radius:12px;">
<tr><td style="padding:18px 6px 16px 6px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${cells}
</tr></table>
</td></tr></table>`;
}

/** Order number, design, status and total, as a clean two-column receipt. */
function details(input: OrderEmail) {
  const rows: [string, string, boolean?][] = [
    ['Order number', input.orderNumber],
    ['Design', input.productName],
    ['Status', ORDER_STATUS_COPY[input.status].label],
    ['Total', formatEuro(input.totalPrice), true],
  ];
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${COLORS.border};">
${rows
  .map(
    ([label, value, strong]) => `<tr>
<td style="padding:14px 0;border-bottom:1px solid ${COLORS.border};font-family:${SANS};font-size:14px;line-height:20px;color:${COLORS.muted};">${escapeHtml(label)}</td>
<td align="right" style="padding:14px 0;border-bottom:1px solid ${COLORS.border};font-family:${SANS};font-size:${strong ? 17 : 14}px;line-height:20px;color:${COLORS.text};${strong ? 'font-weight:bold;' : ''}">${escapeHtml(value)}</td>
</tr>`,
  )
  .join('\n')}
</table>`;
  const text = rows.map(([label, value]) => `${label}: ${value}`);
  return { html, text };
}

function render(
  input: OrderEmail,
  {
    subject,
    eyebrow,
    heading,
    intro,
  }: { subject: string; eyebrow: string; heading: string; intro: string[] },
): RenderedEmail {
  const order = details(input);
  const html = renderLayout({
    preheader: intro.join(' '),
    eyebrow,
    heading,
    body: [
      paragraph(escapeHtml(greeting(input))),
      ...intro.map((line) => paragraph(escapeHtml(line))),
      spacer(8),
      tracker(input.status),
      spacer(28),
      order.html,
      spacer(28),
      paragraph(FOLLOW, COLORS.muted),
      paragraph(
        `${THANKS}<br><span style="color:${COLORS.accent};">— The HomeMade Creator team</span>`,
      ),
    ].join('\n'),
    footer: FOOTER,
  });
  const text = [
    heading,
    '',
    greeting(input),
    '',
    ...intro.flatMap((line) => [line, '']),
    ...order.text,
    '',
    FOLLOW,
    '',
    THANKS,
    'The HomeMade Creator team',
  ].join('\n');
  return { subject, text, html };
}

/** Sent once, right after a customer's order is saved. */
export function orderCreatedEmail(input: OrderEmail): RenderedEmail {
  return render(input, {
    subject: `Order ${input.orderNumber} received`,
    eyebrow: 'Order confirmed',
    heading: 'Thank you for your order!',
    intro: [
      `We’ve received your order ${input.orderNumber} and will start preparing it soon.`,
    ],
  });
}

/** Sent when an admin moves the order to a new status. */
export function orderStatusEmail(input: OrderEmail): RenderedEmail {
  const copy = ORDER_STATUS_COPY[input.status];
  return render(input, {
    subject: copy.subject(input.orderNumber),
    eyebrow: 'Order update',
    heading: copy.title,
    intro: [copy.message],
  });
}
