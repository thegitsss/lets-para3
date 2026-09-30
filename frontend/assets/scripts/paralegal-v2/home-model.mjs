import { readEarningsReport, readExpectedCompensation } from "../utils/paralegal-financials.mjs";
import { buildHomeWorkspace } from "./home-workspace-model.mjs";
import { preHiringRequestCopy } from "./copy-presentation.mjs";

const SOURCE_NAMES = ["dashboard", "profile", "stripe", "recommendations", "invites", "events", "threads", "unread", "applications", "notifications", "submissions"];
const ACTIVE_STATUSES = new Set(["active", "awaiting_documents", "reviewing", "funded_in_progress", "in_progress"]);
const APPLICATION_STATUSES = new Set(["submitted", "viewed", "shortlisted"]);
const FINAL_STATUSES = new Set(["completed", "closed", "cancelled", "canceled", "withdrawn", "rejected", "denied", "hired", "archived"]);
const SOURCE_STATES = new Set(["ready", "loading", "stale", "restricted", "unavailable", "error"]);
const ATTENTION_SOURCES = ["dashboard", "applications", "invites", "recommendations", "events", "threads", "unread"];

function id(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  return id(value._id || value.id || value.caseId || value.jobId);
}

function list(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.items) ? value.items : Array.isArray(value?.threads) ? value.threads : [];
}

