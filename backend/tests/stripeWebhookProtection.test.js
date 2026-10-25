const express = require('express');
const request = require('supertest');
const { createStripeWebhookProtection } = require('../middleware/stripeWebhookProtection');
test('excess deliveries receive retryable 429 before raw parsing or processing', async () => {
  const app = express(); const { deliveryLimit, capacity } = createStripeWebhookProtection({ limit: 2 });
  const processed = jest.fn((_req, res) => res.json({ received: true }));
  app.post('/', deliveryLimit, capacity, express.raw({ type: 'application/json', limit: '100kb' }), processed);
  for (let i = 0; i < 2; i++) expect((await request(app).post('/').send('{}')).status).toBe(200);
  const blocked = await request(app).post('/').send('{}');
  expect(blocked.status).toBe(429); expect(blocked.headers['retry-after']).toBeDefined();
  expect(blocked.body).toMatchObject({ received: false, retryable: true }); expect(processed).toHaveBeenCalledTimes(2);
});
test('concurrency overload receives retryable 503; completing a request releases capacity', async () => {
  const app = express(); const { deliveryLimit, capacity } = createStripeWebhookProtection({ maxConcurrent: 1 });
  let release, entered; const enteredPromise = new Promise(resolve => { entered = resolve; });
  let hold = true;
  app.post('/', deliveryLimit, capacity, async (_req, res) => { if (hold) await new Promise(resolve => { release = resolve; entered(); }); res.json({ received: true }); });
  const first = request(app).post('/').then(value => value); await enteredPromise;
  const blocked = await request(app).post('/');
  expect(blocked.status).toBe(503); expect(blocked.body).toEqual({ received: false, retryable: true });
  expect(blocked.headers['retry-after']).toBe('5');
  hold = false; release(); expect((await first).status).toBe(200);
  expect((await request(app).post('/')).status).toBe(200);
});
