const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const express = require('express'), request = require('supertest'), jwt = require('jsonwebtoken'), mongoose = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { readReadyState } = require('./helpers/mongoHarnessState');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const User = require('../models/User'), Case = require('../models/Case'), Message = require('../models/Message'), Notification = require('../models/Notification');
const { startRealtimeProjectionBridge } = require('../services/realtimeProjectionBridge');
const caseEvents = require('../utils/caseEvents'), notificationEvents = require('../utils/notificationEvents');
const app = express(); app.use(require('cookie-parser')(), express.json()); app.use('/api/messages', require('../routes/messages'));
let attorney, paralegal, outsider, matter, bridge, unsubscribers, frames;
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const get = async (user, route) => { const response = await request(app).get('/api/messages/' + route).set('Cookie', cookie(user)); expect(response.status).toBe(200); return response.body; };
async function otherInstance(user, method, suffix, body) {
  const input = { uri: readReadyState().uri, dbName: mongoose.connection.name, method, path: '/api/messages/' + matter._id + suffix, cookie: cookie(user), body };
  // Jest's sandboxed environment is not automatically the child process environment.
  // Pass only this disposable fixture's authentication and runtime configuration.
  const env = Object.fromEntries(['HOME', 'TMPDIR', 'PATH', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { NODE_ENV: 'test', JWT_SECRET: process.env.JWT_SECRET, DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY, EMAIL_DISABLE: 'true', ENABLE_CSRF: 'false' });
  const result = await promisify(execFile)(process.execPath, [path.join(__dirname, 'helpers/messagingInstanceRequest.js'), JSON.stringify(input)], { timeout: 20000, maxBuffer: 1024 * 1024, env });
  const line = result.stdout.split('\n').find(value => value.startsWith('LPC_INSTANCE_RESULT:'));
  expect(line).toBeTruthy(); return JSON.parse(line.slice('LPC_INSTANCE_RESULT:'.length));
}
async function startBridge() {
  const ready = [], restores = [];
  for (const model of [Message, Notification, Case, User]) {
    const original = model.watch.bind(model);
    const spy = jest.spyOn(model, 'watch').mockImplementation((...args) => {
      const stream = original(...args);
      ready.push(new Promise((resolve, reject) => { stream.once('ready', resolve); stream.once('error', reject); }));
      return stream;
    }); restores.push(spy);
  }
  try { bridge = startRealtimeProjectionBridge({ models: { Message, Notification, Case, User } }); await Promise.all(ready); }
  finally { restores.forEach(spy => spy.mockRestore()); }
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  expect(predicate()).toBe(true);
}
async function counts(user, expected) {
  expect(await get(user, 'unread-count')).toEqual({ count: expected });
  expect((await get(user, 'summary')).items).toEqual([expect.objectContaining({ caseId: String(matter._id), unread: expected })]);
  expect((await get(user, 'threads')).threads).toEqual([expect.objectContaining({ id: String(matter._id), unread: expected })]);
}
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [attorney, paralegal, outsider] = await User.create(['attorney', 'paralegal', 'outsider'].map(name => ({ firstName: 'River', lastName: name, email: name + '@multi-instance.example.test', password: 'Synthetic messaging password!', role: name === 'paralegal' ? 'paralegal' : 'attorney', status: 'approved' })));
  matter = await Case.create({ title: 'River Street correspondence', details: 'Organize the exhibits for review.', attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: 'in progress', escrowStatus: 'funded', escrowIntentId: 'pi_synthetic_multi_instance', totalAmount: 40000 });
  frames = { matter: [], attorney: [], paralegal: [], outsider: [] };
  unsubscribers = [caseEvents.addSubscriber(matter._id, { write: frame => frames.matter.push(frame) }), ...[['attorney', attorney], ['paralegal', paralegal], ['outsider', outsider]].map(([name, user]) => notificationEvents.addSubscriber(user._id, { write: frame => frames[name].push(frame) }))];
  await startBridge();
});
afterEach(async () => { await bridge?.stop(); unsubscribers?.forEach(unsubscribe => unsubscribe()); jest.restoreAllMocks(); });

test.each(['attorney', 'paralegal'])('a separate %s writer, restarted retry and recipient read reconcile every unread source', async role => {
  const sender = role === 'attorney' ? attorney : paralegal, recipient = role === 'attorney' ? paralegal : attorney;
  const text = 'PRIVATE_CROSS_INSTANCE_EXHIBIT_INSTRUCTION', clientMessageId = 'cross-instance-message-' + role;
  const body = { text, clientMessageId, ...(role === 'attorney' ? { expectedOwnerId: String(sender._id) } : {}) };
  const first = await otherInstance(sender, 'post', '', body); expect(first.status).toBe(201);
  await until(() => frames.matter.join('').includes('message_record_refresh') && frames[recipient.role].join('').includes('message_record_refresh'));
  expect(JSON.stringify(frames)).not.toContain(text); expect(frames.outsider).toEqual([]);
  await counts(recipient, 1); await counts(sender, 0);
  expect((await get(recipient, 'threads')).threads[0].lastMessageSnippet).toBe(text);
  const retry = await otherInstance(sender, 'post', '', body); expect(retry.status).toBe(200); expect(retry.body.message._id).toBe(first.body.message._id); expect(retry.mailCount).toBe(0);
  expect(await Message.countDocuments({ caseId: matter._id })).toBe(1);
  expect(await Notification.countDocuments({ userId: recipient._id, type: 'message' })).toBe(1);
  const readBody = { upTo: first.body.message.createdAt, ...(recipient.role === 'attorney' ? { expectedOwnerId: String(recipient._id) } : {}) };
  expect((await otherInstance(recipient, 'post', '/read', readBody)).status).toBe(200);
  expect((await otherInstance(recipient, 'post', '/read', readBody)).status).toBe(200);
  await counts(recipient, 0);
  const recorded = await Message.findById(first.body.message._id).lean();
  expect(recorded.readBy.map(String).filter(value => value === String(recipient._id))).toHaveLength(1);
  expect(recorded.readReceipts.filter(value => String(value.user) === String(recipient._id))).toHaveLength(1);
});

test('persisted unread state survives a stopped bridge and new changes reach subscribers after restart', async () => {
  await bridge.stop();
  const first = await otherInstance(paralegal, 'post', '', { text: 'Retain the original exhibit index.', clientMessageId: 'stopped-bridge-message-001' });
  expect(first.status).toBe(201); expect(frames.matter).toEqual([]);
  await counts(attorney, 1);
  await startBridge();
  const second = await otherInstance(paralegal, 'post', '', { text: 'The revised exhibit index is ready.', clientMessageId: 'restarted-bridge-message-002' });
  expect(second.status).toBe(201);
  await until(() => frames.matter.join('').includes('message_record_refresh'));
  await counts(attorney, 2);
  expect((await get(attorney, 'threads')).threads[0].lastMessageSnippet).toBe('The revised exhibit index is ready.');
  expect(frames.outsider).toEqual([]);
});
