const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Paralegal V2 Phase 8D submissions and revisions", () => {
  test("preserves the exact existing CaseFile lifecycle states", () => {
    const model = read("backend/models/CaseFile.js");
    const cases = read("backend/routes/cases.js");
    expect(model).toMatch(/enum:\s*\["pending_review",\s*"approved",\s*"attorney_revision"\]/);
    expect(cases).toMatch(/const defaultStatus = "pending_review"/);
    expect(cases).toMatch(/status === "approved"[\s\S]*file\.approvedAt = now/);
    expect(cases).toMatch(/Only the Matter attorney can update file status/);
    expect(cases).toMatch(/Only the attorney can request revisions/);
    expect(cases).toMatch(/Only the attorney can replace a document/);
  });

  test("exposes revision evidence through the minimized Matter file projection", () => {
    const uploads = read("backend/routes/uploads.js");
    const projection = uploads.slice(uploads.indexOf("function serializeMatterCaseFile"));
    expect(projection).toMatch(/revisionNotes:\s*file\.revisionNotes/);
    expect(projection).toMatch(/revisionRequestedAt:\s*file\.revisionRequestedAt/);
    expect(projection).toMatch(/approvedAt:\s*file\.approvedAt/);
    expect(projection).not.toMatch(/storageKey:\s*file\.storageKey|key:\s*file\.key|userId:\s*file\.userId/);
  });

  test("keeps attorney decisions out of the paralegal client", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");
    expect(controller).toMatch(/Submitted for review/);
    expect(controller).toMatch(/Revisions requested/);
    // Review labels and their rendered count are covered by v2-submissions.spec.js.
    // This guard covers the absence of attorney mutation authority in this client.
    expect(controller).not.toMatch(/api\.(?:request|delete)|Request revisions|Approve submission/);
    expect(controller).not.toContain("/revision-request");
    expect(controller).not.toContain("/replace`");
    expect(controller).not.toMatch(/file\.status\s*=\s*["'](?:pending_review|approved|attorney_revision)["']/);
  });

  test("requires explicit confirmation and refetches server authority after submission", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");
    expect(controller).toMatch(/data-v2-file-confirmation/);
    expect(controller).toMatch(/Submit this file\?/);
    expect(controller).toMatch(/dialog\.close\("confirm"\)[\s\S]*onConfirm\?\.\(\)/);
    const upload = controller.indexOf("await api.upload(`/api/uploads/case/${encodeURIComponent(state.matterId)}?presentation=matter`");
    const refresh = controller.indexOf("await refresh(state)", upload);
    expect(upload).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(upload);
    expect(controller).toMatch(/formData\.append\("clientUploadId", entry\.clientUploadId\)/);
    expect(controller).toMatch(/Math\.min\(3, entries\.length\)/);
    expect(controller).toMatch(/state\.selectedFiles = state\.selectedFiles\.filter\(\(entry\) => entry\.status !== "uploaded"\)/);
    expect(controller).toMatch(/if \(state\.uploading \|\| state !== current \|\| !state\.writable\) return/);
  });

  test("preserves historical read-only evidence and cross-surface synchronization", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");
    const view = read("frontend/assets/scripts/paralegal-v2/matter-view.mjs");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    // Explicit revision linkage is exercised by the upload lifecycle and browser journeys.
    expect(view).toMatch(/filesWritable: !historical/);
    expect(controller).toMatch(/new BroadcastChannel\("lpc-v2-files"\)/);
    expect(app).toMatch(/new BroadcastChannel\("lpc-v2-files"\)[\s\S]*homeView\.invalidate\(\)[\s\S]*scheduleRouteRefresh\(\["home"\]/);
    // The Work invalidator now accepts download-preservation options. Keep the
    // invalidation guard without requiring the earlier zero-argument call.
    expect(app).toMatch(/function invalidateAuthoritativeViews\([^)]*\)[\s\S]*homeView\.invalidate\(\)[\s\S]*browseView\.invalidate\(\)[\s\S]*workView\.invalidate\(/);
    expect(controller).toMatch(/source\.addEventListener\("documents", scheduleRefresh\)/);
  });

  test("keeps the submission and revision treatment flat and shadow-free", () => {
    const css = read("frontend/assets/styles/paralegal-v2-matter.css");
    expect(css).toMatch(/\.v2-matter-revision-request\s*\{/);
    expect(css).toMatch(/\.v2-matter-dialog\s*\{/);
    expect(css).toMatch(/\.v2-matter-submission-state/);
    expect(css).not.toMatch(/box-shadow/);
  });
});
