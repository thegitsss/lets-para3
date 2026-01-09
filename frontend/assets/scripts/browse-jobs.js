import { secureFetch } from "./auth.js";
import { getStripeConnectStatus, isStripeConnected, STRIPE_GATE_MESSAGE } from "./utils/stripe-connect.js";

const jobModal = document.getElementById("jobModal");
const jobModalClose = document.getElementById("jobModalClose");
const jobModalBackdrop = jobModal?.querySelector(".job-modal-backdrop");
const jobTitleEl = document.getElementById("jobTitle");
const jobSummaryEl = document.getElementById("jobSummary");
const jobBodyEl = document.getElementById("jobBody");
const jobCompensationEl = document.getElementById("jobCompensation");
const jobApplyBtn = document.getElementById("jobApplyBtn");
const attorneyBtn = document.getElementById("jobAttorneyButton");
const attorneyAvatar = document.getElementById("jobAttorneyAvatar");
const attorneyNameEl = document.getElementById("jobAttorneyName");
const attorneyFirmEl = document.getElementById("jobAttorneyFirm");
const FALLBACK_AVATAR = "https://via.placeholder.com/64x64.png?text=A";
const attorneyPreviewCache = new Map();
const urlParams = new URLSearchParams(window.location.search);
const previewCaseId = urlParams.get("caseId");
const previewMode = Boolean(previewCaseId);

let jobsCache = [];
let modalJob = null;
let stripeConnected = false;
let viewerRole = "";

document.addEventListener("DOMContentLoaded", async () => {
  let session = null;
  if (previewMode) {
    try {
      session = await window.checkSession(undefined, { redirectOnFail: false });
    } catch (_) {
      session = null;
    }
  } else {
    session = await window.checkSession("paralegal");
  }
  viewerRole = String(session?.role || session?.user?.role || "").toLowerCase();
  if (viewerRole === "paralegal") {
    await loadStripeStatus();
  }
  if (previewMode) {
    await loadSingleCase(previewCaseId);
    return;
  }
  await loadJobs();
  const REFRESH_MS = 30000;
  setInterval(() => {
    if (document.hidden) return;
    loadJobs();
  }, REFRESH_MS);
});

async function loadJobs() {
  const section = document.getElementById("jobList");
  section.innerHTML = "<h3>Available Jobs</h3><p>Loading...</p>";

  const res = await secureFetch("/api/jobs/open");
  if (!res.ok) {
    section.innerHTML = "<p>Unable to load jobs.</p>";
    return;
  }

  const payload = await res.json().catch(() => ([]));
  const jobs = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
  jobsCache = jobs;

  renderJobs(jobs);
  bindJobListEvents();
}

async function loadSingleCase(caseId) {
  const section = document.getElementById("jobList");
  section.innerHTML = "<h3>Available Jobs</h3><p>Loading...</p>";
  if (!caseId) {
    section.innerHTML = "<p>Unable to load case preview.</p>";
    return;
  }
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      section.innerHTML = `<p>${escapeHtml(data?.error || "Unable to load case preview.")}</p>`;
      return;
    }
    const job = shapeJobFromCase(data);
    jobsCache = [job];
    renderJobs(jobsCache);
    bindJobListEvents();
  } catch (err) {
    section.innerHTML = "<p>Unable to load case preview.</p>";
  }
}

function renderJobs(jobs) {
  const section = document.getElementById("jobList");
  if (!section) return;
  if (!jobs.length) {
    section.innerHTML = "<h3>Available Jobs</h3><p>No available jobs at this time.</p>";
    return;
  }

  const canApply = viewerRole === "paralegal";
  const applyDisabled = canApply && stripeConnected ? "" : "disabled";
  const applyTitle = !canApply
    ? `title="Only paralegals can apply."`
    : stripeConnected
    ? ""
    : `title="${escapeHtml(STRIPE_GATE_MESSAGE)}"`;

  const parts = ["<h3>Available Jobs</h3>"];
  jobs.forEach((job, idx) => {
    const applyId = job.jobId || job._id || job.id || "";
    parts.push(`
      <div class="job-card" data-job-index="${idx}">
        <strong>${escapeHtml(job.title || "Untitled job")}</strong><br>
        <span>${escapeHtml(job.practiceArea || job.shortDescription || "")}</span><br>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="viewJobBtn" data-job-index="${idx}">View</button>
          <button class="applyBtn" data-id="${escapeHtml(applyId)}" ${applyDisabled} ${applyTitle}>Apply</button>
        </div>
      </div>
    `);
  });
  section.innerHTML = parts.join("\n");
}

