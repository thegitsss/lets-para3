// frontend/assets/scripts/views/calendar.js
// Calendar with backend events (deadlines/meetings/etc.)
const API_BASE = "/api/events";
let CSRF = null;

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const STORAGE_KEY = "pc-cal-focus-ym"; // remember the last focused year-month

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
function keyFromDate(dt) { return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`; }

function startOfDayLocalISO(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  return t.toISOString();
}
function endOfDayLocalISO(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return t.toISOString();
}

/**
 * Convert a (date string, time string) pair into an ISO string using LOCAL wall time,
 * which keeps behavior sane across DST shifts.
 */
function atLocalISO(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const [hh = 9, mm = 0] = (timeStr ? String(timeStr).split(":").map(Number) : [9, 0]);
  const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
  return dt.toISOString();
}

function ensureStylesOnce() {
  if (document.getElementById("pc-calendar-styles")) return;
  const style = document.createElement("style");
  style.id = "pc-calendar-styles";
  style.textContent = `
  .cal-wrap{display:grid;gap:16px}
  .cal-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .cal-head .nav{display:flex;gap:8px}
  .cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
  .cal-dow{font-weight:600;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
  .cal-cell{border:1px solid #e5e7eb;border-radius:10px;min-height:120px;padding:8px;display:flex;flex-direction:column;gap:6px;background:#fff}
  .cal-cell:focus{outline:2px solid #111827;outline-offset:-2px}
  .cal-cell .date{font-weight:600;font-size:12px;color:#6b7280}
  .cal-cell.today{outline:2px solid #2563eb; outline-offset:-2px}
  .cal-cell.other{background:#fafafa;color:#9ca3af}
  .cal-ev{display:flex;align-items:center;gap:6px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:4px 6px;font-size:12px}
  .cal-ev .badge{font-size:10px;border-radius:999px;padding:2px 6px;border:1px solid #e5e7eb;white-space:nowrap}
  .cal-ev .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  .cal-ev .x{border:none;background:none;color:#6b7280;cursor:pointer;font-size:14px;line-height:1;padding:0 4px}
  .cal-ev .x:hover{color:#111827}
  .cal-form{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
  .cal-form input[type="text"]{flex:1 1 260px}
  .cal-form input, .cal-form button, .cal-form select{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px}
  .cal-form button{background:#111827;color:#fff;border-color:#111827;cursor:pointer}
  .btn{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
  .btn:disabled{opacity:.6;cursor:not-allowed}
  .badge-deadline{background:#fef3c7;border-color:#fcd34d}
  .badge-meeting{background:#dbeafe;border-color:#93c5fd}
  .badge-call{background:#e9d5ff;border-color:#c4b5fd}
  .badge-court{background:#fee2e2;border-color:#fca5a5}
  .badge-misc{background:#f3f4f6;border-color:#e5e7eb}
  .cal-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:none;align-items:center;justify-content:center;z-index:2000;padding:16px}
  .cal-modal-overlay.show{display:flex}
  .cal-modal{background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 24px 50px rgba(0,0,0,.2);width:min(720px,96vw);display:grid;gap:12px;padding:18px}
  .cal-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .cal-modal-title{font-weight:600;font-size:1.05rem}
  .cal-modal-close{border:none;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#6b7280}
  .cal-modal-close:hover{color:#111827}
  .cal-modal-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .cal-modal-form label{display:grid;gap:6px;font-size:.85rem;color:#374151}
  .cal-modal-form input,.cal-modal-form select{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px}
  .cal-modal-form .wide{grid-column:1/-1}
  .cal-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}
  .cal-modal-actions .btn.primary{background:#111827;color:#fff;border-color:#111827}
  .skel{background:linear-gradient(90deg,#eee 25%,#f5f5f5 37%,#eee 63%);background-size:400% 100%;animation:sk 1.4s ease infinite}
  @keyframes sk{0%{background-position:100% 0}100%{background-position:-100% 0}}
  .toast{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;border-radius:8px;padding:10px 14px;font-size:14px;box-shadow:0 10px 20px rgba(0,0,0,.15);z-index:9999}
  `;
  document.head.appendChild(style);
}

// map event types to labels and badge class
const TYPE_LABEL = { deadline: "Deadline", meeting: "Meeting", call: "Call", court: "Court", misc: "Other" };
const TYPE_BADGE = { deadline: "badge-deadline", meeting: "badge-meeting", call: "badge-call", court: "badge-court", misc: "badge-misc" };

// Tiny toast
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

// Fetch helpers with simple retry/backoff
async function xfetch(url, opts = {}, retries = 1) {
  const r = await fetch(url, { credentials: "include", ...opts });
  if (!r.ok) {
    if (retries > 0 && r.status >= 500) {
      await new Promise((res) => setTimeout(res, 300));
      return xfetch(url, opts, retries - 1);
    }
    const text = await r.text().catch(() => "");
    throw new Error(text || "Request failed");
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.text();
}

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

// -----------------------------
// View
// -----------------------------
export async function render(el) {
  ensureStylesOnce();

  el.innerHTML = `
    <div class="section cal-wrap" aria-label="Calendar" role="region">
      <div class="section-title">Calendar</div>
      <div class="cal-head">
        <div class="nav" role="group" aria-label="Month navigation">
          <button class="btn" data-nav="prev" aria-label="Previous month">‹</button>
          <button class="btn" data-nav="today" aria-label="Jump to today">Today</button>
          <button class="btn" data-nav="next" aria-label="Next month">›</button>
        </div>
        <div class="month-title" style="font-weight:700;" aria-live="polite"></div>
      </div>

      <form class="cal-form" autocomplete="off" aria-label="Add event">
        <label>Date <input required name="date" type="date"></label>
        <label>Start <input name="start" type="time" placeholder="HH:MM"></label>
        <label>End <input name="end" type="time" placeholder="HH:MM"></label>
        <label>Type
          <select name="type">
            <option value="deadline">Deadline</option>
            <option value="meeting">Meeting</option>
            <option value="call">Call</option>
            <option value="court">Court</option>
            <option value="misc">Other</option>
          </select>
        </label>
        <label style="flex:1 1 260px;">Title <input required name="title" type="text" placeholder="e.g., File motion; Zoom with paralegal" maxlength="200"></label>
        <label>Link/Loc <input name="where" type="text" placeholder="Zoom or location (optional)"></label>
        <label>Case ID <input name="caseId" type="text" inputmode="latin" pattern="[a-fA-F0-9]{24}" title="24-char Mongo ID (optional)"></label>
        <button type="submit">Add</button>
      </form>

      <div class="cal-grid cal-dows" aria-hidden="true"></div>
      <div class="cal-grid cal-days" role="grid" aria-label="Month grid"></div>
    </div>
    <div class="cal-modal-overlay" data-cal-modal hidden aria-hidden="true">
      <div class="cal-modal" role="dialog" aria-modal="true" aria-labelledby="calModalTitle">
        <div class="cal-modal-head">
          <div class="cal-modal-title" id="calModalTitle">Add calendar item</div>
          <button type="button" class="cal-modal-close" data-cal-modal-close aria-label="Close">×</button>
        </div>
        <form class="cal-modal-form" autocomplete="off">
          <label>Date <input required name="date" type="date"></label>
          <label>Start <input name="start" type="time" placeholder="HH:MM"></label>
          <label>End <input name="end" type="time" placeholder="HH:MM"></label>
          <label>Type
            <select name="type">
              <option value="deadline">Deadline</option>
              <option value="meeting">Meeting</option>
              <option value="call">Call</option>
              <option value="court">Court</option>
              <option value="misc">Other</option>
            </select>
          </label>
          <label class="wide">Title <input required name="title" type="text" placeholder="e.g., File motion; Zoom with paralegal" maxlength="200"></label>
          <label class="wide">Link/Loc <input name="where" type="text" placeholder="Zoom or location (optional)"></label>
          <label class="wide">Case ID <input name="caseId" type="text" inputmode="latin" pattern="[a-fA-F0-9]{24}" title="24-char Mongo ID (optional)"></label>
          <div class="cal-modal-actions wide">
            <button type="button" class="btn" data-cal-modal-cancel>Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const dows = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const dowsEl = el.querySelector(".cal-dows");
  dows.forEach(txt => {
    const div = document.createElement("div");
    div.className = "cal-dow";
    div.textContent = txt;
    dowsEl.appendChild(div);
  });

  const titleEl = el.querySelector(".month-title");
  const daysEl = el.querySelector(".cal-days");
  const formEl = el.querySelector(".cal-form");
  const modalOverlay = el.querySelector("[data-cal-modal]");
  const modalForm = modalOverlay?.querySelector("form");
  const modalCloseBtn = modalOverlay?.querySelector("[data-cal-modal-close]");
  const modalCancelBtn = modalOverlay?.querySelector("[data-cal-modal-cancel]");

  // Focus month persistence
  let focus = (() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const [y, m] = saved.split("-").map(Number);
      return new Date(y, (m || 1) - 1, 1);
    }
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  })();

  // cache of currently loaded events by ISO day key -> array
  let dayMap = {};
  let inflight; // AbortController

  function skeletonDays() {
    daysEl.innerHTML = "";
    for (let i = 0; i < 42; i++) {
      const sk = document.createElement("div");
      sk.className = "cal-cell skel";
      daysEl.appendChild(sk);
    }
  }

  async function loadMonth() {
    inflight?.abort();
    inflight = new AbortController();

    const y = focus.getFullYear();
    const m = focus.getMonth();
    const from = new Date(y, m, 1);
    const to = new Date(y, m + 1, 0);

    // small buffer either side so prev/next day clicks feel instant
    const fromISO = startOfDayLocalISO(new Date(from.getFullYear(), from.getMonth(), from.getDate() - 7));
    const toISO = endOfDayLocalISO(new Date(to.getFullYear(), to.getMonth(), to.getDate() + 7));

    skeletonDays();
    const j = await apiList(fromISO, toISO, inflight.signal).catch((e) => {
      daysEl.innerHTML = "";
      toast("Failed to load events");
      throw e;
    });

    dayMap = {};
    const items = (j.items || j) || [];
    for (const ev of items) {
      const d = new Date(ev.start);
      const k = keyFromDate(d);
      (dayMap[k] ||= []).push(ev);
    }
  }

  function renderMonth() {
    const y = focus.getFullYear();
    const m = focus.getMonth();

    titleEl.textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(focus);
    localStorage.setItem(STORAGE_KEY, `${y}-${pad(m + 1)}`);

    daysEl.innerHTML = "";
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevMonthDays = new Date(y, m, 0).getDate();

    // leading
    for (let i = 0; i < firstDow; i++) {
      const d = prevMonthDays - firstDow + 1 + i;
      daysEl.appendChild(makeCell(new Date(y, m - 1, d), true));
    }
    // month
    for (let d = 1; d <= daysInMonth; d++) {
      daysEl.appendChild(makeCell(new Date(y, m, d), false));
    }
    // trailing
    const totalCells = firstDow + daysInMonth;
    const trailing = (7 - (totalCells % 7)) % 7;
    for (let i = 1; i <= trailing; i++) {
      daysEl.appendChild(makeCell(new Date(y, m + 1, i), true));
    }
  }

  function makeCell(dt, otherMonth) {
    const cell = document.createElement("div");
    cell.className = "cal-cell" + (otherMonth ? " other" : "");
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("tabindex", "0");
    cell.dataset.date = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}`;

    const today = new Date();
    if (dt.toDateString() === today.toDateString()) cell.classList.add("today");

    const head = document.createElement("div");
    head.className = "date";
    head.textContent = dt.getDate();
    cell.appendChild(head);

    const k = keyFromDate(dt);
    const items = (dayMap[k] || []).slice().sort((a,b) => String(a.start).localeCompare(String(b.start)));

    items.forEach(ev => {
      const row = document.createElement("div");
      row.className = "cal-ev";

      const badge = document.createElement("span");
      badge.className = `badge ${TYPE_BADGE[ev.type] || "badge-misc"}`;
      badge.textContent = TYPE_LABEL[ev.type] || "Event";

      const t = document.createElement("div");
      t.className = "t";
      const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ev.start));
      t.textContent = `${time} · ${ev.title}`;

      const x = document.createElement("button");
      x.className = "x";
      x.type = "button";
      x.title = "Remove";
      x.setAttribute("aria-label", `Delete ${ev.title}`);
      x.textContent = "×";
      x.addEventListener("click", async () => {
        if (!confirm("Delete this event?")) return;
        // optimistic removal
        const idx = dayMap[k]?.indexOf(ev);
        if (idx >= 0) {
          dayMap[k].splice(idx, 1);
          renderMonth();
        }
        try {
          await apiDelete(ev.id || ev._id);
          toast("Event deleted");
        } catch (e) {
          toast("Failed to delete");
          // reload real state
          await loadMonth().catch(() => {});
          renderMonth();
        }
      });

      row.appendChild(badge);
      row.appendChild(t);
      row.appendChild(x);
      cell.appendChild(row);
    });

    // open modal for date add
    cell.addEventListener("click", (e) => {
      if (e.target.closest(".x")) return;
      if (modalForm) {
        openModal(cell.dataset.date);
      } else {
        formEl.date.value = cell.dataset.date;
        formEl.title.focus();
      }
    });

    // keyboard nav between cells
    cell.addEventListener("keydown", (e) => {
      const idx = Array.from(daysEl.children).indexOf(cell);
      if (idx < 0) return;
      const rowLen = 7;
      let to = null;
      if (e.key === "ArrowRight") to = idx + 1;
      else if (e.key === "ArrowLeft") to = idx - 1;
      else if (e.key === "ArrowDown") to = idx + rowLen;
      else if (e.key === "ArrowUp") to = idx - rowLen;
      if (e.key === "Enter" || e.key === " ") {
        if (modalForm) {
          openModal(cell.dataset.date);
          e.preventDefault();
        }
        return;
      }
      if (to != null) {
        const target = daysEl.children[to];
        if (target) target.focus();
        e.preventDefault();
      }
    });

    return cell;
  }

  // nav
  el.querySelector('[data-nav="prev"]').addEventListener("click", async () => {
    focus.setMonth(focus.getMonth() - 1);
    await loadMonth();
    renderMonth();
  });
  el.querySelector('[data-nav="next"]').addEventListener("click", async () => {
    focus.setMonth(focus.getMonth() + 1);
    await loadMonth();
    renderMonth();
  });
  el.querySelector('[data-nav="today"]').addEventListener("click", async () => {
    const now = new Date();
    focus = new Date(now.getFullYear(), now.getMonth(), 1);
    await loadMonth();
    renderMonth();
  });

  // submit
  const formSubmitBtn = formEl?.querySelector('button[type="submit"]');
  const defaultSubmitText = formSubmitBtn?.textContent || "Add";

  const scheduleFormReset = (form, button, defaultText) => {
    if (!form || !button) return;
    const handler = () => {
      button.disabled = false;
      button.textContent = defaultText;
      form.removeEventListener("input", handler);
    };
    form.addEventListener("input", handler, { once: true });
  };

  const openModal = (dateStr = "") => {
    if (!modalOverlay || !modalForm) return;
    modalOverlay.hidden = false;
    modalOverlay.setAttribute("aria-hidden", "false");
    modalOverlay.classList.add("show");
    if (dateStr) modalForm.date.value = dateStr;
    modalForm.title.focus();
  };

  const closeModal = () => {
    if (!modalOverlay) return;
    modalOverlay.classList.remove("show");
    modalOverlay.setAttribute("aria-hidden", "true");
    modalOverlay.hidden = true;
  };

  modalCloseBtn?.addEventListener("click", closeModal);
  modalCancelBtn?.addEventListener("click", closeModal);
  modalOverlay?.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modalOverlay && modalOverlay.classList.contains("show")) {
      closeModal();
    }
  });

  async function submitEvent(form, { resetButtonOnInput = false, afterSuccess } = {}) {
    const date = form?.date?.value;
    const title = form?.title?.value?.trim?.() || "";
    if (!date || !title) return;

    const st = form.start.value;
    const en = form.end.value;
    if (st && en) {
      const sDt = new Date(atLocalISO(date, st));
      const eDt = new Date(atLocalISO(date, en));
      if (eDt < sDt) {
        toast("End time is before start time");
        form.end.focus();
        return;
      }
    }

    const payload = {
      title,
      start: atLocalISO(date, st),
      end: en ? atLocalISO(date, en) : undefined,
      type: form.type.value || "misc",
      where: form.where.value.trim(),
      caseId: form.caseId.value.trim() || undefined,
    };

    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn?.textContent || "Save";

    const tempId = "tmp_" + Math.random().toString(36).slice(2);
    const k = keyFromDate(new Date(payload.start));
    (dayMap[k] ||= []).push({ id: tempId, ...payload });
    renderMonth();

    let restoreButton = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
    }
    try {
      await apiCreate(payload);
      toast("Event added");
      form.reset();
      await loadMonth();
      renderMonth();
      if (resetButtonOnInput) {
        scheduleFormReset(form, submitBtn, originalText);
      } else if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
      restoreButton = false;
      if (typeof afterSuccess === "function") afterSuccess();
    } catch (err) {
      dayMap[k] = (dayMap[k] || []).filter((e) => e.id !== tempId);
      renderMonth();
      toast("Failed to add event");
    } finally {
      if (restoreButton && submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
    }
  }

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    await submitEvent(formEl, { resetButtonOnInput: true });
  });

  modalForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    await submitEvent(modalForm, { afterSuccess: closeModal });
  });

  // initial load
  await loadMonth();
  renderMonth();
}
