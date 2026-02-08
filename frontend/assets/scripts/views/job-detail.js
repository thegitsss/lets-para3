// frontend/assets/scripts/views/job-detail.js
// Job detail page with application flow.

import { j } from "../helpers.js";
import { requireAuth } from "../auth.js";
import { getStripeConnectStatus, isStripeConnected, STRIPE_GATE_MESSAGE } from "../utils/stripe-connect.js";

let stylesInjected = false;
let applyConfirmModal = null;
let applyConfirmTitle = null;
let applyConfirmMessage = null;

export async function render(el, { escapeHTML, params: routeParams } = {}) {
  requireAuth("paralegal");
  ensureStyles();
  const h = escapeHTML || ((s) => String(s ?? ""));
  const params = getRouteParams(routeParams);
  const jobId = params.get("jobId");

  if (!jobId) {
    el.innerHTML = `<section class="dash"><div class="error">Missing jobId.</div></section>`;
    return;
  }

  el.innerHTML = skeleton();

  try {
    const jobs = await j("/api/jobs/open");
    const job = jobs.find((j) => String(j._id || j.id) === jobId);
    if (!job) {
      el.innerHTML = `<section class="dash"><div class="error">Job not found or no longer open.</div></section>`;
      return;
    }
    draw(el, job, h);
    wire(el, jobId, job?.title || "this case");
  } catch (err) {
    el.innerHTML = `<section class="dash"><div class="error">${h(err?.message || "Unable to load job.")}</div></section>`;
  }
}

function draw(root, job, escapeHTML) {
  root.innerHTML = `
    <section class="dash">
      <div class="section-title">${escapeHTML(job.title || "Job")}</div>
      <div class="job-meta">
        ${escapeHTML(job.practiceArea || "General")} · ${formatCurrency(job.budget)}
      </div>
      <p class="job-description">${escapeHTML(job.description || "No description provided.")}</p>

      <form class="apply-form" data-job-apply>
        <label for="coverLetter">Cover letter</label>
        <textarea id="coverLetter" name="coverLetter" rows="6" placeholder="Explain why you are a great fit for this job."></textarea>
        <p class="apply-footnote">Your résumé and LinkedIn profile are included automatically.</p>
        <div class="apply-actions">
          <button class="btn primary" type="submit">Apply to this job</button>
          <span class="apply-status" data-apply-status></span>
        </div>
      </form>
    </section>
  `;
}

function wire(root, jobId, jobTitle = "") {
  const form = root.querySelector("[data-job-apply]");
  const textarea = root.querySelector("#coverLetter");
  const statusNode = root.querySelector("[data-apply-status]");
  const submitBtn = form?.querySelector('button[type="submit"]');
  const defaultText = submitBtn?.textContent || "Apply to this job";
  let stripeConnected = false;

  if (submitBtn) submitBtn.disabled = true;
  void (async () => {
    const stripeStatus = await getStripeConnectStatus();
    stripeConnected = isStripeConnected(stripeStatus);
    if (!stripeConnected) {
      if (statusNode) statusNode.textContent = STRIPE_GATE_MESSAGE;
      if (submitBtn) submitBtn.disabled = true;
    } else if (submitBtn) {
      submitBtn.disabled = false;
      if (statusNode && statusNode.textContent === STRIPE_GATE_MESSAGE) {
        statusNode.textContent = "";
      }
    }
  })();

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!stripeConnected) {
      if (statusNode) statusNode.textContent = STRIPE_GATE_MESSAGE;
      return;
    }
    const letter = textarea?.value.trim();
    if (!letter) {
      if (statusNode) statusNode.textContent = "Please include a brief cover letter.";
      return;
    }

    if (statusNode) statusNode.textContent = "Submitting application…";

    let restoreButton = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Applying…";
    }
    try {
      await j(`/api/jobs/${encodeURIComponent(jobId)}/apply`, {
        method: "POST",
        body: { coverLetter: letter },
        noRedirect: true,
      });
      if (statusNode) statusNode.textContent = "";
      if (textarea) textarea.value = "";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Applied";
      }
      restoreButton = false;
      openApplyConfirmModal(jobTitle);
    } catch (err) {
      if (statusNode) statusNode.textContent = err?.message || "Unable to apply right now.";
      if (err?.status === 403 && /stripe/i.test(err?.message || "")) {
        if (statusNode) statusNode.textContent = STRIPE_GATE_MESSAGE;
      }
    } finally {
      if (restoreButton && submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = defaultText;
      }
    }
  });
}

