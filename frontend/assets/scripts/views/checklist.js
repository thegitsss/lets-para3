// frontend/assets/scripts/views/checklist.js
// Case-aware checklist (deadlines, todos). Requires backend routes at /api/checklist.
// Cookie-based auth + CSRF cookie flow.

import { j } from "../helpers.js";

const API_BASE = "/api/checklist";

function ensureStylesOnce() {
  if (document.getElementById("pc-checklist-styles")) return;
  const style = document.createElement("style");
  style.id = "pc-checklist-styles";
  style.textContent = `
  .chk-wrap{display:grid;gap:16px}
  .chk-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .chk-toolbar input,.chk-toolbar select{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px}
  .chk-toolbar .btn{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
  .chk-form{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
  .chk-form input,.chk-form button,.chk-form textarea{padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px}
  .chk-form textarea{min-width:260px;min-height:38px}
  .chk-form button{background:#111827;color:#fff;border-color:#111827;cursor:pointer}
  .chk-list{display:grid;gap:8px}
  .chk-item{display:grid;grid-template-columns:auto 1fr auto;align-items:start;gap:10px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;padding:10px}
  .chk-item.done{opacity:.65}
  .chk-title{font-weight:600}
  .chk-meta{font-size:12px;color:#6b7280;display:flex;gap:10px;flex-wrap:wrap}
  .chk-actions{display:flex;gap:6px}
  .chk-actions .btn{padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}
  .tag{border:1px solid #e5e7eb;border-radius:6px;padding:2px 6px}
  .overdue{background:#fff7f7;border-color:#fecaca}
  .due-today{background:#eef2ff;border-color:#c7d2fe}
  .skel .line{height:14px;background:#f3f4f6;border-radius:6px;animation:sh 1.2s infinite}
  @keyframes sh{0%{opacity:.6}50%{opacity:1}100%{opacity:.6}}
  .toast{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;border-radius:8px;padding:10px 14px;font-size:14px;box-shadow:0 10px 20px rgba(0,0,0,.15);z-index:9999}
  `;
  document.head.appendChild(style);
}

