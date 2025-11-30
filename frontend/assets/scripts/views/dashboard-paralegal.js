// frontend/assets/scripts/views/dashboard-paralegal.js
// Paralegal dashboard wiring to /api/paralegal/dashboard

import { j } from "../helpers.js";
import { requireAuth } from "../auth.js";

let stylesInjected = false;

export async function render(el, { escapeHTML, navigateTo } = {}) {
  requireAuth("paralegal");
  ensureStyles();
  const nav = navigateTo || window.navigateTo || ((route) => (location.hash = route));
  el.innerHTML = skeleton("Paralegal Dashboard");

  try {
    const data = await j("/api/paralegal/dashboard");
    draw(el, data, escapeHTML || ((s) => String(s ?? "")));
    wire(el, nav);
  } catch (err) {
    showError(el, err, escapeHTML || ((s) => String(s ?? "")));
  }
}

export function viewJob(jobId) {
  if (!jobId) return;
  if (typeof window.navigateTo === "function") {
    window.navigateTo("job-detail", { jobId });
  } else {
    window.location.href = `index.html#job-detail?jobId=${encodeURIComponent(jobId)}`;
  }
}

if (typeof window !== "undefined" && !window.viewJob) {
  window.viewJob = viewJob;
}

function draw(root, payload, escapeHTML) {
  const metrics = payload?.metrics || {};
  const metricCards = [
    { label: "Active cases", value: metrics.activeCases ?? 0 },
    { label: "Invitations", value: metrics.invitations ?? 0 },
    { label: "Pending applications", value: metrics.pendingApplications ?? 0 },
    { label: "Earnings", value: formatCurrency(metrics.earnings) },
  ]
    .map(
      (m) => `
        <div class="metric">
          <div class="metric-label">${escapeHTML(m.label)}</div>
          <div class="metric-value">${escapeHTML(m.value)}</div>
        </div>`
    )
    .join("");

  const invites = (payload?.invitations || [])
    .map((invite) => {
      const dateLabel = invite.invitedAt ? new Date(invite.invitedAt).toLocaleDateString() : "Recently";
      return `
        <article class="case-row">
          <div>
            <div class="case-title">${escapeHTML(invite.jobTitle || "Case invitation")}</div>
            <div class="case-meta">${escapeHTML(invite.attorneyName || "Attorney")} · Invited ${escapeHTML(
        dateLabel
      )}</div>
          </div>
          <div class="invite-actions">
            <button class="btn ghost" data-action="open-case" data-case-id="${escapeHTML(invite.caseId)}">View</button>
            <button class="btn" data-action="accept-invite" data-case-id="${escapeHTML(invite.caseId)}">Accept</button>
            <button class="btn" data-action="decline-invite" data-case-id="${escapeHTML(invite.caseId)}">Decline</button>
          </div>
        </article>
      `;
    })
    .join("");

  const activeCases = (payload?.activeCases || [])
    .map((c) => {
      const meta = [
        c.practiceArea ? `Practice: ${escapeHTML(c.practiceArea)}` : "",
        c.status ? `Status: ${escapeHTML(c.status)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `
        <article class="case-row">
          <div>
            <div class="case-title">${escapeHTML(c.jobTitle || "Case")}</div>
            <div class="case-meta">${meta || "Awaiting details."}</div>
          </div>
          ${
            c.caseId
              ? `<button class="btn ghost" data-action="open-case" data-case-id="${escapeHTML(
                  c.caseId
                )}">Open</button>`
              : ""
          }
        </article>
      `;
    })
    .join("");

  const availableJobs = (payload?.availableJobs || [])
    .map(
      (job) => `
        <article class="job-card">
          <div>
            <div class="job-title">${escapeHTML(job.title || "Job")}</div>
            <div class="job-meta">
              ${escapeHTML(job.practiceArea || "General")} · ${formatCurrency(job.budget)}
            </div>
          </div>
          <button class="btn ghost" data-action="view-job" data-job-id="${escapeHTML(
            job.jobId
          )}">View job</button>
        </article>`
    )
    .join("");

  const myApplications = (payload?.myApplications || [])
    .map(
      (app) => `
        <article class="case-row">
          <div>
            <div class="case-title">${escapeHTML(app.jobTitle || "Job")}</div>
            <div class="case-meta">
              ${escapeHTML(app.practiceArea || "General")} · ${escapeHTML(
                app.status || "submitted"
              )}
            </div>
          </div>
          ${
            app.jobId
              ? `<button class="btn ghost" data-action="view-job" data-job-id="${escapeHTML(
                  app.jobId
                )}">View job</button>`
              : ""
          }
        </article>`
    )
    .join("");

  root.innerHTML = `
    <section class="dash">
      <div class="section-title">Paralegal Dashboard</div>
      <div class="metric-grid metric-grid--three">${metricCards}</div>

      <div class="block">
        <div class="block-title">Invitations</div>
        ${
          invites ||
          `<div class="empty">No invitations right now. Attorneys will invite you directly to cases.</div>`
        }
      </div>

      <div class="grid two">
        <div class="block">
          <div class="block-title">Active cases</div>
          ${
            activeCases ||
            `<div class="empty">When an attorney hires you, the case will appear here.</div>`
          }
        </div>
        <div class="block">
          <div class="block-title">Available jobs</div>
          ${
            availableJobs ||
            `<div class="empty">No matching job postings right now. Check back shortly.</div>`
          }
        </div>
      </div>

      <div class="block" style="margin-top:16px">
        <div class="block-title">My applications</div>
        ${
          myApplications ||
          `<div class="empty">You haven’t applied to any jobs yet.</div>`
        }
      </div>
    </section>
  `;
}

function wire(root, navigateTo) {
  root.addEventListener("click", (event) => {
    const action = event.target?.dataset?.action;
    if (action === "view-job") {
      viewJob(event.target.dataset.jobId);
    }
    if (action === "open-case") {
      const caseId = event.target.dataset.caseId;
      if (caseId) {
        if (typeof navigateTo === "function") navigateTo("case-detail", { caseId });
        else window.location.href = `index.html#case-detail?caseId=${encodeURIComponent(caseId)}`;
      }
    }
    if (action === "accept-invite" || action === "decline-invite") {
      const caseId = event.target.dataset.caseId;
      if (caseId) {
        respondToInvite(caseId, action === "accept-invite" ? "accept" : "decline");
      }
    }
  });
}

