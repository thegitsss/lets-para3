// frontend/assets/scripts/views/overview.js
// Overview aligned to Express/Mongo backend: My Cases, Upcoming Deadlines, Notifications, Quick Actions, Zoom join/add.

export async function render(el, { escapeHTML } = {}) {
  const h = (s) => (escapeHTML ? escapeHTML(String(s)) : String(s));
  ensureStylesOnce();
  el.innerHTML = skeleton();

  // Abortable load (if user navigates away quickly)
  let ctl = new AbortController();
  const signal = ctl.signal;

  try {
    const [me, cases, deadlines] = await Promise.all([
      j("/api/users/me", { signal }),
      j("/api/cases/my", { signal }),
      loadUpcomingDeadlines(7, signal),
    ]);

    const notifs = await buildNotifications(me, cases, deadlines, signal);

    draw(el, { me, cases, deadlines, notifs });
    wire(el, { me });
  } catch (e) {
    if (e?.name === "AbortError") return;
    el.innerHTML = `
      <div class="section">
        <div class="section-title">Overview</div>
        <div class="err">Couldn’t load overview. Please refresh.</div>
      </div>`;
  }

  // ----- render -----
  function draw(root, { me, cases, deadlines, notifs }) {
    const role = me?.role || "attorney";
    const name = me?.name || "User";
    const myCases = Array.isArray(cases) ? cases : [];

    const caseCards = myCases.slice(0, 6).map((c) => {
      const assigned =
        c.assignedTo?.name || c.assignedTo?.email || (c.acceptedParalegal && "Accepted") || null;
      const zoom = c.zoomLink
        ? `<button class="btn join" data-join="${h(c.zoomLink)}" aria-label="Join Zoom for ${h(c.title || "case")}">Join</button>`
        : role === "attorney" || role === "admin"
        ? `<button class="btn" data-addzoom="${h(c._id)}" aria-label="Add Zoom link to ${h(c.title || "case")}">Add Zoom</button>`
        : `<span class="muted">No Zoom</span>`;

      return `
        <div class="card case" data-case="${h(c._id)}">
          <div class="row space">
            <div class="case-title">${h(c.title || "Untitled Case")}</div>
            <span class="status ${statusClass(c.status)}" title="${h(c.status || "open")}">${h(c.status || "open")}</span>
          </div>
          <div class="meta">
            ${assigned ? tag("Paralegal: " + h(String(assigned).slice(0, 48))) : tag("No paralegal yet")}
            ${c.paymentReleased ? tag("Payout: released") : (c.escrowIntentId ? tag("Escrow: funded") : "")}
          </div>
          <div class="row gap">
            ${zoom}
            <button class="btn light" data-openmsgs="${h(c._id)}">Messages</button>
            <button class="btn light" data-opendocs="${h(c._id)}">Documents</button>
          </div>
          <form class="zoom-form" data-for="${h(c._id)}" style="display:none">
            <input name="zoom" type="url" placeholder="https://zoom.us/j/..." required inputmode="url" aria-label="Zoom link">
            <button class="btn">Save</button>
            <button type="button" class="btn light" data-cancelzoom>Cancel</button>
          </form>
        </div>`;
    }).join("");

    const dlRows = (deadlines || []).length
      ? deadlines.map(d => `
          <div class="dl-row ${deadlineClass(d.when)}">
            <div class="when">${fmtWhen(d.when)}</div>
            <div class="title">${h(d.title)}</div>
            <div class="meta">${d.caseId ? tag("Case " + h(String(d.caseId).slice(0,8))+"…") : ""}${d.kind === "event" ? tag("Calendar") : tag("Task")}</div>
          </div>
        `).join("")
      : `<div class="muted">No deadlines in the next 7 days.</div>`;

    const notifRows = (notifs.items || []).length
      ? notifs.items.map(n => `
        <div class="notif-item ${n.sev}">
          <span class="ic" aria-hidden="true">${iconFor(n.type)}</span>
          <div class="n-body">
            <div class="n-title">${h(n.title)}</div>
            ${n.detail ? `<div class="n-detail">${h(n.detail)}</div>` : ""}
          </div>
          ${n.cta ? `<button class="btn n-cta" data-cta="${h(n.cta.action)}">${h(n.cta.label)}</button>` : ""}
        </div>`).join("")
      : `<div class="muted">Nothing needs attention right now.</div>`;

    const qa = quickActions(role);

    root.innerHTML = `
      <div class="section">
        <div class="section-title" aria-live="polite">Welcome back, ${h(name)}</div>

        <div class="grid two">
          <div class="block">
            <div class="block-title">My Cases <span class="muted">(${myCases.length})</span></div>
            ${myCases.length ? `<div class="case-grid">${caseCards}</div>` : emptyCases(role)}
          </div>

          <div class="block">
            <div class="block-title">Upcoming Deadlines (7 days)</div>
            <div class="dl-list">${dlRows}</div>
          </div>
        </div>

        <div class="grid two" style="margin-top:16px">
          <div class="block">
            <div class="block-title">Notifications ${notifs.badge ? `<span class="badge" aria-label="${h(notifs.badge)} items">${notifs.badge}</span>` : ""}</div>
            <div class="notif-list">${notifRows}</div>
          </div>

          <div class="block">
            <div class="block-title">Quick Actions</div>
            <div class="qa">${qa}</div>
          </div>
        </div>
      </div>
    `;
  }

  function wire(root, { me }) {
    // Join Zoom
    root.addEventListener("click", (e) => {
      const join = e.target?.dataset?.join;
      if (join) {
        try { window.open(join, "_blank", "noopener"); } catch {}
      }
    });

    // Show Add Zoom form
    root.addEventListener("click", (e) => {
      const id = e.target?.dataset?.addzoom;
      if (!id) return;
      const form = root.querySelector(`.zoom-form[data-for="${cssEscape(id)}"]`);
      if (form) {
        form.style.display = "";
        form.zoom?.focus?.();
      }
    });

    // Cancel Zoom form
    root.addEventListener("click", (e) => {
      if (e.target?.dataset?.cancelzoom !== undefined) {
        e.target.closest(".zoom-form").style.display = "none";
      }
    });

    // Save Zoom link
    root.addEventListener("submit", async (ev) => {
      const form = ev.target.closest(".zoom-form");
      if (!form) return;
      ev.preventDefault();
      const caseId = form.dataset.for;
      const zoom = form.zoom.value.trim();
      if (!zoom) return;
      try {
        await saveZoom(caseId, zoom);
        await rerenderCard(root, caseId);
      } catch {
        alert("Failed to save Zoom link.");
      }
    });

    // Open Messages / Documents
    root.addEventListener("click", (e) => {
      const c = e.target?.dataset?.openmsgs;
      if (c) location.hash = "messages";
      const d = e.target?.dataset?.opendocs;
      if (d) location.hash = "documents";
    });

    // Quick actions
    root.addEventListener("click", (e) => {
      const qa = e.target?.dataset?.qa;
      if (!qa) return;
      if (qa === "post") location.hash = "cases-new";
      if (qa === "applicants") location.hash = "cases";
      if (qa === "messages") location.hash = "messages";
      if (qa === "browse") location.hash = "cases-browse";
      if (qa === "availability") location.hash = "profile";
      if (qa === "calendar") location.hash = "calendar";
      if (qa === "checklist") location.hash = "checklist";
    });

    // Notification CTAs
    root.addEventListener("click", (e) => {
      const act = e.target?.dataset?.cta;
      if (!act) return;
      if (act === "review-applicants") location.hash = "cases";
      if (act === "open-disputes") location.hash = "cases"; // or a dedicated disputes view
      if (act === "add-zoom") location.hash = "cases"; // direct card supports inline add
      if (act === "view-deadlines") location.hash = "deadlines";
      if (act === "pending-users") location.hash = "admin";
    });
  }
}

