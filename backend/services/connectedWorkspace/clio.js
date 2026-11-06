'use strict';

// US Clio Manage only. Credentials, provider upload URLs and private source
// metadata never appear in API projections or runtime logs.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Connection = require('../../models/ClioConnection');
const OAuthState = require('../../models/ClioOAuthState');
const Handoff = require('../../models/ClioHandoff');
const Transfer = require('../../models/ClioTransfer');
const CaseDraft = require('../../models/CaseDraft');
const Case = require('../../models/Case');
const CaseFile = require('../../models/CaseFile');
const User = require('../../models/User');
const { encryptString, decryptString, decryptCaseFilePayload, isEncryptionEnabled } = require('../../utils/dataEncryption');
const { withActiveAccountWrite } = require('../../utils/activeAccountWrite');
const { caseParticipantIdentity } = require('../../utils/caseParticipantIdentity');
const { findActiveSession } = require('../authSessionService');
const fileWrites = require('../matterFileWrites');
const { createS3Client } = require('../../utils/s3Client');
const { GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { confidentialStorageEncryption } = require('../../utils/storageEncryption');
const security = require('../../utils/fileSecurity');
const retirement = require('../matterStorageRetirement');
const { isRecordVisibleToCurrentAssignment } = require('../../utils/matterAssignmentVisibility');
const { stageMatterFile } = require('../../utils/matterFileArtifact');
const { MAX_MATTER_FILE_BYTES, BUFFERED_MATTER_FILE_BYTES, matterStorageOptions } = require('../../utils/matterFilePolicy');
const multipart = require('./clioMultipart');

const BASE = 'https://app.clio.com';
const MAX_FILE_BYTES = MAX_MATTER_FILE_BYTES;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const oid = value => new mongoose.Types.ObjectId(String(value));
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const clioId = value => { const text = String(value || ''); if (!/^[1-9][0-9]{0,18}$/.test(text) || !Number.isSafeInteger(Number(text))) fail(400, 'INVALID', 'Select a valid Clio record.'); return text; };
const requestId = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) fail(400, 'INVALID', 'A valid request identity is required.'); return value; };
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, publicCode: `CLIO_${code}` }); };
const encode = value => encryptString(JSON.stringify(value), { plaintext: true });
const decode = value => JSON.parse(decryptString(value));
const authVersion = req => Number(req.auth?.payload?.av ?? req.authVersion ?? 0);
const sessionHash = req => hash(req.authSessionId ? `session:${req.authSessionId}` : `token:${req.auth?.token || ''}`);
const ownerGuard = req => ({ ownerId: String(req.user.id), authVersion: authVersion(req) });
function assignmentRevision(matter) { const at = new Date(matter.hiredAt || 0); return hash(JSON.stringify([String(matter.paralegal || matter.paralegalId || ''), Number.isFinite(at.getTime()) ? at.toISOString() : ''])); }

