'use strict';
const crypto = require('crypto');
const Connection = require('../../models/CalendarConnection');
const State = require('../../models/CalendarOAuthState');
const User = require('../../models/User');
const providerApi = require('./providers');
const { encryptString, decryptString } = require('../../utils/dataEncryption');
const { withActiveAccountWrite } = require('../../utils/activeAccountWrite');
const { findActiveSession } = require('../authSessionService');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const encode = value => encryptString(JSON.stringify(value), { plaintext: true });
const decode = value => JSON.parse(decryptString(value));
const version = req => Number(req.auth?.payload?.av ?? req.authVersion ?? 0);
const sessionHash = req => hash(req.authSessionId ? `session:${req.authSessionId}` : `token:${req.auth?.token || ''}`);
function fail(status, code, message) { throw Object.assign(new Error(message), { status, publicCode: `CALENDAR_${code}` }); }
async function actor(req) {
  const user = await User.findById(req.user.id).select('role status disabled deleted authVersion').lean();
  if (!user || !['attorney','paralegal'].includes(user.role) || user.status !== 'approved' || user.disabled || user.deleted || Number(user.authVersion || 0) !== version(req) || req.authSessionId && !await findActiveSession(req.authSessionId, req.user.id)) fail(403, 'ACCOUNT_CHANGED', 'Sign in again before using calendar connections.');
  return user;
}
const guard = req => ({ ownerId: req.user.id, authVersion: version(req) });
function config(provider) { const value = providerApi.configuration(provider); if (!value) fail(503, 'NOT_CONFIGURED', 'This calendar provider is not configured for LPC yet.'); return value; }
async function status(req) {
  await actor(req);
  const rows = await Connection.find({ ownerId: req.user.id }).lean();
  return { ownerId: String(req.user.id), providers: ['google','microsoft'].map(provider => {
    const row = rows.find(item => item.provider === provider && !item.disconnectedAt);
    const configured = Boolean(providerApi.configuration(provider));
    return { provider, configured, connected: Boolean(configured && row && !row.needsReconnect && row.authVersion === version(req)), needsReconnect: Boolean(row && (row.needsReconnect || row.authVersion !== version(req))), revision: row?.revision || null, lastSyncedAt: row?.lastSyncedAt || null, error: row?.lastError || '' };
  }) };
}
async function connect(req) {
  await actor(req); await Promise.all([Connection.init(), State.init()]); const provider = req.params.provider, settings = config(provider), state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(32).toString('base64url');
  await withActiveAccountWrite([req.user.id], async session => {
    const current = await Connection.findOne({ ownerId: req.user.id, provider }).session(session).lean();
    await State.create([{ tokenHash: hash(state), ownerId: req.user.id, provider, sessionHash: sessionHash(req), authVersion: version(req), revision: current?.revision || '', proofKey: encode({ verifier }), expiresAt: new Date(Date.now() + 600000) }], { session });
  }, guard(req));
  return { authorizationUrl: providerApi.authorization(settings, provider, state, verifier) };
}
async function callback(req) {
  await Promise.all([Connection.init(), State.init()]);
  const user = await actor(req), provider = req.params.provider, settings = config(provider);
  if (typeof req.query.state !== 'string' || !/^[\w-]{43}$/.test(req.query.state)) fail(400, 'STATE_INVALID', 'This calendar authorization is invalid or expired.');
  const pending = await State.findOneAndUpdate({ tokenHash: hash(req.query.state), ownerId: req.user.id, provider, sessionHash: sessionHash(req), authVersion: version(req), consumedAt: null, expiresAt: { $gt: new Date() } }, { $set: { consumedAt: new Date() } }, { returnDocument: 'after' }).select('+proofKey').lean();
  if (!pending) fail(400, 'STATE_INVALID', 'This calendar authorization is invalid or expired.');
  const href = `/${user.role}-v2.html#/settings?tab=connections`;
  if (req.query.error) return { href: href + '&calendarResult=canceled' };
  if (typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) fail(400, 'CODE_INVALID', 'The provider did not return a calendar authorization code.');
  let token;
  try { token = await providerApi.exchange(settings, { grant_type: 'authorization_code', code: req.query.code, redirect_uri: settings.redirectUri, code_verifier: decode(pending.proofKey).verifier }); }
  catch { fail(502, 'AUTH_FAILED', 'Calendar access was not confirmed. Return to Settings and reconnect.'); }
  if (typeof token.refresh_token !== 'string' || !token.refresh_token) fail(502, 'AUTH_FAILED', 'The provider did not grant ongoing calendar access. Reconnect and allow calendar access.');
  const accountId = await providerApi.identity(provider, token.access_token);
  let connectionId;
  // The primary calendar is the explicit consent destination; no user-supplied
  // provider URL or provider account identifier can redirect bearer credentials.
  await withActiveAccountWrite([req.user.id], async session => {
    if (!await State.exists({ _id: pending._id, expiresAt: { $gt: new Date() } }).session(session)) fail(409, 'STATE_INVALID', 'This calendar authorization was canceled or expired.');
    const current = await Connection.findOne({ ownerId: req.user.id, provider }).session(session).lean();
    if (current?.leaseUntil > new Date()) fail(409, 'BUSY', 'Calendar sync is running. Start authorization again shortly.');
    if ((current?.revision || '') !== pending.revision) fail(409, 'CONNECTION_CHANGED', 'The calendar connection changed. Start a new authorization.');
    // A reconnect can choose another provider account: retire the old mapping
    // namespace rather than ever updating a different account's records.
    if (current) await Connection.updateOne({ _id: current._id }, { $set: { disconnectedAt: new Date(), credentials: '', revision: crypto.randomUUID() } }, { session });
    // Keep one stable row per owner/provider. New revision namespaces all links.
    const revision = current?.accountId === accountId ? current.revision : crypto.randomUUID();
    const saved = await Connection.findOneAndUpdate({ ownerId: req.user.id, provider }, { $set: { accountId, credentials: encode({ accessToken: token.access_token, refreshToken: token.refresh_token }), authVersion: version(req), revision, expiresAt: new Date(Date.now() + Number(token.expires_in) * 1000), disconnectedAt: null, needsReconnect: false, lease: '', leaseUntil: null, lastError: '', lastSyncedAt: null } }, { session, upsert: true, returnDocument: 'after' }).select('_id');
    connectionId = saved._id;
  }, guard(req));
  // Finish the initial pass before Settings reads the new connection. A provider
  // failure is recorded by sync and must not undo the successfully saved grant.
  await require('./sync').sync(connectionId).catch(() => {});
  return { href: href + '&calendarResult=connected' };
}
async function disconnect(req) {
  await actor(req);
  await withActiveAccountWrite([req.user.id], async session => {
    const row = await Connection.findOne({ ownerId: req.user.id, provider: req.params.provider }).session(session).lean();
    if (row?.leaseUntil > new Date()) fail(409, 'BUSY', 'Calendar sync is running. Try disconnecting again shortly.');
    await Connection.updateOne({ ownerId: req.user.id, provider: req.params.provider }, { $set: { credentials: '', disconnectedAt: new Date(), revision: crypto.randomUUID(), needsReconnect: false, lastError: '' } }, { session });
    await State.deleteMany({ ownerId: req.user.id, provider: req.params.provider }, { session });
  }, guard(req));
  return { disconnected: true };
}
async function cleanupOwner(userId, { session } = {}) {
  const calendars = await Connection.find({ ownerId: userId }).select('_id').session(session || null).lean();
  await State.deleteMany({ ownerId: userId }, { session });
  await require('../../models/CalendarSyncLink').deleteMany({ connectionId: { $in: calendars.map(item => item._id) } }, { session });
  await Connection.deleteMany({ ownerId: userId }, { session });
}
module.exports = { cleanupOwner, actor, status, connect, callback, disconnect, encode, decode, fail, version };
