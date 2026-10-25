'use strict';
const { test, expect } = require('../workspace-paired-observation.cjs');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0 }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
for (const width of [1440, 390]) test(`History uses recorded updates and preserves unknown dates ${width}`, async ({ browser }, info) => {
  const actor = await server.createUser('paralegal'), attorney = await server.createUser('attorney');
  const Case = require('../../../models/Case');
  const docs = [];
  for (const [title, patch, expected] of [
    ['Closed with recorded update', { status: 'closed', completedAt: null, updatedAt: new Date('2026-09-20T12:00:00Z') }, 'Sep 20, 2026'],
    ['Completed with recorded completion', { status: 'completed', completedAt: new Date('2026-09-02T12:00:00Z'), updatedAt: new Date('2026-09-20T12:00:00Z') }, 'Sep 2, 2026'],
    ['Closed without recorded dates', { status: 'closed', completedAt: null, updatedAt: null }, 'Date not recorded'],
    ['Open termination review', { status: 'disputed', pausedReason: 'dispute', completedAt: null, updatedAt: new Date('2026-09-21T12:00:00Z'), paralegalAccessRevokedAt: new Date('2026-09-10T12:00:00Z'), terminationRequestedAt: new Date('2026-09-10T12:00:00Z'), terminationStatus: 'disputed', terminationDisputeId: 'synthetic-native-date-review', disputes: [{ disputeId: 'synthetic-native-date-review', status: 'open' }] }, 'Date not recorded'],
  ]) {
    const doc = await Case.create({ title, details: 'Synthetic History date verification.', attorney: attorney.id, attorneyId: attorney.id, paralegal: actor.id, paralegalId: actor.id, status: 'closed', currency: 'usd' });
    await Case.collection.updateOne({ _id: doc._id }, { $set: patch });
    docs.push({ id: String(doc._id), title, expected, completed: patch.completedAt !== null });
  }
  const before = await Case.collection.find({}).sort({ _id: 1 }).toArray();
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'en-US' });
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage(), writes = [];
  // History is read-only; the unrelated shell Connect readiness prerequisite
  // is fixed locally so no synthetic provider read is attributed to History.
  await page.route(url => url.pathname === '/api/payments/connect/status', route => route.fulfill({ status: 200, json: { readiness: { ready: true, evidenceState: 'verified' } } }));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  try {
    await page.goto(server.origin + '/paralegal-v2.html#/work?section=history');
    for (const doc of docs) {
      const row = page.locator(`[data-work-history-id="${doc.id}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator('time')).toContainText(doc.expected);
      await expect(row.locator('time')).toContainText(doc.completed ? 'Completed:' : 'Updated:');
      await row.getByRole('button', { name: doc.title, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: doc.title, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(doc.expected);
      if (doc.title === 'Open termination review') await expect(dialog).toContainText('Termination review');
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    }
    await page.screenshot({ path: info.outputPath('actual-history-dates.png'), fullPage: true });
    expect(writes).toEqual([]);
    expect(await Case.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(server.evidence().provider).toEqual([]);
    expect(server.evidence().external.mail).toEqual([]);
    await fs.writeFile(info.outputPath('history-dates-evidence.json'), JSON.stringify({ width, records: docs, recordsUnchanged: true, apiWrites: writes, actualLocalDatabase: true, providerCalls: 0, mailCalls: 0 }, null, 2));
  } finally { await context.close(); }
});
