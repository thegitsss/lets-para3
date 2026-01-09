import { secureFetch } from "./auth.js";
import { loadUserHeaderInfo } from "./auth.js";

const applicationsCache = [];
const applicationModal = document.getElementById("applicationDetailModal");
const applicationDetail = applicationModal?.querySelector("[data-application-detail]");

document.addEventListener("DOMContentLoaded", async () => {
  await window.checkSession("paralegal");
  await loadUserHeaderInfo();
  await loadApplications();
  bindApplicationModal();
});

async function loadApplications() {
  const section = document.getElementById("applicationsList");
  if (!section) return;
  section.innerHTML = "";

  let apps = [];
  try {
    const res = await secureFetch("/api/applications/my");
    const payload = await res.json().catch(() => []);
    apps = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
  } catch (err) {
    section.innerHTML = "<p>Unable to load applications right now.</p>";
    return;
  }

  applicationsCache.splice(0, applicationsCache.length, ...apps);

  const params = new URLSearchParams(window.location.search);
  const applicationId = (params.get("applicationId") || params.get("appId") || "").trim();
  const jobId = (params.get("jobId") || "").trim();

  renderApplicationsList(section, apps);

  if (applicationId || jobId) {
    const match = findApplication(applicationId, jobId);
    if (match) {
      openApplicationModal(match);
    } else {
      openApplicationModal(null);
    }
  }
}

function renderApplicationsList(section, apps) {
  if (!apps.length) {
    section.innerHTML = "<p>You have not applied to any jobs.</p>";
    return;
  }

  section.innerHTML = apps
    .map((app) => {
      const job = app.jobId || app.job || {};
      const title = escapeHtml(job.title || app.caseTitle || "Job");
      const status = formatStatus(app.status);
      const appliedAt = app.createdAt ? formatDate(app.createdAt) : "Recently";
      const appId = app._id || app.id || "";
      const jobId = job._id || job.id || app.jobId || "";
      const href = appId
        ? `paralegal-applications.html?applicationId=${encodeURIComponent(appId)}`
        : jobId
          ? `paralegal-applications.html?jobId=${encodeURIComponent(jobId)}`
          : "paralegal-applications.html";
      return `
        <div class="application-card">
          <strong>${title}</strong><br>
          <span>Status: ${status}</span><br>
          <span>Applied: ${escapeHtml(appliedAt)}</span><br>
          <a href="${href}" data-application-view data-application-id="${escapeHtml(appId)}" data-job-id="${escapeHtml(jobId)}">View</a>
        </div>
      `;
    })
    .join("");

  section.querySelectorAll("[data-application-view]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const appId = link.dataset.applicationId || "";
      const jobId = link.dataset.jobId || "";
      const match = findApplication(appId, jobId);
      setApplicationQuery(appId, jobId);
      openApplicationModal(match);
    });
  });
}

function buildApplicationDetail(app) {
  if (!app) {
    return `<p class="muted">Application not found.</p>`;
  }
  const job = app.jobId || app.job || {};
  const title = escapeHtml(job.title || app.caseTitle || "Job");
  const practice = escapeHtml(job.practiceArea || "General practice");
  const description = escapeHtml(job.description || "");
  const budget = formatCurrency(job.budget);
  const status = formatStatus(app.status);
  const appliedAt = app.createdAt ? formatDate(app.createdAt) : "Recently";
  const cover = formatMultiline(app.coverLetter || "");

  return `
    <div class="detail-row">
      <span class="detail-label">Job</span>
      <span class="detail-value">${title}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Practice area</span>
      <span class="detail-value">${practice}</span>
    </div>
    ${description ? `
      <div class="detail-row">
        <span class="detail-label">Summary</span>
        <span class="detail-value">${description}</span>
      </div>
    ` : ""}
    ${budget ? `
      <div class="detail-row">
        <span class="detail-label">Budget</span>
        <span class="detail-value">${budget}</span>
      </div>
    ` : ""}
    <div class="detail-row">
      <span class="detail-label">Status</span>
      <span class="detail-value">${status}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Applied on</span>
      <span class="detail-value">${escapeHtml(appliedAt)}</span>
    </div>
    <div class="application-cover">
      <strong>Cover message</strong>
      <p>${cover || "No cover message available."}</p>
    </div>
  `;
}

function bindApplicationModal() {
  if (!applicationModal) return;
  applicationModal.querySelectorAll("[data-application-close]").forEach((btn) => {
    btn.addEventListener("click", closeApplicationModal);
  });
  applicationModal.addEventListener("click", (event) => {
    if (event.target === applicationModal) {
      closeApplicationModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && applicationModal && !applicationModal.classList.contains("hidden")) {
      closeApplicationModal();
    }
  });
}

function openApplicationModal(app) {
  if (!applicationModal || !applicationDetail) return;
  applicationDetail.innerHTML = buildApplicationDetail(app);
  applicationModal.classList.remove("hidden");
}

function closeApplicationModal() {
  if (!applicationModal) return;
  applicationModal.classList.add("hidden");
  clearApplicationQuery();
}

function setApplicationQuery(appId, jobId) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("applicationId");
    url.searchParams.delete("appId");
    url.searchParams.delete("jobId");
    if (appId) {
      url.searchParams.set("applicationId", appId);
    } else if (jobId) {
      url.searchParams.set("jobId", jobId);
    }
    window.history.pushState({}, "", url.toString());
  } catch {}
}

function clearApplicationQuery() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("applicationId");
    url.searchParams.delete("appId");
    url.searchParams.delete("jobId");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

function findApplication(applicationId, jobId) {
  const appId = String(applicationId || "");
  const jobKey = String(jobId || "");
  return applicationsCache.find((app) => {
    const id = String(app._id || app.id || "");
    if (appId && id === appId) return true;
    if (!jobKey) return false;
    const appJobId = String(app.jobId?._id || app.jobId || "");
    return appJobId === jobKey;
  });
}

function formatStatus(value) {
  const raw = String(value || "submitted").replace(/_/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function formatCurrency(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatMultiline(value) {
  if (!value) return "";
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
