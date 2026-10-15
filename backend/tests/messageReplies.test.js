const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const User = require('../models/User'), Case = require('../models/Case'), Message = require('../models/Message');
const { decryptMessagePayload } = require('../utils/dataEncryption');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/messages', require('../routes/messages'));
let attorney, paralegal, outsider, matter;
const cookie = user => `token=${require('jsonwebtoken').sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const send = (user, body, id = matter._id) => request(app).post(`/api/messages/${id}`).set('Cookie', cookie(user)).set('X-LPC-Owner-Id', String(user._id)).send({ ...(user.role === 'attorney' ? { expectedOwnerId: String(user._id) } : {}), ...body });
const seed = (extras = {}) => Message.create({ caseId: matter._id, senderId: attorney._id, senderRole: 'attorney', type: 'text', text: 'Confidential source instruction', content: 'Confidential source instruction', ...extras });
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); await Message.init();
  [attorney, paralegal, outsider] = await User.create(['attorney', 'paralegal', 'outsider'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@reply.test`, password: 'Synthetic123!', role: name === 'paralegal' ? name : 'attorney', status: 'approved' })));
  matter = await Case.create({ title: 'Synthetic reply Matter', details: 'Review the exhibit list.', attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: 'in progress', escrowStatus: 'funded', escrowIntentId: 'pi_reply_local', totalAmount: 40000 });
});

test.each(['attorney', 'paralegal'])('%s reply persists its authorized parent and server-derived thread, and both participants read the same context', async role => {
  const user = role === 'attorney' ? attorney : paralegal, parent = await seed();
  const first = await send(user, { text: 'I will check the exhibits.', replyTo: String(parent._id), clientMessageId: `${role}-reply-request-0001` });
  expect(first.status).toBe(201); expect(first.body.message.replyTo).toBe(String(parent._id)); expect(first.body.message.threadRoot).toBe(String(parent._id));
  expect(JSON.stringify(first.body)).not.toContain('Confidential source instruction');
  const stored = await Message.findById(first.body.message._id);
  expect(decryptMessagePayload(stored).text).toBe('I will check the exhibits.'); expect(stored.text).not.toBe('I will check the exhibits.');
  const nested = await send(user, { text: 'The date is confirmed.', replyTo: first.body.message._id, clientMessageId: `${role}-reply-request-0002` });
  expect(nested.status).toBe(201); expect(nested.body.message.threadRoot).toBe(String(parent._id));
  for (const reader of [attorney, paralegal]) {
    const response = await request(app).get(`/api/messages/${matter._id}`).set('Cookie', cookie(reader)).query(reader.role === 'attorney' ? { expectedOwnerId: String(reader._id) } : {});
    expect(response.status).toBe(200); const reply = response.body.messages.find(item => item._id === nested.body.message._id);
    expect(reply.replyTo).toBe(first.body.message._id); expect(reply.threadRoot).toBe(String(parent._id));
  }
});

test.each(['attorney', 'paralegal'])('%s exact retries never duplicate or change reply context, including after its parent is deleted', async role => {
  const user = role === 'attorney' ? attorney : paralegal, parent = await seed(), other = await seed({ text: 'Other authorized instruction' });
  const body = { text: 'Reply for exact retry', replyTo: String(parent._id), clientMessageId: `${role}-exact-reply-0001` };
  const first = await send(user, body); expect(first.status).toBe(201);
  expect((await send(user, { ...body, replyTo: String(other._id) })).status).toBe(409);
  expect((await send(user, { ...body, replyTo: undefined })).status).toBe(409);
  expect((await send(user, { ...body, text: 'Different text' })).status).toBe(409);
  await Message.collection.updateOne({ _id: parent._id }, { $set: { deleted: true } });
  const retry = await send(user, body); expect(retry.status).toBe(200); expect(retry.body.idempotent).toBe(true); expect(retry.body.message._id).toBe(first.body.message._id);
  expect(await Message.countDocuments({ clientMessageId: body.clientMessageId })).toBe(1);
});

