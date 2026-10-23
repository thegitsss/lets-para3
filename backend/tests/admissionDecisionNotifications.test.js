const mongoose = require('mongoose');
jest.mock('../utils/email', () => jest.fn(async to => ({ accepted: [to] })));
const sendEmail = require('../utils/email');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User');
const Notice = require('../models/AdmissionDecisionNotification');
const mail = require('../services/admissionDecisionNotifications');
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); sendEmail.mockReset().mockImplementation(async to => ({ accepted: [to] })); });
async function staged(role = 'attorney', decision = 'approved') {
  const user = await User.create({ firstName: 'Synthetic', lastName: 'Applicant', email: `${role}@example.test`, password: 'Synthetic test passphrase', role, status: decision,
    audit: [{ action: decision, adminId: new mongoose.Types.ObjectId() }] });
  const session = await mongoose.startSession();
  try { await session.withTransaction(() => mail.stage(user, decision, session)); } finally { await session.endSession(); }
  return { user, notice: await Notice.findOne({ userId: user._id }) };
}
async function due(notice) { await Notice.updateOne({ _id: notice._id }, { $set: { nextAttemptAt: new Date(0) } }); }
test.each(['attorney', 'paralegal'])('%s pending notice recovers after a route stops before its initial send', async role => {
  const { user, notice } = await staged(role);
  expect(await mail.processNotices()).toBe(1);
  expect(await Notice.findById(notice._id)).toMatchObject({ status: 'accepted', attempts: 1 });
  expect(sendEmail).toHaveBeenCalledWith(user.email, expect.any(String), expect.any(String), expect.objectContaining({ messageId: `<lpc-admission-decision.${notice._id}@lets-paraconnect.com>` }));
  expect(await mail.processNotices()).toBe(0);
});
test('an immediate send cannot drain another applicant notice', async () => {
  const first = await staged('attorney'), second = await staged('paralegal');
  expect(await mail.sendForDecision(first.user)).toBe('accepted');
  expect(await Notice.findById(second.notice._id)).toMatchObject({ status: 'pending', attempts: 0 });
  expect(sendEmail).toHaveBeenCalledTimes(1);
});
test('uncertain SMTP acknowledgement and an expired sending claim never auto-resend', async () => {
  const { notice } = await staged();
  sendEmail.mockRejectedValueOnce(Object.assign(new Error('Synthetic lost acknowledgement'), { code: 'ECONNECTION', command: 'CONN' }));
  await mail.processNotices();
  expect(await Notice.findById(notice._id)).toMatchObject({ status: 'unknown', attempts: 1 });
  await due(notice); expect(await mail.processNotices()).toBe(0);
  await Notice.updateOne({ _id: notice._id }, { $set: { status: 'sending', claimedAt: new Date(0) } });
  expect(await mail.processNotices()).toBe(0);
  expect((await Notice.findById(notice._id)).status).toBe('unknown');
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect((await mail.noticeStatus()).recent).toHaveLength(1);
});
test('a lost receipt write preserves the sending claim and cannot duplicate accepted mail', async () => {
  const { notice } = await staged();
  const original = Notice.updateOne.bind(Notice);
  const write = jest.spyOn(Notice, 'updateOne').mockImplementation((filter, ...args) => filter.status === 'sending'
    ? Promise.reject(new Error('Synthetic lost receipt')) : original(filter, ...args));
  try { await expect(mail.processNotices()).rejects.toThrow('lost receipt'); } finally { write.mockRestore(); }
  expect((await Notice.findById(notice._id)).status).toBe('sending');
  expect(await mail.processNotices()).toBe(0);
  await Notice.updateOne({ _id: notice._id }, { $set: { claimedAt: new Date(0) } });
  expect(await mail.processNotices()).toBe(0);
  expect((await Notice.findById(notice._id)).status).toBe('unknown');
  expect(sendEmail).toHaveBeenCalledTimes(1);
});
test('confirmed rejections retry with backoff and stop at five attempts', async () => {
  const { notice } = await staged();
  sendEmail.mockImplementation(async to => ({ accepted: [], rejected: [to] }));
  for (let i = 1; i <= 5; i++) {
    await due(notice); expect(await mail.processNotices()).toBe(1);
    expect(await Notice.findById(notice._id)).toMatchObject({ status: 'failed', attempts: i });
    expect((await mail.noticeStatus()).recent).toHaveLength(i === 5 ? 1 : 0);
    expect(await mail.processNotices()).toBe(0);
  }
  await due(notice); expect(await mail.processNotices()).toBe(0);
  expect(sendEmail).toHaveBeenCalledTimes(5);
});
test.each(['decision', 'address', 'disabled'])('a changed %s cancels a stale queued notice', async change => {
  const { user, notice } = await staged();
  if (change === 'decision') await User.updateOne({ _id: user._id }, { $push: { audit: { action: 'denied' }, }, $set: { status: 'denied' } });
  if (change === 'address') await User.updateOne({ _id: user._id }, { $set: { email: 'changed@example.test' } });
  if (change === 'disabled') await User.updateOne({ _id: user._id }, { $set: { disabled: true } });
  expect(await mail.processNotices()).toBe(1);
  expect((await Notice.findById(notice._id)).status).toBe('skipped');
  expect(sendEmail).not.toHaveBeenCalled();
});
test('staging is idempotent and cannot be performed outside the decision transaction', async () => {
  const { user } = await staged();
  await expect(mail.stage(user, 'approved')).rejects.toThrow('transaction');
  const session = await mongoose.startSession();
  try { await session.withTransaction(() => mail.stage(user, 'approved', session)); } finally { await session.endSession(); }
  expect(await Notice.countDocuments()).toBe(1);
});

test('the communications worker processes a committed notice missed by the route', async () => {
  const { notice } = await staged();
  await require('../services/authNoticeWorker').runOnce();
  expect(await Notice.findById(notice._id)).toMatchObject({ status: 'accepted', attempts: 1 });
});

test.each(['attorney', 'paralegal'])('%s manual admission emails use the reviewed footer and verification action', async role => {
  const express = require('express'), request = require('supertest'), jwt = require('jsonwebtoken');
  const admin = await User.create({ firstName: 'Admin', lastName: 'Review', email: 'admin@example.test', password: 'Isolated administrator passphrase', role: 'admin', status: 'approved', emailVerified: true });
  const { user } = await staged(role);
  const app = express(); app.use(require('cookie-parser')(), express.json());
  app.use('/api/admin', require('../routes/admin'));
  const cookie = 'token=' + jwt.sign({ id: String(admin._id), role: admin.role, status: admin.status }, process.env.JWT_SECRET, { expiresIn: '5m' });
  for (const type of ['acceptance', 'denial']) {
    sendEmail.mockClear();
    const response = await request(app).post('/api/admin/bulk-email').set('Cookie', cookie).send({ type, userIds: [String(user._id)] });
    expect(response.status).toBe(200); expect(response.body.sent).toBe(1);
    const [, subject, html, options] = sendEmail.mock.calls[0];
    expect(html).toContain('mailto:help@lets-paraconnect.com');
    expect(html).toContain('/privacy.html');
    expect(options.text).toContain('help@lets-paraconnect.com');
    if (type === 'acceptance') {
      expect(subject).toBe('Welcome to Let’s-ParaConnect');
      expect(html).toContain('>Verify your email</a>');
      expect(html).toContain('/verify-email.html?token=');
    } else if (role === 'paralegal') expect(html).toContain('>Contact Us</a>');
  }
});