// ---------------- Data helpers ----------------

async function j(url, opts = {}) {
  const { signal, ...rest } = opts || {};
  const o = { credentials: "include", headers: {}, signal, ...rest };
  if (o.body && typeof o.body === "object" && !(o.body instanceof FormData)) {
    o.headers["Content-Type"] = "application/json";
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(url, o);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw Object.assign(new Error(text || `HTTP ${r.status}`), { status: r.status });
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.text();
}

let _csrf;
async function getCSRF() {
  if (_csrf) return _csrf;
  const r = await fetch("/api/csrf", { credentials: "include" });
  const j = await r.json().catch(() => ({}));
  _csrf = j?.csrfToken;
  return _csrf;
}

async function saveZoom(caseId, zoomLink) {
  const token = await getCSRF();
  const r = await fetch(`/api/cases/${encodeURIComponent(caseId)}/zoom`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    body: JSON.stringify({ zoomLink }),
  });
  if (!r.ok) throw new Error("zoom save failed");
}

async function loadUpcomingDeadlines(days = 7, signal) {
  const now = new Date();
  const limit = new Date(now.getTime() + days * 24 * 3600 * 1000);
  let items = [];

  // tasks with due
  try {
    const u = new URL("/api/checklist", location.origin);
    u.searchParams.set("status", "open");
    const data = await j(u.toString(), { signal });
    const tasks = data?.items || data || [];
    const withDue = tasks.filter(t => t.due).map(t => ({
      kind: "task",
      id: t.id || t._id,
      title: t.title,
      caseId: t.caseId,
      when: new Date(t.due),
    }));
    items = items.concat(withDue);
  } catch { /* noop */ }

  // events of type deadline
  try {
    const from = now.toISOString();
    const to = limit.toISOString();
    const u = new URL("/api/events", location.origin);
    u.searchParams.set("from", from);
    u.searchParams.set("to", to);
    const data = await j(u.toString(), { signal });
    const evs = data?.items || data || [];
    const dl = evs
      .filter(e => e.type === "deadline")
      .map(e => ({
        kind: "event",
        id: e.id || e._id,
        title: e.title,
        caseId: e.caseId,
        when: new Date(e.start),
      }));
    items = items.concat(dl);
  } catch { /* noop */ }

  items = items
    .filter(x => x.when <= limit)
    .sort((a, b) => a.when - b.when)
    .slice(0, 8);

  return items;
}