function configuration(env = process.env) {
  try {
    const origin = new URL(env.APP_BASE_URL);
    if (origin.username || origin.password || !['http:', 'https:'].includes(origin.protocol) || env.NODE_ENV === 'production' && origin.protocol !== 'https:') return null;
    const redirect = new URL(env.CLIO_REDIRECT_URI || '/api/integrations/clio/callback', origin.origin);
    // Clio permits http://127.0.0.1 for local OAuth, but rejects localhost.
    // Preserve hosted callbacks and the application's existing base URL.
    const localCallback = env.NODE_ENV !== 'production' && origin.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && redirect.protocol === 'http:' &&
      redirect.hostname === '127.0.0.1' && redirect.port === origin.port;
    if (redirect.origin !== origin.origin && !localCallback || redirect.username || redirect.password || redirect.pathname !== '/api/integrations/clio/callback' || redirect.search || redirect.hash) return null;
    if (!env.CLIO_CLIENT_ID || !env.CLIO_CLIENT_SECRET || !isEncryptionEnabled()) return null;
    return { clientId: env.CLIO_CLIENT_ID, clientSecret: env.CLIO_CLIENT_SECRET, redirectUri: redirect.href, origin: origin.origin, version: '4.0.13' };
  } catch { return null; }
}
const configured = () => { const config = configuration(); if (!config) fail(503, 'NOT_CONFIGURED', 'Clio is not connected to LPC yet. You can continue using LPC normally.'); return config; };
function localCallbackRedirect(req, env = process.env) {
  const config = configuration(env);
  if (!config || env.NODE_ENV === 'production' || req.method !== 'GET') return null;
  const app = new URL(config.origin), callback = new URL(config.redirectUri);
  if (app.protocol !== 'http:' || app.hostname !== 'localhost' || callback.protocol !== 'http:' ||
      callback.hostname !== '127.0.0.1' || callback.port !== app.port || req.headers?.host !== callback.host ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return null;
  const destination = new URL('/api/integrations/clio/callback', app.origin);
  for (const name of ['code', 'state', 'error']) {
    const value = req.query?.[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > (name === 'code' ? 4096 : 1024)) return null;
    destination.searchParams.set(name, value);
  }
  return destination.href;
}
async function readyTransfers() {
  await Transfer.init();
  const indexes = await Transfer.collection.indexes();
  for (const key of [{ ownerId: 1, requestId: 1 }, { ownerId: 1, direction: 1, fingerprint: 1 }, { ownerId: 1, requestIds: 1 }]) {
    if (!indexes.some(index => index.unique === true && JSON.stringify(index.key) === JSON.stringify(key))) fail(503, 'TRANSFER_INDEX_UNAVAILABLE', 'Document transfers are temporarily unavailable. Try again later.');
  }
}
async function acquireTransfer(req, { direction, key, fingerprint, caseId, fileId, payload = '' }) {
  await readyTransfers();
  const byRequest = () => Transfer.findOne({ ownerId: req.user.id, $or: [{ requestId: key }, { requestIds: key }] }).select('+payload +result').lean();
  const byFingerprint = () => Transfer.findOne({ ownerId: req.user.id, direction, fingerprint }).select('+payload +result').lean();
  const assertIdentity = operation => { if (operation && (operation.direction !== direction || operation.fingerprint !== fingerprint)) fail(409, 'REQUEST_CHANGED', 'This transfer request already belongs to a different document or destination.'); };
  let operation = await byRequest(); assertIdentity(operation);
  if (!operation) operation = await byFingerprint();
  const leaseToken = crypto.randomUUID(), leaseUntil = new Date(Date.now() + 120000); let newlyCreated = false;
  if (!operation) {
    try { operation = (await Transfer.create({ ownerId: req.user.id, caseId, requestId: key, requestIds: [key], fingerprint, direction, fileId: fileId || null, leaseToken, leaseUntil, payload, status: 'preparing' })).toObject(); newlyCreated = true; }
    catch (error) {
      if (error.code !== 11000) throw error;
      operation = await byRequest(); assertIdentity(operation);
      if (!operation) operation = await byFingerprint();
      if (!operation) fail(409, 'TRANSFER_PROCESSING', 'The transfer identity is being recorded. Check again shortly.');
    }
  }
  if (!newlyCreated) {
    // Unique multikey ownership binds every newly accepted request alias. A
    // concurrent request cannot reserve that alias for a different transfer.
    try {
      const bound = await Transfer.updateOne({ _id: operation._id, ownerId: req.user.id, fingerprint, $or: [{ requestIds: key }, { 'requestIds.999': { $exists: false } }] }, { $addToSet: { requestIds: { $each: [operation.requestId, key] } } });
      if (bound.matchedCount !== 1) fail(429, 'REQUEST_LIMIT', 'This transfer has reached its retry limit. Review its recorded result.');
    } catch (error) { if (error.code === 11000) fail(409, 'REQUEST_CHANGED', 'This request identity already belongs to another transfer.'); throw error; }
    if (operation.status !== 'recorded') {
      const claimed = await Transfer.findOneAndUpdate({ _id: operation._id, fingerprint, leaseUntil: { $lte: new Date() }, status: { $ne: 'recorded' } }, { $set: { leaseToken, leaseUntil } }, { new: true }).select('+payload +result').lean();
      if (!claimed) fail(409, 'TRANSFER_PROCESSING', 'This transfer is still processing. Check again shortly.'); operation = claimed;
    }
  }
  return { operation, newlyCreated, leaseToken };
}
async function actor(req) {
  const user = await User.findById(req.user?.id).select('role status disabled deleted authVersion').lean();
  if (!user || user.role !== 'attorney' || user.status !== 'approved' || user.disabled || user.deleted || Number(user.authVersion || 0) !== authVersion(req) || req.authSessionId && !await findActiveSession(req.authSessionId, req.user.id)) fail(403, 'ACCOUNT_CHANGED', 'Sign in again before using this connection.');
  return user;
}
async function boundedBody(response, max = BUFFERED_MATTER_FILE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) fail(413, 'SIZE_LIMIT', 'The document exceeds the supported transfer size.');
  const chunks = []; let size = 0;
  if (!response.body) return Buffer.alloc(0);
  try { for await (const chunk of response.body) { size += chunk.length; if (size > max) fail(413, 'SIZE_LIMIT', 'The document exceeds the supported transfer size.'); chunks.push(Buffer.from(chunk)); } }
  catch (error) { if (error.publicCode) throw error; fail(503, 'PROVIDER_UNCONFIRMED', 'The document transfer did not finish. Check its recorded result before trying again.'); }
  return Buffer.concat(chunks);
}
async function providerFetch(url, options = {}) {
  try { return await fetch(url, { ...options, redirect: 'manual', signal: options.signal || AbortSignal.timeout(30000) }); }
  catch { fail(503, 'PROVIDER_UNCONFIRMED', 'Clio did not confirm the request. Check its recorded result before trying again.'); }
}
async function readJson(response) {
  if (!response.ok) {
    if (response.status === 401) fail(409, 'RECONNECT_REQUIRED', 'Reconnect Clio before continuing.');
    if (response.status === 403) fail(403, 'PERMISSION_REQUIRED', 'Clio does not permit this operation. Check the connection permissions.');
    if (response.status === 404) fail(404, 'RECORD_UNAVAILABLE', 'This Clio record is no longer available. Refresh the list.');
    fail(response.status === 429 ? 429 : 502, 'PROVIDER_UNAVAILABLE', 'Clio could not complete this request. Try again later.');
  }
  try { return JSON.parse((await boundedBody(response, 2 * 1024 * 1024)).toString('utf8')); }
  catch (error) { if (error.publicCode) throw error; fail(502, 'PROVIDER_INVALID', 'Clio returned an unreadable response.'); }
}
async function exchange(body, config = configured()) {
  const response = await providerFetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...body }) });
  const token = await readJson(response);
  if (typeof token.access_token !== 'string' || token.access_token.length < 8 || !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0 || token.token_type && String(token.token_type).toLowerCase() !== 'bearer') fail(502, 'PROVIDER_INVALID', 'Clio did not return a usable connection.');
  return token;
}
async function rawApi(token, path, { method = 'GET', query = {}, body, binary = false } = {}) {
  if (!/^\/[a-z_]+(?:\/[1-9][0-9]{0,18})?(?:\/[a-z_]+)?\.json$/.test(path) && path !== '/users/who_am_i.json') throw new Error('Invalid internal Clio endpoint');
  const config = configured(), url = new URL(`/api/v4${path}`, BASE);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  const response = await providerFetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-API-VERSION': config.version, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return binary ? response : readJson(response);
}
async function readConnection(req) {
  await actor(req); configured();
  const connection = await Connection.findOne({ ownerId: req.user.id, disconnectedAt: null }).select('+credentials').lean();
  if (!connection || connection.needsReconnect || connection.authVersion !== authVersion(req)) fail(409, 'RECONNECT_REQUIRED', 'Connect or reconnect Clio before continuing.');
  if (connection.expiresAt > new Date(Date.now() + 60000)) return connection;
  // A distributed lease prevents two workers from racing rotating tokens.
  // Lost refresh acknowledgements require reauthorization instead of replay.
  const lease = crypto.randomUUID();
  const claimed = await Connection.findOneAndUpdate({ _id: connection._id, revision: connection.revision, disconnectedAt: null, needsReconnect: false, $or: [{ refreshLeaseUntil: null }, { refreshLeaseUntil: { $lte: new Date() } }] }, { $set: { refreshLease: lease, refreshLeaseUntil: new Date(Date.now() + 45000) } }, { new: true }).select('+credentials').lean();
  if (!claimed) fail(409, 'REFRESH_PROCESSING', 'The Clio connection is refreshing. Try again shortly.');
  let token;
  try { const previous = decode(claimed.credentials); token = await exchange({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }); await actor(req);
    const next = await Connection.findOneAndUpdate({ _id: claimed._id, revision: claimed.revision, refreshLease: lease, disconnectedAt: null }, { $set: { credentials: encode({ accessToken: token.access_token, refreshToken: token.refresh_token || previous.refreshToken }), expiresAt: new Date(Date.now() + Number(token.expires_in) * 1000), revision: crypto.randomUUID(), refreshLease: '', refreshLeaseUntil: null } }, { new: true }).select('+credentials').lean();
    if (!next) fail(409, 'CONNECTION_CHANGED', 'The Clio connection changed. Reconnect before continuing.'); return next;
  } catch (error) { await Connection.updateOne({ _id: claimed._id, refreshLease: lease }, { $set: { needsReconnect: true, credentials: '', refreshLease: '', refreshLeaseUntil: null } }); throw error; }
}
async function api(req, path, options) {
  const connection = await readConnection(req), token = decode(connection.credentials).accessToken;
  if (req.clioConnectionRevision && connection.revision !== req.clioConnectionRevision) fail(409, 'CONNECTION_CHANGED', 'The connected Clio account changed. Refresh its records before continuing.');
  try { const result = await rawApi(token, path, options); await actor(req); const current = await Connection.exists({ _id: connection._id, revision: connection.revision, disconnectedAt: null, needsReconnect: false }); if (!current) fail(409, 'CONNECTION_CHANGED', 'The Clio connection changed. Refresh before continuing.'); return result; }
  catch (error) { if (error.publicCode === 'CLIO_RECONNECT_REQUIRED') await Connection.updateOne({ _id: connection._id, revision: connection.revision }, { $set: { needsReconnect: true } }); throw error; }
}
async function status(req) {
  await actor(req); const connection = await Connection.findOne({ ownerId: req.user.id, disconnectedAt: null }).lean();
  return { configured: Boolean(configuration()), connected: Boolean(configuration() && connection && !connection.needsReconnect && connection.authVersion === authVersion(req)), region: 'US', connectionRevision: connection?.revision || null, needsReconnect: Boolean(connection && (connection.needsReconnect || connection.authVersion !== authVersion(req))), connectedAt: connection?.connectedAt || null, ownerId: String(req.user.id) };
}
async function pinConnection(req) {
  const connection = await readConnection(req);
  if (req.body.expectedConnectionRevision !== connection.revision) fail(409, 'CONNECTION_CHANGED', 'The connected Clio account changed. Refresh its records before continuing.');
  req.clioConnectionRevision = connection.revision;
  return connection;
}
async function connect(req) {
  await actor(req); const config = configured(), state = crypto.randomBytes(32).toString('base64url');
  let returnCaseId = null, returnDraftId = null;
  if (req.body.returnCaseId !== undefined) { if (!validId(req.body.returnCaseId)) fail(400, 'INVALID', 'Choose a valid LPC matter to return to.'); await matterOwner({ ...req, params: { caseId: req.body.returnCaseId } }); returnCaseId = req.body.returnCaseId; }
  if (req.body.returnDraftId !== undefined) {
    if (returnCaseId || !validId(req.body.returnDraftId) || !await CaseDraft.exists({ _id: req.body.returnDraftId, owner: req.user.id, publishedCaseId: null, status: 'draft' })) fail(400, 'INVALID', 'Choose an available draft to return to.');
    returnDraftId = req.body.returnDraftId;
  }
  if (req.body.returnToNewMatter !== undefined && (typeof req.body.returnToNewMatter !== 'boolean' || returnCaseId || returnDraftId)) fail(400, 'INVALID', 'Choose one LPC destination to return to.');
  const returnToNewMatter = req.body.returnToNewMatter === true;
  await withActiveAccountWrite([req.user.id], async session => { const current = await Connection.findOne({ ownerId: req.user.id }).select('revision').session(session).lean(); return OAuthState.create([{ tokenHash: hash(state), ownerId: req.user.id, sessionHash: sessionHash(req), authVersion: authVersion(req), connectionRevision: current?.revision || '', returnCaseId, returnDraftId, returnToNewMatter, expiresAt: new Date(Date.now() + 10 * 60000) }], { session }); }, ownerGuard(req));
  const url = new URL('/oauth/authorize', BASE); for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, state, redirect_on_decline: 'true' })) url.searchParams.set(key, value);
  return { authorizationUrl: url.href };
}
async function callback(req) {
  await actor(req); const config = configured();
  if (typeof req.query.state !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(req.query.state)) fail(400, 'STATE_INVALID', 'This Clio connection request is invalid or expired.');
  const pending = await OAuthState.findOneAndUpdate({ tokenHash: hash(req.query.state), ownerId: req.user.id, sessionHash: sessionHash(req), authVersion: authVersion(req), consumedAt: null, canceledAt: null, expiresAt: { $gt: new Date() } }, { $set: { consumedAt: new Date() } }, { new: true }).lean();
  if (!pending) fail(400, 'STATE_INVALID', 'This Clio connection request is invalid or expired.');
  const returnHref = value => `/clio-connect.html?connected=${value}${pending.returnCaseId ? `&caseId=${pending.returnCaseId}` : pending.returnDraftId ? `&draftId=${pending.returnDraftId}` : pending.returnToNewMatter ? '&newMatter=1' : ''}`;
  if (req.query.error) return { href: returnHref(0) };
  if (typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) fail(400, 'CODE_INVALID', 'Clio did not supply an authorization code.');
  const token = await exchange({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: config.redirectUri });
  if (typeof token.refresh_token !== 'string' || !token.refresh_token) fail(502, 'PROVIDER_INVALID', 'Clio did not return a refreshable connection.');
  const identity = (await rawApi(token.access_token, '/users/who_am_i.json', { query: { fields: 'id' } })).data;
  const userId = clioId(identity?.id);
  await withActiveAccountWrite([req.user.id], async session => {
    if (!await OAuthState.exists({ _id: pending._id, canceledAt: null, expiresAt: { $gt: new Date() } }).session(session)) fail(409, 'CONNECTION_CHANGED', 'This authorization was canceled. Start a new Clio connection request.');
    const current = await Connection.findOne({ ownerId: req.user.id }).select('revision').session(session).lean();
    if ((current?.revision || '') !== (pending.connectionRevision || '')) fail(409, 'CONNECTION_CHANGED', 'The Clio connection changed while authorization was pending. Start a new connection request.');
    await Connection.findOneAndUpdate({ ownerId: req.user.id }, { $set: { credentials: encode({ accessToken: token.access_token, refreshToken: token.refresh_token }), authVersion: authVersion(req), clioUserId: userId, revision: crypto.randomUUID(), expiresAt: new Date(Date.now() + Number(token.expires_in) * 1000), connectedAt: new Date(), disconnectedAt: null, needsReconnect: false, refreshLease: '', refreshLeaseUntil: null } }, { upsert: true, session });
  }, ownerGuard(req));
  return { href: returnHref(1) };
}
async function disconnect(req) {
  await actor(req); const connection = await Connection.findOne({ ownerId: req.user.id, disconnectedAt: null }).select('+credentials').lean();
  await withActiveAccountWrite([req.user.id], async session => { await Connection.updateOne({ ownerId: req.user.id }, { $set: { disconnectedAt: new Date(), credentials: '', needsReconnect: false, revision: crypto.randomUUID(), refreshLease: '', refreshLeaseUntil: null } }, { session }); await OAuthState.updateMany({ ownerId: req.user.id, expiresAt: { $gt: new Date() } }, { $set: { canceledAt: new Date() } }, { session }); }, ownerGuard(req));
  let providerRevoked = false;
  if (connection?.credentials) {
    try { const token = decode(connection.credentials).accessToken; const response = await providerFetch(`${BASE}/oauth/deauthorize`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }); providerRevoked = response.ok; } catch { providerRevoked = false; }
  }
  return { connected: false, providerRevoked, revokeRefreshTokenInClio: true, message: 'LPC access has been removed. To revoke the provider refresh grant as well, remove LPC in your Clio application settings.' };
}
function pageCursor(result) {
  const next = result?.meta?.paging?.next;
  if (!next) return null;
  try { const url = new URL(next, BASE); if (url.origin !== BASE) return null; return url.searchParams.get('page_token'); } catch { return null; }
}
function cleanCursor(value) { if (value === undefined || value === '') return ''; if (typeof value !== 'string' || value.length > 2048) fail(400, 'INVALID', 'Refresh the Clio list.'); return value; }
function matterShape(doc) { return { id: clioId(doc.id), label: String(doc.display_number || `Clio matter ${doc.id}`).slice(0,300), description: String(doc.description || '').slice(0,4000), status: String(doc.status || '') }; }
const DOC_FIELDS = 'id,name,filename,matter{id},latest_document_version{id,uuid,size,content_type,fully_uploaded}';
function documentShape(doc) { return { id: clioId(doc.id), name: String(doc.filename || doc.name || 'Document').replace(/[\x00-\x1f\x7f]/g,'').slice(0,200), versionId: clioId(doc.latest_document_version?.id), versionUuid: String(doc.latest_document_version?.uuid || ''), size: Number(doc.latest_document_version?.size || doc.size || 0), contentType: String(doc.latest_document_version?.content_type || doc.content_type || 'application/octet-stream'), ready: doc.latest_document_version?.fully_uploaded === true }; }
async function listMatters(req) {
  if (req.query.q !== undefined && (typeof req.query.q !== 'string' || req.query.q.length > 200)) fail(400, 'INVALID', 'Use a shorter Clio search.');
  const result = await api(req, '/matters.json', { query: { fields: 'id,display_number,description,status', limit: 50, query: req.query.q || '', page_token: cleanCursor(req.query.cursor) } });
  if (!Array.isArray(result.data)) fail(502, 'PROVIDER_INVALID', 'Clio did not return a matter list.');
  return { items: result.data.map(matterShape), nextCursor: pageCursor(result) };
}
async function matterContext(req) {
  const connection = await readConnection(req), matterId = clioId(req.params.clioMatterId);
  if (req.query.expectedUserId !== connection.clioUserId || req.query.expectedConnectionRevision !== connection.revision) fail(409, 'CONNECTION_CHANGED', 'The original Clio account is no longer connected. Select the matter again.');
  req.clioConnectionRevision = connection.revision;
  return { matter: matterShape((await api(req, `/matters/${matterId}.json`, { query: { fields: 'id,display_number,description,status' } })).data) };
}
async function listDocuments(req) {
  const matterId = clioId(req.params.clioMatterId);
  await api(req, `/matters/${matterId}.json`, { query: { fields: 'id' } });
  const result = await api(req, '/documents.json', { query: { fields: DOC_FIELDS, matter_id: matterId, scope: 'descendants', limit: 50, page_token: cleanCursor(req.query.cursor) } });
  if (!Array.isArray(result.data)) fail(502, 'PROVIDER_INVALID', 'Clio did not return a document list.');
  return { items: result.data.filter(doc => String(doc.matter?.id) === matterId).map(documentShape), nextCursor: pageCursor(result) };
}
function selectedIds(value, { empty = true } = {}) {
  if (!Array.isArray(value) || value.length > 10 || !empty && !value.length) fail(400, 'INVALID', 'Choose up to ten documents.');
  const ids = value.map(clioId); if (new Set(ids).size !== ids.length) fail(400, 'INVALID', 'Choose each document once.'); return ids.sort();
}
async function documentsInMatter(req, matterId, ids) {
  const documents = [];
  for (const documentId of ids) {
    const doc = (await api(req, `/documents/${documentId}.json`, { query: { fields: DOC_FIELDS } })).data;
    if (String(doc?.matter?.id) !== matterId) fail(403, 'DOCUMENT_RESTRICTED', 'A selected document does not belong to this Clio matter.');
    const item = documentShape(doc); if (!item.ready || !item.versionUuid) fail(409, 'DOCUMENT_UNAVAILABLE', 'A selected Clio document is not ready to transfer.');
    documents.push(item);
  }
  return documents;
}
function verifyDocumentReview(documents, expected) {
  if (expected === undefined) return;
  if (!Array.isArray(expected) || expected.length !== documents.length || expected.some(item => !item || typeof item.id !== 'string' || typeof item.versionId !== 'string' || typeof item.versionUuid !== 'string') || new Set(expected.map(item => item.id)).size !== expected.length || documents.some(document => !expected.some(item => item.id === document.id && item.versionId === document.versionId && item.versionUuid === document.versionUuid))) fail(409, 'SOURCE_CHANGED', 'A Clio document changed. Choose the source documents again to review their latest versions.');
}
function reviewIdentity(expected) {
  if (expected === undefined) return null;
  if (!Array.isArray(expected) || expected.length > 10 || expected.some(item => !item || typeof item.id !== 'string' || typeof item.versionId !== 'string' || typeof item.versionUuid !== 'string' || item.versionUuid.length > 200)) fail(409, 'SOURCE_CHANGED', 'Choose the Clio documents again to review their latest versions.');
  return expected.map(({ id, versionId, versionUuid }) => ({ id, versionId, versionUuid })).sort((a,b) => a.id.localeCompare(b.id));
}
async function createHandoff(req) {
  if (req.body.confirmed !== true) fail(400, 'CONFIRMATION_REQUIRED', 'Review and confirm the selected Clio information.');
  let publicBrief = null;
  if (req.body.publicWorkBrief !== undefined) {
    const value = req.body.publicWorkBrief;
    if (req.body.publicBriefConfirmed !== true || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['title','description','tasks'].includes(key)) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 300 || typeof value.description !== 'string' || value.description.trim().length < 10 || value.description.length > 4000 || !Array.isArray(value.tasks || []) || (value.tasks || []).length > 25 || (value.tasks || []).some(task => typeof task !== 'string' || !task.trim() || task.length > 200)) fail(400, 'BRIEF_REVIEW_REQUIRED', 'Review the public work title, description and deliverables before preparing the draft.');
    const clean = text => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    publicBrief = { title: clean(value.title), description: clean(value.description), tasks: (value.tasks || []).map(clean) };
    if (!publicBrief.title || publicBrief.description.length < 10 || publicBrief.tasks.some(task => !task)) fail(400, 'BRIEF_REVIEW_REQUIRED', 'Enter a work title and description before reviewing the posting draft.');
  }
  const matterId = clioId(req.body.clioMatterId), ids = selectedIds(req.body.documentIds || []), key = requestId(req.body.requestId), reviewedVersions = reviewIdentity(req.body.expectedDocuments), fingerprint = hash(JSON.stringify([matterId, ids, ...(publicBrief ? [publicBrief] : []), ...(reviewedVersions ? [reviewedVersions] : [])]));
  const connection = await pinConnection(req);
  const old = await Handoff.findOne({ ownerId: req.user.id, requestId: key }).lean();
  if (old) { if (old.fingerprint !== fingerprint) fail(409, 'REQUEST_CHANGED', 'This request was already used for different selections.'); return handoffResult(old); }
  const matter = matterShape((await api(req, `/matters/${matterId}.json`, { query: { fields: 'id,display_number,description,status' } })).data);
  const documents = await documentsInMatter(req, matterId, ids);
  verifyDocumentReview(documents, req.body.expectedDocuments);
  let saved;
  try { saved = await withActiveAccountWrite([req.user.id], async session => {
    if (!await Connection.exists({ _id: connection._id, revision: connection.revision, disconnectedAt: null, needsReconnect: false }).session(session)) fail(409, 'CONNECTION_CHANGED', 'The connected Clio account changed. Refresh its records before continuing.');
    const [draft] = await CaseDraft.create([{ owner: req.user.id, title: publicBrief?.title || '', description: publicBrief?.description || '', tasks: (publicBrief?.tasks || []).map(title => ({ title })), status: 'draft' }], { session });
    // Raw Clio matter descriptions can contain confidential client facts. They
    // stay encrypted in this private handoff, never prefilled into a posting.
    const [handoff] = await Handoff.create([{ ownerId: req.user.id, draftId: draft._id, clioMatterId: matterId, clioUserId: connection.clioUserId, connectionRevision: connection.revision, requestId: key, fingerprint, payload: encode({ matter, documents }) }], { session });
    return handoff;
  }, ownerGuard(req)); } catch (error) { if (error.code !== 11000) throw error; const prior = await Handoff.findOne({ ownerId: req.user.id, requestId: key }).lean(); if (!prior || prior.fingerprint !== fingerprint) throw error; saved = prior; }
  return handoffResult(saved);
}
function handoffResult(handoff) { return { handoffId: String(handoff._id), draftId: handoff.draftId ? String(handoff.draftId) : null, caseId: handoff.targetCaseId ? String(handoff.targetCaseId) : null, href: handoff.draftId ? `/attorney-v2.html#/matters/new?draftId=${handoff.draftId}` : null, documentsDeferredUntilFunding: !handoff.targetCaseId }; }
async function createMatterHandoff(req) {
  if (req.body.confirmed !== true) fail(400, 'CONFIRMATION_REQUIRED', 'Review and confirm the source matter and selected documents.');
  const local = await matterOwner(req, { funded: true }), connection = await pinConnection(req);
  const matterId = clioId(req.body.clioMatterId), ids = selectedIds(req.body.documentIds, { empty: false }), key = requestId(req.body.requestId), reviewedVersions = reviewIdentity(req.body.expectedDocuments), fingerprint = hash(JSON.stringify(['funded-matter', String(local._id), assignmentRevision(local), matterId, ids, ...(reviewedVersions ? [reviewedVersions] : [])]));
  const old = await Handoff.findOne({ ownerId: req.user.id, requestId: key }).lean();
  if (old) { if (old.fingerprint !== fingerprint || String(old.targetCaseId || '') !== String(local._id)) fail(409, 'REQUEST_CHANGED', 'This request already identifies another source selection.'); return handoffResult(old); }
  const matter = matterShape((await api(req, `/matters/${matterId}.json`, { query: { fields: 'id,display_number,description,status' } })).data), documents = await documentsInMatter(req, matterId, ids);
  verifyDocumentReview(documents, req.body.expectedDocuments);
  let saved;
  try { saved = await fileWrites.run(req, local, async session => {
    if (!await Connection.exists({ _id: connection._id, revision: connection.revision, disconnectedAt: null, needsReconnect: false }).session(session)) fail(409, 'CONNECTION_CHANGED', 'The connected Clio account changed. Refresh its records before continuing.');
    const [handoff] = await Handoff.create([{ ownerId: req.user.id, targetCaseId: local._id, clioMatterId: matterId, clioUserId: connection.clioUserId, connectionRevision: connection.revision, requestId: key, fingerprint, payload: encode({ matter, documents }) }], { session });
    return handoff;
  }); } catch (error) { if (error.code !== 11000) throw error; saved = await Handoff.findOne({ ownerId: req.user.id, requestId: key }).lean(); if (!saved || saved.fingerprint !== fingerprint) throw error; }
  return handoffResult(saved);
}
async function matterOwner(req, { funded = false } = {}) {
  await actor(req); if (!validId(req.params.caseId)) fail(400, 'INVALID', 'Select an LPC matter.');
  if (funded) return fileWrites.read(req);
  const doc = await Case.collection.findOne({ _id: oid(req.params.caseId) });
  const identity = doc && caseParticipantIdentity(doc, req.user.id);
  if (!doc || !identity.isAttorney || identity.identityConflict || doc.purgedAt) fail(404, 'MATTER_UNAVAILABLE', 'This LPC matter is unavailable.');
  return doc;
}
async function listHandoffs(req) {
  await actor(req);
  const caseId = req.query.caseId;
  let drafts;
  if (caseId) { await matterOwner({ ...req, params: { ...req.params, caseId } }); drafts = await CaseDraft.find({ owner: req.user.id, publishedCaseId: caseId }).select('_id').lean(); }
  const rows = await Handoff.find({ ownerId: req.user.id, ...(caseId ? { $or: [{ targetCaseId: caseId }, { draftId: { $in: drafts.map(doc => doc._id) } }] } : {}) }).select('+payload').sort({ createdAt: -1 }).limit(50).lean();
  return { items: rows.map(row => { const payload = decode(row.payload); return { ...handoffResult(row), clioMatterId: row.clioMatterId, label: payload.matter.label, documents: payload.documents, createdAt: row.createdAt }; }) };
}
function transferUrl(value) {
  let url; try { url = new URL(value); } catch { fail(502, 'TRANSFER_URL_INVALID', 'Clio returned an invalid storage destination.'); }
  const usS3 = /^(?:[a-z0-9.-]+\.)?s3(?:[.-](?:us-east-[12]|us-west-[12]))?\.amazonaws\.com$/i;
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !usS3.test(url.hostname) || !url.searchParams.has('X-Amz-Signature')) fail(502, 'TRANSFER_URL_INVALID', 'Clio returned an unsupported storage destination.');
  return url.href;
}
async function downloadDocument(req, document) {
  const result = await api(req, `/documents/${document.id}/download.json`, { binary: true, query: { document_version_id: document.versionId } });
  if (result.status !== 303) fail(502, 'DOWNLOAD_UNAVAILABLE', 'Clio did not return the selected document.');
  const response = await providerFetch(transferUrl(result.headers.get('location')), { signal: AbortSignal.timeout(180000) });
  if (!response.ok) fail(502, 'DOWNLOAD_UNAVAILABLE', 'The selected Clio document could not be downloaded.');
  if (document.size > MAX_FILE_BYTES || !Number.isSafeInteger(document.size) || document.size < 1) fail(413, 'SIZE_LIMIT', 'Choose a document up to 500 MB.');
  if (document.size > BUFFERED_MATTER_FILE_BYTES) return stageMatterFile(response.body, { mimeType: document.contentType, filename: document.name, expectedBytes: document.size });
  const buffer = await boundedBody(response);
  if (!buffer.length) fail(422, 'EMPTY_DOCUMENT', 'The selected document is empty.');
  security.validateMatterFileBuffer({ buffer, mimeType: document.contentType, filename: document.name });
  return buffer;
}
async function importDocuments(req) {
  if (req.body.confirmed !== true) fail(400, 'CONFIRMATION_REQUIRED', 'Confirm the selected document imports.');
  const doc = await matterOwner(req, { funded: true }), key = requestId(req.body.requestId), ids = selectedIds(req.body.documentIds, { empty: false });
  if (!validId(req.body.handoffId)) fail(400, 'INVALID', 'Select the original Clio handoff.');
  const handoff = await Handoff.findOne({ _id: req.body.handoffId, ownerId: req.user.id }).select('+payload').lean();
  const draft = handoff?.draftId && await CaseDraft.findOne({ _id: handoff.draftId, owner: req.user.id, publishedCaseId: doc._id }).lean();
  if (!handoff || !draft && String(handoff.targetCaseId || '') !== String(doc._id)) fail(404, 'HANDOFF_UNAVAILABLE', 'This handoff is not connected to the LPC matter.');
  const connection = await pinConnection(req); if (connection.clioUserId !== handoff.clioUserId) fail(409, 'CONNECTION_CHANGED', 'Reconnect the original Clio account before importing.');
  const payload = decode(handoff.payload), files = [];
  if (ids.some(value => !payload.documents.some(item => item.id === value))) fail(400, 'SELECTION_CHANGED', 'Only explicitly selected handoff documents may be imported.');
  const assignment = assignmentRevision(doc), fingerprint = hash(JSON.stringify(['import', String(doc._id), assignment, String(handoff._id), ids]));
  const acquired = await acquireTransfer(req, { direction: 'import', key, fingerprint, caseId: doc._id, payload: encode({ handoffId: String(handoff._id), documentIds: ids, matterId: handoff.clioMatterId, destinationLabel: payload.matter.label, assignmentRevision: assignment }) }), transfer = acquired.operation, leaseToken = acquired.leaseToken;
  if (transfer?.status === 'recorded') {
    const result = decode(transfer.result);
    const records = await CaseFile.collection.find({ _id: { $in: result.files.map(item => oid(item.id)) }, caseId: doc._id }).toArray();
    if (records.length !== result.files.length || result.files.some(item => Number(records.find(record => String(record._id) === item.id)?.version || 1) !== Number(item.version || 1))) fail(409, 'IMPORT_CHANGED', 'A previously imported document was changed or removed. Refresh Files.');
    return { ...result, replayed: true };
  }
  try {
  await require('../matterFileNotifications').ready();
  const current = await documentsInMatter(req, handoff.clioMatterId, ids);
  for (const item of current) {
    const held = await Transfer.updateOne({ _id: transfer._id, leaseToken, status: { $ne: 'recorded' } }, { $set: { leaseUntil: new Date(Date.now() + (item.size > BUFFERED_MATTER_FILE_BYTES ? 600000 : 120000)) } });
    if (held.matchedCount !== 1) fail(409, 'IMPORT_PROCESSING', 'Another worker is checking this import. Refresh Files before continuing.');
    const selected = payload.documents.find(value => value.id === item.id);
    if (selected.versionId !== item.versionId || selected.versionUuid !== item.versionUuid || selected.name !== item.name || selected.contentType !== item.contentType) fail(409, 'SOURCE_CHANGED', 'A selected Clio document changed. Choose the source documents again to review their latest versions.');
    const original = await downloadDocument(req, item), artifact = Buffer.isBuffer(original) ? null : original, buffer = artifact ? undefined : original, size = artifact?.size || buffer.length;
    try {
    const uploadReq = { ...req, file: { buffer, size, mimetype: item.contentType, ...(artifact ? { contentFingerprint: artifact.sha256 } : {}) }, body: {}, params: { caseId: String(doc._id) } };
    const review = await fileWrites.read(uploadReq), clientUploadId = `clio-${hash(JSON.stringify([String(doc._id), assignment, handoff.clioUserId, item.id, item.versionId, item.versionUuid])).slice(0,64)}`;
    const pending = await fileWrites.prepareUpload(uploadReq, review, { name: item.name, clientUploadId });
    if (pending.recorded) { if (pending.recorded.changedSinceUpload) fail(409, 'IMPORT_CHANGED', 'This source was imported earlier and its LPC document later changed. Review Files before importing it again.'); files.push({ id: String(pending.recorded.file._id), name: item.name, version: Number(pending.recorded.file.version || 1), replayed: true }); continue; }
    const s3 = createS3Client(); if (!process.env.S3_BUCKET) fail(503, 'STORAGE_UNAVAILABLE', 'Document storage is not configured.');
    const uploadBody = artifact ? artifact.open() : buffer;
    try { await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: pending.key, Body: uploadBody, ContentType: item.contentType, ContentLength: size, IfNoneMatch: '*', ...matterStorageOptions(size), ...confidentialStorageEncryption() })); }
    catch (error) { await retirement.settleAttempt(pending.operation, 'unconfirmed'); await fileWrites.unconfirmedUpload(pending.operation, 'failed'); throw error; }
    finally { if (artifact) uploadBody.destroy(); }
    await retirement.settleAttempt(pending.operation, 'uploaded');
    let saved;
    try { saved = await fileWrites.run(uploadReq, review, async (session, activeMatter) => {
      await fileWrites.recordUpload(pending.operation, session);
      if (!await Connection.exists({ _id: connection._id, revision: connection.revision, disconnectedAt: null, needsReconnect: false }).session(session)) fail(409, 'CONNECTION_CHANGED', 'The connected Clio account changed during document import. Refresh before continuing.');
      const [record] = await CaseFile.create([{ _id: pending.operation.fileId, caseId: doc._id, userId: req.user.id, originalName: item.name, storageKey: pending.key, mimeType: item.contentType, size, clientUploadId, uploadedByRole: 'attorney', status: 'pending_review', securityStatus: security.malwareScanRequired() ? 'pending' : 'not_required', securityScanResult: security.malwareScanRequired() ? 'PENDING' : 'NOT_REQUIRED', version: 1, createdAt: new Date(Math.max(Date.now(), new Date(activeMatter.hiredAt || 0).getTime() || 0)) }], { session });
      await require('../../models/AuditLog').logFromReq(req, 'file_uploaded', { targetType: 'case', targetId: activeMatter._id, caseId: activeMatter._id, meta: { fileId: String(record._id), source: 'clio' }, session });
      if (activeMatter.paralegal || activeMatter.paralegalId) await require('../../utils/notifyUser').notifyUser(activeMatter.paralegal || activeMatter.paralegalId, 'case_file_uploaded', { caseId: String(doc._id), caseTitle: doc.title, fileId: String(record._id), fileName: item.name, link: `case-detail.html?caseId=${doc._id}&tab=files&fileId=${record._id}` }, { actorUserId: req.user.id, session, deferDispatch: true, fileUpload: { id: pending.operation._id, version: 1 } });
      return record;
    }); } catch (error) { await fileWrites.unconfirmedUpload(pending.operation); const recovered = await fileWrites.recoverUpload(uploadReq, pending.operation); if (!recovered) throw error; saved = recovered.file; }
    files.push({ id: String(saved._id), name: item.name, version: Number(saved.version || 1), securityStatus: saved.securityStatus });
    require('../../utils/caseEvents').publishCaseEvent(doc._id, 'documents', { at: new Date().toISOString() });
    } finally { await artifact?.cleanup(); }
  }
  await fileWrites.read(req);
  const result = { status: 'recorded', files, transferId: String(transfer._id), message: 'Selected documents were added to the funded matter. Security scanning still applies.' };
  const recorded = await Transfer.updateOne({ _id: transfer._id, leaseToken, fingerprint }, { $set: { status: 'recorded', result: encode(result) } });
  if (recorded.matchedCount !== 1) fail(409, 'IMPORT_PROCESSING', 'The import record changed. Review Files before trying again.');
  return result;
  } catch (error) {
    await Transfer.updateOne({ _id: transfer._id, leaseToken, status: { $ne: 'recorded' } }, { $set: { status: 'uncertain', leaseUntil: new Date(0) } });
    throw error;
  }
}

