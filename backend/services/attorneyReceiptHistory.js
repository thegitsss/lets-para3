const { fingerprint } = require("./matterDraftRevision");
const ref = value => String(value?._id || value || ""), date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const decisions = new Set(["zero_auto", "partial_attorney", "full", "admin", "expired_zero"]);
const fields = ["withdrawnParalegalId", "payoutFinalizedAt", "payoutFinalizedType", "partialPayoutAmount", "payoutTransferId", "pausedAt"];
const fail = (status, code) => { throw Object.assign(new Error("Receipt history could not be verified. Refresh the receipts before continuing."), { status, publicCode: code }); };
const validSelection = value => value === "payment" || typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(409, "RECEIPT_HISTORY_INVALID");
  return Object.fromEntries(fields.map(field => [field, value[field] ?? null]));
}
function inventory(doc) {
  if (doc.withdrawalHistory != null && !Array.isArray(doc.withdrawalHistory)) fail(409, "RECEIPT_HISTORY_INVALID");
  if ((doc.withdrawalHistory || []).length > 4000) fail(413, "RECEIPT_HISTORY_TOO_LARGE");
  const entries = new Map();
  const add = (source, historical) => {
    const value = record(source), id = fingerprint([ref(doc._id), "withdrawal", ref(value.withdrawnParalegalId), date(value.payoutFinalizedAt) || value.payoutFinalizedAt]);
    const previous = entries.get(id), name = historical && typeof source.paralegalNameSnapshot === "string" ? source.paralegalNameSnapshot.trim() : "";
    if (previous) { if (fingerprint(previous.record) !== fingerprint(value)) previous.conflict = true; return; }
    entries.set(id, { id, type: "withdrawal", record: value, historical, name, conflict: false });
  };
  for (const previous of doc.withdrawalHistory || []) add(previous, true);
  if (doc.withdrawnParalegalId || doc.payoutFinalizedAt || doc.payoutFinalizedType) add(doc, false);
  const withdrawals = [...entries.values()].sort((a, b) => (date(b.record.payoutFinalizedAt) || "").localeCompare(date(a.record.payoutFinalizedAt) || "") || a.id.localeCompare(b.id));
  return [{ id: "payment", type: "payment", record: null, conflict: false, name: "" }, ...withdrawals];
}
function present(entry, names) {
  const value = entry.record;
  return { id: entry.id, type: entry.type, at: value ? date(value.payoutFinalizedAt) : null, decision: value ? decisions.has(value.payoutFinalizedType) ? value.payoutFinalizedType : "unknown" : null, amount: value && Number.isSafeInteger(value.partialPayoutAmount) && value.partialPayoutAmount >= 0 ? value.partialPayoutAmount : null, paralegalName: value ? names.get(ref(value.withdrawnParalegalId)) || entry.name || "Paralegal name not recorded" : null, needsReview: entry.conflict };
}
module.exports = { inventory, present, validSelection, decisions, fail };
