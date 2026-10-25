const valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const money = value => value === null || Number.isSafeInteger(value) && value >= 0;
const date = value => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
export function readPaymentRecords(value, ownerId) {
  if (!value || value.ownerId !== ownerId || !["all", "unreleased", "released", "withdrawal"].includes(value.view) || typeof value.q !== "string" || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items) || value.items.length > 50 || value.nextCursor !== null && !valid(value.nextCursor) || !["none", "found", "unavailable"].includes(value.selection) || value.selection === "found" !== Boolean(value.selected)) throw new Error("invalid_payment_records");
  const ids = new Set();
  if (value.items.length > value.total) throw new Error("invalid_payment_count");
  for (const item of [...value.items, ...(value.selected ? [value.selected] : [])]) {
    if (!valid(item?.id) || typeof item.title !== "string" || !item.title || typeof item.paralegalName !== "string" || typeof item.matterStatus !== "string" || typeof item.archived !== "boolean" || !money(item.matterAmount) || !["recorded", "not_recorded", "unconfirmed", "needs_review"].includes(item.funding) || !["recorded", "not_recorded", "pending", "failed", "reversed", "needs_review"].includes(item.release) || ![item.createdAt, item.updatedAt, item.fundingVerifiedAt, item.releasedAt].every(date) || item.withdrawal !== null && (!date(item.withdrawal?.at) || !money(item.withdrawal?.amount) || !["zero_auto", "partial_attorney", "full", "admin", "expired_zero", "unknown"].includes(item.withdrawal?.decision))) throw new Error("invalid_payment_record");
    if (item.earlierWithdrawals !== undefined && (!Number.isSafeInteger(item.earlierWithdrawals) || item.earlierWithdrawals < 0)) throw new Error("invalid_withdrawal_count");
    if (item.currency !== null) {
      try { if (!Intl.supportedValuesOf("currency").includes(item.currency) || new Intl.NumberFormat("en-US", { style: "currency", currency: item.currency }).resolvedOptions().maximumFractionDigits !== 2) throw new Error(); } catch { throw new Error("invalid_payment_currency"); }
    }
  }
  for (const item of value.items) { if (ids.has(item.id)) throw new Error("duplicate_payment_record"); ids.add(item.id); }
  return value;
}
export const paymentAmount = (amount, currency) => amount === null || !currency ? "Amount needs review" : new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount / 100);
export const fundingLabel = state => ({ recorded: "Funding recorded", not_recorded: "Funding not recorded", unconfirmed: "Funding needs confirmation", needs_review: "Funding needs review" })[state];
export const releaseLabel = state => ({ recorded: "Payment release recorded", not_recorded: "Payment not released", pending: "Payout pending", failed: "Payout failed", reversed: "Payout reversed", needs_review: "Payout needs review" })[state];
export function billingUrl(value, ownerId) {
  if (value?.ownerId !== ownerId || typeof value.url !== "string") throw new Error("invalid_billing_handoff");
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.hostname !== "billing.stripe.com" || url.username || url.password || url.port || url.search || url.hash || !/^\/p\/session\/[A-Za-z0-9_]+$/.test(url.pathname)) throw new Error("invalid_billing_handoff");
  return url.href;
}
