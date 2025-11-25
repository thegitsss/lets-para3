// frontend/assets/scripts/app.js
// Hash-based SPA shell for ParaConnect dashboards.

import { escapeHTML, j as req } from "./helpers.js";
import { getStoredSession, persistSession, requireAuth } from "./auth.js";

const els = {
  app: document.getElementById("app"),
  content: document.getElementById("contentArea"),
  sidebarLinks: [...document.querySelectorAll("[data-route]")],
};

const ROUTES = {
  "attorney-dashboard": {
    loader: () => import("./views/overview.js"),
    role: "attorney",
    title: "Attorney Dashboard",
  },
  "attorney-cases": {
    loader: () => import("./views/documents.js"),
    role: true,
    title: "Cases",
  },
  "attorney-jobs": {
    loader: () => import("./views/documents.js"),
    role: "attorney",
    title: "Jobs",
  },
  "attorney-settings": {
    loader: () => import("./views/settings.js"),
    role: "attorney",
    title: "Settings",
  },
  "attorney-messages": {
    loader: () => import("./views/messages.js"),
    role: "attorney",
    title: "Messages",
  },
  "paralegal-dashboard": {
    loader: () => import("./views/dashboard-paralegal.js"),
    role: "paralegal",
    title: "Paralegal Dashboard",
  },
  "paralegal-cases": {
    loader: () => import("./views/documents.js"),
    role: "paralegal",
    title: "Cases",
  },
  "paralegal-jobs": {
    loader: () => import("./views/browse-jobs.js"),
    role: "paralegal",
    title: "Jobs",
  },
  "paralegal-profile": {
    loader: () => import("./views/profile.js"),
    role: "paralegal",
    title: "Profile",
  },
  "paralegal-settings": {
    loader: () => import("./views/settings.js"),
    role: "paralegal",
    title: "Settings",
  },
  "paralegal-messages": {
    loader: () => import("./views/messages.js"),
    role: "paralegal",
    title: "Messages",
  },
  pending: {
    loader: () => import("./views/pending.js"),
    role: false,
    title: "Pending",
  },
  rejected: {
    loader: () => import("./views/rejected.js"),
    role: false,
    title: "Rejected",
  },
  "admin-pending-users": {
    loader: () => import("./views/admin-pending-users.js"),
    role: "admin",
    title: "Pending Users",
  },
  documents: { loader: () => import("./views/documents.js"), role: true, title: "Documents" },
  messages: { loader: () => import("./views/messages.js"), role: true, title: "Messages" },
  checklist: { loader: () => import("./views/checklist.js"), role: true, title: "Checklist" },
  deadlines: { loader: () => import("./views/deadlines.js"), role: true, title: "Deadlines" },
  calendar: { loader: () => import("./views/calendar.js"), role: true, title: "Calendar" },
  help: { loader: () => import("./views/help.js"), role: true, title: "Help" },
  "job-detail": { loader: () => import("./views/job-detail.js"), role: "paralegal", title: "Job Detail" },
  "case-detail": { loader: () => import("./views/case-detail.js"), role: true, title: "Case Detail" },
  chat: { loader: () => import("./views/chat.js"), role: true, title: "Case Chat" },
  "browse-jobs": { loader: () => import("./views/browse-jobs.js"), role: "paralegal", title: "Jobs" },
};

ROUTES.overview = ROUTES["attorney-dashboard"];
ROUTES["dashboard-paralegal"] = ROUTES["paralegal-dashboard"];
ROUTES["admin-dashboard"] = ROUTES["admin-pending-users"];

let currentDestroy = null;
let defaultRoute = "attorney-dashboard";

boot();

