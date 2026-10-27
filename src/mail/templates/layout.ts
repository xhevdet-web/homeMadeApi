// The app's palette (warm off-white, navy, copper) in email-safe inline styles.
export const COLORS = {
  background: '#F4F1EC',
  card: '#FFFFFF',
  text: '#2D3250',
  muted: '#676F9D',
  accent: '#A65B2A',
  border: '#E8E1D6',
  soft: '#F8F5F0',
  navy: '#2D3250',
  onNavy: '#FFFFFF',
  onNavyMuted: '#B8BDD5',
  apricot: '#F0A06B',
} as const;
export const SERIF = "Georgia, 'Times New Roman', serif";
export const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

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

/** A small uppercase label above a value, e.g. ORDER / HM-2026-000001. */
export function field(label: string, valueHtml: string): string {
  return `<tr><td style="padding:0 0 16px 0;">
<div style="font-family:${SANS};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};font-weight:bold;">${escapeHtml(label)}</div>
<div style="font-family:${SANS};font-size:15px;line-height:22px;color:${COLORS.text};padding-top:4px;">${valueHtml}</div>
</td></tr>`;
}

export const paragraph = (html: string, color: string = COLORS.text) =>
  `<p style="margin:0 0 16px 0;font-family:${SANS};font-size:15px;line-height:24px;color:${color};">${html}</p>`;

/** Vertical breathing room that every email client respects. */
export const spacer = (height: number) =>
  `<div style="height:${height}px;line-height:${height}px;font-size:1px;">&nbsp;</div>`;

/**
 * The shared email shell: a navy brand header, one white card with an optional small
 * label above the heading, and a quiet footer. Table based and inline styled for email
 * clients; no scripts or external assets. It declares a light colour scheme so dark-mode
 * clients keep the brand colours instead of inverting them.
 */
export function renderLayout({
  preheader,
  eyebrow,
  heading,
  body,
  footer,
}: {
  /** Inbox preview text (hidden in the email). */
  preheader: string;
  /** Small uppercase label above the heading, e.g. "ORDER UPDATE". */
  eyebrow?: string;
  heading: string;
  /** Trusted HTML built from escaped values. */
  body: string;
  footer: string;
}): string {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title>
<style>:root{color-scheme:light;supported-color-schemes:light;}</style>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.background};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.background};">
<tr><td align="center" style="padding:24px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:${COLORS.card};border:1px solid ${COLORS.border};border-radius:16px;overflow:hidden;">
<tr><td align="center" style="background-color:${COLORS.navy};padding:28px 24px 24px 24px;">
<div style="font-family:${SERIF};font-size:26px;line-height:30px;color:${COLORS.onNavy};">Home<span style="color:${COLORS.apricot};font-style:italic;">Creator</span></div>
<div style="font-family:${SANS};font-size:10px;letter-spacing:3px;text-transform:uppercase;color:${COLORS.onNavyMuted};padding-top:8px;">Designed by you · Made by hand</div>
</td></tr>
<tr><td style="padding:32px 24px 8px 24px;">
${eyebrow ? `<div style="font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${COLORS.accent};font-weight:bold;padding-bottom:10px;">${escapeHtml(eyebrow)}</div>` : ''}
<h1 style="margin:0 0 24px 0;font-family:${SERIF};font-size:28px;line-height:34px;font-weight:normal;color:${COLORS.text};">${escapeHtml(heading)}</h1>
${body}
</td></tr>
<tr><td style="padding:0 24px;"><div style="border-top:1px solid ${COLORS.border};height:1px;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>
<tr><td align="center" style="padding:20px 24px 28px 24px;font-family:${SANS};font-size:12px;line-height:18px;color:${COLORS.muted};">
${escapeHtml(footer)}<br>
<span style="color:${COLORS.muted};">© ${year} HomeMade Creator</span>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
