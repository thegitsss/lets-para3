const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
jest.mock('../services/adminExecutiveMetrics', () => ({ ...jest.requireActual('../services/adminExecutiveMetrics'), readExecutiveMetrics: jest.fn(async () => ({ checkedAt: new Date().toISOString(), sources: {}, acquisition: { attorneys: { registered: 0 } } })) }));
jest.mock('../services/adminOperatingPreparation', () => ({ readAdminOperatingStatus: jest.fn(async () => ({ status: 'completed', counts: {} })), readCurrentPreparation: jest.fn(async () => ({ status: 'pending', current: false })) }));
const mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Payment = require('../models/PaymentOperation'), Ticket = require('../models/SupportTicket'), Audit = require('../models/AuditLog');
const { nextAdminTask, saveFollowUp } = require('../services/adminFlowService');
const { readHandled } = require('../services/adminHandledService');
const metrics = require('../services/adminExecutiveMetrics');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/admin/workspace', require('../routes/adminWorkspace')); app.use((e, req, res, next) => res.status(e.statusCode || e.status || 500).json({ error: e.message }));
let owner;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); metrics.readExecutiveMetrics.mockReset().mockImplementation(async () => ({ sources: {}, acquisition: { attorneys: { registered: 0 } } })); owner = await User.create({ firstName: 'Synthetic', lastName: 'Owner', email: 'owner-os@example.test', role: 'admin', status: 'approved', emailVerified: true, password: 'Synthetic owner password' }); });
const cookie = () => `token=${jwt.sign({ id: String(owner._id), role: 'admin', status: 'approved', av: owner.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const get = (path, query = {}) => require('supertest')(app).get('/api/admin/workspace' + path).query(query).set('Cookie', cookie());
async function funding(extra = {}) {
  const now = new Date(); const id = new mongoose.Types.ObjectId();
  await Case.collection.insertOne({ _id: id, title: 'Synthetic funding problem', status: 'open', escrowIntentId: 'pi_os_funding', fundingIntegrityStatus: 'failed', createdAt: now, updatedAt: now, ...extra });
  const operation = await Payment.collection.insertOne({ caseId: id, kind: 'funding', status: 'needs_reconciliation', stripePaymentIntentId: 'pi_os_funding', operationKey: 'os:' + id, fingerprint: 'synthetic', createdAt: now, updatedAt: now });
  return { id, operationId: operation.insertedId };
}
test('same explicit funding problem is one owner decision with both records retained', async () => {
  const record = await funding(); const before = await Case.findById(record.id).lean();
  const queue = await nextAdminTask({ owner: owner._id });
  expect(queue.remaining).toBe(1); expect(queue.grouped.financial).toBe(1); expect(queue.task.key).toBe('payment:' + record.operationId); expect(queue.task.relatedMatter.id).toBe(String(record.id));
  expect(await Case.findById(record.id).lean()).toEqual(before); expect((await Payment.findById(record.operationId)).status).toBe('needs_reconciliation');
});
test.each([
  ['dispute', { disputes: [{ status: 'open' }] }], ['overdue work', { deadlineDate: '2020-01-01' }], ['posting review', { moderationStatus: 'resolution_requested' }], ['separate workflow', { hiringClaimStatus: 'needs_reconciliation' }],
])('a separate %s stays visible next to financial work', async (_label, extra) => {
  await funding(extra); const queue = await nextAdminTask({ owner: owner._id }); expect(queue.remaining).toBe(2); expect(queue.grouped.financial).toBe(0);
});
test('multiple outstanding funding operations are not incorrectly merged', async () => {
  const record = await funding(); await Payment.collection.insertOne({ caseId: record.id, kind: 'funding', status: 'failed', stripePaymentIntentId: 'pi_os_funding', operationKey: 'os:second', fingerprint: 'second', createdAt: new Date(), updatedAt: new Date() });
  const queue = await nextAdminTask({ owner: owner._id }); expect(queue.remaining).toBe(3); expect(queue.grouped.financial).toBe(0);
});
test('a selected financial Matter stays inspectable with exact current revision', async () => {
  const record = await funding(); const queue = await nextAdminTask({ owner: owner._id, current: 'matter:' + record.id }); expect(queue.remaining).toBe(2); expect(queue.currentPending).toBe(true);
});
test('accepted information requests only wait while applicant information is unchanged', async () => {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Applicant', email: 'applicant-os@example.test', password: 'Synthetic applicant password', role: 'attorney', status: 'pending' });
  const sentAt = new Date(Date.now() - 3000); await User.collection.updateOne({ _id: user._id }, { $set: { updatedAt: new Date(sentAt.getTime() - 1000) } });
  await Ticket.create({ subject: 'Information requested', message: 'Synthetic source', administrativeRequestKey: 'os:' + user._id, requesterUserId: user._id, status: 'waiting_on_user', lastAdminReplyAt: sentAt, emailReplies: [{ requestId: 'os', text: 'Source-backed request', delivery: 'accepted', createdAt: sentAt }] });
  expect((await nextAdminTask({ owner: owner._id })).waiting).toBe(1);
  await User.collection.updateOne({ _id: user._id }, { $set: { updatedAt: new Date() } });
  const queue = await nextAdminTask({ owner: owner._id }); expect(queue.waiting).toBe(0); expect(queue.items.map(i => i.key)).toContain('application:' + user._id);
});
test('Handled uses recorded owner decisions and accepted receipts, excluding another owner and unknown sends', async () => {
  const other = new mongoose.Types.ObjectId();
  await Audit.create([{ actor: owner._id, actorRole: 'admin', action: 'admin.user.approved', targetType: 'user', targetId: String(owner._id) }, { actor: other, actorRole: 'admin', action: 'admin.user.denied', targetType: 'user', targetId: String(owner._id) }]);
  await Ticket.create({ subject: 'Synthetic support', message: 'Example', emailReplies: [{ requestId: 'accepted', adminId: owner._id, text: 'Reply', delivery: 'accepted', createdAt: new Date() }, { requestId: 'unknown', adminId: owner._id, text: 'Unknown', delivery: 'unknown', createdAt: new Date() }] });
  const result = await readHandled({ owner: owner._id }); expect(result.items).toHaveLength(2); expect(result.items.some(i => i.label === 'Application denied')).toBe(false); expect(result.items.filter(i => i.outcome === 'provider_accepted')).toHaveLength(1);
});
test('executive read delivers scoped independent sections and a labeled estimate', async () => {
  const result = await get('/executive', { expectedOwnerId: String(owner._id) }); expect(result.status).toBe(200); expect(result.body.ownerId).toBe(String(owner._id)); expect(result.body.revision).toMatch(/^[a-f0-9]{64}$/); expect(result.body.decisions.remaining).toBe(0); expect(result.body.financial.earnings).toMatchObject({ available: true, amount: 0, stripeMode: 'live' }); expect(result.body.ownerTime).toMatchObject({ estimate: true, estimatedMinutes: 0 });
});
test('one failed metrics source does not hide a checked decision queue or become a false zero', async () => {
  metrics.readExecutiveMetrics.mockRejectedValueOnce(new Error('Synthetic unavailable source'));
  const result = await get('/executive'); expect(result.status).toBe(200); expect(result.body.metrics.available).toBe(false); expect(result.body.metrics.acquisition).toBeUndefined(); expect(result.body.decisions.remaining).toBe(0); expect(result.body.sources.metrics.available).toBe(false);
});
test('wrong expected owner is denied before executive data is returned', async () => {
  const result = await get('/executive', { expectedOwnerId: String(new mongoose.Types.ObjectId()) }); expect(result.status).toBe(403); expect(result.body.decisions).toBeUndefined(); expect(metrics.readExecutiveMetrics).not.toHaveBeenCalled();
});
test('late account revocation prevents every executive section from being delivered', async () => {
  metrics.readExecutiveMetrics.mockImplementationOnce(async () => { await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return { secretMarker: 'must-not-deliver' }; });
  const result = await get('/executive'); expect(result.status).toBe(403); expect(result.text).not.toContain('must-not-deliver'); expect(result.body.decisions).toBeUndefined();
});

test.each([{ barNumber: 'SYN-CORRECTED' }, { state: 'NY' }, { location: 'New York, NY' }])('non-admission activity keeps a source-bound request waiting, but material correction %p reopens it', async correction => {
  const applicant = await User.create({ firstName: 'Synthetic', lastName: 'Revision applicant', email: 'revision-applicant@example.test', role: 'attorney', status: 'pending', password: 'Synthetic applicant password', barNumber: 'SYN-OLD' });
  await Ticket.create({ subject: 'Pending information', message: 'Please clarify your information.', administrativeRequestKey: 'revision:' + applicant._id, requesterUserId: applicant._id, status: 'waiting_on_user', admissionSourceRevision: require('../services/admissionReview').admissionRevision(applicant), emailReplies: [{ requestId: 'revision', text: 'Source request', delivery: 'accepted', createdAt: new Date() }] });
  await User.updateOne({ _id: applicant._id }, { $set: { lastLoginAt: new Date() } });
  expect((await nextAdminTask({ owner: owner._id })).waiting).toBe(1);
  await User.updateOne({ _id: applicant._id }, { $set: correction });
  const queue = await nextAdminTask({ owner: owner._id }); expect(queue.waiting).toBe(0); expect(queue.items.some(item => item.key === 'application:' + applicant._id)).toBe(true);
});

test('Handled includes acknowledged in-app replies and does not duplicate the same cross-channel action', async () => {
  const conversation = new mongoose.Types.ObjectId();
  const ticket = await Ticket.create({ subject: 'Shared channel', message: 'Example', emailReplies: [{ requestId: 'same-owner-action', adminId: owner._id, text: 'Reply', delivery: 'accepted', createdAt: new Date() }] });
  await require('../models/SupportMessage').create({ conversationId: conversation, sender: 'assistant', text: 'Recorded owner reply', metadata: { kind: 'team_reply', adminId: String(owner._id), ticketId: String(ticket._id), adminReplyRequestId: 'same-owner-action' } });
  const result = await readHandled({ owner: owner._id }); expect(result.items).toHaveLength(1); expect(result.items[0].targetId).toBe(String(ticket._id));
});
