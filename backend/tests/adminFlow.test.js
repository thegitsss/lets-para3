const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
jest.mock('../utils/email', () => jest.fn(async () => ({ accepted: ['synthetic@example.test'] })));
const User = require('../models/User');
const Ticket = require('../models/SupportTicket');
const Case = require('../models/Case');
const Payment = require('../models/PaymentOperation');
const { nextAdminTask, saveFollowUp } = require('../services/adminFlowService');
const FollowUp = require('../models/AdminFollowUp');
const { readAdminAttention } = require('../services/adminAttentionService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express();
app.use(cookieParser()); app.use(express.json());
app.use('/api/admin/workspace', require('../routes/adminWorkspace'));
app.use('/api/admin', require('../routes/admin'));
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, status: user.status }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let owner;
let counter = 0;
const user = extra => User.create({ firstName: 'Flow', lastName: 'Applicant', email: `flow-${++counter}@example.test`, password: 'Synthetic flow password', role: 'attorney', status: 'pending', emailVerified: true, ...extra });
const ticket = extra => Ticket.create({ subject: 'Please help', message: 'A synthetic question', requestKind: 'human', ...extra });
beforeAll(connect);
beforeEach(async () => { await clearDatabase(); owner = await user({ role: 'admin', status: 'approved' }); });
afterAll(closeDatabase);

