import { secureFetch } from "./auth.js";
import { loadUserHeaderInfo } from "./auth.js";

document.addEventListener("DOMContentLoaded", async () => {
  await window.checkSession("paralegal");
  await loadUserHeaderInfo();
  await loadAssignedCasesList();
});

async function loadAssignedCasesList() {
  const section = document.getElementById("assignedCasesList");
  section.innerHTML = "<h3>Assigned Cases</h3>";

  const res = await secureFetch("/api/cases/my-assigned");
  const { items = [] } = await res.json();

  if (!items.length) {
    section.innerHTML += "<p>No assigned cases.</p>";
    return;
  }

  items.forEach(c => {
    section.innerHTML += `
      <div class="assigned-case-card">
        <strong>${c.title}</strong><br>
        <span>Attorney: ${c.attorneyName || "Unknown"}</span><br>
        <a href="case-detail.html?caseId=${c._id}">Open Case</a>
      </div>
    `;
  });
}
