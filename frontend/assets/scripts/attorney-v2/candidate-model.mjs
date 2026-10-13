import { safeMatterReturn } from "./matter-return.mjs";
const id = (value) => /^[a-f0-9]{24}$/i.test(value || "") ? value : "";
const text = (value) => typeof value === "string" ? value : "";
const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

export function directoryQuery(query) {
  const result = new URLSearchParams({ page: String(Math.min(10000, Math.max(1, Number.parseInt(query.get("page"), 10) || 1))), limit: "10", sort: ["recent", "alpha", "experience"].includes(query.get("sort")) ? query.get("sort") : "recent" });
  for (const key of ["q", "location", "practice"]) { const value = query.get(key)?.trim().slice(0, 2000); if (value) result.set(key, value); }
  const years = Number(query.get("minYears"));
  if (Number.isInteger(years) && years > 0 && years <= 80) result.set("minYears", String(years));
  return result;
}
export function candidateContext(query) {
  const result = new URLSearchParams();
  for (const key of ["caseId", "applicantId", "applicationId"]) if (id(query.get(key))) result.set(key, query.get(key));
  return result;
}
export function candidateHref(candidateId, query = new URLSearchParams()) {
  if (!id(candidateId)) return "#/paralegals";
  const context = candidateContext(query);
  const returnTo = safeCandidateReturn(query.get("returnTo"));
  if (returnTo) context.set("returnTo", returnTo);
  return `#/paralegals/${candidateId}${context.size ? `?${context}` : ""}`;
}
export function safeCandidateReturn(value, depth = 0) {
  if (typeof value !== "string" || value.length > 16000 || /[\\\x00-\x20]/.test(value) || !value.startsWith("#/")) return null;
  const [path, ...parts] = value.slice(1).split("?");
  const query = new URLSearchParams(parts.join("?"));
  if (path === "/paralegals") {
    const safe = directoryQuery(query);
    if (query.get("view") === "saved") safe.set("view", "saved");
    for (const [key, value] of candidateContext(query)) safe.set(key, value);
    const returnTo = depth === 0 ? safeCandidateReturn(query.get("returnTo"), 1) : null;
    if (returnTo?.startsWith("#/matters")) safe.set("returnTo", returnTo);
    return `#/paralegals?${safe}`;
  }
  if (path === "/matters") return safeMatterReturn(value);
  if (/^\/matters\/[a-f0-9]{24}\/(overview|applications|invitations)$/i.test(path)) {
    const safe = candidateContext(query);
    if (["active", "applications", "archived"].includes(query.get("view"))) safe.set("view", query.get("view"));
    for (const key of ["q", "matterPractice", "matterDeadline", "matterUpdated", "matterSort", "archiveStatus"]) {
      const value = query.get(key);
      if (value && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)) safe.set(key, value);
    }
    if (/^[1-9]\d{0,4}$/.test(query.get("page") || "")) safe.set("page", query.get("page"));
    if (/^[1-9]\d{0,6}$/.test(query.get("appPage") || "") && Number(query.get("appPage")) <= 1000000) safe.set("appPage", query.get("appPage"));
    if (["newest", "oldest", "name", "starred"].includes(query.get("appSort"))) safe.set("appSort", query.get("appSort"));
    if (["all", "submitted", "viewed", "shortlisted", "accepted", "rejected", "withdrawn", "unknown"].includes(query.get("appStatus"))) safe.set("appStatus", query.get("appStatus"));
    if (query.get("appSearch") && query.get("appSearch").length <= 200 && !/[\x00-\x1f\x7f]/.test(query.get("appSearch"))) safe.set("appSearch", query.get("appSearch"));
    if (/^[1-9]\d{0,6}$/.test(query.get("invPage") || "") && Number(query.get("invPage")) <= 1000000) safe.set("invPage", query.get("invPage"));
    if (["newest", "oldest", "name"].includes(query.get("invSort"))) safe.set("invSort", query.get("invSort"));
    if (["all", "pending", "accepted", "declined", "expired", "unknown"].includes(query.get("invStatus"))) safe.set("invStatus", query.get("invStatus"));
    if (query.get("invSearch") && query.get("invSearch").length <= 200 && !/[\x00-\x1f\x7f]/.test(query.get("invSearch"))) safe.set("invSearch", query.get("invSearch"));
    if (query.get("openApplicant") === "1") safe.set("openApplicant", "1");
    const returnTo = safeMatterReturn(query.get("returnTo"));
    if (returnTo) safe.set("returnTo", returnTo);
    return `#${path}${safe.size ? `?${safe}` : ""}`;
  }
  return null;
}
export function legacyCandidateHref(candidateId, query) {
  if (!id(candidateId)) return "/browse-paralegals.html";
  const context = candidateContext(query);
  const result = new URLSearchParams({ id: candidateId });
  if (context.has("applicationId")) result.set("applicationId", context.get("applicationId"));
  if (context.has("caseId")) result.set("caseId", context.get("caseId"));
  if (context.has("caseId") && context.has("applicantId")) {
    const back = new URLSearchParams({ caseId: context.get("caseId"), applicantId: context.get("applicantId"), returnFromProfile: "1", openApplicant: "1" });
    if (context.has("applicationId")) back.set("applicationId", context.get("applicationId"));
    result.set("returnTo", `/dashboard-attorney.html?${back}#cases:inquiries`);
  } else if (context.has("caseId")) result.set("returnTo", `/case-detail.html?${new URLSearchParams({ caseId: context.get("caseId"), tab: "applications" })}`);
  else result.set("returnTo", "/browse-paralegals.html");
  return `/profile-paralegal.html?${result}`;
}
export function availability(profile) {
  const next = profile.nextAvailable ? new Date(profile.nextAvailable) : null;
  if (next && Number.isFinite(next.getTime())) {
    if (next <= new Date()) return "Available now";
    return `Next opening ${next.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`;
  }
  const raw = text(profile.availability).trim().toLowerCase();
  if (["available", "open", "available now", "immediately"].includes(raw)) return "Available";
  if (["unavailable", "not available", "busy"].includes(raw)) return "Currently unavailable";
  return raw ? text(profile.availability) : "";
}
export function experience(years) { return typeof years === "number" && Number.isFinite(years) && years >= 0 ? years === 0 ? "Under a year of experience" : `${years} ${years === 1 ? "year" : "years"} of experience` : ""; }
export function profilePhoto(value, candidateId, origin) {
  try {
    const url = new URL(value, origin);
    const querySafe = [...url.searchParams].every(([key, val]) => key === "v" && /^\d+$/.test(val));
    if (url.origin === origin && querySafe && !url.hash && [ `/api/public/paralegals/${candidateId}/photo`, `/api/users/profile-photo/${candidateId}`, "/assets/avatar-placeholder.svg" ].includes(url.pathname)) return `${url.pathname}${url.search}`;
  } catch { /* Show a neutral avatar when a photo is unavailable. */ }
  return "/assets/avatar-placeholder.svg";
}
export function safeDocumentKey(value, candidateId) {
  if (typeof value !== "string" || /[\\\x00-\x20%?#]/.test(value) || value.split("/").some((part) => part === ".." || part === ".")) return null;
  return new RegExp(`^(?:paralegal-(?:resumes|certificates|writing-samples)/${candidateId}/|users/${candidateId}/(?:resume|certificate|writing-sample)/)[a-zA-Z0-9_./-]+$`).test(value) ? value : null;
}
export function safeSignedUrl(value, origin) {
  if (typeof value !== "string" || /[\\\x00-\x20]/.test(value)) return null;
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && url.origin === origin)) ? url.href : null; } catch { return null; }
}
// Deliberate display projection. Ignore preferences, notification settings,
// contact/KYC/Stripe data and every unknown field, even on authenticated DTOs.
export function projectCandidate(payload, candidateId, tier) {
  if (!payload || id(payload.id || payload._id) !== candidateId) throw new Error("invalid_candidate");
  const result = { id: candidateId, name: [text(payload.firstName), text(payload.lastName)].filter(Boolean).join(" ") || text(payload.name) || "Paralegal", tier };
  for (const key of ["bio", "about", "location", "state", "avatarURL", "profileImage", "linkedInURL", "availability"]) result[key] = text(payload[key]);
  result.yearsExperience = typeof payload.yearsExperience === "number" ? payload.yearsExperience : null;
  for (const key of ["practiceAreas", "specialties", "bestFor"]) result[key] = list(payload[key]);
  result.education = Array.isArray(payload.education) ? payload.education.map((item) => Object.fromEntries(["degree", "fieldOfStudy", "school", "startYear", "endYear", "grade", "activities"].map((key) => [key, typeof item?.[key] === "number" ? String(item[key]) : text(item?.[key])]))) : [];
  if (tier === "authenticated") {
    result.nextAvailable = text(payload.availabilityDetails?.nextAvailable);
    for (const key of ["skills", "stateExperience", "jurisdictions"]) result[key] = list(payload[key]);
    result.languages = Array.isArray(payload.languages) ? payload.languages.map((item) => typeof item === "string" ? item : [text(item?.name || item?.language), text(item?.proficiency)].filter(Boolean).join(" · ")) : [];
    result.experience = Array.isArray(payload.experience) ? payload.experience.map((item) => Object.fromEntries(["title", "company", "firm", "years", "startDate", "endDate", "description"].map((key) => [key, text(item?.[key])]))) : [];
    result.documents = [["Résumé", payload.resumeURL || payload.resumeKey], ["Certificate", payload.certificateKey || payload.certificateURL], ["Writing sample", payload.writingSampleURL || payload.writingSampleKey]].map(([label, value]) => ({ label, key: safeDocumentKey(value, candidateId) })).filter((doc) => doc.key);
  }
  return result;
}
