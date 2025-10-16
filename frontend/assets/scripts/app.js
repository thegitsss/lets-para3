// frontend/assets/scripts/app.js
// App bootstrap for the Express/Mongo backend (cookie-based auth).
// - On load, check session via GET /api/users/me
// - If not authenticated -> redirect to login.html
// - If authenticated -> show app shell and route to the requested view
// - Sidebar navigation uses hash routes (e.g., #overview, #messages)

import { escapeHTML, j as req } from "./helpers.js";

const els = {
  app: document.getElementById("app"),
  content: document.getElementById("contentArea"),
  jobTitle: document.getElementById("jobTitle"),
  jobStatus: document.getElementById("jobStatus"),
  uploadBtn: document.getElementById("uploadBtn"),
  fileInput: document.getElementById("fileInput"),
  sidebarLinks: [...document.querySelectorAll(".sidebar a[data-route]")],
};

boot();

async function boot() {
  // Sidebar click handlers
  els.sidebarLinks.forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const route = e.currentTarget.dataset.route;
      location.hash = route;
    })
  );

  // Upload placeholder (until Documents view is wired)
  els.uploadBtn?.addEventListener("click", () => els.fileInput?.click());
  els.fileInput?.addEventListener("change", onUpload);

  // Session check — if not logged in, go to login.html
  const me = await getMeOrRedirect();
  // Show shell
  els.app?.classList.remove("hidden");

  // Optional header badges (if you keep them in your layout)
  if (els.jobTitle) els.jobTitle.textContent = "ParaConnect";
  if (els.jobStatus) els.jobStatus.textContent = (me?.role || "").toUpperCase();

  // Route
  routeTo(location.hash.replace("#", "") || "overview");
  window.addEventListener("hashchange", () =>
    routeTo(location.hash.replace("#", "")))
}

async function getMeOrRedirect() {
  try {
    const me = await req("/api/users/me", { credentials: "include" });
    const hasId = !!(me && (me.id || me._id));
    if (!hasId) throw new Error("no session");
    return me;
  } catch {
    location.href = "login.html";
    throw new Error("redirecting to login");
  }
}

function loading(title = "Loading…") {
  els.content.innerHTML = `
    <div class="section skeleton">
      <div class="section-title">${escapeHTML(title)}</div>
      <div class="line" style="height:14px;background:#f3f4f6;border-radius:6px;width:60%;margin-top:8px"></div>
      <div class="line" style="height:14px;background:#f3f4f6;border-radius:6px;width:40%;margin-top:8px"></div>
    </div>
  `;
}

async function routeTo(route) {
  const routes = {
    overview: () => import("./views/overview.js"),
    profile: () => import("./views/profile.js"),
    messages: () => import("./views/messages.js"),
    checklist: () => import("./views/checklist.js"),
    deadlines: () => import("./views/deadlines.js"),
    documents: () =>
      import("./views/documents.js").catch(() => ({
        render: (el) =>
          (el.innerHTML =
            '<div class="section"><div class="section-title">Documents</div><p>Coming soon</p></div>'),
      })),
    calendar: () => import("./views/calendar.js"),
    settings: () =>
      import("./views/settings.js").catch(() => ({
        render: (el) =>
          (el.innerHTML =
            '<div class="section"><div class="section-title">Settings</div><p>Coming soon</p></div>'),
      })),
    help: () =>
      import("./views/help.js").catch(() => ({
        render: (el) =>
          (el.innerHTML =
            '<div class="section"><div class="section-title">Help</div><p>Coming soon</p></div>'),
      })),
  };

  const normalized = (route || "overview").toLowerCase();
  setActive(normalized);
  loading();

  try {
    const loader = routes[normalized];
    if (!loader) {
      els.content.innerHTML =
        '<div class="section"><div class="section-title">Not found</div><p>This page does not exist.</p></div>';
      return;
    }
    const mod = await loader();
    if (!mod || typeof mod.render !== "function") {
      els.content.innerHTML =
        '<div class="section"><div class="section-title">Error</div><p>View failed to load.</p></div>';
      return;
    }
    await mod.render(els.content, { escapeHTML });
  } catch (err) {
    console.error("Route error:", err);
    els.content.innerHTML =
      '<div class="section"><div class="section-title">Error</div><p>Something went wrong loading this page.</p></div>';
  }
}