function openApplyConfirmModal(jobTitle = "") {
  ensureApplyConfirmModal();
  if (applyConfirmTitle) applyConfirmTitle.textContent = "Applied";
  if (applyConfirmMessage) {
    const title = String(jobTitle || "").trim();
    applyConfirmMessage.textContent = title
      ? `Your application to ${title} has been submitted.`
      : "Your application has been submitted.";
  }
  if (applyConfirmModal) {
    applyConfirmModal.classList.add("show");
    applyConfirmModal.querySelector("[data-apply-confirm-close]")?.focus();
  }
}

function closeApplyConfirmModal() {
  if (applyConfirmModal) applyConfirmModal.classList.remove("show");
}

function ensureApplyConfirmModal() {
  if (applyConfirmModal) return;
  ensureStyles();
  applyConfirmModal = document.createElement("div");
  applyConfirmModal.className = "apply-confirm-overlay";
  applyConfirmModal.innerHTML = `
    <div class="apply-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="applyConfirmTitle">
      <header>
        <h3 id="applyConfirmTitle" data-apply-confirm-title>Applied</h3>
      </header>
      <p class="apply-confirm-message" data-apply-confirm-message>Your application has been submitted.</p>
      <div class="apply-confirm-actions">
        <a class="apply-confirm-link" href="dashboard-paralegal.html#cases">View my applications</a>
        <button type="button" class="apply-confirm-close" data-apply-confirm-close>Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(applyConfirmModal);
  applyConfirmTitle = applyConfirmModal.querySelector("[data-apply-confirm-title]");
  applyConfirmMessage = applyConfirmModal.querySelector("[data-apply-confirm-message]");
  applyConfirmModal.querySelectorAll("[data-apply-confirm-close]").forEach((btn) => {
    btn.addEventListener("click", closeApplyConfirmModal);
  });
  applyConfirmModal.addEventListener("click", (event) => {
    if (event.target === applyConfirmModal) closeApplyConfirmModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && applyConfirmModal?.classList.contains("show")) {
      closeApplyConfirmModal();
    }
  });
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
    .job-meta{color:#6b7280;font-size:.95rem}
    .job-description{line-height:1.6;color:#111827}
    .apply-form{display:grid;gap:8px}
    .apply-form label{font-weight:600}
    .apply-form textarea{border:1px solid #d1d5db;border-radius:10px;padding:10px;font:inherit;resize:vertical}
    .apply-footnote{font-size:.85rem;color:#6b7280;margin:0}
    .apply-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
    .apply-status{font-size:.9rem;color:#6b7280}
    .btn{padding:10px 16px;border-radius:999px;border:1px solid #d1d5db;cursor:pointer;font-weight:600}
    .btn.primary{background:#111827;color:#fff;border-color:#111827}
    .error{padding:16px;border:1px solid #fecaca;background:#fef2f2;border-radius:12px;color:#b91c1c}
    .apply-confirm-overlay{position:fixed;inset:0;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center;z-index:1100;opacity:0;pointer-events:none;transition:opacity .2s ease}
    .apply-confirm-overlay.show{opacity:1;pointer-events:auto}
    .apply-confirm-dialog{background:#fff;border-radius:16px;padding:22px;max-width:420px;width:92%;box-shadow:0 20px 45px rgba(0,0,0,.22);display:grid;gap:12px;text-align:center}
    .apply-confirm-dialog header{display:flex;align-items:center;justify-content:center;gap:12px}
    .apply-confirm-dialog h3{margin:0;font-weight:600;font-size:1.2rem}
    .apply-confirm-dialog .close-btn{border:none;background:none;font-size:1.5rem;line-height:1;cursor:pointer}
    .apply-confirm-message{margin:0;color:#6b7280;font-size:.95rem}
    .apply-confirm-actions{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}
    .apply-confirm-link{background:#111827;color:#fff;border-radius:999px;padding:0.55rem 1.2rem;text-decoration:none;font-weight:250;font-size:.95rem}
    .apply-confirm-close{border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:0.55rem 1.2rem;font-weight:250;font-size:.95rem;cursor:pointer}
    .shimmer{background:linear-gradient(90deg,#f3f4f6 25%,#e5e7eb 37%,#f3f4f6 63%);background-size:400% 100%;animation:shimmer 1.4s ease infinite;border-radius:10px;height:18px}
    @keyframes shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}

function skeleton() {
  return `
    <section class="dash">
      <div class="section-title shimmer" style="width:220px"></div>
      <div class="job-meta shimmer" style="width:180px"></div>
      <div class="job-description shimmer" style="width:100%;height:80px"></div>
    </section>
  `;
}

function getRouteParams(explicit) {
  if (explicit instanceof URLSearchParams) return explicit;
  const hash = window.location.hash || "";
  if (hash.includes("?")) {
    return new URLSearchParams(hash.split("?")[1]);
  }
  if (window.location.search) {
    return new URLSearchParams(window.location.search.slice(1));
  }
  return new URLSearchParams();
}
