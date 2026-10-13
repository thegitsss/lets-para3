const OBJECT_ID = /^[a-f\d]{24}$/i;
const MATTER_TABS = new Set([
  "overview",
  "applications",
  "work",
  "files",
  "messages",
  "deadlines",
  "activity",
  "financials",
]);

function objectId(value) {
  const id = String(value || "").trim();
  return OBJECT_ID.test(id) ? id : "";
}

function route(path, query = new URLSearchParams()) {
  const suffix = query.toString();
  return {
    href: `/paralegal-v2.html#${path}${suffix ? `?${suffix}` : ""}`,
    internal: true,
  };
}

function matterRoute(caseId, source = new URLSearchParams(), fallbackTab = "overview") {
  const id = objectId(caseId);
  if (!id) return null;
  const tab = MATTER_TABS.has(String(source.get("tab") || fallbackTab).toLowerCase())
    ? String(source.get("tab") || fallbackTab).toLowerCase()
    : "overview";
  const query = new URLSearchParams({ tab });
  ["applicantId", "fileId", "messageId", "eventId"].forEach((name) => {
    const value = objectId(source.get(name));
    if (value) query.set(name, value);
  });
  return route(`/matter/${encodeURIComponent(id)}`, query);
}

function settingsRoute(url) {
  const hash = String(url.hash || "").toLowerCase();
  const onboardingStep = String(url.searchParams.get("onboardingStep") || "").toLowerCase();
  const onboardingStatus = String(url.searchParams.get("onboarding") || url.searchParams.get("stripe") || "").toLowerCase();
  let tab = "profile";
  if (hash.includes("security") || url.searchParams.get("tab") === "security" || onboardingStep === "payment" || onboardingStep === "security" || onboardingStatus) tab = "security";
  if (hash.includes("preference") || url.searchParams.get("tab") === "preferences") tab = "preferences";
  const query = new URLSearchParams({ tab });
  if (onboardingStep === "payment" || onboardingStep === "security" || onboardingStatus) query.set("section", "payments");
  if (onboardingStatus) query.set("stripe", onboardingStatus);
  if (url.searchParams.get("profilePrompt") === "1") query.set("profilePrompt", "1");
  return route("/settings", query);
}

function workRoute(url) {
  const replayTour = url.searchParams.get("replayTour") === "1";
  const query = new URLSearchParams();
  const invitationId = objectId(url.searchParams.get("inviteCase"));
  const applicationId = objectId(url.searchParams.get("applicationId"));
  const jobId = objectId(url.searchParams.get("highlightJobId") || url.searchParams.get("jobId"));
  const matterId = objectId(url.searchParams.get("highlightCase") || url.searchParams.get("caseId"));
  const hash = String(url.hash || "").toLowerCase();
  if (invitationId) {
    query.set("section", "invitations");
    query.set("matterId", invitationId);
  } else if (applicationId) {
    query.set("section", "applications");
    query.set("applicationId", applicationId);
  } else if (jobId) {
    query.set("section", "applications");
    query.set("jobId", jobId);
  } else if (matterId || hash.includes("completed")) {
    query.set("section", "history");
    if (matterId) query.set("matterId", matterId);
  } else if (hash.includes("cases")) {
    query.set("section", "applications");
  }
  if (replayTour) {
    return route("/home", new URLSearchParams({ tour: "1" }));
  }
  return route(query.size ? "/work" : "/home", query);
}

export function adaptLegacyDestination(value, { caseId = "" } = {}) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("//") || raw.includes("\\")) return null;
  if (raw.startsWith("#")) {
    if (/case-messages/i.test(raw)) return matterRoute(caseId, new URLSearchParams(), "messages");
    return null;
  }

  let url;
  try {
    url = new URL(raw, "https://lpc.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://lpc.invalid" || url.username || url.password) return null;

  if (url.pathname === "/paralegal-v2.html") {
    const hash = String(url.hash || "");
    if (!hash.startsWith("#/")) return null;
    const parsed = parseRouteHash(hash);
    if (!parsed.found || Object.values(parsed.params).some(value => !objectId(value))) return null;
    return { href: `${url.pathname}${hash}`, internal: true };
  }
  if (url.pathname === "/case-detail.html") {
    const query = new URLSearchParams(url.searchParams);
    if (!query.get("tab")) {
      if (/case-messages/i.test(url.hash)) query.set("tab", "messages");
      else if (/casefilessection/i.test(url.hash)) query.set("tab", "files");
      else if (/financial/i.test(url.hash)) query.set("tab", "financials");
    }
    return matterRoute(url.searchParams.get("caseId"), query);
  }
  if (url.pathname === "/browse-jobs.html") {
    const query = new URLSearchParams();
    const requested = ["caseId", "caseID", "case_id", "id", "matterId"].map(key => url.searchParams.get(key)).find(Boolean);
    const id = objectId(requested);
    if (requested && !id) return null;
    if (id) query.set("matterId", id);
    for (const [key, alias] of [["practice", "browsePractice"], ["state", "browseState"], ["minPay", "browseMinPay"], ["deadline", "browseDeadline"], ["posted", "browsePosted"], ["sort", "browseSort"], ["page", "browsePage"]]) {
      const value = url.searchParams.has(key) ? url.searchParams.get(key) : url.searchParams.get(alias);
      if (value !== null) query.set(key, value);
    }
    return route("/browse", query);
  }
  if (url.pathname === "/dashboard-paralegal.html") return workRoute(url);
  if (url.pathname === "/profile-settings.html") return settingsRoute(url);
  if (url.pathname === "/paralegalhelp.html") {
    const incident = url.searchParams.get("incident");
    if (incident !== null && !/^INC-\d{8}-\d{6}$/.test(incident)) return null;
    return route("/help", incident ? new URLSearchParams({ incident }) : new URLSearchParams());
  }
  if (url.pathname === "/profile-paralegal.html") {
    const id = objectId(url.searchParams.get("paralegalId"));
    return id ? route(`/profile/${encodeURIComponent(id)}`) : null;
  }
  if (url.pathname === "/profile-attorney.html") {
    const id = objectId(url.searchParams.get("id"));
    return id ? route(`/attorney/${encodeURIComponent(id)}`) : null;
  }

  const publicDestinations = new Set([
    "/privacy.html",
    "/terms.html",
    "/accessibility.html",
    "/contact.html",
    "/paralegal-admission.html",
    "/forgot-password.html",
  ]);
  if (!publicDestinations.has(url.pathname)) return null;
  return { href: `${url.pathname}${url.search}${url.hash}`, internal: false };
}

export function navigateToDestination(destination, windowObject = window) {
  if (!destination?.href) return false;
  if (!destination.internal) {
    windowObject.location.assign(destination.href);
    return true;
  }
  const url = new URL(destination.href, windowObject.location.origin);
  if (url.pathname !== windowObject.location.pathname || !url.hash) return false;
  windowObject.location.hash = url.hash;
  return true;
}

export { MATTER_TABS, objectId };
import { parseRouteHash } from "./router.mjs";