function bindJobListEvents() {
  const section = document.getElementById("jobList");
  if (!section) return;
  section.querySelectorAll(".job-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      const idx = Number(card.dataset.jobIndex);
      if (!Number.isNaN(idx) && jobsCache[idx]) {
        openJobModal(jobsCache[idx]);
      }
    });
  });

  section.querySelectorAll(".viewJobBtn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const idx = Number(btn.dataset.jobIndex);
      if (!Number.isNaN(idx) && jobsCache[idx]) {
        openJobModal(jobsCache[idx]);
      }
    });
  });

  section.querySelectorAll(".applyBtn").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (viewerRole !== "paralegal") {
        alert("Only paralegals can apply for jobs.");
        return;
      }
      if (!stripeConnected) {
        alert(STRIPE_GATE_MESSAGE);
        return;
      }
      const jobId = btn.dataset.id;
      if (!jobId) return;
      const coverLetter = promptCoverLetter();
      if (!coverLetter) return;
      await submitQuickApplication(jobId, coverLetter);
    });
  });
}

function promptCoverLetter() {
  const note = window.prompt(
    "Add a brief cover letter (20+ characters). This is required to apply."
  );
  if (!note) return "";
  const trimmed = note.trim();
  if (trimmed.length < 20) {
    alert("Please include at least 20 characters in your cover letter.");
    return "";
  }
  return trimmed;
}

