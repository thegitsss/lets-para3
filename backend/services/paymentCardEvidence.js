"use strict";
const { currentStripeMode } = require("../utils/stripeMode");
const reference = value => typeof value === "string" ? value : value?.id;
const external = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(value);
function invalid() { throw Object.assign(new Error("Payment card details could not be verified. Refresh before continuing."), { status: 409, publicCode: "PAYMENT_SETUP_UNAVAILABLE" }); }
function mode(value) {
  const expected = currentStripeMode();
  if (typeof value?.livemode !== "boolean" || expected === "unknown" || expected !== (value.livemode ? "live" : "test")) invalid();
}
function customer(value, customerId, ownerId) {
  mode(value);
  if (!external(customerId, "cus") || value?.id !== customerId || value.object !== "customer" || value.deleted || value.metadata?.userId && value.metadata.userId !== String(ownerId)) invalid();
  return value;
}
function card(value, customerId, paymentMethodId, { allowUnattached = false } = {}) {
  mode(value);
  if (!external(paymentMethodId, "pm") || value?.id !== paymentMethodId || value.object !== "payment_method" || value.type !== "card" || !(reference(value.customer) === customerId || allowUnattached && value.customer === null)) invalid();
  const details = value.card;
  if (!details || typeof details.brand !== "string" || !/^[a-z0-9_ -]{1,40}$/i.test(details.brand) || !/^\d{4}$/.test(details.last4 || "") || !Number.isInteger(details.exp_month) || details.exp_month < 1 || details.exp_month > 12 || !Number.isInteger(details.exp_year) || details.exp_year < 2000 || details.exp_year > 2200) invalid();
  return value;
}
function setup(value, customerId, intentId, ownerId) {
  mode(value);
  if (!external(intentId, "seti") || value?.id !== intentId || value.object !== "setup_intent" || reference(value.customer) !== customerId || value.metadata?.userId !== String(ownerId) || !["requires_payment_method", "requires_confirmation", "requires_action", "processing", "canceled", "succeeded"].includes(value.status)) invalid();
  return value;
}
module.exports = { customer, card, setup, mode, invalid };
