const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const { USER_ID, json, installSettingsProjection } = require("./settings-fixtures");

for (const retained of [false, true]) test(`security refresh failure describes ${retained ? 'retained rows' : 'an empty prior result'} accurately`, async ({page}, info) => {
  const state = await installSettingsProjection(page, {user:{preferences:{theme:'dark',fontSize:'md',hideProfile:false}}});
  const current = {id:'session-current',current:true,ua:'Chrome Mac OS',lastSeenAt:'2026-09-09T10:00:00Z'};
  const passkeys = retained ? [{id:'c'.repeat(24),name:'Work device',createdAt:'2026-09-09T10:00:00Z'}] : [];
  const sessions = retained ? [current] : [];
  let failed = false;
  for (const resource of ['passkeys','sessions']) await page.route(url=>url.pathname===`/api/account/${resource}`, route=>{
    expect(route.request().method()).toBe('GET');
    return json(route, failed ? {} : resource==='passkeys' ? {passkeys} : {sessions,currentSession:retained?current:null,nextCursor:null,total:sessions.length}, failed?503:200);
  });
  await page.setViewportSize({width:320,height:844});
  await page.goto('/paralegal-v2.html#/settings?tab=security');
  await expect(page.locator('[data-security-content]')).toHaveAttribute('aria-busy','false');
  failed = true;
  await page.getByRole('button',{name:'Refresh security',exact:true}).click();
  const suffix = retained ? ' The previous list is shown below.' : '';
  for (const label of ['Passkeys','Sessions']) await expect(page.getByText(`${label} could not be refreshed.${suffix}`,{exact:true})).toBeVisible();
  await expect(page.getByText('No passkeys added.',{exact:true})).toHaveCount(0);
  await expect(page.locator('[data-security-session]')).toHaveCount(retained ? 1 : 0);
  await expect(page.getByRole('button',{name:'Add passkey',exact:true})).toBeDisabled();
  if (retained) await expect(page.getByRole('button',{name:'Remove Work device'})).toBeDisabled();
  else await expect(page.getByText(/previous list/)).toHaveCount(0);
  await page.getByText(`Passkeys could not be refreshed.${suffix}`,{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('security-read-failure.png')});
  const report = await new AxeBuilder({page}).include('.pv2-security').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(report.violations).toEqual([]);
  failed = false;
  await page.getByRole('button',{name:'Refresh security',exact:true}).click();
  await expect(page.locator('[data-security-content]')).toHaveAttribute('aria-busy','false');
  await expect(page.getByText(/could not be refreshed/)).toHaveCount(0);
  if (retained) await expect(page.getByRole('button',{name:'Remove Work device'})).toBeEnabled();
  else await expect(page.getByText('No passkeys added.',{exact:true})).toBeVisible();
  expect(state.securityMutations).toEqual([]);
});

async function waitForSettings(page) {
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("[data-v2-settings]")).toBeVisible();
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
}

test("confirmed name and photo review state refresh without reloading the profile", async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.route("**/api/uploads/profile-photo", route => {
    state.user.profilePhotoStatus = "pending_review";
    state.user.profilePhotoRevision = "b".repeat(64);
    return json(route, { status: "pending_review", profilePhotoRevision: state.user.profilePhotoRevision });
  });
  await page.goto("/paralegal-v2.html#/settings?tab=profile");
  await waitForSettings(page);
  await page.getByLabel("First name", { exact: true }).fill("Dani");
  await page.getByLabel("First name", { exact: true }).blur();
  await expect(page.locator("[data-v2-profile-name]")).toHaveText("Dani Young");
  await expect(page.locator(".v2-settings-identity-copy")).not.toContainText("Dani Young");
  await expect(page.locator(".v2-settings-identity-copy")).not.toContainText("dana@example.com");
  expect(state.user.firstName).toBe("Dani");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600; canvas.height = 600;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#6495ed"; ctx.fillRect(0, 0, 600, 600);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("Choose profile photo", { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.getByRole("dialog", { name: "Edit profile photo", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save photo", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".v2-settings-identity-copy small")).toHaveText("Attorneys can’t find your profile until your photo is approved.");
  await expect(page.getByLabel("First name", { exact: true })).toHaveValue("Dani");
});

