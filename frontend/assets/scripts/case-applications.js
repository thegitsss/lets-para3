import { secureFetch, fetchCSRF, requireAuth } from "./auth.js";
import { escapeHTML } from "./helpers.js";

const applicantList = document.getElementById("applicantList");
const caseTitle = document.getElementById("caseTitle");
const caseMeta = document.getElementById("caseMeta");
const caseNotice = document.getElementById("caseNotice");

const state = {
  caseId: "",
  canHire: false,
  hasPaymentMethod: true,
  caseAmountCents: 0,
  caseCurrency: "USD",
};

const PLATFORM_FEE_PCT = 22;
const DEFAULT_HIRE_ERROR = "Unable to hire paralegal.";
const MISSING_DOCUMENT_MESSAGE = "This document is no longer available for download.";

function isDisputeWindowActive(caseData) {
  if (!caseData?.disputeDeadlineAt) return false;
  const deadline = new Date(caseData.disputeDeadlineAt).getTime();
  if (Number.isNaN(deadline)) return false;
  return Date.now() < deadline;
}

function resolveBudgetCents(caseData) {
  if (!caseData) return 0;
  if (Number.isFinite(caseData?.remainingAmount)) return caseData.remainingAmount;
  if (Number.isFinite(caseData?.lockedTotalAmount)) return caseData.lockedTotalAmount;
  if (Number.isFinite(caseData?.totalAmount)) return caseData.totalAmount;
  return 0;
}

function formatHireErrorMessage(message) {
  if (!message || typeof message !== "string") return DEFAULT_HIRE_ERROR;
  const normalized = message.toLowerCase();
  if (normalized.includes("stripe") && normalized.includes("connect")) {
    return "This paralegal must connect Stripe before you can hire them.";
  }
  if (
    normalized.includes("stripe") &&
    (normalized.includes("onboard") || normalized.includes("onboarding") || normalized.includes("payout"))
  ) {
    return "This paralegal must complete Stripe onboarding before you can hire them.";
  }
  return message;
}

init();

async function init() {
  requireAuth("attorney");
  const params = new URLSearchParams(window.location.search);
  const caseId = params.get("caseId") || "";
  if (!caseId) {
    setNotice("Missing caseId.", "error");
    return;
  }
  state.caseId = caseId;
  state.hasPaymentMethod = await hasDefaultPaymentMethod();
  await loadCase(caseId);
}

async function loadCase(caseId) {
  setNotice("", "");
  if (caseMeta) caseMeta.textContent = "Loading case details…";
  if (applicantList) applicantList.innerHTML = "";
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error || "Unable to load case details.");
    }
    renderCase(payload);
  } catch (err) {
    setNotice(err?.message || "Unable to load case details.", "error");
    if (caseMeta) caseMeta.textContent = "Case details unavailable.";
  }
}

