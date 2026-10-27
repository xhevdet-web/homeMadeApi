# Email (SMTP)

`src/mail/` is the API's only email client. Import `MailModule` and inject `MailService`.

## Settings (`.env`)

| Variable | Required | Notes |
| --- | --- | --- |
| `SMTP_HOST` | yes | e.g. `smtp.gmail.com` |
| `SMTP_PORT` | yes | `587` (STARTTLS) or `465` (TLS) |
| `SMTP_SECURE` | no | `true`/`false`; defaults to `true` only on port 465 |
| `SMTP_USER` | yes | the mailbox that logs in |
| `SMTP_APP_PASSWORD` | yes | a Gmail App Password; never logged or returned |
| `SMTP_FROM_NAME` | no | defaults to `HomeMade Creator` |
| `SMTP_FROM_EMAIL` | yes | sender of every email, and the inbox for Contact us messages |

The settings are validated when the API starts: a missing or invalid value stops startup
with the variable's name (never its value). On port 587 STARTTLS is required and
certificates are always verified.

## Order status emails

`PATCH /api/v1/orders/:id/status` (admin) saves the new status, then emails the order's
own customer (`order.user.email`). Wording for each status lives only in
`src/mail/order-status-copy.ts`, so raw values such as `READY_FOR_COURIER` never reach a
customer. No email is sent when the saved status equals the previous one, or for payment,
notes or image updates. If sending fails, the status change is kept and the failure is
logged (`orderId`, `status`). The email has no "View your order" button yet: there is no
web page or tested app link for an order.

## Contact us

`POST /api/v1/contact` (public, 5 requests per client per 15 minutes):

```json
{
  "name": "Ilirian",
  "email": "customer@example.com",
  "subject": "Question about my order",
  "message": "Hello, I have a question about...",
  "orderNumber": "HM-2026-627079642"
}
```

`orderNumber` is optional. Limits: name 1–100, email ≤254, subject 1–150 (single line),
message 10–5000, orderNumber ≤40. The message is sent **from** `SMTP_FROM_EMAIL` **to**
`SMTP_FROM_EMAIL`, with **Reply-To** set to the customer, so Reply in Gmail answers the
customer. All customer text is HTML-escaped. Returns
`{ "success": true, "message": "Your message has been sent." }`, or `503` with
"Unable to send your message right now. Please try again later." when SMTP fails.
Messages are not stored.

## Checking the SMTP setup

```bash
pnpm mail:test                      # build, then verify the connection and login only
pnpm mail:test you@example.com      # also send ONE "HomeMade Creator SMTP Test" email
```

There is no HTTP endpoint for test emails. Automated tests replace the transport and never
contact a mail server.
