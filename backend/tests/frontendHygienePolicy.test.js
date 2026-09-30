// Exercise the checker in Node, as the CLI runs it. Jest intercepts even
// createRequire and cannot load these pinned ESM Babel dependencies directly.
const { execFileSync } = require("node:child_process");
const checkerPath = require("node:path").resolve(__dirname, "../scripts/check-frontend-hygiene.js");
const checker = new Proxy({}, { get(_target, method) {
  return (...args) => JSON.parse(execFileSync(process.execPath, ["--eval", `
    const fs = require('node:fs'), checker = require(process.argv[1]);
    const result = checker[process.argv[2]](...JSON.parse(fs.readFileSync(0, 'utf8')));
    process.stdout.write(JSON.stringify(result instanceof Set ? [...result] : result));
  `, checkerPath, method], { input: JSON.stringify(args), encoding: "utf8" }));
} });
const {
  clientSessionCompatibilityIssue,
  duplicateStaticIds,
  staticDocumentRelationshipIssues,
  unsafeDynamicValueAttributes,
  unsafeErrorHtmlInterpolation,
  unsafeServerNavigation,
  unauthorizedSessionSnapshotWrite,
  persistentSensitiveBrowserDataIssue,
  unauthorizedLogoutRequest,
  destructiveBrowserStorageClear,
  persistentAttachmentDraftIssue,
  rawApiMutationIssue,
  runtimePlaceholderLinkIssue,
  silentAsyncFailureIssue,
  unboundedCssTransitionIssue,
  generatedCssWrapperIssue,
  nativeDialogIssue,
  remoteVisualAssetIssue,
  duplicatedAvatarFallbackIssue,
  collectReachableScripts,
  collectServerReachableScripts,
} = checker;

