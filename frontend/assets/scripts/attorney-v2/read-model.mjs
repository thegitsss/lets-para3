import "../utils/business-date.js";
import { matterLink } from "./workspace-model.mjs";

export const dates = globalThis.LPCBusinessDate;
export const PAGE_SIZE = 15;
export const SOURCES = Object.freeze({
  dashboard: "/api/attorney/dashboard",
  active: "/api/cases/my?withFiles=true&limit=100&archived=false",
  archived: "/api/cases/my?archived=true&withFiles=true&limit=100",
  drafts: "/api/case-drafts?limit=200",
  applications: "/api/applications/my-postings",
  profile: "/api/users/me",
  payment: "/api/payments/payment-method/default",
  payments: "/api/payments/summary",
  overdue: "/api/checklist?overdue=true&limit=1",
  unread: "/api/messages/unread-count",
  messageSummary: "/api/messages/summary",
  threads: "/api/messages/threads?limit=100",
  saved: "/api/account/dashboard-views?scope=attorney_matters",
});

export function array(value) {
  if (!Array.isArray(value)) throw new TypeError("Invalid list response");
  return value;
}
export function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid count response");
  return value;
}
export function id(item) { return String(item?.id || item?._id || item?.caseId || ""); }
export function validId(value) { return /^[a-f0-9]{24}$/i.test(String(value || "")); }
export function person(item) {
  return item && typeof item === "object" ? item.name || [item.firstName, item.lastName].filter(Boolean).join(" ") : "";
}
export function statusKey(value) {
  const key = String(value || "").trim().toLowerCase();
  if (["in_progress", "active", "awaiting_documents", "reviewing"].includes(key)) return "in progress";
  if (["cancelled", "canceled"].includes(key)) return "closed";
  if (["assigned", "awaiting_funding"].includes(key)) return "open";
  return key;
}
export function statusLabel(item, now = Date.now()) {
  const key = statusKey(item.status);
  if (item.localDraft) return "Draft";
  if (key === "paused" && item.pausedReason === "paralegal_withdrew" && !item.payoutFinalizedAt && new Date(item.disputeDeadlineAt).getTime() > now) return "24 Hour Hold";
  if (item.archived && !["completed", "closed", "paused", "disputed"].includes(key)) return "Archived";
  return ({ open: "Posted", "in progress": "In Progress", completed: "Completed", disputed: "Disputed", archived: "Archived", closed: "Closed", paused: "Paused", draft: "Draft" })[key] || (key ? `Status: ${key.replaceAll("_", " ")}` : "Status unavailable");
}
export function archived(item) {
  if (item.localDraft) return false;
  if (item.__av2ArchiveBucket === true) return true;
  if (item.archived || item.paymentReleased || ["completed", "closed"].includes(statusKey(item.status))) return true;
  if (statusKey(item.status) !== "paused") return false;
  return !(item.relistRequestedAt || (item.payoutFinalizedAt && ["zero_auto", "partial_attorney", "expired_zero", "admin"].includes(item.payoutFinalizedType)));
}
export function applicantCount(item) {
  const value = item.applicantsCount ?? (Array.isArray(item.applicants) ? item.applicants.length : item.applicants);
  return value == null ? null : count(value);
}
export function bucket(item) {
  if (item.localDraft) return "draft";
  if (archived(item)) return "archived";
  if (!item.paralegal && (applicantCount(item) || 0) > 0) return "applications";
  return statusKey(item.status) === "draft" ? "draft" : "active";
}
export function workspaceEligible(item) {
  return item.archived === false && item.paymentReleased === false && statusKey(item.status) === "in progress" && Boolean(item.escrowIntentId) && item.escrowStatus === "funded" && Boolean(item.paralegal || item.paralegalId);
}
export function matterHref(item, tab = "overview") {
  if (!validId(id(item))) return "#/matters";
  if (item.localDraft) return `#/matters/new?draftId=${id(item)}&step=description`;
  if (statusKey(item.status) === "draft" && !archived(item)) return `#/matters/new?caseDraftId=${id(item)}&step=description`;
  return matterLink(id(item), tab) || "#/matters";
}
export function reviewHref(item) {
  const query = new URLSearchParams();
  for (const key of ["applicantId", "applicationId"]) if (validId(item?.[key])) query.set(key, item[key]);
  return matterLink(id(item), "applications", query) || "#/matters?view=applications";
}
export function money(value, currency = "usd") {
  if (!Number.isSafeInteger(value) || value < 0) return "Amount unavailable";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency).toUpperCase() }).format(value / 100); }
  catch { return "Currency unavailable"; }
}
export function amount(item) {
  // Draft compensation is a dollar string, not the authoritative cents amount.
  if (item.localDraft) return "";
  return money(item.remainingAmount ?? item.lockedTotalAmount ?? item.totalAmount, item.currency || "usd");
}
export function timestamp(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date) : "Date unavailable";
}
export function mergeRecords(active, history, drafts = []) {
  const records = new Map();
  // Archived endpoint wins overlapping records, as in the V1 archive bucket.
  active.forEach((item) => { if (!validId(id(item))) throw new TypeError("Invalid matter identity"); records.set(id(item), item); });
  history.forEach((item) => {
    if (!validId(id(item))) throw new TypeError("Invalid matter identity");
    // V1 includes every archived-endpoint record in its archive bucket. Keep
    // that source membership without changing the server's archived/status fields.
    records.set(id(item), { ...item, __av2ArchiveBucket: true });
  });
  for (const item of drafts) {
    if (!validId(id(item))) throw new TypeError("Invalid draft identity");
    if (item.publishedCaseId != null) continue;
    records.set(`draft:${id(item)}`, { ...item, localDraft: true });
  }
  return [...records.values()];
}
export function filtersFromQuery(query) {
  const choice = (key, choices, fallback = "") => choices.includes(query.get(key)) ? query.get(key) : fallback;
  const view = query.get("view") === "inquiries" ? "applications" : choice("view", ["active", "draft", "archived", "applications"], "active");
  return {
    view, search: String(query.get("q") || "").slice(0, 200), practice: String(query.get("matterPractice") || "").slice(0, 200),
    deadline: choice("matterDeadline", ["overdue", "7_days", "none"]), updated: choice("matterUpdated", ["7_days", "30_days"]),
    sort: choice("matterSort", ["recent", "deadline", "status", "alphabetical", "recent_reverse", "deadline_reverse", "status_reverse", "alphabetical_reverse"], "recent"),
    archiveStatus: choice("archiveStatus", ["all", "completed", "paused", "archived"], "all"),
    page: Math.min(1000000, Math.max(1, Number.parseInt(query.get("page"), 10) || 1)),
  };
}
export function filterRecords(records, filters, { now = Date.now(), today = dates.today() } = {}) {
  const search = filters.search.trim().toLowerCase();
  const list = records.filter((item) => {
    if (bucket(item) !== filters.view) return false;
    if (search && ![item.title, item.practiceArea, person(item.paralegal)].filter(Boolean).join(" ").toLowerCase().includes(search)) return false;
    if (filters.practice && item.practiceArea !== filters.practice) return false;
    const deadline = dates.matterValue(item);
    if (filters.deadline === "none" && deadline) return false;
    if (filters.deadline === "overdue" && (!deadline || deadline >= today)) return false;
    if (filters.deadline === "7_days" && (!deadline || deadline < today || deadline > dates.addDays(today, 7))) return false;
    const updated = new Date(item.updatedAt || item.createdAt).getTime();
    if (filters.updated && (!Number.isFinite(updated) || updated < now - (filters.updated === "7_days" ? 7 : 30) * 86400000)) return false;
    if (filters.view === "archived" && filters.archiveStatus !== "all") {
      const completed = item.paymentReleased || statusKey(item.status) === "completed";
      const paused = statusKey(item.status) === "paused";
      if (filters.archiveStatus === "completed" && !completed) return false;
      if (filters.archiveStatus === "paused" && !paused) return false;
      if (filters.archiveStatus === "archived" && (completed || paused)) return false;
    }
    return true;
  });
  return list.sort((left, right) => {
    const title = () => String(left.title || "").localeCompare(String(right.title || ""));
    if (filters.sort === "alphabetical") return title();
    if (filters.sort === "status") return statusLabel(left, now).localeCompare(statusLabel(right, now)) || title();
    if (filters.sort === "deadline") return (dates.matterValue(left) || "9999-12-31").localeCompare(dates.matterValue(right) || "9999-12-31") || title();
    return (new Date(right.updatedAt || right.createdAt).getTime() || 0) - (new Date(left.updatedAt || left.createdAt).getTime() || 0);
  });
}
export function profileComplete(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new TypeError("Invalid profile");
  return user.onboarding?.attorneyProfileCompleted === true || [user.practiceDescription || user.bio, user.lawFirm, user.linkedInURL, user.firmWebsite, ...(user.practiceAreas || []), ...(user.publications || [])].some((value) => String(value || "").trim());
}
export function eligibleApplications(apps, records) {
  const byId = new Map(records.map((item) => [id(item), item]));
  return apps.filter((app) => {
    if (!app.caseId) return true; // Existing unlinked Job applications remain visible.
    const matter = byId.get(String(app.caseId));
    return matter && !matter.paralegal && !matter.paralegalId && statusKey(matter.status) !== "completed" && !matter.archived && !matter.paymentReleased;
  });
}
export function applicationDisagreements(apps, records) {
  const totals = new Map();
  apps.forEach((app) => { if (app.caseId) totals.set(String(app.caseId), (totals.get(String(app.caseId)) || 0) + 1); });
  return records.filter((item) => !item.localDraft && !item.paralegal && !archived(item) && applicantCount(item) !== null && applicantCount(item) !== (totals.get(id(item)) || 0));
}
export function reconcileUnread(unread, summary, threads) {
  const total = count(unread.count);
  const totalThreads = count(threads.total);
  if (array(threads.threads).length > totalThreads) throw new TypeError("Invalid conversation count");
  const items = array(summary.items);
  // Independent reads can straddle a change in access. Never render an empty
  // conversation list as authoritative when unread evidence contradicts it.
  if (totalThreads === 0 && (total > 0 || items.some(item => count(item.unread) > 0))) throw new TypeError("Inconsistent empty conversation inventory");
  const byId = new Map(items.map((item) => [String(item.caseId), count(item.unread)]));
  const sum = items.reduce((n, item) => n + count(item.unread), 0);
  const mismatch = total !== sum || array(threads.threads).some((item) => byId.get(id(item)) !== count(item.unread));
  return { total: mismatch ? null : total, byId, mismatch, threads: threads.threads, totalThreads };
}
