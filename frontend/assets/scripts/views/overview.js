// frontend/assets/scripts/views/overview.js
// Attorney dashboard wiring: pulls live data from /api/attorney/dashboard

import { j } from "../helpers.js";
import { requireAuth } from "../auth.js";

let stylesInjected = false;

export async function render(el, { escapeHTML, navigateTo } = {}) {
  requireAuth("attorney");
  ensureStyles();
  const nav = navigateTo || window.navigateTo || ((route) => (location.hash = route));
  el.innerHTML = skeleton("Attorney Dashboard");

  try {
    const data = await j("/api/attorney/dashboard");
    draw(el, data, escapeHTML || ((s) => String(s ?? "")));
    wire(el, nav);
  } catch (err) {
    showError(el, err, escapeHTML || ((s) => String(s ?? "")));
  }
}

export function goToCase(caseId) {
  if (!caseId) return;
  if (typeof window.navigateTo === "function") {
    window.navigateTo("case-detail", { caseId });
  } else {
    window.location.href = `index.html#case-detail?caseId=${encodeURIComponent(caseId)}`;
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

if (typeof window !== "undefined") {
  if (!window.goToCase) window.goToCase = goToCase;
  if (!window.viewJob) window.viewJob = viewJob;
}

function draw(root, payload, escapeHTML) {
  const metrics = payload?.metrics || {};
  const metricCards = [
    { label: "Active cases", value: metrics.activeCases ?? 0 },
    { label: "Open postings", value: metrics.openJobs ?? 0 },
    { label: "Pending applications", value: metrics.pendingApplications ?? 0 },
    { label: "Funds in Stripe", value: formatCurrency(metrics.escrowTotal) },
  ]
    .map(
      (m) => `
        <div class="metric">
          <div class="metric-label">${escapeHTML(m.label)}</div>
          <div class="metric-value">${escapeHTML(m.value)}</div>
        </div>`
    )
    .join("");

  const activeCases = (payload?.activeCases || [])
    .map((c) => buildCaseRow(c, escapeHTML))
    .join("");
  const openJobs = (payload?.openJobs || [])
    .map((job) => buildJobCard(job, escapeHTML))
    .join("");
  const pendingApps = (payload?.pendingApplications || [])
    .map((a) => buildPendingApplication(a, escapeHTML))
    .join("");

  root.innerHTML = `
    <section class="dash">
      <div class="section-title">Attorney Dashboard</div>
      <div class="metric-grid">${metricCards}</div>

      <div class="grid two">
        <div class="block">
          <div class="block-title">Active cases</div>
          ${
            activeCases ||
            `<div class="empty">No active cases yet. Post your first job to get started.</div>`
          }
        </div>
        <div class="block">
          <div class="block-title">Open postings</div>
          ${
            openJobs ||
            `<div class="empty">You don’t have any open postings. Create a new one to invite paralegals.</div>`
          }
        </div>
      </div>

      <div class="block" style="margin-top:16px">
        <div class="block-title">Pending applications</div>
        ${
          pendingApps ||
          `<div class="empty">Applicants will appear here as soon as they apply to your postings.</div>`
        }
      </div>
    </section>
  `;
}

function buildCaseRow(c, escapeHTML) {
  const meta = [
    c.practiceArea ? `Practice: ${escapeHTML(c.practiceArea)}` : "",
    c.paralegalName ? `Paralegal: ${escapeHTML(c.paralegalName)}` : "",
    c.status ? `Status: ${escapeHTML(c.status)}` : "",
    Number.isFinite(c.amountCents) ? `Amount: ${formatCurrency(c.amountCents / 100)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <article class="case-row">
      <div>
        <div class="case-title">${escapeHTML(c.jobTitle || "Untitled matter")}</div>
        <div class="case-meta">${meta || "No additional details yet."}</div>
      </div>
      <button class="btn ghost" data-action="open-case" data-case-id="${escapeHTML(
        c.caseId
      )}">View case</button>
    </article>
  `;
}

function buildJobCard(job, escapeHTML) {
  const budget = formatCurrency(job.budget);
  return `
    <article class="job-card">
      <div>
        <div class="job-title">${escapeHTML(job.title || "Job")}</div>
        <div class="job-meta">
          ${job.practiceArea ? escapeHTML(job.practiceArea) : "General"}
          · ${budget}
        </div>
      </div>
      <button class="btn ghost" data-action="view-job" data-job-id="${escapeHTML(
        job.jobId
      )}">View posting</button>
    </article>
  `;
}

function buildPendingApplication(app, escapeHTML) {
  return `
    <article class="case-row">
      <div>
        <div class="case-title">${escapeHTML(app.paralegalName || "Paralegal")}</div>
        <div class="case-meta">
          ${escapeHTML(app.jobTitle || "Job")} · ${escapeHTML(app.practiceArea || "General")} · Status:
          ${escapeHTML(app.status || "submitted")}
        </div>
      </div>
      ${
        app.jobId
          ? `<button class="btn ghost" data-action="view-job" data-job-id="${escapeHTML(
              app.jobId
            )}">Review job</button>`
          : ""
      }
    </article>
  `;
}

function wire(root, navigateTo) {
  root.addEventListener("click", (event) => {
    const act = event.target?.dataset?.action;
    if (act === "open-case") goToCase(event.target.dataset.caseId);
    if (act === "view-job") viewJob(event.target.dataset.jobId);
  });

  root.addEventListener("click", (event) => {
    const qa = event.target?.dataset?.qa;
    if (!qa) return;
    if (qa === "post") navigateTo("attorney-jobs");
    if (qa === "applicants") navigateTo("attorney-cases");
    if (qa === "messages") navigateTo("attorney-messages");
    if (qa === "browse") navigateTo("attorney-cases");
    if (qa === "availability") navigateTo("attorney-settings");
    if (qa === "calendar") navigateTo("calendar");
    if (qa === "checklist") navigateTo("checklist");
  });

  root.addEventListener("click", (event) => {
    const cta = event.target?.dataset?.cta;
    if (!cta) return;
    if (cta === "review-applicants") navigateTo("attorney-cases");
    if (cta === "open-disputes") navigateTo("attorney-cases");
    if (cta === "add-zoom") navigateTo("attorney-cases");
    if (cta === "view-deadlines") navigateTo("deadlines");
    if (cta === "pending-users") navigateTo("attorney-dashboard");
  });
}

function showError(el, err, escapeHTML) {
  const message = err?.message || "Unable to load dashboard data.";
  el.innerHTML = `
    <section class="dash">
      <div class="section-title">Attorney Dashboard</div>
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
    @media(min-width:720px){.metric-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    .metric{border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#fff}
    .metric-label{font-size:.85rem;color:#6b7280;text-transform:uppercase;letter-spacing:.08em}
    .metric-value{font-size:1.75rem;font-weight:600;margin-top:4px}
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
      <div class="metric-grid">
        ${Array.from({ length: 4 })
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
