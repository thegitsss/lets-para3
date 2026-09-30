const POLL_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

export function createMatterDiscoveryController({ api, onChange } = {}) {
  let userId = "";
  let stopped = true;
  let source = null;
  let pollingTimer = null;
  let reconnectTimer = null;
  let refreshTimer = null;
  let discoveryVersion = "";
  let versionRequest = null;

  function notify(reason) {
    if (stopped || refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      onChange?.({ reason });
    }, 120);
  }

  function stopPolling() {
    if (pollingTimer) window.clearInterval(pollingTimer);
    pollingTimer = null;
  }

  function startPolling() {
    if (pollingTimer || stopped) return;
    pollingTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reconcileVersion("poll");
    }, POLL_INTERVAL_MS);
  }

  async function reconcileVersion(reason, { establishOnly = false } = {}) {
    if (stopped || !api?.get) return;
    if (versionRequest) return versionRequest;
    versionRequest = api.get("/api/jobs/discovery-version")
      .then((payload) => {
        if (stopped) return;
        const nextVersion = String(payload?.version || "");
        if (!nextVersion) return;
        const changed = Boolean(discoveryVersion && discoveryVersion !== nextVersion);
        discoveryVersion = nextVersion;
        if (changed && !establishOnly) notify(reason);
      })
      .catch(() => {
        // The full authorized views remain the source of truth. A failed token
        // check is retried on the next interval, visibility change, or reconnect.
      })
      .finally(() => {
        versionRequest = null;
      });
    return versionRequest;
  }

  function stopStream() {
    source?.close();
    source = null;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function startStream() {
    if (stopped || source) return;
    if (typeof EventSource !== "function") {
      startPolling();
      return;
    }
    const nextSource = new EventSource("/api/jobs/stream");
    source = nextSource;
    nextSource.addEventListener("open", () => {
      // Reconcile anything that changed during a disconnect before trusting the
      // restored live stream.
      void reconcileVersion("reconnected");
    });
    nextSource.addEventListener("matters", () => {
      notify("matter-event");
      void reconcileVersion("matter-event", { establishOnly: true });
    });
    nextSource.addEventListener("error", () => {
      if (source !== nextSource) return;
      nextSource.close();
      source = null;
      startPolling();
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        startStream();
      }, RECONNECT_DELAY_MS);
    });
  }

  function start(identity) {
    const nextUserId = String(identity?.id || identity?._id || "").trim();
    if (!nextUserId) return stop();
    if (!stopped && userId === nextUserId) return;
    stop();
    userId = nextUserId;
    stopped = false;
    discoveryVersion = "";
    void reconcileVersion("initial", { establishOnly: true });
    startPolling();
    startStream();
  }

  function stop() {
    stopped = true;
    userId = "";
    discoveryVersion = "";
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = null;
    stopPolling();
    stopStream();
  }

  function reconcile() {
    if (stopped) return;
    void reconcileVersion("reconcile");
    startStream();
  }

  window.addEventListener("online", reconcile);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reconcile();
  });

  return Object.freeze({ start, stop, reconcile });
}
