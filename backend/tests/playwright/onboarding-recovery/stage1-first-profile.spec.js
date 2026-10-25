'use strict';
const { test, expect } = require('../workspace-paired-observation.cjs');
const start = require('../../helpers/financialLifecycleBrowserServer');
const fs = require('node:fs/promises');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0, includeSyntheticDownloads: true, includeSyntheticPersonalDownloads: true }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

for (const width of [1440, 390]) test(`new paralegal can create and retain the first profile entries ${width}`, async ({ browser }, info) => {
  const actor = await server.createUser('paralegal');
  const User = require('../../../models/User');
  await User.updateOne({ _id: actor.id }, { $set: {
    experience: [], education: [], languages: [], resumeURL: '', profileImage: '', avatarURL: '', profilePhotoStatus: 'unsubmitted',
    onboarding: { paralegalTourCompleted: false, paralegalProfileTourCompleted: false, paralegalWelcomePending: true, paralegalTours: {} },
  } });
  const read = () => User.findById(actor.id).select('+pendingProfileImageKey +profileImageKey').lean();
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  try {
    await page.goto(`${server.origin}/paralegal-v2.html#/home`);
    await expect(page.locator('.lpc-boot-screen[open]')).toHaveCount(0);
    const welcome = page.locator('[data-v2-onboarding-dialog="welcome-v1"]');
    await expect(welcome).toBeVisible();
    await welcome.getByRole('button', { name: 'Set up my account', exact: true }).click();
    const panel = page.locator('#v2-settings-profile');
    const intro = page.locator('dialog.ri-dialog[open]');
    await expect(intro).toBeVisible();
    await intro.getByRole('button', { name: 'Enter manually', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await read()).onboarding.paralegalTours['welcome-v1']).toBe('completed');
    const entries = [
      { key: 'experience', button: 'Add work experience', fields: [['Role / title', 'Litigation paralegal'], ['Dates / years', '2020–2026'], ['Organization & description', 'Synthetic firm: filing and trial support.']], expected: { title: 'Litigation paralegal', years: '2020–2026', description: 'Synthetic firm: filing and trial support.' } },
      { key: 'education', button: 'Add education', fields: [['Institution', 'Synthetic City College'], ['Degree', 'B.A.'], ['Subject', 'Legal studies']], expected: { school: 'Synthetic City College', degree: 'B.A.', fieldOfStudy: 'Legal studies' } },
      { key: 'languages', button: 'Add language', fields: [['Language', 'Spanish']], expected: { name: 'Spanish' } },
    ];
    for (const entry of entries) {
      await panel.getByRole('button', { name: entry.button, exact: true }).click();
      for (const [label, value] of entry.fields) await panel.getByLabel(label, { exact: true }).fill(value);
      await panel.getByRole('heading', { name: 'About', exact: true }).click();
      await expect.poll(async () => (await read())[entry.key]).toEqual([expect.objectContaining(entry.expected)]);
      await page.reload();
      await expect(page.locator('.lpc-boot-screen[open]')).toHaveCount(0);
      await expect(panel).toBeVisible();
      expect((await read())[entry.key]).toEqual([expect.objectContaining(entry.expected)]);
    }
    const imageBytes = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 300;
      const drawing = canvas.getContext('2d'); drawing.fillStyle = '#718097'; drawing.fillRect(0, 0, 300, 300);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    const choosePhoto = () => panel.getByLabel('Choose profile photo', { exact: true }).setInputFiles({ name: 'synthetic-profile.png', mimeType: 'image/png', buffer: imageBytes });
    const crop = page.getByRole('dialog', { name: 'Edit profile photo', exact: true });
    const beforePhoto = await read();
    await choosePhoto();
    await expect(crop).toBeVisible();
    await crop.getByRole('button', { name: 'Cancel profile photo edit', exact: true }).click();
    expect((await read()).profilePhotoStatus).toBe(beforePhoto.profilePhotoStatus);
    expect((await read()).profileImage).toBe(beforePhoto.profileImage);
    await choosePhoto();
    await expect(crop.getByRole('button', { name: 'Submit photo for approval', exact: true })).toBeInViewport();
    await page.screenshot({ animations: 'disabled', path: info.outputPath('first-photo-crop.png') });
    await crop.getByRole('button', { name: 'Submit photo for approval', exact: true }).click();
    await expect(crop).toHaveCount(0);
    await expect.poll(async () => (await read()).profilePhotoStatus).toBe('pending_review');
    expect((await read()).pendingProfileImageKey).toMatch(new RegExp(`^profile-photos/${actor.id}/`));
    await page.reload();
    await expect(page.locator('.lpc-boot-screen[open]')).toHaveCount(0);
    await expect(panel).toBeVisible();
    expect((await read()).profilePhotoStatus).toBe('pending_review');
    expect((await read()).profileImage).toBe('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: info.outputPath('first-profile-settings.png'), fullPage: true });
    await panel.getByRole('link', { name: 'View profile', exact: true }).click();
    const preview = page.locator('[data-v2-profile-preview]');
    await expect(preview).toBeVisible();
    for (const value of ['Litigation paralegal', 'Synthetic City College', 'Spanish']) await expect(preview).toContainText(value);
    await expect(preview).not.toContainText((await read()).email);
    await page.screenshot({ animations: 'disabled', path: info.outputPath('first-profile-preview.png'), fullPage: true });
    await fs.writeFile(info.outputPath('first-profile-evidence.json'), JSON.stringify({ width, persistedEntries: Object.fromEntries(entries.map(entry => [entry.key, entry.expected])), syntheticProviders: true }, null, 2));
  } finally { await context.close(); }
});

test('retained profile links stay stored while unsafe destinations remain inactive', async ({ browser }) => {
  const actor = await server.createUser('paralegal');
  const attorney = await server.createUser('attorney');
  const User = require('../../../models/User');
  const retained = { linkedInURL: 'https://unrelated.example.test/member', firmWebsite: 'https://private:embedded@firm.example.test/' };
  await User.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(attorney.id) }, { $set: retained });
  const context = await browser.newContext();
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  try {
    await page.goto(`${server.origin}/paralegal-v2.html#/attorney/${attorney.id}`);
    const profile = page.locator('[data-v2-attorney-profile]');
    await expect(profile).toBeVisible();
    await expect(profile.getByRole('link', { name: 'LinkedIn', exact: true })).toHaveCount(0);
    await expect(profile.getByRole('link', { name: 'Firm website', exact: true })).toHaveCount(0);
    expect(await User.findById(attorney.id).lean()).toMatchObject(retained);
    await User.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(attorney.id) }, { $set: { linkedInURL: 'https://www.linkedin.com/in/updated-member', firmWebsite: 'https://firm.example.test/' } });
    await page.reload();
    await expect(profile.getByRole('link', { name: 'LinkedIn', exact: true })).toHaveAttribute('href', 'https://www.linkedin.com/in/updated-member');
    await expect(profile.getByRole('link', { name: 'Firm website', exact: true })).toHaveAttribute('href', 'https://firm.example.test/');
  } finally { await context.close(); }
});

