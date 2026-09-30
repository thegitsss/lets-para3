import { objectId } from "./workspace-model.mjs";
const ref = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0, money = value => value === null || count(value);
const date = value => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
const cursor = value => value === null || typeof value === "string" && /^[A-Za-z0-9_-]{1,250}$/.test(value);
const person = value => value && (value.id === null || objectId(value.id)) && typeof value.name === "string";
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function record(value) {
  if (!value || value.id !== null && !ref(value.id) || !["open", "resolved", "rejected", "unknown"].includes(value.status) || typeof value.message !== "string" || !person(value.raisedBy) || !date(value.createdAt) || !date(value.updatedAt) || !money(value.requestedAmount) || !count(value.commentCount)) throw new Error("Invalid dispute record");
  return { ...Object.fromEntries(["id", "status", "message", "createdAt", "updatedAt", "requestedAmount", "commentCount"].map(key => [key, value[key]])), raisedBy: { id: value.raisedBy.id, name: value.raisedBy.name } };
}
function comment(value) {
  if (!value || value.id !== null && !objectId(value.id) || !person(value.by) || typeof value.text !== "string" || !date(value.createdAt)) throw new Error("Invalid dispute comment");
  return { id: value.id, by: { id: value.by.id, name: value.by.name }, text: value.text, createdAt: value.createdAt };
}
export function readDisputes(value, caseId, ownerId) {
  if (!value || value.caseId !== caseId || value.ownerId !== ownerId || !objectId(caseId) || !objectId(ownerId) || typeof value.caseTitle !== "string" || !digest(value.revision) || typeof value.reason !== "string" || typeof value.canOpen !== "boolean" || value.canOpen !== (value.reason === "ready") || !count(value.total) || !Array.isArray(value.items) || value.items.length > 25 || value.items.length > value.total || !cursor(value.nextCursor) || !["automatic", "found", "unavailable"].includes(value.selection) || value.selection === "found" && !value.selected) throw new Error("Invalid dispute review");
  let selected = null;
  if (value.selected) {
    const source = value.selected; selected = record(source);
    if (!digest(source.revision) || typeof source.canComment !== "boolean" || source.canComment && !source.id || !Array.isArray(source.comments) || source.comments.length > 25 || source.comments.length > source.commentCount || !cursor(source.nextCommentCursor) || !["none", "found", "unavailable"].includes(source.commentSelection) || source.commentSelection === "found" && !source.selectedComment) throw new Error("Invalid dispute discussion");
    const decision = source.decision;
    if (decision !== null && (!decision || !["refund", "release_full", "release_partial"].includes(decision.action) || ![decision.grossCents, decision.payoutCents, decision.refundCents].every(money) || !date(decision.at))) throw new Error("Invalid administrator decision");
    selected = { ...selected, revision: source.revision, canComment: source.canComment, comments: source.comments.map(comment), nextCommentCursor: source.nextCommentCursor, selectedComment: source.selectedComment ? comment(source.selectedComment) : null, commentSelection: source.commentSelection, decision: decision ? { action: decision.action, grossCents: decision.grossCents, payoutCents: decision.payoutCents, refundCents: decision.refundCents, at: decision.at } : null };
  }
  if (value.operation !== null && (!value.operation || !["not_found", "recorded"].includes(value.operation.status) || value.operation.status === "recorded" && (!["open", "comment"].includes(value.operation.action) || !ref(value.operation.disputeId) || value.operation.commentId !== null && !objectId(value.operation.commentId)) || typeof value.operation.changedSinceSave !== "boolean")) throw new Error("Invalid dispute outcome");
  let currency = null; try { if (typeof value.currency === "string" && Intl.supportedValuesOf("currency").includes(value.currency) && new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).resolvedOptions().maximumFractionDigits === 2) currency = value.currency; } catch { /* Keep unverified amounts unavailable. */ }
  return { ownerId, caseId, caseTitle: value.caseTitle, revision: value.revision, reason: value.reason, canOpen: value.canOpen, total: value.total, items: value.items.map(record), nextCursor: value.nextCursor, selection: value.selection, selected, currency, operation: value.operation ? Object.fromEntries(["status", "action", "disputeId", "commentId", "changedSinceSave"].filter(key => Object.hasOwn(value.operation, key)).map(key => [key, value.operation[key]])) : null };
}
export const disputeStatus = value => ({ open: "Administrator review open", resolved: "Resolved", rejected: "Rejected", unknown: "Status unavailable" })[value] || "Status unavailable";
export const disputeNotice = value => ({ ready: "", funded_work_required: "Dispute review is available for funded work.", review_open: "A dispute review is already open for this Matter.", processing: "Another Matter decision is being processed. Refresh the Matter before opening a dispute.", paralegal_review_window: "The withdrawn paralegal’s review window is open. Attorney dispute requests are unavailable during that window.", withdrawal_window_ended: "The withdrawal review window has ended. A new dispute cannot be opened from this record.", withdrawal_deadline_unavailable: "The withdrawal deadline could not be verified. Ask Help to review this Matter." })[value] ?? "Dispute review is unavailable. Refresh the Matter to check its status.";
export const disputeAmount = (value, currency) => value === null || !currency ? "Amount unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value / 100);
export const disputeLink = (caseId, disputeId, commentId) => `#/matters/${caseId}/financials?${new URLSearchParams({ disputeId, ...(commentId ? { commentId } : {}) })}`;
