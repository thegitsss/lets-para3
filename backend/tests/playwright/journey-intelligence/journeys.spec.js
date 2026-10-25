const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0 }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

async function actors() {
  const attorney = await server.createUser('attorney'), paralegal = await server.createUser('paralegal', {}, true);
  const User = require('../../../models/User');
  await User.updateMany({ _id: { $in: [attorney.id, paralegal.id] } }, { $set: { isFirstLogin: false, 'onboarding.attorneyTourCompleted': true, 'onboarding.paralegalTourCompleted': true, 'onboarding.paralegalProfileTourCompleted': true } });
  return { attorney, paralegal };
}
async function createMatter(people, patch = {}) {
  const Case = require('../../../models/Case');
  return Case.create({ title: 'Journey exhibits', details: 'Prepare the agreed exhibits.', attorney: people.attorney.id, attorneyId: people.attorney.id, paralegal: people.paralegal.id, paralegalId: people.paralegal.id, status: 'in progress', totalAmount: 50000, lockedTotalAmount: 50000, currency: 'usd', escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_journey', hiredAt: new Date(), tasks: [{ title: 'Prepare exhibits', completed: false }], files: [], ...patch });
}
async function contextFor(browser, actor, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  return context;
}
const preserved = doc => JSON.stringify({ totalAmount: doc.totalAmount, lockedTotalAmount: doc.lockedTotalAmount, paymentReleased: doc.paymentReleased, escrowIntentId: doc.escrowIntentId, tasks: doc.tasks, files: doc.files });

for (const role of ['attorney', 'paralegal']) for (const width of [1440, 390]) test(`${role} paired handoffs, Assistant draft and retained records ${width}`, async ({ browser }, info) => {
  const people = await actors(), matter = await createMatter(people), Case = require('../../../models/Case');
  const id = String(matter._id), context = await contextFor(browser, people[role], width), page = await context.newPage(), errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/support\/.*message/.test(request.url()) && request.method() === 'POST') posts.push(request.url()); });
  const href = role === 'attorney' ? `/attorney-v2.html#/matters/${id}/overview?returnHome=1` : `/paralegal-v2.html#/matter/${id}?tab=overview&returnTo=%2Fhome`;
  try {
    for (const [name, patch, expected] of [
      ['work', { files: [] }, role === 'attorney' ? 'Work is with your paralegal' : 'Continue your agreed work'],
      ['submitted', { files: [{ _id: new (require('mongoose').Types.ObjectId)(), original: 'exhibits.txt', uploadedBy: people.paralegal.id, uploadedByRole: 'paralegal', status: 'pending_review' }] }, role === 'attorney' ? 'Submitted work is ready for review' : 'Your submitted work is with the attorney'],
      ['revision', { files: [{ _id: new (require('mongoose').Types.ObjectId)(), original: 'exhibits.txt', uploadedBy: people.paralegal.id, uploadedByRole: 'paralegal', status: 'attorney_revision' }] }, role === 'attorney' ? 'Waiting for a revision response' : 'Revision requests need your review'],
      ...(role === 'attorney' ? [['retained', { status: 'completed', paymentReleased: false }, 'Retained Matter record']] : []),
    ]) {
      await Case.collection.updateOne({ _id: matter._id }, { $set: patch });
      const CaseFile = require('../../../models/CaseFile');
      await CaseFile.deleteMany({ caseId: id });
      for (const file of patch.files || []) await CaseFile.create({ caseId: id, userId: people.paralegal.id, originalName: 'exhibits.txt', storageKey: `cases/${id}/synthetic.txt`, mimeType: 'text/plain', securityStatus: 'clean', uploadedByRole: 'paralegal', status: file.status });
      const before = preserved(await Case.findById(id).lean());
      const response = await context.request.get(`${server.origin}/api/cases/${id}?expectedOwnerId=${people[role].id}`);
      expect(response.status()).toBe(200);
      const record = await response.json();
      expect(record.matterExperience.header.journey.title).toBe(expected);
      await fs.writeFile(info.outputPath(`${role}-${name}-record.json`), JSON.stringify(record.matterExperience.header.journey, null, 2));
      if (page.url() === server.origin + href) await page.reload();
      else await page.goto(server.origin + href);
      await page.locator('.lpc-boot-screen[open]').waitFor({ state: 'hidden' });
      await page.evaluate(() => document.fonts.ready);
      const handoff = page.getByRole('region', { name: 'What happens next' });
      await expect(handoff.getByRole('heading', { name: expected, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${role}-${name}-${width}.png`) });
      expect(preserved(await Case.findById(id).lean())).toBe(before);
    }
    const handoff = page.getByRole('region', { name: 'What happens next' });
    await handoff.getByRole('button', { name: 'Ask Assistant about this step' }).click();
    const composer = page.locator('#supportDrawer textarea');
    await expect(composer).toHaveValue(/Explain the current next step/);
    await composer.fill('My existing unsent question');
    await page.keyboard.press('Escape');
    await handoff.getByRole('button', { name: 'Ask Assistant about this step' }).click();
    await expect(composer).toHaveValue('My existing unsent question');
    expect(posts).toEqual([]);
    expect(errors).toEqual([]);
    await fs.writeFile(info.outputPath('provider-evidence.json'), JSON.stringify(server.evidence(), null, 2));
  } finally { await context.close(); }
});

test('start similar Matter creates an independent editable draft and preserves the original', async ({ browser }, info) => {
  const people = await actors(), matter = await createMatter(people, { status: 'completed', completedAt: new Date(), deadline: new Date('2020-01-01') });
  const Case = require('../../../models/Case'), CaseDraft = require('../../../models/CaseDraft');
  const before = preserved(await Case.findById(matter._id).lean());
  const context = await contextFor(browser, people.attorney, 1440), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${server.origin}/attorney-v2.html#/matters/${matter._id}/overview`);
    await page.getByRole('link', { name: 'Start a similar Matter', exact: true }).click();
    await expect(page.getByText('Scope copied into a new draft.', { exact: false })).toBeVisible();
    await expect.poll(async () => CaseDraft.countDocuments({ owner: people.attorney.id })).toBe(1);
    const draft = await CaseDraft.findOne({ owner: people.attorney.id }).lean();
    expect(draft).not.toHaveProperty('paralegal');
    expect(JSON.stringify(draft)).not.toContain('pi_synthetic_journey');
    expect(preserved(await Case.findById(matter._id).lean())).toBe(before);
    expect(await Case.countDocuments({})).toBe(1);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('independent-draft.png') });
  } finally { await context.close(); }
});
