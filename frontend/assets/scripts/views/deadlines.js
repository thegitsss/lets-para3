// frontend/assets/scripts/views/deadlines.js
// Deadlines view (lists only events with type="deadline")
const API_BASE = "/api/events";
let CSRF = null;

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// -----------------------------
// Utilities
// -----------------------------
async function getCSRF() {
  if (CSRF) return CSRF;
  const r = await fetch("/api/csrf", { credentials: "include" });
  const j = await r.json().catch(() => ({}));
  CSRF = j.csrfToken;
  return CSRF;
}

function pad(n) { return String(n).padStart(2, "0"); }
function fmtDate(dt) {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(dt);
}
function fmtTime(dt) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(dt);
}
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0); }
function endOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999); }

/** Convert local date+time to ISO, DST-safe (same method as calendar) */
function atLocalISO(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const [hh = 9, mm = 0] = (timeStr ? String(timeStr).split(":").map(Number) : [9, 0]);
  const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
  return dt.toISOString();
}

function ensureStylesOnce() {
  if (document.getElementById("pc-deadline-styles")) return;
  const style = document.createElement("style");
  style.id = "pc-deadline-styles";
  style.textContent = `
  .dl-wrap{display:grid;gap:16px}
  .dl-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .filters{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
  .filters input, .filters select, .filters button{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px}
  .filters button{background:#111827;color:#fff;border-color:#111827;cursor:pointer}
  .btn{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
  .list{display:grid;gap:8px}
  .row{display:grid;grid-template-columns: 1fr auto; gap:8px; align-items:center; background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:10px}
  .row-main{display:flex;flex-direction:column;gap:4px; min-width:0}
  .ttl{font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .meta{display:flex; gap:10px; font-size:12px; color:#6b7280; flex-wrap:wrap}
  .meta .pill{background:#fef3c7; border:1px solid #fcd34d; color:#733; border-radius:999px; padding:2px 8px}
  .meta .loc{white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:50ch}
  .actions{display:flex; gap:8px}
  .x{border:none;background:none;color:#6b7280;cursor:pointer;font-size:14px;line-height:1;padding:6px 8px}
  .x:hover{color:#111827}
  .skel{height:54px;background:linear-gradient(90deg,#eee 25%,#f5f5f5 37%,#eee 63%);background-size:400% 100%;animation:sk 1.4s ease infinite;border-radius:10px}
  @keyframes sk{0%{background-position:100% 0}100%{background-position:-100% 0}}
  .overdue{color:#b91c1c}
  .soon{color:#92400e}
  .ok{color:#065f46}
  .toolbar{display:flex; gap:8px; flex-wrap:wrap}
  .toast{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;border-radius:8px;padding:10px 14px;font-size:14px;box-shadow:0 10px 20px rgba(0,0,0,.15);z-index:9999}
  `;
  document.head.appendChild(style);
}

// small toast
let toastT;
function toast(msg) {
  clearTimeout(toastT);
  let el = document.getElementById("pc-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "pc-toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  toastT = setTimeout(() => (el.style.display = "none"), 2500);
}

// fetch with tiny retry
async function xfetch(url, opts = {}, retries = 1) {
  const r = await fetch(url, { credentials: "include", ...opts });
  if (!r.ok) {
    if (retries > 0 && r.status >= 500) {
      await new Promise((res) => setTimeout(res, 250));
      return xfetch(url, opts, retries - 1);
    }
    const text = await r.text().catch(() => "");
    throw new Error(text || "Request failed");
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.text();
}

// API helpers
async function apiList(fromISO, toISO, signal) {
  const url = new URL(API_BASE, location.origin);
  url.searchParams.set("from", fromISO);
  url.searchParams.set("to", toISO);
  return xfetch(url, { signal });
}
async function apiCreate(payload) {
  return xfetch(API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": await getCSRF(),
      "X-Timezone": TZ
    },
    body: JSON.stringify(payload),
  });
}
async function apiDelete(id) {
  return xfetch(`${API_BASE}/${id}`, {
    method: "DELETE",
    headers: {
      "X-CSRF-Token": await getCSRF(),
      "X-Timezone": TZ
    },
  });
}

// date helpers
function daysDiff(a, b) {
  const A = startOfDay(a).getTime();
  const B = startOfDay(b).getTime();
  return Math.round((A - B) / 86400000);
}
function statusClassAndText(deadline) {
  const today = new Date();
  const diff = daysDiff(deadline, today); // positive if in future
  if (diff < 0) return { cls: "overdue", txt: `${Math.abs(diff)} day${Math.abs(diff)===1?"":"s"} overdue` };
  if (diff === 0) return { cls: "soon", txt: "today" };
  if (diff <= 3) return { cls: "soon", txt: `in ${diff} day${diff===1?"":"s"}` };
  if (diff <= 7) return { cls: "ok", txt: `in ${diff} days` };
  return { cls: "ok", txt: `in ${diff} days` };
}

