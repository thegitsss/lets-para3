import { secureFetch } from "./auth.js";

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

  const res = await secureFetch("/api/cases/open");
  if (!res.ok) {
    section.innerHTML = "<p>Unable to load jobs.</p>";
    return;
  }

  const { items = [] } = await res.json();

  if (!items.length) {
    section.innerHTML = "<p>No available jobs at this time.</p>";
    return;
  }

  section.innerHTML = "<h3>Available Jobs</h3>";

  items.forEach(job => {
    section.innerHTML += `
      <div class="job-card">
        <strong>${job.title}</strong><br>
        <span>${job.description || ""}</span><br>
        <button class="applyBtn" data-id="${job._id}">Apply</button>
      </div>
    `;
  });

  document.querySelectorAll(".applyBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const caseId = btn.dataset.id;
      await secureFetch(`/api/applications/${caseId}`, {
        method: "POST",
        body: {}
      });
      alert("Application submitted!");
    });
  });
}
