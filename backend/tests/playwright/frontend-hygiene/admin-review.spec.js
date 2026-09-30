const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
const fs = require('node:fs/promises');
const AxeBuilder = require('@axe-core/playwright').default;
let server, contexts = [];
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeAdminSupport: true }); });
test.beforeEach(async () => server.reset());
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  expect(server.evidence().assets.filter(asset => asset.status >= 400)).toEqual([]);
});
test.afterAll(async () => server?.close());
async function adminPage(browser) {
  const actor = await server.createUser('admin');
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  contexts.push(context); await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.origin + '/admin-dashboard.html?view=queue#user-management');
  await page.waitForFunction(() => typeof window.reviewAdminApplicant === 'function' && typeof window.renderAdminAccount === 'function' && typeof window.openSupportTicketInAdmin === 'function');
  return { page, actor, errors };
}
async function openAccount(page, account) {
  await page.evaluate(id => window.reviewAdminApplicant(id), account.id);
  await expect(page.locator('#adminDecisionNote')).toBeVisible();
}
test('System distinguishes configured approval policy from actual scheduled execution', async ({ browser }, info) => {
  const { page, errors } = await adminPage(browser);
  const State = require('../../../models/AutomationCycleState');
  await require('../../../models/AutonomyPreference').create({ agentRole: 'CMO', actionType: 'marketing_publish', mode: 'auto', learnedFromCount: 5 });
  await page.evaluate(() => window.activateAdminSection('ai-control-room'));
  await page.locator('#adminAutomationRefresh').click();
  await expect(page.locator('#adminAutomationStatus')).toContainText('No scheduled automation run has been recorded.');
  await expect(page.locator('#adminAutomationPolicies')).toContainText('Automatic approval configured');
  expect(await State.countDocuments({})).toBe(0);
  await State.create({ _id: 'scheduled', runId: 'synthetic-run', status: 'completed', startedAt: new Date(Date.now() - 20 * 60000), finishedAt: new Date(Date.now() - 19 * 60000) });
  await page.locator('#adminAutomationRefresh').click();
  await expect(page.locator('#adminAutomationStatus')).toContainText('No recent scheduled automation check-in.');
  await State.updateOne({ _id: 'scheduled' }, { $set: { status: 'failed', startedAt: new Date(), finishedAt: new Date(), failedTasks: ['governedApprovals'] } });
  await page.locator('#adminAutomationRefresh').click();
  await expect(page.locator('#adminAutomationStatus')).toContainText('The latest scheduled automation run needs attention.');
  await expect(page.locator('#adminAutomationStatus')).toContainText('Needs review: Automatic approvals.');
  expect((await State.findById('scheduled')).runId).toBe('synthetic-run');
  await page.screenshot({ path: info.outputPath('scheduled-work-status.png'), fullPage: true });
  expect(errors).toEqual([]);
});
async function expectNoAutomaticToast(page) {
  expect(await page.locator('#toastBanner').evaluate(node => node.classList.contains('show'))).toBe(false);
}
async function persistedNotes(account) {
  return require('../../../models/AuditLog').find({ action: 'admin.user.note_added', targetId: account.id }).lean();
}
async function holdNoteAcknowledgement(page, account) {
  return holdAcknowledgement(page, `**/api/admin/workspace/accounts/${account.id}/note`);
}
async function holdAcknowledgement(page, pattern) {
  let arrive, release;
  const waiting = new Promise(resolve => { arrive = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(pattern, async route => {
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    arrive(); await gate; await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  return { waiting, release };
}
test('account history includes the newly saved internal note without reopening the review', async ({ browser }, info) => {
  const { page, errors } = await adminPage(browser), account = await server.createUser('paralegal');
  await openAccount(page, account);
  const text = 'Verified professional references for this account.';
  await page.locator('#adminDecisionNote').fill(text);
  await page.getByRole('button', { name: 'Save internal note', exact: true }).click();
  await expect(page.locator('#adminAccountResult')).toHaveText('Internal note saved.');
  const notes = await persistedNotes(account); expect(notes).toHaveLength(1); expect(notes[0].meta.note).toBe(text);
  const response = await page.request.get(server.origin + `/api/admin/workspace/accounts/${account.id}`);
  expect(response.ok()).toBe(true); expect((await response.json()).history.map(entry => entry.meta?.note)).toContain(text);
  await page.locator('[data-account-tab="history"]').click();
  await expect(page.locator('[data-account-panel="history"]')).toContainText(text);
  await page.screenshot({ path: info.outputPath('saved-note-history.png') });
  expect(errors).toEqual([]);
});
test('a delayed note acknowledgement preserves text typed for the next note', async ({ browser }) => {
  const { page, errors } = await adminPage(browser), account = await server.createUser('paralegal');
  await openAccount(page, account);
  const gate = await holdNoteAcknowledgement(page, account);
  try {
    await page.locator('#adminDecisionNote').fill('First verified reference.');
    await page.getByRole('button', { name: 'Save internal note', exact: true }).click(); await gate.waiting;
    await page.locator('#adminDecisionNote').fill('Second reference still being checked.');
    gate.release();
    await expect(page.getByRole('button', { name: 'Save internal note', exact: true })).toBeEnabled();
    await expect(page.locator('#adminDecisionNote')).toHaveValue('Second reference still being checked.');
    const notes = await persistedNotes(account); expect(notes).toHaveLength(1); expect(notes[0].meta.note).toBe('First verified reference.');
    expect(errors).toEqual([]);
  } finally { gate.release(); }
});
test('a delayed note acknowledgement cannot clear a different account editor', async ({ browser }) => {
  const { page, errors } = await adminPage(browser), first = await server.createUser('paralegal'), second = await server.createUser('attorney');
  await openAccount(page, first);
  const gate = await holdNoteAcknowledgement(page, first);
  try {
    await page.locator('#adminDecisionNote').fill('First account reference verified.');
    await page.getByRole('button', { name: 'Save internal note', exact: true }).click(); await gate.waiting;
    await openAccount(page, second);
    await page.locator('#adminDecisionNote').fill('Unsent note for the second account.');
    const cleanup = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/drafts/account/${first.id}`));
    gate.release(); await cleanup;
    await expect(page.locator('#adminDecisionNote')).toHaveValue('Unsent note for the second account.');
    await expect(page.locator('#adminAccountResult')).toHaveText('');
    expect(await persistedNotes(first)).toHaveLength(1); expect(await persistedNotes(second)).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally { gate.release(); }
});
test('history failures remain explicit and retry returns the saved account activity', async ({ browser }) => {
  const { page, errors } = await adminPage(browser), account = await server.createUser('paralegal');
  await openAccount(page, account);
  await page.locator('#adminDecisionNote').fill('Credential review recorded.');
  await page.getByRole('button', { name: 'Save internal note', exact: true }).click();
  await expect(page.locator('#adminAccountResult')).toHaveText('Internal note saved.');
  await page.route(`**/api/admin/workspace/accounts/${account.id}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Account history is temporarily unavailable.' }) }), { times: 1 });
  await page.locator('[data-account-tab="history"]').click();
  const panel = page.locator('[data-account-panel="history"]');
  await expect(panel.getByRole('alert')).toHaveText('Account history is temporarily unavailable.');
  await expectNoAutomaticToast(page);
  await expect(panel).not.toContainText('No activity'); await expect(panel).not.toContainText('Credential review recorded.');
  await panel.getByRole('button', { name: 'Retry history', exact: true }).click();
  await expect(panel).toContainText('Credential review recorded.');
  expect(await persistedNotes(account)).toHaveLength(1); expect(errors).toEqual([]);
});
test('a history response for an earlier account cannot replace the current account history', async ({ browser }) => {
  const { page, errors } = await adminPage(browser), first = await server.createUser('paralegal'), second = await server.createUser('attorney');
  await openAccount(page, first);
  await page.locator('#adminDecisionNote').fill('Private history for the first account.');
  await page.getByRole('button', { name: 'Save internal note', exact: true }).click();
  await expect(page.locator('#adminAccountResult')).toHaveText('Internal note saved.');
  let arrive, release;
  const waiting = new Promise(resolve => { arrive = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/admin/workspace/accounts/${first.id}`, async route => {
    const response = await route.fetch(); expect(response.ok()).toBe(true); arrive(); await gate; await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  try {
    await page.locator('[data-account-tab="history"]').click(); await waiting;
    await openAccount(page, second);
    await page.locator('[data-account-tab="history"]').click();
    const panel = page.locator('[data-account-panel="history"]');
    await expect(panel).toHaveText('No activity or correspondence yet.');
    const completed = page.waitForResponse(response => response.url().endsWith(`/accounts/${first.id}`));
    release(); await completed;
    await expect(panel).toHaveText('No activity or correspondence yet.');
    await expect(panel).not.toContainText('Private history for the first account.');
    expect(errors).toEqual([]);
  } finally { release(); }
});
test('a private draft cleanup failure does not undo the confirmed internal note', async ({ browser }) => {
  const { page, errors } = await adminPage(browser), account = await server.createUser('paralegal');
  await openAccount(page, account);
  await page.locator('#adminDecisionNote').fill('Recorded note with a recoverable draft cleanup.');
  await page.evaluate(() => window.flushAdminAccountDraft());
  await page.route(`**/api/admin/workspace/drafts/account/${account.id}`, async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The private draft could not be saved.' }) });
  }, { times: 1 });
  await page.getByRole('button', { name: 'Save internal note', exact: true }).click();
  await expect(page.locator('#adminAccountResult')).toHaveText('Internal note saved.');
  const draft = page.locator(`[data-draft-state="account:${account.id}"]`);
  await expect(draft).toContainText('The private draft could not be saved.');
  await expectNoAutomaticToast(page);
  await expect(page.locator('#adminDecisionNote')).toHaveValue('');
  expect(await persistedNotes(account)).toHaveLength(1);
  await draft.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect(draft).toContainText('Draft saved privately');
  expect(await persistedNotes(account)).toHaveLength(1); expect(errors).toEqual([]);
});
test('a delayed information-request acknowledgement stays with its original applicant', async ({ browser }) => {
  const { page, errors } = await adminPage(browser), first = await server.createUser('paralegal'), second = await server.createUser('attorney');
  await require('../../../models/User').updateOne({ _id: first.id }, { $set: { status: 'pending' } });
  await openAccount(page, first);
  const gate = await holdAcknowledgement(page, `**/api/admin/workspace/accounts/${first.id}/information-request`);
  try {
    await page.locator('#adminInformationText').fill('Please provide the requested professional reference.');
    await page.getByRole('button', { name: 'Send information request', exact: true }).click();
    await page.getByRole('button', { name: 'Send request', exact: true }).click(); await gate.waiting;
    await openAccount(page, second);
    await page.locator('#adminDecisionNote').fill('The second account still needs its own review.');
    const cleanup = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/drafts/account/${first.id}`));
    gate.release(); await cleanup;
    await expect(page.locator('#pendingUserModal')).toHaveAttribute('data-admin-account-id', second.id);
    await expect(page.locator('#adminAccountResult')).toHaveText('');
    await expect(page.locator('#adminDecisionNote')).toHaveValue('The second account still needs its own review.');
    const requests = await require('../../../models/SupportTicket').find({ requesterUserId: first.id, administrativeRequestKey: { $exists: true } }).lean();
    expect(requests).toHaveLength(1);
    const attempts = server.evidence().external.mail;
    expect(attempts).toHaveLength(1);
    expect(attempts[0][0]).toBe((await require('../../../models/User').findById(first.id).lean()).email);
    expect(attempts[0][2]).toContain('Please provide the requested professional reference.');
    await openAccount(page, first);
    await expect(page.locator('#adminInformationText')).toHaveValue('Please provide the requested professional reference.');
    await expect(page.locator('#adminInformationText')).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: 'Check or retry saved request', exact: true }).click();
    await page.getByRole('button', { name: 'Send request', exact: true }).click();
    await expect(page.locator('#adminAccountResult')).toHaveText('Information request recorded. Email unknown.');
    expect(server.evidence().external.mail).toHaveLength(1);
    expect(await require('../../../models/SupportTicket').countDocuments({ requesterUserId: first.id, administrativeRequestKey: { $exists: true } })).toBe(1);
    expect(errors).toEqual([]);
  } finally { gate.release(); }
});
test('a delayed access-change acknowledgement cannot reopen the previous account', async ({ browser }) => {
  const { page, errors } = await adminPage(browser), first = await server.createUser('paralegal'), second = await server.createUser('attorney');
  await openAccount(page, first);
  const gate = await holdAcknowledgement(page, `**/api/admin/disable/${first.id}`);
  // Observe the existing post-write list refresh without changing its behavior.
  await page.evaluate(() => {
    const refresh = window.refreshAdminUsers;
    window.adminReviewMutationRefreshes = 0;
    window.refreshAdminUsers = function(...args) { const result = refresh.apply(this, args); window.adminReviewMutationRefreshes++; return result; };
  });
  try {
    await page.getByText('Account access & exceptions', { exact: true }).click();
    await page.getByRole('button', { name: 'Suspend account', exact: true }).click();
    const prompt = page.getByRole('dialog', { name: 'Account access', exact: true });
    await prompt.getByRole('textbox').fill('Synthetic review of this account.');
    await prompt.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Suspend', exact: true }).click(); await gate.waiting;
    await openAccount(page, second);
    await page.locator('#adminDecisionNote').fill('Keep this account review open.');
    gate.release();
    await expect.poll(() => page.evaluate(() => window.adminReviewMutationRefreshes)).toBe(1);
    await expect(page.locator('#pendingUserModal')).toHaveAttribute('data-admin-account-id', second.id);
    await expect(page.locator('#adminDecisionNote')).toHaveValue('Keep this account review open.');
    expect((await require('../../../models/User').findById(first.id).lean()).disabled).toBe(true);
    expect((await require('../../../models/User').findById(second.id).lean()).disabled).not.toBe(true);
    expect(errors).toEqual([]);
  } finally { gate.release(); }
});
test('stale inquiry follow-up preserves the draft and the newer saved owner instructions', async ({ browser }) => {
  const { page, errors } = await adminPage(browser);
  const Ticket = require('../../../models/SupportTicket');
  const ticket = await Ticket.create({ subject: 'Concurrent follow-up', message: 'Please review.', requesterRole: 'attorney', nextAction: 'Original action' });
  await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await page.getByText('Follow-up & assignment', { exact: true }).click();
  await page.locator('#adminInquiryNext').fill('Keep this unsaved draft');
  await Ticket.collection.updateOne({ _id: ticket._id }, { $set: { nextAction: 'Newer saved action' } });
  await page.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(page.locator('#adminTriageResult')).toContainText('This inquiry changed.');
  await expect(page.locator('#adminInquiryNext')).toHaveValue('Keep this unsaved draft');
  await expect(page.getByRole('button', { name: 'Save follow-up', exact: true })).toBeEnabled();
  expect((await Ticket.findById(ticket._id).lean()).nextAction).toBe('Newer saved action');
  expect(errors).toEqual([]);
});

test('inquiry ownership acknowledgement updates the visible summary and preserves newer form edits', async ({ browser }) => {
  const { page, actor, errors } = await adminPage(browser);
  const Ticket = require('../../../models/SupportTicket');
  const ticket = await Ticket.create({ subject: 'Ownership review', message: 'Please review the assigned follow-up.', requesterRole: 'attorney' });
  await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await page.getByText('Ownership & follow-up', { exact: true }).click();
  const gate = await holdAcknowledgement(page, `**/api/admin/support/tickets/${ticket._id}/triage`);
  try {
    await page.locator('#adminInquiryOwner').selectOption(actor.id);
    await page.locator('#adminInquiryDue').fill('2027-03-14T15:30');
    await page.locator('#adminInquiryNext').fill('Verify the reference.');
    await page.getByRole('button', { name: 'Save ownership & follow-up', exact: true }).click(); await gate.waiting;
    await page.locator('#adminInquiryNext').fill('A newer follow-up that is not saved yet.');
    gate.release();
    await expect(page.getByRole('button', { name: 'Save ownership & follow-up', exact: true })).toBeEnabled();
    const owner = await require('../../../models/User').findById(actor.id).lean();
    const summary = page.locator('#adminInboxDetail p.admin-row-meta').filter({ hasText: /^Owner:/ });
    await expect(summary).toContainText([owner.firstName, owner.lastName].filter(Boolean).join(' '));
    await expect(summary).toContainText('Follow up');
    await expect(page.locator('#adminInquiryNext')).toHaveValue('A newer follow-up that is not saved yet.');
    expect((await Ticket.findById(ticket._id).lean()).nextAction).toBe('Verify the reference.');
    expect(errors).toEqual([]);
  } finally { gate.release(); }
});
for (const destination of ['another account', 'closed review']) test(`a delayed account fetch cannot replace ${destination}`, async ({ browser }) => {
  const { page, errors } = await adminPage(browser), first = await server.createUser('paralegal'), second = await server.createUser('attorney');
  await openAccount(page, first);
  const gate = await holdAcknowledgement(page, `**/api/admin/users/${first.id}`);
  try {
    await page.evaluate(id => { window.pendingAccountFetch = window.reviewAdminApplicant(id); }, first.id); await gate.waiting;
    if (destination === 'another account') {
      await openAccount(page, second);
      await page.locator('#adminDecisionNote').fill('Current review draft.');
    } else await page.locator('#closePendingModal').click();
    gate.release(); await page.evaluate(() => window.pendingAccountFetch);
    if (destination === 'another account') {
      await expect(page.locator('#pendingUserModal')).toHaveAttribute('data-admin-account-id', second.id);
      await expect(page.locator('#adminDecisionNote')).toHaveValue('Current review draft.');
    } else await expect(page.locator('#pendingUserModal')).toBeHidden();
    expect(errors).toEqual([]);
  } finally { gate.release(); }
});
test('a delayed inquiry note acknowledgement preserves the next private note', async ({ browser }) => {
  const { page, errors } = await adminPage(browser);
  const Ticket = require('../../../models/SupportTicket');
  const ticket = await Ticket.create({ subject: 'Inquiry note review', message: 'Please review my question.', requesterRole: 'attorney' });
  await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await page.getByText('Internal notes & status', { exact: true }).click();
  const gate = await holdAcknowledgement(page, `**/api/admin/support/tickets/${ticket._id}/note`);
  try {
    await page.locator('#adminInternalNote').fill('First internal note recorded.');
    await page.getByRole('button', { name: 'Save note', exact: true }).click(); await gate.waiting;
    await page.locator('#adminInternalNote').fill('Next private note still in progress.');
    gate.release();
    await expect(page.locator('#adminInboxDetail')).toContainText('First internal note recorded.');
    await expect(page.locator('#adminInternalNote')).toHaveValue('Next private note still in progress.');
    const saved = await Ticket.findById(ticket._id).lean();
    expect(saved.internalNotes).toHaveLength(1); expect(saved.internalNotes[0].text).toBe('First internal note recorded.');
    expect(errors).toEqual([]);
  } finally { gate.release(); }
});
test('a saved inquiry note remains successful when private draft cleanup needs a retry', async ({ browser }) => {
  const { page, errors } = await adminPage(browser);
  const Ticket = require('../../../models/SupportTicket');
  const ticket = await Ticket.create({ subject: 'Private note cleanup', message: 'Please review my question.', requesterRole: 'attorney' });
  await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await page.getByText('Internal notes & status', { exact: true }).click();
  await page.locator('#adminInternalNote').fill('This note is saved independently of the private draft.');
  await page.evaluate(() => window.flushAdminInquiryDraft());
  await page.route(`**/api/admin/workspace/drafts/inquiry/${ticket._id}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Private draft cleanup is unavailable.' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.locator('#adminInternalResult')).toHaveText('Note saved.');
  const draft = page.locator(`[data-draft-state="inquiry:${ticket._id}"]`);
  await expect(draft).toContainText('Private draft cleanup is unavailable.');
  await expectNoAutomaticToast(page);
  await expect(page.locator('#adminInternalNote')).toHaveValue('');
  await expect(page.locator('#adminInquiryNotes')).toContainText('This note is saved independently of the private draft.');
  expect((await Ticket.findById(ticket._id).lean()).internalNotes).toHaveLength(1);
  await draft.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect(draft).toContainText('Draft saved privately');
  expect((await Ticket.findById(ticket._id).lean()).internalNotes).toHaveLength(1); expect(errors).toEqual([]);
});
test('a failed inquiry follow-up keeps the form and succeeds on an explicit retry', async ({ browser }) => {
  const { page, actor, errors } = await adminPage(browser);
  const Ticket = require('../../../models/SupportTicket');
  const ticket = await Ticket.create({ subject: 'Follow-up recovery', message: 'Please review my question.', requesterRole: 'attorney' });
  await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await page.getByText('Ownership & follow-up', { exact: true }).click();
  await page.locator('#adminInquiryOwner').selectOption(actor.id);
  await page.locator('#adminInquiryNext').fill('Verify the applicant reference.');
  await page.route(`**/api/admin/support/tickets/${ticket._id}/triage`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Follow-up could not be saved.' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Save ownership & follow-up', exact: true }).click();
  await expect(page.locator('#adminTriageResult')).toHaveText('Follow-up could not be saved.');
  await expect(page.locator('#adminInquiryNext')).toHaveValue('Verify the applicant reference.');
  await expect(page.locator('#adminInquirySummary')).toContainText('Unassigned');
  expect((await Ticket.findById(ticket._id).lean()).assignedTo).toBeFalsy();
  await page.getByRole('button', { name: 'Save ownership & follow-up', exact: true }).click();
  await expect(page.locator('#adminTriageResult')).toHaveText('Saved.');
  expect(String((await Ticket.findById(ticket._id).lean()).assignedTo)).toBe(actor.id);
  await page.locator('#adminInquiryNext').fill('A later unsaved change.');
  await expect(page.locator('#adminTriageResult')).toHaveText('Unsaved changes.');
  expect(errors).toEqual([]);
});
test('an unconfirmed inquiry email remains visible and retry does not send it twice', async ({ browser }) => {
  const { page, errors } = await adminPage(browser);
  const Ticket = require('../../../models/SupportTicket');
  const ticket = await Ticket.create({ subject: 'Email follow-up', message: 'Please review my question.', requesterRole: 'attorney', requesterEmail: 'visitor@example.test' });
  await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await page.locator('#adminReplyText').fill('We are reviewing your question.');
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await page.getByRole('dialog', { name: 'Send email reply', exact: true }).getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.locator('#adminReplyResult')).toContainText('outcome is unconfirmed');
  await expect(page.locator('.admin-conversation')).toContainText('We are reviewing your question.');
  await expect(page.locator('.admin-conversation')).toContainText('Email unknown');
  await expect(page.locator('#adminReplyText')).toHaveAttribute('readonly', '');
  await expect(page.locator('#adminReplySend')).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await expect(page.locator('#adminReplyText')).toHaveValue('We are reviewing your question.');
  await page.getByRole('button', { name: 'Check or retry saved reply', exact: true }).click();
  await page.getByRole('dialog', { name: 'Send email reply', exact: true }).getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.locator('#adminReplyResult')).toContainText('outcome is unconfirmed');
  const saved = await Ticket.findById(ticket._id).lean();
  expect(saved.emailReplies).toHaveLength(1); expect(saved.emailReplies[0].delivery).toBe('unknown');
  expect(saved.status).toBe('open'); expect(server.evidence().external.mail).toHaveLength(1); expect(errors).toEqual([]);
});
test('a confirmed conversation reply survives private draft cleanup failure without resetting other editors', async ({ browser }) => {
  const { page, errors } = await adminPage(browser), requester = await server.createUser('attorney');
  const conversation = await require('../../../models/SupportConversation').create({ userId: requester.id, role: 'attorney', status: 'open' });
  const Message = require('../../../models/SupportMessage'), Ticket = require('../../../models/SupportTicket');
  await Message.create({ conversationId: conversation._id, sender: 'user', text: 'Please review my question.' });
  const ticket = await Ticket.create({ subject: 'Conversation follow-up', message: 'Please review my question.', requesterRole: 'attorney', requesterUserId: requester.id, conversationId: conversation._id });
  await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await page.getByText('Internal notes & status', { exact: true }).click();
  await page.locator('#adminInternalNote').fill('Keep this private investigation note.');
  await page.locator('#adminReplyText').fill('The LPC team is reviewing your question.');
  await page.evaluate(() => window.flushAdminInquiryDraft());
  let cleanupFailed = false;
  await page.route(`**/api/admin/workspace/drafts/inquiry/${ticket._id}`, async route => {
    if (!cleanupFailed && route.request().method() === 'PUT' && route.request().postDataJSON().text === '') {
      cleanupFailed = true;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Private draft cleanup is unavailable.' }) });
    }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await expect(page.locator('#adminReplyResult')).toHaveText('Reply sent to the conversation.');
  await expect(page.locator('.admin-conversation')).toContainText('The LPC team is reviewing your question.');
  await expect(page.locator('#adminInternalNote')).toBeVisible();
  await expect(page.locator('#adminInternalNote')).toHaveValue('Keep this private investigation note.');
  await expect(page.locator('#adminReplyText')).toHaveValue('');
  const draft = page.locator(`[data-draft-state="inquiry:${ticket._id}"]`);
  await expect(draft).toContainText('Private draft cleanup is unavailable.');
  await expectNoAutomaticToast(page);
  expect(await Message.countDocuments({ conversationId: conversation._id, 'metadata.kind': 'team_reply' })).toBe(1);
  await draft.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect(draft).toContainText('Draft saved privately');
  expect(await Message.countDocuments({ conversationId: conversation._id, 'metadata.kind': 'team_reply' })).toBe(1);
  expect((await Ticket.findById(ticket._id).lean()).status).toBe('waiting_on_user');
  expect(server.evidence().external.mail).toHaveLength(0); expect(errors).toEqual([]);
});
test('an unavailable email recipient keeps the existing private reply draft readable and recoverable', async ({ browser }) => {
  const { page, errors } = await adminPage(browser);
  const Ticket = require('../../../models/SupportTicket');
  const ticket = await Ticket.create({ subject: 'Recipient recovery', message: 'Please review my question.', requesterRole: 'attorney', requesterEmail: 'visitor@example.test' });
  await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await page.locator('#adminReplyText').fill('An unfinished reply that must remain available.');
  await page.evaluate(() => window.flushAdminInquiryDraft());
  await Ticket.updateOne({ _id: ticket._id }, { $set: { requesterEmail: '' } });
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await expect(page.locator('#adminReplyForm')).toContainText('No reply email is recorded.');
  await expect(page.locator('#adminReplyText')).toBeHidden();
  await page.getByText('Saved reply draft', { exact: true }).click();
  await expect(page.locator('#adminReplyForm details').filter({ has: page.getByText('Saved reply draft', { exact: true }) })).toContainText('An unfinished reply that must remain available.');
  await Ticket.updateOne({ _id: ticket._id }, { $set: { requesterEmail: 'visitor@example.test' } });
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await expect(page.locator('#adminReplyText')).toBeVisible();
  await expect(page.locator('#adminReplyText')).toHaveValue('An unfinished reply that must remain available.');
  expect(server.evidence().external.mail).toHaveLength(0); expect(errors).toEqual([]);
});
for (const operation of ['account note', 'inquiry note', 'inquiry follow-up']) test(`the guided queue waits for an acknowledged ${operation}`, async ({ browser }) => {
  const { page, actor, errors } = await adminPage(browser);
  let id, pattern;
  if (operation === 'account note') {
    const account = await server.createUser('paralegal'); id = account.id;
    await require('../../../models/User').updateOne({ _id: id }, { $set: { status: 'pending' } });
    pattern = `**/api/admin/workspace/accounts/${id}/note`;
  } else {
    const ticket = await require('../../../models/SupportTicket').create({ subject: 'Guided inquiry follow-up', message: 'A question for the LPC team.', requesterRole: 'attorney' });
    id = String(ticket._id); pattern = `**/api/admin/support/tickets/${id}/${operation === 'inquiry note' ? 'note' : 'triage'}`;
  }
  await page.locator('#sidebarNav [data-section="overview"]').click();
  const body = page.locator('#adminFlowBody');
  const gate = await holdAcknowledgement(page, pattern);
  try {
    if (operation === 'account note') {
      await expect(body.getByText('A protected résumé is required before approving this paralegal.', { exact: true })).toHaveCount(1);
      await expect(body.locator('.admin-checklist').getByText(/^Resume: missing/)).toHaveCount(0);
      await expect(page.locator('#adminFlowActions #approveUserBtn')).toBeDisabled();
      await body.getByText('Internal note', { exact: true }).click();
      await body.locator('#adminDecisionNote').fill('Guided account review recorded.');
      await body.getByRole('button', { name: 'Save internal note', exact: true }).click();
    } else if (operation === 'inquiry note') {
      await body.getByText('Internal notes & status', { exact: true }).click();
      await body.locator('#adminInternalNote').fill('Guided inquiry note recorded.');
      await body.getByRole('button', { name: 'Save note', exact: true }).click();
    } else {
      await body.getByText('Ownership & follow-up', { exact: true }).click();
      await body.locator('#adminInquiryOwner').selectOption(actor.id);
      await body.locator('#adminInquiryNext').fill('Check the next reference.');
      await body.getByRole('button', { name: 'Save ownership & follow-up', exact: true }).click();
    }
    await gate.waiting;
    await expect(page.locator('#adminFlowLater')).toBeDisabled();
    await expect(page.locator('#adminFlowRefresh')).toBeDisabled();
    gate.release();
    await expect(page.locator('#adminFlowLater')).toBeEnabled();
    const result = operation === 'account note' ? '#adminAccountResult' : operation === 'inquiry note' ? '#adminInternalResult' : '#adminTriageResult';
    await expect(body.locator(result)).toContainText(/saved/i);
    if (operation === 'account note') expect(await persistedNotes({ id })).toHaveLength(1);
    else {
      const saved = await require('../../../models/SupportTicket').findById(id).lean();
      if (operation === 'inquiry note') expect(saved.internalNotes).toHaveLength(1);
      else expect(String(saved.assignedTo)).toBe(actor.id);
    }
    expect(errors).toEqual([]);
  } finally { gate.release(); }
});
test('inquiry pagination appears only for multiple pages and search returns to the first page', async ({ browser }) => {
  const { page, errors } = await adminPage(browser);
  const Ticket = require('../../../models/SupportTicket');
  await Ticket.create(Array.from({ length: 21 }, (_, index) => ({ subject: `Queue reference ${String(index).padStart(2, '0')}`, message: 'A synthetic inquiry for pagination acceptance.', requesterRole: 'attorney' })));
  await page.locator('#sidebarNav [data-section="support-ops"]').click();
  const queue = page.locator('.admin-inbox-queue');
  await expect(queue.locator('#adminInboxPage')).toHaveText('Page 1 of 2');
  await expect(queue.locator('[data-inbox-ticket]')).toHaveCount(20);
  await queue.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(queue.locator('#adminInboxPage')).toHaveText('Page 2 of 2');
  await expect(queue.locator('[data-inbox-ticket]')).toHaveCount(1);
  await expect(queue.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await queue.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(queue.locator('#adminInboxPage')).toHaveText('Page 1 of 2');
  await queue.getByLabel('Search inquiries', { exact: true }).fill('Queue reference 20');
  await expect(queue.locator('[data-inbox-ticket]')).toHaveCount(1);
  await expect(queue.locator('[data-inbox-ticket]')).toContainText('Queue reference 20');
  await expect(queue.locator('.admin-pager')).toBeHidden();
  await queue.getByLabel('Search inquiries', { exact: true }).fill('No matching queue reference');
  await expect(queue).toContainText('No inquiries match these filters');
  await expect(queue.locator('#adminInboxListStatus')).toHaveText('');
  await expect(queue.locator('.admin-pager')).toBeHidden();
  await queue.getByLabel('Search inquiries', { exact: true }).fill('');
  await expect(queue.locator('#adminInboxPage')).toHaveText('Page 1 of 2');
  await expect(queue.locator('.admin-pager')).toBeVisible();
  expect(errors).toEqual([]);
});
for (const [variant, width, dark, enlarged] of [['desktop-light', 1366, false, false], ['phone-dark', 390, true, false], ['narrow-dark-enlarged', 320, true, true]]) test(`account and inquiry controls remain readable and operable: ${variant}`, async ({ browser }, info) => {
  const { page, actor, errors } = await adminPage(browser), account = await server.createUser(variant === 'phone-dark' ? 'attorney' : 'paralegal');
  if (dark) await require('../../../models/User').updateOne({ _id: account.id }, { $set: { status: 'pending', firstName: 'Alexandria', lastName: 'Montgomery-Washington', bio: 'Experienced professional with complex case research, careful document review and responsive client support.', resumeURL: `paralegal-resumes/${account.id}/professional-reference.pdf` } });
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(({ dark, enlarged }) => {
    document.documentElement.classList.toggle('theme-dark', dark); document.body.classList.toggle('theme-dark', dark);
    document.documentElement.style.fontSize = enlarged ? '200%' : '';
  }, { dark, enlarged });
  await openAccount(page, account);
  const review = page.locator('#adminAccountContext');
  await expect(review.getByText('No introduction has been provided.', { exact: true })).toHaveCount(0);
  await expect(review.getByText(/No document links are recorded/)).toHaveCount(0);
  if (!dark) {
    const background = review.locator('.admin-review-evidence').filter({ has: page.getByText('Background', { exact: true }) });
    await expect(background).toContainText('Immigration');
    await expect(background).toContainText('8 years');
    await expect(review.getByRole('heading', { name: 'Documents & credentials', exact: true })).toHaveCount(0);
    await expect(review.getByText(/before approving this paralegal/)).toHaveCount(0);
    await expect(review.locator('.admin-checklist').getByText(/^Resume: missing/)).toHaveCount(1);
  } else if (variant === 'phone-dark') {
    await expect(review.getByText('No automated credential verification is performed. Review the applicant’s professional details.', { exact: true })).toHaveCount(1);
  }
  const observations = [];
  async function measure(label, selector) {
    const metrics = await page.locator(selector).evaluate(async root => {
      const visible = node => {
        if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') return false;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(node)) return false;
        }
        return true;
      };
      const controls = [...root.querySelectorAll('button, input:not([type=hidden]), select, textarea, summary, a[href]')].filter(visible);
      const values = [];
      for (const node of controls) {
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(resolve));
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        const x = rect.left + rect.width / 2, y = rect.top + Math.min(rect.height / 2, 24), hit = document.elementFromPoint(x, y);
        // Firefox's SVG scroll area can exceed the visibly sized icon. Measure
        // rendered text and icon rectangles for text/icon controls instead.
        const contentRects = [];
        if (node.matches('button,a,summary')) {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (!text.textContent.trim() || text.parentElement.closest('svg') || !visible(text.parentElement)) continue;
            const range = document.createRange(); range.selectNodeContents(text);
            contentRects.push(...Array.from(range.getClientRects(), box => ({ left: box.left, right: box.right })));
          }
          for (const icon of node.querySelectorAll('svg,img')) {
            if (!visible(icon)) continue;
            const box = icon.getBoundingClientRect(); contentRects.push({ left: box.left, right: box.right });
          }
        }
        const contentFits = contentRects.length ? contentRects.every(box => box.left >= rect.left - 1 && box.right <= rect.right + 1) : node.scrollWidth <= node.clientWidth + 1;
        values.push({ id: node.id, selectAppearance: node.tagName === 'SELECT' ? style.appearance : null, selectBackground: node.tagName === 'SELECT' ? style.backgroundImage : null, label: (node.getAttribute('aria-label') || node.textContent || node.name || node.tagName).trim().slice(0, 80), width: rect.width, height: rect.height, fontSize: Number.parseFloat(style.fontSize), disabled: Boolean(node.disabled), contentFits, contentRects, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, contained: rect.left >= -1 && rect.right <= innerWidth + 1, reachable: y >= 0 && y <= innerHeight && (node.disabled || hit === node || node.contains(hit)) });
      }
      const regions = [root, ...root.querySelectorAll('.admin-account-scroll,.admin-tabs,.admin-triage,.admin-inline-actions,.admin-conversation')].filter(visible).map(node => ({ name: node.id || node.className, overflow: node.scrollWidth > node.clientWidth + 1 }));
      const text = [...root.querySelectorAll('p,label,li,td,dt,dd,small,strong,.small,.admin-row-meta,.admin-facts span,.admin-status,.admin-inquiry-identity span')].filter(node => visible(node) && [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())).map(node => ({ label: node.textContent.trim().slice(0, 80), fontSize: Number.parseFloat(getComputedStyle(node).fontSize) }));
      return { controls: values, text, regions, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    const accessibility = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    observations.push({ label, ...metrics, violations: accessibility.violations.map(rule => ({ id: rule.id, nodes: rule.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) })) });
    await page.screenshot({ path: info.outputPath(label + '-bottom.png') });
    await page.locator(selector).evaluate(root => {
      for (const node of [root, ...root.querySelectorAll('.admin-account-scroll')]) node.scrollTo({ top: 0, behavior: 'instant' });
      root.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    await page.screenshot({ path: info.outputPath(label + '-top.png') });
  }
  if (dark) await expect(page.locator('#adminAccountContext').getByRole('link', { name: 'Resume', exact: true })).toHaveAttribute('href', `${server.origin}/api/uploads/view?key=${encodeURIComponent(`paralegal-resumes/${account.id}/professional-reference.pdf`)}`);
  await measure('account-review-' + variant, '#pendingUserModal');
  await page.locator('#adminAccountContext details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  await measure('account-access-' + variant, '#pendingUserModal');
  await page.locator('[data-account-tab="profile"]').click();
  const profileRows = page.locator('#pendingUserDetails tr');
  await expect(profileRows.filter({ has: page.locator('td', { hasText: /^Role$/ }) })).toHaveCount(0);
  await expect(profileRows.filter({ has: page.locator('td', { hasText: /^About$/ }) })).toHaveCount(0);
  if (dark) await expect(profileRows.filter({ has: page.locator('td', { hasText: /^Account access$/ }) })).toContainText('Awaiting approval');
  await measure('account-profile-' + variant, '#pendingUserModal');
  await page.locator('[data-account-tab="history"]').click();
  await expect(page.locator('[data-account-panel="history"]')).toHaveText('No activity or correspondence yet.');
  await measure('account-history-' + variant, '#pendingUserModal');
  await page.locator('#closePendingModal').click();
  const ticket = await require('../../../models/SupportTicket').create({ subject: 'Review account follow-up', message: 'A synthetic inquiry for form acceptance.', requesterRole: 'attorney', requesterEmail: 'visitor@example.test', assignedTo: actor.id, nextAction: 'Check the current application.' });
  await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await expect(page.locator('#adminReplyForm')).toBeVisible();
  await expect(page.locator('#adminReplyText')).toBeVisible();
  await expect(page.getByText('Context & technical details', { exact: true })).toHaveCount(0);
  const queue = page.locator('.admin-inbox-queue');
  if (width <= 760) await page.locator('#adminInboxBack').click();
  await expect(queue.locator(`[data-inbox-ticket="${ticket._id}"]`)).toBeVisible();
  await measure('inquiry-queue-' + variant, '.admin-inbox-queue');
  await measure('inquiry-sources-' + variant, '#section-support-ops>.admin-tabs');
  await queue.getByLabel('Inquiry follow-up', { exact: true }).selectOption('overdue');
  await expect(queue).toContainText('No inquiries match these filters');
  await expect(queue.locator('#adminInboxListStatus')).toHaveText('');
  await expect(queue.locator('.admin-pager')).toBeHidden();
  await measure('inquiry-empty-' + variant, '.admin-inbox-queue');
  await queue.getByLabel('Inquiry follow-up', { exact: true }).selectOption('');
  await expect(queue.locator(`[data-inbox-ticket="${ticket._id}"]`)).toBeVisible();
  await page.route('**/api/admin/support/inbox?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Inquiry list is temporarily unavailable.' }) }), { times: 1 });
  await queue.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(queue.getByRole('alert')).toHaveText('Inquiry list is temporarily unavailable.');
  await expectNoAutomaticToast(page);
  await expect(queue.locator('#adminInboxPage')).toHaveText('');
  await expect(queue.locator('#adminInboxPrev')).toBeDisabled();
  await expect(queue.locator('#adminInboxNext')).toBeDisabled();
  await expect(queue.locator('.admin-pager')).toBeHidden();
  await measure('inquiry-error-' + variant, '.admin-inbox-queue');
  await queue.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(queue.locator(`[data-inbox-ticket="${ticket._id}"]`)).toBeVisible();
  if (width <= 760) await queue.locator(`[data-inbox-ticket="${ticket._id}"]`).click();
  await expect(page.locator('#adminReplyText')).toBeVisible();
  await measure('inquiry-collapsed-' + variant, '#adminInboxDetail');
  await page.locator('#adminInboxDetail details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  await measure('inquiry-expanded-' + variant, '#adminInboxDetail');
  await require('../../../models/SupportTicket').updateOne({ _id: ticket._id }, { $set: { requesterEmail: '' } });
  await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
  await expect(page.locator('#adminReplyForm')).toContainText('No reply email is recorded.');
  await expect(page.locator('#adminReplyText')).toBeHidden();
  await expect(page.locator('#adminReplySend')).toBeDisabled();
  await measure('inquiry-unavailable-' + variant, '#adminInboxDetail');
  if (!dark) await require('../../../models/User').updateOne({ _id: account.id }, { $set: { status: 'pending' } });
  if (width <= 1024) await page.locator('#sidebarToggle').click();
  await page.locator('#sidebarNav [data-section="overview"]').click();
  await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
  if (width <= 760) {
    await page.locator(`[data-flow-select="application:${account.id}"]`).click();
    await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
  }
  {
    await expect(page.locator('#adminFlowBody #pendingUserModal')).toHaveClass(/admin-flow-inline/);
    await expect(page.locator('#adminFlowBody [data-account-tab="profile"]')).toHaveText('Profile');
    await expect(page.locator('#adminFlowContext')).toContainText(dark ? 'Alexandria Montgomery-Washington' : 'River paralegal');
    await expect(page.locator('#adminFlowContext')).toContainText('CA');
    await expect(page.locator('#adminFlowContext')).toContainText('Submitted');
    await page.locator('#adminFlowBody #adminAccountContext details').evaluateAll(items => items.forEach(item => { item.open = true; }));
    await measure('guided-account-' + variant, '#adminFlow');
    await page.locator('#adminFlowBody [data-account-tab="profile"]').click();
    await measure('guided-profile-' + variant, '#adminFlow');
    await page.locator('#adminFlowBody [data-account-tab="history"]').click();
    await expect(page.locator('#adminFlowBody [data-account-panel="history"]')).toHaveText('No activity or correspondence yet.');
    await measure('guided-history-' + variant, '#adminFlow');
    await page.getByRole('button', { name: 'Choose follow-up', exact: true }).click();
    await measure('guided-follow-up-' + variant, '#adminFlowFollowUpForm');
    await page.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  }
  await expect(page.locator('#adminFlowBody #adminInboxDetail #adminReplyForm')).toBeVisible();
  await page.locator('#adminFlowBody #adminInboxDetail details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  await expect(page.locator('#adminFlowBody #adminReplySend')).toBeDisabled();
  await expect(page.locator('#adminFlowBody #adminReplyForm')).toContainText('No reply email is recorded.');
  await measure('guided-inquiry-' + variant, '#adminFlow');
  await fs.writeFile(info.outputPath('control-metrics.json'), JSON.stringify(observations, null, 2));
  const failures = observations.flatMap(view => view.controls.filter(control => control.width < 44 || control.height < 44 || control.fontSize < 14 * (enlarged ? 2 : 1) || !control.contentFits || !control.contained || !control.reachable || control.selectAppearance !== null && (control.selectAppearance !== 'none' || !control.selectBackground.includes('linear-gradient'))).map(control => ({ view: view.label, ...control })));
  expect(failures).toEqual([]);
  expect(observations.flatMap(view => view.text.filter(value => value.fontSize < 14 * (enlarged ? 2 : 1)).map(value => ({ view: view.label, ...value })))).toEqual([]);
  expect(observations.filter(view => view.documentOverflow || view.regions.some(region => region.overflow) || view.violations.length)).toEqual([]);
  expect(errors).toEqual([]);
});