test('encrypted profile recovery survives reload, rejects another owner and clears after save', async ({ browser }, info) => {
  const actor = await server.createUser('paralegal');
  const User = require('../../../models/User');
  const before = await User.findById(actor.id).lean();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  let blockSave = true;
  await page.route(url => url.pathname === '/api/users/me', route => route.request().method() === 'PATCH' && blockSave
    ? route.fulfill({ status: 503, json: { error: 'Synthetic interrupted save' } }) : route.fallback());
  const key = `lpc_v2_profile_draft_v1:${actor.id}`;
  try {
    await page.goto(`${server.origin}/paralegal-v2.html#/settings?tab=profile`);
    const panel = page.locator('#v2-settings-profile');
    await expect(panel).toBeVisible();
    const intro = page.locator('dialog.ri-dialog[open]');
    await expect(intro).toBeVisible();
    await intro.getByRole('button', { name: 'Enter manually', exact: true }).click();
    await page.locator('.lpc-boot-screen[open]').waitFor({ state: 'hidden' });
    await panel.getByRole('button', { name: 'Edit about', exact: true }).click();
    const privateText = 'Unsaved private biography for encrypted recovery.';
    await panel.getByLabel('Bio', { exact: true }).fill(privateText);
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), key)).toMatch(/^enc:v1:/);
    const capsule = await page.evaluate(key => sessionStorage.getItem(key), key);
    expect(capsule).not.toContain(privateText);
    expect((await User.findById(actor.id).lean()).bio).toBe(before.bio);
    // Use the real session/CSRF transport against the mounted owner boundary.
    const crossOwner = await page.evaluate(async ({ capsule }) => {
      const { createApiClient } = await import('/assets/scripts/paralegal-v2/api-client.mjs');
      try { await createApiClient().post('/api/account/profile-draft/open', { expectedOwnerId: '000000000000000000000001', capsule }); return 200; }
      catch (error) { return error.status; }
    }, { capsule });
    expect(crossOwner).toBe(403);
    // The synthetic error above deliberately changes only the request owner,
    // never the actual session. Reload must recover only this session's draft.
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(panel.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('encrypted-recovery-phone.png') });
    blockSave = false;
    await panel.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(async () => (await User.findById(actor.id).lean()).bio).toBe(privateText);
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
