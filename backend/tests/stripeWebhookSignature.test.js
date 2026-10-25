const Stripe = require('stripe');
const { verifyStripeWebhook } = require('../services/stripeWebhookSignature');
const webhooks = new Stripe('sk_test_signature_fixture').webhooks;
const env = { STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_platform', STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_synthetic_connect' };
const payload = account => JSON.stringify({ id: 'evt_signature_fixture', type: 'account.updated', ...(account ? { account } : {}), data: { object: { id: account || 'acct_platform' } } });
const signed = (body, secret) => webhooks.generateTestHeaderString({ payload: body, secret });

test.each(['STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_WEBHOOK_SECRET'])('verifies genuine signatures from %s without a request account header', key => {
  const body = payload(key === 'STRIPE_CONNECT_WEBHOOK_SECRET' ? 'acct_connected_fixture' : null);
  expect(verifyStripeWebhook({ body: Buffer.from(body), signature: signed(body, env[key]), webhooks, env })).toMatchObject({ id: 'evt_signature_fixture' });
});

test('signed Connect account identity is retained for downstream handling', () => {
  const body = payload('acct_connected_fixture');
  expect(verifyStripeWebhook({ body: Buffer.from(body), signature: signed(body, env.STRIPE_CONNECT_WEBHOOK_SECRET), webhooks, env }).account).toBe('acct_connected_fixture');
});

test('changing signed bytes or signing with an unrelated endpoint is rejected', () => {
  const body = payload('acct_connected_fixture');
  expect(() => verifyStripeWebhook({ body: Buffer.from(body.replace('acct_connected_fixture', 'acct_changed')), signature: signed(body, env.STRIPE_CONNECT_WEBHOOK_SECRET), webhooks, env })).toThrow('signature verification failed');
  expect(() => verifyStripeWebhook({ body: Buffer.from(body), signature: signed(body, 'whsec_unrelated'), webhooks, env })).toThrow('signature verification failed');
  expect(() => verifyStripeWebhook({ body: Buffer.from(body), signature: signed(body, env.STRIPE_WEBHOOK_SECRET), webhooks, env: {} })).toThrow('signature verification failed');
});
