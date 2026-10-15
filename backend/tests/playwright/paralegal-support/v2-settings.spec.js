const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const { USER_ID, json, installSettingsProjection } = require("./settings-fixtures");

for (const profileId of ['507f1f77bcf86cd799439011', 'not-a-profile']) test(`unsupported profile ${profileId} clears the preview and recovers in the same document`, async ({page}, info) => {
  const state = await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/profile/me');
  await expect(page.locator('[data-v2-profile-preview]')).toBeVisible();
  await page.evaluate(() => { window.__profileBoundaryDocument = true; });
  for (const width of [320, 1440]) {
    await page.setViewportSize({width, height: 900});
    await page.evaluate(id => { location.hash = `/profile/${id}`; }, profileId);
    await expect(page.getByRole('heading', {level: 1, name: 'Page not found', exact: true})).toBeVisible();
    await expect(page).toHaveTitle('Page not found – Let’s-ParaConnect');
    await expect(page.locator('[data-v2-profile-preview], .v2-foundation-panel')).toHaveCount(0);
    await page.screenshot({path: info.outputPath(`unsupported-profile-${width}.png`), fullPage: true});
    await page.evaluate(() => { location.hash = '/profile/me'; });
    await expect(page.locator('[data-v2-profile-preview]')).toBeVisible();
    await expect(page.getByRole('heading', {level: 1, name: 'Dana Young', exact: true})).toBeVisible();
    expect(await page.evaluate(() => window.__profileBoundaryDocument)).toBe(true);
  }
  expect(state.profilePatches).toEqual([]);
  expect(state.securityMutations).toEqual([]);
});

test('the exact verified owner profile URL opens the real preview', async ({page}) => {
  await installSettingsProjection(page);
  await page.goto(`/paralegal-v2.html#/profile/${USER_ID}`);
  await expect(page.locator('[data-v2-profile-preview]')).toBeVisible();
  await expect(page.getByRole('heading', {level: 1, name: 'Dana Young', exact: true})).toBeVisible();
  await expect(page.locator('.v2-foundation-panel')).toHaveCount(0);
});

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

async function editProfileRow(page, name) {
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  await expect(page.locator('#v2-settings-profile .is-row-editing')).toHaveCount(1);
}

async function saveProfileRow(page) {
  await page.locator('#v2-settings-profile .is-row-editing').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#v2-settings-profile .is-row-editing')).toHaveCount(0);
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
  await editProfileRow(page, 'name');
  await page.getByLabel("First name", { exact: true }).fill("Dani");
  await page.getByLabel("First name", { exact: true }).blur();
  expect(state.profilePatches).toEqual([]);
  await saveProfileRow(page);
  await expect(page.getByRole('button', { name: 'Edit name', exact: true })).toContainText('Dani Young');
  expect(state.user.firstName).toBe("Dani");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600; canvas.height = 600;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#6495ed"; ctx.fillRect(0, 0, 600, 600);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("Choose profile photo", { exact: true }).setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  const photoEditor = page.getByRole("region", { name: "Edit profile photo", exact: true });
  await expect(photoEditor).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await photoEditor.getByRole("button", { name: "Save profile photo", exact: true }).click();
  await expect(photoEditor).toHaveCount(0);
  await expect(page.locator('[data-profile-section="profile-photo"]')).toContainText("Attorneys can’t find your profile until your photo is approved.");
  await expect(page.getByRole('button', { name: 'Edit name', exact: true })).toContainText('Dani Young');
});