test("primary state stays distinct from experience and reports pending and failed saves on Profile", async ({ page }) => {
  const state = await installSettingsProjection(page);
  let release;
  let rejectState = false;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route(/\/api\/account\/preferences(?:\?.*)?$/, async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON()?.state) {
      if (rejectState) return json(route, { error: "State could not be saved." }, 503);
      await pending;
    }
    return route.fallback();
  });
  await page.goto("/paralegal-v2.html#/settings?tab=profile");
  await waitForSettings(page);
  const indicator = page.locator('[data-settings-feedback="profile"] .v2-settings-save-status');
  await page.getByLabel("Primary state", { exact: true }).selectOption("CA");
  await expect(indicator).toHaveText("Saving…");
  await page.getByLabel("First name", { exact: true }).fill("Dani");
  await page.getByLabel("First name", { exact: true }).blur();
  await expect.poll(() => state.user.firstName).toBe("Dani");
  await expect(indicator).toHaveText("Saving…");
  release();
  await expect(indicator).toHaveText("Changes saved");
  await expect(page.getByLabel("Primary state", { exact: true })).toBeEnabled();
  expect(state.preferencePosts).toContainEqual({ state: "CA" });
  expect(state.user.stateExperience).toEqual(["NY"]);
  expect(state.profilePatches.every(patch => !Object.hasOwn(patch, "state"))).toBe(true);
  rejectState = true;
  await page.getByLabel("Primary state", { exact: true }).selectOption("TX");
  const stateError = page.locator('[data-profile-section="primary-state"] [role="status"]');
  await expect(stateError).toHaveText("State could not be saved.");
  await expect(indicator).toBeHidden();
  await expect(page.getByLabel("Primary state", { exact: true })).toHaveValue("CA");
  await expect(page.getByLabel("Primary state", { exact: true })).toBeEnabled();
  expect(state.user.stateExperience).toEqual(["NY"]);
  await page.getByRole("tab", { name: "Preferences", exact: true }).click();
  await expect(page.locator("#v2-settings-preferences").getByLabel("Primary state")).toHaveCount(0);
  await page.getByRole("tab", { name: "Profile", exact: true }).click();
  await expect(stateError).toHaveText("State could not be saved.");
  await expect(indicator).toBeHidden();
});

test("reading size survives a subsequent theme change and reload", async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.goto("/paralegal-v2.html#/settings?tab=preferences");
  await waitForSettings(page);
  await page.getByLabel("Font size", { exact: true }).selectOption("xl");
  await expect.poll(() => state.preferences.fontSize).toBe("xl");
  await page.getByRole("radio", { name: /Dark/ }).click();
  await expect.poll(() => state.preferences.theme).toBe("dark");
  expect(state.preferences.fontSize).toBe("xl");
  await page.reload();
  await waitForSettings(page);
  await expect(page.getByLabel("Font size", { exact: true })).toHaveValue("xl");
});

