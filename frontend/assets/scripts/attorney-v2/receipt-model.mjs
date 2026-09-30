const text = (value, max = 2000) => typeof value === "string" && value.length > 0 && value.length <= max;
const amount = value => Number.isSafeInteger(value) && value >= 0;
export const receiptStatuses = Object.freeze({ received: "Payment confirmed", refunded: "Refund processed", partially_refunded: "Partial refund processed", refund_pending: "Refund pending", refund_failed: "Payment confirmed; refund attempt failed", payout_recorded: "Payout recorded", no_payout: "No payout" });
export function readReceipt(value, caseId, ownerId, selectedId) {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (selectedId && value.selectionId !== selectedId) throw new Error("invalid_receipt_selection");
  if (value.caseId !== caseId || !text(value.caseTitle) || !["available", "not_funded", "payment_pending", "payment_failed", "payment_canceled", "needs_review", "payout_unconfirmed"].includes(value.reason)) throw new Error("invalid_receipt");
  if (value.reason !== "available") { if (value.receipt !== null || value.revision !== null) throw new Error("invalid_receipt_availability"); return value; }
  const r = value.receipt;
  if (!/^[a-f0-9]{64}$/.test(value.revision || "") || !r || !["payment", "withdrawal"].includes(r.type) || !text(r.id, 255) || !/^[A-Z]{3}$/.test(r.currency) || !text(r.partyName) || !(r.status === "no_payout" && r.method === null) && !text(r.method, 250) || !text(r.filename, 160) || /[\u0000-\u001f\u007f/\\]/.test(r.filename) || !r.filename.endsWith(".pdf") || !Object.hasOwn(receiptStatuses, r.status) || !["Payment date", "Payout date", "Payout recorded", "Withdrawal decision date"].includes(r.dateLabel) || r.issuedAt !== null && (!text(r.issuedAt, 40) || !Number.isFinite(new Date(r.issuedAt).getTime())) || !Array.isArray(r.lines) || r.status !== "no_payout" && r.lines.length < 1 || r.lines.length > 6 || r.lines.some(line => !text(line?.label, 100) || !amount(line.amount)) || !text(r.total?.label, 100) || !amount(r.total.amount)) throw new Error("invalid_receipt_details");
  if (r.status === "no_payout" && (r.total.amount !== 0 || r.lines.some(line => line.amount !== 0)) || r.stripeMode != null && !["test", "live"].includes(r.stripeMode)) throw new Error("invalid_receipt_state");
  if ((r.type === "withdrawal") !== ["payout_recorded", "no_payout"].includes(r.status)) throw new Error("invalid_receipt_type");
  if (!Intl.supportedValuesOf("currency").includes(r.currency) || new Intl.NumberFormat("en-US", { style: "currency", currency: r.currency }).resolvedOptions().maximumFractionDigits !== 2) throw new Error("invalid_receipt_currency");
  return value;
}
export const receiptReason = reason => ({ not_funded: "No payment has been confirmed for this Matter.", payment_pending: "A receipt will be available once payment is confirmed.", payment_failed: "The payment was not completed. Review the payment in Payments before trying again.", payment_canceled: "This payment was canceled. No payment receipt is available.", needs_review: "The payment details need review before a receipt can be issued.", payout_unconfirmed: "The withdrawal payout is not confirmed. A receipt can be issued after the payout is recorded." })[reason];
export const receiptMoney = (value, currency) => new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value / 100);
export const receiptDate = value => value ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Date unavailable";