test("residence stays distinct from experience and retains pending and failed edits on Profile", async ({ page }) => {
  const state = await installSettingsProjection(page);
  let release, rejectState = false;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route(/\/api\/users\/me(?:\?.*)?$/, async route => {
    if (route.request().method() === 'PATCH' && route.request().postDataJSON()?.state) {
      if (rejectState) return json(route, { error: 'State could not be saved.' }, 503);
      await pending;
    }
    return route.fallback();
  });
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await waitForSettings(page);
  await editProfileRow(page, 'residence');
  await page.getByLabel('Residence', { exact: true }).selectOption('CA');
  expect(state.profilePatches).toEqual([]);
  const editor = page.locator('.is-row-editing');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  try {
    await expect(editor.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    expect(state.user.state).toBeUndefined();
    expect(state.user.stateExperience).toEqual(['NY']);
  } finally { release(); }
  await expect(editor).toHaveCount(0);
  expect(state.profilePatches).toEqual([{ state: 'CA' }]);
  expect(state.preferencePosts).toEqual([]);
  expect(state.user.stateExperience).toEqual(['NY']);
  rejectState = true;
  await editProfileRow(page, 'residence');
  await page.getByLabel('Residence', { exact: true }).selectOption('TX');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('State could not be saved.');
  await expect(page.getByLabel('Residence', { exact: true })).toHaveValue('TX');
  expect(state.user.state).toBe('CA');
  expect(state.user.stateExperience).toEqual(['NY']);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('tab', { name: 'Preferences', exact: true }).click();
  await expect(page.locator('#v2-settings-preferences').getByLabel('Residence', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Profile', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit residence', exact: true })).toContainText('California');
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
  await page.getByRole("button", { name: "Close tour", exact: true }).click();
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
  await expect(page.locator('[data-document-field="resumeURL"]').getByRole('button',{name:'Edit résumé',exact:true})).toBeFocused();
});

test("photo replacement explains profile visibility before a file is selected", async ({ page }) => {
  await installSettingsProjection(page);
  await page.goto("/paralegal-v2.html#/settings?tab=profile");
  await waitForSettings(page);
  await expect(page.locator('[data-profile-section="profile-photo"]')).toContainText("Updating your photo hides your profile from attorneys until it’s approved.");
});