test('only the approved owner can read the queue and invalid selections fail explicitly', async () => {
  expect((await request(app).get('/api/admin/workspace/flow')).status).toBe(401);
  const attorney = await user({ status: 'approved' });
  expect((await request(app).get('/api/admin/workspace/flow').set('Cookie', cookie(attorney))).status).toBe(403);
  for (const query of ['deferred=no', 'deferred=%7B%7D', 'current=unknown', `deferred=${encodeURIComponent(JSON.stringify(Array(51).fill({key:`application:${owner._id}`,revision:new Date().toISOString()})))}`]) {
    expect((await request(app).get(`/api/admin/workspace/flow?${query}`).set('Cookie', cookie(owner))).status).toBe(400);
  }
  const response = await request(app).get('/api/admin/workspace/flow').set('Cookie', cookie(owner));
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
});
test('routine work is oldest first; disabled and removed applicants are excluded', async () => {
  const first = await user({ createdAt: new Date('2026-01-01') });
  await user({ createdAt: new Date('2026-02-01') });
  await user({ disabled: true }); await user({ deleted: true }); await ticket();
  const queue = await nextAdminTask();
  expect(queue.task.id).toBe(String(first._id)); expect(queue.total).toBe(3);
  expect(queue.task).not.toHaveProperty('password');
});
test('queue pages expose all records and selecting an item does not change its state', async () => {
  const applicants = [];
  for (let index = 0; index < 24; index++) applicants.push(await user({ createdAt: new Date(2026, 0, index + 1) }));
  const first = await nextAdminTask({ owner: String(owner._id) });
  expect(first.items).toHaveLength(20); expect(first.pages).toBe(2);
  const second = await nextAdminTask({ owner: String(owner._id), page: 2, selected: `application:${applicants[23]._id}` });
  expect(second.items).toHaveLength(4); expect(second.task.id).toBe(String(applicants[23]._id));
  expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(24);
  expect(await User.countDocuments({ role: 'attorney', status: 'pending' })).toBe(24);
  expect(second.items.every(item => !('password' in item))).toBe(true);
  for (const query of ['page=0', 'page=oops', 'page=1.5', 'selected=invalid']) {
    expect((await request(app).get(`/api/admin/workspace/flow?${query}`).set('Cookie', cookie(owner))).status).toBe(400);
  }
});
test('the queue reaches records beyond a first page and Later does not change their status', async () => {
  const users = [];
  for (let i = 0; i < 27; i++) users.push(await user({ createdAt: new Date(2026, 0, i + 1) }));
  const deferred = JSON.stringify(users.slice(0, 26).map(row => ({ key: `application:${row._id}`, revision: row.updatedAt.toISOString() })));
  const queue = await nextAdminTask({ deferred });
  expect(queue.task.id).toBe(String(users[26]._id)); expect(queue.deferred).toBe(26); expect(queue.remaining).toBe(1);
  expect(await User.countDocuments({ status: 'pending' })).toBe(27);
});
test('a changed deferred record returns automatically', async () => {
  const row = await ticket();
  const deferred = JSON.stringify([{ key: `inquiry:${row._id}`, revision: row.updatedAt.toISOString() }]);
  expect((await nextAdminTask({ deferred })).task).toBeNull();
  await Ticket.updateOne({ _id: row._id }, { $set: { latestUserMessage: 'New reply', updatedAt: new Date(row.updatedAt.getTime() + 1000) } }, { timestamps: false });
  expect((await nextAdminTask({ deferred })).deferredItems).toEqual([]);
  expect((await nextAdminTask({ deferred })).task.id).toBe(String(row._id));
});
test('accepted information requests wait for the applicant and a response restores review', async () => {
  const applicant = await user();
  const info = await ticket({ requesterUserId: applicant._id, administrativeRequestKey: `admission:${applicant._id}:first`, status: 'waiting_on_user', emailReplies: [{ requestId: 'first', text: 'More information please', delivery: 'accepted' }] });
  const waiting = await nextAdminTask();
  expect(waiting.task).toBeNull(); expect(waiting.waiting).toBe(1);
  await Ticket.updateOne({ _id: info._id }, { $set: { status: 'open' } });
  expect((await nextAdminTask()).task.key).toBe(`application:${applicant._id}`);
});
test('an older waiting request does not hide an applicant whose latest request has a reply', async () => {
  const applicant = await user();
  await ticket({ requesterUserId: applicant._id, administrativeRequestKey: 'older', status: 'waiting_on_user', createdAt: new Date('2026-01-01'), emailReplies: [{ requestId: 'old', text: 'Old request', delivery: 'accepted' }] });
  await ticket({ requesterUserId: applicant._id, administrativeRequestKey: 'newer', status: 'open', createdAt: new Date('2026-02-01') });
  const queue = await nextAdminTask({ current: `application:${applicant._id}` });
  expect(queue.currentPending).toBe(true); expect(queue.counts.application.ready).toBe(1); expect(queue.waiting).toBe(0);
});
test.each(['unknown', 'disabled', 'pending'])('an unconfirmed %s send remains actionable', async delivery => {
  const row = await ticket({ status: 'waiting_on_user', emailReplies: [{ requestId: 'uncertain', text: 'Saved reply', delivery }] });
  const { task } = await nextAdminTask();
  expect(task.id).toBe(String(row._id));
  expect(task.title).toBe('Check reply delivery');
  expect(task.reason).toContain(delivery === 'disabled' ? 'email sending was disabled' : 'Check the mailbox');
  expect(task).not.toHaveProperty('emailReplies');
});
test('completed deferred records no longer occupy a Later slot', async () => {
  const row = await ticket();
  const deferred = JSON.stringify([{ key: `inquiry:${row._id}`, revision: row.updatedAt.toISOString() }]);
  expect((await nextAdminTask({ deferred })).deferredItems).toHaveLength(1);
  await Ticket.updateOne({ _id: row._id }, { $set: { status: 'resolved' } });
  expect((await nextAdminTask({ deferred })).deferredItems).toEqual([]);
});
test('an older disabled send does not reopen a later accepted reply; due follow-ups return', async () => {
  const row = await ticket({ status: 'waiting_on_user', emailReplies: [{ requestId: 'old', text: 'First', delivery: 'disabled' }, { requestId: 'new', text: 'Second', delivery: 'accepted' }] });
  expect((await nextAdminTask()).task).toBeNull();
  await Ticket.updateOne({ _id: row._id }, { $set: { followUpAt: new Date('2026-01-01') } });
  expect((await nextAdminTask()).task.id).toBe(String(row._id));
});
test('checking a current task does not mistake a higher priority arrival for completion', async () => {
  const row = await ticket(); const key = `inquiry:${row._id}`;
  await Payment.create({ operationKey: 'new-urgent-payment', fingerprint: 'synthetic', kind: 'funding', caseId: owner._id, status: 'failed' });
  const queue = await nextAdminTask({ current: key });
  expect(queue.task.kind).toBe('payment'); expect(queue.currentPending).toBe(true);
  await Ticket.updateOne({ _id: row._id }, { $set: { status: 'resolved' } });
  expect((await nextAdminTask({ current: key })).currentPending).toBe(false);
});
test('financial issues stay pending until the authoritative record changes; exact chargeback view is scoped', async () => {
  const matter = await Case.create({ title: 'Late matter', details: 'Synthetic scope', attorney: owner._id, status: 'open', totalAmount: 10000, deadlineDate: '2026-01-01' });
  const payment = await Payment.create({ operationKey: 'flow-payment', fingerprint: 'synthetic', kind: 'funding', caseId: matter._id, status: 'failed' });
  expect((await nextAdminTask()).task).toMatchObject({ key: `payment:${payment._id}`, name: 'Late matter', caseId: String(matter._id), view: 'payment' });
  await Payment.updateOne({ _id: payment._id }, { $set: { status: 'succeeded' } });
  expect((await nextAdminTask({ current: `payment:${payment._id}` })).currentPending).toBe(false);
  expect((await nextAdminTask()).task.key).toBe(`matter:${matter._id}`);
  const charge = await Payment.create({ operationKey: 'flow-charge', fingerprint: 'synthetic', kind: 'chargeback', status: 'succeeded' });
  await Payment.create({ operationKey: 'other-charge', fingerprint: 'synthetic', kind: 'chargeback', status: 'succeeded' });
  const result = await request(app).get(`/api/admin/chargebacks?id=${charge._id}`).set('Cookie', cookie(owner));
  expect(result.status).toBe(200); expect(result.body.total).toBe(1); expect(result.body.items[0].id).toBe(String(charge._id));
});
test('the dispute view requires an open dispute; other matter exceptions keep their matter view', async () => {
  const row = await Case.create({ title: 'Review exception', details: 'Synthetic scope', attorney: owner._id, status: 'disputed', totalAmount: 10000, fundingIntegrityStatus: 'failed', disputes: [{ message: 'Review this issue', raisedBy: owner._id, status: 'open' }] });
  expect((await nextAdminTask()).task.view).toBe('dispute');
  await Case.updateOne({ _id: row._id }, { $set: { 'disputes.0.status': 'resolved' } });
  expect((await nextAdminTask()).task).toMatchObject({ view: 'matter', detail: 'Funding needs review' });
});
test('a matter without a deadline is not reported as overdue', async () => {
  await Case.create({ title: 'No deadline', details: 'Synthetic scope', attorney: owner._id, status: 'open', totalAmount: 10000 });
  expect((await nextAdminTask()).task).toBeNull();
});
test('database failure is an error, never an empty queue', async () => {
  const failure = jest.spyOn(Payment, 'countDocuments').mockRejectedValue(new Error('Synthetic database failure'));
  try { expect((await request(app).get('/api/admin/workspace/flow').set('Cookie', cookie(owner))).status).toBe(500); }
  finally { failure.mockRestore(); }
});