async function boot() {
  els.sidebarLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const targetRoute = event.currentTarget.getAttribute("data-route");
      const url = event.currentTarget.getAttribute("data-url");
      if (url) {
        window.location.href = url;
        return;
      }
      if (targetRoute) navigateTo(targetRoute);
    });
  });

  const me = await getMeOrRedirect();
  const stored = getStoredSession();
  persistSession({
    token: stored.token,
    user: me,
  });

  if (me?.status === "pending") {
    defaultRoute = "pending";
  } else if (me?.status === "rejected" || me?.status === "denied") {
    defaultRoute = "rejected";
  } else if (me?.role === "paralegal") {
    defaultRoute = "paralegal-dashboard";
  } else if (me?.role === "admin") {
    defaultRoute = "admin-pending-users";
  } else {
    defaultRoute = "attorney-dashboard";
  }

  els.app?.classList.remove("hidden");

  if (me?.status === "pending") {
    navigateTo("pending");
  } else if (me?.status === "rejected" || me?.status === "denied") {
    navigateTo("rejected");
  } else if (!location.hash) {
    navigateTo(defaultRoute);
  } else {
    handleHashChange();
  }
  window.addEventListener("hashchange", handleHashChange);
}

async function getMeOrRedirect() {
  try {
    const me = await req("/api/users/me", { credentials: "include" });
    const hasId = !!(me && (me.id || me._id));
    if (!hasId) throw new Error("no-session");
    return me;
  } catch {
    window.location.href = "login.html";
    throw new Error("redirecting");
  }
}

function parseHash(raw) {
  const trimmed = String(raw || "").replace(/^#/, "");
  if (!trimmed) return { view: null, params: new URLSearchParams() };
  const [view, query = ""] = trimmed.split("?");
  return { view: view || null, params: new URLSearchParams(query) };
}

function handleHashChange() {
  const { view, params } = parseHash(location.hash);
  routeTo(view || defaultRoute, params);
}

export function navigateTo(view, params = {}) {
  const query =
    params instanceof URLSearchParams
      ? params
      : Object.keys(params).length
      ? new URLSearchParams(params)
      : null;
  const suffix = query && [...query.entries()].length ? `?${query.toString()}` : "";
  const hash = `#${view}${suffix || ""}`;
  if (location.hash === hash) {
    handleHashChange();
  } else {
    location.hash = hash;
  }
}

window.navigateTo = navigateTo;

function loading(title = "Loading…") {
  els.content.innerHTML = `
    <div class="section skeleton">
      <div class="section-title">${escapeHTML(title)}</div>
      <div class="line" style="height:14px;background:#f3f4f6;border-radius:6px;width:60%;margin-top:8px"></div>
      <div class="line" style="height:14px;background:#f3f4f6;border-radius:6px;width:40%;margin-top:8px"></div>
    </div>
  `;
}

async function routeTo(routeName, params = new URLSearchParams()) {
  const resolvedName = ROUTES[routeName] ? routeName : defaultRoute;
  const route = ROUTES[resolvedName];

  if (!route) {
    els.content.innerHTML =
      '<div class="section"><div class="section-title">Not found</div><p>This page does not exist.</p></div>';
    return;
  }

  if (typeof currentDestroy === "function") {
    try {
      currentDestroy();
    } catch (err) {
      console.warn("View cleanup failed:", err);
    }
    currentDestroy = null;
  }

  setActive(resolvedName);
  loading(route.title);

  if (route.role !== false) {
    try {
      const session = requireAuth(route.role === true ? undefined : route.role);
      if (session?.status && session.status !== "approved" && resolvedName !== "pending") {
        navigateTo("pending");
        return;
      }
    } catch (err) {
      if (resolvedName !== "pending") {
        navigateTo("pending");
      }
      return;
    }
  }

  try {
    const mod = await route.loader();
    if (!mod || typeof mod.render !== "function") {
      throw new Error("Render function missing");
    }

    const maybeCleanup = await mod.render(els.content, {
      escapeHTML,
      params,
      navigateTo,
    });

    if (typeof mod.destroy === "function") {
      currentDestroy = () => mod.destroy(els.content);
    } else if (typeof maybeCleanup === "function") {
      currentDestroy = maybeCleanup;
    }
  } catch (err) {
    console.error("Route error:", err);
    els.content.innerHTML =
      '<div class="section"><div class="section-title">Error</div><p>Something went wrong loading this page.</p></div>';
  }
}

function setActive(routeName) {
  document.querySelectorAll("[data-route]").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-route") === routeName);
    if (el.classList.contains("active")) {
      el.setAttribute("aria-current", "page");
    } else {
      el.removeAttribute("aria-current");
    }
  });
}
