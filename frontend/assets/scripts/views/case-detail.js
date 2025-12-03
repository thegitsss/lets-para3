// frontend/assets/scripts/views/case-detail.js
// Case detail view wired to /api/cases/:caseId

import { j } from "../helpers.js";
import { requireAuth } from "../auth.js";
import { render as renderChecklist } from "./checklist.js";

function normalizeSessionPayload(raw) {
  if (!raw) return null;
  if (raw.user) return raw;
  return {
    user: raw,
    role: raw.role,
    status: raw.status,
  };
}

let stylesInjected = false;
let stripeClientPromise = null;
let stripeElementsInstance = null;
let stripeJsPromise = null;
let cardElementInstance = null;
let cardErrorsNode = null;
let cardHostNode = null;
let paymentEnabled = false;
let countdownTimer = null;

export async function render(el, { escapeHTML, params: routeParams } = {}) {
  ensureStyles();
  let session = null;
  try {
    if (typeof window.requireRole === "function") {
      session = normalizeSessionPayload(await window.requireRole());
    } else if (typeof window.checkSession === "function") {
      session = normalizeSessionPayload(await window.checkSession());
    } else {
      session = normalizeSessionPayload(requireAuth());
    }
  } catch {
    return;
  }
  if (!session) return;

  const viewerRole = String(session?.role || session?.user?.role || "").toLowerCase();
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
    if (err?.status === 403) {
      el.innerHTML = `<section class="dash"><div class="error">You don’t have access to this case.</div></section>`;
      return;
    }
    el.innerHTML = `<section class="dash"><div class="error">${h(err?.message || "Unable to load case details.")}</div></section>`;
  }
}

