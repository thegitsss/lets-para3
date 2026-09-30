const fs = require("fs");
const path = require("path");

describe("profile settings preferences save regression", () => {
  test("account theme normalization exposes only the current appearances", () => {
    const {
      SUPPORTED_ACCOUNT_THEMES,
      normalizeAccountTheme,
      parseAccountTheme,
    } = require("../utils/accountPreferences");

    expect(SUPPORTED_ACCOUNT_THEMES).toEqual(["light", "dark", "system"]);
    for (const theme of SUPPORTED_ACCOUNT_THEMES) {
      expect(parseAccountTheme(theme)).toBe(theme);
      expect(normalizeAccountTheme(theme)).toBe(theme);
    }
    expect(parseAccountTheme(" DARK ")).toBe("dark");
    expect(parseAccountTheme("unsupported")).toBeNull();
    expect(normalizeAccountTheme("unsupported")).toBe("light");
    expect(normalizeAccountTheme("retired-dashboard-dark")).toBe("dark");
    expect(normalizeAccountTheme("unsupported", "dark")).toBe("dark");
  });

  test("preferences save immediately through a sequenced account-preference writer", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"),
      "utf8"
    );

    expect(source).toContain('secureFetch("/api/account/preferences", {');
    expect(source).toContain("let preferenceMutationQueue = Promise.resolve()");
    expect(source).toContain("preferenceMutationQueue.then(operation)");
    expect(source).toContain("queueAccountPreferenceWrite({ state }");
    expect(source).toContain("theme: normalizeSelectableTheme");
    expect(source).not.toContain("LPC-INCIDENT-TEST: intentional preferences save regression marker.");
    expect(source).toContain("Could not save. Your previous setting has been restored.");
    expect(source).toContain("loadPreferences({ preserveStatus: true })");
    expect(source).toContain('if (!preserveStatus) setPreferencesSaveStatus("Changes save automatically.", "idle")');
    expect(source).not.toContain('const prefBtn = document.getElementById("savePreferencesBtn")');
  });

  test("retired themes cannot be selected or emitted by current account surfaces", () => {
    const html = fs.readFileSync(path.join(__dirname, "../../frontend/profile-settings.html"), "utf8");
    const route = fs.readFileSync(path.join(__dirname, "../routes/account.js"), "utf8");
    const preferences = fs.readFileSync(path.join(__dirname, "../utils/accountPreferences.js"), "utf8");
    const session = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/utils/session.js"),
      "utf8"
    );
    const authRoute = fs.readFileSync(path.join(__dirname, "../routes/auth.js"), "utf8");
    const usersRoute = fs.readFileSync(path.join(__dirname, "../routes/users.js"), "utf8");

    expect((html.match(/data-theme-preview=/g) || [])).toHaveLength(2);
    expect(html).toContain('data-theme-preview="light"');
    expect(html).toContain('data-theme-preview="dark"');
    expect(preferences).toContain('"light"');
    expect(preferences).toContain('"dark"');
    expect(route).toContain("parseAccountTheme(theme)");
    expect(session).toContain('const VALID_THEMES = ["light", "dark"]');
    expect(session).toContain('return [`theme-${theme}`]');
    expect(authRoute).toContain("theme: normalizeAccountTheme(");
    expect(usersRoute).toContain("theme: normalizeAccountTheme(");
  });

  test("restored profile drafts expire and remain tied to the server profile they extend", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"),
      "utf8"
    );

    expect(source).toContain("const PROFILE_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000");
    expect(source).toContain("serverFingerprint: getProfileSettingsServerFingerprint()");
    expect(source).toContain("draftServerFingerprint !== currentServerFingerprint");
    expect(source).toMatch(/if \(draft\) \{[\s\S]{0,120}setParalegalProfileDirty\(true\)/);
    expect(source).not.toMatch(/document\.addEventListener\(\s*"click",[\s\S]{0,240}scheduleProfileSettingsDraftPersist/);
  });

  test("programmatic profile editors use the same dirty-state authority as direct inputs", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"),
      "utf8"
    );

    expect(source).toContain("function markParalegalProfileChanged()");
    expect((source.match(/markParalegalProfileChanged\(\)/g) || []).length).toBeGreaterThanOrEqual(10);
    expect(source).toContain('profileSaveStatus.textContent = paralegalProfileDirty ? "Unsaved changes" : "All changes saved."');
  });

  test("attorney save normalizes URL fields and preserves API errors", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"),
      "utf8"
    );

    expect(source).toContain("function normalizeHttpUrlInput");
    expect(source).toContain('requiredHost: "linkedin.com"');
    expect(source).toContain('showToast(err?.message || "Unable to save profile right now.", "err")');
  });

  test("paralegal profile hydration is single-pass and escapes stored editor values", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"),
      "utf8"
    );
    const loadSettings = source.match(/async function loadSettings\(\) \{[\s\S]*?\n\}\n\nfunction hydrateProfileForm/);
    expect(loadSettings).toBeTruthy();
    expect((loadSettings[0].match(/bootstrapProfileSettings\(user\)/g) || [])).toHaveLength(1);
    expect(loadSettings[0]).not.toContain("try { await loadBio(user);");
    expect(source).toContain('value="${escapeHTML(ed.degree || "")}"');
    expect(source).toContain('value="${escapeHTML(user.linkedInURL || "")}"');
    expect(source).toContain('${escapeHTML(user.bio || "")}');
    expect(source).not.toContain("consumeEditPrefillUser");
    expect(source).not.toContain("const cachedUser = prefill || getCachedUser()");
  });

  test("profile preview cannot replace the signed-in cache with another member's profile", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-paralegal.js"),
      "utf8"
    );

    expect(source).not.toContain("cacheProfileForEditing");
    expect(source).not.toContain("lpc_edit_profile_prefill");
    expect(source).not.toContain('localStorage.setItem("lpc_user"');
    expect(source).toContain('state.viewerRole === "paralegal" && state.viewerId && profileId && state.viewerId === profileId');
    expect(source).toContain("if (!isOwner) return;");
  });

  test("attorney onboarding payment copy points to billing instead of Stripe setup jargon", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"),
      "utf8"
    );

    expect(source).toContain("Add a payment method so you can fund matters when you're ready.");
    expect(source).toContain('"Add Payment Method"');
    expect(source).toContain('window.location.href = "dashboard-attorney.html#funds"');
    expect(source).not.toContain("Go to Billing & Add Card");
    expect(source).not.toContain("Set up payments for Stripe.");
    expect(source).not.toContain('"Set Up Payments"');
  });

  test("attorney onboarding step one treats saved professional profile details as complete", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/attorney-tabs.js"),
      "utf8"
    );
    const match = source.match(/function isAttorneyProfileComplete\(user = \{\}\) \{[\s\S]*?\n\}/);

    expect(match).toBeTruthy();

    const isAttorneyProfileComplete = new Function(`${match[0]}; return isAttorneyProfileComplete;`)();

    expect(isAttorneyProfileComplete({ lawFirm: "Sider Legal" })).toBe(true);
    expect(isAttorneyProfileComplete({ firmWebsite: "https://example.com" })).toBe(true);
    expect(isAttorneyProfileComplete({ linkedInURL: "https://linkedin.com/in/example" })).toBe(true);
    expect(isAttorneyProfileComplete({ practiceDescription: "Civil litigation support." })).toBe(true);
    expect(isAttorneyProfileComplete({ practiceAreas: ["Litigation"] })).toBe(true);
    expect(isAttorneyProfileComplete({ publications: ["Panel on discovery practice"] })).toBe(true);
    expect(isAttorneyProfileComplete({})).toBe(false);
    expect(isAttorneyProfileComplete({ practiceAreas: ["   "], publications: [""] })).toBe(false);
  });
});
