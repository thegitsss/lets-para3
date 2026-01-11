import { secureFetch } from "./auth.js";
import { loadUserHeaderInfo } from "./auth.js";

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

document.addEventListener("DOMContentLoaded", async () => {
  await window.checkSession("paralegal");
  await loadUserHeaderInfo();
  await loadAssignedCasesList();
});

async function loadAssignedCasesList() {
  const section = document.getElementById("assignedCasesList");
  if (!section) return;
  section.innerHTML = "<h3>Assigned Cases</h3>";

  const res = await secureFetch("/api/cases/my-assigned");
  if (!res.ok) {
    let message = "Unable to load assigned cases.";
    try {
      const data = await res.json().catch(() => ({}));
      message = data?.error || data?.msg || message;
    } catch {}
    section.innerHTML += `<p>${escapeHTML(message)}</p>`;
    return;
  }
  const { items = [] } = await res.json().catch(() => ({}));

  if (!items.length) {
    section.innerHTML += "<p>No assigned cases.</p>";
    return;
  }

  items.forEach(c => {
    const funded = String(c.escrowStatus || "").toLowerCase() === "funded";
    const action = funded
      ? `<a class="btn primary" href="case-detail.html?caseId=${c._id}">Open Case</a>`
      : '<button class="btn secondary" type="button" disabled aria-disabled="true">Awaiting Attorney Funding</button>';
    section.innerHTML += `
      <div class="assigned-case-card">
        <strong>${escapeHTML(c.title || "Untitled case")}</strong><br>
        <span>Attorney: ${escapeHTML(c.attorneyName || "Unknown")}</span><br>
        ${action}
      </div>
    `;
  });
}
