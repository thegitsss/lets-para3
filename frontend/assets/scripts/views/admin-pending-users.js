// frontend/assets/scripts/views/admin-pending-users.js

import { j } from "../helpers.js";
import { requireAuth } from "../auth.js";

let stylesInjected = false;

export async function render(el, { escapeHTML } = {}) {
  requireAuth("admin");
  ensureStyles();
  el.innerHTML = skeleton();

  try {
    const data = await j("/api/users?status=pending");
    draw(el, data.users || [], escapeHTML || ((s) => String(s ?? "")));
    wire(el);
  } catch (err) {
    showError(el, err?.message || "Unable to load pending users.");
  }
}

function draw(root, users, escapeHTML) {
  root.__pendingEscape = escapeHTML;
  if (!Array.isArray(users)) users = [];
  root.innerHTML = `
    <section class="pending-admin">
      <div class="section-title">Pending Users</div>
      ${
        users.length
          ? `
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Requested</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${users
              .map(
                (u) => `
                  <tr data-user="${escapeHTML(u._id || u.id || "")}">
                    <td>${escapeHTML(u.name || "—")}</td>
                    <td>${escapeHTML(u.email || "—")}</td>
                    <td>${escapeHTML(u.role || "—")}</td>
                    <td>${u.createdAt ? escapeHTML(new Date(u.createdAt).toLocaleString()) : "—"}</td>
                    <td class="actions">
                      <button class="btn approve" data-approve="${escapeHTML(u._id || u.id || "")}">Approve</button>
                      <button class="btn reject" data-reject="${escapeHTML(u._id || u.id || "")}">Reject</button>
                    </td>
                  </tr>`
              )
              .join("")}
          </tbody>
        </table>`
          : `<div class="empty">No pending users right now.</div>`
      }
    </section>
  `;

}

function showError(el, message) {
  el.innerHTML = `
    <section class="pending-admin">
      <div class="section-title">Pending Users</div>
      <div class="error">${message}</div>
    </section>
  `;
}

function skeleton() {
  return `
    <section class="pending-admin">
      <div class="section-title">Pending Users</div>
      <div class="loading">Loading…</div>
    </section>
  `;
}

function wire(root) {
  if (root.__pendingBound) return;
  root.__pendingBound = true;
  root.addEventListener("click", async (event) => {
    const approveId = event.target?.dataset?.approve;
    const rejectId = event.target?.dataset?.reject;
    if (!approveId && !rejectId) return;
    const btn = event.target;
    btn.disabled = true;
    try {
      if (approveId) {
        await j(`/api/users/${encodeURIComponent(approveId)}/approve`, { method: "PATCH" });
      } else if (rejectId) {
        await j(`/api/users/${encodeURIComponent(rejectId)}/reject`, { method: "PATCH" });
      }
      btn.closest("tr")?.remove();
      if (!root.querySelector("tbody tr")) {
        draw(root, [], root.__pendingEscape || ((s) => String(s ?? "")));
      }
    } catch (err) {
      alert(err?.message || "Action failed.");
      btn.disabled = false;
    }
  });
}

function ensureStyles() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = `
    .pending-admin{display:grid;gap:16px}
    .pending-admin table{width:100%;border-collapse:collapse}
    .pending-admin th,.pending-admin td{border:1px solid #e5e7eb;padding:10px;text-align:left;font-size:.95rem}
    .pending-admin th{background:#f9fafb;font-weight:600}
    .pending-admin .actions{display:flex;gap:8px}
    .pending-admin .btn{padding:6px 12px;border-radius:6px;border:1px solid transparent;cursor:pointer;font-weight:600}
    .pending-admin .btn.approve{background:#16a34a;color:#fff}
    .pending-admin .btn.reject{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
    .pending-admin .empty{color:#6b7280}
    .pending-admin .error{padding:12px;border:1px solid #fecaca;background:#fef2f2;border-radius:10px;color:#b91c1c}
    .pending-admin .loading{color:#6b7280}
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}
