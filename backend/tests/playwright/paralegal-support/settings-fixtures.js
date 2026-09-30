const { expect } = require("playwright/test");
const { installNotificationReads } = require("./notification-fixtures");
const USER_ID = "64b000000000000000000001";

async function json(route, payload, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

async function installSettingsProjection(page, overrides = {}) {
  const state = overrides.state || {
    user: {
      _id: USER_ID,
      firstName: "Dana",
      lastName: "Young",
      email: "dana@example.com",
      phoneNumber: "212-555-0142",
      role: "paralegal",
      status: "approved",
      createdAt: "2024-08-14T13:00:00.000Z",
      updatedAt: "2026-09-02T13:00:00.000Z",
      profileImage: "/assets/avatar-placeholder.svg",
      profilePhotoStatus: "approved",
      profilePhotoRevision: "a".repeat(64),
      bio: "Senior litigation paralegal focused on discovery and trial preparation.",
      about: "", specialties: [], jurisdictions: [], pendingEmail: "",
      practiceAreas: ["Litigation"],
      stateExperience: ["NY"],
      skills: ["Discovery", "Legal research"],
      bestFor: ["Document-intensive matters"],
      yearsExperience: 8,
      experience: [{ title: "Senior paralegal", years: "2019–present", description: "Litigation support." }],
      education: [{ school: "City College", degree: "B.A.", fieldOfStudy: "Legal Studies" }],
      languages: [{ name: "English", proficiency: "Native" }],
      resumeURL: `users/${USER_ID}/resume/current.pdf`,
      certificateURL: `users/${USER_ID}/certificate/current.pdf`,
      writingSampleURL: `users/${USER_ID}/writing-sample/current.pdf`,
      notificationPrefs: { email: true, emailMessages: true, emailCase: true },
      preferences: { theme: "light", fontSize: "md", hideProfile: false },
      onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true },
      location: "NY",
      availability: "Unavailable",
      availabilityDetails: { status: "unavailable", nextAvailable: "2026-09-21" },
      ...(overrides.user || {}),
    },
    preferences: {
      email: true,
      theme: "light",
      fontSize: "md",
      hideProfile: false,
      state: "NY",
      ...(overrides.preferences || {}),
    },
    blocks: overrides.blocks || [{ blockedId: "64b000000000000000000777", name: "Taylor Reed", role: "attorney", createdAt: "2026-08-18T14:00:00.000Z" }],
    profilePatches: [],
    preferencePosts: [],
    notificationPatches: [],
    securityMutations: [],
    securityReads: 0,
  };

  // The managed login and these synthetic profile records have different IDs.
  // Do not turn every form test into an unintended account-replacement test.
  // Keep this profile's subsequent saved appearance/drafts across reloads.
  if (!overrides.preserveCachedIdentity) await page.addInitScript(ownerId => {
    try {
      const cached = JSON.parse(localStorage.getItem('lpc_user') || 'null');
      if (cached && String(cached._id || cached.id || '') !== ownerId) localStorage.removeItem('lpc_user');
    } catch { localStorage.removeItem('lpc_user'); }
  }, state.user.id || state.user._id);
  await installNotificationReads(page, { ownerId: () => state.user.id || state.user._id });
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "synthetic-csrf" }));
  await page.route("**/api/auth/workspace-release", route => json(route, { workspace: { schemaVersion: 1, ownerId: state.user.id || state.user._id, role: "paralegal", revision: 1, version: "v2", defaultDestination: "/paralegal-v2.html#/home" } }));
  await page.route("**/api/auth/me", (route) => json(route, { user: state.user }));
  await page.route("**/api/users/me/onboarding", async (route) => {
    if (route.request().method() === "PATCH") {
      state.user.onboarding = { ...state.user.onboarding, ...route.request().postDataJSON() };
    }
    return json(route, { onboarding: state.user.onboarding });
  });
  await page.route(/\/api\/users\/me(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "PATCH") {
      const { expectedOwnerId, expectedValues, expectedPhotoRevision, ...patch } = route.request().postDataJSON();
      expect(expectedOwnerId).toBe(USER_ID);
      expect(expectedValues).toBeTruthy();
      state.profilePatches.push(patch);
      if (overrides.rejectProfilePatches) {
        return json(route, { error: "Profile save temporarily unavailable." }, 503);
      }
      state.user = {
        ...state.user,
        ...patch,
        skills: patch.highlightedSkills || patch.skills || state.user.skills,
        updatedAt: "2026-09-02T14:00:00.000Z",
      };
      return json(route, state.user);
    }
    return json(route, state.user);
  });
  await page.route(/\/api\/account\/preferences(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      const { expectedOwnerId, expectedValues, expectedPhotoRevision, ...patch } = route.request().postDataJSON();
      expect(expectedOwnerId).toBe(USER_ID);
      expect(expectedValues).toBeTruthy();
      state.preferencePosts.push(patch);
      state.preferences = { ...state.preferences, ...patch };
      state.user.preferences = { ...state.user.preferences, ...patch };
      if (Object.prototype.hasOwnProperty.call(patch, "state")) state.user.location = patch.state;
      return json(route, { success: true, preferences: state.preferences, state: state.preferences.state });
    }
    return json(route, state.preferences);
  });
  await page.route("**/api/users/me/notification-prefs", async (route) => {
    const { expectedOwnerId, expectedValues, expectedPhotoRevision, ...patch } = route.request().postDataJSON();
      expect(expectedOwnerId).toBe(USER_ID);
      expect(expectedValues).toBeTruthy();
    state.notificationPatches.push(patch);
    state.user.notificationPrefs = { ...state.user.notificationPrefs, ...patch };
    return json(route, { notificationPrefs: state.user.notificationPrefs });
  });

  const securityGet = payload => async route => {
    expect(route.request().method()).toBe('GET');
    expect(new URL(route.request().url()).searchParams.get('expectedOwnerId')).toBe(USER_ID);
    state.securityReads += 1;
    return json(route, payload);
  };
  const readPath = path => url => url.pathname === path;
  const revision = 'c'.repeat(64);
  await page.route('**/api/payments/connect/status', route => { state.securityReads += 1; return json(route, { readiness: { ready: true, accountPresent: true, evidenceState: 'verified' } }); });
  await page.route(readPath('/api/account/2fa'), securityGet({ enabled: false, method: 'email', hasBackupCodes: false, sessionManaged: true, securityRevision: revision }));
  await page.route(readPath('/api/account/passkeys'), securityGet({ passkeys: [] }));
  const currentSession = { id: 'session-current', current: true, ua: 'Chrome Mac OS', ip: '192.0.2.1', lastSeenAt: '2026-09-02T13:00:00.000Z' };
  await page.route(readPath('/api/account/sessions'), securityGet({ currentSession, nextCursor: null, total: 2, sessions: [currentSession, { id: 'session-other', current: false, ua: 'Safari iPhone', ip: '192.0.2.2', lastSeenAt: '2026-09-01T13:00:00.000Z' }] }));
  const blocks = () => state.blocks.map(item => ({ reason: '', revision, ...item }));
  await page.route(readPath('/api/blocks'), route => securityGet({ items: blocks(), total: state.blocks.length, nextCursor: null })(route));
  await page.route(readPath('/api/account/deactivate-status'), securityGet({ ownerId: USER_ID, canDeactivate: true, blockers: [], closureRevision: revision, resultProof: 'synthetic.' + revision, proofExpiresAt: '2027-09-02T14:00:00.000Z' }));
  await page.route(url => /^\/api\/blocks\/[a-f0-9]{24}$/.test(url.pathname), async route => {
    const blockedId = new URL(route.request().url()).pathname.split('/').at(-1);
    const item = blocks().find(item => item.blockedId === blockedId);
    if (route.request().method() === 'GET') return securityGet({ blockedId, blocked: Boolean(item), revision: item?.revision || null })(route);
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().postDataJSON()).toEqual({ expectedOwnerId: USER_ID, expectedBlockRevision: item.revision });
    state.securityMutations.push({ method: route.request().method(), url: route.request().url() });
    state.blocks = state.blocks.filter(item => item.blockedId !== blockedId);
    return json(route, { ok: true, blocked: false, blockedId });
  });
  await page.route('**/api/account/update-password', async route => {
    state.securityMutations.push({ method: route.request().method(), url: route.request().url() });
    return json(route, { ok: true, reauthenticationRequired: true });
  });
  return state;
}

module.exports = { USER_ID, json, installSettingsProjection };