function renderCase(data) {
  const title = data?.title || "Case Applications";
  const statusRaw = String(data?.status || "open");
  const statusKey = statusRaw.toLowerCase();
  const budgetCents = resolveBudgetCents(data);
  state.caseAmountCents = budgetCents;
  state.caseCurrency = data?.currency || "USD";
  const budget = Number.isFinite(budgetCents) ? formatCurrency(budgetCents / 100) : "—";
  const practice = data?.practiceArea || "General";
  const escrowFunded =
    !!data?.escrowIntentId && String(data?.escrowStatus || "").toLowerCase() === "funded";

  if (caseTitle) caseTitle.textContent = title;
  if (caseMeta) {
    const status = formatCaseStatus(statusRaw, { hasParalegal: !!(data?.paralegal || data?.paralegalId), escrowFunded });
    caseMeta.textContent = `Status: ${status || "—"} · Practice: ${practice} · Budget: ${budget}`;
  }

  const hasParalegal = !!(data?.paralegal || data?.paralegalId);
  const isOpenCase = statusKey === "open";
  const isRelisted = statusKey === "paused" && !!data?.relistRequestedAt;
  const disputeActive = isDisputeWindowActive(data);
  const payoutFinalized = !!data?.payoutFinalizedAt;
  const relistLocked = disputeActive || (isRelisted && !payoutFinalized);
  const hasBudget = Number.isFinite(budgetCents) && budgetCents > 0;
  state.canHire = (isOpenCase || isRelisted) && !hasParalegal && !data?.readOnly && !relistLocked && hasBudget;

  if (hasParalegal) {
    const hiredName = resolveParalegalName(data);
    setNotice(
      escrowFunded
        ? `${hiredName} has been hired. Case is funded and work can begin.`
        : `${hiredName} has been hired. Case funding is pending.`,
      "success"
    );
  } else if (isRelisted) {
    if (relistLocked) {
      if (!payoutFinalized) {
        setNotice("Case relist is locked until payout is finalized.", "error");
      } else {
        const deadlineText = data?.disputeDeadlineAt
          ? new Date(data.disputeDeadlineAt).toLocaleString()
          : "after the 24-hour hold ends";
        setNotice(`Case relisted. Hiring is locked until ${deadlineText}.`, "error");
      }
    } else if (!hasBudget) {
      setNotice("Remaining case balance is $0. Hiring is unavailable.", "error");
    } else {
      setNotice("Case relisted and ready for hiring.", "success");
    }
  } else if (!isOpenCase) {
    setNotice("Applications are available while the case is open.", "error");
  } else if (!state.canHire) {
    setNotice("A paralegal is already in progress for this case.", "error");
  }

  const applicants = Array.isArray(data?.applicants) ? data.applicants : [];
  if (hasParalegal) {
    if (applicantList) {
      applicantList.innerHTML = `<li class="empty">${escapeHTML(resolveParalegalName(data))} has been hired.</li>`;
    }
    return;
  }
  renderApplicants(applicants);
}

function renderApplicants(applicants = []) {
  if (!applicantList) return;
  if (!applicants.length) {
    applicantList.innerHTML = `<li class="empty">No applications yet.</li>`;
    return;
  }
  applicantList.innerHTML = applicants.map((app) => buildApplicantMarkup(app)).join("");
  bindApplicantActions();
}

