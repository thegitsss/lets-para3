export const SECTIONS = Object.freeze([
  { name: "conversations", title: "Messages", path: "/conversations", description: "Messages across your Matters." },
  { name: "home", title: "Home", path: "/home", legacy: "/dashboard-attorney.html", description: "Your Matters, deadlines, and recent activity." },
  { name: "matters", title: "Matters", path: "/matters", legacy: "/dashboard-attorney.html#cases", description: "Manage your Matters and review applications." },
  { name: "tasks", title: "Private Tasks", path: "/tasks", legacy: "/dashboard-attorney.html#tasks", description: "Keep track of your personal tasks and weekly notes." },
  { name: "paralegals", title: "Find a Paralegal", path: "/paralegals", legacy: "/browse-paralegals.html", description: "Explore paralegal profiles and experience." },
  { name: "payments", title: "Payments", path: "/payments", legacy: "/dashboard-attorney.html#funds", description: "Review payment activity and billing details." },
  { name: "settings", title: "Profile Settings", path: "/settings", legacy: "/profile-settings.html?role=attorney", description: "Manage your profile, account security, and preferences." },
  { name: "help", title: "Help", path: "/help", legacy: "/help.html", description: "Find guidance for working with Let’s-ParaConnect." },
]);

const ALLOWED_LEGACY = new Set([
  "/dashboard-attorney.html", "/create-case.html", "/case-detail.html", "/case-applications.html",
  "/browse-paralegals.html", "/profile-paralegal.html", "/profile-attorney.html",
  "/profile-settings.html", "/help.html", "/attorney-faq.html", "/contact.html",
]);

