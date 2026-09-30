const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function readCheckout(value, funding) {
  if (value?.ownerId !== funding.ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (!funding.hasOriginalCheckout || value.caseId !== funding.caseId || value.fundingRevision !== funding.revision || !hash(value.revision) || !/^cs_[A-Za-z0-9_]{1,200}$/.test(value.sessionId || "") || !["available", "expired", "processing", "paid", "verified", "needs_review"].includes(value.state) || typeof value.canResume !== "boolean" || value.canResume !== (value.state === "available") || value.fundingVerified !== funding.fundingVerified || value.totalCents !== funding.totalCents || value.currency !== funding.currency || value.expiresAt !== null && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) || value.state === "verified" && !value.fundingVerified || value.canResume && (funding.totalCents === null || funding.currency === null || funding.blockers.some(key => key !== "payment_reference_needs_review") || value.fundingVerified || funding.closed || funding.canPrepare || !value.expiresAt || Date.parse(value.expiresAt) <= Date.now())) throw new Error("invalid_checkout_review");
  return Object.fromEntries(["ownerId", "caseId", "fundingRevision", "revision", "sessionId", "state", "canResume", "fundingVerified", "totalCents", "currency", "expiresAt"].map(key => [key, value[key]]));
}
export function readCheckoutResume(value, funding, reviewed) {
  const checkout = readCheckout(value?.checkout, funding);
  if (!checkout.canResume || checkout.revision !== reviewed.revision || checkout.sessionId !== reviewed.sessionId || typeof value.url !== "string") throw new Error("checkout_changed");
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password || url.port || ![`/c/pay/${checkout.sessionId}`, `/pay/${checkout.sessionId}`].includes(url.pathname)) throw new Error("invalid_checkout_url");
  return value.url;
}
export const checkoutMessage = value => ({ available: "The original Checkout is open. Continue with Stripe to enter payment details.", expired: "The original Checkout has expired. Request a payment review to continue.", processing: "Stripe is still processing the original payment. Refresh its status before taking another payment action.", paid: "Stripe reports the original payment as paid. Its funding record has not been verified here yet.", verified: "Original Matter payment recorded. Refunds and payouts are shown in the financial history.", needs_review: "The original Checkout needs LPC review before payment can continue." })[value.state];
