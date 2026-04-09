function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toneFromRisk(riskLevel = "") {
  const risk = String(riskLevel || "").toLowerCase();
  if (risk === "high") return "priority";
  if (risk === "medium") return "needs-review";
  return "active";
}

export function renderIncidentList(rootId, metaId, incidents = [], activeIncidentId = "") {
  const root = document.getElementById(rootId);
  const meta = document.getElementById(metaId);
  if (!root) return;

  if (meta) {
    meta.textContent = `${incidents.length} ${incidents.length === 1 ? "incident" : "incidents"} visible`;
  }

  if (!incidents.length) {
    root.innerHTML = '<div class="ai-room-empty">No incidents are visible yet.</div>';
    return;
  }

  root.innerHTML = incidents
    .map((incident) => {
      const isActive = String(incident.id || incident.publicId) === String(activeIncidentId || "");
      const summary = escapeHTML(incident.summary || "Untitled incident");
      const publicId = escapeHTML(incident.publicId || "Incident");
      const cluster = incident.classification?.clusterKey
        ? `Cluster ${escapeHTML(incident.classification.clusterKey)}`
        : "No cluster";
      const state = escapeHTML(incident.state || "unknown");
      const riskLevel = incident.classification?.riskLevel || "low";
      const tone = toneFromRisk(riskLevel);
      const activeStyle = isActive
        ? ' style="border-color: rgba(180, 151, 90, 0.42); box-shadow: 0 18px 30px rgba(15, 23, 42, 0.08);"'
        : "";

      return `
        <article class="ai-room-list-item"${activeStyle}>
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${publicId}</strong>
            <span class="ai-room-badge ai-room-badge--${escapeHTML(tone)}">${escapeHTML(riskLevel)}</span>
          </div>
          <p>${summary}</p>
          <p><strong>State:</strong> ${state} · <strong>Updated:</strong> ${escapeHTML(
            formatDateTime(incident.updatedAt)
          )}</p>
          <p><strong>Surface:</strong> ${escapeHTML(incident.context?.surface || "unknown")} · <strong>${cluster}</strong></p>
          <div class="ai-room-card-actions">
            <span class="ai-room-card-meta">${escapeHTML(
              incident.classification?.domain || "unknown"
            )} · ${escapeHTML(incident.classification?.severity || "low")}</span>
            <button
              class="btn secondary"
              type="button"
              data-incident-select="${escapeHTML(incident.id || incident.publicId)}"
            >
              Inspect
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}
