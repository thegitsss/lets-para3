// Connect events identify their account inside the signed Event object. The
// Stripe-Account request header must not choose a webhook signing secret.
function verifyStripeWebhook({ body, signature, webhooks, env = process.env }) {
  const secrets = [...new Set([env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(value => typeof value === 'string' && value))];
  for (const secret of secrets) {
    try {
      const event = webhooks.constructEvent(body, signature, secret);
      if (event && typeof event === 'object') return event;
    } catch (_) {
      // Try the other configured endpoint secret against the same raw bytes.
      // Never parse or trust the payload to select its verification authority.
    }
  }
  throw Object.assign(new Error('Webhook signature verification failed.'), { code: 'STRIPE_SIGNATURE_INVALID' });
}

module.exports = { verifyStripeWebhook };