test("Security refresh stays with its tab and a departed read cannot restore old controls", async ({ page }, info) => {
  const state = await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings?tab=security');
  await waitForSettings(page);
  const refresh = page.getByRole('button', { name: 'Refresh security', exact: true });
  const header = page.locator('.v2-settings-header');
  await expect(header.getByRole('button', { name: 'Refresh security', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeEnabled();
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let intercept = true;
  await page.route(url => url.pathname === '/api/account/passkeys', async route => {
    if (intercept) { entered(); await held; }
    return json(route, { passkeys: [] });
  });
  await refresh.click();
  await started;
  await expect(refresh).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Preferences', exact: true }).click();
  await expect(refresh).toHaveCount(0);
  intercept = false; release();
  await expect(page.getByLabel('Font size', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await expect(refresh).toHaveCount(1);
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeEnabled();
  await expect(header.getByRole('button', { name: 'Refresh security', exact: true })).toHaveCount(1);
  expect(state.securityMutations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => { document.documentElement.classList.add('theme-dark'); document.documentElement.style.fontSize = '200%'; });
  await refresh.focus();
  await expect(refresh).toBeInViewport();
  const clippedTabs = await header.getByRole('tab').evaluateAll(tabs => tabs.filter(tab => {
    const bounds = tab.getBoundingClientRect();
    return bounds.left < 0 || bounds.right > innerWidth || bounds.bottom > innerHeight;
  }).map(tab => tab.textContent));
  expect(clippedTabs).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('security-header-narrow-dark.png') });
  const scan = await new AxeBuilder({ page }).include('.v2-settings-header').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
});

test("forced tour can be skipped and replayed from Settings", async ({ page }) => {
  await installSettingsProjection(page);
  await page.goto("/paralegal-v2.html#/settings?tab=preferences&tour=1");
  await waitForSettings(page);
  await page.getByRole("button", { name: "Skip tour", exact: true }).click();
  await expect(page.locator("[data-v2-onboarding-dialog]")).toHaveCount(0);
  await page.getByRole("button", { name: "Replay tour", exact: true }).click();
  await expect(page.locator("[data-v2-onboarding-dialog]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-v2-onboarding-dialog]")).toHaveCount(0);
});

test("resume readiness Review focuses the actual document section", async ({ page }) => {
  await installSettingsProjection(page, { user: { resumeURL: "" } });
  await page.goto("/paralegal-v2.html#/settings?tab=profile");
  await waitForSettings(page);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator('[data-profile-section="résumé"]').getByRole("button", { name: "Upload PDF" }).first()).toBeFocused();
});

test("photo replacement explains profile visibility before a file is selected", async ({ page }) => {
  await installSettingsProjection(page);
  await page.goto("/paralegal-v2.html#/settings?tab=profile");
  await waitForSettings(page);
  await expect(page.locator('[data-profile-section="profile-photo"]')).toContainText("Updating your photo hides your profile from attorneys until it’s approved.");
});

test("profile data renders and autosaves without replacing the persistent shell", async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paralegal-v2.html#/settings?tab=profile", { waitUntil: "domcontentloaded" });
  await waitForSettings(page);
  await page.evaluate(() => {
    window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.settingsIdentity = "same-sidebar";
    window.__LPC_PARALEGAL_V2__.shell.header.dataset.settingsIdentity = "same-header";
    window.__settingsNavigationCount = performance.getEntriesByType("navigation").length;
  });

  await expect(page.getByRole("heading", { level: 1, name: "Profile Settings" })).toBeVisible();
  await expect(page.getByLabel("Bio")).toHaveValue(/Senior litigation paralegal/);
  await expect(page.getByRole("button", { name: "Open profile photo actions" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Change photo" })).toBeHidden();
  await page.getByRole("button", { name: "Open profile photo actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Change photo" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open profile photo actions" })).toBeFocused();

  await page.getByLabel("Bio").fill("Senior litigation paralegal focused on discovery, trial preparation, and reliable handoffs.");
  await page.getByLabel("Bio").blur();
  await expect.poll(() => state.profilePatches.length).toBe(1);
  expect(state.profilePatches[0]).toEqual({
    bio: "Senior litigation paralegal focused on discovery, trial preparation, and reliable handoffs.",
  });
  await expect(page.getByRole("status").filter({ hasText: "Changes saved" })).toBeVisible();

  await page.getByRole("link", { name: "View profile" }).click();
  await expect(page.locator("[data-v2-profile-preview]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Dana Young" })).toBeVisible();
  await expect(page.getByText("Not available until Sep 21, 2026")).toBeVisible();
  await expect(page.getByText("Aug 14, 2024")).toBeVisible();
  for (const name of ["Résumé", "Certificate", "Writing sample"]) {
    await expect(page.getByRole("link", { name })).toHaveAttribute("href", /\/api\/uploads\/view\?key=/);
  }
  await page.getByRole("link", { name: "Back to settings" }).click();
  await waitForSettings(page);

  const shell = await page.evaluate(() => ({
    sidebar: window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.settingsIdentity,
    header: window.__LPC_PARALEGAL_V2__.shell.header.dataset.settingsIdentity,
    navigations: performance.getEntriesByType("navigation").length,
    initialNavigations: window.__settingsNavigationCount,
  }));
  expect(shell).toEqual({
    sidebar: "same-sidebar",
    header: "same-header",
    navigations: shell.initialNavigations,
    initialNavigations: shell.initialNavigations,
  });
});

test("autosave patches only changed fields so another tab cannot overwrite unrelated profile data", async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  const state = await installSettingsProjection(first);
  await installSettingsProjection(second, { state });
  await first.goto("/paralegal-v2.html#/settings?tab=profile", { waitUntil: "domcontentloaded" });
  await second.goto("/paralegal-v2.html#/settings?tab=profile", { waitUntil: "domcontentloaded" });
  await waitForSettings(first);
  await waitForSettings(second);
  // The second tab's authenticated-session projection intentionally asks the
  // first tab to revalidate. Begin the concurrent edit only after that startup
  // reconciliation has completed so this test exercises autosave, not startup.
  await first.waitForTimeout(1_000);
  await waitForSettings(first);

  await first.getByLabel("Bio").fill("Updated safely from the first tab.");
  await expect(first.getByLabel("Bio")).toHaveValue("Updated safely from the first tab.");
  await first.getByLabel("Bio").blur();
  await expect.poll(() => state.profilePatches.length).toBe(1);
  expect(state.profilePatches[0]).toEqual({ bio: "Updated safely from the first tab." });

  await second.getByLabel("Phone").fill("646-555-0199");
  await second.getByLabel("Phone").blur();
  await expect.poll(() => state.profilePatches.length).toBe(2);
  expect(state.profilePatches[1]).toEqual({ phoneNumber: "646-555-0199" });
  expect(state.user.bio).toBe("Updated safely from the first tab.");
  expect(state.user.phoneNumber).toBe("646-555-0199");

  await first.close();
  await second.close();
});

test("a failed autosave preserves the draft without retrying the unchanged revision forever", async ({ page }) => {
  const state = await installSettingsProjection(page, { rejectProfilePatches: true });
  await page.goto("/paralegal-v2.html#/settings?tab=profile", { waitUntil: "domcontentloaded" });
  await waitForSettings(page);

  await page.getByLabel("Bio").fill("This draft must remain available after a network failure.");
  await page.getByLabel("Bio").blur();
  await expect.poll(() => state.profilePatches.length).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: "Profile save temporarily unavailable." })).toBeVisible();
  await expect(page.getByLabel("Bio")).toHaveValue("This draft must remain available after a network failure.");

  await page.waitForTimeout(2_000);
  expect(state.profilePatches).toHaveLength(1);

  await page.getByRole("button", { name: "Save now" }).click();
  await expect.poll(() => state.profilePatches.length).toBe(2);
});

test("Profile, Security, and Preferences switch in place and remain scrollable on mobile", async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.route('**/api/auth/workspace-release', route => json(route, { error: 'Workspace routing unavailable' }, 503));
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/paralegal-v2.html#/settings", { waitUntil: "domcontentloaded" });
  await waitForSettings(page);
  expect(state.securityReads).toBe(0);
  await expect(page.locator('[data-workspace-release-notice]')).toBeVisible();
  await page.evaluate(() => {
    const settings = document.querySelector('[data-v2-settings]');
    window.__settingsTabRemovals = 0;
    window.__settingsTabObserver = new MutationObserver(records => {
      for (const record of records) if ([...record.removedNodes].includes(settings)) window.__settingsTabRemovals++;
    });
    window.__settingsTabObserver.observe(settings.parentElement, { childList: true });
  });

  await page.getByRole("tab", { name: "Security" }).click();
  await expect(page.getByRole("heading", { name: "Stripe payouts" })).toBeVisible();
  await expect.poll(() => state.securityReads).toBe(6);
  await page.getByRole("tab", { name: "Preferences" }).click();
  await expect(page.locator("#v2-settings-preferences").getByRole("heading", { name: "Workspace", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Personal details" })).toBeVisible();

  // Horizontal categories support directional keyboard navigation.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('tablist', { name: 'Profile Settings' })).toHaveAttribute('aria-orientation', 'horizontal');
  await page.getByRole("tab", { name: "Profile" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("tab", { name: "Security" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-navigation', 'idle');
  await expect(page.getByRole("tab", { name: "Security" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("tab", { name: "Profile" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-navigation', 'idle');
  await expect(page.getByRole("tab", { name: "Profile" })).toBeFocused();
  await expect(page.locator('[data-workspace-release-notice]')).toBeVisible();
  expect(await page.evaluate(() => {
    window.__settingsTabObserver.disconnect();
    return window.__settingsTabRemovals;
  })).toBe(0);

  for (const width of [320, 360, 375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 600 ? 760 : 900 });
    const bounds = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(bounds.documentWidth, `${width}px settings overflow`).toBeLessThanOrEqual(bounds.viewportWidth + 1);
  }
  await page.setViewportSize({ width: 390, height: 760 });

  const geometry = await page.locator("[data-v2-route-outlet]").evaluate((element) => {
    element.scrollTop = 700;
    return {
      top: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      bodyScroll: document.scrollingElement.scrollTop,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.top).toBeGreaterThan(0);
  expect(geometry.bodyScroll).toBe(0);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
});

test("Preferences expose only current themes and save each change through existing routes", async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.goto("/paralegal-v2.html#/settings?tab=preferences", { waitUntil: "domcontentloaded" });
  await waitForSettings(page);

  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(page.locator("[data-v2-settings]")).not.toContainText(/mountain|classic/i);
  await page.getByRole("radio", { name: /Dark/ }).click();
  await expect.poll(() => state.preferencePosts.some((patch) => patch.theme === "dark")).toBe(true);
  await page.getByLabel("Font size").selectOption("lg");
  await expect.poll(() => state.preferencePosts.some((patch) => patch.fontSize === "lg")).toBe(true);
  await expect(page.locator("#v2-settings-preferences").getByLabel("Primary state")).toHaveCount(0);
  await page.getByLabel("New message alerts").focus();
  await page.keyboard.press("Space");
  await expect.poll(() => state.notificationPatches.some((patch) => patch.emailMessages === false)).toBe(true);
});

test("Security does not mutate on load and destructive account actions require confirmation", async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.goto("/paralegal-v2.html#/settings?tab=security", { waitUntil: "domcontentloaded" });
  await waitForSettings(page);
  await expect(page.getByRole("heading", { name: "Blocked users" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stripe payouts" })).toBeVisible();
  expect(state.securityMutations).toEqual([]);

  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  const passwordCard = page.getByRole('dialog', { name: 'Change password', exact: true });
  const currentPassword = passwordCard.getByLabel("Current password", { exact: true });
  await expect(currentPassword).toHaveAttribute("type", "password");
  await passwordCard.getByRole("button", { name: "Show current password" }).click();
  await expect(currentPassword).toHaveAttribute("type", "text");
  await passwordCard.getByRole("button", { name: "Hide current password" }).click();
  await expect(currentPassword).toHaveAttribute("type", "password");
  await currentPassword.fill("CurrentPassword123!");
  await page.getByLabel("New password", { exact: true }).fill("FirstPassword123!");
  await page.getByLabel("Confirm new password", { exact: true }).fill("DifferentPassword123!");
  await passwordCard.getByRole("button", { name: "Change password and sign out", exact: true }).click();
  expect(await passwordCard.getByLabel("Confirm new password", { exact: true }).evaluate(el => el.validationMessage)).toBe("The new passwords do not match.");
  expect(state.securityMutations).toEqual([]);

  await passwordCard.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Unblock Taylor Reed", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Unblock Taylor Reed?" });
  await expect(dialog).toBeVisible();
  expect(state.securityMutations).toEqual([]);
  await dialog.getByRole("button", { name: "Unblock" }).click();
  await expect.poll(() => state.securityMutations.length).toBe(1);
  await expect(page.getByText("No blocked users.")).toBeVisible();
});

test("all three settings categories have no detectable WCAG A or AA violations", async ({ page }) => {
  await installSettingsProjection(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paralegal-v2.html#/settings", { waitUntil: "domcontentloaded" });
  await waitForSettings(page);

  for (const category of ["Profile", "Security", "Preferences"]) {
    await page.getByRole("tab", { name: category }).click();
    if (category === "Security") await expect(page.getByRole("heading", { name: "Stripe payouts" })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations, category).toEqual([]);
  }
});

test("approved copy: save text reports pending, failure and recovery while retired profile entries stay saved", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const options = { rejectProfilePatches: true };
  const state = await installSettingsProjection(page, options);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route(/\/api\/users\/me(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "PATCH") await pending;
    await route.fallback();
  });
  await page.goto("/paralegal-v2.html#/settings?tab=profile", { waitUntil: "domcontentloaded" });
  await waitForSettings(page);
  const indicator = page.locator('[data-settings-feedback="profile"] .v2-settings-save-status');
  await expect(page.locator('[data-profile-section="best-for"]')).toHaveCount(0);
  await expect(indicator).toHaveText("Changes saved");
  await page.getByLabel("Bio").fill("Updated biography; historical work-type entries must remain saved.");
  await page.getByLabel("Bio").blur();
  try {
    await expect(indicator).toHaveAttribute("data-state", "saving");
    await expect(indicator).toHaveText("Saving…");
  } finally { release(); }
  await expect(indicator).toHaveAttribute("data-state", "error");
  await expect(indicator).toContainText("Your edits are retained. Try again.");
  await expect(indicator).toHaveAttribute("data-state", "error");
  await expect(indicator).toHaveAttribute("aria-label", /Your edits are retained/);
  await expect(indicator).toHaveAttribute("data-message", /Your edits are retained/);
  options.rejectProfilePatches = false;
  await page.getByRole("button", { name: "Save now", exact: true }).click();
  await expect(indicator).toHaveAttribute("data-state", "saved");
  await expect(indicator).toHaveText("Changes saved");
  expect(state.user.bestFor).toEqual(["Document-intensive matters"]);
  expect(state.profilePatches.every((patch) => !Object.hasOwn(patch, "bestFor"))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("profile-save-text.png"), fullPage: true });
  await page.getByRole("link", { name: "View profile" }).click();
  await expect(page.locator("[data-v2-profile-preview]")).toBeVisible();
  await expect(page.getByText("Document-intensive matters", { exact: true })).toHaveCount(0);
  const violations = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.violations).toEqual([]);
});

test('office polish: profile security and preferences retain readable light/dark layouts', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings');
  await waitForSettings(page);
  for (const tab of ['Profile', 'Security', 'Preferences']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await require('./office-polish-review').reviewOffice(page, testInfo, `settings-${tab.toLowerCase()}`, { widths: [1440, 320] });
  }
});

test('office polish: account confirmation and profile preview remain readable', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const state = await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings?tab=security');
  await waitForSettings(page);
  const deactivate = page.getByRole('button', { name: 'Deactivate account', exact: true });
  await deactivate.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await require('./office-polish-review').reviewOffice(page, testInfo, 'account-confirmation', { widths: [1440, 320] });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.securityMutations).toEqual([]);
  await expect(deactivate).toBeFocused();
  await page.goto('/paralegal-v2.html#/profile/me');
  await expect(page.locator('.v2-settings-preview')).toBeVisible();
  await require('./office-polish-review').reviewOffice(page, testInfo, 'profile-preview', { widths: [1440, 320] });
});


test('hierarchy: settings keeps section labels with editable controls and renders no absent-status text', async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await waitForSettings(page);
  await page.getByLabel('First name', { exact: true }).fill('Dani');
  await page.getByLabel('First name', { exact: true }).blur();
  await expect.poll(() => state.user.firstName).toBe('Dani');
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Two-step verification', exact: true })).toBeVisible();
  await expect(page.locator('#v2-settings-security')).not.toContainText('null');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  const password = page.getByRole('dialog', { name: 'Change password', exact: true });
  await password.getByLabel('Current password', { exact: true }).fill('SyntheticOld123!');
  await password.getByLabel('New password', { exact: true }).fill('SyntheticNew123!');
  await password.getByLabel('Confirm new password', { exact: true }).fill('SyntheticNew123!');
  expect(state.securityMutations).toEqual([]);
  await password.getByRole('button', { name: 'Change password and sign out', exact: true }).click();
  await expect.poll(() => state.securityMutations.filter(item => item.url.endsWith('/api/account/update-password')).length).toBe(1);
  await expect(page).toHaveURL(/\/login\.html/);
});

test('compact entries expand by keyboard, save edits, and delete only the selected entry', async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings');
  await waitForSettings(page);
  const section = page.locator('[data-profile-section="experience"]');
  const summary = section.locator('summary').first();
  await expect(summary).toContainText('Senior paralegal');
  await expect(section.getByLabel('Role or firm')).toBeHidden();
  await summary.focus();
  await page.keyboard.press('Enter');
  await section.getByLabel('Role or firm').fill('Trial paralegal');
  await section.getByRole('button', {name:'Done',exact:true}).click();
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('Trial paralegal');
  await expect(section.getByLabel('Role or firm')).toBeHidden();
  await expect.poll(()=>state.user.experience[0].title).toBe('Trial paralegal');
  await section.getByRole('button',{name:'Add experience',exact:true}).click();
  const draft = section.locator('details').last();
  await expect(draft.getByLabel('Role or firm')).toBeFocused();
  // An unrelated save must not discard the still-empty editor or break its index.
  await page.getByLabel('First name',{exact:true}).fill('Dani');
  await page.getByLabel('First name',{exact:true}).blur();
  await expect.poll(()=>state.user.firstName).toBe('Dani');
  await draft.getByLabel('Role or firm').fill('New firm');
  await draft.getByLabel('Role or firm').blur();
  await expect.poll(()=>state.user.experience.length).toBe(2);
  await draft.getByRole('button',{name:'Delete experience entry 2',exact:true}).click();
  await expect.poll(()=>state.user.experience.length).toBe(1);
  expect(state.user.experience[0].title).toBe('Trial paralegal');
  await expect(summary).toBeFocused();
});

test('optional details reveal existing data and profile validation identifies the field without losing a draft', async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings');
  await waitForSettings(page);
  const linkedin = page.locator('.v2-settings-optional').filter({has:page.getByLabel('Profile URL',{exact:true})});
  await expect(page.getByLabel('Profile URL',{exact:true})).toBeHidden();
  await linkedin.locator('summary').click();
  await page.getByLabel('Profile URL',{exact:true}).fill('example.com');
  await page.getByLabel('Profile URL',{exact:true}).blur();
  await expect(page.getByLabel('Profile URL',{exact:true})).toHaveAttribute('aria-invalid','true');
  await expect(linkedin.locator('.v2-settings-field-error')).toHaveText('Enter a valid LinkedIn URL.');
  expect(state.profilePatches).toEqual([]);
  await page.getByLabel('Profile URL',{exact:true}).fill('linkedin.com/in/dana');
  await page.getByLabel('Profile URL',{exact:true}).blur();
  await expect.poll(()=>state.user.linkedInURL).toBe('https://linkedin.com/in/dana');
  await expect(linkedin.locator('.v2-settings-field-error')).toHaveCount(0);
  await page.reload();
  await waitForSettings(page);
  await expect(page.getByLabel('Profile URL',{exact:true})).toBeVisible();
  await expect(page.getByLabel('First name',{exact:true})).toHaveAttribute('aria-required','true');
  const education = page.locator('[data-profile-section="education"]');
  await education.locator('summary').first().click();
  await expect(education.getByLabel('Grade',{exact:true})).toBeHidden();
  await education.locator('summary').filter({hasText:'Additional details'}).click();
  await education.getByLabel('Grade',{exact:true}).fill('Honors');
  await education.getByLabel('Grade',{exact:true}).blur();
  await expect.poll(()=>state.user.education[0].grade).toBe('Honors');
  expect(state.user.education[0].school).toBe('City College');
});

test('preference failures stay beside their controls and a retry restores the saved state', async ({ page }) => {
  const state = await installSettingsProjection(page);
  let reject = true;
  await page.route('**/api/users/me/notification-prefs',route=> reject && route.request().method()==='PATCH' ? json(route,{error:'Notifications could not be saved.'},503) : route.fallback());
  await page.goto('/paralegal-v2.html#/settings?tab=preferences');
  await waitForSettings(page);
  const card = page.locator('.v2-settings-card').filter({has:page.getByRole('heading',{name:'Notifications',exact:true})});
  const toggle = card.getByLabel('New message alerts',{exact:true});
  await toggle.uncheck();
  await expect(toggle).toBeChecked();
  await expect(card.getByRole('status')).toHaveText('Notifications could not be saved.');
  reject = false;
  await toggle.uncheck();
  await expect.poll(()=>state.notificationPatches.some(patch=>patch.emailMessages === false)).toBe(true);
  await expect(card.getByRole('status')).toBeHidden();
  await expect(toggle).not.toBeChecked();
});

for (const scenario of ['profile', 'field', 'primary', 'notifications', 'workspace']) for (const mode of ['light', 'dark']) test(`settings ${scenario} error is singular and readable in ${mode}`, async ({ page }, info) => {
  const dark = mode === 'dark';
  await page.setViewportSize({ width: dark ? 320 : 1440, height: 1000 });
  const state = await installSettingsProjection(page, {
    rejectProfilePatches: scenario === 'profile',
    user: { preferences: { theme: mode, fontSize: dark ? 'xl' : 'md', hideProfile: false } },
    preferences: { theme: mode, fontSize: dark ? 'xl' : 'md' },
  });
  let reject = true;
  const message = scenario === 'primary' ? 'Primary state could not be saved.' : scenario === 'notifications' ? 'Notifications could not be saved.' : 'Reading size could not be saved.';
  await page.route(url => url.pathname === '/api/account/preferences', route => reject && route.request().method() === 'POST' ? json(route, { error: message }, 503) : route.fallback());
  if (scenario === 'notifications') await page.route('**/api/users/me/notification-prefs', route => reject && route.request().method() === 'PATCH' ? json(route, { error: message }, 503) : route.fallback());
  const tab = ['notifications', 'workspace'].includes(scenario) ? 'preferences' : 'profile';
  await page.goto(`/paralegal-v2.html#/settings?tab=${tab}`);
  await waitForSettings(page);
  const headerStatus = page.locator(`[data-settings-feedback="${tab}"] .v2-settings-save-status`);
  let status, expected;
  if (scenario === 'profile') {
    await page.getByLabel('First name', { exact: true }).fill('Retained');
    await page.getByLabel('First name', { exact: true }).blur();
    status = headerStatus; expected = 'Profile save temporarily unavailable.';
  } else if (scenario === 'field') {
    const disclosure = page.locator('.v2-settings-optional').filter({ has: page.getByLabel('Profile URL', { exact: true }) });
    await disclosure.locator('summary').click();
    await page.getByLabel('Profile URL', { exact: true }).fill('example.com');
    await page.getByLabel('Profile URL', { exact: true }).blur();
    status = disclosure.locator('.v2-settings-field-error'); expected = 'Enter a valid LinkedIn URL.';
  } else if (scenario === 'primary') {
    await page.getByLabel('Primary state', { exact: true }).selectOption('CA');
    status = page.locator('[data-profile-section="primary-state"] .v2-settings-inline-status'); expected = message;
    await expect(page.getByLabel('Primary state', { exact: true })).toHaveValue('NY');
  } else if (scenario === 'notifications') {
    await page.getByLabel('New message alerts', { exact: true }).uncheck();
    status = page.locator('.v2-settings-card').filter({ has: page.getByRole('heading', { name: 'Notifications', exact: true }) }).locator('.v2-settings-inline-status'); expected = message;
    await expect(page.getByLabel('New message alerts', { exact: true })).toBeChecked();
  } else {
    await page.getByLabel('Font size', { exact: true }).selectOption('sm');
    status = page.locator('.v2-settings-card--workspace .v2-settings-inline-status'); expected = message;
    await expect(page.getByLabel('Font size', { exact: true })).toHaveValue(dark ? 'xl' : 'md');
  }
  await expect(status).toContainText(expected);
  await expect(status).toBeVisible();
  if (scenario !== 'profile') await expect(headerStatus).toBeHidden();
  const visibleMessages = await page.locator('[role="status"], [role="alert"]').evaluateAll((nodes, expected) => nodes.filter(n => n.checkVisibility() && n.textContent.includes(expected)).map(n => n.textContent), expected);
  expect(visibleMessages).toHaveLength(1);
  await status.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('singular-settings-error.png') });
  const scan = await new AxeBuilder({ page }).include('[data-v2-settings]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
  expect(await page.locator('[data-v2-route-outlet]').evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
  if (scenario === 'workspace') {
    await page.getByLabel('New message alerts', { exact: true }).uncheck();
    await expect.poll(() => state.user.notificationPrefs.emailMessages).toBe(false);
    await expect(status).toContainText(message);
    await expect(headerStatus).toBeHidden();
    reject = false;
    await page.getByLabel('Font size', { exact: true }).selectOption('sm');
    await expect.poll(() => state.preferences.fontSize).toBe('sm');
    await expect(status).toBeHidden();
    await expect(headerStatus).toHaveText('Reading size saved');
  }
});

test('photo and document actions remain readable in the dark form after scrolling', async ({ page }, info) => {
  await installSettingsProjection(page, { user: { preferences: { theme: 'dark', fontSize: 'xl', hideProfile: false } }, preferences: { theme: 'dark', fontSize: 'xl' } });
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await waitForSettings(page);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const photo = page.getByRole('button', { name: 'Open profile photo actions', exact: true });
    await photo.click();
    await expect(page.getByRole('menuitem', { name: 'Remove photo', exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).include('.v2-settings-photo-menu').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`photo-actions-dark-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(photo).toBeFocused();
    const documents = page.locator('[data-profile-section="résumé"]');
    await documents.scrollIntoViewIfNeeded();
    await expect(documents.getByRole('button', { name: 'Remove Writing sample', exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).include('[data-profile-section="résumé"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`documents-dark-${width}.png`) });
    expect(await page.locator('[data-v2-route-outlet]').evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
  }
});
