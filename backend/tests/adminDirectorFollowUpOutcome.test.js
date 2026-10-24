jest.mock('../utils/email', () => jest.fn());
const email = require('../utils/email');
const User = require('../models/User'), Profile = require('../models/DirectorProfile');
const Record = require('../models/DirectorOutreachRecord'), Event = require('../models/DirectorOutreachEvent');
const service = require('../services/director/directorPortalService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const now = new Date('2026-10-13T14:00:00Z');
let director, attorney, record, profile;
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); email.mockReset();
  process.env.DIRECTOR_SMTP_USER = 'synthetic-director@example.test'; process.env.DIRECTOR_SMTP_PASS = 'synthetic-only';
  [director, attorney] = await User.create(['director', 'attorney'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `outcome-${role}@example.test`, password: 'Password123!', role, status: 'approved', emailVerified: true, createdAt: new Date('2026-10-01T14:00:00Z') })));
  profile = await Profile.create({ userId: director._id, email: director.email, zohoEmail: director.email, displayName: 'Synthetic Director' });
  record = await Record.create({ directorUserId: director._id, directorEmail: director.email, attorneyEmail: attorney.email, attorneyName: 'Synthetic Attorney', firstOutreachSentAt: new Date('2026-09-30T14:00:00Z') });
});
const run = (at = now) => service.processAutomaticDirectorFollowUps({ directorUserId: director._id, now: at });
const retained = () => Record.findById(record._id).lean();
test.each([
  ['intended recipient accepted', recipient => ({ accepted: [recipient], rejected: [] }), 'accepted'],
  ['transport disabled', () => ({ disabled: true }), 'disabled'],
  ['intended recipient rejected', recipient => ({ accepted: [], rejected: [recipient] }), 'failed'],
  ['a different recipient accepted', () => ({ accepted: ['other@example.test'], rejected: [] }), 'unknown'],
  ['no recipient outcome', () => ({ messageId: 'synthetic-outcome-unconfirmed' }), 'unknown'],
])('Director follow-up records truthful %s without a duplicate on the next worker pass', async (_label, response, status) => {
  email.mockImplementation(async recipient => response(recipient));
  const result = await run(), saved = await retained();
  expect(result.sent).toBe(status === 'accepted' ? 1 : 0);
  expect(Boolean(saved.followUpSentAt)).toBe(status === 'accepted');
  expect(saved.metadata.automaticFollowUp.status).toBe(status);
  expect(await Event.countDocuments({ recordId: record._id, eventType: 'follow_up_sent' })).toBe(status === 'accepted' ? 1 : 0);
  expect(email).toHaveBeenCalledTimes(1);
  await run(new Date(now.getTime() + 86400000)); expect(email).toHaveBeenCalledTimes(1);
});
test('an uncertain thrown outcome remains unknown and never exposes provider-private error text or blindly retries', async () => {
  email.mockRejectedValue(Object.assign(new Error('private-provider-token synthetic-secret'), { code: 'ECONNRESET', command: 'CONN' }));
  const result = await run(); expect(result.sent).toBe(0);
  const saved = await retained(); expect(saved.stage).toBe('follow_up_failed'); expect(saved.followUpSentAt).toBeNull();
  expect(saved.metadata.automaticFollowUp.status).toBe('unknown'); expect(JSON.stringify(saved)).not.toContain('synthetic-secret');
  await run(new Date(now.getTime() + 86400000)); expect(email).toHaveBeenCalledTimes(1);
});
test('a paused Director profile prevents automatic transport and a false sent history', async () => {
  await Profile.updateOne({ _id: profile._id }, { $set: { status: 'paused' } }); email.mockImplementation(async recipient => ({ accepted: [recipient] }));
  expect((await run()).sent).toBe(0); expect(email).not.toHaveBeenCalled(); expect((await retained()).followUpSentAt).toBeNull();
  expect(await Event.countDocuments({ recordId: record._id, eventType: 'follow_up_sent' })).toBe(0);
});
test('a reserved follow-up stays sending before acceptance and an overlapping worker cannot duplicate it', async () => {
  let started, release; const entered = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  email.mockImplementation(async recipient => { started(); await held; return { accepted: [recipient] }; });
  const first = run(); await entered;
  try {
    const sending = await retained(); expect(sending.followUpSentAt).toBeNull(); expect(sending.metadata.automaticFollowUp.status).toBe('sending');
    expect((await run(new Date(now.getTime() + 60000))).sent).toBe(0); expect(email).toHaveBeenCalledTimes(1);
  } finally { release(); await first; }
});
test('an accepted transport is retained when event persistence fails and the next worker repairs its canonical event without resending', async () => {
  email.mockImplementation(async recipient => ({ accepted: [recipient] }));
  const create = Event.create.bind(Event); let fail = true;
  jest.spyOn(Event, 'create').mockImplementation((...args) => { if (fail) { fail = false; return Promise.reject(new Error('synthetic event unavailable')); } return create(...args); });
  await run(); const saved = await retained(); expect(saved.followUpSentAt).toEqual(now); expect(saved.metadata.automaticFollowUp.status).toBe('accepted');
  await run(new Date(now.getTime() + 60000)); expect(email).toHaveBeenCalledTimes(1);
  expect(await Event.countDocuments({ recordId: record._id, eventType: 'follow_up_sent' })).toBe(1);
});
test.each([
  ['disabled Director', 'director', { disabled: true }],
  ['deleted Director', 'director', { deleted: true }],
  ['reclassified Director', 'director', { role: 'paralegal' }],
  ['unapproved Director', 'director', { status: 'pending' }],
  ['unverified Director', 'director', { emailVerified: false }],
  ['disabled attorney', 'attorney', { disabled: true }],
  ['changed attorney email', 'attorney', { email: 'changed-outcome@example.test' }],
])('current %s cannot trigger automatic transport', async (_label, which, changes) => {
  if (which === 'attorney') await Record.updateOne({ _id: record._id }, { $set: { registeredUserId: attorney._id } }); // retain the original referred account
  await User.updateOne({ _id: which === 'director' ? director._id : attorney._id }, { $set: changes });
  email.mockImplementation(async recipient => ({ accepted: [recipient] }));
  await run(); expect(email).not.toHaveBeenCalled(); expect((await retained()).followUpSentAt).toBeNull();
});
test('a paused profile discovered after reservation prevents transport and returns the exact claim for owner review', async () => {
  const mongoose = require('mongoose'), start = mongoose.startSession.bind(mongoose); let claimed = false, paused = false;
  const update = Record.findOneAndUpdate.bind(Record);
  jest.spyOn(Record, 'findOneAndUpdate').mockImplementation((...args) => {
    const query = update(...args), exec = query.exec.bind(query);
    query.exec = async (...execArgs) => { const result = await exec(...execArgs); if (result && args[1]?.$set?.['metadata.automaticFollowUp']) claimed = true; return result; }; return query;
  });
  jest.spyOn(mongoose, 'startSession').mockImplementation(async (...args) => {
    const session = await start(...args), end = session.endSession.bind(session);
    session.endSession = async (...endArgs) => { await end(...endArgs); if (claimed && !paused) { paused = true; await Profile.updateOne({ _id: profile._id }, { $set: { status: 'paused' } }); } };
    return session;
  });
  email.mockImplementation(async recipient => ({ accepted: [recipient] }));
  await run(); expect(email).not.toHaveBeenCalled(); const saved = await retained();
  expect(saved.metadata.automaticFollowUp.status).toBe('skipped'); expect(saved.stage).toBe('follow_up_failed');
});
test('an abandoned exact claim becomes unknown only after ten minutes even during a pause and is never automatically resent', async () => {
  await Record.updateOne({ _id: record._id }, { $set: { 'metadata.automaticFollowUp': { claimId: 'synthetic-stopped-claim', status: 'sending', claimedAt: now } } });
  await Profile.updateOne({ _id: profile._id }, { $set: { status: 'paused' } });
  await run(new Date(now.getTime() + 10 * 60000)); expect((await retained()).metadata.automaticFollowUp.status).toBe('sending');
  await run(new Date(now.getTime() + 10 * 60000 + 1)); const saved = await retained();
  expect(saved.metadata.automaticFollowUp.claimId).toBe('synthetic-stopped-claim'); expect(saved.metadata.automaticFollowUp.status).toBe('unknown'); expect(saved.stage).toBe('follow_up_failed');
  await run(new Date(now.getTime() + 86400000)); expect(email).not.toHaveBeenCalled();
});
test('known late acceptance clarifies its abandoned exact claim without undoing a newer owner escalation', async () => {
  let started, release; const entered = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  email.mockImplementation(async recipient => { started(); await held; return { accepted: [recipient] }; });
  const first = run(); await entered;
  try {
    await Record.updateOne({ _id: record._id }, { $set: { founderAttentionAt: now, stage: 'founder_attention', attorneyName: 'Owner retained revision' } });
    await run(new Date(now.getTime() + 10 * 60000 + 1));
  } finally { release(); await first; }
  const saved = await retained(); expect(saved.metadata.automaticFollowUp.status).toBe('accepted'); expect(saved.followUpSentAt).toEqual(now);
  expect(saved.founderAttentionAt).toEqual(now); expect(saved.stage).toBe('founder_attention'); expect(saved.attorneyName).toBe('Owner retained revision');
  expect(email).toHaveBeenCalledTimes(1); expect(await Event.countDocuments({ recordId: record._id, eventType: 'follow_up_sent' })).toBe(1);
});
test('overlapping canonical history repair retains the exact accepted claim and latest owner edits with one event and no resend', async () => {
  email.mockImplementation(async recipient => ({ accepted: [recipient] }));
  const create = Event.create.bind(Event); const spy = jest.spyOn(Event, 'create').mockRejectedValueOnce(new Error('synthetic first history failure'));
  await run(); const accepted = await retained();
  spy.mockImplementation(create);
  await Record.updateOne({ _id: record._id }, { $set: { founderAttentionAt: now, stage: 'founder_attention', firmName: 'Owner latest firm' } });
  await Promise.all([run(new Date(now.getTime() + 60000)), run(new Date(now.getTime() + 60000))]);
  const saved = await retained(), event = await Event.findOne({ recordId: record._id, eventType: 'follow_up_sent' }).lean();
  expect(saved.metadata.automaticFollowUp.eventRecorded).toBe(true); expect(event.metadata.claimId).toBe(accepted.metadata.automaticFollowUp.claimId);
  expect(event.attorneyEmail).toBe(accepted.metadata.automaticFollowUp.recipient); expect(event.occurredAt).toEqual(now);
  expect(saved.founderAttentionAt).toEqual(now); expect(saved.stage).toBe('founder_attention'); expect(saved.firmName).toBe('Owner latest firm');
  expect(await Event.countDocuments({ recordId: record._id, eventType: 'follow_up_sent' })).toBe(1); expect(email).toHaveBeenCalledTimes(1);
});
test('a colliding canonical event cannot masquerade as the exact claim and history repair remains bounded without resending', async () => {
  await Event.create({ recordId: record._id, directorUserId: director._id, directorEmail: director.email, attorneyEmail: 'different@example.test', eventType: 'follow_up_sent', providerMessageId: `auto-follow-up:${record._id}`, occurredAt: now, metadata: { claimId: 'different-claim' } });
  email.mockImplementation(async recipient => ({ accepted: [recipient] }));
  await run(); for (const minutes of [1, 2, 3, 4]) await run(new Date(now.getTime() + minutes * 60000));
  const saved = await retained(); expect(saved.followUpSentAt).toEqual(now); expect(saved.metadata.automaticFollowUp.status).toBe('accepted');
  expect(saved.metadata.automaticFollowUp.eventRecorded).toBe(false); expect(saved.metadata.automaticFollowUp.eventAttempts).toBe(3);
  expect(saved.metadata.automaticFollowUp.eventFailure).toContain('No additional email'); expect(email).toHaveBeenCalledTimes(1);
});
test.each([
  ['unconfirmed', 'unknown', 'Delivery unconfirmed; owner review'],
  ['accepted history needing repair', 'accepted', 'Email accepted; history needs repair'],
  ['historical record without outcome metadata', 'legacy', 'Follow-Up Auto Sent'],
])('actual Director and owner record responses show safe %s status without internal transport/claim metadata', async (_name, status, label) => {
  if (status === 'legacy') await Record.updateOne({ _id: record._id }, { $set: { followUpSentAt: now, stage: 'follow_up_sent' } });
  else {
    email.mockImplementation(async recipient => status === 'accepted' ? { accepted: [recipient] } : {});
    if (status === 'accepted') jest.spyOn(Event, 'create').mockRejectedValue(new Error('synthetic history unavailable'));
    await run();
  }
  const portal = await service.listDirectorRecords({ user: { id: director._id, role: 'director' }, rangeDays: 30 });
  const admin = await require('../services/director/directorAdminService').listDirectorOversight({ limit: 500 });
  const current = await retained();
  for (const response of [portal.find(row => row.id === String(record._id)), admin.records.find(row => row.id === String(record._id))]) {
    expect(response.stageLabel).toBe(label); expect(response.stage).toBe(current.stage); expect(response).not.toHaveProperty('metadata');
    if (current.metadata.automaticFollowUp) expect(JSON.stringify(response)).not.toContain(current.metadata.automaticFollowUp.claimId);
    expect(JSON.stringify(response)).not.toContain('synthetic history unavailable');
  }
  expect(email).toHaveBeenCalledTimes(status === 'legacy' ? 0 : 1);
});
