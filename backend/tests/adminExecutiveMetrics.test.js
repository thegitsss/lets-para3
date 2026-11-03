const mongoose = require('mongoose');
const User = require('../models/User');
const Case = require('../models/Case');
const Ticket = require('../models/SupportTicket');
const Audit = require('../models/AuditLog');
const Message = require('../models/SupportMessage');
const Approval = require('../models/ApprovalTask');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { readExecutiveMetrics, periodFor } = require('../services/adminExecutiveMetrics');
const now = new Date('2026-11-01T04:30:00Z');
const id = () => new mongoose.Types.ObjectId();
let attorney, para, owner;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [attorney, para, owner] = [id(), id(), id()];
  await User.collection.insertMany([
    { _id: attorney, email: 'attorney@metrics.example.test', role: 'attorney', status: 'approved', emailVerified: true, createdAt: new Date('2026-10-30T12:00:00Z') },
    { _id: para, email: 'paralegal@metrics.example.test', role: 'paralegal', status: 'approved', emailVerified: true, createdAt: new Date('2026-10-30T12:00:00Z') },
    { _id: owner, email: 'owner@metrics.example.test', role: 'admin', status: 'approved', createdAt: new Date('2026-10-30T12:00:00Z') },
  ]);
});
test('activation follows approved account access without requiring email verification', async () => {
  await User.collection.insertMany([
    { _id: id(), email: 'unverified@metrics.example.test', role: 'paralegal', status: 'approved', emailVerified: false, createdAt: now },
    { _id: id(), email: 'disabled@metrics.example.test', role: 'paralegal', status: 'approved', emailVerified: true, disabled: true, createdAt: now },
    { _id: id(), email: 'pending@metrics.example.test', role: 'paralegal', status: 'pending', emailVerified: true, createdAt: now },
    { _id: id(), email: 'deleted@metrics.example.test', role: 'paralegal', status: 'approved', emailVerified: true, deleted: true, createdAt: now },
  ]);
  const value = await readExecutiveMetrics({ now, ownerId: owner });
  expect(value.acquisition.paralegals.activation).toMatchObject({ numerator: 2, denominator: 4, rate: 50 });
  expect(value.definitions.activation).not.toContain('email-verified');
});
test('business month is New York, including the DST boundary', () => {
  expect(periodFor(new Date('2026-11-01T03:59:59Z'))).toMatchObject({ month: '2026-10', from: '2026-10-01T04:00:00.000Z' });
  expect(periodFor(now)).toMatchObject({ month: '2026-11', from: '2026-11-01T04:00:00.000Z' });
  expect(periodFor(new Date('2026-12-10T12:00:00Z')).from).toBe('2026-12-01T05:00:00.000Z');
});
test('conversions use canonical accounts/cases and combine both participant history and live state', async () => {
  const former = id();
  await User.collection.insertOne({ _id: former, email: 'former@metrics.example.test', role: 'paralegal', status: 'approved', emailVerified: false, createdAt: new Date('2026-10-29T00:00:00Z') });
  await Case.collection.insertMany([
    { attorney, paralegal: para, status: 'completed', createdAt: new Date('2026-10-31T12:00:00Z'), hiredAt: new Date('2026-10-31T18:00:00Z'), completedAt: new Date('2026-11-01T04:10:00Z'), stripeMode: 'live', withdrawalHistory: [{ withdrawnParalegalId: former }] },
    { attorneyId: attorney, status: 'open', createdAt: new Date('2026-11-01T04:15:00Z'), stripeMode: 'unknown', deadlineDate: '2026-10-31' },
    { attorney, status: 'completed', createdAt: new Date('2026-11-01T04:15:00Z'), stripeMode: 'test' },
  ]);
  const value = await readExecutiveMetrics({ now, ownerId: owner });
  expect(value.sources.marketplace.available).toBe(true);
  expect(value.acquisition.attorneys.firstPostConversion).toMatchObject({ numerator: 1, denominator: 1, rate: 100 });
  expect(value.acquisition.paralegals.activation).toMatchObject({ numerator: 2, denominator: 2, rate: 100 });
  expect(value.acquisition.paralegals.engagement).toMatchObject({ numerator: 2, denominator: 2, rate: 100 });
  expect(value.marketplace).toMatchObject({ posted: 2, postedThisMonth: 1, hired: 1, completed: 1, completedThisMonth: 1, unfilled: 1, overdue: 1 });
  expect(value.marketplace.postedToHire).toMatchObject({ rate: 50, denominator: 2, numerator: 1 });
  expect(value.marketplace.timeToHire).toMatchObject({ hours: 6, samples: 1, missingDates: 0 });
  expect(value.marketplace.timeToComplete).toMatchObject({ hours: 10.17, samples: 1, missingDates: 0 });
});
test('missing timestamps and zero denominators remain distinct from a measured zero rate', async () => {
  await Case.collection.insertOne({ attorney, paralegal: para, status: 'completed' });
  const value = await readExecutiveMetrics({ now, ownerId: owner });
  expect(value.marketplace.postedThisMonth).toBeNull();
  expect(value.marketplace.hiredThisMonth).toBeNull();
  expect(value.marketplace.timeToHire).toMatchObject({ hours: null, samples: 0, missingDates: 1 });
  expect(value.acquisition.attorneys.firstPostConversion).toMatchObject({ numerator: 0, evidenceMissing: 1, rate: null });
  await User.collection.deleteMany({ role: { $in: ['attorney', 'paralegal'] } });
  const empty = await readExecutiveMetrics({ now, ownerId: owner });
  expect(empty.acquisition.paralegals.activation).toMatchObject({ numerator: 0, denominator: 0, rate: null });
});
test('source failures do not turn unavailable support into zero unresolved tickets', async () => {
  const spy = jest.spyOn(Ticket, 'aggregate').mockImplementation(() => ({ option: () => Promise.reject(Error('controlled database failure')) }));
  try {
    const value = await readExecutiveMetrics({ now, ownerId: owner });
    expect(value.customerExperience).toBeNull();
    expect(value.sources.customerExperience.available).toBe(false);
    expect(value.marketplace.posted).toBe(0);
    expect(value.limitations).toContain('Support measurements are temporarily unavailable.');
  } finally { spy.mockRestore(); }
});
test('automatic delivery rates count attempt receipts and expose legacy or uncertain claim gaps', async () => {
  await Ticket.collection.insertOne({ status: 'open', requestKind: 'human', urgency: 'high', createdAt: now, emailReplies: [
    { automatedKind: 'routine_reply', requestId: 'one', createdAt: now, attemptOutcomes: [{ status: 'accepted', attempted: true, recordedAt: now, claimId: 'a' }, { status: 'failed', attempted: true, recordedAt: now, claimId: 'b' }] },
    { automatedKind: 'reminder', requestId: 'two', createdAt: now, attemptOutcomes: [{ status: 'unknown', attempted: null, recordedAt: now, claimId: 'c' }] },
    { automatedKind: 'admission_information', requestId: 'legacy', createdAt: now },
  ] });
  const value = await readExecutiveMetrics({ now, ownerId: owner });
  expect(value.customerExperience).toMatchObject({ unresolved: 1, waiting: 0, needsOwner: 1, urgent: 1 });
  expect(value.automation.delivery).toMatchObject({ accepted: 1, failed: 1, unknown: 0, uncertainClaims: 1, attempts: 2, successRate: null, coverage: { complete: false, legacyWithoutAttemptReceipts: 1 } });
  expect(value.automation.latestCycle.status).toBe('unknown');
});
test('owner decisions use real canonical records and deduplicate the same support reply', async () => {
  await Audit.collection.insertMany([
    { actor: owner, actorRole: 'admin', action: 'admin.user.approved', createdAt: now },
    { actor: owner, actorRole: 'admin', action: 'admin.user.notification_recorded', createdAt: now },
    { actor: id(), actorRole: 'admin', action: 'admin.user.approved', createdAt: now },
  ]);
  await Approval.collection.insertOne({ decidedBy: { userId: owner, actorType: 'user' }, decidedAt: now });
  await Message.collection.insertOne({ metadata: { kind: 'team_reply', adminId: String(owner), adminReplyRequestId: 'same-reply' }, createdAt: now });
  await Ticket.collection.insertOne({ emailReplies: [{ adminId: owner, requestId: 'same-reply', createdAt: now, delivery: 'accepted' }] });
  const value = await readExecutiveMetrics({ now, ownerId: owner });
  expect(value.owner).toMatchObject({ decisionsThisMonth: 3, bySource: { audits: 1, approvals: 1, incidents: 0, supportReplies: 1 }, recordedMinutes: null, timeCoverage: 'not_recorded' });
});
test('invalid reporting time or owner is rejected before private measurement reads', async () => {
  await expect(readExecutiveMetrics({ now: new Date('invalid'), ownerId: owner })).rejects.toThrow('Invalid reporting time');
  await expect(readExecutiveMetrics({ now, ownerId: 'not-an-owner' })).rejects.toMatchObject({ statusCode: 403 });
});