function buildApplicantMarkup(applicant) {
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
  const paralegalId =
    applicant?.paralegal?.id ||
    applicant?.paralegal?._id ||
    applicant?.paralegalId?._id ||
    applicant?.paralegalId ||
    "";
  const appliedAt = applicant?.appliedAt
    ? new Date(applicant.appliedAt).toLocaleDateString()
    : "";
  const showHire = state.canHire && paralegalId;
  const paymentBlocked = showHire && !state.hasPaymentMethod;
  const hireDisabledAttr = paymentBlocked
    ? ' disabled aria-disabled="true" title="Add a payment method to hire."'
    : "";

  const snapshot = applicant?.profileSnapshot && typeof applicant.profileSnapshot === "object"
    ? applicant.profileSnapshot
    : {};
  const summary = [];
  if (snapshot.location) summary.push(snapshot.location);
  if (snapshot.availability) summary.push(snapshot.availability);
  if (typeof snapshot.yearsExperience === "number") {
    summary.push(`${snapshot.yearsExperience}+ yrs experience`);
  }
  const languages = Array.isArray(snapshot.languages) ? snapshot.languages.filter(Boolean) : [];
  if (languages.length) summary.push(`Languages: ${languages.join(", ")}`);

  const coverLetter = applicant?.coverLetter || applicant?.note || "";
  const avatar = snapshot.profileImage || person?.profileImage || person?.avatarURL || "";
  const avatarMarkup = avatar
    ? `<img src="${escapeAttribute(avatar)}" alt="${escapeHTML(displayName)}" />`
    : `<span>${escapeHTML(displayName.charAt(0) || "P")}</span>`;

  const resumeURL = applicant?.resumeURL || "";
  const resumeIsHttp = isHttpUrl(resumeURL);
  const resumeKey = resumeIsHttp ? "" : normalizeDocKey(resumeURL);
  const linkedInURL = applicant?.linkedInURL || "";
  const profileHref = paralegalId
    ? `profile-paralegal.html?paralegalId=${encodeURIComponent(paralegalId)}`
    : "";

  return `
    <li class="applicant-card">
      <div class="applicant-avatar">${avatarMarkup}</div>
      <div>
        <div class="applicant-name">
          ${profileHref ? `<a href="${escapeAttribute(profileHref)}">${escapeHTML(displayName)}</a>` : escapeHTML(displayName)}
        </div>
        <div class="applicant-meta">${escapeHTML(appliedAt ? `Applied ${appliedAt}` : "Applied recently")}</div>
        ${
          summary.length
            ? `<div class="applicant-summary">${summary.map((item) => `<span class="chip">${escapeHTML(item)}</span>`).join("")}</div>`
            : ""
        }
        <div class="applicant-summary" style="margin-top:10px;">
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
        </div>
        ${
          coverLetter
            ? `<div class="cover">
                <div class="label">Cover message</div>
                <div>${escapeHTML(coverLetter).replace(/\n/g, "<br>")}</div>
              </div>`
            : ""
        }
      </div>
      <div class="applicant-actions">
        ${
          showHire
            ? `<button class="btn primary" data-hire-paralegal data-paralegal-id="${escapeHTML(
                paralegalId
              )}" data-paralegal-name="${escapeAttribute(displayName)}"${hireDisabledAttr}>Hire</button>`
            : ""
        }
        ${
          paymentBlocked
            ? `<div class="applicant-meta">Payment method required to hire.</div>
              <a class="btn" href="dashboard-attorney.html#billing">Add payment method</a>`
            : ""
        }
      </div>
    </li>
  `;
}

function bindApplicantActions() {
  applicantList?.addEventListener("click", async (event) => {
    const hireBtn = event.target.closest("[data-hire-paralegal]");
    if (hireBtn) {
      if (!state.hasPaymentMethod) {
        setNotice("Add a payment method to hire before hiring.", "error");
        return;
      }
      const paralegalId = hireBtn.dataset.paralegalId || "";
      const paralegalName = hireBtn.dataset.paralegalName || "Paralegal";
      if (!paralegalId || !state.caseId) return;
      const amountCents = Number(state.caseAmountCents || 0);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        setNotice("Payment amount is unavailable for this case.", "error");
        return;
      }
      openHireConfirmModal({
        paralegalName,
        amountCents,
        feePct: PLATFORM_FEE_PCT,
        continueHref: `case-detail.html?caseId=${encodeURIComponent(state.caseId)}`,
        onConfirm: async () => {
          const originalText = hireBtn?.textContent || "Hire";
          if (hireBtn) {
            hireBtn.dataset.btnText = originalText;
            hireBtn.textContent = "Processing...";
            hireBtn.setAttribute("disabled", "disabled");
          }
          try {
            await hireParalegal(state.caseId, paralegalId);
            setNotice(`${paralegalName} has been hired. Case funded through Stripe.`, "success");
          } catch (err) {
            if (hireBtn) {
              hireBtn.removeAttribute("disabled");
              hireBtn.textContent = hireBtn.dataset.btnText || "Hire";
              delete hireBtn.dataset.btnText;
            }
            throw err;
          }
        },
      });
      return;
    }
    const docLink = event.target.closest("a[data-doc-key]");
    if (docLink) {
      event.preventDefault();
      const key = docLink.dataset.docKey || "";
      if (!key) return;
      openDocument(key);
    }
  });
}

async function openDocument(key) {
  try {
    const params = new URLSearchParams({ key });
    const res = await secureFetch(`/api/uploads/signed-get?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) {
      setNotice(MISSING_DOCUMENT_MESSAGE);
      return;
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.url) {
      throw new Error(payload?.msg || payload?.error || "Document unavailable.");
    }
    window.open(payload.url, "_blank", "noopener");
  } catch (err) {
    setNotice(err?.message || "Unable to open document.", "error");
  }
}

