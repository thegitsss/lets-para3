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
      await submitQuickApplication(jobId);
    });
  });
}

async function submitQuickApplication(jobId) {
  try {
    await secureFetch(`/api/jobs/${jobId}/apply`, {
      method: "POST",
      body: { coverLetter: "" }
    });
    alert("Application submitted!");
  } catch (err) {
    alert("Unable to submit application.");
  }
}

function openJobModal(job) {
  if (!jobModal) return;
  modalJob = job;
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
    if (atty.profileImage) {
      attorneyAvatar.src = atty.profileImage;
    } else {
      attorneyAvatar.src = FALLBACK_AVATAR;
    }
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

attorneyBtn?.addEventListener("click", () => {
  const attorneyId = attorneyBtn.dataset.attorneyId;
  const jobId = attorneyBtn.dataset.jobId;
  if (!attorneyId) return;
  const url = new URL("profile-attorney.html", window.location.href);
  url.searchParams.set("id", attorneyId);
  if (jobId) url.searchParams.set("job", jobId);
  window.location.href = url.toString();
});

jobApplyBtn?.addEventListener("click", async () => {
  if (!modalJob) return;
  const jobId = modalJob._id || modalJob.id;
  if (!jobId) return;
  await submitQuickApplication(jobId);
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
