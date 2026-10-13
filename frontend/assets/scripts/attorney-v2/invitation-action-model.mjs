const id = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const date = value => value === null || typeof value === "string" && Number.isFinite(new Date(value).getTime());
const reasons = ["ready", "blocked", "profile_unavailable", "payout_setup", "records_unavailable", "pending", "accepted", "matter_unavailable", "amount_unavailable"];
export function readInvitationOptions(value, ownerId, paralegalId, cursor = "") {
  if (!value || value.ownerId !== ownerId || value.paralegalId !== paralegalId || value.cursor !== cursor || !(value.next === null || id(value.next) && value.next !== cursor) || !Array.isArray(value.matters) || value.matters.length > 25 || value.matters.some(item => !id(item.caseId) || typeof item.title !== "string") || new Set(value.matters.map(item => item.caseId)).size !== value.matters.length) throw new Error("invalid_invitation_options");
  return { cursor, next: value.next, matters: value.matters.map(item => ({ caseId: item.caseId, title: item.title })) };
}
export function readInvitationReview(value, caseId, ownerId, paralegalId) {
  if (!value || value.caseId !== caseId || value.ownerId !== ownerId || value.paralegalId !== paralegalId || !id(caseId) || !id(ownerId) || !id(paralegalId) || typeof value.caseTitle !== "string" || typeof value.name !== "string" || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || !reasons.includes(value.reason) || typeof value.canInvite !== "boolean" || value.canInvite !== (value.reason === "ready") || !(value.amountCents === null || Number.isSafeInteger(value.amountCents) && value.amountCents >= 0) || !(value.currency === null || typeof value.currency === "string" && /^[a-z]{3}$/.test(value.currency)) || typeof value.amountLocked !== "boolean" || value.canInvite && (value.amountCents === null || !value.currency)) throw new Error("invalid_invitation_review");
  if (typeof value.relisted !== "boolean" || !(value.remainingCents === null || Number.isSafeInteger(value.remainingCents) && value.remainingCents >= 0) || value.canInvite && value.relisted && !(value.remainingCents > 0)) throw new Error("invalid_replacement_amount");
  if (value.invitation !== null && (!value.invitation || !["pending", "accepted", "declined", "expired", "unknown"].includes(value.invitation.status) || !date(value.invitation.invitedAt) || !date(value.invitation.respondedAt))) throw new Error("invalid_invitation_record");
  if (value.canInvite && value.invitation && !["declined", "expired"].includes(value.invitation.status)) throw new Error("invalid_invitation_action");
  return Object.fromEntries(["caseId", "ownerId", "paralegalId", "caseTitle", "name", "revision", "reason", "canInvite", "amountCents", "currency", "amountLocked", "invitation", "relisted", "remainingCents"].map(key => [key, value[key]]));
}
export function confirmInvitation(value, review) {
  const record = value?.invitationConfirmation;
  if (!record || record.paralegalId !== review.paralegalId || record.reviewedRevision !== review.revision || record.amountCents !== review.amountCents || !record.invitedAt || !date(record.invitedAt)) throw new Error("unconfirmed_invitation");
  return record;
}
export function invitationAmount(value) {
  if (value.amountCents === null || !value.currency) return "Amount unavailable";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency.toUpperCase() }).format(value.amountCents / 100);
}
export const invitationReason = reason => ({ blocked: "Further interaction with this paralegal is blocked.", profile_unavailable: "This paralegal's account is unavailable for invitations.", payout_setup: "The paralegal must finish their payout setup before an invitation can be sent.", records_unavailable: "The invitation records need verification before another invitation can be sent.", pending: "An invitation is already awaiting this paralegal's response.", accepted: "This paralegal accepted the invitation. Review the application to continue hiring.", matter_unavailable: "This Matter does not currently permit invitations. Review its assignment and status.", amount_unavailable: "The Matter amount could not be verified. Review the posting before inviting a paralegal." })[reason] || "";
export function invitationActionError(error) {
  if (error.kind === "authentication") return "Your account could not be verified. Sign in again before reviewing the invitation.";
  if ([403, 404].includes(error.status)) return "This Matter or paralegal is no longer available for an invitation from your account.";
  if (error.status === 409) return "The Matter or invitation changed. Check its saved status before continuing.";
  return "The invitation could not be confirmed. Check its saved status before sending another invitation.";
}