async function hireParalegal(caseId, paralegalId) {
  if (!caseId || !paralegalId) {
    throw new Error("Missing case or paralegal identifier.");
  }
  if (!state.hasPaymentMethod) {
    throw new Error("Add a payment method to hire.");
  }

  const postHire = async () => {
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

  const { res, payload } = await postHire();
  if (!res.ok) throw new Error(payload?.error || DEFAULT_HIRE_ERROR);
  return payload;
}

async function hasDefaultPaymentMethod() {
  try {
    const res = await secureFetch("/api/payments/payment-method/default", {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return false;
    return !!payload?.paymentMethod;
  } catch {
    return false;
  }
}

function resolveParalegalName(caseData = {}) {
  const candidate =
    caseData?.paralegal && typeof caseData.paralegal === "object"
      ? caseData.paralegal
      : caseData?.paralegalId && typeof caseData.paralegalId === "object"
      ? caseData.paralegalId
      : {};
  const name =
    candidate?.name ||
    [candidate?.firstName, candidate?.lastName].filter(Boolean).join(" ").trim() ||
    caseData?.paralegalNameSnapshot ||
    "Paralegal";
  return name;
}

function ensureHireModalStyles() {
  if (document.getElementById("hire-confirm-styles")) return;
  const style = document.createElement("style");
  style.id = "hire-confirm-styles";
  style.textContent = `
    .hire-confirm-overlay{position:fixed;inset:0;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center;z-index:1500}
    .hire-confirm-modal{background:#fff;border-radius:16px;padding:24px;max-width:520px;width:92%;box-shadow:0 24px 50px rgba(0,0,0,.2);display:grid;gap:12px}
    .hire-confirm-title{font-weight:600;font-size:1.2rem}
    .hire-confirm-summary{border:1px solid rgba(15,23,42,.08);border-radius:12px;padding:12px 14px;display:grid;gap:8px}
    .hire-confirm-row{display:flex;justify-content:space-between;gap:16px;font-size:0.95rem}
    .hire-confirm-row strong{font-weight:600}
    .hire-confirm-total{font-weight:600}
    .hire-confirm-help{display:flex;justify-content:flex-end;margin-top:-4px}
    .hire-confirm-info{width:24px;height:24px;border-radius:50%;border:1px solid rgba(15,23,42,.12);background:#fff;color:#6b7280;font-size:0.75rem;font-weight:250;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;position:relative;padding:0;transition:border-color .2s ease,color .2s ease,transform .15s ease}
    .hire-confirm-info:hover,
    .hire-confirm-info:focus-visible{border-color:#b6a47a;color:#111827;transform:translateY(-1px)}
    .hire-confirm-tooltip{position:absolute;right:0;bottom:calc(100% + 8px);width:min(320px,80vw);padding:10px 12px;border-radius:12px;background:#fff;border:1px solid rgba(15,23,42,.12);box-shadow:0 18px 40px rgba(0,0,0,.16);font-size:0.78rem;line-height:1.45;color:#111827;opacity:0;pointer-events:none;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;z-index:2}
    .hire-confirm-info:hover .hire-confirm-tooltip,
    .hire-confirm-info:focus-visible .hire-confirm-tooltip{opacity:1;pointer-events:auto;transform:translateY(0)}
    .hire-confirm-error{border:1px solid rgba(185,28,28,.4);background:rgba(254,242,242,.9);color:#991b1b;border-radius:10px;padding:8px 10px;font-size:0.9rem}
    .hire-confirm-success{border:1px solid rgba(22,163,74,.35);background:rgba(240,253,244,.9);color:#166534;border-radius:10px;padding:8px 10px;font-size:0.9rem}
    .hire-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
  `;
  document.head.appendChild(style);
}

function openHireConfirmModal({ paralegalName, amountCents, feePct, continueHref, onConfirm }) {
  ensureHireModalStyles();
  const safeName = escapeHTML(paralegalName || "Paralegal");
  const feeNote =
    "Platform fee includes Stripe security, dispute support, payment processing, and vetted paralegal access.";
  const feeRate = Number(feePct || 0);
  const feeCents = Math.max(0, Math.round(Number(amountCents || 0) * (feeRate / 100)));
  const totalCents = Math.max(0, Math.round(Number(amountCents || 0) + feeCents));
  const overlay = document.createElement("div");
  overlay.className = "hire-confirm-overlay";
  overlay.innerHTML = `
    <div class="hire-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="hireConfirmTitle">
      <div class="hire-confirm-title" id="hireConfirmTitle">Confirm Hire</div>
      <p>You’re about to hire ${safeName}. This will fund Stripe immediately.</p>
      <div class="hire-confirm-summary">
        <div class="hire-confirm-row">
          <span>Case amount</span>
          <strong>${escapeHTML(formatCurrency(Number(amountCents || 0) / 100))}</strong>
        </div>
        <div class="hire-confirm-row">
          <span>Platform fee (${feeRate}%)</span>
          <strong>${escapeHTML(formatCurrency(feeCents / 100))}</strong>
        </div>
        <div class="hire-confirm-row hire-confirm-total">
          <span>Total charge</span>
          <strong>${escapeHTML(formatCurrency(totalCents / 100))}</strong>
        </div>
      </div>
      <div class="hire-confirm-help">
        <button class="hire-confirm-info" type="button" aria-label="${escapeAttribute(feeNote)}">
          ?
          <span class="hire-confirm-tooltip" aria-hidden="true">${escapeHTML(feeNote)}</span>
        </button>
      </div>
      <div class="hire-confirm-error" data-hire-error hidden></div>
      <div class="hire-confirm-success" data-hire-success hidden>Case funded. Work can begin.</div>
      <div class="hire-confirm-actions" data-hire-actions>
        <button class="btn ghost" type="button" data-hire-cancel>Cancel</button>
        <button class="btn primary" type="button" data-hire-confirm>Confirm &amp; Hire</button>
      </div>
      <div class="hire-confirm-actions" data-hire-continue hidden>
        <a class="btn primary" href="${escapeAttribute(continueHref || "#")}">Continue to case</a>
      </div>
    </div>
  `;
  const errorEl = overlay.querySelector("[data-hire-error]");
  const successEl = overlay.querySelector("[data-hire-success]");
  const actionsEl = overlay.querySelector("[data-hire-actions]");
  const continueEl = overlay.querySelector("[data-hire-continue]");
  const confirmBtn = overlay.querySelector("[data-hire-confirm]");
  const cancelBtn = overlay.querySelector("[data-hire-cancel]");

  const close = () => overlay.remove();
  const setLoading = (isLoading) => {
    if (confirmBtn) {
      confirmBtn.disabled = isLoading;
      confirmBtn.textContent = isLoading ? "Charging..." : "Confirm & Hire";
    }
    if (cancelBtn) cancelBtn.disabled = isLoading;
  };
  const showError = (message) => {
    if (!errorEl) return;
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.textContent = message;
    errorEl.hidden = false;
  };
  const showSuccess = () => {
    if (successEl) successEl.hidden = false;
    if (actionsEl) actionsEl.hidden = true;
    if (continueEl) continueEl.hidden = false;
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !confirmBtn?.disabled) close();
  });
  cancelBtn?.addEventListener("click", () => {
    if (!confirmBtn?.disabled) close();
  });
  confirmBtn?.addEventListener("click", async () => {
    showError("");
    setLoading(true);
    try {
      await onConfirm?.();
      showSuccess();
    } catch (err) {
      showError(formatHireErrorMessage(err?.message));
      setLoading(false);
    }
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !confirmBtn?.disabled) close();
    },
    { once: true }
  );
  document.body.appendChild(overlay);
}

function formatCaseStatus(statusRaw, { hasParalegal = false, escrowFunded = false } = {}) {
  const key = String(statusRaw || "").trim().toLowerCase();
  if (!key) return "Posted";
  if (["assigned", "awaiting_funding"].includes(key)) return "Posted";
  if (["active", "awaiting_documents", "reviewing", "in_progress", "funded_in_progress"].includes(key)) {
    return "In Progress";
  }
  if (key === "in progress") return "In Progress";
  if (key === "completed") return "Completed";
  if (key === "disputed") return "Disputed";
  if (key === "closed") return "Closed";
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function setNotice(message, type) {
  if (!caseNotice) return;
  if (!message) {
    caseNotice.hidden = true;
    caseNotice.textContent = "";
    caseNotice.classList.remove("error");
    return;
  }
  caseNotice.hidden = false;
  caseNotice.textContent = message;
  caseNotice.classList.toggle("error", type === "error");
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

function formatCurrency(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}