async function respondToInvite(caseId, decision) {
  try {
    await j(`/api/cases/${encodeURIComponent(caseId)}/respond-invite`, {
      method: "POST",
      body: { decision },
    });
    window.location.reload();
  } catch (err) {
    alert(err?.message || "Unable to update invitation.");
  }
}

function showError(el, err, escapeHTML) {
  const message = err?.message || "Unable to load dashboard data.";
  el.innerHTML = `
    <section class="dash">
      <div class="section-title">Paralegal Dashboard</div>
      <div class="error">${escapeHTML(message)}</div>
    </section>
  `;
}

function formatCurrency(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function ensureStyles() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = `
    .dash{display:grid;gap:16px}
    .metric-grid{display:grid;gap:12px}
    .metric-grid--three{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
    .metric{border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#fff}
    .metric-label{font-size:.85rem;color:#6b7280;text-transform:uppercase;letter-spacing:.08em}
    .metric-value{font-size:1.5rem;font-weight:600;margin-top:4px}
    .grid.two{display:grid;gap:16px}
    @media(min-width:960px){.grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}}
    .block{border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:16px;display:grid;gap:12px}
    .block-title{font-weight:600}
    .case-row,.job-card{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb}
    .case-title,.job-title{font-weight:600}
    .case-meta,.job-meta{font-size:.9rem;color:#6b7280;margin-top:2px}
    .btn{padding:8px 14px;border-radius:999px;border:1px solid #d1d5db;background:#fff;cursor:pointer}
    .btn.ghost{background:#fff}
    .empty{color:#6b7280;font-size:.95rem}
    .error{padding:16px;border:1px solid #fecaca;background:#fef2f2;border-radius:12px;color:#b91c1c}
    .shimmer{background:linear-gradient(90deg,#f3f4f6 25%,#e5e7eb 37%,#f3f4f6 63%);background-size:400% 100%;animation:shimmer 1.4s ease infinite;border-radius:10px;height:18px}
    @keyframes shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}

function skeleton(title) {
  return `
    <section class="dash">
      <div class="section-title">${title}</div>
      <div class="metric-grid metric-grid--three">
        ${Array.from({ length: 3 })
          .map(
            () => `
          <div class="metric">
            <div class="metric-label shimmer"></div>
            <div class="metric-value shimmer"></div>
          </div>`
          )
          .join("")}
      </div>
      <div class="grid two">
        <div class="block shimmer" style="height:200px"></div>
        <div class="block shimmer" style="height:200px"></div>
      </div>
    </section>
  `;
}
