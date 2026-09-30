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

describe("Paralegal V2 Phase 6 global tools", () => {
  test("authenticated Help preserves all current subjects and structured issue reporting", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/help-view.mjs");
    const center = read("frontend/assets/scripts/utils/help-center.mjs");
    [
      "Account & access",
      "Invitations & applying",
      "Working on a matter",
      "Getting paid",
      "Withdrawals & disputes",
      "Report an issue",
      "Reset password",
      "Privacy Policy",
      "Terms of Service",
      "Accessibility",
    ].forEach((copy) => expect(source).toContain(copy));
    expect(source).toContain('createHelpCenter({');
    expect(source).toContain('api: guardedApi');
    expect(source).toContain('verifyParalegalSession(options.api, request)');
    expect(center).toMatch(/api\.post\("\/api\/incidents"/);
    expect(center).toMatch(/error\?\.payload\?\.fields/);
    expect(center).toMatch(/Report received/);
    expect(center).toMatch(/Unable to submit/);
    expect(center).toMatch(/Try again/);
    expect(center).toMatch(/Do not include privileged matter content/);
    expect(center).toMatch(/const reportDraft = \{ summary: "", description: "" \}/);
    expect(center).toMatch(/hasDrafts\(\)/);
    expect(source).toContain('center.clearDrafts(settings); guardedApi.clear()');
  });

  test("unfinished V2 work is retained during internal navigation and protected at session exit", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const browse = read("frontend/assets/scripts/paralegal-v2/browse-view.mjs");
    const work = read("frontend/assets/scripts/paralegal-v2/work-view.mjs");
    const matter = read("frontend/assets/scripts/paralegal-v2/matter-view.mjs");
    expect(app).toMatch(/function hasUnfinishedWork\(\)/);
    expect(app).toMatch(/window\.addEventListener\("beforeunload"/);
    expect(app).toMatch(/Log out and discard unfinished work\?/);
    expect(app).toMatch(/function clearSensitiveDrafts\(\)/);
    expect(app).toMatch(/matterView\?\.leave\?\.\(\)[\s\S]*matterView\?\.clearDrafts\?\.\(\)/);
    expect(browse).toMatch(/hasDrafts\(\) \{[\s\S]*applicationDrafts\.size/);
    expect(work).toMatch(/hasDrafts\(\) \{ return requirements\.hasDrafts\(\); \}/);
    expect(work).toContain('requirements.clear()');
    expect(matter).toMatch(/messageController\.hasDrafts\(\) \|\| fileController\.hasDrafts\(\)/);
  });

  test("Search remains user-scoped, cancellation-safe, and server-authorized", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/search-controller.mjs");
    const search = read("frontend/assets/scripts/utils/workspace-search.mjs");
    const backend = read("backend/services/authenticatedSearch.js");
    expect(source).toContain('createWorkspaceSearch({');
    expect(source).toContain('verifyParalegalSession(options.api, request)');
    expect(source).toContain('types: ["matter"]');
    expect(search).toContain('lpc-v2-search-recent:${scopedUserId}');
    expect(search).toMatch(/controller\?\.abort\(\)/);
    expect(search).toContain('ticket === sequence && ownerId === currentId() && ownerId === scopedUserId');
    expect(search).toMatch(/scopeToIdentity/);
    expect(search).toContain('expectedOwnerId: ownerId');
    expect(search).toMatch(/\/api\/cases\/search\?\$\{params\}/);
    expect(search).toMatch(/ArrowDown/);
    expect(search).toMatch(/aria-activedescendant/);
    expect(search).toMatch(/visible\(false\)/);
    expect(read("frontend/paralegal-v2.html")).toMatch(/class="v2-header-search" role="search"/);
    expect(backend).toMatch(/buildMatterAccessFilter/);
    expect(backend).toMatch(/getBlockedUserIds|blockedIds/);
    expect(backend).toMatch(/withdrawnParalegalId/);
  });

  test("legacy authorized destinations map into V2 without loosening identifiers", () => {
    const id = "64b000000000000000000001";
    const destinations = evaluateModule(
      "frontend/assets/scripts/paralegal-v2/deep-links.mjs",
      `[
        subject.adaptLegacyDestination("/case-detail.html?caseId=${id}&tab=messages&messageId=64b000000000000000000002"),
        subject.adaptLegacyDestination("/browse-jobs.html?caseId=${id}"),
        subject.adaptLegacyDestination("/dashboard-paralegal.html?inviteCase=${id}#home"),
        subject.adaptLegacyDestination("/dashboard-paralegal.html?applicationId=64b000000000000000000003#cases"),
        subject.adaptLegacyDestination("/profile-settings.html#securitySection"),
        subject.adaptLegacyDestination("javascript:alert(1)"),
        subject.adaptLegacyDestination("/case-detail.html?caseId=not-an-id")
      ]`
    );
    expect(destinations[0]).toEqual({
      href: `/paralegal-v2.html#/matter/${id}?tab=messages&messageId=64b000000000000000000002`,
      internal: true,
    });
    expect(destinations[1]).toEqual({ href: `/paralegal-v2.html#/browse?matterId=${id}`, internal: true });
    expect(destinations[2]).toEqual({ href: `/paralegal-v2.html#/work?section=invitations&matterId=${id}`, internal: true });
    expect(destinations[3].href).toContain("#/work?section=applications&applicationId=");
    expect(destinations[4]).toEqual({ href: "/paralegal-v2.html#/settings?tab=security", internal: true });
    expect(destinations[5]).toBeNull();
    expect(destinations[6]).toBeNull();
  });

  test("Notifications share the verified account-bound center across both workspaces", () => {
    const wrapper = read("frontend/assets/scripts/paralegal-v2/notifications-controller.mjs");
    const source = read("frontend/assets/scripts/utils/notification-center.mjs");
    const attorney = read("frontend/assets/scripts/attorney-v2/global-tools.mjs");
    expect(wrapper).toContain("createNotificationCenter");
    expect(wrapper).toContain("adaptLegacyDestination");
    expect(attorney).toContain("createNotificationCenter");
    expect(source).toContain("/api/notifications/page?");
    expect(source).toContain('ownedRequest("/api/notifications/unread-count"');
    expect(source).toContain("expectedOwnerId");
    expect(source).toContain('result?.success !== true');
    expect(source).toContain('new EventSource("/api/notifications/stream")');
    expect(source).toContain("new BroadcastChannel");
    expect(source).toContain('addEventListener("storage"');
    expect(source).toContain("cancelNavigation");
    // Browser tests exercise authority-before-update, retry, focus and both account races.
    expect(read("frontend/attorney-v2.html")).toContain("data-av2-notification-actions");
  });

  test("older Browse aliases retain a selected Matter and all filters without accepting external destinations", () => {
    const id = "64b000000000000000000001";
    const destinations = evaluateModule("frontend/assets/scripts/paralegal-v2/deep-links.mjs", `[
      ...["id", "caseId", "caseID", "case_id"].map(key => subject.adaptLegacyDestination("/browse-jobs.html?" + key + "=${id}&browseState=&browsePractice=Contract+Law&browseMinPay=700&browseDeadline=7_days&browsePosted=30_days&browseSort=payHigh&browsePage=2")),
      subject.adaptLegacyDestination("/browse-jobs.html?id=bad"),
      subject.adaptLegacyDestination("https://example.com/browse-jobs.html?id=${id}")
    ]`);
    for (const destination of destinations.slice(0, 4)) {
      expect(destination.internal).toBe(true);
      expect(destination.href.split("?")[0]).toBe("/paralegal-v2.html#/browse");
      expect(Object.fromEntries(new URLSearchParams(destination.href.split("?")[1]))).toEqual({ matterId: id,
        state: "", practice: "Contract Law", minPay: "700", deadline: "7_days", posted: "30_days", sort: "payHigh", page: "2" });
    }
    expect(destinations.slice(4)).toEqual([null, null]);
  });

  test("the V2 Assistant reuses the permission-aware workflow and explicit route context", () => {
    const html = read("frontend/paralegal-v2.html");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const assistant = read("frontend/assets/scripts/utils/support-drawer.js");
    const style = read("frontend/assets/styles/paralegal-v2-global.css");
    expect(html).toMatch(/data-support-v2-host[^>]*data-v2-persistent="assistant"/);
    expect(html).toMatch(/data-lpc-support-external-launcher="true"/);
    expect(app).toMatch(/registerSupportLauncher/);
    expect(app).toMatch(/notifySupportRouteChanged/);
    expect(app).toMatch(/if \(reason !== "external"\) return/);
    expect(assistant).toMatch(/messages\/\$\{encodeURIComponent\([\s\S]*\/feedback/);
    expect(assistant).toMatch(/\["helpful", "Helpful"\]/);
    expect(assistant).toMatch(/\["unhelpful", "Not helpful"\]/);
    expect(assistant).toMatch(/v2MatterId/);
    expect(assistant).toMatch(/href: window\.location\.href/);
    expect(assistant).toMatch(/AI can make mistakes\. Check important information\./);
    expect(assistant).not.toMatch(/Checking that now/i);
    expect(assistant).not.toMatch(/Describe what(?:'|’)s blocking you/i);
    expect(style).toMatch(/--v2-assistant-width/);
    expect(app).toMatch(/from "\.\.\/utils\/support-drawer\.js"/);
    expect(app).not.toMatch(/support-drawer\.js\?v=/);
    expect(style).toMatch(/\.support-drawer[\s\S]*box-shadow: none/);
    expect(assistant).toMatch(/isV2Shell \? "\(min-width: 1101px\)"/);
  });
});