function draw(root, data, escapeHTML, caseId, session) {
  const practiceArea = data?.practiceArea || "General matter";
  const title = data?.title || "Case";
  const statusRaw = String(data?.status || "open");
  const status = statusRaw.replace(/_/g, " ");
  const zoomLink = data?.zoomLink;
  const applicants = Array.isArray(data?.applicants) ? data.applicants : [];
  const viewer = session?.user || {};
  const viewerRole = String(session?.role || viewer.role || "").toLowerCase();
  const viewerId = viewer?.id || viewer?._id || session?.id || "";
  const ownerId = data?.attorney?._id || data?.attorney?.id || data?.attorneyId || "";
  const isOwner = viewerRole === "attorney" && ownerId && viewerId && String(ownerId) === String(viewerId);
  const isAdmin = viewerRole === "admin";
  const paralegalOnCase = !!data?.paralegal;
  const pendingParalegalId = data?.pendingParalegalId || data?.pendingParalegal?._id || data?.pendingParalegal?.id;
  const pendingParalegalName =
    data?.pendingParalegal?.name ||
    [data?.pendingParalegal?.firstName, data?.pendingParalegal?.lastName].filter(Boolean).join(" ").trim();
  const viewerIsInvited = viewerRole === "paralegal" && pendingParalegalId && viewerId && String(pendingParalegalId) === String(viewerId);
  const readOnly = !!data?.readOnly;
  const purgeAt = data?.purgeScheduledFor ? new Date(data.purgeScheduledFor) : null;
  const alreadyApplied = applicants.some((applicant) => {
    const entry =
      applicant?.paralegalId?._id ||
      applicant?.paralegalId ||
      applicant?.paralegal?._id ||
      applicant?.paralegal?.id;
    return entry && viewerId && String(entry) === String(viewerId);
  });
  const showPayment = (isOwner || isAdmin) && paralegalOnCase && !data?.paymentReleased && !readOnly;
  const showCompleteButton = (isOwner || isAdmin) && paralegalOnCase && !data?.paymentReleased && !readOnly;
  const canInvite = (isOwner || isAdmin) && !paralegalOnCase && !pendingParalegalId;
  const canApply =
    viewerRole === "paralegal" &&
    statusRaw.toLowerCase() === "open" &&
    !paralegalOnCase &&
    !alreadyApplied &&
    !pendingParalegalId &&
    !data?.paymentReleased;

  const applicantsMarkup =
    applicants.length
      ? `<ul class="applicant-list">${applicants.map((app) => renderApplicant(app, escapeHTML, { canInvite })).join("")}</ul>`
      : `<div class="empty">No applicants yet.</div>`;

  let applicationSection = "";
  if (viewerRole === "paralegal") {
    if (viewerIsInvited) {
      applicationSection = `
        <div class="case-section">
          <div class="case-section-title">Invitation pending</div>
          <p class="hint">You’ve been invited to this case. Accept to start or decline to pass.</p>
          <div class="case-actions">
            <button class="btn primary" type="button" data-accept-invite>Accept invite</button>
            <button class="btn ghost" type="button" data-decline-invite>Decline</button>
          </div>
          <div class="apply-status" data-invite-status></div>
        </div>
      `;
    } else if (canApply) {
      applicationSection = `
        <div class="case-section">
          <div class="case-section-title">Apply to this case</div>
          <form class="apply-form" data-case-apply-form>
            <label for="caseApplyNote">Cover letter (optional)</label>
            <textarea id="caseApplyNote" data-apply-note rows="5" placeholder="Explain why you are a strong fit."></textarea>
            <div class="case-actions">
              <button class="btn primary" type="submit">Submit application</button>
              <span class="apply-status" data-apply-status></span>
            </div>
          </form>
        </div>
      `;
    } else {
      let note = "";
      if (alreadyApplied) {
        note = "You already applied to this case. We’ll let the attorney know.";
      } else if (paralegalOnCase) {
        note = "An attorney has already hired a paralegal for this case.";
      } else if (pendingParalegalId) {
        note = "An invitation to another paralegal is pending.";
      } else if (data?.paymentReleased) {
        note = "This case has been completed.";
      } else if (statusRaw.toLowerCase() !== "open") {
        note = "Applications for this case are currently closed.";
      }
      if (note) {
        applicationSection = `
          <div class="case-section">
            <div class="case-section-title">Apply to this case</div>
            <p class="notice">${escapeHTML(note)}</p>
          </div>
        `;
      }
    }
  }

  const actionsSection =
    showPayment || showCompleteButton
      ? `
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
          ${
            showCompleteButton
              ? `<button class="btn secondary" data-complete-case>Mark Case Complete &amp; Archive</button>`
              : ""
          }
        </div>
      </div>`
      : "";

  const archiveSection = readOnly
    ? `
      <div class="case-section notice" data-archive-status>
        <div class="case-section-title">Archive</div>
        <p class="notice">Case archived. Auto-delete in <span data-purge-countdown>${purgeAt ? formatCountdown(purgeAt) : "--:--"}</span>.</p>
        <div class="case-actions">
          <button class="btn" data-download-archive>Download Archive</button>
        </div>
      </div>
    `
    : "";

  root.innerHTML = `
    <section class="dash">
      <div class="section-title">${escapeHTML(title)}</div>
      <div class="case-meta">Practice area: ${escapeHTML(practiceArea)}</div>
      <div class="case-status-pill">${escapeHTML(status)}</div>
      ${
        pendingParalegalId
          ? `<div class="notice">Invitation sent to ${escapeHTML(
              pendingParalegalName || "a paralegal"
            )}. Awaiting response.</div>`
          : ""
      }

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
        ${applicantsMarkup}
      </div>

      ${applicationSection}
      ${actionsSection}
      ${archiveSection}
      <div id="caseChecklist"></div>
    </section>
  `;

  bindHireButtons(root, caseId);
  setupPaymentSection(root, caseId, showPayment);
  bindEscrowButton(root, caseId);
  bindCompleteButton(root, caseId);
  bindDownloadButton(root, caseId);
  bindApplicationForm(root, caseId);
  bindInviteResponses(root, caseId);
  const checklistHost = root.querySelector("#caseChecklist");
  if (checklistHost) {
    renderChecklist(checklistHost, { caseId: data?._id || caseId }).catch((err) => {
      console.warn("Checklist failed to render", err);
      checklistHost.innerHTML = `<div class="empty">Checklist unavailable.</div>`;
    });
  }
  if (viewerRole === "paralegal") {
    hideAttorneyOnlyControls(root);
  }
  if (readOnly && purgeAt) {
    startCountdown(root.querySelector("[data-purge-countdown]"), purgeAt);
  } else if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
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
    .apply-form{display:grid;gap:8px}
    .apply-form textarea{border:1px solid #d1d5db;border-radius:10px;padding:10px;font:inherit;resize:vertical}
    .apply-status{font-size:.9rem;color:#6b7280}
    .notice{color:#6b7280;font-size:.95rem}
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
    .case-modal-overlay{position:fixed;inset:0;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center;z-index:999}
    .case-modal{background:#fff;border-radius:16px;padding:24px;max-width:420px;box-shadow:0 20px 45px rgba(0,0,0,.22)}
    .case-modal-title{font-weight:600;font-size:1.15rem;margin-bottom:8px}
    .case-modal-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:16px}
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

function renderApplicant(applicant, escapeHTML, { canInvite } = {}) {
  const person = applicant?.paralegal || {};
  const displayName =
    person?.name ||
    [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim() ||
    "Paralegal";
  const status = (applicant?.status || "pending").replace(/_/g, " ");
  const paralegalId = applicant?.paralegal?.id || applicant?.paralegalId || "";
  const appliedAt = applicant?.appliedAt ? new Date(applicant.appliedAt).toLocaleDateString() : "";
  const showInvite = canInvite && paralegalId;
  return `
    <li class="applicant-card">
      <div class="applicant-card-main">
        <div class="applicant-name">${escapeHTML(displayName)}</div>
        <div class="applicant-status">${escapeHTML(status)}${appliedAt ? ` · Applied ${escapeHTML(appliedAt)}` : ""}</div>
      </div>
      ${
        showInvite
          ? `<button class="btn primary" data-invite-paralegal data-paralegal-id="${escapeHTML(
              paralegalId
            )}">Invite</button>`
          : ""
      }
    </li>
  `;
}

function bindHireButtons(root, caseId) {
  root.querySelectorAll("[data-invite-paralegal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const paralegalId = btn.dataset.paralegalId || prompt("Enter the paralegal ID to invite:") || "";
      if (!paralegalId) {
        notify("Paralegal reference is required.", "error");
        return;
      }
      inviteParalegal(caseId, paralegalId, btn);
    });
  });
}

function bindEscrowButton(root, caseId) {
  const btn = root.querySelector("[data-start-escrow]");
  if (!btn) return;
  btn.addEventListener("click", () => startEscrow(caseId, btn));
}

function bindCompleteButton(root, caseId) {
  const btn = root.querySelector("[data-complete-case]");
  if (!btn) return;
  btn.addEventListener("click", () => showCompletionModal(caseId, btn));
}

function bindInviteResponses(root, caseId) {
  const acceptBtn = root.querySelector("[data-accept-invite]");
  const declineBtn = root.querySelector("[data-decline-invite]");
  const statusNode = root.querySelector("[data-invite-status]");

  const setStatus = (msg, ok = false) => {
    if (!statusNode) return;
    statusNode.textContent = msg || "";
    statusNode.className = "apply-status" + (ok ? " ok" : " err");
  };

  const handle = async (decision) => {
    try {
      acceptBtn?.setAttribute("disabled", "disabled");
      declineBtn?.setAttribute("disabled", "disabled");
      setStatus(decision === "accept" ? "Accepting…" : "Declining…");
      await j(`/api/cases/${encodeURIComponent(caseId)}/respond-invite`, {
        method: "POST",
        body: { decision },
      });
      setStatus("Updated. Reloading…", true);
      setTimeout(() => window.location.reload(), 500);
    } catch (err) {
      setStatus(err?.message || "Unable to update invitation.", false);
      acceptBtn?.removeAttribute("disabled");
      declineBtn?.removeAttribute("disabled");
    }
  };

  acceptBtn?.addEventListener("click", () => handle("accept"));
  declineBtn?.addEventListener("click", () => handle("decline"));
}

function bindDownloadButton(root, caseId) {
  const btn = root.querySelector("[data-download-archive]");
  if (!btn) return;
  btn.addEventListener("click", () => downloadArchive(caseId, btn));
}

function bindApplicationForm(root, caseId) {
  const form = root.querySelector("[data-case-apply-form]");
  if (!form) return;
  const textarea = form.querySelector("[data-apply-note]");
  const statusNode = form.querySelector("[data-apply-status]");
  const submitBtn = form.querySelector('button[type="submit"]');
  const defaultText = submitBtn?.textContent || "Submit application";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = textarea?.value.trim();
    if (statusNode) statusNode.textContent = "Submitting application…";
    let restoreButton = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Applying…";
    }
    try {
      await j(`/api/cases/${encodeURIComponent(caseId)}/apply`, {
        method: "POST",
        body: { note },
      });
      if (statusNode) statusNode.textContent = "Application submitted!";
      if (textarea) textarea.value = "";
      restoreButton = false;
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      if (statusNode) statusNode.textContent = err?.message || "Unable to apply right now.";
    } finally {
      if (restoreButton && submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = defaultText;
      }
    }
  });
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

async function inviteParalegal(caseId, paralegalId, button) {
  if (!caseId || !paralegalId) {
    notify("Missing case or paralegal identifier.", "error");
    return;
  }
  button?.setAttribute("disabled", "disabled");
  button?.setAttribute("data-btn-text", button.textContent || "Hire");
  if (button) button.textContent = "Inviting…";
  try {
    await j(`/api/cases/${encodeURIComponent(caseId)}/invite/${encodeURIComponent(paralegalId)}`, {
      method: "POST",
    });
    if (button) {
      button.textContent = "Invited";
      button.classList.add("success");
      button.removeAttribute("data-btn-text");
    }
    notify("Invitation sent to paralegal.", "success");
  } catch (err) {
    if (button) {
      button.removeAttribute("disabled");
      const original = button.getAttribute("data-btn-text") || "Hire";
      button.textContent = original;
      button.removeAttribute("data-btn-text");
    }
    notify(err?.message || "Unable to invite paralegal.", "error");
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

function showCompletionModal(caseId) {
  const overlay = document.createElement("div");
  overlay.className = "case-modal-overlay";
  overlay.innerHTML = `
    <div class="case-modal">
      <div class="case-modal-title">Mark case complete?</div>
      <p>Confirming will release the escrow payment, lock all uploads and messages, revoke paralegal access, generate a ZIP archive, and start a 24-hour purge timer.</p>
      <div class="case-modal-actions">
        <button class="btn" data-modal-cancel>Cancel</button>
        <button class="btn primary" data-modal-confirm>Confirm</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  overlay.querySelector("[data-modal-cancel]")?.addEventListener("click", () => overlay.remove());
  const confirmBtn = overlay.querySelector("[data-modal-confirm]");
  confirmBtn?.addEventListener("click", async () => {
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Working…";
    try {
      await completeCase(caseId);
    } finally {
      overlay.remove();
    }
  });
}

function hideAttorneyOnlyControls(root) {
  const selectors = [
    "[data-hire-paralegal]",
    "[data-start-escrow]",
    "[data-payment-panel]",
    "[data-complete-case]",
    "[data-invite-paralegal]",
    "[data-budget-edit]",
  ];
  selectors.forEach((selector) => {
    root.querySelectorAll(selector).forEach((node) => {
      node.style.display = "none";
    });
  });
}

async function completeCase(caseId) {
  if (!caseId) {
    notify("Missing case identifier.", "error");
    return;
  }
  try {
    const result = await j(`/api/cases/${encodeURIComponent(caseId)}/complete`, {
      method: "POST",
    });
    notify("Case archived. Downloading…", "success");
    if (result?.downloadPath) {
      setTimeout(() => {
        window.open(result.downloadPath, "_blank", "noopener");
      }, 300);
    }
    setTimeout(() => window.location.reload(), 1200);
  } catch (err) {
    notify(err?.message || "Unable to complete this case.", "error");
  }
}

function downloadArchive(caseId, button) {
  if (!caseId) return;
  button?.setAttribute("disabled", "disabled");
  const url = `/api/cases/${encodeURIComponent(caseId)}/archive/download`;
  window.open(url, "_blank", "noopener");
  setTimeout(() => button?.removeAttribute("disabled"), 1500);
}

function startCountdown(node, targetDate) {
  if (!node || !targetDate) return;
  const run = () => {
    const diff = targetDate.getTime() - Date.now();
    if (diff <= 0) {
      node.textContent = "00:00";
      clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }
    node.textContent = formatCountdown(targetDate);
  };
  run();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(run, 60 * 1000);
}

function formatCountdown(targetDate) {
  const diff = Math.max(0, targetDate.getTime() - Date.now());
  const totalMinutes = Math.floor(diff / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function notify(message, type = "info") {
  if (window.toastUtils?.stage) {
    window.toastUtils.stage(message, type);
  } else {
    alert(message);
  }
}
