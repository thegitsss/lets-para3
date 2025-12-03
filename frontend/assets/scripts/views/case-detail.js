// frontend/assets/scripts/views/case-detail.js
// Case detail view wired to /api/cases/:caseId

import { j } from "../helpers.js";
import { requireAuth } from "../auth.js";

let stylesInjected = false;
let stripeClientPromise = null;
let stripeElementsInstance = null;
let stripeJsPromise = null;
let cardElementInstance = null;
let cardErrorsNode = null;
let cardHostNode = null;
let paymentEnabled = false;

export async function render(el, { escapeHTML, params: routeParams } = {}) {
  const session = requireAuth();
  ensureStyles();
  const h = escapeHTML || ((s) => String(s ?? ""));
  const params = getRouteParams(routeParams);
  const caseId = params.get("caseId");

  if (!caseId) {
    el.innerHTML = `<section class="dash"><div class="error">Missing caseId.</div></section>`;
    return;
  }

  el.innerHTML = skeleton();

  try {
    const data = await j(`/api/cases/${encodeURIComponent(caseId)}`);
    draw(el, data, h, caseId, session);
  } catch (err) {
    el.innerHTML = `<section class="dash"><div class="error">${h(err?.message || "Unable to load case details.")}</div></section>`;
  }
}

function draw(root, data, escapeHTML, caseId, session) {
  const practiceArea = data?.practiceArea || "General matter";
  const title = data?.title || "Case";
  const status = (data?.status || "open").replace(/_/g, " ");
  const zoomLink = data?.zoomLink;
  const applicants = Array.isArray(data?.applicants) ? data.applicants : [];
  const showPayment =
    (session?.role || "").toLowerCase() === "attorney" && !!data?.paralegal && !data?.paymentReleased;

  root.innerHTML = `
    <section class="dash">
      <div class="section-title">${escapeHTML(title)}</div>
      <div class="case-meta">Practice area: ${escapeHTML(practiceArea)}</div>
      <div class="case-status-pill">${escapeHTML(status)}</div>

      <div class="case-section">
        <div class="case-section-title">Zoom link</div>
        ${
          zoomLink
            ? `<a class="btn primary" href="${escapeHTML(zoomLink)}" target="_blank" rel="noopener">Join meeting</a>`
            : `<div class="empty">No meeting link has been provided yet.</div>`
        }
      </div>

      <div class="case-section">
        <div class="case-section-title">Applicants</div>
        ${
          applicants.length
            ? `<ul class="applicant-list">${applicants.map((app) => renderApplicant(app, escapeHTML)).join("")}</ul>`
            : `<div class="empty">No applicants yet.</div>`
        }
      </div>

      <div class="case-section">
        <div class="case-section-title">Actions</div>
        <div class="case-actions">
          ${
            showPayment
              ? `<button class="btn primary" data-start-escrow>Fund Escrow</button>
                 <div class="payment-panel" data-payment-panel>
                   <div data-card-element></div>
                   <div class="card-errors" data-card-errors></div>
                 </div>`
              : ""
          }
          <button class="btn secondary" data-release-escrow>Mark Complete &amp; Release Funds</button>
        </div>
      </div>
    </section>
  `;

  bindHireButtons(root, caseId);
  setupPaymentSection(root, caseId, showPayment);
  bindEscrowButton(root, caseId);
  bindReleaseButton(root, caseId);
}

