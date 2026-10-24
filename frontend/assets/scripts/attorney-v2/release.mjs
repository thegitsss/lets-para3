export const RELEASE = Object.freeze({
  id: "attorney-v2-final-review-20260907",
  enabled: false,
  attorneyIds: Object.freeze([]),
});

// Local development is available without browser flags (LPC Product North Star).
// This presentation gate never grants API access; the server owns authorization.
export function isLocalPreview(hostname) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

export function canEnter(identity, hostname, release = RELEASE) {
  return identity?.role === "attorney" && identity?.status === "approved"
    && !identity.disabled && !identity.deleted
    && (isLocalPreview(hostname) || (release.enabled === true && release.attorneyIds.includes(identity.id)));
}

export function createTelemetry(target = window) {
  const counts = Object.create(null);
  const allowed = new Set(["session_ready", "session_lost", "session_error", "route_ready", "route_error", "tool_error"]);
  return Object.freeze({
    record(kind) {
      if (!allowed.has(kind)) return;
      counts[kind] = (counts[kind] || 0) + 1;
      // No user IDs, paths, queries, record titles, error bodies, or remote sink.
      target.dispatchEvent(new CustomEvent("lpc:attorney-v2-health", { detail: { release: RELEASE.id, kind } }));
    },
    snapshot: () => ({ release: RELEASE.id, counts: { ...counts } }),
  });
}
