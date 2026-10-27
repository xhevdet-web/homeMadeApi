import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { ContactModule } from '../../src/modules/contact/contact.module.js';
import { setupApp } from '../../src/config/setup-app.js';
import {
  fakeTransport,
  testMailConfig,
  withFakeMail,
} from '../mail/fake-mail.js';

describe('Contact us', () => {
  let app: INestApplication<App>;
  let throttle: ThrottlerStorageService;
  const mail = fakeTransport();
  const valid = {
    name: 'Ilirian',
    email: 'customer@example.com',
    subject: 'Question about my order',
    message: 'Hello,\nI have a question about the delivery of my order.',
    orderNumber: 'HM-2026-627079642',
  };
  const send = (body: object) =>
    request(app.getHttpServer()).post('/api/v1/contact').send(body);

  beforeAll(async () => {
    const module = await withFakeMail(
      Test.createTestingModule({ imports: [ContactModule] }),
      mail,
    ).compile();
    app = module.createNestApplication();
    setupApp(app);
    await app.init();
    throttle = module.get(ThrottlerStorage);
  });
  beforeEach(() => {
    vi.resetAllMocks();
    // Each test starts with a fresh rate limit: the store keeps counts and hit times apart.
    throttle.storage.clear();
    (
      throttle as unknown as { hitExpirations: Map<string, unknown> }
    ).hitExpirations.clear();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('delivers the message to the shop inbox, from the shop, replying to the customer', async () => {
    const response = await send(valid).expect(200);
    expect(response.body).toEqual({
      success: true,
      message: 'Your message has been sent.',
    });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const message = mail.sendMail.mock.calls[0][0];
    expect(message.to).toBe(testMailConfig.from.address);
    expect(message.from).toEqual({
      name: 'HomeMade Creator',
      address: testMailConfig.from.address,
    });
    expect(message.replyTo).toEqual({
      name: 'Ilirian',
      address: 'customer@example.com',
    });
    expect(message.subject).toBe('[HomeMade Creator] Question about my order');
    for (const content of [message.text, message.html]) {
      expect(content).toContain('customer@example.com');
      expect(content).toContain('HM-2026-627079642');
      expect(content).toContain('the delivery of my order.');
    }
    expect(message.html).toContain('Hello,<br>I have a question');
  });

  it('escapes customer HTML instead of rendering it', async () => {
    await send({
      ...valid,
      name: 'Eve <b>Bold</b>',
      subject: 'Hi <img src=x onerror=alert(1)>',
      message: '<script>alert("x")</script> & thanks',
    }).expect(200);
    const { html } = mail.sendMail.mock.calls[0][0];
    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; thanks',
    );
    expect(html).toContain('Eve &lt;b&gt;Bold&lt;/b&gt;');
  });

  it('works without an order number', async () => {
    const { orderNumber: _orderNumber, ...withoutOrder } = valid;
    await send(withoutOrder).expect(200);
    expect(mail.sendMail.mock.calls[0][0].text).not.toContain('Order:');
  });

  it.each([
    ['an invalid email', { email: 'not-an-email' }],
    [
      'a header-injection email',
      { email: 'a@example.com\r\nBcc: victim@example.com' },
    ],
    ['an empty message', { message: '   ' }],
    ['a too short message', { message: 'Hi' }],
    ['an oversized message', { message: 'a'.repeat(5001) }],
    ['a missing name', { name: '' }],
    ['a multi-line subject', { subject: 'Hello\r\nBcc: victim@example.com' }],
    ['an oversized subject', { subject: 's'.repeat(151) }],
    ['a malformed order number', { orderNumber: 'HM 2026; DROP' }],
    ['unknown fields', { to: 'someone@example.com' }],
  ])('rejects %s', async (_case, change) => {
    await send({ ...valid, ...change }).expect(400);
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('reports a safe error when the email cannot be sent', async () => {
    mail.sendMail.mockRejectedValue(
      new Error('Invalid login: 535-5.7.8 Username and Password not accepted'),
    );
    const response = await send(valid).expect(503);
    expect(response.body.message).toBe(
      'Unable to send your message right now. Please try again later.',
    );
    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/535|Password not accepted|smtp/i);
    expect(body).not.toContain(testMailConfig.password);
    expect(body).not.toContain(testMailConfig.user);
  });

  it('limits each client to 5 messages per 15 minutes', async () => {
    for (let attempt = 0; attempt < 5; attempt++) await send(valid).expect(200);
    await send(valid).expect(429);
    expect(mail.sendMail).toHaveBeenCalledTimes(5);
  });
});
