const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Readable } = require('stream');
const mockStorage = jest.fn();
jest.mock('../utils/s3Client', () => ({ createS3Client: () => ({ send: mockStorage }) }));
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../services/lpcEvents/publishEventService', () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const User = require('../models/User');
const Case = require('../models/Case');
const CaseFile = require('../models/CaseFile');
const CaseDraft = require('../models/CaseDraft');
const Connection = require('../models/ClioConnection');
const OAuthState = require('../models/ClioOAuthState');
const Handoff = require('../models/ClioHandoff');
const Transfer = require('../models/ClioTransfer');
const clio = require('../services/connectedWorkspace/clio');
const { decryptCaseFilePayload } = require('../utils/dataEncryption');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/integrations/clio', require('../routes/clioIntegration'));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
const base = '/api/integrations/clio';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cookie = (user, extra = {}) => `token=${require('jsonwebtoken').sign({ id: String(user._id), role: user.role, av: user.authVersion || 0, ...extra }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let owner, para, other, authCookie, matter, file, originalFetch, mockFetch, remoteCreated, remoteUploaded, remoteDocument;
const sourceDocument = (patch = {}) => ({ id: 21, name: 'Source.txt', filename: 'Source.txt', matter: { id: 123 }, latest_document_version: { id: 31, uuid: 'source-version-31', size: 15, content_type: 'text/plain', fully_uploaded: true }, ...patch });
const mutation = async (method, path, body = {}, userCookie = authCookie) => { const connection = await Connection.findOne({ ownerId: owner._id }).lean(); return request(app)[method](`${base}${path}`).set('Cookie', userCookie).send({ expectedOwnerId: String(owner._id), expectedConnectionRevision: connection?.revision || null, ...body }); };
const get = (path, userCookie = authCookie) => request(app).get(`${base}${path}`).set('Cookie', userCookie);
async function establishConnection(expiresAt = new Date(Date.now() + 3600000)) {
  return Connection.create({ ownerId: owner._id, credentials: clio.encode({ accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token' }), clioUserId: '1001', authVersion: 0, revision: crypto.randomUUID(), expiresAt });
}
beforeAll(async () => { originalFetch = global.fetch; await connect(); });
afterAll(async () => { global.fetch = originalFetch; await closeDatabase(); });
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  process.env.CLIO_CLIENT_ID = 'synthetic-clio-client'; process.env.CLIO_CLIENT_SECRET = 'synthetic-clio-secret';
  process.env.APP_BASE_URL = 'http://localhost:5050'; process.env.S3_BUCKET = 'synthetic-clio-tests'; process.env.S3_MALWARE_SCAN_REQUIRED = 'false';
  [owner, para, other] = await User.create(['owner','para','other'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@clio-integration.test`, password: 'Synthetic123!', role: name === 'para' ? 'paralegal' : 'attorney', status: 'approved' })));
  authCookie = cookie(owner);
  matter = await Case.create({ attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, title: 'Synthetic matter', details: 'Review approved work', status: 'in progress', escrowStatus: 'funded', escrowIntentId: 'pi_clio_synthetic', totalAmount: 50000, hiredAt: new Date(Date.now() - 60000) });
  file = await CaseFile.create({ caseId: matter._id, userId: para._id, originalName: 'Approved.txt', storageKey: `cases/${matter._id}/documents/approved.txt`, mimeType: 'text/plain', size: 13, uploadedByRole: 'paralegal', status: 'approved', securityStatus: 'not_required' });
  remoteCreated = 0; remoteUploaded = false; remoteDocument = null;
  mockStorage.mockImplementation(async command => {
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from(['approved work']), ContentLength: 13 };
    if (command.constructor.name === 'GetObjectTaggingCommand') return { TagSet: [{ Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' }] };
    return {};
  });
  mockFetch = jest.fn(async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth/token') return json({ access_token: 'synthetic-new-access', refresh_token: 'synthetic-new-refresh', expires_in: 3600, token_type: 'bearer' });
    if (url.pathname === '/oauth/deauthorize') return new Response('', { status: 200 });
    if (url.pathname.endsWith('/users/who_am_i.json')) return json({ data: { id: 1001 } });
    if (url.pathname === '/api/v4/matters.json') return json({ data: [{ id: 123, display_number: 'SYN-123', description: 'Confidential client facts that must stay private', status: 'Open' }] });
    if (url.pathname === '/api/v4/matters/123.json') return json({ data: { id: 123, display_number: 'SYN-123', description: 'Confidential client facts that must stay private', status: 'Open' } });
    if (url.pathname === '/api/v4/documents/21.json') return json({ data: sourceDocument() });
    if (url.pathname === '/api/v4/documents/21/download.json') return new Response(null, { status: 303, headers: { location: 'https://s3.us-west-2.amazonaws.com/iris-production/source.txt?X-Amz-Signature=synthetic' } });
    if (url.hostname === 's3.us-west-2.amazonaws.com') { if (options.method === 'PUT') { remoteUploaded = true; return new Response('', { status: 200 }); } return new Response('source contents', { status: 200 }); }
    if (url.pathname === '/api/v4/documents.json' && options.method === 'POST') {
      remoteCreated++; const data = JSON.parse(options.body).data;
      remoteDocument = { id: 7001, matter: { id: data.parent.id }, external_properties: data.external_properties, latest_document_version: { uuid: 'export-version-1', fully_uploaded: false, put_url: 'https://s3.us-west-2.amazonaws.com/iris-production/export.txt?X-Amz-Signature=synthetic', put_headers: [{ name: 'Content-Type', value: 'text/plain' }] } };
      return json({ data: remoteDocument }, 201);
    }
    if (url.pathname === '/api/v4/documents.json') return json({ data: url.searchParams.has('external_property_name') ? (remoteDocument ? [remoteDocument] : []) : [sourceDocument()] });
    if (url.pathname === '/api/v4/documents/7001.json') { if (options.method === 'PATCH') { if (!remoteUploaded) return json({}, 422); remoteDocument.latest_document_version.fully_uploaded = true; } return json({ data: remoteDocument }); }
    throw new Error(`Unexpected synthetic Clio request: ${url.pathname}`);
  });
  global.fetch = mockFetch;
});

