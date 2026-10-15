jest.mock('../utils/email', () => jest.fn(async recipient => ({ accepted: [recipient] })));
const email = require('../utils/email');
const User = require('../models/User'), Ticket = require('../models/SupportTicket'), Preference = require('../models/AutonomyPreference');
const service = require('../services/support/automaticCorrespondence');
const { nextAdminTask } = require('../services/adminFlowService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); email.mockClear(); });
test('an unanswered pending application reaches the existing owner queue after two accepted information reminders without another send', async () => {
  const [applicant, owner] = await User.create(['paralegal', 'admin'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `exhaustion-${role}@example.test`, password: 'Password123!', role, status: role === 'paralegal' ? 'pending' : 'approved', emailVerified: true, createdAt: new Date('2026-10-07T14:00:00Z') })));
  for (const kind of ['admission_information', 'reminder']) await Preference.create({ agentRole: 'CCO', actionType: service.POLICIES[kind], mode: 'auto' });
  for (const date of ['2026-10-09T14:00:00Z', '2026-10-12T14:00:00Z', '2026-10-15T14:00:00Z']) await service.processAutomaticCorrespondence({ now: new Date(date) });
  const ticket = await Ticket.findOne({ administrativeRequestKey: `admission:auto:${applicant._id}` }).select('+automaticCorrespondence').lean();
  expect(ticket.automaticReminders).toBe(2); expect(ticket.automaticCorrespondence.status).toBe('accepted'); expect(ticket.emailReplies).toHaveLength(3);
  expect(ticket.emailReplies.every(row => row.delivery === 'accepted')).toBe(true); expect(email).toHaveBeenCalledTimes(3);
  const at = new Date('2026-10-19T14:00:00Z'); await service.processAutomaticCorrespondence({ now: at });
  const saved = await Ticket.findById(ticket._id).select('+automaticCorrespondence').lean();
  const queue = await nextAdminTask({ owner: String(owner._id), now: at });
  expect(queue.items.some(row => row.key === `inquiry:${ticket._id}`)).toBe(true);
  expect(saved.followUpAt).toEqual(ticket.automaticCorrespondence.nextReminderAt);
  expect(saved.emailReplies).toEqual(ticket.emailReplies); expect(saved.automaticReminders).toBe(2); expect(email).toHaveBeenCalledTimes(3);
  expect((await User.findById(applicant._id)).status).toBe('pending');
});
const FollowUp = require('../models/AdminFollowUp'), Audit = require('../models/AuditLog');
afterEach(() => jest.restoreAllMocks());
async function exhausted() {
  const [applicant, owner] = await User.create(['paralegal', 'admin'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `guard-${role}@example.test`, password: 'Password123!', role, status: role === 'paralegal' ? 'pending' : 'approved', emailVerified: true, createdAt: new Date('2026-10-07T14:00:00Z') })));
  for (const kind of ['admission_information', 'reminder']) await Preference.create({ agentRole: 'CCO', actionType: service.POLICIES[kind], mode: 'auto' });
  for (const date of ['2026-10-09T14:00:00Z', '2026-10-12T14:00:00Z', '2026-10-15T14:00:00Z']) await service.processAutomaticCorrespondence({ now: new Date(date) });
  const ticket = await Ticket.findOne({ administrativeRequestKey: `admission:auto:${applicant._id}` }).select('+automaticCorrespondence').lean();
  return { applicant, owner, ticket, at: new Date('2026-10-19T14:00:00Z') };
}
test('overlapping exhaustion scans make one durable handoff/audit and preserve all accepted history and source revision', async () => {
  const { ticket, at } = await exhausted();
  await Promise.all([service.processAutomaticCorrespondence({ now: at }), service.processAutomaticCorrespondence({ now: at })]);
  const saved = await Ticket.findById(ticket._id).select('+automaticCorrespondence').lean();
  expect(saved.followUpAt).toEqual(ticket.automaticCorrespondence.nextReminderAt); expect(saved.updatedAt).toEqual(ticket.updatedAt);
  expect(saved.automaticCorrespondence).toEqual(ticket.automaticCorrespondence); expect(saved.emailReplies).toEqual(ticket.emailReplies);
  expect(await Audit.countDocuments({ targetId: ticket._id, action: 'support.automatic.reminder_exhausted' })).toBe(1); expect(email).toHaveBeenCalledTimes(3);
});
test.each(['shared follow-up', 'private follow-up'])('an existing owner-assigned future %s survives an exhaustion scan', async kind => {
  const { ticket, owner, at } = await exhausted(), future = new Date(at.getTime() + 86400000);
  if (kind === 'shared follow-up') await Ticket.updateOne({ _id: ticket._id }, { $set: { followUpAt: future } });
  else await FollowUp.create({ _id: `${owner._id}:inquiry:${ticket._id}`, owner: owner._id, key: `inquiry:${ticket._id}`, sourceRevision: ticket.updatedAt, followUpAt: future });
  const before = await Ticket.findById(ticket._id).lean();
  await service.processAutomaticCorrespondence({ now: at });
  const saved = await Ticket.findById(ticket._id).select('+automaticCorrespondence').lean(); expect(saved.followUpAt).toEqual(before.followUpAt); expect(saved.updatedAt).toEqual(before.updatedAt);
  if (kind === 'private follow-up') expect((await FollowUp.findById(`${owner._id}:inquiry:${ticket._id}`).lean()).followUpAt).toEqual(future);
  expect(await Audit.countDocuments({ action: 'support.automatic.reminder_exhausted' })).toBe(0); expect(email).toHaveBeenCalledTimes(3);
});
test.each([
  ['new applicant reply', ({ at }) => ({ latestUserMessage: 'Synthetic new information', lastInboundMailAt: at })],
  ['owner takeover', ({ owner }) => ({ assignedTo: owner._id })],
  ['new owner reply', () => ({ emailReplies: [{ text: 'Synthetic owner reply', adminName: 'Samantha', delivery: 'accepted' }] })],
])('%s prevents an obsolete exhaustion handoff', async (_label, update) => {
  const state = await exhausted(); await Ticket.updateOne({ _id: state.ticket._id }, { $set: update(state) });
  await service.processAutomaticCorrespondence({ now: state.at }); expect((await Ticket.findById(state.ticket._id)).followUpAt).toBeNull();
  expect(await Audit.countDocuments({ action: 'support.automatic.reminder_exhausted' })).toBe(0); expect(email).toHaveBeenCalledTimes(3);
});
test.each(['policy pause', 'account disabled', 'admission facts changed'])('%s prevents an exhaustion handoff', async kind => {
  const { ticket, applicant, at } = await exhausted();
  if (kind === 'policy pause') await Preference.updateOne({ actionType: service.POLICIES.reminder }, { $set: { mode: 'manual' } });
  else await User.updateOne({ _id: applicant._id }, { $set: kind === 'account disabled' ? { disabled: true } : { emailVerified: false } });
  await service.processAutomaticCorrespondence({ now: at }); expect((await Ticket.findById(ticket._id)).followUpAt).toBeNull();
  expect(await Audit.countDocuments({ action: 'support.automatic.reminder_exhausted' })).toBe(0); expect(email).toHaveBeenCalledTimes(3);
});
test('a zero-reminder limit still hands the accepted initial request back after its deadline without any reminder send', async () => {
  // Retain one real accepted initial request; no fictitious transport result.
  const applicant = await User.create({ firstName: 'Zero', lastName: 'Synthetic', email: 'zero@example.test', password: 'Password123!', role: 'paralegal', status: 'pending', emailVerified: true, createdAt: new Date('2026-10-07T14:00:00Z') });
  await Preference.create({ agentRole: 'CCO', actionType: service.POLICIES.admission_information, mode: 'auto' });
  await Preference.create({ agentRole: 'CCO', actionType: service.POLICIES.reminder, mode: 'auto', outboundRules: { reminderLimit: 0 } });
  await service.processAutomaticCorrespondence({ now: new Date('2026-10-09T14:00:00Z') });
  const ticket = await Ticket.findOne({ administrativeRequestKey: `admission:auto:${applicant._id}` }).select('+automaticCorrespondence').lean();
  await service.processAutomaticCorrespondence({ now: new Date('2026-10-12T14:00:00Z') });
  const saved = await Ticket.findById(ticket._id).select('+automaticCorrespondence').lean(); expect(saved.followUpAt).toEqual(ticket.automaticCorrespondence.nextReminderAt);
  expect(saved.automaticReminders).toBe(0); expect(saved.emailReplies).toHaveLength(1); expect(email).toHaveBeenCalledTimes(1);
});
test('failed handoff audit rolls back the existing follow-up and policy reservation; the next worker records one handoff without resending', async () => {
  const { ticket, at } = await exhausted(), policy = await Preference.findOne({ actionType: service.POLICIES.reminder }).lean();
  jest.spyOn(Audit, 'create').mockRejectedValueOnce(new Error('synthetic handoff audit unavailable'));
  await expect(service.processAutomaticCorrespondence({ now: at })).rejects.toThrow('synthetic handoff audit unavailable');
  const unchanged = await Ticket.findById(ticket._id).select('+automaticCorrespondence').lean(); expect(unchanged.followUpAt).toBeNull(); expect(unchanged.updatedAt).toEqual(ticket.updatedAt);
  expect((await Preference.findById(policy._id)).executionRevision).toBe(policy.executionRevision); expect(unchanged.emailReplies).toEqual(ticket.emailReplies);
  await service.processAutomaticCorrespondence({ now: at }); expect((await Ticket.findById(ticket._id)).followUpAt).toEqual(ticket.automaticCorrespondence.nextReminderAt);
  expect(await Audit.countDocuments({ action: 'support.automatic.reminder_exhausted' })).toBe(1); expect(email).toHaveBeenCalledTimes(3);
});
