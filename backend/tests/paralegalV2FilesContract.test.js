const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Paralegal V2 Phase 8B Matter files", () => {
  test("uses only the existing participant file list, upload, scan-status, and download authorities", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");
    expect(controller).toMatch(/api\.get\(`\/api\/uploads\/case\/\$\{encodeURIComponent\(state\.matterId\)\}\?presentation=matter`/);
    expect(controller).toMatch(/api\.upload\(`\/api\/uploads\/case\/\$\{encodeURIComponent\(state\.matterId\)\}\?presentation=matter`, formData/);
    expect(controller).toMatch(/\/security-status`/);
    expect(controller).toMatch(/\/download`/);
    expect(controller).toMatch(/\?preview=true/);
    expect(controller).not.toMatch(/method:\s*["'](?:PUT|PATCH|DELETE)["']|api\.(?:request|delete)|complete Matter/i);
    expect(controller).not.toContain("/revision-request");
    expect(controller).not.toContain("/replace`");
  });

  test("preserves server file validation and never fabricates an authoritative uploaded record", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");
    const upload = controller.indexOf("await api.upload(`/api/uploads/case/${encodeURIComponent(state.matterId)}?presentation=matter`");
    const refresh = controller.indexOf("await refresh(state)", upload);
    expect(upload).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(upload);
    expect(controller).toMatch(/MAX_FILE_BYTES = 20 \* 1024 \* 1024/);
    expect(controller).toMatch(/formData\.append\("file", entry\.file\)/);
    expect(controller).toMatch(/formData\.append\("clientUploadId", entry\.clientUploadId\)/);
    expect(controller).toMatch(/multiple: ""/);
    expect(controller).toMatch(/Math\.min\(3, entries\.length\)/);
    expect(controller).toMatch(/const drafts = new Map\(\)/);
    expect(controller).not.toMatch(/optimistic|localStorage|sessionStorage|indexedDB|innerHTML/);
    expect(controller).toMatch(/onProgress\(value\)/);
    expect(controller).toMatch(/data-v2-file-cancel/);
    expect(controller).toMatch(/data-v2-file-retry/);
  });

  test("fails closed for stale access and synchronizes server-confirmed document changes", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");
    expect(controller).toMatch(/error\.status === 401[\s\S]*onSessionLost\?\.\(\)/);
    expect(controller).toMatch(/error\.status === 403[\s\S]*lockPanel[\s\S]*onAccessLost/);
    expect(controller).toMatch(/source\.addEventListener\("documents", scheduleRefresh\)/);
    expect(controller).toMatch(/source\.addEventListener\("open", \(\) => \{[\s\S]*scheduleRefresh\(\)/);
    expect(controller).toMatch(/new BroadcastChannel\(`lpc-v2-matter-files:/);
    expect(controller).toMatch(/POLL_INTERVAL_MS = 15_000/);
    expect(controller).toMatch(/SECURITY_RECHECK_DELAYS_MS = Object\.freeze\(\[1_000, 3_000, 8_000, 15_000\]\)/);
    expect(controller).toMatch(/schedulePendingSecurityChecks\(state\)/);
    expect(controller).toMatch(/window\.addEventListener\("online"/);
  });

  test("leaves destructive or attorney review mutations out of the paralegal file surface", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-files.mjs");
    expect(controller).not.toMatch(/data-v2-file-delete|Delete file|Request revisions|Approve submission/);
  });

  test("keeps the file workspace contained and shadow-free", () => {
    const css = read("frontend/assets/styles/paralegal-v2-matter.css");
    expect(css).toMatch(/\.v2-matter-file-form\s*\{/);
    expect(css).toMatch(/\.v2-matter-file-picker-row\s*\{/);
    expect(css).toMatch(/@container v2-matter/);
    expect(css).not.toMatch(/box-shadow/);
  });
});
