const { rateLimit } = require('express-rate-limit');
function createStripeWebhookProtection({ limit = 3000, windowMs = 60000, maxConcurrent = 32 } = {}) {
  // Dedicated provider budget: reject before parsing/DB work and never
  // acknowledge an unprocessed event, so Stripe can retry it later.
  const deliveryLimit = rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false,
    message: { received: false, retryable: true, error: 'Webhook delivery capacity reached. Retry later.' } });
  let active = 0;
  function capacity(_req, res, next) {
    if (active >= maxConcurrent) {
      res.set('Retry-After', '5');
      return res.status(503).json({ received: false, retryable: true });
    }
    active += 1;
    let released = false;
    const release = () => { if (!released) { released = true; active -= 1; } };
    res.once('finish', release); res.once('close', release); next();
  }
  return { deliveryLimit, capacity };
}
module.exports = { createStripeWebhookProtection };
