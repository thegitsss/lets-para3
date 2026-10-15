import { createWorkspacePresenceLease } from "../utils/workspace-presence-lease.mjs";

const HEARTBEAT_INTERVAL_MS = 20_000;
const PRESENCE_SURFACES = new Map([
  ["overview", "overview"], ["work", "tasks"], ["tasks", "tasks"],
  ["messages", "messages"], ["files", "files"], ["deadlines", "deadlines"],
  ["activity", "history"], ["history", "history"],
]);

export function createWorkspacePresenceController({ api } = {}) {
  const lease = createWorkspacePresenceLease();
  let matterId = "";
  let surface = "";
  let active = false;
  let heartbeatTimer = null;
  let requestSequence = 0;

  function stopTimer() {
    if (heartbeatTimer) window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function mark(id, activeSurface, sequence) {
    if (!id || !active || id !== matterId || sequence !== requestSequence || document.hidden) return;
    try {
      const result = await api.post("/api/notifications/workspace-presence", { caseId: id, surface: activeSurface, ...lease.next() });
      if (result?.success !== true) return false;
      return true;
    } catch {
      // Presence only suppresses redundant alerts. It must never block the workspace.
      return false;
    }
  }

  async function clear(id, activeSurface) {
    if (!id) return;
    try {
      const result = await api.request("/api/notifications/workspace-presence", {
        method: "DELETE",
        // A pagehide clear must be allowed to finish after navigation or reload.
        keepalive: true,
        body: JSON.stringify({ caseId: id, surface: activeSurface, ...lease.next() }),
      });
      if (result?.success !== true) return false;
      return true;
    } catch {
      // Server-side presence expires automatically if an explicit clear cannot finish.
      return false;
    }
  }

  function beginHeartbeat() {
    stopTimer();
    if (!active || !matterId || document.hidden) return;
    const id = matterId;
    const activeSurface = surface;
    const sequence = requestSequence;
    void mark(id, activeSurface, sequence);
    heartbeatTimer = window.setInterval(() => void mark(id, activeSurface, sequence), HEARTBEAT_INTERVAL_MS);
  }

  function start(nextMatterId, { enabled = true, surface: nextSurface = "overview" } = {}) {
    const nextId = String(nextMatterId || "").trim();
    const normalizedSurface = PRESENCE_SURFACES.get(String(nextSurface || "overview").trim().toLowerCase() || "overview");
    // Applications and Payments do not consume live message/file updates.
    // Clear any previous lease without claiming generic workspace presence,
    // which would suppress alerts for content the user is not viewing.
    if (!normalizedSurface) { stop(); return; }
    const previousId = matterId;
    const previousSurface = surface;
    requestSequence += 1;
    stopTimer();
    matterId = nextId;
    surface = normalizedSurface;
    active = Boolean(nextId && enabled);
    if (previousId && (!active || previousId !== nextId || previousSurface !== normalizedSurface)) {
      void clear(previousId, previousSurface);
    }
    beginHeartbeat();
  }

  function stop({ clearRemote = true } = {}) {
    const previousId = matterId;
    const previousSurface = surface;
    requestSequence += 1;
    stopTimer();
    matterId = "";
    surface = "";
    active = false;
    if (clearRemote && previousId) void clear(previousId, previousSurface);
  }

  function handleVisibilityChange() {
    if (!active || !matterId) return;
    if (document.hidden) {
      stopTimer();
      void clear(matterId, surface);
      return;
    }
    requestSequence += 1;
    beginHeartbeat();
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", () => stop());

  return Object.freeze({ start, stop });
}

export { HEARTBEAT_INTERVAL_MS };
