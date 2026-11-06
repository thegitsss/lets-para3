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

function largePdf(size) {
  const block = Buffer.alloc(64 * 1024, 65), prefix = Buffer.from('%PDF-1.7\n');
  return Readable.from((async function* () { yield prefix; for (let offset = prefix.length; offset < size; offset += block.length) yield block.subarray(0, Math.min(block.length, size - offset)); })());
}
test('large Clio imports stream to private storage and retain the exact original size', async () => {
  await establishConnection(); const size = 21 * 1024 * 1024, original = mockFetch.getMockImplementation(); let uploadedBytes = 0;
  const document = sourceDocument({ name: 'Exhibits.pdf', filename: 'Exhibits.pdf', latest_document_version: { id: 31, uuid: 'large-pdf-31', size, content_type: 'application/pdf', fully_uploaded: true } });
  mockFetch.mockImplementation(async (input, options = {}) => { const url = new URL(String(input)); if (url.pathname === '/api/v4/documents/21.json') return json({ data: document }); if (url.hostname === 's3.us-west-2.amazonaws.com' && options.method !== 'PUT') return new Response(largePdf(size), { headers: { 'content-length': String(size) } }); return original(input, options); });
  mockStorage.mockImplementation(async command => { if (command.constructor.name === 'PutObjectCommand') { expect(Buffer.isBuffer(command.input.Body)).toBe(false); for await (const chunk of command.input.Body) uploadedBytes += chunk.length; } return {}; });
  const handoff = await fundedHandoff();
  const result = await mutation('post', `/matters/${matter._id}/import`, { handoffId: handoff._id || handoff.handoffId, documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true });
  expect(result.status).toBe(200); expect(uploadedBytes).toBe(size);
  expect((await CaseFile.findById(result.body.files[0].id)).size).toBe(size);
});
test('large Clio exports use checked multipart instructions and recover a failed part automatically', async () => {
  await establishConnection(); const size = 101 * 1024 * 1024, original = mockFetch.getMockImplementation(), uploaded = new Map(); let failedPart = false, declared;
  file.originalName = 'Approved exhibits.pdf'; file.mimeType = 'application/pdf'; file.size = size; await file.save();
  mockStorage.mockImplementation(async command => command.constructor.name === 'HeadObjectCommand' ? { ContentLength: size, ETag: '"large-pdf"' } : command.constructor.name === 'GetObjectCommand' ? { Body: largePdf(size), ContentLength: size, ETag: '"large-pdf"' } : {});
  mockFetch.mockImplementation(async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v4/documents.json' && options.method === 'POST') {
      const result = await original(input, options); declared = JSON.parse(options.body).data.multiparts; expect(declared).toHaveLength(7);
      remoteDocument.latest_document_version.multiparts = declared.map(part => ({ part_number: part.part_number, put_url: `https://s3.us-west-2.amazonaws.com/iris-production/part?X-Amz-Signature=synthetic&partNumber=${part.part_number}`, put_headers: [{ name: 'Content-Length', value: String(part.content_length) }, { name: 'Content-MD5', value: part.content_md5 }] }));
      return json({ data: remoteDocument }, result.status);
    }
    if (url.hostname === 's3.us-west-2.amazonaws.com' && options.method === 'PUT') {
      const number = Number(url.searchParams.get('partNumber'));
      if (number === 2 && !failedPart) { failedPart = true; return new Response('', { status: 503 }); }
      const md5 = crypto.createHash('md5'); let bytes = 0;
      for await (const chunk of options.body) { md5.update(chunk); bytes += chunk.length; }
      expect(bytes).toBe(declared[number - 1].content_length); expect(md5.digest('base64')).toBe(declared[number - 1].content_md5);
      uploaded.set(number, bytes); remoteUploaded = uploaded.size === declared.length; return new Response('', { status: 200 });
    }
    return original(input, options);
  });
  const result = await mutation('post', `/matters/${matter._id}/export`, { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true });
  expect(result.status).toBe(200); expect(result.body.status).toBe('recorded'); expect(failedPart).toBe(true); expect(remoteCreated).toBe(1); expect([...uploaded.values()].reduce((sum, bytes) => sum + bytes, 0)).toBe(size);
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
test('OAuth preserves only an owned unpublished return draft and returns to it after authorization',async()=>{
  const draft=await CaseDraft.create({owner:owner._id,title:'Keep my draft notes',status:'draft'});
  const foreign=await CaseDraft.create({owner:other._id,title:'Another account draft',status:'draft'});
  expect((await mutation('post','/connect',{returnDraftId:String(foreign._id)})).status).toBe(400);
  const start=await mutation('post','/connect',{returnDraftId:String(draft._id)});expect(start.status).toBe(200);
  const state=new URL(start.body.authorizationUrl).searchParams.get('state');const record=await OAuthState.findOne({tokenHash:clio.hash(state)}).lean();expect(String(record.returnDraftId)).toBe(String(draft._id));
  const callback=await get(`/callback?state=${state}&code=synthetic-code`);expect(callback.status).toBe(303);expect(callback.headers.location).toBe('/clio-connect.html?connected=1&draftId='+draft._id);
});
test('OAuth returns a blank New Matter to the same entry after connection or decline',async()=>{
  expect((await mutation('post','/connect',{returnToNewMatter:'https://evil.test'})).status).toBe(400);
  for(const declined of [false,true]){
    const start=await mutation('post','/connect',{returnToNewMatter:true});expect(start.status).toBe(200);
    const state=new URL(start.body.authorizationUrl).searchParams.get('state');
    const result=await get(`/callback?state=${state}&${declined?'error=access_denied':'code=synthetic-code'}`);
    expect(result.status).toBe(303);expect(result.headers.location).toBe('/clio-connect.html?connected='+(declined?'0':'1')+'&newMatter=1');
  }
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
test('an explicitly reviewed public brief fills the posting draft without copying private Clio context', async () => {
  await establishConnection();
  const body = { clioMatterId: '123', documentIds: ['21'], expectedDocuments: [{ id: '21', versionId: '31', versionUuid: 'source-version-31' }], publicWorkBrief: { title: 'Prepare a document chronology', description: 'Organize the supplied records into a chronology for attorney review.', tasks: ['Prepare the chronology'] }, publicBriefConfirmed: true, requestId: crypto.randomUUID(), confirmed: true };
  const result = await mutation('post','/handoffs',body); expect(result.status).toBe(200);
  const draft = await CaseDraft.findById(result.body.draftId); expect(draft.title).toBe(body.publicWorkBrief.title); expect(draft.description).toBe(body.publicWorkBrief.description); expect(draft.tasks.map(item => item.title)).toEqual(body.publicWorkBrief.tasks); expect(JSON.stringify(draft)).not.toContain('Confidential client facts');
  expect((await mutation('post','/handoffs',{ ...body, publicWorkBrief: { ...body.publicWorkBrief, title: 'A different assignment' } })).status).toBe(409);
  expect((await mutation('post','/handoffs',{ ...body, requestId: crypto.randomUUID(), publicBriefConfirmed: false })).status).toBe(400);
});
test('source versions changed before handoff confirmation are rejected before any draft is created', async () => {
  await establishConnection();
  const result = await mutation('post','/handoffs',{ clioMatterId: '123', documentIds: ['21'], expectedDocuments: [{ id: '21', versionId: '30', versionUuid: 'old-version' }], requestId: crypto.randomUUID(), confirmed: true });
  expect(result.status).toBe(409); expect(result.body.code).toBe('CLIO_SOURCE_CHANGED'); expect(await CaseDraft.countDocuments()).toBe(0); expect(await Handoff.countDocuments()).toBe(0);
});
test('a direct funded-matter selection imports documents without creating another posting draft', async () => {
  await establishConnection(); const selected = await mutation('post',`/matters/${matter._id}/handoffs`,{ clioMatterId: '123', documentIds: ['21'], expectedDocuments: [{ id: '21', versionId: '31', versionUuid: 'source-version-31' }], requestId: crypto.randomUUID(), confirmed: true });
  expect(selected.status).toBe(200); expect(selected.body).toMatchObject({ caseId: String(matter._id), draftId: null, documentsDeferredUntilFunding: false }); expect(await CaseDraft.countDocuments()).toBe(0);
  const imported = await mutation('post',`/matters/${matter._id}/import`,{ handoffId: selected.body.handoffId, documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true }); expect(imported.status).toBe(200);
  const choices = await get(`/handoffs?caseId=${matter._id}`); expect(choices.body.items.map(item => item.handoffId)).toContain(selected.body.handoffId);
  const receipt = await get(`/transfers?caseId=${matter._id}`); expect(receipt.status).toBe(200); expect(receipt.body.items[0]).toMatchObject({ direction: 'import', status: 'recorded', label: 'SYN-123', handoffId: selected.body.handoffId, documentCount: 1, retry: null }); expect(JSON.stringify(receipt.body)).not.toMatch(/synthetic-access-token|X-Amz-Signature|putUrl/);
});
test('direct Clio selections require current funding, ownership and reviewed source versions', async () => {
  await establishConnection(); const body = { clioMatterId: '123', documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true };
  expect((await mutation('post',`/matters/${matter._id}/handoffs`, body, cookie(other))).status).toBe(403);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { escrowStatus: 'pending' } });
  expect((await mutation('post',`/matters/${matter._id}/handoffs`, body)).status).toBe(403); expect(await Handoff.countDocuments()).toBe(0); expect(mockFetch).not.toHaveBeenCalled();
});
test('OAuth can return to the owned matter that initiated the connection without accepting arbitrary destinations', async () => {
  const start = await mutation('post','/connect',{ returnCaseId: String(matter._id) }), state = new URL(start.body.authorizationUrl).searchParams.get('state');
  expect((await get(`/callback?state=${state}&code=synthetic-code`)).headers.location).toBe(`/clio-connect.html?connected=1&caseId=${matter._id}`);
  expect((await mutation('post','/connect',{ returnCaseId: 'https://evil.test' })).status).toBe(400);
  const foreign = await Case.create({ attorney: other._id, attorneyId: other._id, title: 'Foreign', details: 'A foreign matter', status: 'open', totalAmount: 50000 });
  expect((await mutation('post','/connect',{ returnCaseId: String(foreign._id) })).status).toBe(404);
});
test('stale owner headers cannot read another account connection or transfer history', async () => {
  expect((await get('/status').set('X-LPC-Owner-Id', String(other._id))).status).toBe(403);
  expect((await get(`/transfers?caseId=${matter._id}`).set('X-LPC-Owner-Id', String(other._id))).status).toBe(403); expect(mockFetch).not.toHaveBeenCalled();
});
test('recovery reads the selected matter through the original Clio account without replaying a nonce', async () => {
  const connection = await establishConnection();
  const result = await get(`/matters/123/context?expectedUserId=1001&expectedConnectionRevision=${connection.revision}`); expect(result.status).toBe(200); expect(result.body.matter.id).toBe('123');
  expect((await get(`/matters/123/context?expectedUserId=2002&expectedConnectionRevision=${connection.revision}`)).status).toBe(409);
  expect((await get('/matters/123/context?expectedUserId=1001&expectedConnectionRevision=stale')).status).toBe(409);
  expect(mockFetch.mock.calls.some(([input]) => new URL(String(input)).searchParams.has('custom_action_nonce'))).toBe(false);
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
test('a document replaced after native review cannot be exported as the reviewed earlier version', async () => {
  await establishConnection(); await CaseFile.updateOne({ _id: file._id }, { $set: { version: 2 } });
  const result = await mutation('post',`/matters/${matter._id}/export`,{ fileId: String(file._id), expectedFileVersion: 1, clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true });
  expect(result.status).toBe(409); expect(result.body.code).toBe('CLIO_FILE_CHANGED'); expect(mockFetch).not.toHaveBeenCalled(); expect(mockStorage).not.toHaveBeenCalled();
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
test('a pending Clio upload resolves its sole version before latest_document_version is populated', async () => {
  await establishConnection(); const original = mockFetch.getMockImplementation();
  mockFetch.mockImplementation(async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v4/documents/7001/versions.json') return json({ data: [remoteDocument.latest_document_version] });
    const response = await original(input, options);
    if (!remoteUploaded && (url.pathname === '/api/v4/documents/7001.json' || url.pathname === '/api/v4/documents.json' && options.method === 'POST')) return json({ data: { ...remoteDocument, latest_document_version: null } }, response.status);
    return response;
  });
  const response = await mutation('post', `/matters/${matter._id}/export`, { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true });
  expect(response.status).toBe(200); expect(response.body.status).toBe('recorded'); expect(remoteUploaded).toBe(true); expect(remoteCreated).toBe(1);
});
test('lost acknowledgements recover an incomplete upload by its exact transfer property', async () => {
  await establishConnection(); const original = mockFetch.getMockImplementation(); let lost = false;
  mockFetch.mockImplementation(async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v4/documents/7001/versions.json') return json({ data: [remoteDocument.latest_document_version] });
    if (url.pathname === '/api/v4/documents.json' && options.method !== 'POST' && url.searchParams.has('external_property_name')) {
      expect(url.searchParams.get('show_uncompleted')).toBe('true');
      expect(url.searchParams.get('external_property_value')).toBe(String((await Transfer.findOne())._id));
      return json({ data: [{ ...remoteDocument, latest_document_version: null }] });
    }
    const response = await original(input, options);
    if (url.pathname === '/api/v4/documents.json' && options.method === 'POST' && !lost) { lost = true; throw Error('lost acknowledgement for an incomplete upload'); }
    if (url.pathname === '/api/v4/documents/7001.json' && !remoteUploaded) return json({ data: { ...remoteDocument, latest_document_version: null } });
    return response;
  });
  const body = { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true };
  expect((await mutation('post', `/matters/${matter._id}/export`, body)).status).toBe(503);
  expect((await mutation('post', `/matters/${matter._id}/export`, body)).status).toBe(200); expect(remoteCreated).toBe(1); expect(await Transfer.countDocuments()).toBe(1);
});
test.each(['multiple', 'changed', 'paged'])('a %s pending version response cannot upload into an unreviewed version', async shape => {
  await establishConnection(); const original = mockFetch.getMockImplementation();
  mockFetch.mockImplementation(async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v4/documents/7001/versions.json') {
      const version = { ...remoteDocument.latest_document_version };
      return json({ data: shape === 'multiple' ? [version, { ...version, uuid: 'another-version' }] : [{ ...version, ...(shape === 'changed' ? { uuid: 'another-version' } : {}) }], ...(shape === 'paged' ? { meta: { paging: { next: 'https://app.clio.com/api/v4/documents/7001/versions.json?page_token=more' } } } : {}) });
    }
    const response = await original(input, options);
    if (url.pathname === '/api/v4/documents/7001.json' && !remoteUploaded) return json({ data: { ...remoteDocument, latest_document_version: null } });
    return response;
  });
  const response = await mutation('post', `/matters/${matter._id}/export`, { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true });
  expect(response.status).toBe(409); expect(response.body.code).toBe('CLIO_EXPORT_CHANGED'); expect(remoteUploaded).toBe(false); expect(remoteCreated).toBe(1);
});
test.each([false, true])('redacted transfer identity uses an exact document filter without broader access, lost acknowledgement: %s', async lostAcknowledgement => {
  await establishConnection(); const original = mockFetch.getMockImplementation(); let lost = false;
  mockFetch.mockImplementation(async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v4/documents.json' && url.searchParams.has('external_property_name')) {
      expect(url.searchParams.get('external_property_value')).toBe(String((await Transfer.findOne())._id));
      expect(url.searchParams.get('show_uncompleted')).toBe('true');
      return json({ data: [url.searchParams.get('fields') === 'id,matter{id}' ? { id: remoteDocument.id, matter: remoteDocument.matter } : { ...remoteDocument, external_properties: [{ redacted: true }] }] });
    }
    const response = await original(input, options);
    if (url.pathname === '/api/v4/documents.json' && options.method === 'POST') {
      if (lostAcknowledgement && !lost) { lost = true; throw Error('lost response for redacted transfer metadata'); }
      return json({ data: { ...remoteDocument, external_properties: [{ redacted: true }] } }, 201);
    }
    return url.pathname === '/api/v4/documents/7001.json' ? json({ data: { ...remoteDocument, external_properties: [{ redacted: true }] } }) : response;
  });
  const body = { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true };
  if (lostAcknowledgement) expect((await mutation('post', `/matters/${matter._id}/export`, body)).status).toBe(503);
  const response = await mutation('post', `/matters/${matter._id}/export`, body);
  expect(response.status).toBe(200); expect(response.body.status).toBe('recorded'); expect(remoteUploaded).toBe(true); expect(remoteCreated).toBe(1); expect(await Transfer.countDocuments()).toBe(1);
});
test.each(['unmatched', 'different document', 'different matter', 'paged'])('a redacted identity with a %s filter result cannot upload document bytes', async shape => {
  await establishConnection(); const original = mockFetch.getMockImplementation();
  mockFetch.mockImplementation(async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v4/documents.json' && url.searchParams.has('external_property_name')) return json({ data: shape === 'unmatched' ? [] : [{ id: shape === 'different document' ? 7002 : 7001, matter: { id: shape === 'different matter' ? 124 : 123 } }], ...(shape === 'paged' ? { meta: { paging: { next: 'https://app.clio.com/api/v4/documents.json?page_token=more' } } } : {}) });
    const response = await original(input, options);
    return url.pathname === '/api/v4/documents.json' && options.method === 'POST' ? json({ data: { ...remoteDocument, external_properties: [{ redacted: true }] } }, 201) : response;
  });
  const response = await mutation('post', `/matters/${matter._id}/export`, { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true });
  expect(response.status).toBe(409); expect(response.body.code).toBe('CLIO_EXPORT_RECONCILIATION'); expect(remoteUploaded).toBe(false); expect((await Transfer.findOne()).status).toBe('uncertain');
});
test('readable mismatched transfer metadata cannot use the redaction recovery path', async () => {
  await establishConnection(); const original = mockFetch.getMockImplementation();
  mockFetch.mockImplementation(async (input, options = {}) => {
    const response = await original(input, options), url = new URL(String(input));
    return url.pathname === '/api/v4/documents.json' && options.method === 'POST' ? json({ data: { ...remoteDocument, external_properties: [{ name: 'LPC Transfer', value: 'another-transfer' }] } }, 201) : response;
  });
  const response = await mutation('post', `/matters/${matter._id}/export`, { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true });
  expect(response.status).toBe(409); expect(remoteUploaded).toBe(false);
  expect(mockFetch.mock.calls.some(([input]) => new URL(String(input)).searchParams.has('external_property_name'))).toBe(false);
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
test('an uncertain export exposes only a safe exact retry receipt and retains it after disconnect', async () => {
  await establishConnection(); const original = mockFetch.getMockImplementation(); let once = false;
  mockFetch.mockImplementation(async (...args) => { const value = await original(...args); if (!once && new URL(String(args[0])).pathname === '/api/v4/documents.json' && args[1].method === 'POST') { once = true; throw new Error('synthetic lost create acknowledgement'); } return value; });
  const body = { fileId: String(file._id), clioMatterId: '123', requestId: crypto.randomUUID(), confirmed: true };
  expect((await mutation('post',`/matters/${matter._id}/export`, body)).status).toBe(503);
  const receipt = await get(`/transfers?caseId=${matter._id}`); expect(receipt.body.items[0]).toMatchObject({ direction: 'export', status: 'uncertain', label: 'SYN-123', fileName: 'Approved.txt', retry: { path: `${base}/matters/${matter._id}/export`, body: { fileId: String(file._id), clioMatterId: '123', requestId: body.requestId } } }); expect(JSON.stringify(receipt.body)).not.toMatch(/synthetic-access-token|synthetic-refresh-token|X-Amz-Signature|putUrl/);
  await mutation('delete','/connection'); expect((await get(`/transfers?caseId=${matter._id}`)).body.items).toHaveLength(1);
  expect((await get(`/transfers?caseId=${matter._id}`, cookie(other))).status).toBe(404);
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
test('a replacement assignment gets an explicitly imported current file rather than replaying an earlier hidden copy', async () => {
  await establishConnection(); const handoff = await fundedHandoff(), body = { handoffId: handoff.handoffId, documentIds: ['21'], requestId: crypto.randomUUID(), confirmed: true };
  const first = await mutation('post',`/matters/${matter._id}/import`,body); expect(first.status).toBe(200);
  const replacement = await User.create({ firstName: 'Replacement', lastName: 'Synthetic', email: 'replacement@clio-integration.test', password: 'Synthetic123!', role: 'paralegal', status: 'approved' }), hiredAt = new Date();
  await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegal: replacement._id, paralegalId: replacement._id, withdrawnParalegalId: para._id, hiredAt }, $inc: { __v: 1 } });
  expect((await mutation('post',`/matters/${matter._id}/import`,body)).status).toBe(409);
  const current = await mutation('post',`/matters/${matter._id}/import`,{ ...body, requestId: crypto.randomUUID() }); expect(current.status).toBe(200); expect(current.body.files[0].id).not.toBe(first.body.files[0].id);
  const fileRecord = await CaseFile.findById(current.body.files[0].id); expect(fileRecord.createdAt.getTime()).toBeGreaterThanOrEqual(hiredAt.getTime());
  expect(require('../utils/matterAssignmentVisibility').isRecordVisibleToCurrentAssignment(fileRecord, await Case.findById(matter._id), { role: 'paralegal', userId: String(replacement._id) })).toBe(true);
  const history = (await get(`/transfers?caseId=${matter._id}`)).body; expect(history.items).toHaveLength(2); expect(history.items.filter(item => item.assignmentRevision === history.assignmentRevision)).toHaveLength(1);
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
