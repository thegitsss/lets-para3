import { receiptDate, receiptMoney } from "./receipt-model.mjs";
export const receiptSelection = value => value === "payment" || typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function entry(value) {
  if (!value || !receiptSelection(value.id) || !["payment", "withdrawal"].includes(value.type) || (value.type === "payment") !== (value.id === "payment") || value.at !== null && (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))) || value.amount !== null && (!Number.isSafeInteger(value.amount) || value.amount < 0) || typeof value.needsReview !== "boolean") throw new Error("invalid_receipt_history_entry");
  if (value.type === "payment" ? value.decision !== null || value.paralegalName !== null || value.amount !== null || value.at !== null : !["zero_auto", "partial_attorney", "full", "admin", "expired_zero", "unknown"].includes(value.decision) || typeof value.paralegalName !== "string" || !value.paralegalName) throw new Error("invalid_receipt_history_type");
  return { id: value.id, type: value.type, at: value.at, amount: value.amount, decision: value.decision, paralegalName: value.paralegalName, needsReview: value.needsReview };
}
export function readReceiptHistory(value, caseId, ownerId, selectedId) {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (value.caseId !== caseId || !/^[a-f0-9]{64}$/.test(value.revision || "") || !Number.isSafeInteger(value.total) || value.total < 1 || value.total > 4002 || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 25 || value.entries.length > value.total || value.nextCursor !== null && (typeof value.nextCursor !== "string" || !/^[1-9]\d{0,3}$/.test(value.nextCursor) || Number(value.nextCursor) >= value.total) || !["none", "found", "unavailable"].includes(value.selection) || (value.selection === "found") !== Boolean(value.selected)) throw new Error("invalid_receipt_history");
  if (value.currency !== null && (!Intl.supportedValuesOf("currency").includes(value.currency) || new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).resolvedOptions().maximumFractionDigits !== 2)) throw new Error("invalid_receipt_currency");
  if (selectedId && (value.selection === "none" || value.selected && value.selected.id !== selectedId)) throw new Error("invalid_receipt_history_selection");
  const entries = value.entries.map(entry);
  if (new Set(entries.map(value => value.id)).size !== entries.length) throw new Error("repeated_receipt_history");
  return { caseId, ownerId, revision: value.revision, total: value.total, currency: value.currency, entries, nextCursor: value.nextCursor, selected: value.selected ? entry(value.selected) : null, selection: value.selection };
}
export const receiptHistoryTitle = value => value.type === "payment" ? "Original Matter funding" : `Withdrawal decision · ${receiptDate(value.at)}`;
export const receiptHistoryDetail = (value, currency) => value.type === "payment" ? "Review the captured payment, attorney fee and any refunds." : `${value.paralegalName} · Decision amount: ${value.amount === null || currency === null ? "Not verified" : receiptMoney(value.amount, currency)}`;
