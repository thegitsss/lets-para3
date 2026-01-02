import { secureFetch } from "./auth.js";

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

let jobsCache = [];
let modalJob = null;

document.addEventListener("DOMContentLoaded", async () => {
  await window.checkSession("paralegal");
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

  if (!jobs.length) {
    section.innerHTML = "<h3>Available Jobs</h3><p>No available jobs at this time.</p>";
    return;
  }

  const parts = ["<h3>Available Jobs</h3>"];
  jobs.forEach((job, idx) => {
    parts.push(`
      <div class="job-card" data-job-index="${idx}">
        <strong>${escapeHtml(job.title || "Untitled job")}</strong><br>
        <span>${escapeHtml(job.practiceArea || job.shortDescription || "")}</span><br>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="viewJobBtn" data-job-index="${idx}">View</button>
          <button class="applyBtn" data-id="${job._id || job.id || ""}">Apply</button>
        </div>
      </div>
    `);
  });
  section.innerHTML = parts.join("\n");

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
        promptStripeOnboarding(message);
        return;
      }
      throw new Error(message);
    }
    alert("Application submitted!");
  } catch (err) {
    alert("Unable to submit application.");
  }
}

function promptStripeOnboarding(message) {
  const copy = message || "Complete Stripe onboarding before applying.";
  const go = window.confirm(`${copy} Open Profile Settings to connect Stripe now?`);
  if (go) window.location.href = "profile-settings.html";
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