export function safeLegacyHref(value, origin = "https://lpc.invalid") {
  if (typeof value !== "string" || !value || /[\\\x00-\x20]/.test(value)) return null;
  try {
    const url = new URL(value, `${origin}/`);
    if (url.origin !== origin || url.username || url.password || !ALLOWED_LEGACY.has(url.pathname)) return null;
    // Preserve known V1 state. A nested return must itself stay on an allowed screen.
    for (const key of ["returnTo", "next", "redirect", "redirectTo", "returnUrl"]) {
      if (url.searchParams.has(key)) {
        const nested = new URL(url.searchParams.get(key), `${origin}/`);
        if (nested.origin !== origin || nested.username || nested.password || !ALLOWED_LEGACY.has(nested.pathname) || nested.search || nested.hash) return null;
      }
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function parseRoute(hash = "") {
  const source = String(hash).replace(/^#/, "") || "/home";
  const [rawPath, ...queryParts] = source.split("?");
  const path = rawPath === "/" ? "/home" : rawPath.replace(/\/$/, "");
  const query = new URLSearchParams(queryParts.join("?"));
  const simple = SECTIONS.find((section) => section.path === path);
  if (simple) return { ...simple, key: source, query, found: true };
  if (path === "/payments/setup") return { name: "payment-setup", title: "Payment card", path, key: source, query, found: true };
  const candidate = path.match(/^\/paralegals\/([a-f0-9]{24})$/i);
  if (candidate) return { name: "candidate", candidateId: candidate[1], title: "Paralegal profile", path, key: source, query, found: true, legacy: `/profile-paralegal.html?id=${candidate[1]}` };
  const downloads = path.match(/^\/matters\/([a-f0-9]{24})\/files$/i);
  const receipt = path.match(/^\/matters\/([a-f0-9]{24})\/receipt$/i);
  if (receipt) return { name: "matter-receipt", caseId: receipt[1], title: "Receipt", path, key: source, query, found: true, legacy: `/dashboard-attorney.html?previewCaseId=${receipt[1]}#cases` };
  if (downloads) return { name: "matter-downloads", caseId: downloads[1], tab: "files", title: "Matter files", path, key: source, query, found: true, legacy: `/dashboard-attorney.html?previewCaseId=${downloads[1]}#cases` };
  const archiveExport = path.match(/^\/matters\/([a-f0-9]{24})\/export$/i);
  if (archiveExport) return { name: "matter-export", caseId: archiveExport[1], title: "Download Matter archive", path, key: source, query, found: true, legacy: `/dashboard-attorney.html?previewCaseId=${archiveExport[1]}#cases:archived` };
  const archive = path.match(/^\/matters\/([a-f0-9]{24})\/archive$/i);
  if (archive) return { name: "matter-archive", caseId: archive[1], title: "Archive and restore", path, key: source, query, found: true, legacy: `/dashboard-attorney.html?previewCaseId=${archive[1]}#cases:archived` };
  const applications = path.match(/^\/matters\/([a-f0-9]{24})\/applications$/i);
  if (applications) return { name: "matter-applications", caseId: applications[1], tab: "applications", title: "Review applications", path, key: source, query, found: true, legacy: `/dashboard-attorney.html?caseId=${applications[1]}&openApplicants=1#cases:inquiries` };
  const invitations = path.match(/^\/matters\/([a-f0-9]{24})\/invitations$/i);
  if (invitations) return { name: "matter-invitations", caseId: invitations[1], title: "Invited paralegals", path, key: source, query, found: true, legacy: `/dashboard-attorney.html?previewCaseId=${invitations[1]}#cases` };
  const management = path.match(/^\/matters\/([a-f0-9]{24})\/manage$/i);
  if (management) return { name: "matter-management", caseId: management[1], title: "Matter notes and history", path, key: source, query, found: true, legacy: `/dashboard-attorney.html?previewCaseId=${management[1]}#cases` };
  const match = path.match(/^\/matters\/([a-f0-9]{24})\/(overview|applications|work|files|messages|deadlines|activity|financials)$/i);
  if (match && match[2].toLowerCase()==='messages') { query.set('matter',match[1]); return {name:'conversations',title:'Messages',path:'/conversations',caseId:match[1],tab:'messages',key:source,query,found:true}; }
  if (match && match[2].toLowerCase() === "activity" && /^[a-f0-9]{24}$/i.test(query.get("eventId") || "")) match[2] = "deadlines";
  if (match) return { name: "workspace", caseId: match[1], tab: match[2].toLowerCase(), title: "Matter", path, key: source, query, found: true, legacy: `/case-detail.html?caseId=${match[1]}&tab=${match[2]}` };
  if (path === "/matters/new") return { name: "create", title: "Create a Matter", path, key: source, query, found: true, legacy: "/create-case.html", description: "Describe your Matter and the support you need." };
  if (path === "/profile") return { name: "profile", title: "Your profile", path, key: source, query, found: true, legacy: "/profile-attorney.html", description: "Review your attorney profile." };
  return { name: "not-found", title: "Page not found", path, key: source, query, found: false };
}

// Notification destinations keep the Matter/object context inside this workspace.
export function notificationDestination(item, origin = "https://lpc.invalid") {
  const value = item?.action?.href;
  if (typeof value !== "string" || !value || /[\\\x00-\x20]/.test(value)) return null;
  const id = value => /^[a-f\d]{24}$/i.test(value || "") ? value : "";
  const route = (path, query = new URLSearchParams()) => ({ href: `/attorney-v2.html#${path}${query.size ? `?${query}` : ""}`, internal: true });
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password) return null;
    if (url.pathname === "/attorney-v2.html") return parseRoute(url.hash).found ? { href: `${url.pathname}${url.hash}`, internal: true } : null;
    if (!safeLegacyHref(value, origin)) return null;
    const query = new URLSearchParams();
    for (const name of ["applicantId", "applicationId", "fileId", "messageId", "eventId", "taskId"]) {
      const target = id(url.searchParams.get(name)); if (target) query.set(name, target);
    }
    const caseId = id(url.searchParams.get("caseId") || url.searchParams.get("previewCaseId") || url.searchParams.get("highlightCase"));
    if (url.pathname === "/case-detail.html" || url.pathname === "/case-applications.html") {
      if (!caseId) return null;
      const fallback = url.pathname === "/case-applications.html" ? "applications" : /case-messages/i.test(url.hash) ? "messages" : /caseFilesSection/i.test(url.hash) ? "files" : "overview";
      const tab = url.searchParams.get("tab") || fallback;
      if (!["overview", "applications", "work", "files", "messages", "deadlines", "activity", "financials"].includes(tab)) return null;
      return route(`/matters/${caseId}/${tab}`, query);
    }
    if (url.pathname === "/dashboard-attorney.html") {
      if (caseId) return route(`/matters/${caseId}/${url.searchParams.has("openApplicants") || url.searchParams.has("openApplicant") ? "applications" : /funds|payment/.test(url.hash) ? "financials" : "overview"}`, query);
      if (/funds|payment/.test(url.hash)) return route("/payments");
      if (/tasks/.test(url.hash)) return route("/tasks");
      if (/cases/.test(url.hash)) { const view = url.hash.split(":")[1]; if (["archived", "active", "draft", "inquiries"].includes(view)) query.set("view", view); return route("/matters", query); }
      return route("/home");
    }
    if (url.pathname === "/profile-paralegal.html") {
      const candidateId = id(url.searchParams.get("paralegalId") || url.searchParams.get("id"));
      return candidateId ? route(`/paralegals/${candidateId}`) : null;
    }
    if (url.pathname === "/profile-settings.html") {
      const tab = url.searchParams.get("tab") || url.hash.slice(1);
      if (["profile", "security", "preferences"].includes(tab)) query.set("tab", tab);
      return route("/settings", query);
    }
    if (url.pathname === "/help.html") {
      const incident = url.searchParams.get("incident");
      if (incident !== null && !/^INC-\d{8}-\d{6}$/.test(incident)) return null;
      return route("/help", incident ? new URLSearchParams({ incident }) : new URLSearchParams());
    }
    if (url.pathname === "/browse-paralegals.html") return route("/paralegals");
    if (["/attorney-faq.html", "/contact.html"].includes(url.pathname)) return { href: url.pathname, internal: false };
    return null;
  } catch { return null; }
}

export function legacyDestination(route) {
  if (!route.legacy) return "/dashboard-attorney.html";
  const url = new URL(route.legacy, "https://lpc.invalid");
  if (route.name === "matters") {
    const view = ({ active: "active", draft: "draft", archived: "archived", applications: "inquiries", inquiries: "inquiries" })[route.query.get("view")];
    if (view) url.hash = `cases:${view}`;
  }
  const keys = ({
    matters: ["openApplicant", "openApplicants", "caseId", "previewCaseId", "highlightCase", "matterDeadline", "matterUpdated", "matterSort", "matterPractice", "returnFromProfile", "continueHire"],
    create: ["draftId", "caseId"], settings: ["tab", "panel", "settingsTarget"],
    payments: ["from", "settingsTarget", "payment", "caseId", "highlightCase"],
    workspace: ["applicantId", "applicationId", "fileId", "messageId", "eventId", "taskId", "panel"],
  })[route.name] || [];
  for (const key of keys) {
    const value = route.query.get(key);
    if (value && value.length <= 200 && !/[\x00-\x1f]/.test(value)) url.searchParams.set(key, value);
  }
  return safeLegacyHref(url.href) || "/dashboard-attorney.html";
}
