const http = require('node:http');
const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../services/support/conversationService', () => ({
 getOrCreateOpenConversation: jest.fn(), findConversationForUser: jest.fn(async (id, ownerId) => ({ _id: id, userId: ownerId })),
 listConversationMessages: jest.fn(), createConversationMessage: jest.fn(), recordConversationMessageFeedback: jest.fn(), restartConversation: jest.fn(), escalateConversation: jest.fn(),
}));
jest.mock('../services/support/liveUpdateService', () => { const actual = jest.requireActual('../services/support/liveUpdateService'); return { ...actual, subscribeToConversationEvents: jest.fn((...args) => jest.fn(actual.subscribeToConversationEvents(...args))) }; });
const User = require('../models/User'), AuthSession = require('../models/AuthSession');
const { createAuthSession } = require('../services/authSessionService');
const { publishConversationEvent } = require('../services/support/liveUpdateService');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/support', require('../routes/support'));
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
const conversationId = 'cccccccccccccccccccccccc'; let server, owner, sid;
beforeAll(async () => { await connect(); server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }, 90000);
afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await closeDatabase(); });
beforeEach(async () => { await clearDatabase(); jest.clearAllMocks(); owner = await User.create({ firstName: 'Synthetic', lastName: 'Stream', email: 'owner@stream-boundary.test', password: 'Synthetic123!', role: 'attorney', status: 'approved' }); sid = (await createAuthSession(owner, {})).sessionId; });
function cookie(ttl = 3600) { return 'token=' + require('jsonwebtoken').sign({ id: String(owner._id), role: owner.role, av: 0, sid }, process.env.JWT_SECRET, { expiresIn: ttl }); }
const url = () => `/api/support/conversation/${conversationId}/events?expectedOwnerId=${owner._id}&expectedRole=attorney`;
async function stream(auth) {
 let text = '', response, req, ended = false; const ready = new Promise((resolve, reject) => { req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: url(), headers: { Cookie: auth } }, res => { response = res; res.on('end', () => ended = true); res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; if (text.includes('conversation.ready')) resolve(); }); res.on('error', reject); }); req.on('error', reject); });
 await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Stream did not become ready')), 3000).unref())]);
 return { text: () => text, ended: () => ended, close() { response?.destroy(); req.destroy(); } };
}
const scenarios = [
 ['disabled', () => User.collection.updateOne({ _id: owner._id }, { $set: { disabled: true } })],
 ['deleted', () => User.collection.updateOne({ _id: owner._id }, { $set: { deleted: true } })],
 ['approval revoked', () => User.collection.updateOne({ _id: owner._id }, { $set: { status: 'pending' } })],
 ['role replaced', () => User.collection.updateOne({ _id: owner._id }, { $set: { role: 'paralegal' } })],
 ['auth version revoked', () => User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } })],
 ['session revoked', () => AuthSession.collection.updateOne({ sessionId: sid }, { $set: { revokedAt: new Date() } })],
 ['session expired', () => AuthSession.collection.updateOne({ sessionId: sid }, { $set: { expiresAt: new Date(Date.now() - 1000) } })],
 ['JWT expired', async () => { await new Promise(resolve => setTimeout(resolve, 7200)); }],
];
test.each(scenarios)('an open stream stops private update metadata after %s', async (name, revoke) => {
 const auth = cookie(name === 'JWT expired' ? 1 : 3600); const connection = await stream(auth);
 try {
  await revoke();
  const fresh = await request(app).get(url()).set('Cookie', auth).timeout({ response: 3000, deadline: 5000 });
  expect(fresh.status).toBe(403);
  publishConversationEvent(conversationId, { type: 'conversation.updated', reason: 'ticket.status_updated', ticketStatus: 'waiting_on_user', ticketId: 'dddddddddddddddddddddddd', ticketReference: 'SUP-DDDDDD' });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(connection.text()).not.toContain('SUP-DDDDDD'); expect(connection.ended()).toBe(true);
 } finally { connection.close(); }
});
test('an authorized stream receives a private ticket hint through the real event bus', async () => {
 const connection = await stream(cookie()); try { publishConversationEvent(conversationId, { type: 'conversation.updated', reason: 'ticket.status_updated', ticketStatus: 'waiting_on_user', ticketReference: 'SUP-AAAAAA' }); await new Promise(resolve => setTimeout(resolve, 100)); expect(connection.text()).toContain('SUP-AAAAAA'); } finally { connection.close(); }
});

