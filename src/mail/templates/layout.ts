// The app's palette (warm off-white, navy, copper) in email-safe inline styles.
export const COLORS = {
  background: '#FAF7F2',
  card: '#FFFFFF',
  text: '#2D3250',
  muted: '#676F9D',
  accent: '#A65B2A',
  border: '#E8E1D6',
  soft: '#F5EFE7',
} as const;
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Every value that reaches HTML goes through this, so user text is shown, never run. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Escaped text that keeps its line breaks. */
export const multiline = (value: string) =>
  escapeHtml(value).replace(/\r?\n/g, '<br>');

/** A small uppercase label above a value, e.g. ORDER / #HM-2026-000001. */
export function field(label: string, valueHtml: string): string {
  return `<tr><td style="padding:0 0 16px 0;">
<div style="font-family:${SANS};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};font-weight:bold;">${escapeHtml(label)}</div>
<div style="font-family:${SANS};font-size:15px;line-height:22px;color:${COLORS.text};padding-top:4px;">${valueHtml}</div>
</td></tr>`;
}

export const paragraph = (html: string, color: string = COLORS.text) =>
  `<p style="margin:0 0 16px 0;font-family:${SANS};font-size:15px;line-height:24px;color:${color};">${html}</p>`;

/**
 * The shared email shell: brand header, one white card, footer. Table based and inline
 * styled for email clients; no scripts or external assets.
 */
export function renderLayout({
  preheader,
  heading,
  body,
  footer,
}: {
  /** Inbox preview text (hidden in the email). */
  preheader: string;
  heading: string;
  /** Trusted HTML built from escaped values. */
  body: string;
  footer: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.background};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.background};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 8px 20px 8px;font-family:${SERIF};font-size:22px;color:${COLORS.text};">
HomeMade <span style="color:${COLORS.accent};font-style:italic;">Creator</span>
</td></tr>
<tr><td style="background-color:${COLORS.card};border:1px solid ${COLORS.border};border-radius:16px;padding:32px 28px;">
<h1 style="margin:0 0 20px 0;font-family:${SERIF};font-size:26px;line-height:32px;font-weight:normal;color:${COLORS.text};">${escapeHtml(heading)}</h1>
${body}
</td></tr>
<tr><td style="padding:20px 8px 0 8px;font-family:${SANS};font-size:12px;line-height:18px;color:${COLORS.muted};">${escapeHtml(footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