function status(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function timestamp(value) {
  if (!value) return 0;
  const valueMs = new Date(value).getTime();
  return Number.isFinite(valueMs) ? valueMs : 0;
}

function compareId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function count(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Math.floor(Number(value)) : null;
}

// Same listing display precedence as browse-view.mjs; these are posted gross
// amounts, never client-calculated earnings, fees, transfers or bank receipts.
function listingAmount(value) {
  for (const key of ["remainingAmount", "lockedTotalAmount", "totalAmount"]) {
    if (Number.isFinite(Number(value[key])) && Number(value[key]) > 0) return Number(value[key]) / 100;
  }
  for (const key of ["payAmount", "budget"]) {
    if (Number.isFinite(Number(value[key])) && Number(value[key]) > 0) return Number(value[key]);
  }
  return null;
}

// Match backend/utils/businessDate.js: retain the calendar date, validate it,
// and never shift an authoritative date-only Matter deadline through local time.
export function dateOnly(value) {
  if (value instanceof Date) value = Number.isNaN(value.getTime()) ? "" : value.toISOString();
  const candidate = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return "";
  const [year, month, day] = candidate.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : "";
}

export function newYorkDateOnly(value = Date.now()) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(parsed);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function formatHomeDate(value) {
  const date = dateOnly(value);
  return date ? new Date(`${date}T12:00:00.000Z`).toLocaleDateString(undefined, {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
  }) : "No deadline listed";
}

function source(wrapper, forcedState = "", name = "") {
  const code = Number(wrapper?.error?.status || wrapper?.error?.statusCode);
  let state = forcedState || (SOURCE_STATES.has(wrapper?.state) ? wrapper.state
    : wrapper?.stale ? "stale" : wrapper?.available === true ? "ready"
      : code === 401 || code === 403 ? "restricted"
        : wrapper?.available === false ? "unavailable" : "loading");
  if (state === "ready") {
    const supplied = wrapper?.value;
    const listSource = ["recommendations", "invites", "events", "threads", "applications", "notifications"].includes(name);
    const valid = listSource ? Array.isArray(supplied) || Array.isArray(supplied?.items) || (name === "threads" && Array.isArray(supplied?.threads))
      : name === "dashboard" ? Array.isArray(supplied?.activeCases)
        : name === "unread" ? count(supplied?.count) !== null
          : Boolean(supplied && typeof supplied === "object" && !Array.isArray(supplied));
    if (!valid || wrapper?.available !== true) state = "unavailable";
  }
  const value = state === "ready" ? wrapper?.value : null;
  const rows = list(value);
  const truncated = Number(value?.pages) > 1 || (Number.isFinite(Number(value?.total)) && Number(value.total) > rows.length);
  return { state, available: state === "ready", complete: state === "ready" && !truncated, value };
}

function collectionState(sources) {
  if (sources.every(item => item.state === "ready" && item.complete)) return "ready";
  for (const state of ["restricted", "stale", "error", "unavailable", "loading"]) {
    if (sources.some(item => item.state === state)) return state;
  }
  return "partial";
}

function rowEvent(left, right) {
  return right.eventAt - left.eventAt || compareId(left.id, right.id);
}

function rowDeadline(left, right) {
  return compareId(left.deadline || "9999-12-31", right.deadline || "9999-12-31") || rowEvent(left, right);
}

export function compareAttention(left, right) {
  return left.priority - right.priority || rowDeadline(left, right);
}

function unique(rows) {
  const found = new Map();
  // Canonical ordering also resolves duplicate IDs deterministically.
  [...rows].sort((a, b) => rowEvent(a, b) || compareId(JSON.stringify(a), JSON.stringify(b))).forEach(row => {
    if (row.id && !found.has(row.id)) found.set(row.id, row);
  });
  return [...found.values()];
}

function workspaceHref(matterId, tab = "overview") {
  return `/matter/${encodeURIComponent(matterId)}?tab=${tab}`;
}

function ownerMatches(record, userId, field = "paralegalId") {
  const owner = id(record?.[field]);
  return !owner || owner === userId;
}

function activeRows(dashboard, threads, userId, today) {
  const supplied = Array.isArray(dashboard?.activeCases) ? dashboard.activeCases : [];
  const threadById = new Map(unique(threads.map(thread => ({
    id: id(thread.caseId || thread.case || thread.matterId || thread.id),
    eventAt: timestamp(thread.updatedAt || thread.lastMessageAt),
    unread: count(thread.unread),
  }))).map(thread => [thread.id, thread]));
  return unique(supplied.filter(matter => {
    const owner = id(matter.paralegalId || matter.paralegal);
    return owner === userId && ACTIVE_STATUSES.has(status(matter.status)) && matter.archived !== true && matter.paymentReleased !== true;
  }).map(matter => {
    const matterId = id(matter.caseId || matter._id || matter.id);
    const workspaceReady = matter.archived === false && matter.paymentReleased === false &&
      status(matter.escrowStatus) === "funded" && Boolean(matter.escrowIntentId);
    const deadline = dateOnly(matter.deadlineDate || matter.deadline);
    const total = count(matter.tasksTotal);
    const remaining = count(matter.tasksRemaining);
    const completed = total !== null && remaining !== null && remaining <= total ? total - remaining : null;
    return {
      id: matterId, jobId: id(matter.jobId), title: matter.jobTitle || matter.title || "Matter", practice: matter.practiceArea || "",
      attorney: matter.attorneyName || "", status: status(matter.status),
      label: ({ awaiting_documents: "Awaiting documents", reviewing: "Under review" }[status(matter.status)] || "In progress"),
      deadline, deadlineLabel: deadline ? `${deadline < today ? "Past due" : deadline === today ? "Due today" : "Due"} · ${formatHomeDate(deadline)}` : "",
      overdue: Boolean(deadline && deadline < today), eventAt: timestamp(matter.latestUpdateAt),
      latestUpdate: String(matter.latestUpdate || ""), latestUpdateAt: matter.latestUpdateAt || "",
      latestFileName: String(matter.latestFileName || ""), total, completed,
      progress: total > 0 && completed !== null ? `${completed} of ${total} work items complete` : "",
      unread: workspaceReady ? threadById.get(matterId)?.unread ?? null : null, workspaceReady,
      href: workspaceReady ? workspaceHref(matterId) : "/work", actionLabel: workspaceReady ? "Open workspace" : "Review matter",
    };
  })).sort(rowDeadline);
}

function applicationRows(applications, userId, activeIds) {
  return unique(applications.filter(app => ownerMatches(app, userId)).map(app => {
    const persistedId = id(app._id || app.id || app.applicationId);
    const job = app.jobId && typeof app.jobId === "object" ? app.jobId : app.job && typeof app.job === "object" ? app.job : {};
    const matterId = id(app.caseId || job.caseId);
    const appId = persistedId || (app.applicationSource === "invite_accept" && matterId ? `case:${matterId}` : "");
    const linkedJobId = id(job._id || job.id || app.jobId);
    const appStatus = status(app.status || app.applicationStatus || app.state);
    const jobStatus = status(job.status);
    const pre = app.preEngagement || {};
    const preStatus = status(pre.status);
    const pending = app.pending !== false && APPLICATION_STATUSES.has(appStatus) && (!jobStatus || jobStatus === "open") && job.archived !== true &&
      app.casePaymentReleased !== true && job.paymentReleased !== true &&
      status(app.caseEscrowStatus || job.escrowStatus) !== "funded" && !activeIds.has(matterId);
    const request = pending && id(pre.requestedParalegalId) === userId &&
      ["requested", "changes_requested"].includes(preStatus);
    const review = pending && preStatus === "submitted";
    const label = request ? preStatus === "changes_requested" ? "Changes requested" : "Information needed before hiring"
      : review ? "With attorney for review" : ({ submitted: "Submitted", viewed: "Viewed", shortlisted: "Shortlisted", hired: "Hired", withdrawn: "Withdrawn", rejected: "Rejected" }[appStatus] || "Status unavailable");
    return {
      id: appId, caseId: matterId, jobId: linkedJobId,
      title: job.title || app.caseTitle || "Matter no longer available", practice: job.practiceArea || "",
      status: appStatus, label, request, pending, movement: pending && ["viewed", "shortlisted"].includes(appStatus),
      detail: request ? preHiringRequestCopy(pre) : "", deadline: "",
      eventAt: timestamp(request ? pre.requestedAt || app.updatedAt || app.createdAt : app.updatedAt || app.createdAt),
      href: persistedId ? `/work?applicationId=${encodeURIComponent(persistedId)}` : linkedJobId ? `/work?jobId=${encodeURIComponent(linkedJobId)}` : "/work?section=applications",
      actionLabel: request ? "Review request" : "View application",
    };
  })).sort((a, b) => Number(b.request) - Number(a.request) || Number(b.movement) - Number(a.movement) || rowEvent(a, b));
}

function invitationRows(invites, userId, activeIds) {
  return unique(invites.filter(invite => {
    const matterId = id(invite.caseId || invite._id || invite.id);
    const assigned = id(invite.paralegalId || invite.paralegal);
    return status(invite.inviteStatus) === "pending" && !FINAL_STATUSES.has(status(invite.status)) &&
      invite.archived !== true && invite.paymentReleased !== true && !activeIds.has(matterId) &&
      (!assigned || assigned === userId);
  }).map(invite => {
    const attorney = invite.attorneyId || invite.attorney || {};
    return {
      id: id(invite.caseId || invite._id || invite.id), jobId: id(invite.jobId),
      title: invite.title || "Matter invitation", practice: invite.practiceArea || "",
      description: String(invite.briefSummary || invite.details || invite.description || "").slice(0, 600),
      state: invite.state || invite.locationState || "",
      compensation: typeof invite.lockedTotalAmount === "number" && Number.isFinite(invite.lockedTotalAmount)
        ? invite.lockedTotalAmount / 100 : typeof invite.totalAmount === "number" && Number.isFinite(invite.totalAmount) ? invite.totalAmount / 100 : null,
      currency: /^[A-Z]{3}$/.test(String(invite.currency || "")) ? invite.currency : "USD",
      attorney: attorney.name || [attorney.firstName, attorney.lastName].filter(Boolean).join(" "),
      status: "pending", label: "Invitation", deadline: "", matterDeadline: dateOnly(invite.deadlineDate || invite.deadline),
      detail: [invite.practiceArea, invite.state || invite.locationState].filter(value => typeof value === "string" && value.trim()).join(" · "), eventAt: timestamp(invite.inviteInvitedAt || invite.pendingParalegalInvitedAt),
      href: "/work?section=invitations", actionLabel: "Review invitation",
    };
  })).sort(rowEvent);
}

function recommendationRows(recommendations, exclusions) {
  return unique(recommendations.filter(job => {
    const ids = [id(job.caseId || job._id || job.id), id(job.jobId)];
    return !ids.some(value => value && exclusions.has(value)) && job.archived !== true && job.paymentReleased !== true &&
      (!status(job.status) || status(job.status) === "open");
  }).map(job => {
    const matterId = id(job.caseId || job._id || job.id);
    return {
      id: matterId, title: job.title || "Matter", practice: job.practiceArea || "", status: "recommended", label: "Open Matter",
      description: String(job.briefSummary || job.details || job.description || "").slice(0, 600),
      compensation: listingAmount(job), currency: "USD",
      state: job.state || job.locationState || job.location?.state || job.jurisdiction || "",
      deadline: dateOnly(job.deadlineDate || job.deadline), eventAt: timestamp(job.createdAt || job.updatedAt),
      href: `/browse?matterId=${encodeURIComponent(matterId)}`, actionLabel: "Preview matter",
    };
  })).sort(rowDeadline);
}

function deadlineRows(matters, events, userId, today) {
  const authorized = new Map(matters.filter(matter => matter.workspaceReady).map(matter => [matter.id, matter]));
  const matterRows = matters.filter(matter => matter.workspaceReady && matter.deadline).map(matter => ({
    id: `matter:${matter.id}`, caseId: matter.id, title: matter.title, deadline: matter.deadline,
    status: matter.overdue ? "past_due" : matter.deadline === today ? "due_today" : "upcoming", label: "Matter deadline",
    eventAt: matter.eventAt, source: "matter", href: workspaceHref(matter.id, "deadlines"), actionLabel: "Open deadline",
  }));
  const reminderRows = events.filter(event => {
    const matterId = id(event.caseId || event.case);
    return status(event.type) === "deadline" && ownerMatches(event, userId, "owner") &&
      !FINAL_STATUSES.has(status(event.status)) && event.completed !== true && event.cancelled !== true &&
      (!matterId || authorized.has(matterId));
  }).map(event => {
    const matterId = id(event.caseId || event.case);
    const deadline = event.isAllDay === false ? timestamp(event.start) ? newYorkDateOnly(event.start) : "" : dateOnly(event.start);
    return {
      id: id(event.id || event._id) ? `event:${id(event.id || event._id)}` : "", caseId: matterId,
      title: event.title || "Private reminder", deadline, status: deadline < today ? "past_date" : "upcoming", label: "Private reminder",
      eventAt: timestamp(event.updatedAt || event.createdAt), source: "event",
      href: matterId ? workspaceHref(matterId, "deadlines") : "", actionLabel: matterId ? "Open reminder" : "",
    };
  }).filter(event => event.deadline);
  return unique([...matterRows, ...reminderRows]).sort(rowDeadline);
}

function availabilityModel(profile, sourceState, today) {
  const details = profile?.availabilityDetails || {};
  const returnDate = dateOnly(details.nextAvailable);
  const explicit = status(details.status);
  const text = String(profile?.availability || "");
  const known = sourceState === "ready" && (["available", "unavailable"].includes(explicit) || /available/i.test(text));
  const returned = returnDate && returnDate <= today;
  const unavailable = !returned && (explicit === "unavailable" || /unavailable/i.test(text));
  return {
    state: known ? "ready" : sourceState === "ready" ? "unknown" : sourceState,
    status: known ? unavailable ? "unavailable" : "available" : "unknown",
    label: known ? unavailable ? "Not available" : "Available now" : "Availability unavailable",
    next: known && unavailable ? returnDate : "", canEdit: known && ["available", "unavailable"].includes(explicit),
  };
}

function profileTodos(source) {
  if (!source.complete) return [];
  const p = source.value || {};
  const text = value => typeof value === "string" && value.trim().length > 0;
  const entries = value => Array.isArray(value) && value.some(text);
  const checks = [
    ["primary-state", text(p.state) || text(p.location), "Choose your primary state", "Add the state where you are based."],
    ["bio", text(p.bio), "Add your professional summary", "Introduce your experience and the work you do."],
    ["skills", entries(p.skills), "Add your skills", "List the skills you bring to Matter work."],
    ["practice-areas", entries(p.practiceAreas), "Add your practice areas", "Select the areas of law you work in."],
    ["résumé", text(p.resumeURL) || text(p.resumeKey), "Upload your résumé", "Add your résumé to your profile."],
    ["profile-photo", text(p.profileImage) || text(p.avatarURL) || text(p.pendingProfileImage) || p.profilePhotoStatus === "pending_review", "Add your profile photo", "Upload a photo for your professional profile."],
  ];
  return checks.filter(([, complete]) => !complete).map(([id, , title, detail]) => ({ id, title, detail, actionLabel: "Update profile", href: `/settings?tab=profile&section=${encodeURIComponent(id)}` }));
}

function readinessModel(sources, opportunities) {
  const profile = sources.profile.value || {};
  const photo = sources.profile.available ? Boolean(profile.profileImage || profile.avatarURL) : null;
  const readiness = sources.stripe.value?.readiness;
  const payout = !sources.stripe.available || !readiness || (readiness.evidenceState && readiness.evidenceState !== "verified")
    ? "unknown" : readiness.ready === true ? "ready" : readiness.ready === false ? "incomplete" : "unknown";
  const items = [];
  if (sources.recommendations.available && sources.recommendations.value?.hasMatchingProfile === false) items.push({
    id: "matching", title: "Complete your professional profile", detail: "Add your state experience, practice areas, and years of experience to your professional profile.",
    href: "/settings?tab=profile", actionLabel: "Update profile", scope: "recommendations",
  });
  if (opportunities.recommendations.length && photo === false) items.push({
    id: "photo", title: "Add a profile photo before applying", detail: "A profile photo is required when you submit an application.",
    href: "/settings?tab=profile", actionLabel: "Add profile photo", scope: "applying",
  });
  if (opportunities.recommendations.length || opportunities.invitations.length) {
    if (payout === "incomplete") items.push({
      id: "payout", title: "Set up payouts", detail: "Payout setup is required before applying or accepting an invitation.",
      href: "/settings?tab=security&section=payments", actionLabel: "Continue to Stripe", action: "stripe", scope: "applying_and_accepting",
    });
    else if (payout === "unknown") items.push({
      id: "payout_unknown", title: "Payout status unavailable", detail: "Payout readiness will need to be checked before applying or accepting an invitation.",
      href: "/settings?tab=security&section=payments", actionLabel: "Payment settings", scope: "applying_and_accepting",
    });
  }
  return { profile: photo === null ? "unknown" : photo ? "ready" : "incomplete", payout, items };
}

function attentionModel(matters, opportunities, communications, sources, today) {
  const candidates = [];
  const add = (row, kind, priority, detail, groupId = `${kind}:${row.id}`) => candidates.push({
    ...row, kind, priority, detail, groupId,
  });
  opportunities.applications.forEach(row => {
    if (row.request) add(row, "request", 10, row.detail, `matter:${row.caseId || row.id}`);
    else if (row.movement) add(row, "application", 50, `Your application is ${row.label.toLowerCase()}.`, `matter:${row.caseId || row.id}`);
  });
  matters.filter(row => row.workspaceReady).forEach(row => {
    const group = `matter:${row.id}`;
    if (row.deadline) add(row, "deadline", row.deadline < today ? 20 : row.deadline === today ? 21 : 60,
      `${row.deadline < today ? "The recorded matter deadline has passed" : row.deadline === today ? "The recorded matter deadline is today" : "Upcoming matter deadline"} · ${formatHomeDate(row.deadline)}.`, group);
    if (row.latestUpdate && row.eventAt) add(row, "update", 30, row.latestUpdate, group);
    if (row.unread) add({ ...row, href: workspaceHref(row.id, "messages"), actionLabel: "Open messages" }, "communication", 70,
      `${row.unread} unread message${row.unread === 1 ? "" : "s"}.`, group);
    add(row, "workspace", 71, "Open your matter workspace.", group);
  });
  opportunities.invitations.forEach(row => add(row, "invitation", 40, row.detail, `matter:${row.id}`));
  if (communications.unreadCount && !communications.items.length) add({
    id: "messages", title: "Unread messages", label: "Unread messages", status: "unread", deadline: "", eventAt: 0,
    href: "/work", actionLabel: "Review your matters",
  }, "communication", 70, `${communications.unreadCount} unread message${communications.unreadCount === 1 ? "" : "s"}.`);
  opportunities.recommendations.forEach(row => add(row, "recommendation", 80, "Review the scope and requirements before applying."));
  const grouped = new Map();
  candidates.sort(compareAttention).forEach(row => {
    if (!grouped.has(row.groupId)) grouped.set(row.groupId, row);
  });
  const ordered = [...grouped.values()];
  const state = collectionState(ATTENTION_SOURCES.map(name => sources[name]));
  return { state: ordered.length ? state === "ready" ? "ready" : "partial" : state === "ready" ? "quiet" : state, complete: state === "ready", item: ordered[0] || null, candidates: ordered };
}

export function buildHomeModel(snapshot = {}, { now = Date.now(), userId = "" } = {}) {
  const currentUserId = id(userId);
  const profile = snapshot.profile?.value || {};
  const profileId = id(profile._id || profile.id);
  const unauthorized = SOURCE_NAMES.some(name => Number(snapshot[name]?.error?.status || snapshot[name]?.error?.statusCode) === 401);
  const mismatch = !currentUserId || (snapshot.userId && id(snapshot.userId) !== currentUserId) || (profileId && profileId !== currentUserId);
  const restrictedProfile = (status(profile.role) && status(profile.role) !== "paralegal") ||
    (status(profile.status) && status(profile.status) !== "approved") || profile.disabled === true || profile.deleted === true;
  const forcedState = unauthorized || mismatch || restrictedProfile ? "restricted" : snapshot.stale ? "stale" : "";
  const sources = Object.fromEntries(SOURCE_NAMES.map(name => [name, source(snapshot[name], forcedState, name)]));
  const today = newYorkDateOnly(now);
  const activeWork = activeRows(sources.dashboard.value, list(sources.threads.value), currentUserId, today).filter(row => sources.submissions.value?.matters?.[row.id]?.state !== "restricted");
  const activeIds = new Set(activeWork.map(row => row.id));
  const allApplications = applicationRows(list(sources.applications.value), currentUserId, activeIds);
  const invitations = invitationRows(list(sources.invites.value), currentUserId, activeIds);
  const exclusions = new Set([...activeIds, ...activeWork.map(row => row.jobId), ...allApplications.flatMap(row => [row.caseId, row.jobId]), ...invitations.flatMap(row => [row.id, row.jobId])].filter(Boolean));
  const opportunities = {
    invitations, applications: allApplications.filter(row => row.pending),
    recommendations: recommendationRows(list(sources.recommendations.value), exclusions),
  };
  const activeById = new Map(activeWork.filter(row => row.workspaceReady).map(row => [row.id, row]));
  const communicationItems = unique(list(sources.threads.value).map(thread => {
    const matterId = id(thread.caseId || thread.case || thread.matterId || thread.id);
    return {
      id: matterId, title: thread.title || activeById.get(matterId)?.title || "Matter", status: "unread", label: "Unread messages",
      unread: count(thread.unread), detail: String(thread.lastMessageSnippet || ""), deadline: "", eventAt: timestamp(thread.updatedAt || thread.lastMessageAt),
      href: workspaceHref(matterId, "messages"), actionLabel: "Open messages",
    };
  }).filter(row => row.unread > 0 && activeById.has(row.id))).sort(rowEvent);
  const communications = {
    items: communicationItems, unreadCount: sources.unread.available ? count(sources.unread.value?.count) : null,
    state: collectionState([sources.threads, sources.unread, sources.dashboard]),
    complete: sources.threads.complete && sources.unread.complete && sources.dashboard.complete,
  };
  const metrics = sources.dashboard.value?.metrics || {};
  let earningsReport = null, expectedCompensation = null;
  if (sources.dashboard.state === "ready") {
    try { earningsReport = readEarningsReport(metrics.earningsReport, currentUserId); } catch {}
    try { expectedCompensation = readExpectedCompensation(metrics.expectedCompensation, currentUserId); } catch {}
  }
  const history = {
    earningsReport, expectedCompensation,
    state: sources.dashboard.state, href: "/work?section=history",
    metrics: [["earnings", "This month"], ["earningsLast30Days", "Last 30 days"], ["earningsTotal", "All time"]].map(([key, label]) => ({
      id: key, label, currency: "USD", value: typeof metrics[key] === "number" && Number.isFinite(metrics[key]) ? metrics[key] : null,
    })),
  };
  const result = {
    today, sources, activeWork, opportunities, profileTodos: profileTodos(sources.profile),
    attention: attentionModel(activeWork, opportunities, communications, sources, today),
    deadlines: deadlineRows(activeWork, list(sources.events.value), currentUserId, today), communications, history,
    availability: availabilityModel(sources.profile.value, sources.profile.state, today), readiness: readinessModel(sources, opportunities),
  };
  result.workspace = buildHomeWorkspace(result);
  return result;
}