const { EventEmitter } = require('node:events');
const { attachSupportConversationStream } = require('../utils/supportStreamAccess');
const settle = () => new Promise(resolve => setImmediate(resolve));
function controlled(verifyAccess, options = {}) {
 const req = new EventEmitter(), res = new EventEmitter(); const chunks = []; const off = jest.fn(); let emit;
 Object.assign(res, { setHeader() {}, flushHeaders() {}, write(chunk) { chunks.push(chunk); }, end() { this.writableEnded = true; this.emit('close'); } });
 const close = attachSupportConversationStream({ req, res, conversationId, verifyAccess, subscribe: (_id, callback) => { emit = callback; return off; }, ...options });
 return { req, res, chunks, off, close, emit: payload => emit(payload) };
}
test('periodic authorization failure closes idle streams and detaches listeners', async () => {
 let allowed = true; const live = controlled(async () => allowed, { intervalMs: 15 });
 try { await settle(); expect(live.chunks.join('')).toContain('conversation.ready'); allowed = false; await new Promise(resolve => setTimeout(resolve, 40)); expect(live.res.writableEnded).toBe(true); expect(live.off).toHaveBeenCalledTimes(1); expect(live.req.listenerCount('close')).toBe(0); expect(live.res.listenerCount('close')).toBe(0); } finally { live.close(); }
});
test('a client close during held verification discards the late result and queued events', async () => {
 let release; const live = controlled(() => new Promise(resolve => release = resolve));
 await settle(); live.emit({ type: 'conversation.updated', private: 'old' }); live.req.emit('close'); release(true); await settle();
 expect(live.chunks).toEqual([]); expect(live.off).toHaveBeenCalledTimes(1); expect(live.res.writableEnded).toBe(true);
});
test('revocation found on a queued event prevents all later queued metadata', async () => {
 let checks = 0; const live = controlled(async () => ++checks === 1);
 try { await settle(); live.emit({ private: 'first' }); live.emit({ private: 'second' }); await settle(); expect(live.chunks.join('')).not.toContain('private'); expect(checks).toBe(2); expect(live.off).toHaveBeenCalledTimes(1); } finally { live.close(); }
});
test('credential expiry closes even a held authorization query and cannot publish its late response', async () => {
 let release; const live = controlled(() => new Promise(resolve => release = resolve), { expiresAt: Date.now() + 20 });
 await settle(); await new Promise(resolve => setTimeout(resolve, 40)); expect(live.res.writableEnded).toBe(true); release(true); await settle(); expect(live.chunks).toEqual([]); expect(live.off).toHaveBeenCalledTimes(1);
});
test('authorization query failures fail closed without publishing event metadata', async () => {
 const live = controlled(async () => { throw new Error('Synthetic database unavailable'); }); await settle(); expect(live.res.writableEnded).toBe(true); expect(live.chunks).toEqual([]); expect(live.off).toHaveBeenCalledTimes(1);
});
test('closing one actual connection cannot unsubscribe another and fresh authorized reconnect still works', async () => {
 const first = await stream(cookie()), second = await stream(cookie());
 try { first.close(); await settle(); publishConversationEvent(conversationId, { type: 'conversation.updated', ticketReference: 'SUP-SECOND' }); await new Promise(resolve => setTimeout(resolve, 100)); expect(second.text()).toContain('SUP-SECOND'); expect(first.text()).not.toContain('SUP-SECOND'); second.close(); await new Promise(resolve => setTimeout(resolve, 20)); const subscriptions = require('../services/support/liveUpdateService').subscribeToConversationEvents.mock.results; expect(subscriptions).toHaveLength(2); subscriptions.forEach(result => expect(result.value).toHaveBeenCalledTimes(1)); } finally { first.close(); second.close(); }
});
test('an unavailable authorization read reaches a bounded deadline and ignores a late success', async () => {
 let release; const live = controlled(() => new Promise(resolve => release = resolve), { accessTimeoutMs: 15 });
 await settle(); await new Promise(resolve => setTimeout(resolve, 40)); expect(live.res.writableEnded).toBe(true); release(true); await settle(); expect(live.chunks).toEqual([]); expect(live.off).toHaveBeenCalledTimes(1);
});
test('initial legacy unmanaged credentials retain accepted stream access and later revocation is enforced', async () => {
 const auth = 'token=' + require('jsonwebtoken').sign({ id: String(owner._id), role: owner.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: 3600 });
 const connection = await stream(auth); try { await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); publishConversationEvent(conversationId, { ticketReference: 'SUP-LEGACY' }); await new Promise(resolve => setTimeout(resolve, 100)); expect(connection.text()).not.toContain('SUP-LEGACY'); expect(connection.ended()).toBe(true); } finally { connection.close(); }
});
test('stream access retains the initiating credential even if the request object later changes', async () => {
 const originalToken = cookie().slice(6); const req = { auth: { token: originalToken, payload: { exp: Math.floor(Date.now() / 1000) + 3600 } }, user: { _id: String(owner._id), role: owner.role }, authSessionId: sid };
 const access = require('../utils/supportStreamAccess').createSupportStreamAccess(req); req.auth.token = 'changed'; req.user = { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', role: 'paralegal' }; req.authSessionId = 'changed';
 expect(await access.verify()).toBe(true); await AuthSession.collection.updateOne({ sessionId: sid }, { $set: { revokedAt: new Date() } }); expect(await access.verify()).toBe(false);
});
test('a lost conversation ownership lookup closes before later ticket metadata', async () => {
 const service = require('../services/support/conversationService'); const connection = await stream(cookie());
 try { service.findConversationForUser.mockResolvedValue(null); publishConversationEvent(conversationId, { ticketReference: 'SUP-FOREIGN' }); await new Promise(resolve => setTimeout(resolve, 100)); expect(connection.text()).not.toContain('SUP-FOREIGN'); expect(connection.ended()).toBe(true); } finally { connection.close(); service.findConversationForUser.mockImplementation(async (id, ownerId) => ({ _id: id, userId: ownerId })); }
});