async function submitQuickApplication(jobId, coverLetter) {
  try {
    const res = await secureFetch(`/api/jobs/${jobId}/apply`, {
      method: "POST",
      body: { coverLetter },
      noRedirect: true,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.error || "Unable to submit application.";
      if (res.status === 403 && /stripe/i.test(message)) {
        alert(STRIPE_GATE_MESSAGE);
        return;
      }
      throw new Error(message);
    }
    alert("Application submitted!");
  } catch (err) {
    alert("Unable to submit application.");
  }
}

async function loadStripeStatus() {
  const data = await getStripeConnectStatus();
  stripeConnected = isStripeConnected(data);
  return data;
}

async function ensureAttorneyPreview(job) {
  if (!job) return null;
  const existing = job.attorney || {};
  if (existing && (existing.firstName || existing.lastName || existing.lawFirm || existing.profileImage)) {
    if (!existing._id && job.attorneyId) {
      existing._id = job.attorneyId;
    }
    return existing;
  }

  const id = job.attorneyId || existing._id;
  if (!id) return null;
  if (!attorneyPreviewCache.has(id)) {
    try {
      const res = await secureFetch(`/api/users/attorneys/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
        noRedirect: true,
      });
      if (!res.ok) throw new Error(`Attorney preview failed (${res.status})`);
      const data = await res.json().catch(() => ({}));
      attorneyPreviewCache.set(id, data);
    } catch (err) {
      console.warn("Unable to fetch attorney preview", err);
      attorneyPreviewCache.set(id, null);
    }
  }
  const preview = attorneyPreviewCache.get(id);
  if (preview) {
    job.attorney = {
      _id: preview._id || id,
      firstName: preview.firstName || preview.givenName || "",
      lastName: preview.lastName || preview.familyName || "",
      lawFirm: preview.lawFirm || preview.firmName || "",
      profileImage: preview.profileImage || preview.avatarURL || "",
    };
    return job.attorney;
  }
  return null;
}

function shapeJobFromCase(caseData = {}) {
  const totalAmount = typeof caseData.totalAmount === "number" ? caseData.totalAmount : null;
  const lockedTotalAmount = typeof caseData.lockedTotalAmount === "number" ? caseData.lockedTotalAmount : null;
  const amountForCase = lockedTotalAmount != null ? lockedTotalAmount : totalAmount;
  const budgetFromCase = amountForCase != null ? Math.round(amountForCase / 100) : null;
  const attorney = caseData.attorney || null;
  const attorneyId =
    (attorney && (attorney._id || attorney.id)) ||
    caseData.attorneyId ||
    caseData.attorney ||
    null;

  return {
    _id: caseData.jobId || caseData.job || caseData._id || caseData.id,
    id: caseData._id || caseData.id,
    caseId: caseData._id || caseData.id || null,
    jobId: caseData.jobId || caseData.job || null,
    title: caseData.title || "Untitled Case",
    practiceArea: caseData.practiceArea || "",
    shortDescription: caseData.briefSummary || "",
    description: caseData.details || caseData.description || "",
    totalAmount,
    lockedTotalAmount,
    budget: typeof budgetFromCase === "number" ? budgetFromCase : null,
    currency: caseData.currency || "usd",
    createdAt: caseData.createdAt || null,
    attorneyId,
    attorney,
  };
}

async function openJobModal(job) {
  if (!jobModal) return;
  modalJob = job;
  try {
    await ensureAttorneyPreview(job);
  } catch (err) {
    console.warn("Attorney preview load failed", err);
  }

  const title = job.title || "Untitled job";
  const summary = job.shortDescription || job.practiceArea || "";
  const description = job.description || job.details || "No additional description provided.";
  const pay = typeof job.budget === "number" ? `$${Number(job.budget).toLocaleString()}` : job.compensationDisplay || "Rate negotiable";

  if (jobTitleEl) jobTitleEl.textContent = title;
  if (jobSummaryEl) jobSummaryEl.textContent = summary;
  if (jobBodyEl) jobBodyEl.textContent = description;
  if (jobCompensationEl) jobCompensationEl.textContent = pay;

  const atty = job.attorney || {};
  const attorneyName = [atty.firstName, atty.lastName].filter(Boolean).join(" ") || "Attorney";
  if (attorneyNameEl) attorneyNameEl.textContent = attorneyName;
  if (attorneyFirmEl) attorneyFirmEl.textContent = atty.lawFirm || "";
  if (attorneyAvatar) {
    attorneyAvatar.src = atty.profileImage || FALLBACK_AVATAR;
    attorneyAvatar.alt = `Profile photo of ${attorneyName}`;
  }
  if (attorneyBtn) {
    attorneyBtn.dataset.attorneyId = atty._id || job.attorneyId || "";
    attorneyBtn.dataset.jobId = job._id || job.id || "";
  }
  if (jobApplyBtn) {
    jobApplyBtn.disabled = !stripeConnected;
    jobApplyBtn.textContent = "Apply";
    if (!stripeConnected) {
      jobApplyBtn.title = STRIPE_GATE_MESSAGE;
    } else {
      jobApplyBtn.removeAttribute("title");
    }
  }

  jobModal.classList.remove("hidden");
  jobModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeJobModal() {
  if (!jobModal) return;
  jobModal.classList.add("hidden");
  jobModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  modalJob = null;
}

jobModalClose?.addEventListener("click", closeJobModal);
jobModalBackdrop?.addEventListener("click", closeJobModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !jobModal?.classList.contains("hidden")) {
    closeJobModal();
  }
});

attorneyBtn?.addEventListener("click", async () => {
  if (!attorneyBtn) return;
  let attorneyId = attorneyBtn.dataset.attorneyId || "";
  let jobId = attorneyBtn.dataset.jobId || "";
  if (!attorneyId && modalJob) {
    try {
      await ensureAttorneyPreview(modalJob);
    } catch {}
    attorneyId = modalJob?.attorney?._id || modalJob?.attorneyId || "";
    jobId = jobId || modalJob?._id || modalJob?.id || "";
  }
  if (!attorneyId) {
    alert("Unable to open this attorney profile right now.");
    return;
  }
  const url = new URL("profile-attorney.html", window.location.href);
  url.searchParams.set("id", attorneyId);
  if (jobId) url.searchParams.set("job", jobId);
  window.location.href = url.toString();
});

jobApplyBtn?.addEventListener("click", async () => {
  if (!stripeConnected) {
    alert(STRIPE_GATE_MESSAGE);
    return;
  }
  if (!modalJob) return;
  const jobId = modalJob._id || modalJob.id;
  if (!jobId) return;
  const coverLetter = promptCoverLetter();
  if (!coverLetter) return;
  await submitQuickApplication(jobId, coverLetter);
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
