const fs = require('fs'), path = require('path'), assert = require('assert/strict'), { randomBytes } = require('crypto'), { spawn } = require('child_process');
process.env.LPC_LIFECYCLE_RANDOM_PORT = 'true'; process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const out = path.resolve(process.env.LPC_ADMIN_JOURNEY_OUTPUT || path.join(__dirname, '../../outputs/admin-os/journey')); fs.mkdirSync(out, { recursive: true });
(async () => {
  let server, browser, result;
  try {
    server = await require('../tests/helpers/financialLifecycleBrowserServer')({ includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true, includeDirectors: true, includeSyntheticMail: true });
    const mongoose = require('mongoose'), User = require('../models/User'), Ticket = require('../models/SupportTicket');
    const owner = await server.createUser('admin'), member = await server.createUser('attorney');
    const requester = await User.findById(member.id).lean();
    const applicant = await User.create({ firstName: 'Casey', lastName: 'Applicant', email: 'owner-journey-applicant@example.test', password: 'Synthetic application password', role: 'attorney', status: 'pending', emailVerified: true, state: 'CA', location: 'Los Angeles, CA', barNumber: 'SYN-2042', attorneyGoodStanding: true, attorneyPricingAccepted: true, termsAccepted: true, createdAt: new Date(Date.now() - 3600000) });
    const inquiry = await Ticket.create({ subject: 'Profile update question', message: 'How do I update my profile?', requestKind: 'human', requesterUserId: member.id, requesterEmail: requester.email, requesterRole: 'attorney', status: 'open' });
    const uri = mongoose.connection.getClient().s.url;
    assert(uri.startsWith('mongodb://127.0.0.1:')); assert.equal(mongoose.connection.name, server.ownedDatabaseName);
    const worker = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'run-admin-preparation.js')], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, MONGO_URI: uri, ADMIN_OS_TEST_DB: server.ownedDatabaseName }, stdio: ['ignore', 'pipe', 'pipe'] }); let text = '';
      child.stdout.on('data', value => text += value); child.stderr.on('data', value => text += value); child.on('error', reject); child.on('exit', code => code === 0 ? resolve(text.trim()) : reject(Error('Preparation worker exited ' + code + ': ' + text)));
    });
    fs.writeFileSync(path.join(out, 'browser-closed-worker.txt'), worker);
    const Work = require('../models/AdminWorkPreparation'); assert.equal(await Work.countDocuments({ status: 'prepared' }), 2);
    const { chromium } = require('playwright'), { expect } = require('playwright/test'); browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: path.join(out, 'video') } }); await context.addCookies([owner.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); const started = performance.now();
    page.on('response', async response => { if (response.request().method() === 'POST' && response.url().includes('/api/admin/support/')) { const body = await response.json().catch(() => null); fs.writeFileSync(path.join(out, 'support-result.json'), JSON.stringify({status:response.status(),body},null,2)); } });
    await page.goto(server.origin + '/admin-dashboard.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#adminFlow')).toBeVisible(); await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#approveUserBtn')).toBeEnabled();
    await expect(page.locator('#adminFlowReason')).toContainText('No information request is needed');
    await expect(page.locator('#adminFlowReason')).not.toContainText('still needed');
    await page.screenshot({ path: path.join(out, 'overview-application.png'), fullPage: true });
    await page.locator('#approveUserBtn').click();
    await expect.poll(async () => (await User.findById(applicant._id).lean()).status).toBe('approved');
    await expect(page.locator('#adminReplyText')).toBeVisible();
    await page.locator('#adminReplyText').fill('You can update your profile from Profile Settings in your workspace.');
    await page.screenshot({ path: path.join(out, 'overview-human-reply.png'), fullPage: true });
    await page.locator('#adminReplySend').click();
    await page.getByRole('button', { name: 'Send email', exact: true }).click();
    await expect.poll(async () => (await Ticket.findById(inquiry._id).lean()).emailReplies.filter(reply => reply.delivery === 'accepted').length).toBe(1);
    await expect.poll(async () => { const result = await context.request.get(server.origin + '/api/admin/workspace/flow'); return (await result.json()).remaining; }).toBe(0);
    await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
    await page.screenshot({ path: path.join(out, 'overview-decisions-complete.png'), fullPage: true });
    const elapsedMs = Math.round(performance.now() - started); assert.deepEqual(errors, []);
    for (const width of [390, 320]) { await page.setViewportSize({ width, height: 900 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.screenshot({ path: path.join(out, `complete-${width}.png`), fullPage: true }); }
    result = { status: 'passed', browserClosedWorker: true, preparedBeforeBrowserOpened: 2, admissionStatus: (await User.findById(applicant._id)).status, acceptedReplies: (await Ticket.findById(inquiry._id)).emailReplies.filter(row => row.delivery === 'accepted').length, remainingDecisions: 0, automatedBrowserElapsedMs: elapsedMs, limitations: ['Automated browser interaction time does not measure human review or credential verification.', 'Actual mounted APIs and local database; mail and storage providers substituted.', 'Missing hosted mailbox/scheduler evidence remains visible; no false all-clear was required.'] };
    await context.close();
  } finally { await browser?.close(); await server?.close(); }
  result.cleanupComplete = true;
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; });
