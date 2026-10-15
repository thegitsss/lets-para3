import { candidateHref } from "./candidate-model.mjs";
const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const validDate = value => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
const validCursor = value => typeof value === "string" && /^(?:a:[a-f0-9]{24}|m:(?:0|[1-9]\d{0,3}))?$/i.test(value);
function recordedLinkedIn(value) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 500 || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) ? url.href : null;
  } catch { return null; }
}
const statuses = { submitted: "Submitted", viewed: "Viewed", shortlisted: "Shortlisted", accepted: "Accepted application", rejected: "Rejected", withdrawn: "Withdrawn by paralegal", unknown: "Status unavailable" };
export const applicationStatus = value => statuses[value] || statuses.unknown;
const warningText = {
  posting_missing: "The posting linked to this Matter is unavailable. Applications recorded only on that posting may be missing from this list.",
  unreadable_records: "Some application records could not be read. This list may be incomplete.",
  earlier_record: "This application is retained in the Matter's earlier records. A separate application record was not found.",
  sync_pending: "This application has an update awaiting verification. Check its recorded status before making a decision.",
  matter_entry_missing: "This application is missing from the Matter's applicant list. Its records need verification.",
  records_differ: "The application and the Matter's applicant entry differ. The application shown here is the submitted record. Verify the disagreement before making a decision.",
};
export const applicationWarning = value => warningText[value];
const fail = () => { throw new Error("invalid_applications"); };
const warnings = value => { if (!Array.isArray(value) || value.some(key => !Object.hasOwn(warningText, key))) fail(); return [...new Set(value)]; };
function readProfile(value) {
  if (value === null) return null;
  if (!value || ["location", "availability", "bio"].some(key => typeof value[key] !== "string") || (value.yearsExperience !== null && (!Number.isFinite(value.yearsExperience) || value.yearsExperience < 0)) || ["languages", "specialties"].some(key => !Array.isArray(value[key]) || value[key].some(item => typeof item !== "string"))) fail();
  return { location: value.location, availability: value.availability, bio: value.bio, yearsExperience: value.yearsExperience, languages: [...value.languages], specialties: [...value.specialties] };
}
export function readApplications(value, caseId, ownerId, cursor = "", applicantId = "") {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("account_changed"), { kind: "authentication" });
  if (value?.caseId !== caseId || typeof value.caseTitle !== "string" || typeof value.caseStatus !== "string" || typeof value.archived !== "boolean" || value.cursor !== cursor || !validCursor(cursor) || value.selectedApplicantId !== (applicantId || null) || (value.next !== null && (!validCursor(value.next) || !value.next || value.next === cursor)) || (applicantId && value.next !== null) || !Array.isArray(value.applications) || value.applications.length > 25) fail();
  const seen = new Set();
  const applications = value.applications.map(item => {
    if (!validId(item?.applicantId) || (applicantId && item.applicantId !== applicantId) || seen.has(item.applicantId) || (item.applicationId !== null && !validId(item.applicationId)) || typeof item.name !== "string" || typeof item.coverLetter !== "string" || !Object.hasOwn(statuses, item.status) || (item.matterStatus !== null && !Object.hasOwn(statuses, item.matterStatus)) || !validDate(item.appliedAt) || !validDate(item.withdrawnAt) || ["profileAvailable", "blocked", "assigned", "starred", "resumeRecorded", "linkedInRecorded"].some(key => typeof item[key] !== "boolean") || !Array.isArray(item.history) || item.history.length > 50 || !Array.isArray(item.invitations)) fail();
    seen.add(item.applicantId);
    const history = item.history.map(entry => { if (!entry || !Object.hasOwn(statuses, entry.from) || !Object.hasOwn(statuses, entry.to) || !validDate(entry.at)) fail(); return { from: entry.from, to: entry.to, at: entry.at }; });
    const invitations = item.invitations.map(entry => { if (!entry || !["pending", "accepted", "declined", "expired", "unknown"].includes(entry.status) || !validDate(entry.invitedAt) || !validDate(entry.respondedAt)) fail(); return { status: entry.status, invitedAt: entry.invitedAt, respondedAt: entry.respondedAt }; });
    return { applicationId: item.applicationId, applicantId: item.applicantId, name: item.name || "Paralegal applicant", coverLetter: item.coverLetter, profileAvailable: item.profileAvailable && !item.blocked, blocked: item.blocked, assigned: item.assigned, starred: item.starred, resumeRecorded: item.resumeRecorded, linkedInRecorded: item.linkedInRecorded, linkedInReference: item.linkedInRecorded ? recordedLinkedIn(item.linkedInReference) : null, status: item.status, matterStatus: item.matterStatus, appliedAt: item.appliedAt, withdrawnAt: item.withdrawnAt, profileSnapshot: readProfile(item.profileSnapshot), history, invitations, warnings: warnings(item.warnings) };
  });
  return { caseId, ownerId, caseTitle: value.caseTitle, caseStatus: value.caseStatus, archived: value.archived, selectedApplicantId: applicantId || null, cursor, next: value.next, warnings: warnings(value.warnings), applications };
}
export function applicationProfileHref(item, caseId, current = false, returnContext = "") {
  if (!item.profileAvailable || !validId(item.applicantId) || !validId(caseId)) return null;
  const returnTo = current ? `/dashboard-attorney.html?${new URLSearchParams({ caseId, applicantId: item.applicantId, openApplicant: "1", applicationHistory: "1" })}#cases:inquiries` : returnContext || `#/matters/${caseId}/applications?applicantId=${item.applicantId}`;
  const query = new URLSearchParams({ caseId, applicantId: item.applicantId, returnTo, ...(item.applicationId ? { applicationId: item.applicationId } : {}) });
  if (current) { query.set("paralegalId", item.applicantId); return `/profile-paralegal.html?${query}`; }
  return candidateHref(item.applicantId, query);
}
export function applicationError(error) {
  if (error.kind === "authentication" || error.kind === "authorization" || error.status === 404) return "These applications are no longer available to your account.";
  if (error.code === "APPLICATION_REVIEW_SOURCE_INVALID") return "The Matter and application records need verification. Contact support before making an application decision.";
  if (error.code === "APPLICATION_REVIEW_CHANGED") return "The applications changed during this read. Refresh to review the current records.";
  if (error.code === "APPLICATION_REVIEW_TOO_LARGE") return "This Matter has too many earlier application records to review here. Contact support for help reviewing them.";
  return "Applications couldn’t load. Refresh to try again.";
}
