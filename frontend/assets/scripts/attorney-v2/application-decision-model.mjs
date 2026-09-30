import { applicationError } from "./application-model.mjs";
export const decisionLabels = Object.freeze({ star: "Star application", unstar: "Remove star", shortlist: "Shortlist application", return: "Return to submitted", reject: "Reject application" });
const reasons = { ready: "", matter_closed: "This Matter is not accepting application decisions in its current state.", hiring_started: "Hiring has started for this Matter. Application decisions are closed.", application_closed: "This application's recorded status does not allow further decisions here.", profile_unavailable: "This paralegal's account is unavailable for further application decisions.", blocked: "Further interaction with this paralegal is blocked. Application history remains available.", records_differ: "The application and Matter records need verification before another decision can be recorded." };
const statuses = ["submitted", "viewed", "shortlisted", "accepted", "rejected", "withdrawn", "unknown"];
const validRevision = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const invalid = () => { throw new Error("invalid_application_decision"); };
export function readDecision(value, caseId, ownerId, item) {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (value.caseId !== caseId || value.applicantId !== item.applicantId || value.applicationId !== item.applicationId || typeof value.caseTitle !== "string" || typeof value.name !== "string" || !validRevision(value.revision) || !statuses.includes(value.status) || typeof value.starred !== "boolean" || !Object.hasOwn(reasons, value.reason) || !Array.isArray(value.actions)) invalid();
  const expected = value.reason === "ready" ? [value.starred ? "unstar" : "star", ...(item.applicationId ? [value.status === "shortlisted" ? "return" : "shortlist"] : []), "reject"] : [];
  if (JSON.stringify(value.actions) !== JSON.stringify(expected) || value.reason === "ready" && !["submitted", "viewed", "shortlisted"].includes(value.status)) invalid();
  return { caseTitle: value.caseTitle, name: value.name, revision: value.revision, status: value.status, starred: value.starred, reason: value.reason, actions: [...value.actions] };
}
export function readDecisionResult(value, caseId, ownerId, item, sent) {
  if (!value || !Object.hasOwn(value, "receipt")) invalid();
  if (value.receipt === null) return null;
  const record = value.receipt;
  if (record.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (record.caseId !== caseId || record.applicantId !== item.applicantId || record.applicationId !== sent.applicationId || record.requestId !== sent.requestId || record.revision !== sent.revision || record.action !== sent.action || !statuses.includes(record.status) || typeof record.starred !== "boolean" || typeof record.recordedAt !== "string" || !Number.isFinite(Date.parse(record.recordedAt))) invalid();
  const expectedStatus = { shortlist: "shortlisted", return: "submitted", reject: "rejected" }[sent.action] || sent.status;
  if (record.status !== expectedStatus || record.starred !== (sent.action === "star" ? true : sent.action === "unstar" ? false : sent.starred)) invalid();
  return { action: record.action, status: record.status, starred: record.starred, recordedAt: record.recordedAt };
}
export const decisionReason = value => reasons[value] || "";
export const decisionSaved = action => ({ star: "Application starred.", unstar: "Application star removed.", shortlist: "Application shortlisted.", return: "Application returned to submitted status.", reject: "Application rejected." })[action];
export function decisionEffect(action) {
  return ({ star: "This adds a star to the application.", unstar: "This removes your star from the application.", shortlist: "This records the application as shortlisted. It does not hire the paralegal or fund the Matter.", return: "This removes the application from the shortlist and records its status as Submitted.", reject: "This rejects the application and removes it from consideration for this Matter. Its application history remains available." })[action];
}
export function decisionError(error) {
  if (error.kind === "authentication" || error.kind === "authorization" || [401, 403, 404].includes(error.status)) return applicationError(error);
  if (error.code === "APPLICATION_REVIEW_DECISION_CHANGED" || error.code === "APPLICATION_REVIEW_DECISION_INELIGIBLE") return "The application or Matter changed. Refresh the applications before making another decision.";
  return "The application decision could not be checked. Refresh the applications to try again.";
}
