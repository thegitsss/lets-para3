const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("Paralegal V2 completion handoff contract", () => {
  const matterView = read("frontend/assets/scripts/paralegal-v2/matter-view.mjs");
  const matterStyles = read("frontend/assets/styles/paralegal-v2-matter.css");
  const cases = read("backend/routes/cases.js");
  const help = read("frontend/assets/scripts/paralegal-v2/help-view.mjs");

  test("presents attorney-owned review and completion as state, not paralegal controls", () => {
    expect(matterView).toMatch(/The attorney marks each item complete after review\./);
    expect(matterView).toMatch(/Awaiting final attorney review\./);
    expect(matterView).toMatch(/data-completion-state/);
    expect(matterView).not.toMatch(/api\.(?:post|patch)\([^\n]*(?:complete|tasks)/i);
    expect(help).toMatch(/the attorney reviews files, requests revisions, and marks work items complete/i);
    expect(help).toMatch(/the attorney handles final review, matter completion, and payment release/i);
  });

  test("revalidates task and Matter changes without remounting the application shell", () => {
    expect(matterView).toMatch(/new EventSource\(`\/api\/cases\/\$\{encodeURIComponent\(matterId\)\}\/stream`\)/);
    expect(matterView).toMatch(/addEventListener\("tasks", scheduleReconcile\)/);
    expect(matterView).toMatch(/addEventListener\("case", scheduleReconcile\)/);
    expect(matterView).toMatch(/const latest = await api\.get\(`\/api\/cases\/\$\{encodeURIComponent\(matterId\)\}\?\$\{new URLSearchParams\(\{ expectedOwnerId:/);
    expect(matterView).toMatch(/if \(fingerprint === activeMatterFingerprint\) return/);
    expect(matterView).toMatch(/source\.addEventListener\("open", \(\) => \{[\s\S]*scheduleReconcile\(\)/);
    expect(matterView).toMatch(/matterEventSource\?\.close\(\)/);
  });

  test("keeps the existing server authority and completed-history boundary", () => {
    expect(cases).toMatch(/Only the Matter attorney can update this Matter/);
    expect(cases).toMatch(/Only the Matter attorney may close this Matter/);
    expect(cases).toMatch(/Completed Matters are no longer accessible/);
    expect(cases).toMatch(/publishCaseEvent\(doc\._id, "tasks"/);
    expect(cases).toMatch(/publishCaseEvent\(doc\._id, "case"/);
  });

  test("uses one compact guidance line in document flow with no overlay or shadow", () => {
    expect(matterStyles).toMatch(/\.v2-matter-completion-handoff\s*\{/);
    expect(matterView).toMatch(/handoff\?\.detail \? node\("aside",[\s\S]*?\}, \[\s*node\("span", \{ text: handoff\.detail \}\),\s*\]\) : null/);
    const block = matterStyles.match(/\.v2-matter-completion-handoff\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(block).toBeTruthy();
    expect(block).toMatch(/border-top:\s*1px solid var\(--v2-line\)/);
    expect(block).not.toMatch(/box-shadow|position:\s*(?:fixed|absolute)|z-index|\b(?:min-)?width\s*:|grid-template-columns/);
  });
});