test('money exceptions and urgent inquiries cannot wait behind an application backlog', async () => {
  await user({ createdAt: new Date('2020-01-01') });
  await ticket({ createdAt: new Date('2021-01-01') });
  const urgent = await ticket({ urgency: 'high' });
  const money = await Payment.create({ operationKey: 'priority-payment', fingerprint: 'synthetic', kind: 'funding', caseId: owner._id, status: 'failed' });
  expect((await nextAdminTask()).task).toMatchObject({ id: String(money._id), priority: 'urgent' });
  await Payment.updateOne({ _id: money._id }, { $set: { status: 'succeeded' } });
  expect((await nextAdminTask()).task.id).toBe(String(urgent._id));
});

test('a newer disputed matter outranks an older overdue matter and normal applications', async () => {
  await user({ createdAt: new Date('2020-01-01') });
  await Case.create({ title: 'Older deadline', details: 'Synthetic', attorney: owner._id, status: 'open', deadlineDate: '2020-01-01', totalAmount: 10000, createdAt: new Date('2020-01-01') });
  const disputed = await Case.create({ title: 'New dispute', details: 'Synthetic', attorney: owner._id, status: 'disputed', totalAmount: 10000, disputes: [{ message: 'Review this', raisedBy: owner._id, status: 'open' }] });
  expect((await nextAdminTask()).task).toMatchObject({ id: String(disputed._id), priority: 'urgent', view: 'dispute' });
});

