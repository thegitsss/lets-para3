const { createDevOnlyEmailSet } = require("./devOnlyEmailSet");

// Development/test-only compatibility. createDevOnlyEmailSet returns an empty
// set in production, so these identities cannot bypass payout readiness there.
const STRIPE_CONNECT_BYPASS_EMAILS = createDevOnlyEmailSet([
  "samanthasider+11@gmail.com",
  "samanthasider+56@gmail.com",
  "support.cr.e2e.paralegal@lets-paraconnect.dev",
]);

function hasStripeConnectBypass(email = "") {
  return STRIPE_CONNECT_BYPASS_EMAILS.has(String(email || "").toLowerCase().trim());
}

module.exports = { hasStripeConnectBypass, STRIPE_CONNECT_BYPASS_EMAILS };
