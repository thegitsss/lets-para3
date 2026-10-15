const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Paralegal V2 Phase 8C Matter deadlines", () => {
  test("keeps the shared matter deadline read-only and labels Events as private reminders", () => {
    const view = read("frontend/assets/scripts/paralegal-v2/matter-view.mjs");
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-deadlines.mjs");
    expect(view).toMatch(/matterDeadline: context\.experience\.overview\?\.deadline/);
    expect(controller).toContain("Your private reminders");
    expect(controller).toContain("Reminders don’t change the Matter deadline.");
    expect(controller).not.toMatch(/complete(?:d)? reminder|shared reminder|case_team/i);
  });

  test("uses reviewed owner-scoped Event operations and never edits the Case deadline", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-deadlines.mjs");
    expect(controller).toContain("/api/events/paralegal/matters/");
    expect(controller).toContain("/reviewed-action");
    expect(controller).toContain("expectedOwnerId: state.ownerId");
    expect(controller).toContain("reviewedMatterRevision: state.result.revision");
    expect(controller).toContain("reviewedRevision: event.revision");
    expect(controller).toContain("readDateOperation");
    expect(controller).not.toMatch(/\/api\/cases\/|deadlineDate\s*[:=]/);
  });

  test("uses all-day date semantics, server-confirmed refreshes, and duplicate-action guards", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-deadlines.mjs");
    expect(controller).toMatch(/T12:00:00\.000Z/);
    expect(controller).toMatch(/isAllDay: true/);
    expect(controller).toMatch(/if \(state\.busy \|\| state !== current \|\| !state\.writable \|\| state\.reading \|\| state\.pending/);
    expect(controller).toMatch(/await refresh\(state\)/);
    expect(controller).not.toMatch(/optimistic|localStorage|sessionStorage|indexedDB|innerHTML/);
  });

  test("fails closed for stale Matter access and synchronizes private reminders across tabs and Home", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-deadlines.mjs");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const home = read("frontend/assets/scripts/paralegal-v2/home-view.mjs");
    expect(controller).toMatch(/error\.status === 401[\s\S]*onSessionLost\?\.\(\)/);
    expect(controller).toMatch(/error\.status === 403[\s\S]*lockPanel[\s\S]*onAccessLost/);
    expect(controller).toMatch(/new BroadcastChannel\(`lpc-v2-matter-deadlines:/);
    expect(controller).toMatch(/new BroadcastChannel\("lpc-v2-deadlines"\)/);
    expect(app).toMatch(/new BroadcastChannel\("lpc-v2-deadlines"\)[\s\S]*homeView\.invalidate\(\)[\s\S]*scheduleRouteRefresh\(\["home"\]/);
    expect(controller).toMatch(/POLL_INTERVAL_MS = 15_000/);
    expect(app).toMatch(/onDeadlinesChanged\(\) \{[\s\S]*homeView\.invalidate\(\)/);
    expect(home).toMatch(/buildHomeModel/);
    const model = read("frontend/assets/scripts/paralegal-v2/home-model.mjs");
    expect(model).toMatch(/unique\(\[\.\.\.matterRows, \.\.\.reminderRows\]\)\.sort\(rowDeadline\)/);
    expect(model).toMatch(/matter\.workspaceReady && matter\.deadline/);
    expect(model).toMatch(/authorized\.has\(matterId\)/);
  });

  test("keeps the private-reminder layout contained without shadows", () => {
    const css = read("frontend/assets/styles/paralegal-v2-matter.css");
    expect(css).toMatch(/\.v2-matter-deadline-form\s*\{/);
    expect(css).toMatch(/\.v2-matter-deadline-list li\s*\{/);
    expect(css).toMatch(/@container v2-matter/);
    expect(css).not.toMatch(/box-shadow/);
  });

  test("supports a private-reminder deep link only through the allowlisted Matter route", () => {
    const deepLinks = read("frontend/assets/scripts/paralegal-v2/deep-links.mjs");
    expect(deepLinks).toMatch(/"deadlines"/);
    expect(deepLinks).toMatch(/"eventId"/);
    expect(deepLinks).toMatch(/const value = objectId\(source\.get\(name\)\)/);
  });
});
