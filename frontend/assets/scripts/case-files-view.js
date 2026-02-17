import { secureFetch } from "./auth.js";

let allFiles = [];
let currentConfig = null;
let gatedEmpty = false;
let actionsBound = false;

const FUNDED_WORKSPACE_STATUSES = new Set([
  "in progress",
  "in_progress",
]);

export async function initCaseFilesView(config = {}) {
  currentConfig = normalizeConfig(config);
  if (!currentConfig.containerId) {
    console.warn("Case files view missing containerId");
    return;
  }
  await loadCaseFiles();
  bindFileActions();
  bindFilters();
  renderFiles(allFiles);
}

function normalizeConfig(config) {
  const filters = Array.isArray(config.filters)
    ? config.filters.filter((item) => item && item.id)
    : [];
  return {
    containerId: config.containerId,
    filters,
    emptyCopy: config.emptyCopy || "No files found.",
    emptySubtext: config.emptySubtext || "",
    unauthorizedCopy: config.unauthorizedCopy || "Unable to load files.",
    gatedCopy: config.gatedCopy || "No funded cases yet.",
    formatStatus:
      typeof config.formatStatus === "function"
        ? config.formatStatus
        : defaultFormatStatus,
  };
}

function normalizeCaseListPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.cases)) return payload.cases;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeCaseStatus(status) {
  const value = String(status || "").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (lower === "in_progress") return "in progress";
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing", "funded_in_progress"].includes(lower)) return "in progress";
  return lower;
}

function isFundedWorkspaceCase(caseItem) {
  if (!caseItem) return false;
  if (caseItem.archived !== false) return false;
  if (caseItem.paymentReleased !== false) return false;

  const status = normalizeCaseStatus(caseItem?.status);
  if (!status || !FUNDED_WORKSPACE_STATUSES.has(status)) return false;

  const escrowStatus = String(caseItem?.escrowStatus || "").toLowerCase();
  const escrowIntentId = caseItem?.escrowIntentId;
  const escrowFunded = !!escrowIntentId && escrowStatus === "funded";
  if (!escrowFunded) return false;

  const hasParalegal = caseItem?.paralegal || caseItem?.paralegalId;
  return !!hasParalegal;
}

async function loadCaseFiles() {
  const container = document.getElementById(currentConfig.containerId);
  function readViewerRole() {
    if (typeof window.getStoredUser === "function") {
      const user = window.getStoredUser();
      if (user?.role) return String(user.role).toLowerCase();
    }
    try {
      const raw = localStorage.getItem("lpc_user");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.role) return String(parsed.role).toLowerCase();
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  async function fetchActiveCasesFallback() {
    try {
      const role = readViewerRole();
      if (role && role !== "paralegal" && role !== "attorney" && role !== "admin") return [];
      const endpoint =
        role === "paralegal" ? "/api/paralegal/dashboard" : "/api/attorney/dashboard";
      const res = await secureFetch(endpoint, {
        headers: { Accept: "application/json" },
        noRedirect: true,
      });
      if (!res.ok) return [];
      const payload = await res.json().catch(() => ({}));
      return Array.isArray(payload?.activeCases) ? payload.activeCases : [];
    } catch {
      return [];
    }
  }

  try {
    const res = await secureFetch("/api/cases/my?withFiles=true&limit=100", {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    const status = res.status;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`HTTP ${status}`);
      err.status = status;
      throw err;
    }
    const cases = normalizeCaseListPayload(data);
    const eligibleCases = cases.filter((caseItem) => isFundedWorkspaceCase(caseItem));
    gatedEmpty = cases.length > 0 && eligibleCases.length === 0;
    allFiles = eligibleCases.flatMap((caseItem = {}) => {
      const caseId = caseItem.id || caseItem._id;
      const caseTitle = caseItem.title || caseItem.name || "Untitled Case";
      const caseStatus = normalizeStatus(caseItem.status) || "pending";
      const files = Array.isArray(caseItem.files) ? caseItem.files : [];
      if (!files.length) {
        return [
          {
            placeholder: true,
            caseId,
            caseTitle,
            status: caseStatus,
          },
        ];
      }
      return files.map((file) => ({
        ...file,
        caseId,
        caseTitle,
        status: normalizeStatus(file.status) || caseStatus,
      }));
    });

    // Fallback: if no cases/files returned, pull active cases from dashboard data
    if (!allFiles.length) {
      const activeCases = await fetchActiveCasesFallback();
      const eligibleFallback = activeCases.filter((caseItem) => isFundedWorkspaceCase(caseItem));
      gatedEmpty = activeCases.length > 0 && eligibleFallback.length === 0;
      allFiles = eligibleFallback.map((c) => ({
        placeholder: true,
        caseId: c.caseId || c.id || c._id || "",
        caseTitle: c.jobTitle || c.title || c.practiceArea || "Case",
        status: normalizeStatus(c.status) || "in progress",
      }));
    }
  } catch (err) {
    console.warn("Unable to load case files", err);
    allFiles = [];
    if (container) {
      const message =
        err?.status === 401 || err?.status === 403
          ? currentConfig.unauthorizedCopy
          : "Unable to load files.";
      container.innerHTML = `<p class="case-files-empty">${sanitize(message)}</p>`;
    }
  }
}

function bindFilters() {
  if (!currentConfig.filters.length) return;
  currentConfig.filters.forEach(({ id, fn }, index) => {
    const btn = document.getElementById(id);
    if (!btn || btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", () => {
      setActiveFilter(id);
      const mapper = typeof fn === "function" ? fn : ((files) => files);
      renderFiles(mapper(allFiles));
    });
    if (index === 0) {
      setActiveFilter(id);
    }
  });
}