test('an earlier accepted admission email cannot hide a later unconfirmed request', async () => {
  const applicant = await user();
  await ticket({ requesterUserId: applicant._id, administrativeRequestKey: 'multiple-sends', status: 'waiting_on_user', emailReplies: [{ requestId: 'old', text: 'Old', delivery: 'accepted' }, { requestId: 'new', text: 'New', delivery: 'unknown' }] });
  expect((await nextAdminTask()).waiting).toBe(0);
});

const deferInput = (row, extra = {}) => ({ owner: owner._id, key: `inquiry:${row._id}`, sourceRevision: row.updatedAt.toISOString(), followUpAt: new Date(Date.now() + 86400000).toISOString(), revision: 0, ...extra });

test('a follow-up survives a new request, remains private, and returns when due without changing the ticket', async () => {
  const row = await ticket();
  const input = deferInput(row);
  const saved = await request(app).put('/api/admin/workspace/flow/follow-up').set('Cookie', cookie(owner)).send(input);
  expect(saved.status).toBe(200); expect(saved.body.revision).toBe(1);
  const queue = (await request(app).get('/api/admin/workspace/flow').set('Cookie', cookie(owner))).body;
  expect(queue.task).toBeNull(); expect(queue.followUps).toHaveLength(1); expect(queue.counts.inquiry).toEqual({ total: 1, ready: 0 });
  const other = await user({ role: 'admin', status: 'approved' });
  expect((await nextAdminTask({ owner: other._id })).task.id).toBe(String(row._id));
  const due = await nextAdminTask({ owner: owner._id, now: new Date(Date.parse(input.followUpAt) + 1) });
  expect(due.task.id).toBe(String(row._id)); expect(due.followUps).toEqual([]);
  const unchanged = await Ticket.findById(row._id).lean();
  expect(unchanged.status).toBe(row.status); expect(unchanged.updatedAt).toEqual(row.updatedAt);
});

test('new information brings a deferred record back without hiding it behind the old reminder', async () => {
  const row = await ticket(); await saveFollowUp(deferInput(row));
  await Ticket.updateOne({ _id: row._id }, { $set: { latestUserMessage: 'Please check this new detail', updatedAt: new Date(row.updatedAt.getTime() + 1000) } }, { timestamps: false });
  const queue = await nextAdminTask({ owner: owner._id });
  expect(queue.task.id).toBe(String(row._id)); expect(queue.followUps).toEqual([]); expect(queue.task.followUpRevision).toBe(1);
  await expect(saveFollowUp(deferInput(row, { revision: 1 }))).rejects.toMatchObject({ statusCode: 409 });
});

test('due personal reminders surface before a full page of routine work but after payment emergencies', async () => {
  const row = await ticket();
  const input = deferInput(row);
  await saveFollowUp(input);
  await Ticket.insertMany(Array.from({ length: 25 }, (_, index) => ({ subject: `Older routine ${index}`, message: 'Routine request', requestKind: 'human', status: 'open', createdAt: new Date('2025-01-01') })));
  const now = new Date(Date.parse(input.followUpAt) + 1);
  const queue = await nextAdminTask({ owner: owner._id, now });
  expect(queue.task).toMatchObject({ id: String(row._id), priority: 'high', followUpDue: true });
  expect(queue.task.reason).toContain('The follow-up you set is due.');
  expect(queue.remaining).toBe(26);
  const other = await user({ role: 'admin', status: 'approved' });
  const otherQueue = await nextAdminTask({ owner: other._id, now });
  expect(otherQueue.task.id).not.toBe(String(row._id));
  expect(otherQueue.items.some(item => item.followUpDue)).toBe(false);
  const emergency = await Payment.create({ operationKey: 'due-reminder-payment', fingerprint: 'synthetic', kind: 'funding', caseId: owner._id, status: 'failed' });
  const urgent = await nextAdminTask({ owner: owner._id, now });
  expect(urgent.task.key).toBe(`payment:${emergency._id}`);
  expect(urgent.items[1].id).toBe(String(row._id));
  await Ticket.updateOne({ _id: row._id }, { $set: { latestUserMessage: 'New information', updatedAt: new Date(row.updatedAt.getTime() + 1000) } }, { timestamps: false });
  const changed = await nextAdminTask({ owner: owner._id, now, page: 2 });
  expect(changed.items.find(item => item.id === String(row._id))).toMatchObject({ priority: 'normal' });
  expect(changed.items.find(item => item.id === String(row._id))).not.toHaveProperty('followUpDue');
});