async function approvedFile(req, fileId) {
  const matter = await matterOwner(req, { funded: true });
  if (!validId(fileId)) fail(400, 'INVALID', 'Choose an approved document.');
  const record = await CaseFile.collection.findOne({ _id: oid(fileId), caseId: { $in: [matter._id, String(matter._id)] } });
  if (!record || record.status !== 'approved' || !isRecordVisibleToCurrentAssignment(record, matter, { role: 'attorney', userId: req.user.id })) fail(403, 'FILE_NOT_APPROVED', 'Only a currently approved matter document can be returned to Clio.');
  const file = decryptCaseFilePayload(record);
  if (!String(file.storageKey || '').startsWith(`cases/${matter._id}/documents/`) || /[\\?#%]/.test(file.storageKey) || file.storageKey.split('/').some(part => !part || part === '..' || part === '.')) fail(403, 'FILE_RESTRICTED', 'This document is unavailable for transfer.');
  const revision = hash(JSON.stringify([String(record._id), file.storageKey, file.version, file.originalName, file.status, file.size]));
  return { matter, record, file, revision };
}
async function readApprovedBytes(req, fileId, revision) {
  const current = await approvedFile(req, fileId);
  if (current.revision !== revision) fail(409, 'FILE_CHANGED', 'The document changed. Review its latest version before exporting.');
  if (!process.env.S3_BUCKET) fail(503, 'STORAGE_UNAVAILABLE', 'Document storage is not configured.');
  const s3 = createS3Client(), options = { s3, bucket: process.env.S3_BUCKET, key: current.file.storageKey };
  await security.assertObjectMalwareSafe(options);
  if (current.file.size > MAX_FILE_BYTES || !Number.isSafeInteger(current.file.size) || current.file.size < 1) fail(413, 'SIZE_LIMIT', 'Choose a document up to 500 MB.');
  if (current.file.size > BUFFERED_MATTER_FILE_BYTES) {
    const head = await s3.send(new HeadObjectCommand({ Bucket: options.bucket, Key: options.key }));
    if (!head.ETag || head.ContentLength !== current.file.size) fail(409, 'FILE_CHANGED', 'The stored document changed. Review its latest version before exporting.');
    const object = await s3.send(new GetObjectCommand({ Bucket: options.bucket, Key: options.key, IfMatch: head.ETag, ...(head.VersionId && head.VersionId !== 'null' ? { VersionId: head.VersionId } : {}) }));
    const artifact = await stageMatterFile(object.Body, { mimeType: current.file.mimeType, filename: current.file.originalName, expectedBytes: current.file.size });
    try { await security.assertObjectMalwareSafe(options); if ((await approvedFile(req, fileId)).revision !== revision) fail(409, 'FILE_CHANGED', 'The document changed during the transfer review.'); return { ...current, artifact }; }
    catch (error) { await artifact.cleanup(); throw error; }
  }
  const object = await s3.send(new GetObjectCommand({ Bucket: options.bucket, Key: options.key }));
  const buffer = await boundedBody(new Response(object.Body, { headers: object.ContentLength == null ? {} : { 'content-length': String(object.ContentLength) } }));
  if (!buffer.length) fail(422, 'EMPTY_DOCUMENT', 'This document has no contents to transfer.');
  await security.assertObjectMalwareSafe(options);
  security.validateMatterFileBuffer({ buffer, mimeType: current.file.mimeType, filename: current.file.originalName });
  if ((await approvedFile(req, fileId)).revision !== revision) fail(409, 'FILE_CHANGED', 'The document changed during the transfer review.');
  return { ...current, buffer };
}
const EXPORT_FIELDS = 'id,matter{id},external_properties{name,value},latest_document_version{uuid,put_url,put_headers,multiparts,fully_uploaded}';
async function exportIdentity(req, doc, expectedMatterId, operationId) {
  const restricted = () => fail(409, 'EXPORT_RECONCILIATION', 'The earlier Clio transfer needs review before another export.');
  if (!doc || String(doc.matter?.id) !== expectedMatterId) restricted();
  if (doc.external_properties?.some(value => value.name === 'LPC Transfer' && value.value === String(operationId))) return;
  if (!doc.external_properties?.some(value => value.redacted === true)) restricted();
  // The Documents scope permits exact property filters even when the generic
  // metadata association is redacted. Confirm identity through that documented
  // predicate instead of requesting broader access or guessing from filenames.
  const result = await api(req, '/documents.json', { query: { fields: 'id,matter{id}', matter_id: expectedMatterId, scope: 'descendants', show_uncompleted: true, external_property_name: 'LPC Transfer', external_property_value: String(operationId), limit: 2 } });
  if (!Array.isArray(result.data) || result.data.length !== 1 || result.meta?.paging?.next || String(result.data[0].id) !== String(doc.id) || String(result.data[0].matter?.id) !== expectedMatterId) restricted();
}
function exportRecord(doc) {
  const version = doc.latest_document_version;
  if (!version || typeof version.uuid !== 'string' || !version.uuid) fail(502, 'PROVIDER_INVALID', 'Clio did not return an upload version.');
  const multiparts = version.multiparts || [];
  if (!Array.isArray(multiparts)) fail(502, 'PROVIDER_INVALID', 'Clio did not return valid upload parts.');
  return { documentId: clioId(doc.id), uuid: version.uuid, putUrl: version.fully_uploaded || multiparts.length ? '' : transferUrl(version.put_url), putHeaders: version.put_headers || [], multiparts, fullyUploaded: version.fully_uploaded === true };
}
async function readExportRecord(req, doc, matterId, operationId, expectedUuid) {
  await exportIdentity(req, doc, matterId, operationId);
  if (doc.latest_document_version) return exportRecord(doc);
  // Before finalization Clio can leave latest_document_version null. Resolve
  // only the exact transfer document's sole version; never guess among versions.
  const versions = await api(req, `/documents/${clioId(doc.id)}/versions.json`, { query: { fields: 'uuid,put_url,put_headers,multiparts,fully_uploaded', limit: 50 } });
  if (!Array.isArray(versions.data) || versions.data.length !== 1 || versions.meta?.paging?.next || expectedUuid && versions.data[0].uuid !== expectedUuid) fail(409, 'EXPORT_CHANGED', 'The destination document changed in Clio. Review it before continuing.');
  return exportRecord({ ...doc, latest_document_version: versions.data[0] });
}
async function reconcileExport(req, operation, matterId) {
  const response = await api(req, '/documents.json', { query: { fields: EXPORT_FIELDS, matter_id: matterId, scope: 'descendants', show_uncompleted: true, external_property_name: 'LPC Transfer', external_property_value: String(operation._id), limit: 200 } });
  const exact = (response.data || []).filter(doc => doc.external_properties?.some(value => value.redacted === true || value.name === 'LPC Transfer' && value.value === String(operation._id)));
  if (exact.length !== 1 || response.meta?.paging?.next) fail(409, 'EXPORT_UNCONFIRMED', 'The earlier export is unconfirmed. Review the Clio matter before starting another transfer; LPC will not create a duplicate.');
  return readExportRecord(req, exact[0], matterId, operation._id);
}
async function exportDocument(req) {
  if (req.body.confirmed !== true) fail(400, 'CONFIRMATION_REQUIRED', 'Review and confirm the document and Clio destination.');
  const key = requestId(req.body.requestId), matterId = clioId(req.body.clioMatterId), reviewed = await approvedFile(req, req.body.fileId);
  if (req.body.expectedFileVersion !== undefined && (!Number.isSafeInteger(req.body.expectedFileVersion) || req.body.expectedFileVersion !== Number(reviewed.file.version || 1))) fail(409, 'FILE_CHANGED', 'The approved document changed. Review its latest version before sending it to Clio.');
  const connection = await pinConnection(req);
  // Verify the destination through this attorney's own current OAuth grant.
  const destination = (await api(req, `/matters/${matterId}.json`, { query: { fields: 'id,display_number' } })).data;
  const source = await readApprovedBytes(req, req.body.fileId, reviewed.revision);
  try {
  const byteHash = source.artifact?.sha256 || hash(source.buffer.toString('base64'));
  const partPlan = source.artifact && source.file.size >= 100 * 1024 * 1024 ? await multipart.plan(source.artifact) : null;
  const fingerprint = hash(JSON.stringify(['export', connection.clioUserId, String(source.matter._id), String(source.record._id), reviewed.revision, matterId, byteHash]));
  const acquired = await acquireTransfer(req, { direction: 'export', key, fingerprint, caseId: source.matter._id, fileId: source.record._id, payload: encode({ matterId, revision: reviewed.revision, byteHash, destinationLabel: String(destination.display_number || `Clio matter ${matterId}`).slice(0,300), fileName: source.file.originalName, fileVersion: source.file.version }) });
  const { operation, newlyCreated, leaseToken } = acquired;
  if (operation?.status === 'recorded') return { ...decode(operation.result), replayed: true };
  const saveOperation = async (statusValue, payload, result) => {
    const changed = await Transfer.updateOne({ _id: operation._id, leaseToken, fingerprint }, { $set: { status: statusValue, leaseUntil: new Date(Date.now() + (source.artifact ? 600000 : 120000)), ...(payload ? { payload: encode(payload) } : {}), ...(result ? { result: encode(result) } : {}) } });
    if (changed.matchedCount !== 1) fail(409, 'EXPORT_PROCESSING', 'The export record changed. Review the current transfer.');
  };
  let payload = decode(operation.payload), remote = payload.remote;
  try {
    if (!remote) {
      if (newlyCreated) {
        // Retained identity precedes the provider request. If acknowledgement
        // is lost, a retry searches the exact external property; it never POSTs
        // another document merely because the first request timed out.
        await approvedFile(req, req.body.fileId);
        const created = await api(req, '/documents.json', { method: 'POST', query: { fields: EXPORT_FIELDS }, body: { data: { name: source.file.originalName, filename: source.file.originalName, parent: { id: Number(matterId), type: 'Matter' }, external_properties: [{ name: 'LPC Transfer', value: String(operation._id) }], ...(partPlan ? { multiparts: partPlan } : {}) } } });
        remote = await readExportRecord(req, created.data, matterId, operation._id);
      } else remote = await reconcileExport(req, operation, matterId);
      payload = { ...payload, remote }; await saveOperation('created', payload);
    }
    const check = await api(req, `/documents/${remote.documentId}.json`, { query: { fields: EXPORT_FIELDS } });
    const latest = await readExportRecord(req, check.data, matterId, operation._id, remote.uuid);
    if (latest.uuid !== remote.uuid) fail(409, 'EXPORT_CHANGED', 'The destination document changed in Clio. Review it before continuing.');
    if (!latest.fullyUploaded) {
      if ((await approvedFile(req, req.body.fileId)).revision !== reviewed.revision) fail(409, 'FILE_CHANGED', 'The approved document changed before export.');
      if (partPlan) {
        const instructions = multipart.instructions(remote, partPlan, transferUrl);
        const completedParts = new Set(payload.completedParts || []);
        for (const part of instructions) {
          if (completedParts.has(part.part_number)) continue;
          if ((await approvedFile(req, req.body.fileId)).revision !== reviewed.revision) fail(409, 'FILE_CHANGED', 'The approved document changed before export.');
          let uploaded = false;
          for (let attempt = 0; attempt < 3 && !uploaded; attempt++) {
            const body = source.artifact.open({ start: part.start, end: part.end });
            try { const response = await providerFetch(part.url, { method: 'PUT', headers: part.headers, body, duplex: 'half', signal: AbortSignal.timeout(60000) }); if (!response.ok) fail(502, 'UPLOAD_UNCONFIRMED', 'Clio did not confirm the document part.'); uploaded = true; }
            catch (error) { if (attempt === 2) throw error; }
            finally { body.destroy(); }
          }
          completedParts.add(part.part_number); payload = { ...payload, completedParts: [...completedParts] }; await saveOperation('uploading', payload);
        }
      } else {
      const headers = {};
      for (const entry of remote.putHeaders) {
        if (!['content-type', 'content-md5', 'x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id'].includes(String(entry.name).toLowerCase()) || typeof entry.value !== 'string' || /[\r\n]/.test(entry.value)) fail(502, 'UPLOAD_HEADERS_INVALID', 'Clio returned unsupported upload instructions.');
        headers[entry.name] = entry.value;
      }
      const body = source.artifact ? source.artifact.open() : source.buffer;
      let uploaded;
      try { uploaded = await providerFetch(transferUrl(remote.putUrl), { method: 'PUT', headers, body, ...(source.artifact ? { duplex: 'half', signal: AbortSignal.timeout(180000) } : {}) }); }
      finally { if (source.artifact) body.destroy(); }
      if (!uploaded.ok) fail(502, 'UPLOAD_UNCONFIRMED', 'Clio did not confirm the document upload. Reopen the recorded transfer before trying again.');
      }
      await saveOperation('uploaded', payload);
      // PATCH is the currently documented document update method. A later
      // retry checks fully_uploaded before repeating finalization.
      try { await api(req, `/documents/${remote.documentId}.json`, { method: 'PATCH', body: { data: { uuid: remote.uuid, fully_uploaded: true } } }); }
      catch (error) { const verify = await api(req, `/documents/${remote.documentId}.json`, { query: { fields: EXPORT_FIELDS } }); const version = await readExportRecord(req, verify.data, matterId, operation._id, remote.uuid); if (!version.fullyUploaded || version.uuid !== remote.uuid) throw error; }
    }
    const final = (await api(req, `/documents/${remote.documentId}.json`, { query: { fields: EXPORT_FIELDS } })).data, version = await readExportRecord(req, final, matterId, operation._id, remote.uuid);
    if (!version.fullyUploaded || version.uuid !== remote.uuid) fail(503, 'EXPORT_UNCONFIRMED', 'The exported document has not been confirmed by Clio.');
    const result = { transferId: String(operation._id), clioDocumentId: remote.documentId, clioMatterId: matterId, fileId: String(source.record._id), status: 'recorded' };
    await saveOperation('recorded', payload, result);
    await require('../../models/AuditLog').logFromReq(req, 'clio_document_exported', { targetType: 'case', targetId: source.matter._id, caseId: source.matter._id, meta: { fileId: String(source.record._id), transferId: String(operation._id) } });
    return result;
  } catch (error) {
    await Transfer.updateOne({ _id: operation._id, leaseToken, status: { $ne: 'recorded' } }, { $set: { status: 'uncertain', leaseUntil: new Date(0) } });
    if (error.publicCode) throw error;
    fail(503, 'EXPORT_UNCONFIRMED', 'The Clio transfer could not be confirmed. Reopen this transfer before attempting another export.');
  }
  } finally { await source.artifact?.cleanup(); }
}
async function registerAction(req) {
  const config = configured();
  await pinConnection(req);
  const label = 'Engage a paralegal through LPC', targetUrl = `${config.origin}/clio-connect.html`;
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const existing = await api(req, '/custom_actions.json', { query: { fields: 'id,label,target_url,ui_reference', limit: 100, page_token: cursor } });
    if (!Array.isArray(existing.data)) fail(502, 'PROVIDER_INVALID', 'Clio did not return its action list.');
    const action = existing.data.find(value => value.label === label && value.target_url === targetUrl && value.ui_reference === 'matters/show');
    if (action) return { id: clioId(action.id), label, replayed: true };
    cursor = pageCursor(existing); if (!cursor) break;
    if (page === 9) fail(503, 'ACTION_UNCONFIRMED', 'The existing Clio action could not be checked. LPC will not create a possible duplicate.');
  }
  const result = await api(req, '/custom_actions.json', { method: 'POST', body: { data: { label, target_url: targetUrl, ui_reference: 'matters/show' } } });
  return { id: clioId(result.data?.id), label };
}
async function actionContext(req) {
  const connection = await pinConnection(req), body = req.body;
  if (String(body.user_id) !== connection.clioUserId || typeof body.custom_action_nonce !== 'string' || !body.custom_action_nonce || body.custom_action_nonce.length > 1024 || typeof body.subject_url !== 'string') fail(400, 'ACTION_INVALID', 'This Clio action is invalid or expired.');
  const match = /^\/api\/v4\/matters\/([1-9][0-9]{0,18})(?:\.json)?$/.exec(body.subject_url);
  if (!match) fail(400, 'ACTION_INVALID', 'This Clio action does not identify a matter.');
  const result = await api(req, `/matters/${match[1]}.json`, { query: { custom_action_nonce: body.custom_action_nonce, fields: 'id,display_number,description,status' } });
  return { matter: matterShape(result.data) };
}
async function listTransfers(req) {
  const matter = await matterOwner({ ...req, params: { ...req.params, caseId: req.query.caseId } });
  const currentAssignment = assignmentRevision(matter);
  const rows = await Transfer.find({ ownerId: req.user.id, caseId: matter._id }).select('+payload +result').sort({ createdAt: -1 }).limit(20).lean();
  return { assignmentRevision: currentAssignment, items: rows.map(row => {
    const payload = row.payload ? decode(row.payload) : {}, result = row.result ? decode(row.result) : null;
    const retryBody = row.direction === 'export' && row.fileId && payload.matterId ? { fileId: String(row.fileId), clioMatterId: payload.matterId, requestId: row.requestId, ...(payload.fileVersion ? { expectedFileVersion: Number(payload.fileVersion) } : {}) } : row.direction === 'import' && payload.assignmentRevision === currentAssignment && payload.handoffId && Array.isArray(payload.documentIds) ? { handoffId: payload.handoffId, documentIds: payload.documentIds, requestId: row.requestId } : null;
    return { id: String(row._id), direction: row.direction, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, label: payload.destinationLabel || 'Clio matter', assignmentRevision: payload.assignmentRevision || null, handoffId: payload.handoffId || null, fileName: payload.fileName || '', fileVersion: payload.fileVersion || null, documentCount: row.direction === 'export' ? 1 : result?.files?.length || payload.documentIds?.length || 0, result, retry: row.status !== 'recorded' && retryBody ? { path: `/api/integrations/clio/matters/${matter._id}/${row.direction}`, body: retryBody } : null };
  }) };
}
async function cleanupOwner(ownerId, { session } = {}) {
  if (!validId(String(ownerId || ''))) throw new Error('Clio cleanup requires an owner identity');
  // The caller owns its account-closure transaction. No provider requests or
  // new credentials are created while that transaction is being committed.
  for (const Model of [Connection, OAuthState, Handoff, Transfer]) await Model.deleteMany({ ownerId }, ...(session ? [{ session }] : []));
}
async function cleanupDraft(ownerId, draftId, { session } = {}) {
  if (!validId(String(ownerId || '')) || !validId(String(draftId || ''))) throw new Error('Clio handoff cleanup requires draft ownership');
  await Handoff.deleteMany({ ownerId, draftId }, ...(session ? [{ session }] : []));
}

module.exports = { configuration, localCallbackRedirect, status, connect, callback, disconnect, listMatters, matterContext, listDocuments, createHandoff, createMatterHandoff, listHandoffs, listTransfers, importDocuments, exportDocument, registerAction, actionContext, cleanupOwner, cleanupDraft, transferUrl, boundedBody, actor, rawApi, api, documentShape, matterOwner, requestId, selectedIds, hash, decode, encode, fail, clioId, approvedFile, BASE, MAX_FILE_BYTES };
