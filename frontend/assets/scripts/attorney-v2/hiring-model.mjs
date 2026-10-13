import { readCard } from "./payment-setup-model.mjs";
const reasons = new Set(["ready", "withdrawal_review_required", "reconciliation", "processing", "assigned", "other_assigned", "matter_unavailable", "blocked", "profile_unavailable", "application_unavailable", "scope_required", "amount_unavailable", "pre_engagement_required", "payout_setup_required", "card_required"]);
const validMoney = value => value === null || Number.isSafeInteger(value) && value >= 0;
export function readHiringReview(value, caseId, ownerId, applicantId) {
  if (value?.caseId !== caseId || value.ownerId !== ownerId || value.applicantId !== applicantId || !/^[a-f0-9]{64}$/.test(value.revision || "") || typeof value.caseTitle !== "string" || typeof value.name !== "string" || !reasons.has(value.reason) || ["canHire", "canResume", "relisted", "fundingVerified", "assigned"].some(key => typeof value[key] !== "boolean") || ["budgetCents", "feeCents", "chargeCents", "remainingCents"].some(key => !validMoney(value[key])) || !/^[a-z]{3}$/.test(value.currency || "")) throw new Error("invalid_hiring_review");
  const card = value.card === null ? null : readCard(value.card);
  if (value.canHire !== (value.reason === "ready") || value.canResume && (value.reason !== "reconciliation" || !value.fundingVerified || value.relisted || value.assigned) || value.canHire && value.canResume || (value.canHire || value.canResume) && (!value.relisted && value.budgetCents < 40000 || !(value.budgetCents > 0) || value.chargeCents === null || value.feeCents === null) || value.canHire && (value.relisted ? value.chargeCents !== 0 || !value.fundingVerified || !(value.remainingCents > 0) || card !== null : !card || value.chargeCents !== value.budgetCents + value.feeCents) || value.canResume && value.chargeCents !== value.budgetCents + value.feeCents) throw new Error("invalid_hiring_action");
  return { ...value, card };
}
export function hiringMoney(value, amount) {
  return amount === null ? "Amount unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency.toUpperCase() }).format(amount / 100);
}
export function confirmHiring(result, review) {
  const value = result?.hiringConfirmation, mode = review.canResume ? "finish_hire" : review.relisted ? "replacement" : "hire_and_fund";
  if (!value || value.caseId !== review.caseId || value.applicantId !== review.applicantId || value.reviewedRevision !== review.revision || value.mode !== mode || value.chargeCents !== (review.canResume ? 0 : review.chargeCents) || value.budgetCents !== review.budgetCents || value.remainingCents !== review.remainingCents) throw new Error("unconfirmed_hire");
}
export function hiringReason(value) {
  if (value.canResume) return "The earlier charge is verified. You can review and finish recording this hire without another charge.";
  return ({ ready: "", withdrawal_review_required: "The earlier withdrawal or payout needs review before you can hire a replacement.", reconciliation: "Funding needs review before another hiring attempt. Check again for an updated record or contact Help with this Matter.", processing: "A hiring request is still in progress. Check the saved hiring details before continuing.", assigned: value.fundingVerified ? "This paralegal is assigned, and the Matter's funding is verified." : "This paralegal is assigned. The Matter's funding could not be verified for this review.", other_assigned: "Another paralegal is assigned to this Matter.", matter_unavailable: "The Matter does not currently permit hiring. Review its status and any dispute or withdrawal notices.", blocked: "Hiring is unavailable because interaction between these accounts is blocked.", profile_unavailable: "This paralegal's account is not currently available for hiring.", application_unavailable: "This application no longer permits hiring, or its saved status needs review.", scope_required: "Add the Matter's scope tasks before hiring.", amount_unavailable: "The Matter amount needs review before hiring can continue.", pre_engagement_required: "Review and approve this applicant's pre-engagement requirements before hiring.", payout_setup_required: "The paralegal must complete payout setup before hiring can continue.", card_required: "Save a payment card before reviewing the hiring charge." })[value.reason];
}
export function hiringError(error) {
  if (error?.kind === "authentication" || error?.code === "HIRING_ACCOUNT_CHANGED") return "Your account changed. Sign in again before reviewing hiring.";
  if (error?.code === "HIRING_WITHDRAWAL_REVIEW_REQUIRED") return "The earlier withdrawal or payout changed. Refresh the hiring review before continuing.";
  if (error?.code === "HIRING_CARD_NOT_CHARGED") return "The provider confirmed that the card charge did not complete. Check the saved card and refresh this review before another attempt.";
  if (["HIRING_CHARGE_UNCONFIRMED", "HIRING_RECONCILIATION", "HIRE_RECONCILIATION_REQUIRED"].includes(error?.code)) return "The charge or hire needs verification. Check the saved hiring details before taking another action.";
  return "The hiring result could not be confirmed. Check the saved hiring details before continuing.";
}
