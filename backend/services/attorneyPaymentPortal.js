const account = require("./attorneyAccountBoundary"), evidence = require("./paymentCardEvidence"), { randomUUID } = require("node:crypto");
const fail = (status, suffix) => { throw Object.assign(new Error("Billing could not be opened. Check the saved card and try again."), { status, publicCode: `PAYMENT_SETUP_PORTAL_${suffix}` }); };
const providerOptions = { timeout: 10000, maxNetworkRetries: 0 };
function safeUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "billing.stripe.com" && !url.port && !url.username && !url.password && !url.hash && !url.search && /^\/p\/session\/[A-Za-z0-9_]+$/.test(url.pathname) ? url.href : null; } catch { return null; }
}
async function create(req, { stripe, clientBase, legacy = false }) {
  const provided = req.body || {};
  if (Object.keys(provided).some(key => !["expectedOwnerId", "requestId"].includes(key))) fail(400, "INVALID");
  const body = legacy ? { expectedOwnerId: provided.expectedOwnerId ?? String(req.user.id), requestId: provided.requestId ?? randomUUID() } : provided;
  if (Object.keys(body).some(key => !["expectedOwnerId", "requestId"].includes(key)) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId || "")) fail(400, "INVALID");
  const read = () => account.read(req, body.expectedOwnerId, ["stripeCustomerId"]), user = await read(), customerId = user.stripeCustomerId;
  if (typeof customerId !== "string" || !/^cus_[A-Za-z0-9_]{1,200}$/.test(customerId)) fail(409, "CARD_REQUIRED");
  const check = async () => { const current = await read(); if (current.stripeCustomerId !== customerId) fail(409, "CHANGED"); };
  const customer = await stripe.customers.retrieve(customerId, {}, providerOptions);
  await check();
  evidence.customer(customer, customerId, user._id);
  const returnUrl = new URL(legacy ? "/dashboard-attorney.html?billing=return#funds" : "/attorney-v2.html#/payments?billing=return", clientBase);
  if (!["http:", "https:"].includes(returnUrl.protocol) || returnUrl.username || returnUrl.password) fail(503, "UNAVAILABLE");
  const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl.href }, { ...providerOptions, idempotencyKey: stripe.stripeIdempotencyKey("attorney_portal", user._id, body.requestId) });
  await check();
  evidence.mode(session);
  if (session?.object !== "billing_portal.session" || session.customer !== customerId) fail(503, "UNAVAILABLE");
  const url = safeUrl(session?.url);
  if (!url || !/^bps_[A-Za-z0-9_]{1,200}$/.test(session?.id || "")) fail(503, "UNAVAILABLE");
  return { ownerId: String(user._id), url, ...(legacy ? { sessionId: session.id } : {}) };
}
module.exports = { create, safeUrl };