// Exports (CSV/ICS)
function exportCSV(items) {
  const rows = [
    ["Title","Date","Time","CaseId","Location","Notes"].join(",")
  ];
  for (const ev of items) {
    const dt = new Date(ev.start);
    const date = dt.toISOString().slice(0,10);
    const time = fmtTime(dt).replace(",", "");
    const cells = [
      (ev.title || "").replace(/"/g,'""'),
      date,
      time,
      ev.caseId || "",
      (ev.where || "").replace(/"/g,'""'),
      ""
    ];
    rows.push(cells.map(v => `"${v}"`).join(","));
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "deadlines.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toICSDate(dt) {
  // YYYYMMDDTHHMMSSZ
  const iso = new Date(dt).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
  return iso.slice(0,15) + "Z";
}
function exportICS(items) {
  const lines = [
    "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//ParaConnect//Deadlines//EN"
  ];
  for (const ev of items) {
    const uid = (ev.id || ev._id || Math.random().toString(36).slice(2)) + "@lets-paraconnect";
    const dtstart = toICSDate(ev.start);
    const dtstamp = toICSDate(new Date());
    const summary = (ev.title || "").replace(/(\r?\n)/g, " ");
    const location = (ev.where || "").replace(/(\r?\n)/g, " ");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${dtstart}`,
      `SUMMARY:${summary}`,
      location ? `LOCATION:${location}` : "",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.filter(Boolean).join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "deadlines.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// -----------------------------
// View
// -----------------------------
export async function render(el) {
  ensureStylesOnce();

  el.innerHTML = `
    <div class="section dl-wrap" aria-label="Deadlines" role="region">
      <div class="dl-head">
        <div class="section-title">Deadlines</div>
        <div class="toolbar">
          <button class="btn" data-export="csv" title="Export CSV">Export CSV</button>
          <button class="btn" data-export="ics" title="Export iCalendar (.ics)">Export ICS</button>
        </div>
      </div>

      <form class="filters" autocomplete="off">
        <label>Range
          <select name="range">
            <option value="7">Next 7 days</option>
            <option value="30" selected>Next 30 days</option>
            <option value="90">Next 90 days</option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        <label>From <input type="date" name="from" disabled></label>
        <label>To <input type="date" name="to" disabled></label>
        <button type="submit">Apply</button>
      </form>

      <form class="add" autocomplete="off" aria-label="Add deadline" style="display:flex;flex-wrap:wrap;gap:8px;align-items:end">
        <label>Date <input required name="date" type="date"></label>
        <label>Time <input name="time" type="time" placeholder="HH:MM"></label>
        <label style="flex:1 1 260px;">Title <input required name="title" type="text" maxlength="200" placeholder="e.g., File motion"></label>
        <label>Case ID <input name="caseId" type="text" pattern="[a-fA-F0-9]{24}" title="24-char Mongo ID (optional)"></label>
        <label>Location <input name="where" type="text" placeholder="(optional)"></label>
        <button type="submit">Add</button>
      </form>

      <div class="list" aria-live="polite"></div>
    </div>
  `;

  const listEl = el.querySelector(".list");
  const filtersEl = el.querySelector(".filters");
  const addEl = el.querySelector(".add");

  let items = []; // current list
  let inflight;

  // range state
  function getRange() {
    const v = filtersEl.range.value;
    if (v === "custom") {
      const from = filtersEl.from.value ? new Date(filtersEl.from.value) : startOfDay(new Date());
      const to = filtersEl.to.value ? endOfDay(new Date(filtersEl.to.value)) : endOfDay(new Date(Date.now() + 30*86400000));
      return { from, to };
    }
    const days = parseInt(v, 10) || 30;
    const from = startOfDay(new Date());
    const to = endOfDay(new Date(Date.now() + days*86400000));
    return { from, to };
  }

  filtersEl.range.addEventListener("change", () => {
    const custom = filtersEl.range.value === "custom";
    filtersEl.from.disabled = !custom;
    filtersEl.to.disabled = !custom;
  });

  const filterSubmitBtn = filtersEl?.querySelector('button[type="submit"]');
  const filterDefaultText = filterSubmitBtn?.textContent || "Apply";

  const scheduleFilterReset = () => {
    if (!filtersEl || !filterSubmitBtn) return;
    const handler = () => {
      filterSubmitBtn.disabled = false;
      filterSubmitBtn.textContent = filterDefaultText;
      filtersEl.removeEventListener("input", handler);
      filtersEl.removeEventListener("change", handler);
    };
    filtersEl.addEventListener("input", handler, { once: true });
    filtersEl.addEventListener("change", handler, { once: true });
  };

  filtersEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    let restoreButton = true;
    if (filterSubmitBtn) {
      filterSubmitBtn.disabled = true;
      filterSubmitBtn.textContent = "Loading…";
    }
    try {
      await loadAndRender();
      scheduleFilterReset();
      restoreButton = false;
    } finally {
      if (restoreButton && filterSubmitBtn) {
        filterSubmitBtn.disabled = false;
        filterSubmitBtn.textContent = filterDefaultText;
      }
    }
  });

  // exports
  el.querySelector('[data-export="csv"]').addEventListener("click", () => exportCSV(items));
  el.querySelector('[data-export="ics"]').addEventListener("click", () => exportICS(items));

  function skeleton(n = 5) {
    listEl.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const sk = document.createElement("div");
      sk.className = "skel";
      listEl.appendChild(sk);
    }
  }

  function renderList() {
    listEl.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.textContent = "No deadlines in the selected range.";
      empty.style.color = "#6b7280";
      listEl.appendChild(empty);
      return;
    }

    for (const ev of items) {
      const row = document.createElement("div");
      row.className = "row";

      const main = document.createElement("div");
      main.className = "row-main";

      const ttl = document.createElement("div");
      ttl.className = "ttl";
      ttl.textContent = ev.title || "(untitled)";
      main.appendChild(ttl);

      const meta = document.createElement("div");
      meta.className = "meta";

      const d = new Date(ev.start);
      const { cls, txt } = statusClassAndText(d);
      const when = document.createElement("span");
      when.innerHTML = `<strong>${fmtDate(d)}</strong> · ${fmtTime(d)} · <span class="${cls}">${txt}</span>`;
      meta.appendChild(when);

      if (ev.caseId) {
        const pill = document.createElement("span");
        pill.className = "pill";
        pill.textContent = `Case ${String(ev.caseId).slice(-6)}`;
        meta.appendChild(pill);
      }

      if (ev.where) {
        const loc = document.createElement("span");
        loc.className = "loc";
        loc.textContent = ev.where;
        meta.appendChild(loc);
      }

      main.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "actions";

      const del = document.createElement("button");
      del.className = "x";
      del.type = "button";
      del.title = "Delete";
      del.setAttribute("aria-label", `Delete ${ev.title}`);
      del.textContent = "×";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this deadline?")) return;
        // optimistic remove
        const old = items.slice();
        items = items.filter((x) => (x.id || x._id) !== (ev.id || ev._id));
        renderList();
        try {
          await apiDelete(ev.id || ev._id);
          toast("Deadline deleted");
        } catch {
          items = old;
          renderList();
          toast("Failed to delete");
        }
      });

      actions.appendChild(del);

      row.appendChild(main);
      row.appendChild(actions);
      listEl.appendChild(row);
    }
  }

  async function loadAndRender() {
    inflight?.abort?.();
    const ctrl = new AbortController();
    inflight = ctrl;

    const { from, to } = getRange();
    skeleton(6);
    const j = await apiList(startOfDay(from).toISOString(), endOfDay(to).toISOString(), ctrl.signal).catch(() => {
      listEl.innerHTML = "";
      toast("Failed to load deadlines");
      return { items: [] };
    });

    // Keep only deadlines; sort ascending by start date
    items = ((j.items || j) || [])
      .filter(ev => (ev.type || "misc") === "deadline")
      .sort((a,b) => new Date(a.start) - new Date(b.start));

    renderList();
  }

  // quick add
  const addSubmitBtn = addEl.querySelector('button[type="submit"]');
  const addDefaultText = addSubmitBtn?.textContent || "Add";

  addEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = addEl.title.value.trim();
    const date = addEl.date.value;
    if (!title || !date) return;

    const time = addEl.time.value;
    const payload = {
      title,
      type: "deadline",
      start: atLocalISO(date, time),
      end: undefined,
      where: addEl.where.value.trim() || undefined,
      caseId: addEl.caseId.value.trim() || undefined,
    };

    // optimistic add
    const temp = { id: "tmp_"+Math.random().toString(36).slice(2), ...payload };
    items = items.concat([temp]).sort((a,b) => new Date(a.start) - new Date(b.start));
    renderList();

    let restoreButton = true;
    if (addSubmitBtn) {
      addSubmitBtn.disabled = true;
      addSubmitBtn.textContent = "Saving…";
    }
    try {
      await apiCreate(payload);
      toast("Deadline added");
      addEl.reset();
      await loadAndRender();
      scheduleAddButtonReset();
      restoreButton = false;
    } catch {
      items = items.filter(x => x.id !== temp.id);
      renderList();
      toast("Failed to add");
    } finally {
      if (restoreButton && addSubmitBtn) {
        addSubmitBtn.disabled = false;
        addSubmitBtn.textContent = addDefaultText;
      }
    }
  });

  function scheduleAddButtonReset() {
    if (!addEl || !addSubmitBtn) return;
    const handler = () => {
      addSubmitBtn.disabled = false;
      addSubmitBtn.textContent = addDefaultText;
      addEl.removeEventListener("input", handler);
    };
    addEl.addEventListener("input", handler, { once: true });
  }

  // initial
  await loadAndRender();
}