test('unconfigured integration reports its state and never calls a provider', async () => {
  delete process.env.CLIO_CLIENT_SECRET;
  expect((await get('/status')).body).toMatchObject({ configured: false, connected: false, region: 'US' });
  expect((await mutation('post','/connect')).status).toBe(503);
  expect(mockFetch).not.toHaveBeenCalled();
});
test('paralegals and changed-account requests cannot use Clio operations', async () => {
  expect((await get('/status', cookie(para))).status).toBe(403);
  expect((await mutation('post','/connect', { expectedOwnerId: String(other._id) })).status).toBe(403);
  expect(mockFetch).not.toHaveBeenCalled();
});
test('OAuth state is single-use, account-bound, and stores only a hash', async () => {
  const start = await mutation('post','/connect'); expect(start.status).toBe(200);
  const url = new URL(start.body.authorizationUrl), state = url.searchParams.get('state');
  const record = await OAuthState.findOne().lean(); expect(record.tokenHash).not.toBe(state); expect(record.tokenHash).toBe(clio.hash(state));
  const foreign = await get(`/callback?state=${state}&code=synthetic-code`, cookie(other)); expect(foreign.status).toBe(400); expect((await OAuthState.findById(record._id)).consumedAt).toBeNull();
  const callback = await get(`/callback?state=${state}&code=synthetic-code`); expect(callback.status).toBe(303); expect(callback.headers.location).toBe('/clio-connect.html?connected=1');
  expect((await get(`/callback?state=${state}&code=synthetic-code`)).status).toBe(400);
  const connection = await Connection.findOne().select('+credentials').lean(); expect(connection.credentials).toMatch(/^enc:v1:/); expect(connection.credentials).not.toContain('synthetic-new-access');
  expect((await get('/status')).body).toMatchObject({ configured: true, connected: true });
});
test('OAuth callback rejects a different initiating session without consuming the state', async () => {
  const start = await mutation('post','/connect'), state = new URL(start.body.authorizationUrl).searchParams.get('state');
  expect((await get(`/callback?state=${state}&code=synthetic-code`, cookie(owner, { jti: 'different-session' }))).status).toBe(400);
  expect((await OAuthState.findOne()).consumedAt).toBeNull(); expect(mockFetch).not.toHaveBeenCalled();
});
test('an expired OAuth state cannot obtain tokens', async () => {
  const start = await mutation('post','/connect'), state = new URL(start.body.authorizationUrl).searchParams.get('state');
  await OAuthState.updateOne({}, { $set: { expiresAt: new Date(0) } });
  expect((await get(`/callback?state=${state}&code=synthetic-code`)).status).toBe(400); expect(mockFetch).not.toHaveBeenCalled();
});
test('account revocation during OAuth exchange prevents a late connection', async () => {
  const start = await mutation('post','/connect'), state = new URL(start.body.authorizationUrl).searchParams.get('state');
  const original = mockFetch.getMockImplementation(); mockFetch.mockImplementation(async (...args) => { if (new URL(String(args[0])).pathname === '/oauth/token') await User.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return original(...args); });
  expect((await get(`/callback?state=${state}&code=synthetic-code`)).status).toBe(403); expect(await Connection.countDocuments()).toBe(0);
});
test('disconnect during OAuth exchange cancels the consumed state and prevents a late connection', async () => {
  const start = await mutation('post','/connect'), state = new URL(start.body.authorizationUrl).searchParams.get('state');
  const original = mockFetch.getMockImplementation(); mockFetch.mockImplementation(async (...args) => { if (new URL(String(args[0])).pathname === '/oauth/token') expect((await mutation('delete','/connection')).status).toBe(200); return original(...args); });
  expect((await get(`/callback?state=${state}&code=synthetic-code`)).status).toBe(409); expect(await Connection.countDocuments()).toBe(0);
});
test('token refresh preserves the existing refresh grant when provider does not rotate it', async () => {
  await establishConnection(new Date(0));
  const original = mockFetch.getMockImplementation(); mockFetch.mockImplementation(async (...args) => new URL(String(args[0])).pathname === '/oauth/token' ? json({ access_token: 'refreshed-synthetic-token', expires_in: 3600 }) : original(...args));
  expect((await get('/matters')).status).toBe(200);
  const saved = await Connection.findOne().select('+credentials'); expect(clio.decode(saved.credentials)).toMatchObject({ accessToken: 'refreshed-synthetic-token', refreshToken: 'synthetic-refresh-token' });
});
test('a lost refresh acknowledgement requires reconnecting instead of replaying refresh', async () => {
  await establishConnection(new Date(0)); mockFetch.mockRejectedValue(new Error('synthetic network loss'));
  expect((await get('/matters')).status).toBe(503); expect((await get('/matters')).status).toBe(409); expect(mockFetch).toHaveBeenCalledTimes(1);
  expect((await get('/status')).body).toMatchObject({ connected: false, needsReconnect: true });
});
test('disconnect removes local credentials even when provider revocation is unavailable', async () => {
  await establishConnection(); mockFetch.mockRejectedValue(new Error('synthetic unavailable'));
  const result = await mutation('delete','/connection'); expect(result.status).toBe(200); expect(result.body).toMatchObject({ connected: false, providerRevoked: false, revokeRefreshTokenInClio: true });
  expect((await Connection.findOne().select('+credentials')).credentials).toBe(''); expect((await get('/matters')).status).toBe(409);
});
test('handoff preserves confidential source details privately and creates a blank unpublished draft', async () => {
  await establishConnection(); const requestId = crypto.randomUUID();
  const result = await mutation('post','/handoffs', { clioMatterId: '123', documentIds: ['21'], requestId, confirmed: true }); expect(result.status).toBe(200);
  const stored = await Handoff.findById(result.body.handoffId).select('+payload'); expect(stored.payload).toMatch(/^enc:v1:/); expect(stored.payload).not.toContain('Confidential');
  const draft = await CaseDraft.findById(result.body.draftId); expect(draft.description).toBe(''); expect(draft.title).toBe(''); expect(draft.publishedCaseId).toBeNull();
  expect((await mutation('post','/handoffs', { clioMatterId: '123', documentIds: ['21'], requestId, confirmed: true })).body.handoffId).toBe(result.body.handoffId);
  expect(await CaseDraft.countDocuments()).toBe(1);
});
test('handoffs require explicit consent and cannot select a document from another Clio matter', async () => {
  await establishConnection(); expect((await mutation('post','/handoffs', { clioMatterId: '123', documentIds: ['21'], requestId: crypto.randomUUID() })).status).toBe(400);
  const original = mockFetch.getMockImplementation(); mockFetch.mockImplementation(async (...args) => new URL(String(args[0])).pathname === '/api/v4/documents/21.json' ? json({ data: sourceDocument({ matter: { id: 999 } }) }) : original(...args));
  expect((await mutation('post','/handoffs', { clioMatterId: '123', documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true })).status).toBe(403); expect(await CaseDraft.countDocuments()).toBe(0);
});
test('a stale Clio account selection cannot create a handoff under a new connection', async () => {
  const connection = await establishConnection(), oldRevision = connection.revision;
  await Connection.updateOne({ _id: connection._id }, { $set: { revision: crypto.randomUUID(), clioUserId: '2002' } });
  expect((await mutation('post','/handoffs', { clioMatterId: '123', documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true, expectedConnectionRevision: oldRevision })).status).toBe(409);
  expect(mockFetch).not.toHaveBeenCalled(); expect(await CaseDraft.countDocuments()).toBe(0);
});
async function fundedHandoff() {
  const result = await mutation('post','/handoffs', { clioMatterId: '123', documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true });
  await CaseDraft.updateOne({ _id: result.body.draftId }, { $set: { publishedCaseId: matter._id } }); return result.body;
}
test('handoff list is owner-scoped and bound to its published LPC matter', async () => {
  await establishConnection(); const handoff = await fundedHandoff();
  expect((await get(`/handoffs?caseId=${matter._id}`)).body.items[0]).toMatchObject({ handoffId: handoff.handoffId, clioMatterId: '123', documents: [{ id: '21', name: 'Source.txt' }] });
  expect((await get(`/handoffs?caseId=${matter._id}`, cookie(other))).status).toBe(404);
  expect((await get('/handoffs', cookie(other))).body.items).toEqual([]);
});
test('funded imports use the normal file ledger once and retain current-assignment timestamps', async () => {
  await establishConnection(); const handoff = await fundedHandoff(), requestId = crypto.randomUUID(), body = { handoffId: handoff.handoffId, documentIds: ['21'], requestId, confirmed: true };
  const first = await mutation('post',`/matters/${matter._id}/import`, body); expect(first.status).toBe(200); expect(first.body.files).toHaveLength(1);
  const saved = await CaseFile.findById(first.body.files[0].id); expect(saved.createdAt.getTime()).toBeGreaterThanOrEqual(matter.hiredAt.getTime()); expect(decryptCaseFilePayload(saved).storageKey).toMatch(/\/documents\/scan-required-/); expect(saved.status).toBe('pending_review');
  const repeated = await mutation('post',`/matters/${matter._id}/import`, body); expect(repeated.status).toBe(200); expect(repeated.body.files[0].id).toBe(first.body.files[0].id);
  expect(mockStorage.mock.calls.filter(([command]) => command.constructor.name === 'PutObjectCommand')).toHaveLength(1);
});
test('unfunded or revoked matter imports do not contact Clio or storage', async () => {
  await establishConnection(); await Case.collection.updateOne({ _id: matter._id }, { $set: { escrowStatus: 'pending' } });
  expect((await mutation('post',`/matters/${matter._id}/import`, { handoffId: String(new mongoose.Types.ObjectId()), documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true })).status).toBe(403);
  expect(mockStorage).not.toHaveBeenCalled(); expect(mockFetch).not.toHaveBeenCalled();
});
test('source versions changed after handoff are not silently imported', async () => {
  await establishConnection(); const handoff = await fundedHandoff(), original = mockFetch.getMockImplementation(); mockFetch.mockImplementation(async (...args) => new URL(String(args[0])).pathname === '/api/v4/documents/21.json' ? json({ data: sourceDocument({ latest_document_version: { id: 32, uuid: 'new-version', size: 15, content_type: 'text/plain', fully_uploaded: true } }) }) : original(...args));
  expect((await mutation('post',`/matters/${matter._id}/import`, { handoffId: handoff.handoffId, documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true })).status).toBe(409); expect(mockStorage).not.toHaveBeenCalled();
});
test.each(['https://evil.test/file?X-Amz-Signature=x','http://127.0.0.1/file?X-Amz-Signature=x','https://s3.eu-west-1.amazonaws.com/file?X-Amz-Signature=x','https://s3.us-west-2.amazonaws.com/file'])('provider storage destinations fail closed: %s', value => { expect(() => clio.transferUrl(value)).toThrow(); });
test('exports require approval and explicit consent before sending document bytes', async () => {
  await establishConnection();
  expect((await mutation('post',`/matters/${matter._id}/export`, { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID() })).status).toBe(400);
  await CaseFile.updateOne({ _id: file._id }, { $set: { status: 'pending_review' } });
  expect((await mutation('post',`/matters/${matter._id}/export`, { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true })).status).toBe(403); expect(mockStorage).not.toHaveBeenCalled(); expect(mockFetch).not.toHaveBeenCalled();
});
test('export creates, uploads and finalizes one Clio document; exact retry returns the recorded result', async () => {
  await establishConnection(); const body = { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true };
  const first = await mutation('post',`/matters/${matter._id}/export`, body); expect(first.status).toBe(200); expect(first.body).toMatchObject({ clioDocumentId: '7001', status: 'recorded' });
  expect((await mutation('post',`/matters/${matter._id}/export`, body)).body).toMatchObject({ clioDocumentId: '7001', replayed: true }); expect(remoteCreated).toBe(1); expect(await Transfer.countDocuments()).toBe(1);
  const upload = mockFetch.mock.calls.find(([input, options]) => new URL(String(input)).hostname === 's3.us-west-2.amazonaws.com' && options.method === 'PUT'); expect(upload[1].headers.Authorization).toBeUndefined(); expect(upload[1].body.toString()).toBe('approved work');
});
test('an acknowledged remote document with a lost response is reconciled without creating another', async () => {
  await establishConnection(); const original = mockFetch.getMockImplementation(); let once = false;
  mockFetch.mockImplementation(async (...args) => { const value = await original(...args); if (!once && new URL(String(args[0])).pathname === '/api/v4/documents.json' && args[1].method === 'POST') { once = true; throw new Error('synthetic lost create acknowledgement'); } return value; });
  const body = { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true };
  expect((await mutation('post',`/matters/${matter._id}/export`, body)).status).toBe(503);
  expect((await mutation('post',`/matters/${matter._id}/export`, body)).status).toBe(200); expect(remoteCreated).toBe(1);
});
test('a refreshed export request identity replays the same recorded source and destination', async () => {
  await establishConnection(); const body = { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true };
  const first = await mutation('post',`/matters/${matter._id}/export`, body), alias = crypto.randomUUID(); expect(first.status).toBe(200);
  const repeated = await mutation('post',`/matters/${matter._id}/export`, { ...body, requestId: alias });
  expect(repeated.status).toBe(200); expect(repeated.body).toMatchObject({ transferId: first.body.transferId, clioDocumentId: '7001', replayed: true }); expect(remoteCreated).toBe(1); expect(await Transfer.countDocuments()).toBe(1);
  const recorded = await Transfer.findById(first.body.transferId); expect(recorded.requestIds).toEqual(expect.arrayContaining([body.requestId, alias]));
  const anotherFile = await CaseFile.create({ caseId: matter._id, userId: para._id, originalName: 'OtherApproved.txt', storageKey: `cases/${matter._id}/documents/another.txt`, mimeType: 'text/plain', size: 13, uploadedByRole: 'paralegal', status: 'approved', securityStatus: 'not_required' });
  expect((await mutation('post',`/matters/${matter._id}/export`, { ...body, fileId: String(anotherFile._id), requestId: alias })).status).toBe(409); expect(remoteCreated).toBe(1);
});
test('a refreshed request reconciles a lost create acknowledgement without a second provider document', async () => {
  await establishConnection(); const original = mockFetch.getMockImplementation(); let once = false;
  mockFetch.mockImplementation(async (...args) => { const value = await original(...args); if (!once && new URL(String(args[0])).pathname === '/api/v4/documents.json' && args[1].method === 'POST') { once = true; throw new Error('synthetic lost create acknowledgement'); } return value; });
  const body = { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true };
  expect((await mutation('post',`/matters/${matter._id}/export`, body)).status).toBe(503);
  const pending = await Transfer.findOne().lean(); const recovered = await mutation('post',`/matters/${matter._id}/export`, { ...body, requestId: crypto.randomUUID() });
  expect(recovered.status).toBe(200); expect(recovered.body.transferId).toBe(String(pending._id)); expect(remoteCreated).toBe(1); expect(await Transfer.countDocuments()).toBe(1);
});
test('concurrent fresh request identities cannot create two provider documents for the same export', async () => {
  await establishConnection(); const body = { fileId: String(file._id), clioMatterId: '123', confirmed: true };
  const responses = await Promise.all([mutation('post',`/matters/${matter._id}/export`, { ...body, requestId: crypto.randomUUID() }), mutation('post',`/matters/${matter._id}/export`, { ...body, requestId: crypto.randomUUID() })]);
  expect(responses.some(response => response.status === 200)).toBe(true); expect(responses.every(response => [200,409].includes(response.status))).toBe(true); expect(remoteCreated).toBe(1); expect(await Transfer.countDocuments()).toBe(1);
});
test('fresh import identities replay existing source versions without another file copy', async () => {
  await establishConnection(); const handoff = await fundedHandoff(), body = { handoffId: handoff.handoffId, documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true };
  const first = await mutation('post',`/matters/${matter._id}/import`, body); expect(first.status).toBe(200);
  const again = await mutation('post',`/matters/${matter._id}/import`, { ...body, requestId: crypto.randomUUID() });
  expect(again.status).toBe(200); expect(again.body).toMatchObject({ transferId: first.body.transferId, replayed: true }); expect(again.body.files[0].id).toBe(first.body.files[0].id);
  expect(mockStorage.mock.calls.filter(([command]) => command.constructor.name === 'PutObjectCommand')).toHaveLength(1);
});
test('transfers fail closed when the durable fingerprint index is missing', async () => {
  await establishConnection(); const indexes = await Transfer.collection.indexes(), index = indexes.find(value => value.key.direction && value.key.fingerprint);
  await Transfer.collection.dropIndex(index.name);
  try { const result = await mutation('post',`/matters/${matter._id}/export`, { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true }); expect(result.status).toBe(503); expect(result.body.code).toBe('CLIO_TRANSFER_INDEX_UNAVAILABLE'); expect(remoteCreated).toBe(0); }
  finally { await Transfer.collection.createIndex({ ownerId: 1, direction: 1, fingerprint: 1 }, { unique: true }); }
});
test('registering the Clio matter action twice reuses its existing action', async () => {
  await establishConnection(); const original = mockFetch.getMockImplementation(); let created = null, creates = 0;
  mockFetch.mockImplementation(async (...args) => {
    if (new URL(String(args[0])).pathname !== '/api/v4/custom_actions.json') return original(...args);
    if (args[1].method === 'POST') { creates++; created = { id: 9001, ...JSON.parse(args[1].body).data }; return json({ data: created }, 201); }
    return json({ data: created ? [created] : [] });
  });
  expect((await mutation('post','/custom-action')).body.id).toBe('9001');
  expect((await mutation('post','/custom-action')).body).toMatchObject({ id: '9001', replayed: true }); expect(creates).toBe(1);
});
test('a foreign document ID cannot be exported through an owned matter', async () => {
  await establishConnection(); const foreign = await CaseFile.create({ caseId: new mongoose.Types.ObjectId(), userId: other._id, originalName: 'Other.txt', storageKey: 'cases/foreign/documents/other.txt', status: 'approved' });
  expect((await mutation('post',`/matters/${matter._id}/export`, { fileId: String(foreign._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true })).status).toBe(403); expect(mockFetch).not.toHaveBeenCalled(); expect(mockStorage).not.toHaveBeenCalled();
});
