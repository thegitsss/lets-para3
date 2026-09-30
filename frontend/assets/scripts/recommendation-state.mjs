export const RECOMMENDATION_HISTORY_EVENT = "lpc:recommendation-history-changed";
export const RECOMMENDATION_HISTORY_STORAGE_KEY = "lpc_recommendation_history_changed";

export function normalizeRecommendationId(value) {
  if (!value) return "";
  if (typeof value === "object") {
    return normalizeRecommendationId(value._id || value.id || value.caseId || value.jobId || "");
  }
  return String(value).trim();
}

export function getRecommendationIdentityIds(listing = {}) {
  return [
    listing.caseId,
    listing.case_id,
    listing.contextCaseId,
    listing.case,
    listing.id,
    listing._id,
    listing.jobId,
    listing.job_id,
  ].map(normalizeRecommendationId).filter(Boolean);
}

export function buildHistoricalExclusionSet(payload = {}) {
  const values = [
    ...(Array.isArray(payload.matterIds) ? payload.matterIds : []),
    ...(Array.isArray(payload.caseIds) ? payload.caseIds : []),
    ...(Array.isArray(payload.jobIds) ? payload.jobIds : []),
  ];
  return new Set(values.map(normalizeRecommendationId).filter(Boolean));
}

export function isHistoricallyExcluded(listing, exclusionIds) {
  const ids = exclusionIds instanceof Set ? exclusionIds : buildHistoricalExclusionSet(exclusionIds);
  return getRecommendationIdentityIds(listing).some((id) => ids.has(id));
}

export function createRecommendationStateLoader({
  loadProfile,
  loadJobs,
  loadExclusions,
  onLoading = () => {},
  onReady = () => {},
  onError = () => {},
}) {
  let generation = 0;
  return {
    async refresh(options = {}) {
      const currentGeneration = ++generation;
      if (!options.silent) onLoading(options);
      try {
        const [profile, jobs, exclusions] = await Promise.all([
          options.profilePromise || loadProfile(options),
          loadJobs(options),
          loadExclusions(options),
        ]);
        if (currentGeneration !== generation) return { stale: true };
        const payload = { profile, jobs, exclusions };
        onReady(payload, options);
        return { stale: false, ...payload };
      } catch (error) {
        if (currentGeneration !== generation) return { stale: true, error };
        if (!options.silent) onError(error, options);
        return { stale: false, error };
      }
    },
  };
}

export function shouldHandleRecommendationHistoryChange(payload = {}, viewerId = "") {
  const targetViewer = normalizeRecommendationId(payload.viewerId);
  const activeViewer = normalizeRecommendationId(viewerId);
  return Boolean(targetViewer && activeViewer && targetViewer === activeViewer);
}

export function publishRecommendationHistoryChange(payload = {}) {
  if (typeof window === "undefined") return null;
  const detail = {
    viewerId: normalizeRecommendationId(payload.viewerId),
    caseIds: (payload.caseIds || []).map(normalizeRecommendationId).filter(Boolean),
    jobIds: (payload.jobIds || []).map(normalizeRecommendationId).filter(Boolean),
    matterIds: (payload.matterIds || []).map(normalizeRecommendationId).filter(Boolean),
    changedAt: new Date().toISOString(),
    nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  try {
    // Cross-tab refresh needs the viewer and a change signal, not Matter IDs.
    window.localStorage?.setItem(RECOMMENDATION_HISTORY_STORAGE_KEY, JSON.stringify({
      viewerId: detail.viewerId,
      changedAt: detail.changedAt,
      nonce: detail.nonce,
    }));
  } catch {
    // Server refresh remains the authority when browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(RECOMMENDATION_HISTORY_EVENT, { detail }));
  return detail;
}

export function subscribeRecommendationHistoryChanges(handler) {
  if (typeof window === "undefined" || typeof handler !== "function") return () => {};
  const onLocal = (event) => handler(event?.detail || {});
  const onStorage = (event) => {
    if (event.key !== RECOMMENDATION_HISTORY_STORAGE_KEY || !event.newValue) return;
    try {
      handler(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed or legacy storage values.
    }
  };
  window.addEventListener(RECOMMENDATION_HISTORY_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(RECOMMENDATION_HISTORY_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}