// Notifications builder
async function buildNotifications(me, cases, deadlines, signal) {
  const role = me?.role || "attorney";
  const items = [];
  let badge = "";

  const now = new Date();
  const soon = new Date(now.getTime() + 3 * 24 * 3600 * 1000);

  if (role === "attorney") {
    let pendingApps = 0;
    let openDisputes = 0;
    let missingZoom = 0;

    for (const c of cases || []) {
      pendingApps += (c.applicants || []).filter(a => (a.status || "pending") === "pending").length;
      openDisputes += (c.disputes || []).filter(d => d.status === "open").length;
      if (c.acceptedParalegal && !c.zoomLink) missingZoom += 1;
    }

    const dueSoon = deadlines.filter(d => d.when <= soon).length;

    if (pendingApps > 0) items.push({
      type: "applicants",
      sev: "info",
      title: `${pendingApps} new applicant${pendingApps>1?"s":""} awaiting review`,
      cta: { label: "Review applicants", action: "review-applicants" },
    });

    if (openDisputes > 0) items.push({
      type: "disputes",
      sev: "warn",
      title: `${openDisputes} open dispute${openDisputes>1?"s":""} need${openDisputes>1?"":"s"} attention`,
      cta: { label: "View disputes", action: "open-disputes" },
    });

    if (missingZoom > 0) items.push({
      type: "zoom",
      sev: "hint",
      title: `${missingZoom} accepted case${missingZoom>1?"s":""} without a Zoom link`,
      detail: "Add a meeting link so work can start smoothly.",
      cta: { label: "Add Zoom link", action: "add-zoom" },
    });

    if (dueSoon > 0) items.push({
      type: "deadlines",
      sev: "info",
      title: `${dueSoon} deadline${dueSoon>1?"s":""} within 3 days`,
      cta: { label: "View deadlines", action: "view-deadlines" },
    });

    const total = pendingApps + openDisputes + (missingZoom ? 1 : 0) + (dueSoon ? 1 : 0);
    badge = total ? String(total) : "";
  } else if (role === "paralegal") {
    const active = (cases || []).length;
    const missingZoom = (cases || []).filter(c => !c.zoomLink).length;
    const dueSoon = deadlines.filter(d => d.when <= soon).length;

    if (active === 0) {
      items.push({ type: "cases", sev: "hint", title: "No active cases yet", cta: { label: "Browse cases", action: "browse" } });
    } else {
      items.push({ type: "cases", sev: "info", title: `${active} active case${active>1?"s":""}` });
    }
    if (missingZoom > 0) {
      items.push({ type: "zoom", sev: "hint", title: `${missingZoom} case${missingZoom>1?"s":""} missing Zoom link` });
    }
    if (dueSoon > 0) {
      items.push({ type: "deadlines", sev: "info", title: `${dueSoon} deadline${dueSoon>1?"s":""} within 3 days`, cta: { label: "View deadlines", action: "view-deadlines" } });
    }

    const total = (missingZoom ? 1 : 0) + (dueSoon ? 1 : 0);
    badge = total ? String(total) : "";
  } else if (role === "admin") {
    // Admin-only extra queries (best-effort)
    let pendingUsers = 0;
    let openDisputes = 0;
    let allCases = 0;
    try {
      const res = await j("/api/admin/pending-users", { signal });
      pendingUsers = Array.isArray(res) ? res.length : (res?.length || 0);
    } catch {}
    try {
      const res = await j("/api/disputes/open", { signal });
      openDisputes = Array.isArray(res) ? res.length : (res?.length || 0);
    } catch {}
    try {
      const res = await j("/api/admin/cases", { signal });
      allCases = Array.isArray(res?.cases) ? res.cases.length : (res?.cases?.length || 0);
    } catch {}

    if (pendingUsers > 0) items.push({
      type: "users", sev: "info",
      title: `${pendingUsers} user${pendingUsers>1?"s":""} pending approval`,
      cta: { label: "Review users", action: "pending-users" }
    });
    if (openDisputes > 0) items.push({
      type: "disputes", sev: "warn",
      title: `${openDisputes} open dispute${openDisputes>1?"s":""}`,
      cta: { label: "View disputes", action: "open-disputes" }
    });
    items.push({ type: "cases", sev: "hint", title: `${allCases} total cases` });

    const total = (pendingUsers ? 1 : 0) + (openDisputes ? 1 : 0);
    badge = total ? String(total) : "";
  }

  return { items, badge };
}