function toast(msg) {
  clearTimeout(window.__chkToastT);
  let el = document.getElementById("chk-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "chk-toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  window.__chkToastT = setTimeout(() => (el.style.display = "none"), 2200);
}

let inflight; // AbortController

async function apiList(params = {}) {
  inflight?.abort();
  inflight = new AbortController();
  const url = new URL(API_BASE, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  return j(url.toString(), { signal: inflight.signal });
}
async function apiCreate(body) {
  return j(API_BASE, {
    method: "POST",
    body,
  });
}
async function apiUpdate(id, body) {
  return j(`${API_BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}
async function apiDelete(id) {
  return j(`${API_BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function render(el) {
  ensureStylesOnce();

  el.innerHTML = `
    <div class="section chk-wrap" aria-label="Checklist" role="region">
      <div class="section-title">Checklist</div>

      <div class="chk-toolbar" role="group" aria-label="Filters">
        <input type="search" name="q" placeholder="Search tasks…">
        <select name="status" title="Status filter">
          <option value="open">Open</option>
          <option value="done">Completed</option>
          <option value="all">All</option>
        </select>
        <input type="text" name="caseId" placeholder="Filter by Case ID (optional)" inputmode="latin" pattern="[a-fA-F0-9]{24}" title="24-char Mongo ID">
        <button class="btn" data-act="refresh">Refresh</button>
      </div>

      <form class="chk-form" autocomplete="off" aria-label="Add task">
        <label>Title <input required name="title" type="text" placeholder="e.g., File motion, prep exhibits" maxlength="200"></label>
        <label>Due <input name="due" type="date"></label>
        <label>Case ID <input name="caseId" type="text" placeholder="(optional)" pattern="[a-fA-F0-9]{24}"></label>
        <label style="flex: 1 1 260px;">Notes
          <textarea name="notes" placeholder="(optional) brief notes" maxlength="1000"></textarea>
        </label>
        <button type="submit">Add</button>
      </form>

      <div class="chk-list" aria-live="polite"></div>
    </div>
  `;

  const toolbar = el.querySelector(".chk-toolbar");
  const listEl = el.querySelector(".chk-list");
  const formEl = el.querySelector(".chk-form");

  function skeleton() {
    listEl.innerHTML = `
      <div class="skel" style="display:grid;gap:8px">
        ${Array.from({length:4}).map(() => `
          <div class="chk-item">
            <div class="line" style="width:18px;height:18px;border-radius:4px"></div>
            <div style="display:grid;gap:6px">
              <div class="line" style="width:60%"></div>
              <div class="line" style="width:40%"></div>
            </div>
            <div class="line" style="width:80px"></div>
          </div>`).join("")}
      </div>
    `;
  }

  async function loadAndRender() {
    skeleton();
    const q = toolbar.querySelector('[name="q"]').value.trim();
    const status = toolbar.querySelector('[name="status"]').value;
    const caseId = toolbar.querySelector('[name="caseId"]').value.trim();
    try {
      const { items = [] } = await apiList({ q, status, caseId });
      // sort: due soonest first, then createdAt asc (if present)
      items.sort((a, b) => {
        const da = a.due ? new Date(a.due).getTime() : Infinity;
        const db = b.due ? new Date(b.due).getTime() : Infinity;
        if (da !== db) return da - db;
        const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return ca - cb;
      });
      draw(items);
    } catch {
      listEl.innerHTML = `<div style="color:#b91c1c;">Failed to load tasks.</div>`;
    }
  }

  function draw(items) {
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.innerHTML = `<div style="color:#6b7280;">No tasks found.</div>`;
      return;
    }
    for (const t of items) {
      const row = document.createElement("div");
      row.className = "chk-item" + (t.done ? " done" : "");
      row.dataset.id = t.id || t._id;

      // due state styling
      const cls = dueClass(t.due);
      if (cls) row.classList.add(cls);

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!t.done;
      cb.title = "Mark complete";
      cb.addEventListener("change", async () => {
        // optimistic toggle
        row.classList.toggle("done", cb.checked);
        try {
          await apiUpdate(row.dataset.id, { done: cb.checked });
          toast(cb.checked ? "Marked complete" : "Marked open");
        } catch {
          cb.checked = !cb.checked;
          row.classList.toggle("done", cb.checked);
          toast("Update failed");
        }
      });

      const main = document.createElement("div");
      const title = document.createElement("div");
      title.className = "chk-title";
      title.textContent = t.title;

      const meta = document.createElement("div");
      meta.className = "chk-meta";
      if (t.due) {
        const d = new Date(t.due);
        meta.appendChild(tag(`Due ${d.toLocaleDateString(undefined,{month:"short",day:"numeric"})}`));
      }
      if (t.caseId) meta.appendChild(tag(`Case ${String(t.caseId).slice(0,8)}…`));
      if (t.notes) meta.appendChild(tag(String(t.notes)));

      main.appendChild(title);
      main.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "chk-actions";

      const btnEdit = button("Edit", async () => {
        const newTitle = prompt("Edit title:", t.title);
        if (newTitle === null) return;
        const newDue = prompt("Edit due date (YYYY-MM-DD or blank):", t.due ? t.due.slice(0,10) : "");
        const newNotes = prompt("Edit notes:", t.notes || "");
        try {
          await apiUpdate(row.dataset.id, {
            title: newTitle.trim(),
            due: newDue ? new Date(newDue + "T00:00:00").toISOString() : null,
            notes: (newNotes || "").trim(),
          });
          toast("Saved");
          await loadAndRender();
        } catch {
          toast("Failed to save");
        }
      });

      const btnDel = button("Delete", async () => {
        if (!confirm("Delete this task?")) return;
        // optimistic remove
        const anchor = row.nextElementSibling;
        row.remove();
        try {
          await apiDelete(row.dataset.id);
          toast("Deleted");
          // If list is empty after optimistic remove, reload to be sure
          if (!listEl.children.length) await loadAndRender();
        } catch {
          toast("Delete failed");
          // reinsert roughly where it was
          if (anchor) listEl.insertBefore(row, anchor); else listEl.appendChild(row);
        }
      });

      actions.appendChild(btnEdit);
      actions.appendChild(btnDel);

      row.appendChild(cb);
      row.appendChild(main);
      row.appendChild(actions);
      listEl.appendChild(row);
    }
  }

  function tag(text) {
    const span = document.createElement("span");
    span.className = "tag";
    span.textContent = text;
    return span;
  }
  function button(label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function dueClass(due) {
    if (!due) return "";
    const d = new Date(due);
    const startToday = new Date(); startToday.setHours(0,0,0,0);
    const endToday = new Date();   endToday.setHours(23,59,59,999);
    if (d < startToday) return "overdue";
    if (d >= startToday && d <= endToday) return "due-today";
    return "";
    }

  // events
  toolbar.querySelector('[data-act="refresh"]').addEventListener("click", loadAndRender);
  toolbar.querySelector('[name="q"]').addEventListener("input", debounce(loadAndRender, 250));
  toolbar.querySelector('[name="status"]').addEventListener("change", loadAndRender);
  toolbar.querySelector('[name="caseId"]').addEventListener("input", debounce(loadAndRender, 250));

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = formEl.title.value.trim();
    if (!title) return;
    // simple pattern check for Case ID (optional)
    const caseIdRaw = formEl.caseId.value.trim();
    if (caseIdRaw && !/^[a-fA-F0-9]{24}$/.test(caseIdRaw)) {
      alert("Case ID must be a 24-char hex string"); return;
    }
    const due = formEl.due.value ? new Date(formEl.due.value + "T00:00:00").toISOString() : undefined;
    const caseId = caseIdRaw || undefined;
    const notes = formEl.notes.value.trim() || undefined;

    // optimistic add
    const tempId = "tmp_" + Math.random().toString(36).slice(2);
    const temp = { id: tempId, title, due, caseId, notes, done: false, createdAt: new Date().toISOString() };
    draw([temp, ...Array.from(listEl.children).map(rowToTask)]);

    try {
      await apiCreate({ title, due, caseId, notes });
      formEl.reset();
      await loadAndRender();
      toast("Task added");
    } catch {
      toast("Failed to add task");
      await loadAndRender(); // rollback to server truth
    }
  });

  function rowToTask(row) {
    const id = row.dataset.id;
    const title = row.querySelector(".chk-title")?.textContent || "";
    const dueTag = [...row.querySelectorAll(".tag")].find(t => t.textContent.startsWith("Due "));
    const due = dueTag ? new Date(dueTag.textContent.replace(/^Due /,"") + " " + new Date().getFullYear()).toISOString() : undefined;
    return { id, title, due, done: row.classList.contains("done") };
  }

  // initial
  await loadAndRender();
}