test('completed work drops out of saved follow-ups', async () => {
  const row = await ticket(); await saveFollowUp(deferInput(row));
  await Ticket.updateOne({ _id: row._id }, { $set: { status: 'resolved' } });
  const queue = await nextAdminTask({ owner: owner._id });
  expect(queue.task).toBeNull(); expect(queue.followUps).toEqual([]); expect(queue.total).toBe(0);
});

test('stale tabs cannot overwrite a follow-up and bringing it back preserves version checks', async () => {
  const row = await ticket(); const input = deferInput(row);
  await saveFollowUp(input);
  await expect(saveFollowUp(input)).rejects.toMatchObject({ statusCode: 409 });
  expect(await FollowUp.countDocuments()).toBe(1);
  const cleared = await saveFollowUp({ ...input, revision: 1, followUpAt: null });
  expect(cleared.revision).toBe(2);
  expect((await nextAdminTask({ owner: owner._id })).task.id).toBe(String(row._id));
  await expect(saveFollowUp({ ...input, revision: 1 })).rejects.toMatchObject({ statusCode: 409 });
});

test('follow-up writes require an approved admin and valid dates', async () => {
  const row = await ticket(); const input = deferInput(row);
  expect((await request(app).put('/api/admin/workspace/flow/follow-up').send(input)).status).toBe(401);
  const attorney = await user({ status: 'approved' });
  expect((await request(app).put('/api/admin/workspace/flow/follow-up').set('Cookie', cookie(attorney)).send(input)).status).toBe(403);
  for (const followUpAt of ['', 'bad', true, new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 91 * 86400000).toISOString()]) {
    expect((await request(app).put('/api/admin/workspace/flow/follow-up').set('Cookie', cookie(owner)).send({ ...input, followUpAt })).status).toBe(400);
  }
  expect(await FollowUp.countDocuments()).toBe(0);
  const oldCsrf = process.env.ENABLE_CSRF;
  process.env.ENABLE_CSRF = 'true';
  try {
    expect((await request(app).put('/api/admin/workspace/flow/follow-up').set('Cookie', cookie(owner)).send(input)).status).toBe(403);
  } finally { process.env.ENABLE_CSRF = oldCsrf; }
  expect(await FollowUp.countDocuments()).toBe(0);
});

test('the Assistant and Today use the same owner queue, including saved follow-ups', async () => {
  const row = await ticket(); const input = deferInput(row);
  const before = await readAdminAttention({ user: owner, text: 'What actually needs me today?' });
  expect(before).toMatchObject({ available: true, remaining: 1, nextKey: input.key });
  await saveFollowUp(input);
  const after = await readAdminAttention({ user: owner, text: 'What should I review?' });
  expect(after).toMatchObject({ available: true, remaining: 0, deferred: 1, nextKey: null });
  expect(after.reply).toContain('set for later');
});

test('the Assistant does not trust a forged role, disabled account, or failed data source', async () => {
  const attorney = await user({ status: 'approved' });
  const text = 'What needs my attention?';
  expect(await readAdminAttention({ user: owner, text: 'What should I do about this refund?' })).toBeNull();
  expect(await readAdminAttention({ user: { _id: attorney._id, role: 'admin' }, text })).toBeNull();
  const failure = jest.spyOn(Payment, 'countDocuments').mockRejectedValue(new Error('Synthetic private database detail'));
  try {
    const result = await readAdminAttention({ user: owner, text });
    expect(result.available).toBe(false); expect(result.reply).toContain('couldn’t check');
    expect(result).not.toHaveProperty('remaining'); expect(result.reply).not.toContain('private database detail');
  } finally { failure.mockRestore(); }
  await User.updateOne({ _id: owner._id }, { $set: { disabled: true } });
  expect(await readAdminAttention({ user: owner, text })).toBeNull();
});