// ---------------- UI helpers ----------------

function ensureStylesOnce() {
  if (document.getElementById("ov-styles")) return;
  const s = document.createElement("style");
  s.id = "ov-styles";
  s.textContent = `
  .grid.two{display:grid;gap:16px}
  .grid.one{display:grid;gap:16px;margin-top:16px}
  @media(min-width:960px){.grid.two{grid-template-columns:1fr 1fr}}
  .block{border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:14px}
  .block-title{font-weight:700;margin-bottom:8px}
  .badge{display:inline-block;min-width:22px;padding:1px 6px;border-radius:999px;background:#111827;color:#fff;font-size:.75rem;vertical-align:middle;margin-left:6px}
  .case-grid{display:grid;gap:10px}
  @media(min-width:960px){.case-grid{grid-template-columns:1fr 1fr}}
  .card.case{border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#fff}
  .row{display:flex;gap:8px;align-items:center}
  .row.space{justify-content:space-between}
  .row.gap{gap:8px;margin-top:8px;flex-wrap:wrap}
  .case-title{font-weight:700}
  .status{font-size:.8rem;border-radius:999px;padding:2px 8px;border:1px solid #e5e7eb;text-transform:capitalize}
  .status.open{background:#eef2ff;border-color:#c7d2fe}
  .status.in\\ progress{background:#ecfeff;border-color:#a5f3fc}
  .status.closed{background:#ecfdf5;border-color:#a7f3d0}
  .meta{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}
  .tag{border:1px solid #e5e7eb;border-radius:8px;padding:2px 6px;font-size:.8rem;background:#fff}
  .dl-list{display:grid;gap:8px}
  .dl-row{display:grid;grid-template-columns:160px 1fr auto;gap:10px;align-items:center;border:1px solid #e5e7eb;border-radius:10px;background:#fff;padding:10px}
  .dl-row.overdue{background:#fee2e2}
  .dl-row.today{background:#eef2ff}
  .when{font-family:ui-monospace, SFMono-Regular, Menlo, monospace}
  .btn{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
  .btn.light{background:#fff}
  .qa{display:flex;flex-wrap:wrap;gap:8px}
  .qa .btn{min-width:160px}
  .muted{color:#6b7280}
  .err{color:#b91c1c}
  .zoom-form{display:flex;gap:8px;margin-top:8px}
  .zoom-form input{flex:1;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px}
  .skeleton .line{height:14px;background:#f3f4f6;border-radius:6px;animation:sh 1.2s infinite}
  @keyframes sh{0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}

  /* Notifications */
  .notif-list{display:grid;gap:8px}
  .notif-item{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;border:1px solid #e5e7eb;border-radius:10px;background:#fff;padding:10px}
  .notif-item.warn{border-color:#fca5a5;background:#fff7f7}
  .notif-item.info{border-color:#bfdbfe;background:#f8fbff}
  .notif-item.hint{border-color:#e5e7eb;background:#fff}
  .ic{font-size:18px;line-height:1}
  .n-title{font-weight:600}
  .n-detail{font-size:.85rem;color:#6b7280}
  .n-cta{white-space:nowrap}
  `;
  document.head.appendChild(s);
}

