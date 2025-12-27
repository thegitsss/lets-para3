import { secureFetch } from "./auth.js";

let allFiles = [];
let currentConfig = null;

export async function initCaseFilesView(config = {}) {
  currentConfig = normalizeConfig(config);
  if (!currentConfig.containerId) {
    console.warn("Case files view missing containerId");
    return;
  }
  await loadCaseFiles();
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
    formatStatus:
      typeof config.formatStatus === "function"
        ? config.formatStatus
        : defaultFormatStatus,
  };
}

async function loadCaseFiles() {
  const container = document.getElementById(currentConfig.containerId);
  async function fetchActiveCasesFallback() {
    try {
      const res = await secureFetch("/api/paralegal/dashboard", {
        headers: { Accept: "application/json" },
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
    const cases = Array.isArray(data?.cases) ? data.cases : [];
    allFiles = cases.flatMap((caseItem = {}) => {
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
      allFiles = activeCases.map((c) => ({
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
    const primary = `<p class="case-files-empty">${sanitize(currentConfig.emptyCopy)}</p>`;
    container.innerHTML = currentConfig.emptySubtext
      ? `${primary}<p class="case-files-empty">${sanitize(currentConfig.emptySubtext)}</p>`
      : primary;
    return;
  }
  container.innerHTML = files
    .map((file) => {
      const caseId = file.caseId || file.id || "";
      const caseLink = caseId ? `case-detail.html?caseId=${encodeURIComponent(caseId)}` : "#";
      const downloadUrl = file.downloadUrl || file.key || file.url || "#";
      const sizeLabel =
        typeof file.size === "number" ? `${(file.size / 1024).toFixed(1)} KB` : "—";
      const statusLabel = sanitize(currentConfig.formatStatus(file.status));
      const caseMeta = `<div class="file-meta"><span>Case: ${sanitize(file.caseTitle || "Case")}</span></div>`;
      if (file.placeholder) {
        return `
          <article class="file-card" data-case-id="${sanitize(caseId)}">
            <div class="file-line">
              <span class="file-name">${sanitize(file.caseTitle || "Case")}</span>
              <span class="file-status">${statusLabel}</span>
            </div>
            ${caseMeta}
            <div class="file-actions">
              <a href="${caseLink}" class="btn-link">Open Case</a>
            </div>
          </article>
        `;
      }
      return `
        <article class="file-card" data-case-id="${sanitize(caseId)}">
          <div class="file-line">
            <span class="file-name">${sanitize(file.original || file.filename || "Untitled document")}</span>
            <span class="file-status">${statusLabel}</span>
          </div>
          <div class="file-meta">
            <span>Case: ${sanitize(file.caseTitle || "Case")}</span>
            <span>${sanitize(sizeLabel)}</span>
          </div>
          <div class="file-actions">
            <a href="${caseLink}" class="btn-link">Open Case</a>
            <a href="${downloadUrl}" class="btn-link" download>Download</a>
          </div>
        </article>
      `;
    })
    .join("");
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
  if (value.toLowerCase() === "in_progress") return "in progress";
  return value;
}

function sanitize(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}