test('content and technical approvals join Today without taking over their decision handlers', async () => {
  const Approval = require('../models/ApprovalTask');
  const IncidentApproval = require('../models/IncidentApproval');
  const draft = await Approval.create({ taskType: 'marketing_review', targetType: 'marketing_draft_packet', targetId: String(new (require('mongoose').Types.ObjectId)()), title: 'Weekly company post', summary: 'Prepared draft', approvalState: 'pending' });
  const technical = await IncidentApproval.create({ incidentId: new (require('mongoose').Types.ObjectId)(), attemptNumber: 1, approvalType: 'production_deploy', requiredByPolicy: true, requestedAt: new Date() });
  let queue = await nextAdminTask({ owner: owner._id });
  expect(queue.remaining).toBe(2); expect(queue.task.key).toBe(`incident:${technical._id}`);
  expect(queue.task.reason).toContain('does not deploy');
  await IncidentApproval.updateOne({ _id: technical._id }, { $set: { status: 'approved' } });
  queue = await nextAdminTask({ owner: owner._id });
  expect(queue.task.workKey).toBe(`marketing_draft_packet:${draft.targetId}`);
  await saveFollowUp({ owner: owner._id, key: queue.task.key, sourceRevision: queue.task.revision, revision: 0, followUpAt: new Date(Date.now() + 3600000).toISOString() });
  expect((await nextAdminTask({ owner: owner._id })).remaining).toBe(0);
  expect((await Approval.findById(draft._id)).approvalState).toBe('pending');
  await Approval.updateOne({ _id: draft._id }, { $set: { summary: 'New evidence', updatedAt: new Date(draft.updatedAt.getTime() + 1000) } }, { timestamps: false });
  expect((await nextAdminTask({ owner: owner._id })).remaining).toBe(1);
});

test('expired technical approvals stay out of Today; photos and submitted posting edits are included', async () => {
  await require('../models/IncidentApproval').create({ incidentId: new (require('mongoose').Types.ObjectId)(), attemptNumber: 1, approvalType: 'production_deploy', requiredByPolicy: true, requestedAt: new Date(), expiresAt: new Date(Date.now() - 1000) });
  await user({ status: 'approved', pendingProfileImage: 'synthetic-photo-key' });
  await user({ status: 'pending', pendingProfileImage: 'another-synthetic-key' });
  await Case.create({ title: 'Edited posting', details: 'Synthetic', attorney: owner._id, status: 'open', moderationStatus: 'resolution_requested' });
  const queue = await nextAdminTask();
  expect(queue.counts.incident.ready).toBe(0); expect(queue.counts.photo.ready).toBe(1);
  expect(queue.counts.application.ready).toBe(1); expect(queue.counts.matter.ready).toBe(1);
});

test('activity reports distinguish unknown feeds, draft approvals, undone actions, and waiting work', async () => {
  const Action = require('../models/AutonomousAction');
  await ticket({ status: 'waiting_on_user', followUpAt: new Date(Date.now() + 3600000) });
  for (const delivery of ['unknown', 'disabled', 'pending']) await ticket({ status: 'waiting_on_user', followUpAt: new Date(Date.now() + 3600000), emailReplies: [{ requestId: delivery, text: 'Unconfirmed reply', delivery }] });
  await Action.create({ agentRole: 'CMO', actionType: 'marketing_publish_auto_approved', confidenceScore: 0.99, confidenceReason: 'Synthetic', targetModel: 'MarketingDraftPacket', targetId: new (require('mongoose').Types.ObjectId)(), changedFields: { approvalState: 'approved' }, previousValues: { approvalState: 'pending_review' }, actionTaken: 'Legacy publish wording must not be repeated', status: 'undone' });
  const response = await request(app).get('/api/admin/workspace/activity').set('Cookie', cookie(owner));
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.waiting.count).toBe(1); expect(response.body.waiting.upcoming).toHaveLength(1);
  expect(response.body.activity[0]).toMatchObject({ label: 'Marketing draft approved', status: 'undone' });
  expect(response.body.policies.every(row => row.mode === 'manual')).toBe(true);
  expect((await request(app).get('/api/admin/workspace/activity')).status).toBe(401);
  const other = await user({ status: 'approved' });
  expect((await request(app).get('/api/admin/workspace/activity').set('Cookie', cookie(other))).status).toBe(403);
  const lookup = jest.spyOn(Action, 'find').mockImplementationOnce(() => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.reject(new Error('synthetic failure')) }) }) }) }));
  const partial = await require('../services/adminActivityService').readAdminActivity();
  expect(partial.activity).toBeNull(); expect(partial.unavailable).toContain('activity'); expect(partial.waiting.count).toBe(1);
  lookup.mockRestore();
  expect(require('../utils/email')).not.toHaveBeenCalled();
});

