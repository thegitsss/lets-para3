import { safeMatterReturn } from "./matter-return.mjs";
import { applicationFilters, applicationQuery } from "./application-inventory-model.mjs";
import { invitationFilters, invitationQuery } from "./invitation-model.mjs";
export const MATTER_TABS = Object.freeze(["overview", "applications", "work", "files", "messages", "deadlines", "activity", "financials"]);
export const objectId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value) ? value : null;
export const text = value => typeof value === "string" ? value : "";
const id = value => objectId(value?._id || value?.id || value);
export function readMatter(value, caseId) {
  const experience = value?.matterExperience;
  if (id(value) !== caseId || !text(value.title) || !text(value.status) || experience?.version !== 1 || experience.header?.relationship !== "Matter owner" || !Array.isArray(experience.sections) || !Array.isArray(value.tasks) || !experience.overview || !experience.work || !Array.isArray(experience.activity)) throw new Error("invalid_matter");
  if (value.tasks.some(task => !task || !text(task.title) || typeof task.completed !== "boolean")) throw new Error("invalid_work");
  const available = new Set(experience.sections.map(section => section.id));
  if (MATTER_TABS.some(tab => !available.has(tab))) throw new Error("invalid_matter_sections");
  if (value.id !== undefined && value.id !== caseId) throw new Error("invalid_matter_identity");
  return value.id === caseId ? value : { ...value, id: caseId };
}
// A confirmed decision advances its own status/star and the exact derived
// pending-count prompt. Independent changes still stay in the reviewed snapshot.
export function acknowledgeApplicationDecision(before, after, receipt) {
  const applicantId = objectId(receipt?.applicantId)?.toLowerCase();
  const sameId = value => id(value)?.toLowerCase() === applicantId;
  const status = value => value === "pending" ? "submitted" : value;
  const one = (items, matches) => Array.isArray(items) && items.filter(matches).length === 1 ? items.find(matches) : null;
  const matches = item => sameId(item?.paralegalId);
  const prior = one(before?.applicants, matches), next = one(after?.applicants, matches);
  const priorExperience = one(before?.matterExperience?.applications?.items, item => sameId(item?.id));
  const nextExperience = one(after?.matterExperience?.applications?.items, item => sameId(item?.id));
  // Earlier Case entries have no canonical application ID and group submitted,
  // viewed and shortlisted applications under the same pending status.
  const earlier = prior && next && !prior.applicationId && !next.applicationId;
  const matchesStatus = value => status(value) === receipt.status || earlier && value === "pending" && ["submitted", "viewed", "shortlisted"].includes(receipt.status);
  const receiptId = objectId(receipt?.applicationId)?.toLowerCase();
  if (!applicantId || !prior || !next || !priorExperience || !nextExperience || before.id !== after.id ||
      !["star", "unstar", "shortlist", "return", "reject"].includes(receipt.action) ||
      (receipt.applicationId && !receiptId) || (!earlier && (!receiptId || id(next.applicationId)?.toLowerCase() !== receiptId)) ||
      !matchesStatus(next.status) || !matchesStatus(nextExperience.status) || next.starred !== receipt.starred) return before;
  const acknowledged = { ...before,
    applicants: before.applicants.map(item => item === prior ? { ...item, status: next.status, starred: next.starred } : item),
    matterExperience: { ...before.matterExperience, applications: { ...before.matterExperience.applications,
      items: before.matterExperience.applications.items.map(item => item === priorExperience ? { ...item, status: nextExperience.status } : item),
    } },
  };
  const beforeCount = before.matterExperience.applications.pendingCount;
  const afterCount = after.matterExperience.applications.pendingCount;
  const pending = value => ["pending", "submitted", "viewed", "shortlisted"].includes(value);
  const delta = Number(pending(next.status)) - Number(pending(prior.status));
  if (Number.isSafeInteger(beforeCount) && beforeCount >= 0 && afterCount === beforeCount + delta && afterCount >= 0) {
    acknowledged.matterExperience.applications.pendingCount = afterCount;
    const reviewAction = count => ({ code: "review_applications", label: "Review applications", detail: `${count} application${count === 1 ? "" : "s"} ready for review`, tab: "applications" });
    const priorHeader = before.matterExperience.header, nextHeader = after.matterExperience.header;
    const expectedAction = afterCount ? reviewAction(afterCount) : { code: "view_posting", label: "View posting", tab: "overview" };
    // No whole-header replacement: title, status, deadline, assignment and
    // any unrelated action/attention change still require a fresh review.
    if (beforeCount > 0 && priorHeader?.attention === "Applications available" &&
        JSON.stringify(priorHeader.primaryAction) === JSON.stringify(reviewAction(beforeCount)) &&
        nextHeader?.attention === (afterCount ? "Applications available" : null) &&
        JSON.stringify(nextHeader.primaryAction) === JSON.stringify(expectedAction)) {
      acknowledged.matterExperience.header = { ...priorHeader, attention: nextHeader.attention, primaryAction: expectedAction };
    }
  }
  return acknowledged;
}
export function matterLink(caseId, tab = "overview", query = new URLSearchParams()) {
  if (!objectId(caseId) || !MATTER_TABS.includes(tab)) return null;
  const output = new URLSearchParams();
  for (const key of ["applicantId", "applicationId", "fileId", "messageId", "taskId", "eventId"]) if (objectId(query.get(key)) && !(key === "eventId" && tab === "activity")) output.set(key, query.get(key));
  try { for (const [key, value] of applicationQuery(applicationFilters(query))) output.set(key, value); }
  catch { /* An invalid filter cannot become a carried review instruction. */ }
  try { for (const [key, value] of invitationQuery(invitationFilters(query))) output.set(key, value); }
  catch { /* Keep only valid history filters when changing Matter sections. */ }
  const returnTo = safeMatterReturn(query.get("returnTo"));
  if (returnTo) output.set("returnTo", returnTo);
  return `#/matters/${caseId}/${tab}${output.size ? `?${output}` : ""}`;
}
export const dateLabel = value => {
  if (!value) return "Not recorded";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value), parsed = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) }) : "Date unavailable";
};
export const timeLabel = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Date unavailable";
export function matterNotice(value) {
  if (value.archived) return "This Matter is archived. Retained records and available downloads remain below.";
  if (value.status === "disputed" || value.termination?.status === "disputed") return "This Matter is under review by LPC. Work and payment actions may be restricted while the dispute is reviewed.";
  if (value.status === "paused" && value.pausedReason === "paralegal_withdrew") return "The paralegal withdrew from this Matter. Review the work and withdrawal decision in Financials.";
  if (value.status === "paused") return "This Matter is paused. Review its activity and financial records before continuing.";
  if (value.readOnly || ["completed", "closed", "cancelled", "canceled", "expired"].includes(value.status)) return "This Matter is closed to further work. Retained records and available downloads remain below.";
  return "";
}
export function readMessages(value, caseId) {
  const entries = Array.isArray(value) ? value : value?.messages;
  if (!Array.isArray(entries)) throw new Error("invalid_messages");
  const seen = new Set();
  return entries.map(entry => {
    const key = id(entry);
    if (!key || id(entry.caseId || entry.case) !== caseId || seen.has(key) || !["text", "file", "audio", "system"].includes(entry.type || "text")) throw new Error("invalid_message");
    seen.add(key);
    const sender = entry.senderId || entry.sender;
    return { id: key, type: entry.type || "text", senderId: id(sender), sender: [text(sender?.firstName), text(sender?.lastName)].filter(Boolean).join(" ") || (entry.senderRole === "system" ? "LPC" : "Name unavailable"), text: text(entry.text) || text(entry.content?.text) || text(entry.content), transcript: text(entry.transcript) || text(entry.content?.transcript), filename: text(entry.fileName), createdAt: entry.createdAt, replyTo: id(entry.replyTo), deleted: entry.deleted === true, pinned: entry.pinned === true };
  }).filter(entry => !entry.deleted);
}
