const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadRecommendationState(windowOverrides = {}) {
  const filePath = path.resolve(
    __dirname,
    "../../frontend/assets/scripts/recommendation-state.mjs"
  );
  const source = fs
    .readFileSync(filePath, "utf8")
    .replace(/export const /g, "const ")
    .replace(/export function /g, "function ")
    .concat(`
      module.exports = {
        RECOMMENDATION_HISTORY_EVENT,
        RECOMMENDATION_HISTORY_STORAGE_KEY,
        normalizeRecommendationId,
        getRecommendationIdentityIds,
        buildHistoricalExclusionSet,
        isHistoricallyExcluded,
        createRecommendationStateLoader,
        shouldHandleRecommendationHistoryChange,
        publishRecommendationHistoryChange,
        subscribeRecommendationHistoryChanges,
      };
    `);
  const listeners = new Map();
  const window = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.forEach((handler) => handler(event));
    },
    localStorage: { setItem: jest.fn() },
    ...windowOverrides,
  };
  class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const sandbox = {
    module: { exports: {} },
    exports: {},
    window,
    CustomEvent,
    Date,
    Math,
    Set,
  };
  vm.runInNewContext(source, sandbox, { filename: filePath });
  return { ...sandbox.module.exports, window };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Recommendation dependency and tab synchronization", () => {
  test("dashboard and Browse wire refresh, back-navigation, and cross-tab synchronization", () => {
    const dashboard = fs.readFileSync(
      path.resolve(__dirname, "../../frontend/assets/scripts/paralegal-dashboard.js"),
      "utf8"
    );
    const browse = fs.readFileSync(
      path.resolve(__dirname, "../../frontend/assets/scripts/views/browse-jobs.js"),
      "utf8"
    );
    expect(dashboard).toContain("readOwnedHome('recommendations', options => fetchJson('/api/jobs/recommended', options))");
    expect(dashboard).not.toMatch(/rankRecommendedMatters|isHistoricallyExcluded/);
    expect(browse).not.toMatch(/lpc_applied_jobs|persistAppliedJobs/);
    expect(dashboard).toMatch(/const resume = reason => \{\s*dashboardDeparting = false;\s*refreshDashboardFromServer\(reason, \{ force: true \}\);/);
    expect(dashboard).toMatch(/window\.addEventListener\('pageshow',[\s\S]*event\.persisted\) resume\('pageshow'\)/);
    expect(dashboard).toMatch(/document\.addEventListener\('visibilitychange',[\s\S]*document\.visibilityState === 'visible'\) resume\('visible'\)/);
    expect(dashboard).toMatch(/loadAppliedJobs\(\{ preservePage: true, silent: true \}\)/);
    expect(dashboard).toMatch(/loadRecommendedMatters\(\{ silent: true \}\)/);
    expect(dashboard).toMatch(/window\.addEventListener\('lpc:lifecycle-refresh',[\s\S]*refreshDashboardFromServer\('lifecycle', \{ force: true \}\)/);
    expect(dashboard).toMatch(/subscribeRecommendationHistoryChanges\([\s\S]*handleRecommendationHistoryChange/);
    expect(browse).toMatch(/publishRecommendationHistoryChange\(\{/);
  });

  test.each([
    ["jobs first", ["jobs", "profile", "exclusions"]],
    ["profile first", ["profile", "jobs", "exclusions"]],
    ["historical exclusions last", ["profile", "jobs", "exclusions"]],
  ])("does not render until every authoritative dependency resolves: %s", async (_label, order) => {
    const state = loadRecommendationState();
    const requests = {
      profile: deferred(),
      jobs: deferred(),
      exclusions: deferred(),
    };
    const ready = jest.fn();
    const loading = jest.fn();
    const loader = state.createRecommendationStateLoader({
      loadProfile: () => requests.profile.promise,
      loadJobs: () => requests.jobs.promise,
      loadExclusions: () => requests.exclusions.promise,
      onLoading: loading,
      onReady: ready,
    });

    const refresh = loader.refresh();
    const values = {
      profile: { state: "CA" },
      jobs: [{ id: "case-1" }],
      exclusions: { matterIds: [] },
    };
    for (const key of order.slice(0, -1)) {
      requests[key].resolve(values[key]);
      await Promise.resolve();
      expect(ready).not.toHaveBeenCalled();
    }
    const last = order[order.length - 1];
    requests[last].resolve(values[last]);
    await refresh;

    expect(loading).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(values, {});
  });

  test.each(["profile", "jobs", "exclusions"])(
    "shows an unavailable state and never renders partial data when %s fails",
    async (failedRequest) => {
      const state = loadRecommendationState();
      const ready = jest.fn();
      const unavailable = jest.fn();
      const values = {
        profile: Promise.resolve({ state: "CA" }),
        jobs: Promise.resolve([{ id: "case-1" }]),
        exclusions: Promise.resolve({ matterIds: [] }),
      };
      values[failedRequest] = Promise.reject(new Error(`${failedRequest} unavailable`));
      const loader = state.createRecommendationStateLoader({
        loadProfile: () => values.profile,
        loadJobs: () => values.jobs,
        loadExclusions: () => values.exclusions,
        onReady: ready,
        onError: unavailable,
      });

      await loader.refresh();

      expect(ready).not.toHaveBeenCalled();
      expect(unavailable).toHaveBeenCalledWith(
        expect.objectContaining({ message: `${failedRequest} unavailable` }),
        {}
      );
    }
  );

  test("silent refresh preserves the rendered recommendation state while dependencies reload", async () => {
    const state = loadRecommendationState();
    const loading = jest.fn();
    const ready = jest.fn();
    const loader = state.createRecommendationStateLoader({
      loadProfile: () => Promise.resolve({ state: "CA" }),
      loadJobs: () => Promise.resolve([{ id: "case-1" }]),
      loadExclusions: () => Promise.resolve({ matterIds: [] }),
      onLoading: loading,
      onReady: ready,
    });

    await loader.refresh({ silent: true });

    expect(loading).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledWith(
      {
        profile: { state: "CA" },
        jobs: [{ id: "case-1" }],
        exclusions: { matterIds: [] },
      },
      { silent: true }
    );
  });

  test("silent refresh also preserves the rendered state when a dependency fails", async () => {
    const state = loadRecommendationState();
    const unavailable = jest.fn();
    const loader = state.createRecommendationStateLoader({
      loadProfile: () => Promise.resolve({ state: "CA" }),
      loadJobs: () => Promise.reject(new Error("temporary failure")),
      loadExclusions: () => Promise.resolve({ matterIds: [] }),
      onError: unavailable,
    });

    const result = await loader.refresh({ silent: true });

    expect(unavailable).not.toHaveBeenCalled();
    expect(result.error).toEqual(expect.objectContaining({ message: "temporary failure" }));
  });

  test("a slower stale refresh cannot restore an old recommendation", async () => {
    const state = loadRecommendationState();
    const oldJobs = deferred();
    const ready = jest.fn();
    let call = 0;
    const loader = state.createRecommendationStateLoader({
      loadProfile: () => Promise.resolve({ state: "CA" }),
      loadJobs: () => (++call === 1 ? oldJobs.promise : Promise.resolve([])),
      loadExclusions: () => Promise.resolve({ matterIds: ["case-1"] }),
      onReady: ready,
    });

    const staleRefresh = loader.refresh();
    await loader.refresh();
    oldJobs.resolve([{ id: "case-1" }]);
    await staleRefresh;

    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][0].jobs).toEqual([]);
  });

  test("Case and Job identities are both durable recommendation exclusions", () => {
    const state = loadRecommendationState();
    const exclusions = state.buildHistoricalExclusionSet({
      caseIds: ["case-1"],
      jobIds: ["job-old"],
      matterIds: ["job-current"],
    });
    expect(state.isHistoricallyExcluded({ id: "case-1", jobId: "job-current" }, exclusions)).toBe(true);
    expect(state.isHistoricallyExcluded({ id: "case-other", jobId: "job-old" }, exclusions)).toBe(true);
    expect(state.isHistoricallyExcluded({ id: "case-other", jobId: "job-other" }, exclusions)).toBe(false);
  });

  test("same-paralegal application events refresh stale tabs without affecting another paralegal", () => {
    const state = loadRecommendationState();
    const received = [];
    const unsubscribe = state.subscribeRecommendationHistoryChanges((payload) => received.push(payload));

    const published = state.publishRecommendationHistoryChange({
      viewerId: "paralegal-1",
      caseIds: ["case-1"],
      jobIds: ["job-1"],
    });

    expect(received).toEqual([published]);
    expect(state.shouldHandleRecommendationHistoryChange(published, "paralegal-1")).toBe(true);
    expect(state.shouldHandleRecommendationHistoryChange(published, "paralegal-2")).toBe(false);
    expect(state.window.localStorage.setItem).toHaveBeenCalledWith(
      state.RECOMMENDATION_HISTORY_STORAGE_KEY,
      expect.any(String)
    );
    unsubscribe();
  });
});
