const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Paralegal V2 Phase 8A Matter messaging", () => {
  test("connects text, existing authorized file exchange, and read acknowledgement", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-messages.mjs");
    expect(controller).toMatch(/clientMessageId: state\.pendingMessage\.id/);
    expect(controller).toMatch(/api\.post\(`\/api\/messages\/\$\{encodeURIComponent\(state\.matterId\)\}\/read`, \{ upTo \}\)/);
    expect(controller).toMatch(/api\.upload\(`\/api\/uploads\/case\/\$\{encodeURIComponent\(state\.matterId\)\}\?presentation=matter`, formData/);
    expect(controller).toMatch(/formData\.append\("file", entry\.file\)/);
    expect(controller).toMatch(/formData\.append\("clientUploadId", entry\.clientUploadId\)/);
    expect(controller).toMatch(/multiple: ""/);
    expect(controller).toMatch(/addEventListener\("drop"/);
    expect(controller).toMatch(/maxlength: "2000"/);
    // Inline mutation ownership and failure behavior are exercised by conversations-approved.spec.js.

  });

  test("renders a pending delivery immediately, then reconciles server-confirmed state while preserving per-Matter drafts", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-messages.mjs");
    const post = controller.indexOf("await api.post(`/api/messages/${encodeURIComponent(state.matterId)}`, {");
    const clear = controller.indexOf('input.value = ""', post);
    const refresh = controller.indexOf("await refresh(state)", clear);
    expect(post).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(post);
    expect(refresh).toBeGreaterThan(clear);
    expect(controller).toMatch(/pendingDelivery/);
    expect(controller).toMatch(/Sending…/);
    expect(controller).toMatch(/const sent = await api\.post/);
    expect(controller).toMatch(/state\.pendingDelivery = null/);
    expect(controller).not.toMatch(/innerHTML|insertAdjacentHTML/);
    expect(controller).toMatch(/const drafts = new Map\(\)/);
    expect(controller).toMatch(/const readWatermarks = new Map\(\)/);
    expect(controller).toMatch(/readWatermarks\.get\(matterId\) === upTo/);
    expect(controller).toMatch(/const draftKey = `\$\{viewerId\}:\$\{String\(matterId \|\| ""\)\}`/);
    expect(controller).toMatch(/saveDraft\(current\)/);
  });

  test("revalidates authentication and authorization failures without caching Matter content", () => {
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-messages.mjs");
    expect(controller).toMatch(/error\.status === 401[\s\S]*onSessionLost\?\.\(\)/);
    expect(controller).toMatch(/\[403, 404\]\.includes\(error\.status\)[\s\S]*lockComposer[\s\S]*onAccessLost/);
    expect(controller).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  test("synchronizes the mounted conversation without remounting the persistent shell", () => {
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const controller = read("frontend/assets/scripts/paralegal-v2/matter-messages.mjs");
    expect(app).toMatch(/matterView\.afterMount\(view\)/);
    expect(controller).toMatch(/new EventSource\(`\/api\/cases\/\$\{encodeURIComponent\(state\.matterId\)\}\/stream`\)/);
    expect(controller).toMatch(/source\.addEventListener\("messages", scheduleRefresh\)/);
    expect(controller).toMatch(/source\.addEventListener\("documents", scheduleRefresh\)/);
    expect(controller).toMatch(/new BroadcastChannel\(`lpc-v2-matter-messages:/);
    expect(controller).toMatch(/POLL_INTERVAL_MS = 15_000/);
    expect(controller).toMatch(/content\.replaceChildren/);
  });

  test("keeps the composer visually scoped while completed access remains server-authoritative", () => {
    const css = read("frontend/assets/styles/paralegal-v2-matter.css");
    expect(css).toMatch(/\.v2-matter-message-form\s*\{/);
    expect(css).toMatch(/@container v2-matter/);
    expect(css).not.toMatch(/box-shadow/);
  });
});
