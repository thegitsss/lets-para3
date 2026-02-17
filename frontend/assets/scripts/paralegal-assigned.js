import { secureFetch } from "./auth.js";
import { loadUserHeaderInfo } from "./auth.js";

const FUNDED_WORKSPACE_STATUSES = new Set([
  "in progress",
  "in_progress",
]);

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCaseId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return value.caseId || value.id || value._id || "";
  return "";
}

function normalizeCaseStatus(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "in_progress") return "in progress";
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing", "funded_in_progress"].includes(lower)) return "in progress";
  return lower;
}

function isWorkspaceEligibleCase(caseItem) {
  if (!caseItem) return false;
  if (caseItem.archived !== false) return false;
  if (caseItem.paymentReleased !== false) return false;
  const status = normalizeCaseStatus(caseItem?.status);
  if (!status || !FUNDED_WORKSPACE_STATUSES.has(status)) return false;
  const escrowFunded =
    !!caseItem?.escrowIntentId && String(caseItem?.escrowStatus || "").toLowerCase() === "funded";
  if (!escrowFunded) return false;
  const hasParalegal = caseItem?.paralegal || caseItem?.paralegalId;
  return !!hasParalegal;
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
    const caseId = getCaseId(c);
    const eligible = caseId ? isWorkspaceEligibleCase(c) : false;
    const action = eligible
      ? `<a class="btn primary" href="case-detail.html?caseId=${encodeURIComponent(caseId)}">Open Case</a>`
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