test('application preparation uses known missing profile fields and never requests owner approval or unknown checks', () => {
  const { prepareApplication } = require('../services/adminPreparationService');
  const prepared = prepareApplication({ firstName: 'Jordan', status: 'pending' }, { reasons: [
    { key: 'account_approval', status: 'pending_review' }, { key: 'account_information', status: 'incomplete', fields: ['email_verification', 'unrecognized'] },
    { key: 'resume', status: 'missing' }, { key: 'payouts', status: 'unknown' }, { key: 'approved_photo', status: 'pending_review' },
  ] });
  expect(prepared.missing).toHaveLength(2); expect(prepared.requestText).toContain('Hi Jordan');
  expect(prepared.requestText).not.toMatch(/payout|approval|unrecognized/);
  expect(prepared.requestText).not.toMatch(/sign in|in your account|log in/i);
  expect(prepared.requestText).toContain('Attach your current résumé to your reply.');
  expect(prepareApplication({ status: 'pending' }, { reasons: [{ key: 'account_information', status: 'incomplete', fields: ['terms_acceptance', 'attorney_pricing_acceptance'] }] }).requestText).toBe('');
  expect(prepareApplication({ status: 'approved' }, { reasons: [{ key: 'resume', status: 'missing' }] }).requestText).toBe('');
});

test('inquiry preparation uses the requester role and current message, preserves records, and blocks stale drafts', async () => {
  const knowledge = require('../services/knowledge/retrievalService');
  const row = await ticket({ requesterRole: 'paralegal', latestUserMessage: 'How do I find available work?' });
  const lookup = jest.spyOn(knowledge, 'retrieveSupportKnowledge').mockResolvedValue([{ key: 'work', title: 'Finding work', answer: 'Open Find Work to see available postings.' }]);
  const response = await request(app).get(`/api/admin/workspace/inquiries/${row._id}/preparation`).set('Cookie', cookie(owner));
  expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.text).toContain('Open Find Work');
  expect(lookup).toHaveBeenCalledWith({ query: `${row.subject}\nHow do I find available work?`, role: 'paralegal', limit: 1 });
  expect((await Ticket.findById(row._id)).updatedAt.toISOString()).toBe(row.updatedAt.toISOString());
  expect((await request(app).get(`/api/admin/workspace/inquiries/${row._id}/preparation`)).status).toBe(401);
  lookup.mockImplementationOnce(async () => {
    await Ticket.updateOne({ _id: row._id }, { $set: { latestUserMessage: 'New question', updatedAt: new Date(row.updatedAt.getTime() + 1000) } }, { timestamps: false });
    return [{ key: 'old', title: 'Old answer', answer: 'Stale text' }];
  });
  expect((await request(app).get(`/api/admin/workspace/inquiries/${row._id}/preparation`).set('Cookie', cookie(owner))).status).toBe(409);
  const current = await Ticket.findById(row._id).lean();
  lookup.mockImplementationOnce(async () => {
    await Ticket.updateOne({ _id: row._id }, { $set: { latestUserMessage: 'Changed within the same millisecond', updatedAt: current.updatedAt } }, { timestamps: false });
    return [{ key: 'old', title: 'Old answer', answer: 'Stale text' }];
  });
  expect((await request(app).get(`/api/admin/workspace/inquiries/${row._id}/preparation`).set('Cookie', cookie(owner))).status).toBe(409);
  lookup.mockRestore();
});

test('sensitive and closed inquiries never get a routine prepared reply', async () => {
  const { prepareInquiry } = require('../services/adminPreparationService');
  const sensitive = await ticket({ latestUserMessage: 'Please refund this payment.' });
  expect((await prepareInquiry(sensitive._id)).text).toBe('');
  const closed = await ticket({ status: 'resolved' });
  expect((await prepareInquiry(closed._id)).text).toBe('');
});
