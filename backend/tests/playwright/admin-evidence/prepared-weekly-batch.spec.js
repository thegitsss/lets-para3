const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(360000); server = await start({ port: Number(process.env.LPC_ADMIN_LEGACY_PORT || 5168), includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true, includeDirectors: true }); });
test.beforeEach(async () => server.reset()); test.afterAll(async () => server?.close());

test('owner-prepared weekly drafts lead to their canonical review and Director oversight preserves full records and history', async ({ browser }, info) => {
  const admin = await server.createUser('admin'), director = await server.createUser('director');
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addCookies([admin.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  const Packet = require('../../../models/MarketingDraftPacket'), Task = require('../../../models/ApprovalTask');
  const Cycle = require('../../../models/MarketingPublishingCycle'), Record = require('../../../models/DirectorOutreachRecord');
  const Event = require('../../../models/DirectorOutreachEvent');
  const page = await context.newPage();
  let csrfToken;
  const post = async (path, data = {}, expected = 200) => { const response = await context.request.post(server.origin + path, { data, headers: { 'X-CSRF-Token': csrfToken } }); expect(response.status()).toBe(expected); return response.json(); };
  try {
    const csrfResponse = await context.request.get(server.origin + '/api/csrf'); expect(csrfResponse.status()).toBe(200);
    ({ csrfToken } = await csrfResponse.json()); expect(csrfToken).toEqual(expect.any(String));
    await post('/api/admin/knowledge/sync');
    await post('/api/admin/marketing/publishing/settings', { isEnabled: false, cadenceMode: 'manual_only', maxOpenCycles: 2 });
    const cycles = [];
    for (const cycleLabel of ['Earlier prepared owner batch', 'Current prepared owner batch']) {
      const prepared = await post('/api/admin/marketing/publishing/cycles', { cycleLabel }, 201);
      expect(prepared.created).toBe(true); cycles.push(prepared.cycle);
    }
    const earlier = await Packet.findById(cycles[0].channels.linkedin_company.packetId).lean();
    expect(earlier.channelDraft.body.trim().length).toBeGreaterThan(0); expect(earlier.approvedFactCards.length).toBeGreaterThan(0); expect(earlier.citations.length).toBeGreaterThan(0);
    const old = new Date(Date.now() - 8 * 86400000);
    await Packet.collection.updateOne({ _id: earlier._id }, { $set: { createdAt: old, updatedAt: old } });
    const readiness = await post(`/api/admin/marketing/draft-packets/${earlier._id}/publish-readiness`);
    expect(readiness.readiness).toMatchObject({ status: 'blocked', isReady: false });
    expect(readiness.readiness.blockers).toContain('Packet must be approved before it can be published.');
    const directorUser = await require('../../../models/User').findById(director.id).lean();
    const records = await Record.insertMany(Array.from({ length: 51 }, (_, index) => ({ directorUserId: director.id, directorEmail: directorUser.email, attorneyEmail: `prepared-referral-${index}@example.test`, attorneyName: `Synthetic prepared referral ${index}`, stage: 'founder_attention', founderAttentionAt: new Date(Date.now() - index * 1000) })));
    const oldest = records[50];
    await Event.create({ recordId: oldest._id, directorUserId: director.id, directorEmail: directorUser.email, attorneyEmail: oldest.attorneyEmail, eventType: 'reply_received', summary: 'Retained synthetic prepared-batch reply', provider: 'local', providerMessageId: 'prepared-batch-full-history' });
    const packetSnapshot = await Packet.find().sort({ _id: 1 }).lean(), taskSnapshot = await Task.find({ targetType: 'marketing_draft_packet' }).sort({ _id: 1 }).lean();
    await page.goto(server.origin + '/admin-dashboard.html#marketing-drafts');
    await page.getByRole('combobox', { name: 'Growth view', exact: true }).selectOption('weekly');
    const weekly = page.locator('#adminGrowthReview'), older = weekly.locator('article').filter({ hasText: 'Earlier prepared owner batch' });
    await expect(weekly).toContainText('Current prepared owner batch'); await expect(older).toContainText('Earlier unfinished review');
    await older.getByRole('button', { name: 'Review draft', exact: true }).click();
    const detail = page.locator('#approvalItemDetail');
    await expect(detail).toHaveAttribute('data-approval-detail-state', 'loaded');
    await expect(detail).toHaveAttribute('data-approval-active-work-key', `marketing_draft_packet:${earlier._id}`);
    await expect(detail).toContainText(earlier.channelDraft.body);
    await page.goto(server.origin + '/admin-dashboard.html#marketing-drafts');
    await page.getByRole('combobox', { name: 'Growth view', exact: true }).selectOption('weekly');
    await expect(older).toContainText('Earlier unfinished review');
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 }); await weekly.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await weekly.screenshot({ path: info.outputPath(`prepared-weekly-${width}.png`), animations: 'disabled' });
    }
    await weekly.locator('summary').click();
    const oversight = weekly.locator('[data-growth-directors]');
    await expect(oversight).toContainText('1 directors · 51 referral records');
    await expect(oversight).toContainText('The overview shows 50 recent records. Open director records for the complete history.');
    await expect(oversight.locator('article')).toHaveCount(50);
    await expect(oversight).not.toContainText(oldest.attorneyName);
    await weekly.getByRole('link', { name: 'Open director records and payment history', exact: true }).click();
    await expect(page).toHaveURL(/\/admin-directors\.html$/);
    await page.getByRole('combobox', { name: 'Director view', exact: true }).selectOption({ label: 'All records' });
    await expect(page.locator('#recordsBody')).toBeVisible();
    await expect(page.locator('#metricRecords')).toHaveText('51'); await expect(page.locator('#recordsBody tr')).toHaveCount(51);
    const excludedRow = page.locator('#recordsBody tr').filter({ hasText: oldest.attorneyEmail });
    await expect(excludedRow).toHaveCount(1); await excludedRow.getByRole('button', { name: 'Audit', exact: true }).click();
    await expect(page.locator('#auditPanel')).toBeVisible(); await expect(page.locator('#auditBody')).toContainText(oldest.attorneyEmail);
    await expect(page.locator('#auditBody')).toContainText('Retained synthetic prepared-batch reply');
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const historyEntry = page.locator('#auditBody').getByText('Retained synthetic prepared-batch reply');
      await historyEntry.scrollIntoViewIfNeeded(); await expect(historyEntry).toBeVisible(); await expect(historyEntry).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.locator('#auditPanel').screenshot({ path: info.outputPath(`prepared-director-history-${width}.png`), animations: 'disabled' });
    }
    await page.locator('#auditPanel').getByRole('button', { name: /close/i }).click();
    const downloadPending = page.waitForEvent('download'); await page.locator('#downloadCsvBtn').click();
    const download = await downloadPending; expect(await download.failure()).toBeNull();
    const csv = fs.readFileSync(await download.path(), 'utf8'); expect(csv.trim().split(/\r?\n/)).toHaveLength(52);
    for (const record of records) expect(csv).toContain(record.attorneyEmail);
    expect(await Packet.find().sort({ _id: 1 }).lean()).toEqual(packetSnapshot);
    expect(await Task.find({ targetType: 'marketing_draft_packet' }).sort({ _id: 1 }).lean()).toEqual(taskSnapshot);
    expect(await Cycle.countDocuments()).toBe(2); expect(await Record.countDocuments()).toBe(51);
    expect(await require('../../../models/MarketingPublishIntent').countDocuments()).toBe(0);
    expect(await require('../../../models/MarketingPublishAttempt').countDocuments()).toBe(0);
    for (const record of await Record.find().lean()) { expect(record.commissionPayoutStatus).toBe('unpaid'); expect(record.commissionPaymentVersion).toBe(0); }
    const mutations = server.evidence().requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method));
    for (const mutation of mutations) expect(mutation.path).toMatch(/^\/api\/admin\/(?:knowledge\/sync|marketing\/(?:publishing\/(?:settings|cycles)|draft-packets\/[a-f0-9]+\/publish-readiness|founder-daily-log\/refresh))$/);
    expect(server.evidence().external.mail).toHaveLength(0); expect(server.evidence().external.storage).toHaveLength(0);
  } finally { await context.close(); }
});