function skeleton() {
  return `
  <div class="section skeleton">
    <div class="section-title">Overview</div>
    <div class="grid two">
      <div class="block">
        <div class="block-title">My Cases</div>
        <div class="case-grid">
          ${Array.from({ length: 3 }).map(() => `
            <div class="card case">
              <div class="line" style="width:60%"></div>
              <div class="line" style="width:40%;margin-top:6px"></div>
              <div class="line" style="width:30%;margin-top:10px"></div>
            </div>`).join("")}
        </div>
      </div>
      <div class="block">
        <div class="block-title">Upcoming Deadlines</div>
        ${Array.from({ length: 4 }).map(() => `
          <div class="dl-row">
            <div class="line" style="width:120px"></div>
            <div class="line" style="width:80%"></div>
            <div class="line" style="width:80px"></div>
          </div>`).join("")}
      </div>
    </div>
    <div class="grid two" style="margin-top:16px">
      <div class="block">
        <div class="block-title">Notifications</div>
        ${Array.from({ length: 3 }).map(() => `
          <div class="notif-item">
            <div class="line" style="width:18px;height:18px;border-radius:50%"></div>
            <div class="line" style="width:80%"></div>
            <div class="line" style="width:120px"></div>
          </div>`).join("")}
      </div>
      <div class="block">
        <div class="block-title">Quick Actions</div>
        <div class="qa">
          <div class="line" style="width:160px"></div>
          <div class="line" style="width:160px"></div>
          <div class="line" style="width:160px"></div>
        </div>
      </div>
    </div>
  </div>`;
}

function emptyCases(role) {
  if (role === "paralegal") {
    return `<div class="muted">No active cases yet. Try <button class="btn" data-qa="browse">Browse cases</button> or <button class="btn" data-qa="availability">Update availability</button>.</div>`;
  }
  return `<div class="muted">No cases yet. <button class="btn" data-qa="post">Post a case</button> to get started.</div>`;
}

function quickActions(role) {
  if (role === "paralegal") {
    return `
      <button class="btn" data-qa="browse">Browse Cases</button>
      <button class="btn" data-qa="availability">Update Availability</button>
      <button class="btn" data-qa="messages">Open Messages</button>
      <button class="btn" data-qa="calendar">Calendar</button>
      <button class="btn" data-qa="checklist">Checklist</button>
    `;
  }
  return `
    <button class="btn" data-qa="post">Post Case</button>
    <button class="btn" data-qa="applicants">Review Applicants</button>
    <button class="btn" data-qa="messages">Open Messages</button>
    <button class="btn" data-qa="calendar">Calendar</button>
    <button class="btn" data-qa="checklist">Checklist</button>
  `;
}

function tag(text) { return `<span class="tag">${text}</span>`; }

function statusClass(s = "open") {
  const v = String(s).toLowerCase();
  if (v === "closed") return "closed";
  if (v.startsWith("in")) return "in progress";
  return "open";
}

function fmtWhen(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const day = dt.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
  const time = dt.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"});
  return `${day} ${time}`;
}
function deadlineClass(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const today = new Date(); today.setHours(0,0,0,0);
  const sameDay = dt.toDateString() === today.toDateString();
  return dt < today ? "overdue" : (sameDay ? "today" : "");
}

// Icons for notification types
function iconFor(type) {
  if (type === "applicants") return "👥";
  if (type === "disputes")   return "⚠️";
  if (type === "deadlines")  return "⏰";
  if (type === "zoom")       return "🎥";
  if (type === "users")      return "📝";
  if (type === "cases")      return "📁";
  return "🔔";
}

// Re-render after zoom save (preserve scroll)
async function rerenderCard(root, _caseId) {
  const anchor = root.getBoundingClientRect().top + window.scrollY;
  const { render } = await import("./overview.js");
  await render(root, {});
  window.scrollTo({ top: anchor, behavior: "instant" });
}

// CSS.escape ponyfill
function cssEscape(id) {
  try { return CSS.escape(id); } catch { return String(id).replace(/[^a-zA-Z0-9_-]/g, s => `\\${s}`); }
}
