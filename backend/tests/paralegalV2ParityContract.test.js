const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function evaluateModule(relativePath, expression) {
  const moduleUrl = pathToFileURL(path.join(root, relativePath)).href;
  const script = `import * as subject from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(${expression}));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" }));
}

describe("Paralegal V2 functional parity guardrails", () => {
  test("active Matter presence uses surface-aware notification suppression without changing legacy clients", () => {
    const presence = read("frontend/assets/scripts/paralegal-v2/workspace-presence.mjs");
    const view = read("frontend/assets/scripts/paralegal-v2/matter-view.mjs");
    expect(presence).toContain('HEARTBEAT_INTERVAL_MS = 20_000');
    expect(presence).toContain('api.post("/api/notifications/workspace-presence", { caseId: id, surface: activeSurface, ...lease.next() })');
    expect(presence).toContain('createWorkspacePresenceLease()');
    expect(presence).toContain('method: "DELETE"');
    expect(presence).toMatch(/document\.addEventListener\("visibilitychange"/);
    expect(presence).toMatch(/window\.addEventListener\("pagehide"/);
    expect(view).toMatch(/presenceController\.start\(matterId/);
    expect(view).toMatch(/surface: selectedTab/);
    expect(view).toMatch(/presenceController\.stop\(\)/);
  });

  test("the conversation and file list share the same authorized upload evidence", () => {
    const messages = read("frontend/assets/scripts/paralegal-v2/matter-messages.mjs");
    const files = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");
    const view = read("frontend/assets/scripts/paralegal-v2/matter-view.mjs");
    expect(files).toMatch(/export const MAX_FILE_BYTES = 20 \* 1024 \* 1024/);
    expect(messages).toMatch(/import \{ ACCEPTED_FILE_TYPES, MAX_FILE_BYTES \} from "\.\/matter-files\.mjs"/);
    expect(messages).toMatch(/timelineEntries\(state\)/);
    expect(messages).toMatch(/api\.blob\(`\/api\/uploads\/case\//);
    expect(view).toMatch(/\["messages", "files"\]\.includes\(requestedTab\)/);
    expect(view).toMatch(/filesResult: context\.files/);
  });

  test("legacy links preserve Matter tabs, application identifiers, setup returns, tours, and attorney profiles", () => {
    const id = "64b000000000000000000001";
    const other = "64b000000000000000000002";
    const values = evaluateModule("frontend/assets/scripts/paralegal-v2/deep-links.mjs", `[
      subject.adaptLegacyDestination("/case-detail.html?caseId=${id}#case-messages"),
      subject.adaptLegacyDestination("/case-detail.html?caseId=${id}#caseFilesSection"),
      subject.adaptLegacyDestination("/dashboard-paralegal.html?highlightJobId=${other}#cases"),
      subject.adaptLegacyDestination("/dashboard-paralegal.html#cases-completed"),
      subject.adaptLegacyDestination("/dashboard-paralegal.html?replayTour=1"),
      subject.adaptLegacyDestination("/profile-settings.html?onboarding=success"),
      subject.adaptLegacyDestination("/profile-settings.html?onboardingStep=profile&profilePrompt=1"),
      subject.adaptLegacyDestination("/profile-attorney.html?id=${id}&from=browse")
    ]`);
    expect(values[0].href).toBe(`/paralegal-v2.html#/matter/${id}?tab=messages`);
    expect(values[1].href).toBe(`/paralegal-v2.html#/matter/${id}?tab=files`);
    expect(values[2].href).toBe(`/paralegal-v2.html#/work?section=applications&jobId=${other}`);
    expect(values[3].href).toBe("/paralegal-v2.html#/work?section=history");
    expect(values[4].href).toBe("/paralegal-v2.html#/home?tour=1");
    expect(values[5].href).toBe("/paralegal-v2.html#/settings?tab=security&section=payments&stripe=success");
    expect(values[6].href).toBe("/paralegal-v2.html#/settings?tab=profile&profilePrompt=1");
    expect(values[7].href).toBe(`/paralegal-v2.html#/attorney/${id}`);
  });

  test("attorney profiles and onboarding are real V2 routes backed by existing authorities", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const profile = read("frontend/assets/scripts/paralegal-v2/attorney-profile-view.mjs");
    const onboarding = read("frontend/assets/scripts/paralegal-v2/onboarding-controller.mjs");
    const settings = read("frontend/assets/scripts/paralegal-v2/settings-view.mjs");
    expect(app).toMatch(/route\.name === "attorney"/);
    expect(profile).toMatch(/api\.get\(`\/api\/users\/attorneys\/\$\{encodeURIComponent\(id\)\}`/);
    expect(profile).toMatch(/error\.status === 403/);
    expect(onboarding).toContain('api.get("/api/users/me/onboarding")');
    expect(onboarding).toContain('method: "PATCH"');
    expect(onboarding).toContain("paralegalTourCompleted");
    expect(onboarding).toContain("paralegalProfileTourCompleted");
    expect(settings).not.toMatch(/location\.assign\("dashboard-paralegal\.html\?replayTour=1"\)/);
  });

  test("Matter navigation and payout evidence remain available in the V2 workspace", () => {
    const view = read("frontend/assets/scripts/paralegal-v2/matter-view.mjs");
    expect(view).toContain('endpoint: "/api/cases/assigned-choices"');
    expect(view).not.toContain('/api/cases/my?limit=100');
    expect(view).toContain('"data-v2-matter-switcher"');
    expect(view).toContain('import { renderMatterPayments } from "../utils/matter-financials.mjs"');
    expect(view).toContain('renderMatterPayments(experience.financials, { ownerId: context.ownerId, caseId: context.matterId, role: "paralegal", api: context.api, signal: context.signal, isCurrent: context.isCurrent, onRefresh: context.onRefresh })');
  });
});
