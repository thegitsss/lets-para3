const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
jest.mock('../utils/email', () => jest.fn(async to => ({ accepted: [to] })));
jest.mock('../services/lpcEvents/publishEventService', () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
jest.mock('../utils/stripe', () => ({ accounts: { retrieve: jest.fn() } }));
const User = require('../models/User');
const AuthSession = require('../models/AuthSession');
const SupportTicket = require('../models/SupportTicket');
const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const { createAuthSession } = require('../services/authSessionService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use('/api/admin/support', require('../routes/adminSupport'));
const evidenceRoot = process.env.LPC_CHAT_CONCURRENCY_EVIDENCE;
if (evidenceRoot && !evidenceRoot.startsWith('/Users/samanthasider/Desktop/lets-para3/outputs/lpc-release-acceptance-20261014/admin-chat-concurrency/')) throw Error('Owned concurrency evidence required');
if (evidenceRoot) for (const file of fs.readdirSync(path.resolve(__dirname, '../models')).filter(n => n.endsWith('.js')).sort()) require(path.resolve(__dirname, '../models', file));
async function capture(stage, details = {}) {
  if (!evidenceRoot) return;
  if (mongoose.connection.readyState !== 1 || mongoose.connection.name !== 'jest') throw Error('Owned current database required');
  const models = {};
  for (const name of Object.keys(mongoose.models).sort()) models[name] = await mongoose.models[name].collection.find({}).sort({ _id: 1 }).toArray();
  if (Object.keys(models).length !== 100) throw Error('Current full100 model inventory required');
  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(evidenceRoot, stage + '.json'), JSON.stringify({ stage, at: new Date().toISOString(), observedBrowserContexts: 0, renderedUIPages: 0, details, models }, null, 2), { mode: 0o600 });
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const cookie = (user, sid) => `token=${jwt.sign({ id: String(user._id), sid, av: Number(user.authVersion || 0), role: user.role, email: user.email, status: user.status }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const actor = (role, email) => User.create({ firstName: 'Concurrent', lastName: role, email, password: 'Example123!Strong', role, status: 'approved', emailVerified: true, state: 'CA' });
let admin, attorney, firstSession;
beforeAll(connect, 120000); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); admin = await actor('admin', 'chat-turn-admin@example.test'); attorney = await actor('attorney', 'chat-turn-attorney@example.test'); firstSession = await createAuthSession(admin, { headers: { 'user-agent': 'Managed concurrent chat fixture' } }); });
afterEach(() => jest.restoreAllMocks());
async function inquiry() {
  const conversation = await SupportConversation.create({ userId: attorney._id, role: 'attorney', status: 'escalated' });
  const ticket = await SupportTicket.create({ subject: 'Same private inquiry', message: 'Private caller detail', requestKind: 'human', requesterEmail: attorney.email, requesterUserId: attorney._id, conversationId: conversation._id });
  return { conversation, ticket, endpoint: `/api/admin/support/tickets/${ticket._id}/reply`, body: { text: 'The same reviewed team reply', requestId: randomUUID() } };
}
function holdFirstMessage(ticketId, expectedInitialReads) {
  const held = deferred(), release = deferred(), initialReadsDone = deferred();
  const create = SupportMessage.create.bind(SupportMessage), find = SupportTicket.collection.findOne.bind(SupportTicket.collection);
  let writes = 0, initialReads = 0;
  const writer = jest.spyOn(SupportMessage, 'create').mockImplementation(async (...args) => { if (++writes === 1) { held.resolve(); await release.promise; } return create(...args); });
  const reader = jest.spyOn(SupportTicket.collection, 'findOne').mockImplementation(async (...args) => { const result = await find(...args); if (String(args[0]?._id) === String(ticketId) && !args[1]?.session && ++initialReads >= expectedInitialReads) initialReadsDone.resolve(); return result; });
  return { held, release, initialReadsDone, writer, reader, counts: () => ({ messageCreates: writes, initialReads }) };
}

test('held identical chat retries each verify current authority and commit one shared reply', async () => {
  const { ticket, endpoint, body } = await inquiry(), gate = holdFirstMessage(ticket._id, 3), pending = [];
  let responses;
  await capture('identical-before');
  try {
    pending.push(request(app).post(endpoint).set('Cookie', cookie(admin, firstSession.sessionId)).send(body).then(r => r));
    await gate.held.promise;
    pending.push(...[1, 2].map(() => request(app).post(endpoint).set('Cookie', cookie(admin, firstSession.sessionId)).send(body).then(r => r)));
    await gate.initialReadsDone.promise;
    await capture('identical-held-all-three-requests-entered', { requestId: body.requestId, counts: gate.counts() });
    gate.release.resolve(); responses = await Promise.all(pending);
    await capture('identical-after-three-results', { responses: responses.map(r => ({ status: r.status, body: r.body })), counts: gate.counts() });
    expect(responses.map(r => r.status)).toEqual([201, 201, 201]);
    const messages = await SupportMessage.find({ 'metadata.adminReplyRequestId': body.requestId });
    expect(messages).toHaveLength(1); expect(messages[0].text).toBe(body.text); expect(String(messages[0].metadata.adminId)).toBe(String(admin._id));
    expect(gate.counts().messageCreates).toBe(1);
    expect((await SupportTicket.findById(ticket._id)).status).toBe('waiting_on_user');
    expect((await request(app).post(endpoint).set('Cookie', cookie(admin, firstSession.sessionId)).send({ ...body, text: 'Changed text must not reuse the ID' })).status).toBe(409);
    const other = await actor('admin', 'other-chat-owner@example.test'), otherSession = await createAuthSession(other, {});
    expect((await request(app).post(endpoint).set('Cookie', cookie(other, otherSession.sessionId)).send(body)).status).toBe(409);
    // A rejected turn cannot poison the queue or manufacture another message.
    expect((await request(app).post(endpoint).set('Cookie', cookie(admin, firstSession.sessionId)).send(body)).status).toBe(201);
    expect(await SupportMessage.countDocuments({ 'metadata.adminReplyRequestId': body.requestId })).toBe(1);
    await capture('identical-after-conflicting-text-owner-and-fresh-receipt');
  } finally { gate.release.resolve(); await Promise.allSettled(pending); gate.writer.mockRestore(); gate.reader.mockRestore(); }
});

test('a queued chat retry cannot reuse a committed receipt after its own session is independently revoked', async () => {
  const secondSession = await createAuthSession(admin, { headers: { 'user-agent': 'Independent queued managed session' } });
  const { ticket, endpoint, body } = await inquiry(), gate = holdFirstMessage(ticket._id, 2), pending = [];
  await capture('queued-loss-before');
  try {
    pending.push(request(app).post(endpoint).set('Cookie', cookie(admin, firstSession.sessionId)).send(body).then(r => r));
    await gate.held.promise;
    pending.push(request(app).post(endpoint).set('Cookie', cookie(admin, secondSession.sessionId)).send(body).then(r => r));
    await gate.initialReadsDone.promise;
    await capture('queued-loss-second-request-read-before-revocation', { requestId: body.requestId, firstSid: firstSession.sessionId, secondSid: secondSession.sessionId });
    const revokedAt = new Date();
    const loss = await AuthSession.collection.updateOne({ sessionId: secondSession.sessionId, userId: admin._id, revokedAt: null }, { $set: { revokedAt, revokedReason: 'Independent winning queued-session revocation' } }, { writeConcern: { w: 'majority' } });
    expect(loss.modifiedCount).toBe(1);
    await capture('queued-loss-majority-committed-before-first-release', { loss: { matchedCount: loss.matchedCount, modifiedCount: loss.modifiedCount, acknowledged: loss.acknowledged }, secondSid: secondSession.sessionId, revokedAt });
    gate.release.resolve(); const responses = await Promise.all(pending);
    await capture('queued-loss-after-both-results', { responses: responses.map(r => ({ status: r.status, body: r.body })), counts: gate.counts() });
    expect(responses.map(r => r.status)).toEqual([201, 403]);
    expect(responses[1].body.error).toMatch(/sign in again/i); expect(responses[1].body).not.toHaveProperty('ticket'); expect(responses[1].body).not.toHaveProperty('replyMessage');
    expect(await SupportMessage.countDocuments({ 'metadata.adminReplyRequestId': body.requestId })).toBe(1);
    expect(gate.counts().messageCreates).toBe(1);
    expect((await SupportTicket.findById(ticket._id)).status).toBe('waiting_on_user');
    expect((await AuthSession.findOne({ sessionId: secondSession.sessionId })).revokedAt).not.toBeNull();
    expect((await request(app).post(endpoint).set('Cookie', cookie(admin, firstSession.sessionId)).send(body)).status).toBe(201);
    await capture('queued-loss-accepted-first-receipt-retained');
  } finally { gate.release.resolve(); await Promise.allSettled(pending); gate.writer.mockRestore(); gate.reader.mockRestore(); }
});
