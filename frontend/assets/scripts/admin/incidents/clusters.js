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

export function renderIncidentClusters(rootId, metaId, clusters = []) {
  const root = document.getElementById(rootId);
  const meta = document.getElementById(metaId);
  if (!root) return;

  if (meta) {
    meta.textContent = `${clusters.length} ${clusters.length === 1 ? "cluster" : "clusters"}`;
  }

  if (!clusters.length) {
    root.innerHTML = '<div class="ai-room-empty">No repeated issue clusters are visible yet.</div>';
    return;
  }

  root.innerHTML = clusters
    .map((cluster) => {
      const tone = toneFromRisk(cluster.riskLevel);
      const targetId = cluster.incidentIds?.[0] || "";
      return `
        <article class="ai-room-list-item">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(cluster.clusterKey || "Unclustered")}</strong>
            <span class="ai-room-badge ai-room-badge--${escapeHTML(tone)}">${escapeHTML(
              cluster.riskLevel || "low"
            )}</span>
          </div>
          <p>${escapeHTML(cluster.topSummary || "No summary recorded.")}</p>
          <p><strong>Count:</strong> ${escapeHTML(cluster.count)} · <strong>Newest:</strong> ${escapeHTML(
            formatDateTime(cluster.newestAt)
          )}</p>
          <div class="ai-room-card-actions">
            <span class="ai-room-card-meta">${escapeHTML(
              Object.keys(cluster.stateBreakdown || {}).join(", ") || "No state breakdown"
            )}</span>
            ${
              targetId
                ? `<button class="btn secondary" type="button" data-incident-select="${escapeHTML(
                    targetId
                  )}">Open Incident</button>`
                : ""
            }
          </div>
        </article>
      `;
    })
    .join("");
}
