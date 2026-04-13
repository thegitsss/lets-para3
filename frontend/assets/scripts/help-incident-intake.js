(function () {
  const STYLE_ID = "lpc-incident-intake-styles";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .incident-intake-shell{
        border:1px solid var(--line, #e8edf3);
        border-radius:var(--radius, 14px);
        padding:24px;
        background:rgba(255,255,255,0.96);
        margin-bottom:32px;
      }
      .incident-intake-head{
        display:flex;
        flex-wrap:wrap;
        justify-content:space-between;
        gap:12px;
        align-items:flex-start;
        margin-bottom:16px;
      }
      .incident-intake-head h2{
        margin:0 0 8px;
        border-bottom:none;
        padding-bottom:0;
      }
      .incident-intake-subtitle{
        margin:0;
        color:var(--muted, #5c6b7a);
        font-size:0.95rem;
      }
      .incident-intake-pills{
        display:flex;
        flex-wrap:wrap;
        gap:8px;
      }
      .incident-pill{
        display:inline-flex;
        align-items:center;
        gap:6px;
        padding:6px 10px;
        border-radius:999px;
        border:1px solid rgba(39,57,77,0.12);
        background:#ffffff;
        color:var(--ink, #1a2230);
        font-size:0.78rem;
        letter-spacing:0.04em;
        text-transform:uppercase;
      }
      .incident-intake-form{
        display:grid;
        gap:14px;
      }
      .incident-field{
        display:grid;
        gap:8px;
      }
      .incident-field label{
        color:var(--ink, #1a2230);
        font-size:0.88rem;
        letter-spacing:0.02em;
      }
      .incident-field input,
      .incident-field textarea{
        width:100%;
        border:1px solid rgba(39,57,77,0.16);
        border-radius:12px;
        padding:12px 14px;
        font:inherit;
        color:var(--ink, #1a2230);
        background:#ffffff;
      }
      .incident-field textarea{
        min-height:120px;
        resize:vertical;
      }
      .incident-grid{
        display:grid;
        gap:12px;
        grid-template-columns:repeat(2, minmax(0, 1fr));
      }
      .incident-checkbox{
        display:flex;
        align-items:flex-start;
        gap:10px;
        font-size:0.9rem;
        color:var(--muted, #5c6b7a);
      }
      .incident-checkbox input{
        margin-top:2px;
      }
      .incident-intake-actions{
        display:flex;
        flex-wrap:wrap;
        gap:12px;
        align-items:center;
      }
      .incident-submit{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-width:170px;
        padding:0.7rem 1.1rem;
        border:none;
        border-radius:12px;
        background:#27394d;
        color:#ffffff;
        cursor:pointer;
        font:inherit;
        letter-spacing:0.05em;
        text-transform:uppercase;
      }
      .incident-submit[disabled]{
        opacity:0.65;
        cursor:not-allowed;
      }
      .incident-note{
        color:var(--muted, #5c6b7a);
        font-size:0.9rem;
      }
      .incident-status{
        margin-top:14px;
        padding:14px 16px;
        border-radius:12px;
        border:1px solid rgba(39,57,77,0.12);
        background:#ffffff;
        color:var(--ink, #1a2230);
      }
      .incident-status[data-tone="error"]{
        border-color:rgba(148, 59, 59, 0.24);
        background:#fff7f7;
      }
      .incident-status[data-tone="success"]{
        border-color:rgba(39, 90, 64, 0.22);
        background:#f7fbf8;
      }
      .incident-status-title{
        font-family:var(--font-serif, serif);
        font-size:1.08rem;
        margin:0 0 6px;
      }
      .incident-status-copy{
        margin:0;
        color:var(--muted, #5c6b7a);
      }
      .incident-status-meta{
        display:flex;
        flex-wrap:wrap;
        gap:10px;
        margin-top:10px;
        font-size:0.82rem;
        color:var(--ink, #1a2230);
      }
      @media (max-width: 720px){
        .incident-grid{
          grid-template-columns:1fr;
        }
        .incident-intake-shell{
          padding:18px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function compactText(value, maxLength) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, maxLength) : "";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function detectBrowserName() {
    const ua = String(navigator.userAgent || "");
    if (/edg\//i.test(ua)) return "Edge";
    if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) return "Chrome";
    if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) return "Safari";
    if (/firefox\//i.test(ua)) return "Firefox";
    if (/opr\//i.test(ua) || /opera/i.test(ua)) return "Opera";
    return "Unknown";
  }

  function detectDeviceType() {
    const ua = String(navigator.userAgent || "");
    if (/ipad|tablet/i.test(ua)) return "tablet";
    if (/iphone|android|mobile/i.test(ua)) return "mobile";
    return "desktop";
  }

  function collectDiagnostics() {
    return {
      pageUrl: window.location.href,
      routePath: window.location.pathname,
      referrer: document.referrer || "",
      userAgent: navigator.userAgent,
      browserName: detectBrowserName(),
      deviceType: detectDeviceType(),
      language: navigator.language || "",
      online: navigator.onLine,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      viewport: {
        width: window.innerWidth || null,
        height: window.innerHeight || null,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      screen: {
        width: window.screen?.width || null,
        height: window.screen?.height || null,
      },
      submittedAt: new Date().toISOString(),
    };
  }

  async function fetchCsrfToken() {
    try {
      const response = await fetch("/api/csrf", { credentials: "include" });
      if (!response.ok) return "";
      const data = await response.json().catch(() => ({}));
      return String(data?.csrfToken || "");
    } catch {
      return "";
    }
  }

  function parseContextDefaults() {
    const params = new URLSearchParams(window.location.search);
    return {
      featureKey: compactText(params.get("featureKey") || params.get("feature"), 120),
      caseId: compactText(params.get("caseId"), 64),
      jobId: compactText(params.get("jobId"), 64),
      applicationId: compactText(params.get("applicationId"), 64),
    };
  }

  function storeReporterAccess(incident, reporterAccessToken) {
    if (!incident?.publicId || !reporterAccessToken) return;
    try {
      sessionStorage.setItem(
        `incident-access:${incident.publicId}`,
        JSON.stringify({
          publicId: incident.publicId,
          reporterAccessToken,
          storedAt: new Date().toISOString(),
        })
      );
    } catch {
      // Best effort only.
    }
  }

  function buildUnavailableMarkup(title, copy) {
    return `
      <div class="incident-intake-shell">
        <div class="incident-intake-head">
          <div>
            <h2>${title}</h2>
            <p class="incident-intake-subtitle">${copy}</p>
          </div>
        </div>
      </div>
    `;
  }

  function buildReadyMarkup(surface, defaults, options = {}) {
    const surfaceLabel = surface === "paralegal" ? "Paralegal" : "Attorney";
    const {
      hideContextPills = false,
      hideReadyStatus = false,
      hidePrimaryLabels = false,
      hideOptionalContextFields = false,
      hideSubmitNote = false,
    } = options;
    return `
      <div class="incident-intake-shell">
        <div class="incident-intake-head">
          <div>
            <h2>Report an issue</h2>
          </div>
          ${
            hideContextPills
              ? ""
              : `<div class="incident-intake-pills">
            <span class="incident-pill">Surface: ${surfaceLabel}</span>
            <span class="incident-pill">Page: ${compactText(window.location.pathname, 40) || "/"}</span>
          </div>`
          }
        </div>
        <form class="incident-intake-form" novalidate>
          <div class="incident-field">
            ${hidePrimaryLabels ? "" : '<label for="incidentSummary">Short summary</label>'}
            <input id="incidentSummary" name="summary" type="text" maxlength="180" required placeholder="What is not working?" aria-label="Short summary" />
          </div>
          <div class="incident-field">
            ${hidePrimaryLabels ? "" : '<label for="incidentDescription">What happened?</label>'}
            <textarea id="incidentDescription" name="description" maxlength="5000" required placeholder="Describe what you expected, what happened instead, and anything that makes the issue reproducible." aria-label="What happened?"></textarea>
          </div>
          ${hideOptionalContextFields ? "" : `<div class="incident-grid">
            <div class="incident-field">
              <label for="incidentFeatureKey">Feature key</label>
              <input id="incidentFeatureKey" name="featureKey" type="text" maxlength="120" value="${escapeHtml(defaults.featureKey)}" placeholder="Optional" />
            </div>
            <div class="incident-field">
              <label for="incidentCaseId">Related case id</label>
              <input id="incidentCaseId" name="caseId" type="text" maxlength="64" value="${escapeHtml(defaults.caseId)}" placeholder="Optional" />
            </div>
            <div class="incident-field">
              <label for="incidentJobId">Related job id</label>
              <input id="incidentJobId" name="jobId" type="text" maxlength="64" value="${escapeHtml(defaults.jobId)}" placeholder="Optional" />
            </div>
            <div class="incident-field">
              <label for="incidentApplicationId">Related application id</label>
              <input id="incidentApplicationId" name="applicationId" type="text" maxlength="64" value="${escapeHtml(defaults.applicationId)}" placeholder="Optional" />
            </div>
          </div>`}
          <label class="incident-checkbox">
            <input id="incidentAttachDiagnostics" type="checkbox" checked />
            <span>Include technical details to help us troubleshoot.</span>
          </label>
          <div class="incident-intake-actions">
            <button class="incident-submit" type="submit">Submit issue</button>
            ${hideSubmitNote ? "" : '<span class="incident-note">This creates a structured incident record in the internal War Room.</span>'}
          </div>
        </form>
        <div class="incident-status" data-tone="neutral" aria-live="polite"${hideReadyStatus ? ' hidden' : ""}>
          <p class="incident-status-title">Ready</p>
          <p class="incident-status-copy">Your report will include this help page, your surface, and any optional context you add here.</p>
        </div>
      </div>
    `;
  }

  function setStatus(root, { tone = "neutral", title = "", copy = "", meta = [] } = {}) {
    const status = root.querySelector(".incident-status");
    if (!status) return;
    status.dataset.tone = tone;
    status.innerHTML = "";

    const titleNode = document.createElement("p");
    titleNode.className = "incident-status-title";
    titleNode.textContent = title;

    const copyNode = document.createElement("p");
    copyNode.className = "incident-status-copy";
    copyNode.textContent = copy;

    status.append(titleNode, copyNode);

    if (Array.isArray(meta) && meta.length) {
      const metaWrap = document.createElement("div");
      metaWrap.className = "incident-status-meta";
      meta.forEach((item) => {
        const span = document.createElement("span");
        span.textContent = item;
        metaWrap.appendChild(span);
      });
      status.appendChild(metaWrap);
    }
  }

  async function postIncident(payload) {
    const csrfToken = await fetchCsrfToken();
    const response = await fetch("/api/incidents", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const fieldMessages = data?.fields && typeof data.fields === "object" ? Object.values(data.fields) : [];
      const message =
        fieldMessages.find(Boolean) ||
        data?.error ||
        data?.message ||
        "Unable to submit the issue right now.";
      throw new Error(message);
    }
    return data;
  }

  async function renderIntake(container) {
    const surface = String(container.dataset.surface || "").toLowerCase();
    const options = {
      hideContextPills: container.dataset.hideContextPills === "true",
      hideReadyStatus: container.dataset.hideReadyStatus === "true",
      hidePrimaryLabels: container.dataset.hidePrimaryLabels === "true",
      hideOptionalContextFields: container.dataset.hideOptionalContextFields === "true",
      hideSubmitNote: container.dataset.hideSubmitNote === "true",
    };
    container.innerHTML = buildUnavailableMarkup(
      "Structured reporting",
      "Checking whether structured incident reporting is available for this session."
    );

    let session = null;
    try {
      session = await window.checkSession?.(surface, { redirectOnFail: false });
    } catch {
      session = null;
    }

    const role = String(session?.role || session?.user?.role || "").toLowerCase();
    if (!session || role !== surface) {
      container.innerHTML = buildUnavailableMarkup(
        "Structured reporting unavailable",
        "This form is available for signed-in users on the matching help surface."
      );
      return;
    }

    container.innerHTML = buildReadyMarkup(surface, parseContextDefaults(), options);
    const form = container.querySelector(".incident-intake-form");
    const submitButton = container.querySelector(".incident-submit");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const payload = {
        summary: compactText(formData.get("summary"), 180),
        description: String(formData.get("description") || "").trim(),
        pageUrl: window.location.href,
        routePath: window.location.pathname,
        featureKey: compactText(formData.get("featureKey"), 120),
        caseId: compactText(formData.get("caseId"), 64),
        jobId: compactText(formData.get("jobId"), 64),
        applicationId: compactText(formData.get("applicationId"), 64),
      };

      if (container.querySelector("#incidentAttachDiagnostics")?.checked) {
        payload.diagnostics = collectDiagnostics();
      }

      submitButton.disabled = true;
      submitButton.textContent = "Submitting…";
      setStatus(container, {
        title: "Submitting",
        copy: "Creating a structured incident record for this report.",
      });

      try {
        const result = await postIncident(payload);
        storeReporterAccess(result.incident, result.reporterAccessToken);
        form.reset();
        const defaults = parseContextDefaults();
        const featureKeyInput = container.querySelector("#incidentFeatureKey");
        const caseIdInput = container.querySelector("#incidentCaseId");
        const jobIdInput = container.querySelector("#incidentJobId");
        const applicationIdInput = container.querySelector("#incidentApplicationId");
        const attachDiagnosticsInput = container.querySelector("#incidentAttachDiagnostics");
        if (featureKeyInput) featureKeyInput.value = defaults.featureKey;
        if (caseIdInput) caseIdInput.value = defaults.caseId;
        if (jobIdInput) jobIdInput.value = defaults.jobId;
        if (applicationIdInput) applicationIdInput.value = defaults.applicationId;
        if (attachDiagnosticsInput) attachDiagnosticsInput.checked = true;
        setStatus(container, {
          tone: "success",
          title: "Report received",
          copy: "Your report is now in the internal incident queue.",
          meta: [
            `Reference: ${result?.incident?.publicId || "Pending"}`,
            `Status: ${result?.incident?.userVisibleStatus || "received"}`,
          ],
        });
      } catch (error) {
        setStatus(container, {
          tone: "error",
          title: "Unable to submit",
          copy: error?.message || "Unable to submit the issue right now.",
        });
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Submit issue";
      }
    });
  }

  function boot() {
    ensureStyles();
    document.querySelectorAll("[data-incident-intake-root]").forEach((container) => {
      renderIntake(container);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
