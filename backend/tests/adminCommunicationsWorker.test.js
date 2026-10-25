const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const mongoose = require('mongoose');
jest.mock('../utils/email', () => jest.fn(async () => ({ accepted: ['owner@example.test'] })));
const sendEmail = require('../utils/email');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { readReadyState } = require('./helpers/mongoHarnessState');
const { runOnce } = require('../scripts/admin-communications-worker');
const { enqueueAlert, processAlerts } = require('../services/adminAlertService');
const { syncMailbox } = require('../services/support/mailboxSyncService');
const Alert = require('../models/AdminCommunicationAlert');
const Mail = require('../models/AdminInboundMail');
const State = require('../models/AdminMailboxState');
const Ticket = require('../models/SupportTicket');
const { checkAdminCommunicationHealth } = require('../services/adminCommunicationHealth');
const { encryptString } = require('../utils/dataEncryption');
const config = { configured: true, key: 'restart-test', mailbox: 'help@example.test' };
const makeTicket = () => Ticket.create({ subject: 'Restart rehearsal', message: 'Synthetic inquiry', requestKind: 'contact', requesterEmail: 'visitor@example.test' });

beforeAll(connect);
beforeEach(async () => { await clearDatabase(); sendEmail.mockClear(); process.env.ADMIN_ALERT_EMAIL = 'owner@example.test'; });
afterAll(closeDatabase);

