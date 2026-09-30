const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Paralegal V2 My Matters & Applications contract", () => {
  test("Work is a real same-document view inside the persistent shell", () => {
    const html = read("frontend/paralegal-v2.html");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    expect(html).toMatch(/paralegal-v2-work\.css/);
    expect(app).toMatch(/createWorkView/);
    expect(app).toMatch(/route\.name === "work"/);
    expect(app).toMatch(/workView\.render/);
    expect(app).not.toMatch(/location\.(?:assign|replace)\([^)]*dashboard-paralegal/);
  });

  test("Work consumes the existing authoritative projections without inventing statuses", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/work-view.mjs");
    [
      'api.get(`/api/paralegal/dashboard?expectedOwnerId=${encodeURIComponent(ownerId)}`)',
      'api.get("/api/applications/my")',
      'loadReceivedInvitations(api, ownerId,',
      'loadParalegalHistory(api, ownerId,',
      'api.get("/api/payments/connect/status")',
      "paralegal_applications",
    ].forEach((contract) => expect(source).toContain(contract));
    expect(read("frontend/assets/scripts/utils/paralegal-history.mjs")).toContain('api.get(`/api/cases/my-completed?${query}`');
    expect(read("frontend/assets/scripts/utils/received-invitations.mjs")).toContain("/api/cases/invited-to");
    const moduleUrl = require("url").pathToFileURL(path.join(root, "frontend/assets/scripts/paralegal-v2/work-view.mjs")).href;
    require("child_process").execFileSync(process.execPath, ["--input-type=module", "--eval", `import assert from 'node:assert/strict'; import { retainedApplications } from ${JSON.stringify(moduleUrl)}; const statuses=['submitted','viewed','shortlisted','accepted','rejected','withdrawn']; const records=statuses.map(status=>({status,jobId:{_id:'a'.repeat(24),title:'Retained posting',status:'closed'}})); assert.deepEqual(retainedApplications(records).map(item=>item.status),statuses);`]);
    expect(source).not.toMatch(/status\s*=\s*["'](?:pending_review|invitations_pending|work_complete)["']/);
    expect(source).toMatch(/payoutReadiness\(currentSnapshot\) !== "ready"/);
  });

  test("existing invitation, revocation, pre-engagement, dispute, block, receipt, and saved-view routes are retained", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/work-view.mjs");
    expect(source).toMatch(/`\/api\/cases\/\$\{encodeURIComponent\(id\)\}\/invite\/\$\{decision\}`/);
    expect(source).toContain('createEarlierApplicationWithdrawal({');
    expect(source).toContain('`/api/cases/${encodeURIComponent(id)}/invite/revoke`');
    expect(source).toContain('`/api/applications/${encodeURIComponent(id)}/revoke`');
    expect(source).toMatch(/pre-engagement\/respond/);
    expect(source).toMatch(/`\/api\/disputes\/\$\{encodeURIComponent\(caseId\(item\)\)\}`/);
    expect(source).toContain('api.post("/api/blocks", { caseId: caseId(item) })');
    expect(source).toContain('renderHistoryPayout(item, { api, ownerId,');
    expect(read("frontend/assets/scripts/utils/paralegal-history.mjs")).toMatch(/\/api\/payments\/receipt\/paralegal\//);
    expect(source).toMatch(/\/api\/account\/dashboard-views/);
    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/location\.reload/);
  });

  test("retains unfinished pre-engagement answers and files in memory until submission succeeds", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/work-view.mjs");
    const drafts = read("frontend/assets/scripts/utils/pre-engagement-drafts.mjs");
    expect(source).toContain('createPreEngagementDrafts({ getOwner: owner,');
    expect(source).toContain('actions.requirements.get(selection, pre)');
    expect(source).toContain('result?.success !== true');
    expect(source).toContain('actions.requirements.saved(preDraft, result.preEngagement)');
    expect(drafts).toContain('const drafts = new Map()');
    expect(drafts).toContain('`${getOwner()}:${selection.caseId}:${selection.applicationId}`');
    expect(drafts).toContain('draft.ownerId === getOwner() && drafts.get(draft.key) === draft');
    expect(drafts).toMatch(/saved\(draft, pre\) \{ if \(!isCurrent\(draft\)\) return; draft\.savedPre = pre; draft\.file = null/);
  });

  test("filters, saved views, pagination, and supported deep links remain explicit", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/work-view.mjs");
    [
      "Recent applications",
      "All applications",
      "Waiting longest",
      "Search applications",
      "All statuses",
      "All practice areas",
      "Any time",
      "Newest first",
      "Oldest first",
      "Matter name",
    ].forEach((copy) => expect(source).toContain(copy));
    expect(source).toMatch(/route\.query\.get\("highlightCase"\)/);
    expect(source).toMatch(/route\.query\.get\("applicationId"\)/);
    expect(source).toMatch(/route\.query\.get\("jobId"\)/);
    expect(source).toMatch(/const PAGE_SIZE = 3/);
  });

  test("Work styling is isolated, responsive, white-canvas, flat, and shadow-free", () => {
    const css = read("frontend/assets/styles/paralegal-v2-work.css");
    expect(css).toMatch(/^\.v2-work \{/m);
    expect(css).toMatch(/grid-template-columns: minmax\(0, \.9fr\) minmax\(0, 1\.1fr\)/);
    expect(css).toMatch(/@media \(max-width: 600px\)/);
    expect(css).toMatch(/@media \(max-width: 390px\)/);
    expect(css).toMatch(/background: var\(--v2-white\)/);
    expect(css).not.toMatch(/box-shadow/);
  });
});
