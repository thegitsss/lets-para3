const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User'), Case = require('../models/Case'), Message = require('../models/Message');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/messages', require('../routes/messages'));
const cookie = user => `token=${require('jsonwebtoken').sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let attorney, paralegal, matter, old, newer;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); await Message.init();
  [attorney, paralegal] = await User.create(['attorney','paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@target-read.test`, password: 'Synthetic123!', role, status: 'approved' })));
  matter = await Case.create({ title: 'Synthetic linked old message', details: 'Review the existing instruction.', attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: 'in progress', escrowStatus: 'funded', escrowIntentId: 'pi_read_local', totalAmount: 40000 });
  old = await Message.create({ caseId: matter._id, senderId: attorney._id, senderRole: 'attorney', type: 'text', text: 'Earlier instruction', createdAt: new Date(Date.now()-60000) });
  newer = await Message.create({ caseId: matter._id, senderId: attorney._id, senderRole: 'attorney', type: 'text', text: 'Newer unseen message', createdAt: new Date(Date.now()-1000) });
});

test('loading a referenced older message through the paralegal/legacy reader must not implicitly mark its unseen newer messages read', async () => {
  const response = await request(app).get(`/api/messages/${matter._id}`).query({ messageId: String(old._id) }).set('Cookie', cookie(paralegal));
  expect(response.status).toBe(200);
  expect((await User.findById(paralegal._id)).messageLastViewedAt?.get(String(matter._id))).toBeUndefined();
  const count = await request(app).get('/api/messages/unread-count').set('Cookie', cookie(paralegal));
  expect(count.status).toBe(200); expect(count.body.count).toBe(2);
  expect((await Message.findById(newer._id)).readBy.map(String)).not.toContain(String(paralegal._id));
});

test('the existing explicit read endpoint acknowledges only the reviewed older timestamp, preserving newer unread', async () => {
  const response = await request(app).post(`/api/messages/${matter._id}/read`).set('Cookie', cookie(paralegal)).send({ upTo: old.createdAt.toISOString() });
  expect(response.status).toBe(200);
  expect((await Message.findById(old._id)).readBy.map(String)).toContain(String(paralegal._id));
  expect((await Message.findById(newer._id)).readBy.map(String)).not.toContain(String(paralegal._id));
  expect((await request(app).get('/api/messages/unread-count').set('Cookie', cookie(paralegal))).body.count).toBe(1);
});

test('ordinary history retrieval stays read-only and its existing explicit latest acknowledgement still consumes unread', async () => {
  const read = await request(app).get(`/api/messages/${matter._id}`).set('Cookie', cookie(paralegal));
  expect(read.status).toBe(200);
  expect((await request(app).get('/api/messages/unread-count').set('Cookie', cookie(paralegal))).body.count).toBe(2);
  const marked = await request(app).post(`/api/messages/${matter._id}/read`).set('Cookie', cookie(paralegal)).send({ upTo: newer.createdAt.toISOString() });
  expect(marked.status).toBe(200);
  expect((await request(app).get('/api/messages/unread-count').set('Cookie', cookie(paralegal))).body.count).toBe(0);
  expect((await Message.findById(newer._id)).readBy.map(String)).toContain(String(paralegal._id));
});

test('an owner-bound exact target acknowledgement persists only its reviewed boundary', async () => {
  const response = await request(app).post(`/api/messages/${matter._id}/read`).set('Cookie', cookie(paralegal)).set('X-LPC-Owner-Id', String(paralegal._id)).send({ messageId: String(old._id), upTo: old.createdAt.toISOString() });
  expect(response.status).toBe(200);
  expect((await Message.findById(old._id)).readBy.map(String)).toContain(String(paralegal._id));
  expect((await Message.findById(newer._id)).readBy.map(String)).not.toContain(String(paralegal._id));
  expect((await request(app).get('/api/messages/unread-count').set('Cookie', cookie(paralegal))).body.count).toBe(1);
});

test.each(['newer boundary', 'deleted target', 'another Matter', 'missing target', 'invalid timestamp', 'invalid target', 'changed owner', 'revoked access', 'replaced participant', 'closed Matter', 'funding lost'])('an unavailable or stale exact read target cannot consume any messages: %s', async condition => {
  let messageId = String(old._id), upTo = old.createdAt.toISOString(), ownerId = String(paralegal._id), expected = 409;
  if (condition === 'newer boundary') upTo = newer.createdAt.toISOString();
  if (condition === 'deleted target') await Message.updateOne({ _id: old._id }, { $set: { deleted: true } });
  if (condition === 'another Matter') {
    const elsewhere = await Case.create({ title: 'Separate synthetic Matter', details: 'Separate owned fixture for cross-Matter read denial.', attorney: attorney._id, attorneyId: attorney._id, status: 'open' });
    messageId = String((await Message.create({ caseId: elsewhere._id, senderId: attorney._id, senderRole: 'attorney', type: 'text', text: 'Do not expose this separate instruction.' }))._id);
  }
  if (condition === 'missing target') messageId = String(new (require('mongoose').Types.ObjectId)());
  if (condition === 'invalid timestamp') { upTo = 'not-a-date'; expected = 400; }
  if (condition === 'invalid target') { messageId = 'invalid'; expected = 400; }
  if (condition === 'changed owner') { ownerId = String(attorney._id); expected = 403; }
  if (condition === 'revoked access') { await Case.updateOne({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } }); expected = 403; }
  if (condition === 'replaced participant') { await Case.updateOne({ _id: matter._id }, { $unset: { paralegal: '', paralegalId: '' } }); expected = 403; }
  if (condition === 'closed Matter') { await Case.updateOne({ _id: matter._id }, { $set: { status: 'completed', readOnly: true, paymentReleased: true } }); expected = 403; }
  if (condition === 'funding lost') { await Case.updateOne({ _id: matter._id }, { $set: { escrowStatus: 'pending' }, $unset: { escrowIntentId: '' } }); expected = 403; }
  const response = await request(app).post(`/api/messages/${matter._id}/read`).set('Cookie', cookie(paralegal)).set('X-LPC-Owner-Id', ownerId).send({ messageId, upTo });
  expect(response.status).toBe(expected);
  expect(JSON.stringify(response.body)).not.toContain('Do not expose');
  for (const record of [old, newer]) expect((await Message.findById(record._id)).readBy.map(String)).not.toContain(String(paralegal._id));
  expect((await User.findById(paralegal._id)).messageLastViewedAt?.get(String(matter._id))).toBeUndefined();
});

test('the legacy explicit read request without a timestamp retains its established ordinary acknowledgement contract', async () => {
  const response = await request(app).post(`/api/messages/${matter._id}/read`).set('Cookie', cookie(paralegal)).send({});
  expect(response.status).toBe(200);
  expect((await Message.findById(newer._id)).readBy.map(String)).toContain(String(paralegal._id));
});
