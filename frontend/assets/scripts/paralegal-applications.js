import { secureFetch } from "./auth.js";
import { loadUserHeaderInfo } from "./auth.js";

document.addEventListener("DOMContentLoaded", async () => {
  await window.checkSession("paralegal");
  await loadUserHeaderInfo();
  await loadApplicationsList();
});

async function loadApplicationsList() {
  const section = document.getElementById("applicationsList");
  section.innerHTML = "<h3>My Applications</h3>";

  const res = await secureFetch("/api/applications/my");
  const { items = [] } = await res.json();

  if (!items.length) {
    section.innerHTML += "<p>You have not applied to any jobs.</p>";
    return;
  }

  items.forEach(app => {
    section.innerHTML += `
      <div class="application-card">
        <strong>${app.caseTitle || "Case"}</strong><br>
        <span>Status: ${app.status}</span><br>
        <a href="case-detail.html?caseId=${app.caseId}">View Case</a>
      </div>
    `;
  });
}
