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
} = require("../scripts/check-frontend-hygiene");

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
});
