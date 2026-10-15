jest.mock('../utils/email', () => jest.fn(async recipient => ({ accepted: [recipient] })));
const sendEmail = require('../utils/email');
const User = require('../models/User'), Ticket = require('../models/SupportTicket');
const Preference = require('../models/AutonomyPreference'), Audit = require('../models/AuditLog');
const Item = require('../models/KnowledgeItem'), Revision = require('../models/KnowledgeRevision'), Collection = require('../models/KnowledgeCollection');
const service = require('../services/support/automaticCorrespondence');
const policy = require('../services/support/correspondencePolicy');
const { readAdminActivity } = require('../services/adminActivityService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); sendEmail.mockClear(); });

test('a paused policy exposes abandoned claimed work after ten minutes and retains accepted history without another transport attempt', async () => {
  const started = new Date('2026-10-09T14:00:00Z'), reminderAt = new Date('2026-10-12T14:00:00Z');
  const [requester, owner] = await User.create(['paralegal', 'admin'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `deadline-${role}@example.test`, password: 'Password123!', role, status: 'approved', emailVerified: true })));
  const collection = await Collection.create({ key: 'deadline-support', title: 'Synthetic deadline support', audienceScopes: ['support_safe'] });
  const item = await Item.create({ key: 'deadline-notifications', title: 'Notification preferences', collectionId: collection._id, recordType: 'objection_card', approvalState: 'approved', audienceScopes: ['support_safe'], tags: ['paralegal'], nextReviewAt: new Date('2027-01-01') });
  const question = 'How do I change notification preferences?';
  const revision = await Revision.create({ knowledgeItemId: item._id, revisionNumber: 1, fingerprint: 'deadline-approved-answer', approvalState: 'approved', content: { objection: question, approvedResponse: 'Open Settings and select Notifications to change your message preferences.' } });
  await Item.updateOne({ _id: item._id }, { $set: { currentApprovedRevisionId: revision._id } });
  const ticket = await Ticket.create({ subject: 'Notification preferences', message: question, requesterUserId: requester._id, userId: requester._id, requesterEmail: requester.email, requesterRole: requester.role, sourceSurface: 'paralegal' });
  for (const kind of ['routine_reply', 'reminder']) await Preference.create({ agentRole: 'CCO', actionType: service.POLICIES[kind], mode: 'auto' });
  const retained = () => Ticket.findById(ticket._id).select('+automaticCorrespondence').lean();
  await service.processAutomaticCorrespondence({ now: started });
  const accepted = await retained();
  expect(accepted.automaticCorrespondence.status).toBe('accepted'); expect(accepted.emailReplies).toHaveLength(1); expect(sendEmail).toHaveBeenCalledTimes(1);

  // Run the actual reminder scan, stop after staging, then claim as the worker
  // would. Simulate its process stopping before delivery; no transport starts.
  let stop = false;
  await service.processAutomaticCorrespondence({ now: reminderAt, shouldStop: () => stop, onProgress: async () => { stop = true; } });
  expect((await retained()).automaticCorrespondence).toMatchObject({ kind: 'reminder', status: 'pending' });
  const claimed = await service.claim(ticket._id, reminderAt); expect(claimed).toBeTruthy();
  const sending = await retained(); expect(sending.emailReplies).toHaveLength(2);
  expect(sending.automaticCorrespondence).toMatchObject({ status: 'sending', attempts: 1 });
  expect(sending.emailReplies[0]).toEqual(accepted.emailReplies[0]); expect(sending.emailReplies[1].delivery).toBe('pending');
  expect(sendEmail).toHaveBeenCalledTimes(1);

  // Exercise the existing current-owner policy contract rather than bypassing
  // pause with a direct preference edit. Final admission/payment authority is
  // unaffected; both enabled correspondence kinds are now manual.
  for (const kind of ['routine_reply', 'reminder']) {
    const reviewed = (await policy.readPolicies()).policies.find(row => row.kind === kind);
    await policy.savePolicy({ user: { id: String(owner._id) }, auth: { payload: { av: 0 } }, params: { kind }, body: { mode: 'manual', rules: reviewed.rules, dailyAttemptLimit: reviewed.dailyAttemptLimit, revision: reviewed.revision } });
  }
  expect(await Audit.countDocuments({ action: 'support.correspondence.policy_changed' })).toBe(2);
  expect((await policy.readPolicies()).counts).toEqual({ sending: 1 });
  expect((await retained()).automaticCorrespondence.status).toBe('sending');

  await service.processAutomaticCorrespondence({ now: new Date(reminderAt.getTime() + 10 * 60000) });
  expect((await retained()).automaticCorrespondence.status).toBe('sending');
  const overdueAt = new Date(reminderAt.getTime() + 10 * 60000 + 1);
  // Reading alone does not run the stopped worker or falsely clear its claim.
  expect((await readAdminActivity({ now: overdueAt })).correspondence.counts).toEqual({ sending: 1 });
  expect((await retained()).automaticCorrespondence.status).toBe('sending');
  expect(await service.processAutomaticCorrespondence({ now: overdueAt })).toEqual({ processed: 0, staged: 0 });
  const unknown = await retained();
  expect(unknown.automaticCorrespondence.status).toBe('unknown'); expect(unknown.automaticCorrespondence.failure).toContain('Check the provider');
  expect(unknown.automaticCorrespondence.requestId).toBe(sending.automaticCorrespondence.requestId);
  expect(unknown.emailReplies).toHaveLength(2); expect(unknown.emailReplies[0]).toEqual(accepted.emailReplies[0]);
  expect(unknown.emailReplies[1].requestId).toBe(sending.automaticCorrespondence.requestId); expect(unknown.emailReplies[1].delivery).toBe('unknown');
  expect(unknown.lastAdminReplyAt).toEqual(accepted.lastAdminReplyAt); expect(unknown.automaticReminders).toBe(0);
  expect((await readAdminActivity({ now: overdueAt })).correspondence.counts).toEqual({ unknown: 1 });
  await service.processAutomaticCorrespondence({ now: new Date('2026-10-19T14:00:00Z') });
  expect(await retained()).toEqual(unknown); expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(await Audit.countDocuments({ action: 'support.automatic.send_claimed' })).toBe(2);
});
