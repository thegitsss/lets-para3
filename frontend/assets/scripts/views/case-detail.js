// frontend/assets/scripts/views/case-detail.js
// Case detail view wired to /api/cases/:caseId

import { j } from "../helpers.js";
import { requireAuth, fetchCSRF } from "../auth.js";
import { render as renderChecklist } from "./checklist.js";
import { getStripeConnectStatus, isStripeConnected, STRIPE_GATE_MESSAGE } from "../utils/stripe-connect.js";

console.log("case-detail.js loaded");

function normalizeSessionPayload(raw) {
  if (!raw) return null;
  if (raw.user) return raw;
  return {
    user: raw,
    role: raw.role,
    status: raw.status,
  };
}

function isCompletedCase(data) {
  const status = String(data?.status || "").toLowerCase();
  if (["completed", "closed"].includes(status)) return true;
  return !!(data?.readOnly && data?.paymentReleased);
}

function getCompletionRedirectForRole(role) {
  if (role === "paralegal") return "dashboard-paralegal.html";
  if (role === "admin") return "admin-dashboard.html";
  return "dashboard-attorney.html#cases:archived";
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
let hasPaymentMethodOnFile = true;
let currentViewerRole = "";
const PENDING_HIRE_KEY = "lpc_pending_hire_funding";

export async function render(el, { escapeHTML, params: routeParams } = {}) {
  ensureStyles();
  let session = null;
  try {
    const rawSession =
      typeof window.checkSession === "function"
        ? await window.checkSession(undefined, { redirectOnFail: false })
        : typeof window.requireRole === "function"
        ? await window.requireRole()
        : requireAuth();
    session = normalizeSessionPayload(rawSession);
    const viewerRole = String(session?.role || session?.user?.role || "").toLowerCase();
    if (!["attorney", "paralegal", "admin", ""].includes(viewerRole)) {
      return;
    }
  } catch {
    return;
  }
  if (!session) return;

  const viewerRole = String(session?.role || session?.user?.role || "").toLowerCase();
  currentViewerRole = viewerRole;
  const h = escapeHTML || ((s) => String(s ?? ""));
  const params = getRouteParams(routeParams);
  const caseId = params.get("caseId");

  if (!caseId) {
    el.innerHTML = `<section class="dash"><div class="error">Missing caseId.</div></section>`;
    return;
  }

  el.innerHTML = skeleton();

  try {
    const paymentCheck =
      viewerRole === "attorney" ? hasDefaultPaymentMethod() : Promise.resolve(true);
    const [data, hasPaymentMethod] = await Promise.all([
      j(`/api/cases/${encodeURIComponent(caseId)}`),
      paymentCheck,
    ]);
    if (isCompletedCase(data)) {
      window.location.href = getCompletionRedirectForRole(viewerRole);
      return;
    }
    hasPaymentMethodOnFile = hasPaymentMethod !== false;
    draw(el, data, h, caseId, session, hasPaymentMethodOnFile);
  } catch (err) {
    if (err?.status === 403) {
      el.innerHTML = `<section class="dash"><div class="error">You don’t have access to this case.</div></section>`;
      return;
    }
    el.innerHTML = `<section class="dash"><div class="error">${h(err?.message || "Unable to load case details.")}</div></section>`;
  }
}

function draw(root, data, escapeHTML, caseId, session, hasPaymentMethod) {
  const practiceArea = data?.practiceArea || "General matter";
  const title = data?.title || "Case";
  const statusRaw = String(data?.status || "open");
  const statusKey = statusRaw.toLowerCase();
  const isFinal = statusKey === "completed" || data?.paymentReleased;
  const budgetCents = Number.isFinite(data?.lockedTotalAmount)
    ? data.lockedTotalAmount
    : Number(data?.totalAmount) || 0;
  const budgetDisplay = formatCurrency(budgetCents / 100);
  const zoomLink = data?.zoomLink;
  const escrowFunded =
    !!data?.escrowIntentId && String(data?.escrowStatus || "").toLowerCase() === "funded";
  const applicants = Array.isArray(data?.applicants) ? data.applicants : [];
  const viewer = session?.user || {};
  const viewerRole = String(session?.role || viewer.role || "").toLowerCase();
  const viewerId = viewer?.id || viewer?._id || session?.id || "";
  const ownerId = data?.attorney?._id || data?.attorney?.id || data?.attorneyId || "";
  const isOwner = viewerRole === "attorney" && ownerId && viewerId && String(ownerId) === String(viewerId);
  const isAdmin = viewerRole === "admin";
  const paralegalOnCase = !!data?.paralegal;
  const paralegalName =
    data?.paralegal?.name ||
    [data?.paralegal?.firstName, data?.paralegal?.lastName].filter(Boolean).join(" ").trim() ||
    data?.paralegalNameSnapshot ||
    "Paralegal";
  const pendingParalegalId =
    data?.pendingParalegalId || data?.pendingParalegal?._id || data?.pendingParalegal?.id;
  const pendingParalegalName =
    data?.pendingParalegal?.name ||
    [data?.pendingParalegal?.firstName, data?.pendingParalegal?.lastName].filter(Boolean).join(" ").trim();
  const pendingInvites = Array.isArray(data?.invites)
    ? data.invites.filter((invite) => String(invite?.status || "pending").toLowerCase() === "pending")
    : [];
  const pendingInviteCount =
    pendingInvites.length || (pendingParalegalId ? 1 : 0);
  const viewerInvite = pendingInvites.find(
    (invite) => viewerId && String(invite?.paralegalId) === String(viewerId)
  );
  const viewerIsInvited =
    !isFinal &&
    viewerRole === "paralegal" &&
    viewerId &&
    (viewerInvite ||
      (pendingParalegalId && String(pendingParalegalId) === String(viewerId)));
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
  const termination = normalizeTermination(data?.termination);
  const caseLocked = statusRaw === "disputed" || termination.status === "disputed";
  const showPayment =
    !caseLocked &&
    !isFinal &&
    (isOwner || isAdmin) &&
    paralegalOnCase &&
    !escrowFunded &&
    !data?.paymentReleased &&
    !readOnly;
  const showCompleteButton =
    !caseLocked &&
    !isFinal &&
    (isOwner || isAdmin) &&
    paralegalOnCase &&
    !data?.paymentReleased &&
    !readOnly;
  const isOpenCase = statusKey === "open";
  const canHire =
    (isOwner || isAdmin) &&
    isOpenCase &&
    !paralegalOnCase &&
    !data?.paymentReleased &&
    !readOnly &&
    !isFinal;
  const paymentBlocked = viewerRole === "attorney" && hasPaymentMethod === false;
  const canApply =
    viewerRole === "paralegal" &&
    isOpenCase &&
    !paralegalOnCase &&
    !alreadyApplied &&
    !data?.paymentReleased &&
    !isFinal;

  const statusLabel = formatCaseStatus(statusRaw, { hasParalegal: paralegalOnCase, escrowFunded });
  const fundingNotice =
    paralegalOnCase && !escrowFunded
      ? `<div class="notice">${
          isOwner || isAdmin
            ? `${escapeHTML(paralegalName)} has been hired. Fund escrow to start work.`
            : `${escapeHTML(paralegalName)} has been hired. Awaiting attorney funding.`
        }</div>`
      : "";

  const applicantsMarkup =
    applicants.length
      ? `<ul class="applicant-list">${applicants
          .map((app) => renderApplicant(app, escapeHTML, { canHire, paymentBlocked }))
          .join("")}</ul>`
      : `<div class="empty">No applications yet.</div>`;

  const applicationsSection =
    (isOwner || isAdmin) && isOpenCase
      ? `
      <div class="case-section">
        <div class="case-section-title">Applications</div>
        ${applicantsMarkup}
      </div>
    `
      : "";

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
            <p class="apply-footnote">Your résumé, LinkedIn profile, and saved cover letter are included automatically.</p>
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

  const canTerminate =
    !caseLocked &&
    (isOwner || isAdmin) &&
    paralegalOnCase &&
    !readOnly &&
    !["cancelled", "closed"].includes(statusRaw) &&
    termination.status === "none";
  const actionsSection =
    showPayment || showCompleteButton || canTerminate
      ? `
      <div class="case-section">
        <div class="case-section-title">Actions</div>
        <div class="case-actions">
          ${
            showPayment
              ? `<button class="btn primary" data-start-escrow>Hire &amp; Start Work</button>
                 <div class="payment-panel" data-payment-panel>
                   <div data-card-element></div>
                   <div class="card-errors" data-card-errors></div>
                 </div>`
              : ""
          }
          ${
            showCompleteButton
              ? `<button class="btn secondary" data-complete-case>Approve &amp; Release Funds</button>`
              : ""
          }
          ${
            canTerminate
              ? `<button class="btn danger" data-terminate-case>Terminate Engagement</button>`
              : ""
          }
        </div>
      </div>`
      : "";
  const terminationNotice = renderTerminationNotice(termination, escapeHTML);

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
      <div class="case-meta">Posted amount: ${escapeHTML(budgetDisplay)}</div>
      <div class="case-status-pill">${escapeHTML(statusLabel)}</div>
      ${fundingNotice}
      ${
        pendingInviteCount
          ? `<div class="notice">${
              pendingInviteCount === 1 && pendingParalegalName
                ? `Invitation sent to ${escapeHTML(pendingParalegalName)}. Awaiting response.`
                : `Invitations pending (${pendingInviteCount}). Awaiting responses.`
            }</div>`
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

      ${applicationsSection}
      ${applicationSection}
      ${terminationNotice}
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
  bindTerminationButton(root, caseId);
  bindApplicantDocLinks(root);
  if (isFinal) {
    removeWorkspaceActions(root);
  }
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
    .applicant-card{display:flex;align-items:flex-start;gap:16px;border:1px solid #e5e7eb;padding:16px;border-radius:14px;background:#fff}
    .applicant-card-main{display:grid;gap:8px;flex:1}
    .applicant-name{font-weight:600;font-size:1rem}
    .applicant-name a{color:inherit;text-decoration:none;border-bottom:1px solid transparent;transition:color .2s ease,border-color .2s ease}
    .applicant-name a:hover,.applicant-name a:focus{color:#0f172a;border-color:#0f172a}
    .applicant-status{font-size:.85rem;color:#6b7280;text-transform:capitalize}
    .applicant-summary{display:flex;flex-wrap:wrap;gap:8px}
    .applicant-summary span{font-size:.8rem;color:#374151;background:#f3f4f6;padding:2px 10px;border-radius:999px}
    .applicant-cover{border:1px solid #e5e7eb;border-radius:12px;padding:10px}
    .applicant-cover .cover-label{font-size:.75rem;color:#6b7280;letter-spacing:.05em;text-transform:uppercase;margin-bottom:4px}
    .applicant-cover p{margin:0;font-size:.95rem;line-height:1.5;color:#111827}
    .applicant-links{display:flex;flex-wrap:wrap;gap:8px}
    .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;font-size:.85rem;border:1px solid #d1d5db;text-decoration:none;color:#111827;background:#fff}
    .chip.muted{color:#9ca3af;border-color:#e5e7eb;background:#f9fafb}
    .applicant-avatar img,.applicant-avatar .avatar-fallback{width:56px;height:56px;border-radius:50%}
    .applicant-avatar img{object-fit:cover;border:1px solid #e5e7eb}
    .avatar-fallback{display:flex;align-items:center;justify-content:center;font-weight:600;color:#4b5563;background:#f3f4f6}
    .applicant-actions{display:flex;align-items:center}
    .apply-footnote{font-size:.85rem;color:#6b7280;margin:0}
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
      <div class="case-meta shimmer" style="width:200px"></div>
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

function formatCurrency(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatCaseStatus(statusRaw, { hasParalegal = false, escrowFunded = false } = {}) {
  const key = String(statusRaw || "").trim().toLowerCase();
  if (key === "awaiting_funding" || (hasParalegal && !escrowFunded && key !== "open")) {
    return "Hired - Pending Funding";
  }
  if (!key) return "Open";
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeAttribute(value = "") {
  return String(value ?? "").replace(/"/g, "&quot;");
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function normalizeDocKey(value) {
  if (!value) return "";
  return String(value).replace(/^\/+/, "");
}

function renderApplicant(applicant, escapeHTML, { canHire, paymentBlocked } = {}) {
  const person =
    applicant?.paralegal && typeof applicant.paralegal === "object"
      ? applicant.paralegal
      : applicant?.paralegalId && typeof applicant.paralegalId === "object"
      ? applicant.paralegalId
      : {};
  const displayName =
    person?.name ||
    [person?.firstName, person?.lastName].filter(Boolean).join(" ").trim() ||
    "Paralegal";
  const status = (applicant?.status || "pending").replace(/_/g, " ");
  const paralegalId =
    applicant?.paralegal?.id ||
    applicant?.paralegal?._id ||
    applicant?.paralegalId?._id ||
    applicant?.paralegalId ||
    "";
  const appliedAt = applicant?.appliedAt ? new Date(applicant.appliedAt).toLocaleDateString() : "";
  const showHire = canHire && paralegalId;
  const hireDisabledAttr = paymentBlocked && showHire
    ? ' disabled aria-disabled="true" title="Add a payment method to fund escrow."'
    : "";
  const snapshot = applicant?.profileSnapshot && typeof applicant.profileSnapshot === "object" ? applicant.profileSnapshot : {};
  const languages = Array.isArray(snapshot.languages) ? snapshot.languages.filter(Boolean) : [];
  const specialties = Array.isArray(snapshot.specialties) ? snapshot.specialties.filter(Boolean) : [];
  const summaryBits = [];
  if (snapshot.location) summaryBits.push(snapshot.location);
  if (snapshot.availability) summaryBits.push(snapshot.availability);
  if (typeof snapshot.yearsExperience === "number") {
    summaryBits.push(`${snapshot.yearsExperience}+ yrs experience`);
  }
  if (languages.length) summaryBits.push(`Languages: ${languages.join(", ")}`);
  if (!languages.length && specialties.length) {
    summaryBits.push(`Focus: ${specialties.slice(0, 2).join(", ")}`);
  }
  const summaryHtml = summaryBits.length
    ? `<div class="applicant-summary">${summaryBits.map((bit) => `<span>${escapeHTML(bit)}</span>`).join("")}</div>`
    : "";
  const coverLetter = applicant?.coverLetter || applicant?.note || "";
  const coverLetterHtml = coverLetter
    ? `<div class="applicant-cover">
        <div class="cover-label">Cover letter</div>
        <p>${escapeHTML(coverLetter).replace(/\n/g, "<br>")}</p>
      </div>`
    : "";
  const paymentHelperHtml =
    paymentBlocked && showHire ? `<div class="notice">Payment method required to fund escrow.</div>` : "";
  const resumeURL = applicant?.resumeURL || "";
  const resumeIsHttp = isHttpUrl(resumeURL);
  const resumeKey = resumeIsHttp ? "" : normalizeDocKey(resumeURL);
  const linkedInURL = applicant?.linkedInURL || "";
  const paymentCta =
    paymentBlocked && showHire ? `<a class="chip" href="dashboard-attorney.html#billing">Add payment method</a>` : "";
  const profileHref = paralegalId
    ? `profile-paralegal.html?paralegalId=${encodeURIComponent(paralegalId)}`
    : "";
  const avatar = snapshot.profileImage || person?.profileImage || person?.avatarURL || "";
  const avatarMarkup = avatar
    ? `<img src="${escapeAttribute(avatar)}" alt="${escapeHTML(displayName)}" />`
    : `<div class="avatar-fallback">${escapeHTML(displayName.charAt(0) || "P")}</div>`;

  return `
    <li class="applicant-card">
      <div class="applicant-avatar">
        ${avatarMarkup}
      </div>
      <div class="applicant-card-main">
        <div class="applicant-name">
          ${
            profileHref
              ? `<a href="${escapeAttribute(profileHref)}">${escapeHTML(displayName)}</a>`
              : `${escapeHTML(displayName)}`
          }
        </div>
        <div class="applicant-status">${escapeHTML(status)}${appliedAt ? ` · Applied ${escapeHTML(appliedAt)}` : ""}</div>
        ${summaryHtml}
        ${coverLetterHtml}
        ${paymentHelperHtml}
        <div class="applicant-links">
          ${
            resumeURL
              ? resumeIsHttp
                ? `<a class="chip" href="${escapeAttribute(resumeURL)}" target="_blank" rel="noopener">Résumé</a>`
                : `<a class="chip" href="#" data-doc-key="${escapeAttribute(resumeKey)}">Résumé</a>`
              : `<span class="chip muted" aria-disabled="true">No résumé</span>`
          }
          ${
            linkedInURL
              ? `<a class="chip" href="${escapeAttribute(linkedInURL)}" target="_blank" rel="noopener">LinkedIn</a>`
              : `<span class="chip muted" aria-disabled="true">LinkedIn unavailable</span>`
          }
          ${paymentCta}
        </div>
      </div>
      ${
        showHire
          ? `<div class="applicant-actions">
              <button class="btn primary" data-hire-paralegal data-paralegal-id="${escapeHTML(
                paralegalId
              )}" data-paralegal-name="${escapeAttribute(displayName)}"${hireDisabledAttr}>Hire</button>
            </div>`
          : ""
      }
    </li>
  `;
}

function normalizeTermination(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      status: "none",
      reason: "",
      requestedAt: null,
      requestedBy: null,
      disputeId: null,
      terminatedAt: null,
    };
  }
  return {
    status: raw.status || "none",
    reason: raw.reason || "",
    requestedAt: raw.requestedAt ? new Date(raw.requestedAt) : null,
    requestedBy: raw.requestedBy || null,
    disputeId: raw.disputeId || null,
    terminatedAt: raw.terminatedAt ? new Date(raw.terminatedAt) : null,
  };
}

function renderTerminationNotice(termination, escapeHTML) {
  if (!termination || termination.status === "none") return "";
  if (termination.status === "disputed") {
    return `
      <div class="case-section notice">
        <div class="case-section-title">Termination under review</div>
        <p class="notice">This engagement is paused while our admin team reviews the dispute${
          termination.reason ? `: ${escapeHTML(termination.reason)}` : "."
        }</p>
      </div>
    `;
  }
  if (termination.status === "auto_cancelled") {
    const reason = termination.reason
      ? escapeHTML(termination.reason)
      : "The case was cancelled before work began.";
    return `
      <div class="case-section notice">
        <div class="case-section-title">Engagement ended</div>
        <p class="notice">${reason}</p>
      </div>
    `;
  }
  return "";
}

function bindHireButtons(root, caseId) {
  root.querySelectorAll("[data-hire-paralegal]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!hasPaymentMethodOnFile) {
        notify("Add a payment method to fund escrow before hiring.", "error");
        return;
      }
      const paralegalId = btn.dataset.paralegalId || "";
      const paralegalName = btn.dataset.paralegalName || "Paralegal";
      if (!paralegalId) {
        notify("Paralegal ID is required.", "error");
        return;
      }
      const confirmed = await openHireConfirmModal(paralegalName);
      if (!confirmed) return;
      hireParalegal(caseId, paralegalId, paralegalName, btn);
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
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    btn.setAttribute("disabled", "disabled");
    showCompletionModal(caseId, btn);
  });
}

function bindTerminationButton(root, caseId) {
  const btn = root.querySelector("[data-terminate-case]");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const confirmed = window.confirm("Terminate this engagement? This cannot be undone.");
    if (!confirmed) return;
    const reason = window.prompt("Share any context for the admin team (optional):", "") || "";
    submitTerminationRequest(caseId, btn, reason);
  });
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
        noRedirect: true,
      });
      setStatus("Updated. Reloading…", true);
      setTimeout(() => window.location.reload(), 500);
    } catch (err) {
      const stripeBlocked = err?.status === 403 && /stripe/i.test(err?.message || "");
      const message = stripeBlocked ? err?.message || STRIPE_GATE_MESSAGE : err?.message || "Unable to update invitation.";
      setStatus(message, false);
      if (stripeBlocked) {
        notify(message, "error");
      }
      acceptBtn?.removeAttribute("disabled");
      declineBtn?.removeAttribute("disabled");
    }
  };

  acceptBtn?.addEventListener("click", () => handle("accept"));
  declineBtn?.addEventListener("click", () => handle("decline"));
}

async function submitTerminationRequest(caseId, button, reason) {
  if (!caseId) return;
  button?.setAttribute("disabled", "disabled");
  try {
    const payload = await j(`/api/cases/${encodeURIComponent(caseId)}/terminate`, {
      method: "POST",
      body: { reason },
    });
    const message = payload?.requiresAdmin
      ? "Case paused while an admin reviews the dispute."
      : "Case terminated successfully.";
    notify(message, "success");
    setTimeout(() => window.location.reload(), 900);
  } catch (err) {
    notify(err?.message || "Unable to terminate this case.", "error");
  } finally {
    button?.removeAttribute("disabled");
  }
}

function bindDownloadButton(root, caseId) {
  const btn = root.querySelector("[data-download-archive]");
  if (!btn) return;
  btn.addEventListener("click", () => downloadArchive(caseId, btn));
}

function bindApplicantDocLinks(root) {
  const list = root?.querySelector(".applicant-list");
  if (!list || list.dataset.docsBound === "true") return;
  list.dataset.docsBound = "true";
  list.addEventListener("click", async (event) => {
    const link = event.target.closest("a[data-doc-key]");
    if (!link) return;
    event.preventDefault();
    const key = link.dataset.docKey || "";
    if (!key) return;
    try {
      const params = new URLSearchParams({ key });
      const data = await j(`/api/uploads/signed-get?${params.toString()}`);
      if (data?.url) {
        window.open(data.url, "_blank", "noopener");
      } else {
        notify("Document unavailable.", "error");
      }
    } catch (err) {
      notify(err?.message || "Unable to open document.", "error");
    }
  });
}

function bindApplicationForm(root, caseId) {
  const form = root.querySelector("[data-case-apply-form]");
  if (!form) return;
  const textarea = form.querySelector("[data-apply-note]");
  const statusNode = form.querySelector("[data-apply-status]");
  const submitBtn = form.querySelector('button[type="submit"]');
  const defaultText = submitBtn?.textContent || "Submit application";
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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!stripeConnected) {
      if (statusNode) statusNode.textContent = STRIPE_GATE_MESSAGE;
      return;
    }
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
        noRedirect: true,
      });
      if (statusNode) statusNode.textContent = "Application submitted!";
      if (textarea) textarea.value = "";
      restoreButton = false;
      setTimeout(() => window.location.reload(), 800);
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

async function hireParalegal(caseId, paralegalId, paralegalName, button) {
  if (!caseId || !paralegalId) {
    notify("Missing case or paralegal identifier.", "error");
    return;
  }
  const originalText = button?.textContent || "Hire";
  if (button) {
    button.dataset.btnText = originalText;
    button.textContent = "Processing...";
    button.setAttribute("disabled", "disabled");
  }

  try {
    const paymentReady = await hasDefaultPaymentMethod();
    if (!paymentReady) {
      notify("Add a payment method to fund escrow before hiring.", "error");
      if (button) {
        button.removeAttribute("disabled");
        button.textContent = button.dataset.btnText || "Hire";
        delete button.dataset.btnText;
      }
      return;
    }
    const csrfToken = await fetchCSRF().catch(() => "");
    const res = await fetch(
      `/api/cases/${encodeURIComponent(caseId)}/hire/${encodeURIComponent(paralegalId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({}),
      }
    );
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error || "Unable to hire paralegal.");
    }
    const escrowStatus = String(payload?.escrowStatus || "").toLowerCase();
    const funded = escrowStatus === "funded";
    const displayName = paralegalName || "Paralegal";
    const hasPaymentMethod = await hasDefaultPaymentMethod();
    if (!funded && !hasPaymentMethod) {
      const message = `Add a payment method to hire '${displayName}'`;
      storePendingHire({ caseId, paralegalName: displayName, message });
      notify(`${displayName} has been hired. Redirecting to Billing...`, "success");
      setTimeout(() => {
        window.location.href = "dashboard-attorney.html#billing";
      }, 400);
      return;
    }
    notify(
      funded
        ? `${displayName} has been hired. Escrow funded. Opening workspace...`
        : `${displayName} has been hired. Redirecting to fund escrow...`,
      "success"
    );
    const target = funded
      ? `case-detail.html?caseId=${encodeURIComponent(caseId)}`
      : `fund-escrow.html?caseId=${encodeURIComponent(caseId)}`;
    setTimeout(() => {
      window.location.href = target;
    }, 400);
  } catch (err) {
    notify(err?.message || "Unable to hire paralegal.", "error");
  } finally {
    if (button) {
      button.removeAttribute("disabled");
      button.textContent = button.dataset.btnText || "Hire";
      delete button.dataset.btnText;
    }
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
        existing.addEventListener("error", () =>
          reject(new Error("We couldn't load the secure payment form. Please allow js.stripe.com or disable ad blockers and try again."))
        );
        return;
      }
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("We couldn't load the secure payment form. Please allow js.stripe.com or disable ad blockers and try again."));
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
  const originalText = button?.textContent || "Hire & Start Work";
  if (button) {
    button.dataset.btnText = originalText;
    button.textContent = "Processing payment...";
    button.setAttribute("aria-busy", "true");
  }
  try {
    await ensureStripeCard();
  } catch (err) {
    notify(err?.message || "Unable to load payment form.", "error");
    if (button) {
      button.textContent = button.dataset.btnText || originalText;
      button.removeAttribute("aria-busy");
      delete button.dataset.btnText;
    }
    return;
  }
  if (!cardElementInstance) {
    notify("Payment form is not ready.", "error");
    if (button) {
      button.textContent = button.dataset.btnText || originalText;
      button.removeAttribute("aria-busy");
      delete button.dataset.btnText;
    }
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
    if (button) {
      button.textContent = button.dataset.btnText || originalText;
      button.removeAttribute("aria-busy");
      delete button.dataset.btnText;
    }
    notify(err?.message || "Unable to fund escrow.", "error");
  }
}

function showCompletionModal(caseId, triggerButton) {
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
  const restoreTrigger = () => {
    triggerButton?.removeAttribute("disabled");
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      overlay.remove();
      restoreTrigger();
    }
  });
  overlay.querySelector("[data-modal-cancel]")?.addEventListener("click", () => {
    overlay.remove();
    restoreTrigger();
  });
  const confirmBtn = overlay.querySelector("[data-modal-confirm]");
  confirmBtn?.addEventListener("click", async () => {
    if (confirmBtn.disabled) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Working…";
    try {
      const result = await completeCase(caseId);
      if (result?.ok) {
        triggerButton?.setAttribute("disabled", "disabled");
        if (triggerButton) triggerButton.hidden = true;
      } else {
        restoreTrigger();
      }
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

function removeWorkspaceActions(root) {
  if (!root) return;
  const selectors = [
    "[data-hire-paralegal]",
    "[data-start-escrow]",
    "[data-complete-case]",
    "[data-terminate-case]",
    "[data-invite-paralegal]",
    "[data-case-apply-form]",
    "[data-accept-invite]",
    "[data-decline-invite]",
  ];
  selectors.forEach((selector) => {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  });
}

async function completeCase(caseId) {
  if (!caseId) {
    notify("Missing case identifier.", "error");
    return { ok: false };
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
    removeWorkspaceActions(document);
    const redirect = getCompletionRedirectForRole(currentViewerRole);
    if (redirect) {
      setTimeout(() => {
        window.location.href = redirect;
      }, 900);
    }
    return { ok: true, result };
  } catch (err) {
    notify(err?.message || "Unable to complete this case.", "error");
    return { ok: false };
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

async function hasDefaultPaymentMethod() {
  try {
    const res = await fetch("/api/payments/payment-method/default", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return false;
    return !!payload?.paymentMethod;
  } catch {
    return false;
  }
}

function storePendingHire(payload) {
  if (!payload?.caseId) return;
  const data = {
    caseId: String(payload.caseId),
    paralegalName: payload.paralegalName || "",
    message: payload.message || "",
    fundUrl: `fund-escrow.html?caseId=${encodeURIComponent(payload.caseId)}`,
  };
  try {
    localStorage.setItem(PENDING_HIRE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function openHireConfirmModal(paralegalName) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "case-modal-overlay";
    overlay.innerHTML = `
      <div class="case-modal" role="dialog" aria-modal="true" aria-labelledby="hireConfirmTitle">
        <div class="case-modal-title" id="hireConfirmTitle">Confirm Hire</div>
        <p>You’re about to hire '<span data-hire-name></span>' for this case.</p>
        <p>Once hired, this case will move forward and escrow funding will be required to begin work.</p>
        <p>You’ll be able to review progress and release funds only after approving completed work.</p>
        <div class="case-modal-actions">
          <button class="btn" data-hire-cancel>Cancel</button>
          <button class="btn primary" data-hire-confirm>Confirm Hire</button>
        </div>
      </div>
    `;
    const nameNode = overlay.querySelector("[data-hire-name]");
    if (nameNode) nameNode.textContent = paralegalName || "Paralegal";
    const close = (confirmed) => {
      overlay.remove();
      resolve(confirmed);
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(false);
    });
    overlay.querySelector("[data-hire-cancel]")?.addEventListener("click", () => close(false));
    overlay.querySelector("[data-hire-confirm]")?.addEventListener("click", () => close(true));
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close(false);
      },
      { once: true }
    );
    document.body.appendChild(overlay);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("hireStartWorkBtn");
  console.log("hireStartWorkBtn found:", btn);

  if (!btn) return;

  const postHire = async (caseId, paralegalId) => {
    const csrfToken = await fetchCSRF().catch(() => "");
    const res = await fetch(
      `/api/cases/${encodeURIComponent(caseId)}/hire/${encodeURIComponent(paralegalId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({}),
      }
    );
    const payload = await res.json().catch(() => ({}));
    return { res, payload };
  };

  btn.addEventListener("click", async () => {
    console.log("HIRE CLICKED");
    const caseId =
      window.caseId ||
      window.CASE_ID ||
      document.body?.dataset?.caseId ||
      new URLSearchParams(window.location.search).get("caseId") ||
      "";
    const paralegalId =
      window.paralegalId ||
      window.PARALEGAL_ID ||
      document.body?.dataset?.paralegalId ||
      btn.dataset.paralegalId ||
      "";
    const paralegalName = btn.dataset.paralegalName || "Paralegal";

    try {
      const confirmed = await openHireConfirmModal(paralegalName);
      if (!confirmed) return;
      const originalText = btn.textContent || "Hire & Start Work";
      btn.dataset.btnText = originalText;
      btn.disabled = true;
      btn.textContent = "Processing...";

      const { res, payload } = await postHire(caseId, paralegalId);
      console.log("Hire response status:", res.status);
      console.log("Hire response JSON:", payload);

      if (res.ok) {
        const escrowStatus = String(payload?.escrowStatus || "").toLowerCase();
        const funded = escrowStatus === "funded";
        const displayName = paralegalName || "Paralegal";
        const hasPaymentMethod = await hasDefaultPaymentMethod();
        if (!funded && !hasPaymentMethod) {
          const message = `Add a payment method to hire '${displayName}'`;
          storePendingHire({ caseId, paralegalName: displayName, message });
          notify(`${displayName} has been hired. Redirecting to Billing...`, "success");
          setTimeout(() => {
            window.location.href = "dashboard-attorney.html#billing";
          }, 400);
          return;
        }
        notify(
          funded
            ? `${displayName} has been hired. Escrow funded. Opening workspace...`
            : `${displayName} has been hired. Redirecting to fund escrow...`,
          "success"
        );
        const target = funded
          ? `case-detail.html?caseId=${encodeURIComponent(caseId)}`
          : `fund-escrow.html?caseId=${encodeURIComponent(caseId)}`;
        setTimeout(() => {
          window.location.href = target;
        }, 400);
        return;
      }

      throw new Error(payload?.error || "Unable to hire paralegal.");
    } catch (err) {
      console.error("Hire request failed:", err);
      notify(err?.message || "Unable to hire paralegal.", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = btn.dataset.btnText || "Hire & Start Work";
      delete btn.dataset.btnText;
    }
  });
});