function setActiveFilter(activeId) {
  currentConfig.filters.forEach(({ id }) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle("active", id === activeId);
  });
}

function renderFiles(files) {
  const container = document.getElementById(currentConfig.containerId);
  if (!container) return;
  if (!files.length) {
    const message = gatedEmpty ? currentConfig.gatedCopy : currentConfig.emptyCopy;
    const primary = `<p class="case-files-empty">${sanitize(message)}</p>`;
    container.innerHTML = currentConfig.emptySubtext
      ? `${primary}<p class="case-files-empty">${sanitize(currentConfig.emptySubtext)}</p>`
      : primary;
    return;
  }
  container.innerHTML = files
    .map((file) => {
      const caseId = file.caseId || file.id || "";
      const caseLink = caseId ? `case-detail.html?caseId=${encodeURIComponent(caseId)}` : "#";
      const fileId = file.id || file._id || "";
      const fileKey = file.storageKey || file.key || "";
      const fileName = file.original || file.filename || "Untitled document";
      const mimeType = file.mimeType || file.mime || "";
      const downloadUrl =
        caseId && fileId
          ? `/api/uploads/case/${encodeURIComponent(caseId)}/${encodeURIComponent(fileId)}/download`
          : "";
      const viewUrl =
        caseId && fileKey
          ? `/api/uploads/view?caseId=${encodeURIComponent(caseId)}&key=${encodeURIComponent(fileKey)}`
          : "";
      if (file.placeholder) {
        return `
          <article class="file-card" data-case-id="${sanitize(caseId)}">
            <div class="file-line">
              <span class="file-name">${sanitize(file.caseTitle || "Case")}</span>
            </div>
            <div class="file-actions">
              <a href="${caseLink}" class="btn-link">View</a>
            </div>
          </article>
        `;
      }
      return `
        <article class="file-card" data-case-id="${sanitize(caseId)}">
          <div class="file-line">
            <span class="file-name">${sanitize(fileName)}</span>
          </div>
          <div class="file-actions">
            <a href="${viewUrl || "#"}" class="btn-link" data-file-action="view" data-case-id="${sanitize(caseId)}" data-file-key="${sanitize(fileKey)}" data-file-name="${sanitize(fileName)}" data-file-mime="${sanitize(mimeType)}" target="_blank" rel="noopener">View</a>
            <a href="${downloadUrl || "#"}" class="btn-link" data-file-action="download" data-case-id="${sanitize(caseId)}" data-file-id="${sanitize(fileId)}" data-file-name="${sanitize(fileName)}" download>Download</a>
          </div>
        </article>
      `;
    })
    .join("");
}

function bindFileActions() {
  if (actionsBound) return;
  const container = document.getElementById(currentConfig.containerId);
  if (!container) return;
  actionsBound = true;
  container.addEventListener("click", (event) => {
    const target = event.target.closest("[data-file-action]");
    if (!target) return;
    const action = target.dataset.fileAction;
    const fileName = target.dataset.fileName || "File";
    const mimeType = target.dataset.fileMime || "";
    const caseId = target.dataset.caseId || "";
    const fileKey = target.dataset.fileKey || "";

    if (action === "view") {
      event.preventDefault();
      if (!isPreviewSupported({ fileName, mimeType })) {
        notifyFileAction("Preview not supported for this file type. Please download to view.");
        return;
      }
      if (!caseId || !fileKey) {
        notifyFileAction("Preview unavailable for this file.");
        return;
      }
      const viewUrl = buildViewUrl({ caseId, fileKey });
      if (!viewUrl) {
        notifyFileAction("Preview unavailable for this file.");
        return;
      }
      window.open(viewUrl, "_blank", "noopener");
      return;
    }

    if (action === "download") {
      if (!target.getAttribute("href") || target.getAttribute("href") === "#") {
        event.preventDefault();
        notifyFileAction("Download unavailable for this file.");
      }
    }
  });
}

function defaultFormatStatus(status) {
  const normalized = normalizeStatus(status).toLowerCase();
  if (normalized === "pending_review") return "Pending Review";
  if (normalized === "approved") return "Approved";
  if (normalized === "attorney_revision") return "Requested Revisions";
  if (normalized === "in progress" || normalized === "in_progress") return "In Progress";
  return status || "Unknown";
}

function normalizeStatus(status) {
  const value = String(status || "").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (lower === "in_progress") return "in progress";
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing", "funded_in_progress"].includes(lower)) return "in progress";
  return lower;
}

function getFileExtension(name) {
  const base = String(name || "").trim();
  if (!base) return "";
  const parts = base.split(".");
  if (parts.length < 2) return "";
  return parts.pop().toLowerCase();
}

function isPreviewSupported({ fileName, mimeType } = {}) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  if (mime === "application/pdf") return true;
  const ext = getFileExtension(fileName);
  return ["pdf", "png", "jpg", "jpeg", "gif", "webp"].includes(ext);
}

function buildViewUrl({ caseId, fileKey } = {}) {
  if (!caseId || !fileKey) return "";
  return `/api/uploads/view?caseId=${encodeURIComponent(caseId)}&key=${encodeURIComponent(fileKey)}`;
}

function notifyFileAction(message) {
  const toastTarget = document.getElementById("toastBanner");
  if (window.toastUtils?.show && toastTarget) {
    window.toastUtils.show(message, { targetId: toastTarget, type: "info" });
    return;
  }
  alert(message);
}

function sanitize(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
