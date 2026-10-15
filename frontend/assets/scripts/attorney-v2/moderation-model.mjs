export function readModeration(value, caseId, ownerId) {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (value.caseId !== caseId || typeof value.caseTitle !== "string" || !["none", "flagged", "resolution_requested", "unavailable"].includes(value.status) || !/^[a-f0-9]{64}$/.test(value.revision || "") || typeof value.canRequestReview !== "boolean" || typeof value.feedback !== "string" || !["ready", "archived", "read_only", "no_request", "awaiting_review", "edit_required", "legacy_edit_required", "unavailable"].includes(value.reason)) throw new Error("invalid_review");
  if (value.canRequestReview !== (value.reason === "ready") || (value.canRequestReview && value.status !== "flagged")) throw new Error("invalid_review");
  if ([value.flaggedAt, value.requestedAt, value.receipt?.requestedAt].some(date => date != null && !Number.isFinite(new Date(date).getTime()))) throw new Error("invalid_review_date");
  if (value.receipt && (!/^[a-f0-9-]{36}$/i.test(value.receipt.requestId || "") || !/^[a-f0-9]{64}$/.test(value.receipt.revision || ""))) throw new Error("invalid_receipt");
  return value;
}
export const confirmsReview = (value, sent) => Boolean(sent && value?.receipt?.requestId === sent.requestId && value.receipt.revision === sent.revision);
export const reasonText = value => ({
  ready: "The posting has changed since the admin edit request. Review the feedback and your saved posting before requesting another review.",
  edit_required: "Edit the public posting to address the admin feedback before requesting review. Notes and other Matter activity do not count as posting edits.",
  legacy_edit_required: "This older request has no saved posting comparison. Make a posting edit in the current editor, then check the request again before submitting it for review.",
  awaiting_review: "Your request is awaiting admin review. The flag remains until an admin clears it.",
  no_request: "There is no active admin edit request on this Matter.",
  archived: "Review requests cannot be submitted while this Matter is archived.",
  read_only: "This Matter is read-only. Review requests are unavailable.",
  unavailable: "This Matter's review status is unavailable. Check again before continuing.",
})[value.reason];
