const objectId = value => /^[a-f0-9]{24}$/i.test(value || "");
const choices = {
  view: ["active", "draft", "applications", "archived", "inquiries"],
  matterDeadline: ["overdue", "7_days", "none"], matterUpdated: ["7_days", "30_days"],
  matterSort: ["recent", "deadline", "status", "alphabetical"], archiveStatus: ["all", "completed", "paused", "archived"],
};

export function safeCurrentMatterReturn(value) {
  if (typeof value !== 'string' || value.length > 4000 || /[\\\x00-\x20\x7f]/.test(value) || !/^\/dashboard-attorney\.html(?:\?|#)/.test(value)) return null;
  const url = new URL(value, 'https://lpc.invalid');
  if (url.origin !== 'https://lpc.invalid' || url.pathname !== '/dashboard-attorney.html' || !/^#cases(?::(?:active|draft|archived|inquiries))?$/.test(url.hash)) return null;
  const input = url.searchParams, output = new URLSearchParams();
  for (const key of ['q', 'matterPractice']) {
    const text = input.get(key);
    if (input.getAll(key).length === 1 && text && text.length <= 200 && !/[\x00-\x1f\x7f]/.test(text)) output.set(key, text);
  }
  for (const key of ['matterDeadline', 'matterUpdated', 'matterSort', 'archiveStatus']) if (input.getAll(key).length === 1 && choices[key].includes(input.get(key))) output.set(key, input.get(key));
  for (const key of ['activePage', 'draftPage', 'archivedPage', 'inquiriesPage']) {
    const page = input.get(key);
    if (input.getAll(key).length === 1 && /^[1-9]\d{0,6}$/.test(page || '') && Number(page) <= 1000000) output.set(key, page);
  }
  if (input.getAll('workspace').length === 1 && input.get('workspace') === 'legacy') output.set('workspace', 'legacy');
  return `/dashboard-attorney.html${output.size ? `?${output}` : ''}${url.hash}`;
}

// Only a Matter list can be a nested return. Never carry external redirects,
// another tool page, or recursively nested return URLs through private tools.
export function safeMatterReturn(value) {
  if (typeof value !== "string" || value.length > 4000 || /[\\\x00-\x20\x7f]/.test(value) || !value.startsWith("#/matters") || value.indexOf("#", 1) !== -1) return null;
  const [path, ...parts] = value.slice(1).split("?");
  if (path !== "/matters") return null;
  const input = new URLSearchParams(parts.join("?")), output = new URLSearchParams();
  for (const [key, allowed] of Object.entries(choices)) if (input.getAll(key).length === 1 && (allowed.includes(input.get(key)) || (key === 'matterSort' && ['recent_reverse', 'deadline_reverse', 'status_reverse', 'alphabetical_reverse'].includes(input.get(key))))) output.set(key, input.get(key));
  for (const key of ["q", "matterPractice"]) {
    const value = input.get(key);
    if (input.getAll(key).length === 1 && value && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)) output.set(key, value);
  }
  const page = input.get("page");
  if (input.getAll("page").length === 1 && /^[1-9]\d{0,6}$/.test(page || "") && Number(page) <= 1000000) output.set("page", page);
  for (const key of ["caseId", "previewCaseId", "highlightCase", "applicantId", "applicationId"]) if (input.getAll(key).length === 1 && objectId(input.get(key))) output.set(key, input.get(key));
  for (const key of ["openApplicant", "openApplicants"]) if (input.getAll(key).length === 1 && input.get(key) === "1") output.set(key, "1");
  const ordered = new URLSearchParams([...input].filter(([key, value]) => output.get(key) === value));
  return `#/matters${ordered.size ? `?${ordered}` : ""}`;
}

export function matterReturnHref(route, fallback = "#/matters") {
  return safeMatterReturn(route?.query?.get("returnTo")) || safeMatterReturn(fallback) || "#/matters";
}

export function withMatterReturn(href, route) {
  const target = route?.name === "matters" ? safeMatterReturn(`#/matters${route.query?.size ? `?${route.query}` : ""}`) : safeMatterReturn(route?.query?.get("returnTo"));
  if (!target || typeof href !== "string" || !/^#\/matters(?:\/|\?|$)/.test(href)) return href;
  const [path, ...parts] = href.split("?"), query = new URLSearchParams(parts.join("?"));
  query.set("returnTo", target);
  return `${path}?${query}`;
}
