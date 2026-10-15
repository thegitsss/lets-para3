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
  if (typeof href !== "string" || !/^#\/(?:matters|tasks|payments|conversations|help)(?:\/|\?|$)/.test(href)) return href;
  const [path, ...parts] = href.split("?"), query = new URLSearchParams(parts.join("?"));
  if (target) query.set("returnTo", target);
  const origin = matterOriginHref(route);
  const sameMatter = path.match(/^#\/matters\/([a-f0-9]{24})\//i);
  if (origin && sameMatter && sameMatter[1].toLowerCase() === route?.caseId?.toLowerCase()) {
    const carried = new URLSearchParams(origin.split('?').slice(1).join('?'));
    for (const [key,value] of carried) if (key !== 'returnTo' && !query.has(key)) query.set(key,value);
  }
  if (origin && (!path.startsWith('#/matters/') || /\/(?:receipt|export|archive)$/.test(path))) query.set('matterOrigin', origin);
  return `${path}${query.size ? `?${query}` : ''}`;
}

// A separate bounded origin lets adjacent tools return to the actual Matter
// tab. The nested list return remains restricted to the existing list grammar.
export function safeMatterOrigin(value) {
  if (typeof value !== 'string' || value.length > 6000 || /[\\\x00-\x20\x7f]/.test(value)) return null;
  const [path, ...parts] = value.split('?');
  if (!/^#\/matters\/[a-f0-9]{24}\/(?:overview|applications|work|files|messages|deadlines|activity|financials|invitations)$/i.test(path)) return null;
  const input = new URLSearchParams(parts.join('?')), output = new URLSearchParams();
  for (const key of ['fileId','eventId','taskId','messageId','applicantId','applicationId']) if (input.getAll(key).length === 1 && objectId(input.get(key))) output.set(key,input.get(key));
  const earlier=input.get('earlierFileId');if(input.getAll('earlierFileId').length===1 && /^[a-f0-9]{64}$/.test(earlier || ''))output.set('earlierFileId',earlier);
  const taskIndex=input.get('taskIndex');if(input.getAll('taskIndex').length===1 && /^(0|[1-9]\d{0,3})$/.test(taskIndex || ''))output.set('taskIndex',taskIndex);
  for (const key of ['appSearch','appStatus','appSort','appPage','fileSearch','fileStatus','fileSort','invStatus','invSearch','invSort','invPage']) {
    const text = input.get(key);
    if (input.getAll(key).length === 1 && text && text.length <= 200 && !/[\x00-\x1f\x7f]/.test(text)) output.set(key,text);
  }
  const list = safeMatterReturn(input.get('returnTo')); if (list) output.set('returnTo',list);
  return path + (output.size ? `?${output}` : '');
}
export function matterOriginHref(route) {
  if (!route?.caseId || !objectId(route.caseId)) return safeMatterOrigin(route?.query?.get('matterOrigin'));
  const rawTab = route.tab || ({'matter-invitations':'invitations','matter-management':'overview','matter-receipt':'financials','matter-export':'financials','matter-archive':'overview'})[route.name];
  const tab = ({receipt:'financials',export:'financials',archive:'overview',manage:'overview'})[rawTab] || rawTab;
  if (!tab) return safeMatterOrigin(route.query?.get('matterOrigin'));
  return safeMatterOrigin(route.query?.get('matterOrigin')) || safeMatterOrigin(`#/matters/${route.caseId}/${tab}${route.query?.size ? `?${route.query}` : ''}`);
}
export function matterToolReturnHref(route, fallback) {
  return safeMatterOrigin(route?.query?.get('matterOrigin')) || fallback || matterReturnHref(route);
}
