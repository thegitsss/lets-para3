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

function toneFromEvent(eventType = "") {
  const type = String(eventType || "").toLowerCase();
  if (type.includes("failed") || type.includes("rollback")) return "priority";
  if (type.includes("approval") || type.includes("verification")) return "needs-review";
  return "active";
}

export function renderIncidentTimeline(rootId, metaId, events = []) {
  const root = document.getElementById(rootId);
  const meta = document.getElementById(metaId);
  if (!root) return;

  if (meta) {
    meta.textContent = `${events.length} ${events.length === 1 ? "event" : "events"}`;
  }

  if (!events.length) {
    root.innerHTML = '<div class="ai-room-empty">No timeline events are available for this incident yet.</div>';
    return;
  }

  root.innerHTML = events
    .map((event) => {
      const tone = toneFromEvent(event.eventType);
      const actor =
        event.actor?.agentRole || event.actor?.role || event.actor?.type || "system";
      const transition =
        event.fromState || event.toState
          ? `<p><strong>Transition:</strong> ${escapeHTML(event.fromState || "—")} -> ${escapeHTML(
              event.toState || "—"
            )}</p>`
          : "";

      return `
        <article class="ai-room-list-item">
          <div class="ai-room-list-item-top">
            <strong class="ai-room-list-item-title">${escapeHTML(event.summary || "Timeline event")}</strong>
            <span class="ai-room-badge ai-room-badge--${escapeHTML(tone)}">${escapeHTML(
              event.eventType || "event"
            )}</span>
          </div>
          <p><strong>At:</strong> ${escapeHTML(formatDateTime(event.createdAt))} · <strong>Actor:</strong> ${escapeHTML(
            actor
          )}</p>
          ${transition}
        </article>
      `;
    })
    .join("");
}
