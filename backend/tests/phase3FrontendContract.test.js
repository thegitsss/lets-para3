const fs = require("node:fs");
const path = require("node:path");

function frontendSource(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "../../frontend", relativePath), "utf8");
}

describe("Phase 3 frontend stale-state contract", () => {
  test("successful lifecycle mutations publish same-tab and cross-tab refresh signals", () => {
    const source = frontendSource("assets/scripts/auth.js");
    expect(source).toMatch(/new BroadcastChannel\(LIFECYCLE_CHANNEL_NAME\)/);
    expect(source).toMatch(/localStorage\.setItem\(LIFECYCLE_STORAGE_KEY/);
    expect(source).toMatch(/window\.dispatchEvent\(new CustomEvent\("lpc:lifecycle-refresh"/);
    expect(source).toMatch(/isMutation && res\.ok && shouldPublishLifecycleMutation/);
  });

  test("paralegal dashboard ignores old generations and queues the authoritative refresh", () => {
    const source = frontendSource("assets/scripts/paralegal-dashboard.js");
    expect(source).toMatch(/const generation = \+\+dashboardRefreshGeneration/);
    expect(source).toMatch(/if \(generation !== dashboardRefreshGeneration\) return/);
    expect(source).toMatch(/dashboardRefreshQueuedReason = reason \|\| 'queued'/);
    expect(source).toMatch(/refreshDashboardFromServer\(queuedReason, \{ force: true \}\)/);
  });

  test("workspace authorization loss purges cached confidential state before redirect or reload", () => {
    const source = frontendSource("assets/scripts/case-detail.js");
    expect(source).toMatch(/function purgeRevokedWorkspaceState/);
    expect(source).toMatch(/state\.messageCacheByCase\.delete\(revokedCaseId\)/);
    expect(source).toMatch(/state\.caseDocumentsById\.delete\(revokedCaseId\)/);
    expect(source).toMatch(/\(err\?\.status === 403 \|\| err\?\.status === 404\)[\s\S]*purgeRevokedWorkspaceState\(caseId\)/);
    expect(source).toMatch(/window\.addEventListener\("lpc:lifecycle-refresh"/);
  });

  test("attorney Home rejects superseded reads and refreshes on lifecycle and bfcache signals", () => {
    const source = frontendSource("assets/scripts/attorney-tabs.js");
    const home = frontendSource("assets/scripts/legacy-attorney-home.mjs");
    expect(source).toContain('createLegacyAttorneyHome');
    expect(source).toContain('await legacyHome.refresh()');
    expect(home).toContain('if (pending.get(key) !== controller || suspended || lost) return;');
    expect(source).toMatch(/window\.addEventListener\("lpc:lifecycle-refresh", scheduleLifecycleOverviewRefresh\)/);
    expect(home).toContain("window.addEventListener('pageshow', event => { if (event.persisted && !lost) { suspended = false; void refresh(); } });");
  });
});