test("profile data renders and explicitly saves without replacing the persistent shell", async ({ page }) => {
  // This fixture's unavailable-until date is September 21; keep its preview
  // assertion tied to the intended earlier day rather than the host clock.
  await page.clock.setFixedTime(new Date("2026-09-08T16:00:00Z"));
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
  await expect(page.locator(".v2-profile-editor-list")).toBeVisible();
  await expect(page.getByLabel("Bio")).toHaveValue(/Senior litigation paralegal/);
  await editProfileRow(page, "about");
  await expect(page.getByLabel("Bio")).toBeFocused();
  await page.locator(".is-row-editing").getByRole("button", {name:"Cancel",exact:true}).click();
  await editProfileRow(page, "practice areas");
  await expect(page.getByLabel("Select a practice area")).toBeFocused();
  await page.locator(".is-row-editing").getByRole("button", {name:"Cancel",exact:true}).click();
  await expect(page.getByRole("button", { name: "Open profile photo actions" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Change photo" })).toBeHidden();
  await page.getByRole("button", { name: "Open profile photo actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Change photo" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open profile photo actions" })).toBeFocused();

  await editProfileRow(page, "about");
  await page.getByLabel("Bio").fill("Senior litigation paralegal focused on discovery, trial preparation, and reliable handoffs.");
  await page.getByLabel("Bio").blur();
  expect(state.profilePatches).toEqual([]);
  await saveProfileRow(page);
  await expect.poll(() => state.profilePatches.length).toBe(1);
  expect(state.profilePatches[0]).toEqual({
    bio: "Senior litigation paralegal focused on discovery, trial preparation, and reliable handoffs.",
  });
  await expect(page.getByRole("status").filter({ hasText: "Changes saved" })).toBeVisible();

  await page.goto("/paralegal-v2.html#/profile/me", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-v2-profile-preview]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Dana Young" })).toBeVisible();
  await expect(page.getByText("New York · 8 years of experience")).toBeVisible();
  await expect(page.getByRole("img", { name: "Unavailable", exact: true })).toBeVisible();
  await expect(page.getByText("Aug 14, 2024")).toHaveCount(0);
  for (const name of ["Résumé", "Certificate", "Writing sample"]) {
    await expect(page.getByRole("link", { name: `View ${name.toLowerCase()}` })).toHaveAttribute("href", /\/api\/uploads\/view\?key=/);
  }
  await page.getByRole("link", { name: /Back to profile settings/ }).click();
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

test("profile rows support view, edit, cancel and explicit Save", async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await waitForSettings(page);
  const panel = page.locator('#v2-settings-profile');
  await expect(panel.getByRole('heading', { name: 'Phone', exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Bio')).toBeHidden();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name,label,value] of [['about','Bio','A local change that must be discarded.'],['residence','Residence','CA']]) {
      await editProfileRow(page, name);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const education = panel.locator('[data-profile-section="education"]');
      const before = await education.boundingBox();
      await panel.getByLabel(label, {exact:true}).focus();
      const after = await education.boundingBox();
      expect(Math.abs(after.y-before.y)).toBeLessThan(1);
      if(label==='Residence') await panel.getByLabel(label,{exact:true}).selectOption(value);
      else await panel.getByLabel(label,{exact:true}).fill(value);
      await page.waitForTimeout(1000);
      expect(state.profilePatches).toEqual([]);
      expect(state.preferencePosts).toEqual([]);
      await panel.locator('.is-row-editing').getByRole('button',{name:'Cancel',exact:true}).click();
      await expect(panel.getByRole('button',{name:`Edit ${name}`,exact:true})).toBeFocused();
    }
    await expect(panel.getByLabel('Bio')).toHaveValue(state.user.bio);
    await expect(panel.getByLabel('Residence',{exact:true})).toHaveValue('NY');
  }
  await editProfileRow(page, 'linkedin');
  await panel.getByLabel('Profile URL').fill('not-a-link');
  await panel.locator('.is-row-editing').getByRole('button',{name:'Save',exact:true}).click();
  await expect(panel).toContainText('Enter a valid LinkedIn URL.');
  expect(state.profilePatches).toEqual([]);
  await expect(panel.getByLabel('Profile URL')).toBeFocused();
  await panel.getByLabel('Profile URL').fill('');
  expect((await new AxeBuilder({page}).include('#v2-settings-profile').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await panel.locator('.is-row-editing').getByRole('button',{name:'Cancel',exact:true}).click();
  for(const [name,label,value] of [['name','First name','Dani'],['about','Bio','Litigation support and trial preparation.'],['residence','Residence','CA'],['practice areas','Select a practice area','Family Law']]) {
    await editProfileRow(page,name);
    const control=panel.getByLabel(label,{exact:true});
    if(name==='residence') await control.selectOption(value);
    else if(name==='practice areas') await control.selectOption({label:value});
    else await control.fill(value);
    await saveProfileRow(page);
  }
  expect(state.user.firstName).toBe('Dani');
  expect(state.user.bio).toBe('Litigation support and trial preparation.');
  expect(state.user.state).toBe('CA');
  expect(state.user.practiceAreas).toContain('Family Law');
  expect(state.preferencePosts).toEqual([]);
  await expect(panel.getByLabel('Bio')).toBeHidden();
  await expect(panel.getByRole('button',{name:'Edit about',exact:true})).toContainText(state.user.bio);
  expect(state.profilePatches).toHaveLength(4);
});

test("profile preview reads the latest saved attorney-facing fields without account contact details", async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.goto("/paralegal-v2.html#/settings?tab=profile", { waitUntil: "domcontentloaded" });
  await waitForSettings(page);
  state.user.bio = "Updated saved profile from another session.";
  state.user.practiceAreas = ["Family Law"];
  state.user.preferences.hideProfile = true;
  await page.goto("/paralegal-v2.html#/profile/me", { waitUntil: "domcontentloaded" });
  const preview = page.locator("[data-v2-profile-preview]");
  await expect(preview).toContainText("Updated saved profile from another session.");
  await expect(preview).toContainText("Family Law");
  await expect(preview).not.toContainText("Senior litigation paralegal focused on discovery and trial preparation.");
  await expect(preview).not.toContainText("dana@example.com");
  await expect(preview).not.toContainText("212-555-0142");
  await expect(preview).toContainText("Your profile is hidden from discovery.");
});

test("explicit Save patches only changed fields so another tab preserves unrelated profile data", async ({ context }) => {
  const first = await context.newPage(), second = await context.newPage();
  const state = await installSettingsProjection(first);
  await installSettingsProjection(second, {state});
  await first.goto('/paralegal-v2.html#/settings?tab=profile');
  await second.goto('/paralegal-v2.html#/settings?tab=profile');
  await waitForSettings(first); await waitForSettings(second);
  await first.waitForTimeout(1000); await waitForSettings(first);
  await editProfileRow(first,'about');
  await editProfileRow(second,'years of experience');
  await first.getByLabel('Bio').fill('Updated safely from the first tab.');
  await first.getByLabel('Bio').blur();
  expect(state.profilePatches).toEqual([]);
  await saveProfileRow(first);
  expect(state.profilePatches).toEqual([{bio:'Updated safely from the first tab.'}]);
  await second.getByLabel('Years of experience',{exact:true}).fill('9');
  await saveProfileRow(second);
  expect(state.profilePatches).toEqual([{bio:'Updated safely from the first tab.'},{yearsExperience:9}]);
  expect(state.user.bio).toBe('Updated safely from the first tab.');
  expect(state.user.yearsExperience).toBe(9);
  expect(state.user.phoneNumber).toBe('212-555-0142');
  await first.close(); await second.close();
});

test("a failed explicit Save retains the draft and retries only on request", async ({ page }) => {
  const options={rejectProfilePatches:true};
  const state=await installSettingsProjection(page,options);
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await waitForSettings(page); await editProfileRow(page,'about');
  await page.getByLabel('Bio').fill('This draft must remain available after a network failure.');
  await page.getByLabel('Bio').blur();
  expect(state.profilePatches).toEqual([]);
  const editor=page.locator('.is-row-editing');
  await editor.getByRole('button',{name:'Save',exact:true}).click();
  await expect(editor.getByRole('status')).toContainText('Profile save temporarily unavailable.');
  await expect(page.getByLabel('Bio')).toHaveValue('This draft must remain available after a network failure.');
  await page.waitForTimeout(2000);
  expect(state.profilePatches).toHaveLength(1);
  options.rejectProfilePatches=false;
  await saveProfileRow(page);
  expect(state.profilePatches).toHaveLength(2);
  expect(state.user.bio).toBe('This draft must remain available after a network failure.');
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
  await expect(page.getByRole("heading", { name: "Name", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Email", exact: true })).toBeVisible();

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

test("approved copy: explicit save reports pending, failure and recovery while retired entries stay saved", async ({ page }, testInfo) => {
  await page.setViewportSize({width:390,height:844});
  const options={rejectProfilePatches:true},state=await installSettingsProjection(page,options);
  let release;const pending=new Promise(resolve=>{release=resolve;});
  await page.route(/\/api\/users\/me(?:\?.*)?$/,async route=>{if(route.request().method()==='PATCH')await pending;await route.fallback();});
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await waitForSettings(page);
  const indicator=page.locator('[data-settings-feedback="profile"] .v2-settings-save-status');
  await expect(page.locator('[data-profile-section="best-for"]')).toHaveCount(0);
  await expect(page.locator('[data-profile-section="experience"]')).toHaveCount(0);
  await expect(indicator).toHaveText('Changes saved');
  await editProfileRow(page,'about');
  await page.getByLabel('Bio').fill('Updated biography; historical work-type entries must remain saved.');
  await page.getByLabel('Bio').blur();expect(state.profilePatches).toEqual([]);
  const editor=page.locator('.is-row-editing');
  await editor.getByRole('button',{name:'Save',exact:true}).click();
  try {
    await expect(indicator).toHaveAttribute('data-state','saving');
    await expect(indicator).toHaveText('Saving…');
    await expect(editor.getByRole('button',{name:'Saving…',exact:true})).toBeDisabled();
  } finally {release();}
  const localStatus=editor.getByRole('status');
  await expect(localStatus).toContainText('Your edits are retained. Try again.');
  await expect(localStatus).toHaveAttribute('aria-live','polite');
  await expect(indicator).toBeHidden();
  options.rejectProfilePatches=false;
  await saveProfileRow(page);
  await expect(indicator).toHaveAttribute('data-state','saved');
  await expect(indicator).toHaveText('Changes saved');
  expect(state.user.bestFor).toEqual(['Document-intensive matters']);
  expect(state.user.experience).toEqual([{title:'Senior paralegal',years:'2019–present',description:'Litigation support.'}]);
  expect(state.profilePatches.every(patch=>!Object.hasOwn(patch,'bestFor')&&!Object.hasOwn(patch,'experience')&&!Object.hasOwn(patch,'phoneNumber'))).toBe(true);
  await page.screenshot({path:testInfo.outputPath('profile-save-text.png'),fullPage:true});
  await page.goto('/paralegal-v2.html#/profile/me');
  await expect(page.locator('[data-v2-profile-preview]')).toBeVisible();
  await expect(page.getByText('Document-intensive matters',{exact:true})).toHaveCount(0);
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([]);
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
  await editProfileRow(page,'name');
  await page.getByLabel('First name', { exact: true }).fill('Dani');
  await page.getByLabel('First name', { exact: true }).blur();
  expect(state.profilePatches).toEqual([]);
  await saveProfileRow(page);
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

test('education entries edit by keyboard and remove only the selected entry while historical experience stays saved',async({page})=>{
  const state=await installSettingsProjection(page);
  const historicalExperience=structuredClone(state.user.experience);
  await page.goto('/paralegal-v2.html#/settings');await waitForSettings(page);
  const section=page.locator('[data-profile-section="education"]');
  const trigger=section.getByRole('button',{name:'Edit school, education entry 1',exact:true});
  await expect(section.getByLabel('School',{exact:true})).toBeHidden();
  await trigger.press('Enter');
  await expect(section.getByLabel('School',{exact:true})).toBeFocused();
  await section.getByLabel('School',{exact:true}).fill('Trial College');
  expect(state.profilePatches).toEqual([]);
  await saveProfileRow(page);await expect(trigger).toBeFocused();
  expect(state.user.education[0].school).toBe('Trial College');
  await section.getByRole('button',{name:'Add education',exact:true}).click();
  const draft=section.locator('[data-profile-entry="1"]');
  await expect(draft.getByLabel('School',{exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Edit name',exact:true}).click();
  await expect(page.locator('.is-row-editing')).toHaveCount(1);
  await expect(page.getByLabel('First name',{exact:true})).toBeHidden();
  await draft.getByLabel('School',{exact:true}).fill('New College');
  await saveProfileRow(page);expect(state.user.education).toHaveLength(2);
  await section.getByRole('button',{name:'Remove education entry 2',exact:true}).click();
  expect(state.user.education).toHaveLength(2);
  await saveProfileRow(page);
  expect(state.user.education).toHaveLength(1);
  expect(state.user.education[0].school).toBe('Trial College');
  expect(state.user.experience).toEqual(historicalExperience);
  expect(state.profilePatches.every(patch=>!Object.hasOwn(patch,'experience'))).toBe(true);
  const languages=page.locator('[data-profile-section="languages"]');
  await languages.getByRole('button',{name:'Add language',exact:true}).click();
  const newLanguage=languages.locator('[data-profile-entry="1"]').getByLabel('Language',{exact:true});
  await expect(newLanguage).toBeFocused();
  await newLanguage.fill('French');
  await languages.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(state.user.languages).toEqual([{name:'English',proficiency:'Native'}]);
  expect(state.user.education).toHaveLength(1);
});

test('optional detail editing validates the field without losing a draft or saved education',async({page})=>{
  const state=await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings');await waitForSettings(page);
  await expect(page.getByLabel('Profile URL',{exact:true})).toBeHidden();
  await editProfileRow(page,'linkedin');
  await page.getByLabel('Profile URL',{exact:true}).fill('example.com');
  await page.getByLabel('Profile URL',{exact:true}).blur();expect(state.profilePatches).toEqual([]);
  await page.locator('.is-row-editing').getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByLabel('Profile URL',{exact:true})).toHaveAttribute('aria-invalid','true');
  await expect(page.getByLabel('Profile URL',{exact:true})).toBeFocused();
  await expect(page.locator('.is-row-editing .v2-settings-field-error')).toHaveText('Enter a valid LinkedIn URL.');
  expect(state.profilePatches).toEqual([]);
  await page.getByLabel('Profile URL',{exact:true}).fill('linkedin.com/in/dana');
  await saveProfileRow(page);expect(state.user.linkedInURL).toBe('https://linkedin.com/in/dana');
  await page.reload();await waitForSettings(page);
  await expect(page.getByRole('button',{name:'Edit linkedin',exact:true})).toContainText('https://linkedin.com/in/dana');
  await expect(page.getByLabel('First name',{exact:true})).toHaveAttribute('aria-required','true');
  const education=page.locator('[data-profile-section="education"]');
  await expect(education.getByLabel('Grade',{exact:true})).toBeHidden();
  await education.getByLabel('Add detail to education entry 1',{exact:true}).selectOption('grade');
  await education.getByLabel('Grade',{exact:true}).fill('Honors');
  await education.getByLabel('Grade',{exact:true}).blur();
  expect(state.user.education[0].grade).toBeUndefined();
  await saveProfileRow(page);expect(state.user.education[0].grade).toBe('Honors');
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
  if (scenario === 'primary') await page.route(/\/api\/users\/me(?:\?.*)?$/, route => reject && route.request().method() === 'PATCH' ? json(route, { error: message }, 503) : route.fallback());
  if (scenario === 'notifications') await page.route('**/api/users/me/notification-prefs', route => reject && route.request().method() === 'PATCH' ? json(route, { error: message }, 503) : route.fallback());
  const tab = ['notifications', 'workspace'].includes(scenario) ? 'preferences' : 'profile';
  await page.goto(`/paralegal-v2.html#/settings?tab=${tab}`);
  await waitForSettings(page);
  const headerStatus = page.locator(`[data-settings-feedback="${tab}"] .v2-settings-save-status`);
  let status, expected;
  if (scenario === 'profile') {
    await editProfileRow(page, 'name');
    await page.getByLabel('First name', { exact: true }).fill('Retained');
    await page.getByLabel('First name', { exact: true }).blur();
    await page.locator('.is-row-editing').getByRole('button', { name: 'Save', exact: true }).click();
    status = page.locator('.is-row-editing').getByRole('status'); expected = 'Profile save temporarily unavailable.';
  } else if (scenario === 'field') {
    await editProfileRow(page, 'linkedin');
    await page.getByLabel('Profile URL', { exact: true }).fill('example.com');
    await page.getByLabel('Profile URL', { exact: true }).blur();
    await page.locator('.is-row-editing').getByRole('button', { name: 'Save', exact: true }).click();
    status = page.locator('.is-row-editing .v2-settings-field-error'); expected = 'Enter a valid LinkedIn URL.';
  } else if (scenario === 'primary') {
    await editProfileRow(page, 'residence');
    await page.getByLabel('Residence', { exact: true }).selectOption('CA');
    await page.locator('.is-row-editing').getByRole('button', { name: 'Save', exact: true }).click();
    status = page.locator('.is-row-editing').getByRole('status'); expected = message;
    await expect(page.getByLabel('Residence', { exact: true })).toHaveValue('CA');
    expect(state.user.location).toBe('NY');
    expect(state.user.state).toBeUndefined();
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
  await expect(headerStatus).toBeHidden();
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
  const state = await installSettingsProjection(page, { user: { preferences: { theme: 'dark', fontSize: 'xl', hideProfile: false } }, preferences: { theme: 'dark', fontSize: 'xl' } });
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
    await photo.click();
    await page.getByRole('menuitem', { name: 'Remove photo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save photo removal', exact: true })).toBeEnabled();
    expect((await new AxeBuilder({ page }).include('.v2-profile-photo-removal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`photo-removal-dark-${width}.png`) });
    await page.getByRole('button', { name: 'Cancel photo removal', exact: true }).click();
    const documents = page.locator('[data-profile-section="résumé"]');
    await documents.scrollIntoViewIfNeeded();
    const writingSample = documents.locator('[data-document-field="writingSampleURL"]');
    if (!await writingSample.evaluate(row => row.classList.contains('is-editing'))) {
      await writingSample.getByRole('button',{name:'Edit writing sample',exact:true}).click();
    }
    await expect(documents.getByRole('button', { name: 'Remove Writing sample', exact: true })).toBeVisible();
    await documents.getByRole('button', { name: 'Remove Writing sample', exact: true }).click();
    await expect(writingSample.getByRole('button', { name: 'Save writing sample', exact: true })).toBeEnabled();
    expect((await new AxeBuilder({ page }).include('[data-profile-section="résumé"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`documents-dark-${width}.png`) });
    expect(await page.locator('[data-v2-route-outlet]').evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    await writingSample.getByRole('button',{name:'Cancel writing sample edit',exact:true}).click();
    await expect(writingSample.getByRole('button',{name:'Edit writing sample',exact:true})).toBeFocused();
  }
  expect(state.profilePatches).toEqual([]);
  expect(state.user.writingSampleURL).toBe(`users/${USER_ID}/writing-sample/current.pdf`);
});