function ensureStyles() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = `
    .dash{display:grid;gap:16px}
    .case-meta{color:#6b7280;font-size:.95rem}
    .case-status-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:999px;text-transform:capitalize;font-weight:600;width:max-content}
    .case-section{border-top:1px solid #e5e7eb;padding-top:12px}
    .case-section-title{font-weight:600;margin-bottom:6px}
    .case-actions{display:flex;gap:12px;flex-wrap:wrap}
    .btn{padding:10px 16px;border-radius:999px;border:1px solid #d1d5db;cursor:pointer;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
    .btn.primary{background:#111827;color:#fff;border-color:#111827}
    .btn.success{background:#047857;color:#fff;border-color:#047857}
    .btn.primary[disabled]{opacity:.6;cursor:not-allowed}
    .payment-panel{border:1px solid #e5e7eb;border-radius:12px;padding:14px;background:#fff;min-width:260px}
    .payment-panel p{margin:0 0 6px;font-weight:600}
    .payment-panel [data-card-element]{padding:12px;border:1px solid #e5e7eb;border-radius:8px;background:#fff}
    .payment-panel .card-errors{color:#b00020;font-size:.85rem;margin-top:6px;min-height:1rem}
    .empty{color:#6b7280;font-size:.95rem}
    .error{padding:16px;border:1px solid #fecaca;background:#fef2f2;border-radius:12px;color:#b91c1c}
    .applicant-list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
    .applicant-card{display:flex;align-items:center;justify-content:space-between;border:1px solid #e5e7eb;padding:12px 16px;border-radius:12px}
    .applicant-card-main{display:flex;flex-direction:column;gap:4px}
    .applicant-name{font-weight:600;font-size:1rem}
    .applicant-status{font-size:.85rem;color:#6b7280;text-transform:capitalize}
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
      <div class="case-meta shimmer" style="width:180px"></div>
      <div class="case-status-pill shimmer" style="width:120px;height:32px"></div>
      <div class="case-section">
        <div class="case-section-title shimmer" style="width:140px"></div>
        <div class="shimmer" style="width:200px;height:40px"></div>
      </div>
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

function renderApplicant(applicant, escapeHTML) {
  const person = applicant?.paralegal || {};
  const displayName =
    person?.name ||
    [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim() ||
    "Paralegal";
  const status = (applicant?.status || "pending").replace(/_/g, " ");
  const paralegalId = applicant?.paralegal?.id || applicant?.paralegalId || "";
  const appliedAt = applicant?.appliedAt ? new Date(applicant.appliedAt).toLocaleDateString() : "";
  const disabledAttr = paralegalId ? "" : " disabled";
  return `
    <li class="applicant-card">
      <div class="applicant-card-main">
        <div class="applicant-name">${escapeHTML(displayName)}</div>
        <div class="applicant-status">${escapeHTML(status)}${appliedAt ? ` · Applied ${escapeHTML(appliedAt)}` : ""}</div>
      </div>
      <button class="btn primary" data-hire-paralegal data-paralegal-id="${escapeHTML(paralegalId)}"${disabledAttr}>Hire</button>
    </li>
  `;
}

function bindHireButtons(root, caseId) {
  root.querySelectorAll("[data-hire-paralegal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const paralegalId = btn.dataset.paralegalId || prompt("Enter the paralegal ID to hire:") || "";
      if (!paralegalId) {
        notify("Paralegal reference is required.", "error");
        return;
      }
      hireParalegal(caseId, paralegalId, btn);
    });
  });
}

function bindEscrowButton(root, caseId) {
  const btn = root.querySelector("[data-start-escrow]");
  if (!btn) return;
  btn.addEventListener("click", () => startEscrow(caseId, btn));
}

function bindReleaseButton(root, caseId) {
  const btn = root.querySelector("[data-release-escrow]");
  if (!btn) return;
  btn.addEventListener("click", () => releaseEscrow(caseId, btn));
}

function setupPaymentSection(root, caseId, enable) {
  paymentEnabled = enable;
  if (cardElementInstance) {
    cardElementInstance.destroy?.();
    cardElementInstance = null;
  }
  cardHostNode = enable ? root.querySelector("[data-card-element]") : null;
  cardErrorsNode = enable ? root.querySelector("[data-card-errors]") : null;
  if (enable) {
    ensureStripeCard().catch((err) => notify(err?.message || "Unable to load payment form.", "error"));
  }
}

async function hireParalegal(caseId, paralegalId, button) {
  if (!caseId || !paralegalId) {
    notify("Missing case or paralegal identifier.", "error");
    return;
  }
  button?.setAttribute("disabled", "disabled");
  try {
    await j(`/api/cases/${encodeURIComponent(caseId)}/hire/${encodeURIComponent(paralegalId)}`, {
      method: "POST",
    });
    if (button) {
      button.textContent = "Hired";
      button.classList.add("success");
    }
    notify("Paralegal hired successfully.", "success");
  } catch (err) {
    button?.removeAttribute("disabled");
    notify(err?.message || "Unable to hire paralegal.", "error");
  }
}

function ensureStripeJs() {
  if (typeof window === "undefined") return Promise.reject(new Error("Window unavailable"));
  if (window.Stripe) return Promise.resolve();
  if (!stripeJsPromise) {
    stripeJsPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[src="https://js.stripe.com/v3/"]');
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("Stripe.js failed to load")));
        return;
      }
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Stripe.js failed to load"));
      document.head.appendChild(script);
    });
  }
  return stripeJsPromise;
}

async function getStripeClient() {
  await ensureStripeJs();
  if (!stripeClientPromise) {
    stripeClientPromise = (async () => {
      const config = await j("/api/payments/config");
      if (!config?.publishableKey) throw new Error("Stripe publishable key missing");
      return window.Stripe(config.publishableKey);
    })();
  }
  try {
    return await stripeClientPromise;
  } catch (err) {
    stripeClientPromise = null;
    throw err;
  }
}

async function ensureStripeCard() {
  if (!cardHostNode) return null;
  await ensureStripeJs();
  if (cardElementInstance) return cardElementInstance;
  const stripe = await getStripeClient();
  if (!stripeElementsInstance) {
    stripeElementsInstance = stripe.elements();
  }
  cardElementInstance = stripeElementsInstance.create("card", {
    style: {
      base: {
        color: "#1a1a1a",
        fontFamily: '"Sarabun", sans-serif',
        fontSize: "16px",
        "::placeholder": { color: "#9ba6b1" },
      },
      invalid: { color: "#b00020" },
    },
  });
  cardElementInstance.mount(cardHostNode);
  cardElementInstance.on("change", (event) => {
    if (cardErrorsNode) cardErrorsNode.textContent = event.error ? event.error.message : "";
  });
  return cardElementInstance;
}

async function startEscrow(caseId, button) {
  if (!caseId) {
    notify("Missing case identifier.", "error");
    return;
  }
  if (!paymentEnabled) {
    notify("Escrow funding is currently unavailable.", "error");
    return;
  }
  try {
    await ensureStripeCard();
  } catch (err) {
    notify(err?.message || "Unable to load payment form.", "error");
    return;
  }
  if (!cardElementInstance) {
    notify("Payment form is not ready.", "error");
    return;
  }
  if (cardErrorsNode) cardErrorsNode.textContent = "";
  button?.setAttribute("disabled", "disabled");
  try {
    const { clientSecret } = await j("/api/payments/start-escrow", {
      method: "POST",
      body: { caseId },
    });
    const stripe = await getStripeClient();
    const result = await stripe.confirmCardPayment(clientSecret, {
      payment_method: { card: cardElementInstance },
    });
    if (result.error) {
      if (cardErrorsNode) cardErrorsNode.textContent = result.error.message || "Payment failed.";
      throw new Error(result.error.message || "Payment failed.");
    }
    if (result.paymentIntent?.status !== "succeeded") {
      throw new Error("Payment not completed.");
    }
    notify("Escrow funded successfully.", "success");
    window.location.reload();
  } catch (err) {
    button?.removeAttribute("disabled");
    notify(err?.message || "Unable to fund escrow.", "error");
  }
}

async function releaseEscrow(caseId, button) {
  if (!caseId) {
    notify("Missing case identifier.", "error");
    return;
  }
  button?.setAttribute("disabled", "disabled");
  try {
    await j("/api/payments/release", {
      method: "POST",
      body: { caseId },
    });
    notify("Funds released successfully.", "success");
    window.location.reload();
  } catch (err) {
    button?.removeAttribute("disabled");
    notify(err?.message || "Unable to release funds.", "error");
  }
}

function notify(message, type = "info") {
  if (window.toastUtils?.stage) {
    window.toastUtils.stage(message, type);
  } else {
    alert(message);
  }
}