describe("frontend hygiene policy", () => {
  test("rejects retired browser-token reads and Bearer construction", () => {
    expect(clientSessionCompatibilityIssue('localStorage.getItem("lpc_token")')).toMatch(/retired/);
    expect(clientSessionCompatibilityIssue("window.getSessionToken()" )).toMatch(/retired/);
    expect(clientSessionCompatibilityIssue("const headers = { Authorization: `Bearer ${token}` };")).toMatch(
      /Bearer/
    );
  });

  test("allows deletion of retired token keys", () => {
    expect(clientSessionCompatibilityIssue('localStorage.removeItem("lpc_token")')).toBe("");
  });

  test("finds duplicate static ids without misreading embedded templates", () => {
    const source = `
      <main id="main"><section id='summary'></section><div id=summary></div></main>
      <script>const template = '<div id="summary"></div>';</script>
      <style>#summary { display: block; }</style>
    `;
    expect(duplicateStaticIds(source)).toEqual(["summary"]);
    expect(duplicateStaticIds('<main id="main"><script>const x = `id="main"`;</script></main>')).toEqual([]);
  });

  test("rejects direct error-message interpolation into HTML", () => {
    expect(unsafeErrorHtmlInterpolation('target.innerHTML = `<p>${err?.message}</p>`;')).toBe(true);
    expect(unsafeErrorHtmlInterpolation('target.innerHTML = `<p>${escapeHTML(err?.message)}</p>`;')).toBe(false);
    expect(unsafeErrorHtmlInterpolation('target.textContent = err?.message || "Unavailable";')).toBe(false);
  });

  test("rejects unescaped dynamic values in generated form controls", () => {
    expect(unsafeDynamicValueAttributes('<input value="${profile.name}">')).toEqual(["profile.name"]);
    expect(unsafeDynamicValueAttributes('<input value="${escapeHTML(profile.name)}">')).toEqual([]);
    expect(unsafeDynamicValueAttributes('querySelector(`[value="${CSS.escape(value)}"]`)')).toEqual([]);
  });

  test("rejects direct navigation to server-provided URLs", () => {
    expect(unsafeServerNavigation("window.location.href = data.url;")).toBe(true);
    expect(unsafeServerNavigation('window.open(response.connectUrl, "_blank");')).toBe(true);
    expect(unsafeServerNavigation('window.open(normalizeHttpNavigationUrl(payload.url), "_blank");')).toBe(false);
  });

  test("keeps session snapshot persistence behind the centralized projection boundary", () => {
    const write = 'localStorage.setItem("lpc_user", JSON.stringify(user));';
    expect(unauthorizedSessionSnapshotWrite(write, "/repo/frontend/assets/scripts/profile.js")).toBe(true);
    expect(
      unauthorizedSessionSnapshotWrite(write, "/repo/frontend/assets/scripts/utils/session.js")
    ).toBe(false);
    expect(unauthorizedSessionSnapshotWrite('localStorage.removeItem("lpc_user")', "/repo/frontend/login.js")).toBe(
      false
    );
  });

  test("rejects persistent storage for email, profile prefill, avatar aliases, and support behavior", () => {
    expect(persistentSensitiveBrowserDataIssue('localStorage.setItem("lastEmail", email)')).toBe(true);
    expect(persistentSensitiveBrowserDataIssue('localStorage.getItem("lpc_edit_profile_prefill")')).toBe(true);
    expect(persistentSensitiveBrowserDataIssue('sessionStorage.setItem("lpc_case_edit_prefill", payload)')).toBe(true);
    expect(persistentSensitiveBrowserDataIssue('sessionStorage.getItem("lpc_case_preview_receipt")')).toBe(true);
    expect(persistentSensitiveBrowserDataIssue('sessionStorage.setItem("lastEmail", email)')).toBe(false);
    expect(persistentSensitiveBrowserDataIssue('localStorage.removeItem("avatarURL")')).toBe(false);
  });

  test("keeps logout requests behind the CSRF-protected auth boundary", () => {
    const request = 'fetch("/api/auth/logout", { method: "POST" })';
    expect(unauthorizedLogoutRequest(request, "/repo/frontend/help.html")).toBe(true);
    expect(unauthorizedLogoutRequest(request, "/repo/frontend/assets/scripts/auth.js")).toBe(false);
    expect(unauthorizedLogoutRequest("await logout(null)", "/repo/frontend/help.js")).toBe(false);
  });

  test("rejects broad storage deletion and persistent unsent attachment blobs", () => {
    expect(destructiveBrowserStorageClear("localStorage.clear(); sessionStorage.clear();")).toBe(true);
    expect(destructiveBrowserStorageClear('localStorage.removeItem("lpc_user")')).toBe(false);
    expect(persistentAttachmentDraftIssue('indexedDB.open("lpc_case_attachments", 1)')).toBe(true);
    expect(persistentAttachmentDraftIssue("const record = { blob: entry.file };")).toBe(true);
    expect(persistentAttachmentDraftIssue('indexedDB.deleteDatabase("lpc_case_attachments")')).toBe(false);
  });

  test("keeps authenticated application mutations behind secureFetch", () => {
    const raw = 'fetch("/api/cases", { method: "POST", body: JSON.stringify(payload) })';
    expect(rawApiMutationIssue(raw, "/repo/frontend/create-case.html")).toBe(true);
    expect(rawApiMutationIssue(raw, "/repo/frontend/contact.html")).toBe(false);
    expect(rawApiMutationIssue('secureFetch("/api/cases", { method: "POST", body: payload })', "/repo/frontend/app.js")).toBe(
      false
    );
  });

  test("rejects runtime fallbacks that turn unavailable actions into dead links", () => {
    expect(runtimePlaceholderLinkIssue('title.href = ready ? viewUrl || "#" : "#";')).toBe(true);
    expect(runtimePlaceholderLinkIssue('const receiptLink = caseId ? `/api/receipt/${caseId}` : "#";')).toBe(true);
    expect(runtimePlaceholderLinkIssue('<a href="${continueHref || "#"}">Continue</a>')).toBe(true);
    expect(runtimePlaceholderLinkIssue('<a href="#funds">Open payments</a>')).toBe(false);
    expect(runtimePlaceholderLinkIssue('const href = caseId ? `/case/${caseId}` : "";')).toBe(false);
    expect(runtimePlaceholderLinkIssue('function downloadUrl(value) { if (!value) return "#"; }')).toBe(true);
  });

  test("rejects silent asynchronous UI failures outside non-recursive telemetry delivery", () => {
    const source = "saveChanges().catch(() => {});";
    expect(silentAsyncFailureIssue(source, "/repo/frontend/assets/scripts/profile.js")).toBe(true);
    expect(
      silentAsyncFailureIssue(source, "/repo/frontend/assets/scripts/web-vitals-rum.js")
    ).toBe(false);
    expect(
      silentAsyncFailureIssue(
        'saveChanges().catch((error) => console.error("Save rejected", error));',
        "/repo/frontend/assets/scripts/profile.js"
      )
    ).toBe(false);
  });

  test("rejects transition-all declarations that animate unrelated layout and paint properties", () => {
    expect(unboundedCssTransitionIssue(".button { transition: all 200ms ease; }")).toBe(true);
    expect(unboundedCssTransitionIssue(".button { transition-property: all; }")).toBe(true);
    expect(unboundedCssTransitionIssue(".button { transition: color 200ms ease, border-color 200ms ease; }")).toBe(false);
  });

  test("rejects generated-response wrappers and non-CSS comments in stylesheets", () => {
    const cssPath = "/repo/frontend/assets/styles/styles.css";
    expect(generatedCssWrapperIssue("Absolutely—here is the replacement.\n```css\nbody {}", cssPath)).toBe(true);
    expect(generatedCssWrapperIssue("/// header ///\nheader {}", cssPath)).toBe(true);
    expect(generatedCssWrapperIssue("/* Header */\nheader {}", cssPath)).toBe(false);
    expect(generatedCssWrapperIssue("Absolutely fine", "/repo/frontend/assets/scripts/app.js")).toBe(false);
  });

  test("rejects every native browser dialog spelling", () => {
    expect(nativeDialogIssue("window.alert('No')")).toBe(true);
    expect(nativeDialogIssue("confirm('Delete?')")).toBe(true);
    expect(nativeDialogIssue("window.prompt('Name')")).toBe(true);
    expect(nativeDialogIssue("dialogs.confirm(options)")).toBe(false);
    expect(nativeDialogIssue("globalThis['confirm']('Delete?')")).toBe(true);
    expect(nativeDialogIssue("window?.prompt?.('Name')")).toBe(true);
  });

  test("distinguishes lexical product confirmations from native dialogs", () => {
    expect(nativeDialogIssue("function confirm() {} confirm();")).toBe(false);
    expect(nativeDialogIssue("import { confirm } from './dialogs.mjs'; confirm();")).toBe(false);
    expect(nativeDialogIssue("function run(confirm) { confirm(); } confirm('Outside');")).toBe(true);
    expect(nativeDialogIssue("function run(window) { window.confirm(); }")).toBe(false);
    expect(nativeDialogIssue("const html = '<script>confirm(1)</script>';" )).toBe(false);
    expect(nativeDialogIssue('<html><script type="application/json">{"copy":"confirm(1)"}</script><script>window.confirm(1)</script></html>', '/repo/frontend/test.html')).toBe(true);
    expect(nativeDialogIssue('<script type="application/json">{"copy":"confirm(1)"}</script>', '/repo/frontend/test.html')).toBe(false);
  });

  test("rejects mutable remote visual assets but permits functional vendor scripts", () => {
    expect(remoteVisualAssetIssue('<img src="https://cdn.example.com/avatar.png">', "/repo/frontend/index.html")).toBe(true);
    expect(remoteVisualAssetIssue('.hero { background: url("//cdn.example.com/hero.jpg"); }', "/repo/frontend/styles.css")).toBe(true);
    expect(remoteVisualAssetIssue('<script src="https://js.stripe.com/v3/"></script>', "/repo/frontend/payments.html")).toBe(false);
    expect(remoteVisualAssetIssue('.hero { background: url("../hero.jpg"); }', "/repo/frontend/styles.css")).toBe(false);
  });

  test("rejects duplicated generated avatar fallbacks", () => {
    expect(duplicatedAvatarFallbackIssue("const DEFAULT_AVATAR = `data:image/svg+xml,<svg></svg>`;")).toBe(true);
    expect(duplicatedAvatarFallbackIssue("function buildAvatar() { return `data:image/svg+xml,${svg}`; }")).toBe(true);
    expect(duplicatedAvatarFallbackIssue('const DEFAULT_AVATAR = "/assets/avatar-placeholder.svg";')).toBe(false);
  });

  test("rejects broken static navigation and accessibility relationships", () => {
    const htmlPath = require("path").resolve(__dirname, "../../frontend/index.html");
    const broken = `
      <main id="main">
        <a href="#missing">Broken fragment</a>
        <a href="missing-page.html">Broken page</a>
        <a href="javascript:alert(1)">Unsafe</a>
        <label for="missingInput">Name</label>
        <button aria-controls="missingPanel">Open</button>
      </main>
    `;
    expect(staticDocumentRelationshipIssues(htmlPath, broken)).toEqual(
      expect.arrayContaining([
        "contains a javascript: link destination",
        "references missing fragment #missing",
        "references missing navigation target missing-page.html",
        "label references missing id missingInput",
        "ARIA relationship references missing id missingPanel",
      ])
    );
  });

  test("allows valid local pages, fragments, labels, and ARIA relationships", () => {
    const htmlPath = require("path").resolve(__dirname, "../../frontend/index.html");
    const valid = `
      <a href="login.html">Log in</a>
      <a href="#main">Skip</a>
      <main id="main">
        <label for="email">Email</label>
        <input id="email" aria-describedby="emailHelp">
        <span id="emailHelp">Use your work email.</span>
      </main>
    `;
    expect(staticDocumentRelationshipIssues(htmlPath, valid)).toEqual([]);
  });

  test("validates declared application routes without accepting arbitrary fragments", () => {
    const htmlPath = require("path").resolve(__dirname, "../../frontend/index.html");
    const source = '<a href="#/home">Home</a><a data-view="/home?view=work" href="#/home?view=work">Work</a><button data-section="finance" type="button">Finance</button><a href="#finance">Finance</a>';
    expect(staticDocumentRelationshipIssues(htmlPath, source)).toEqual([]);
    expect(staticDocumentRelationshipIssues(htmlPath, source + '<a href="#/missing">Missing route</a><a href="#missing">Missing section</a>')).toEqual(expect.arrayContaining(['references missing fragment #/missing', 'references missing fragment #missing']));
  });

  test("validates V2 links against the mounted application's real route parser", () => {
    const path = require('node:path');
    for (const [role, route] of [['attorney', '/matters/new'], ['paralegal', '/conversations']]) {
      const htmlPath = path.resolve(__dirname, `../../frontend/${role}-v2.html`);
      const script = `<script type="module" src="assets/scripts/${role}-v2/app.mjs?v=example"></script>`;
      expect(staticDocumentRelationshipIssues(htmlPath, script + `<a href="#${route}">Open</a>`)).toEqual([]);
      expect(staticDocumentRelationshipIssues(htmlPath, script + '<a href="#/missing-route">Missing</a>')).toContain('references missing fragment #/missing-route');
      expect(staticDocumentRelationshipIssues(htmlPath, `<a href="#${route}">Unmounted</a>`)).toContain(`references missing fragment #${route}`);
      expect(staticDocumentRelationshipIssues(path.resolve(__dirname, '../../frontend/index.html'), script + `<a href="#${route}">Wrong document</a>`)).toContain(`references missing fragment #${route}`);
    }
  });

  test("counts real server imports without treating unused frontend modules as reachable", () => {
    const path = require('node:path');
    const files = collectServerReachableScripts();
    expect(files).toContain(path.resolve(__dirname, '../../frontend/assets/scripts/attorney-v2/draft-profile.mjs'));
    expect(files).not.toContain(path.resolve(__dirname, '../../frontend/assets/scripts/attorney-v2/draft-assistant.mjs'));
  });

  test("follows inline imports and consumed import-map overrides in their own document", () => {
    const fs = require("fs"), path = require("path");
    const directory = fs.mkdtempSync(path.resolve(__dirname, "../../frontend/assets/scripts/hygiene-fixture-"));
    try {
      const base = '/assets/scripts/' + path.basename(directory);
      fs.writeFileSync(path.join(directory, 'entry.mjs'), "import './original.mjs';");
      for (const name of ['original', 'mapped', 'unused']) fs.writeFileSync(path.join(directory, name + '.mjs'), 'export const available = true;');
      const mapped = path.join(directory, 'mapped.html'), ordinary = path.join(directory, 'ordinary.html');
      fs.writeFileSync(mapped, `<script type="importmap">${JSON.stringify({ imports: { [base + '/original.mjs']: base + '/mapped.mjs', 'unused-dependency': base + '/unused.mjs' } })}</script><script type="module">import './entry.mjs';</script>`);
      fs.writeFileSync(ordinary, '<script type="module" src="entry.mjs"></script>');
      expect([...collectReachableScripts([mapped])].sort()).toEqual(['entry.mjs', 'mapped.mjs'].map(name => path.join(directory, name)).sort());
      expect([...collectReachableScripts([mapped, ordinary])].sort()).toEqual(['entry.mjs', 'mapped.mjs', 'original.mjs'].map(name => path.join(directory, name)).sort());
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
