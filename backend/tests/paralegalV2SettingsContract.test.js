const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Paralegal V2 account settings contract", () => {
  test("Profile Settings is a same-document view in the persistent V2 shell", () => {
    const html = read("frontend/paralegal-v2.html");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    const router = read("frontend/assets/scripts/paralegal-v2/router.mjs");

    expect(html).toMatch(/paralegal-v2-settings\.css/);
    expect(html).toMatch(/assets\/vendor\/simplewebauthn-13\.3\.0\.js/);
    expect(app).toMatch(/createSettingsView/);
    expect(app).toMatch(/route\.name === "settings"/);
    expect(app).toMatch(/settingsView\.render/);
    expect(app).toMatch(/invalidateWork: \(\) => workView\?\.invalidate\(\)/);
    expect(router).toMatch(/name: "settings", pattern: \/\^\\\/settings/);
    expect(app).not.toMatch(/location\.(?:assign|replace)\([^)]*profile-settings/);
  });

  test("all retained settings categories use existing authoritative endpoints", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/settings-view.mjs");
    const security = read("frontend/assets/scripts/utils/account-security-api.mjs");
    const blocked = read("frontend/assets/scripts/utils/account-blocked-api.mjs");
    const closure = read("frontend/assets/scripts/utils/account-closure-api.mjs");
    [
      '/api/users/me',
      '/api/account/preferences',
      '/api/users/me/notification-prefs',
      '/api/payments/connect/status',
      '/api/uploads/profile-photo',
      '/api/uploads/paralegal-resume',
      '/api/uploads/paralegal-certificate',
      '/api/uploads/paralegal-writing-sample',
    ].forEach((contract) => expect(source).toContain(contract));
    [
      '/api/account/2fa',
      '/api/account/2fa-toggle',
      '/api/account/2fa/authenticator/setup',
      '/api/account/2fa/authenticator/confirm',
      '/api/account/2fa-backup-codes',
      '/api/account/passkeys',
      '/api/account/passkeys/registration-options',
      '/api/account/passkeys/register',
      '/api/account/sessions',
      '/api/account/sessions/revoke-others',
      '/api/account/update-password',
    ].forEach((contract) => expect(security).toContain(contract));
    expect(blocked).toContain('/api/blocks');
    ['/api/account/deactivate-status', '/api/account/deactivate', '/api/account/deactivate-result']
      .forEach((contract) => expect(closure).toContain(contract));
    for (const [category, factory] of [['security', 'createSecurityApi'], ['blocked', 'createBlockedApi'], ['closure', 'createClosureApi']]) {
      const wrapper = read(`frontend/assets/scripts/paralegal-v2/${category}-api.mjs`);
      expect(wrapper).toContain(`../utils/account-${category}-api.mjs`);
      expect(wrapper).toContain('classifySession: classifySecuritySession');
      if (category === 'security') expect(source).toContain(`${factory}({`);
      else expect(read(`frontend/assets/scripts/paralegal-v2/${category}-view.mjs`)).toContain(factory);
    }
    ['createSecurityView', 'createBlockedView', 'createClosureView'].forEach(factory => {
      expect(source).toContain(`${factory}({ id: context.ownerId }`);
    });
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  test("profile edits autosave while sensitive changes remain explicit", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/settings-view.mjs");
    const security = read("frontend/assets/scripts/paralegal-v2/security-view.mjs");
    expect(source).toMatch(/PROFILE_SAVE_DELAY_MS = 850/);
    expect(source).toMatch(/profileSaveTimer = window\.setTimeout/);
    expect(source).toContain('writeAccount("/api/users/me", "PATCH", { ...payload, expectedValues: attempt.expectedValues }, attempt.context)');
    expect(source).toContain('setProfileStatus("Saving…", "saving")');
    expect(source).toContain("const dirtyProfileFields = new Map()");
    expect(source).toContain('Object.fromEntries([...fields.keys()].map(field => [field, completePayload[field]]))');
    expect(source).toContain('attempt.fields.forEach((revision, field) =>');
    expect(source).toContain('dirtyProfileFields.forEach((_revision, field) => { normalized[field] = profile[field]; })');
    expect(source).toContain('recoverProfileSave(attempt, error)');
    expect(source).toContain('committed && dirtyProfileFields.size && !profileConflict && !unresolvedProfileSave');
    expect(source).not.toMatch(/if \(profileRevision > profileSavedRevision\) \{\s*profileSaveTimer/);
    const profileFields = source.match(/const PROFILE_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1];
    expect(profileFields).toBeTruthy();
    expect(profileFields).not.toMatch(/password|passkey|authenticator/i);
    expect(security).toContain('Current password');
    expect(security).toContain('form.addEventListener("submit"');
    expect(security).toContain('securityApi.changePassword(');
    expect(source).toContain('unavailable ? "Status unavailable" : "Action required"');
    expect(source).toContain('await startStripeOnboarding()');
    expect(source).toMatch(/results\[0\]\.status === "fulfilled"[^\n]+invalidateWork\?\.\(\)/);
    expect(source).toContain('confirmAction({');
    expect(source).toContain('onSessionLost: securitySignOut');
    expect(source).toContain('location.replace(pending ? "/account-closure.html" : "/login.html")');
    const autosave = source.slice(source.indexOf('async function saveProfile('), source.indexOf('function showProfileFieldError('));
    expect(autosave).toContain('writeAccount(');
    expect(autosave).not.toMatch(/location\.(?:reload|assign|replace)/);
  });

  test("profile completeness and visibility preserve the established requirements", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/settings-view.mjs");
    ["Bio", "Skills", "Practice areas", "Résumé", "Profile photo"].forEach((requirement) => {
      expect(source).toContain(requirement);
    });
    expect(source).toMatch(/profilePhotoStatus[^\n]+approved/);
    expect(source).toMatch(/pendingProfileImage/);
    expect(source).toContain('Your profile remains hidden until your profile photo is approved.');
  });

  test("the attorney-view preview retains the established profile and document evidence", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/settings-view.mjs");
    expect(source).toContain("user.bio || user.about");
    expect(source).toContain("list(user.specialties)");
    expect(source).toContain("list(user.preferredPracticeAreas)");
    expect(source).toContain("skills: list(user.skills)");
    expect(source).toContain('previewList("Skills", current.skills)');
    expect(source).toContain("list(user.jurisdictions)");
    expect(source).toContain('text: "Availability"');
    expect(source).toContain('text: "Joined LPC"');
    expect(source).toMatch(/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\$/);
    expect(source).toContain('profileDocumentValue(user, "resumeURL")');
    expect(source).toContain('if (!profileDocumentValue(user, "resumeURL")) missing.push("Résumé")');
    expect(source).toContain('profileDocumentValue(user, "certificateURL")');
    expect(source).toContain('profileDocumentValue(user, "writingSampleURL")');
    expect(source).toContain('href: documentReadUrl(field, value, "view")');
    expect(source).toContain('expectedOwnerId: context.ownerId, documentField: field, expectedDocumentKey: key');
    expect(source).toContain('return `/api/uploads/${endpoint}?${query}`');
  });

  test("only the current light and dark themes are exposed", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/settings-view.mjs");
    expect(source).toContain('["light", "Light"');
    expect(source).toContain('["dark", "Dark"');
    expect(source).not.toMatch(/mountain/i);
    expect(source).not.toMatch(/classic/i);
  });

  test("settings styling is responsive, isolated, flat, and uses one scroll owner", () => {
    const css = read("frontend/assets/styles/paralegal-v2-settings.css");
    const shellCss = read("frontend/assets/styles/paralegal-v2.css");
    expect(css).toMatch(/^\.v2-settings,/m);
    expect(css).toMatch(/@media \(max-width: 520px\)/);
    expect(css).toMatch(/@media \(max-width: 360px\)/);
    expect(css).not.toMatch(/box-shadow/);
    expect(shellCss).toMatch(/\.v2-view\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).not.toMatch(/overflow-y:\s*(?:auto|scroll)/);
  });

  test("the photo actions are disclosed from the photo instead of permanent edit controls", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/settings-view.mjs");
    expect(source).toContain('"aria-label": photoOf(user) ? "Open profile photo actions" : "Add profile photo"');
    expect(source).toContain('className: "v2-settings-photo-menu"');
    expect(source).toContain('action(photoOf(user) ? "Change photo" : "Add photo"');
    expect(source).toContain('action("Edit crop"');
    expect(source).toContain('action("Remove photo"');
  });
});