test.each(['attorney', 'paralegal'])('%s cannot link missing, deleted, cross-Matter or inconsistent-thread messages and receives no parent text', async role => {
  const user = role === 'attorney' ? attorney : paralegal;
  const parent = await seed(), deleted = await seed({ deleted: true }), foreign = await seed({ caseId: new (require('mongoose').Types.ObjectId)(), text: 'Private other Matter instruction' });
  const before = await Message.countDocuments();
  const requests = [{ replyTo: 'f'.repeat(24) }, { replyTo: String(deleted._id) }, { replyTo: String(foreign._id) }, { replyTo: String(parent._id), threadRoot: 'e'.repeat(24) }];
  for (const reference of requests) {
    const response = await send(user, { text: 'Should not be recorded', ...reference });
    expect(response.status).toBe(409); expect(response.body.code).toBe('WORKSPACE_REPLY_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toMatch(/Confidential|Private other Matter/);
  }
  expect(await Message.countDocuments()).toBe(before);
});

test.each(['attorney', 'paralegal'])('%s rejects malformed reply references without widening the message lookup', async role => {
  const user = role === 'attorney' ? attorney : paralegal;
  for (const reference of [{ replyTo: {} }, { replyTo: ['a'.repeat(24)] }, { replyTo: 'bad' }, { threadRoot: 'a'.repeat(24) }, { replyTo: 'a'.repeat(24), threadRoot: {} }]) {
    const response = await send(user, { text: 'Malformed', ...reference }); expect(response.status).toBe(400); expect(response.body.code).toBe('WORKSPACE_REPLY_INVALID');
  }
  expect(await Message.countDocuments()).toBe(0);
});

test('an unavailable root is rejected even when its later reply remains in the current Matter', async () => {
  const root = await seed({ deleted: true }), parent = await seed({ threadRoot: root._id });
  const response = await send(paralegal, { text: 'Do not widen a hidden thread', replyTo: String(parent._id) });
  expect(response.status).toBe(409); expect(response.body.code).toBe('WORKSPACE_REPLY_UNAVAILABLE');
});

test('a replacement paralegal cannot reply to predecessor-only messages from before their assignment', async () => {
  const parent = await seed({ createdAt: new Date('2026-08-01T12:00:00Z') });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { withdrawnParalegalId: outsider._id, hiredAt: new Date('2026-09-01T12:00:00Z') } });
  const response = await send(paralegal, { text: 'Do not expose predecessor context', replyTo: String(parent._id) });
  expect(response.status).toBe(409); expect(response.body.code).toBe('WORKSPACE_REPLY_UNAVAILABLE'); expect(await Message.countDocuments()).toBe(1);
});

test('outsiders and unfunded participants cannot send replies through a valid known parent', async () => {
  const parent = await seed(), body = { text: 'Not permitted', replyTo: String(parent._id) };
  expect((await send(outsider, body)).status).toBe(403);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { escrowStatus: 'unfunded' } });
  expect((await send(attorney, body)).status).toBe(403); expect((await send(paralegal, body)).status).toBe(403);
  expect(await Message.countDocuments()).toBe(1);
});

test('existing ordinary text sends remain compatible and have no invented reply context', async () => {
  for (const user of [attorney, paralegal]) {
    const response = await send(user, { text: 'An ordinary message', clientMessageId: `${user.role}-ordinary-0001` });
    expect(response.status).toBe(201); expect(response.body.message.replyTo).toBeNull(); expect(response.body.message.threadRoot).toBeNull();
    expect((await send(user, { text: 'An ordinary message', clientMessageId: `${user.role}-ordinary-0001` })).status).toBe(200);
  }
});

test('legacy sends without owner headers still preserve ordinary text and optional reply metadata', async () => {
  const parent = await seed();
  for (const user of [attorney, paralegal]) {
    const response = await request(app).post(`/api/messages/${matter._id}`).set('Cookie', cookie(user)).send({ text: 'Legacy compatible reply', replyTo: String(parent._id) });
    expect(response.status).toBe(201); expect(response.body.message.replyTo).toBe(String(parent._id));
  }
});