test('two fresh worker processes recover an unqueued request without duplicating it', async () => {
  const ticket = await makeTicket();
  const User = require('../models/User'), Case = require('../models/Case'), Notice = require('../models/MatterPreEngagementNotification');
  const [owner, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@restart.test`, password: 'Synthetic123!', role, status: 'approved' })));
  const matter = await Case.create({ title: 'Pre-engagement restart', details: 'Synthetic restart', attorney: owner._id, status: 'open', totalAmount: 60000, applicants: [{ paralegalId: para._id, status: 'pending' }], preEngagement: { revision: 1, status: 'requested', requestedParalegalId: para._id, requestedBy: owner._id, requestedAt: new Date(), conflictsCheckRequired: true } });
  const saved = await Case.collection.findOne({ _id: matter._id });
  const revisionKey = require('../services/matterPreEngagementNotifications').revisionKey(saved, owner._id, para._id, 'requested', owner._id);
  const notice = await Notice.create({ caseId: matter._id, kind: 'requested', ownerId: owner._id, paralegalId: para._id, userId: para._id, actorUserId: owner._id, revisionKey });
  const admin = await User.create({ firstName: 'Synthetic', lastName: 'Admin', email: 'admin@restart.test', password: 'Synthetic123!', role: 'admin', status: 'approved' });
  const Posting = require('../models/MatterPostingNotification');
  const posting = await Posting.create({ kind: 'created', caseId: matter._id, ownerId: owner._id, actorUserId: owner._id, userId: admin._id, eventKey: 'a'.repeat(64), stateKey: require('../services/matterPostingNotifications').stateKey(saved, 'created', owner._id) });
  const uri = readReadyState().uri.replace(/\/$/, '') + '/jest';
  const env = { ...process.env, NODE_ENV: 'test', EMAIL_DISABLE: 'true', MONGO_URI: uri,
    SUPPORT_ZOHO_CLIENT_ID: '', SUPPORT_ZOHO_CLIENT_SECRET: '', SUPPORT_ZOHO_REFRESH_TOKEN: '',
    SUPPORT_ZOHO_ACCOUNT_ID: '', SUPPORT_ZOHO_INBOX_FOLDER_ID: '' };
  const AdmissionNotice = require('../models/AdmissionDecisionNotification');
  await User.updateOne({ _id: owner._id }, { $push: { audit: { action: 'approved' } } });
  const admission = await AdmissionNotice.create({ userId: owner._id, auditIndex: 1, decision: 'approved',
    emailHash: require('crypto').createHash('sha256').update(owner.email).digest('hex') });
  const launch = () => promisify(execFile)(process.execPath, [path.resolve(__dirname, '../scripts/admin-communications-worker.js'), '--once'], { env, timeout: 60000 });
  await expect(launch()).rejects.toMatchObject({ code: 1 });
  const first = await Alert.findOne({ key: `contact:${ticket._id}` }).lean();
  expect(first).toMatchObject({ status: 'disabled', attempts: 1 });
  await expect(launch()).rejects.toMatchObject({ code: 1 });
  expect(await Alert.countDocuments({ key: first.key })).toBe(1);
  expect((await Alert.findById(first._id)).attempts).toBe(1);
  expect(await Posting.findById(posting._id)).toMatchObject({ status: 'disabled', attempts: 1 });
  expect(await Notice.findById(notice._id)).toMatchObject({ status: 'disabled', attempts: 1 });
  expect(await AdmissionNotice.findById(admission._id)).toMatchObject({ status: 'disabled', attempts: 1 });
  expect((await State.findById('communications-worker')).lastWorkerAt).toBeInstanceOf(Date);
}, 120000);

test('stopping during delivery finishes that claim and leaves later alerts pending', async () => {
  const first = await makeTicket(), second = await makeTicket();
  for (const ticket of [first, second]) await enqueueAlert({ key: `contact:${ticket._id}`, kind: 'contact', targetId: ticket._id });
  let stopping = false;
  sendEmail.mockImplementationOnce(async () => { stopping = true; return { accepted: ['owner@example.test'] }; });
  expect(await processAlerts({ shouldStop: () => stopping })).toBe(1);
  expect(await Alert.countDocuments({ status: 'accepted' })).toBe(1);
  expect(await Alert.countDocuments({ status: 'pending', attempts: 0 })).toBe(1);
});

test('a database failure before SMTP stays retryable and does not claim delivery is uncertain', async () => {
  const ticket = await makeTicket();
  await enqueueAlert({ key: `contact:${ticket._id}`, kind: 'contact', targetId: ticket._id });
  const lookup = jest.spyOn(Ticket, 'findById').mockImplementationOnce(() => { throw new Error('Synthetic database outage'); });
  try { await processAlerts(); } finally { lookup.mockRestore(); }
  expect(sendEmail).not.toHaveBeenCalled();
  expect(await Alert.findOne({ targetId: ticket._id })).toMatchObject({ status: 'failed' });
});
test('owner alerts do not automatically resend when the SMTP connection closes after an unknown acceptance', async () => {
  const ticket = await makeTicket();
  await enqueueAlert({ key: `contact:${ticket._id}`, kind: 'contact', targetId: ticket._id });
  sendEmail.mockRejectedValueOnce(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN' }));
  await processAlerts();
  expect(await Alert.findOne({ targetId: ticket._id })).toMatchObject({ status: 'unknown' });
  await processAlerts(); expect(sendEmail).toHaveBeenCalledTimes(1);
});

test('restart applies durable mail even when the message has left the provider Inbox', async () => {
  const ticketId = new mongoose.Types.ObjectId();
  await Mail.create({ mailboxKey: config.key, providerId: '123', ticketId, sender: 'visitor@example.test', subject: 'Saved before restart', content: encryptString('Recovered detail'), receivedAt: new Date(), ignored: false });
  const adapter = { verify: jest.fn(async () => {}), list: jest.fn(async () => []), read: jest.fn() };
  await syncMailbox({ config, adapter });
  await syncMailbox({ config, adapter });
  expect(await Ticket.countDocuments({ _id: ticketId })).toBe(1);
  expect(await Alert.countDocuments({ targetId: ticketId })).toBe(1);
  expect((await Mail.findOne({ providerId: '123' })).applied).toBe(true);
  expect(adapter.read).not.toHaveBeenCalled();
});

test('stopping a mailbox page preserves its cursor and releases its lease', async () => {
  let stopping = false;
  const rows = [1, 2].map(id => ({ messageId: String(id), receivedTime: String(Date.now()), fromAddress: 'visitor@example.test', subject: 'Synthetic' }));
  const adapter = { verify: async () => {}, list: async () => rows, read: async () => {
    stopping = true; return { headers: { from: 'visitor@example.test' }, text: 'Saved once' };
  } };
  const result = await syncMailbox({ config, adapter, shouldStop: () => stopping });
  expect(result).toMatchObject({ paused: true, complete: false, cursor: 2, imported: 1 });
  const state = await State.findById(config.key).lean();
  expect(state.lastCompletedAt).toBeUndefined();
  expect(state.lease).toBeUndefined();
});

test('a cycle reports mailbox failure while still processing owner alerts', async () => {
  await makeTicket();
  const result = await runOnce({ mailboxOptions: { config, adapter: { verify: async () => { throw new Error('Synthetic provider outage'); } } } });
  expect(result.ok).toBe(false);
  expect(result.mailbox.failed).toBe(true);
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect((await State.findById('communications-worker')).lastCycleOk).toBe(false);
});

test('a missing support connection cannot record a healthy completed cycle', async () => {
  const result = await runOnce({ mailboxOptions: { config: { configured: false } } });
  expect(result).toMatchObject({ ok: false, mailbox: { configured: false } });
  expect(await State.findById('communications-worker').lean()).toMatchObject({ lastCycleOk: false });
});

test('the monitor requires a recent completed communication cycle on the same release', async () => {
  const now = new Date(), commit = 'a'.repeat(40), env = { RENDER_GIT_COMMIT: commit };
  expect(await checkAdminCommunicationHealth({ now, env })).toMatchObject({ ok: false, code: 'communications_worker_stopped' });
  await State.create({ _id: 'communications-worker', lastWorkerAt: now, lastCompletedCycleAt: now, lastWorkerCommit: commit, lastCycleOk: true });
  expect(await checkAdminCommunicationHealth({ now, env })).toMatchObject({ ok: true });
  expect(await checkAdminCommunicationHealth({ now, env: { RENDER_GIT_COMMIT: 'b'.repeat(40) } })).toMatchObject({ ok: false, code: 'communications_worker_release_mismatch' });
  expect(await checkAdminCommunicationHealth({ now, env: {} })).toMatchObject({ ok: false, code: 'communications_worker_release_mismatch' });
  await State.updateOne({ _id: 'communications-worker' }, { $set: { lastCompletedCycleAt: new Date(now.getTime() - 360000) } });
  expect(await checkAdminCommunicationHealth({ now, env })).toMatchObject({ ok: false, code: 'communications_worker_stalled' });
  await State.updateOne({ _id: 'communications-worker' }, { $set: { lastWorkerAt: new Date(now.getTime() - 360000) } });
  expect(await checkAdminCommunicationHealth({ now, env })).toMatchObject({ ok: false, code: 'communications_worker_stopped' });
});

test('a completed worker cycle records its release and health without hiding a later provider failure', async () => {
  const previous = process.env.RENDER_GIT_COMMIT, commit = 'c'.repeat(40);
  process.env.RENDER_GIT_COMMIT = commit;
  try {
    const adapter = { verify: async () => {}, list: async () => [] };
    expect((await runOnce({ mailboxOptions: { config, adapter } })).ok).toBe(true);
    expect(await State.findById('communications-worker').lean()).toMatchObject({ lastWorkerCommit: commit, lastCycleOk: true, lastCompletedCycleAt: expect.any(Date) });
    expect(await checkAdminCommunicationHealth({ env: { RENDER_GIT_COMMIT: commit } })).toMatchObject({ ok: true });
    expect((await require('../services/support/mailboxSyncService').mailboxStatus()).workerHealth).toMatchObject({ ok: true });
    expect((await runOnce({ mailboxOptions: { config, adapter: { verify: async () => { throw new Error('Synthetic provider outage'); } } } })).ok).toBe(false);
    expect(await checkAdminCommunicationHealth({ env: { RENDER_GIT_COMMIT: commit } })).toMatchObject({ ok: false, code: 'communications_worker_cycle_failed' });
    expect((await require('../services/adminActivityService').readAdminActivity()).mailbox.workerHealth).toMatchObject({ ok: false, code: 'communications_worker_cycle_failed' });
  } finally {
    if (previous === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = previous;
  }
});


test('a committed payment exception is reconciled after enqueue interruption and delivered once', async () => {
  const Event = require('../models/WebhookEvent');
  await Event.create({ eventId: 'evt_attention_recovery', type: 'refund.failed', status: 'processed', attentionRequired: true, attentionCategory: 'refund' });
  const { reconcileAlerts } = require('../services/adminAlertService');
  await reconcileAlerts(); await reconcileAlerts();
  expect(await Alert.countDocuments({ kind: 'payment' })).toBe(1);
  await processAlerts(); await processAlerts();
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(await Alert.findOne({ kind: 'payment' }).lean()).toMatchObject({ status: 'accepted', attempts: 1 });
});
test('acceptance of a different recipient cannot complete an administrative alert', async () => {
  const ticket = await makeTicket();
  await enqueueAlert({ key: `contact:${ticket._id}`, kind: 'contact', targetId: ticket._id });
  sendEmail.mockResolvedValueOnce({ accepted: ['someone-else@example.test'] });
  await processAlerts(); await processAlerts();
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(await Alert.findOne({ key: `contact:${ticket._id}` }).lean()).toMatchObject({ status: 'unknown', attempts: 1 });
});
