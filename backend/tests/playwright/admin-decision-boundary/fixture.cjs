'use strict';
const { expect } = require('playwright/test');
const crypto = require('node:crypto');
const security = require('../../../utils/fileSecurity');
const actualScan = security.assertObjectMalwareSafe;
const scans = [];
const revocations = [];
let heldScan = null;
// Retain the actual malware classifier. Only the object-tag transport is local.
security.assertObjectMalwareSafe = options => actualScan({ ...options, s3: {
  async send(command) {
    if (command.constructor.name !== 'GetObjectTaggingCommand') throw Error('Unconfigured synthetic admission storage transport.');
    scans.push({ command: command.constructor.name, key: command.input.Key, bucket: command.input.Bucket });
    if (heldScan && command.input.Key === heldScan.key) {
      heldScan.entered = true; await heldScan.promise;
    }
    return { TagSet: [{ Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' }] };
  },
} });
const emailId = require.resolve('../../../utils/email'), adminId = require.resolve('../../../routes/admin');
const bindings = new Map(), functionIds = new WeakMap();
let nextFunctionId = 0;
function functionId(fn) {
  if (typeof fn !== 'function') throw Error('Synthetic admission sender is not a function.');
  if (!functionIds.has(fn)) functionIds.set(fn, 'admission-mock-email-' + ++nextFunctionId);
  return functionIds.get(fn);
}
async function start() {
  const before = require.cache[adminId]?.exports;
  const server = await require('../../helpers/financialLifecycleBrowserServer')({
    port: 0, includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true, includeSyntheticMail: true,
  });
  process.env.S3_MALWARE_SCAN_REQUIRED = 'true';
  const route = require.cache[adminId]?.exports, sender = require.cache[emailId]?.exports;
  if (!before && route) bindings.set(route, { route, sender, calls: server.evidence().external.mail });
  const binding = bindings.get(route);
  if (!binding) { await server.close(); throw Error('The actual cached Admin admission sender has no observed owning capture.'); }
  server.noticeEvidence = () => ({ owningSenderId: functionId(binding.sender), currentRequireCacheSenderId: functionId(require.cache[emailId].exports),
    owningSenderIsCurrent: binding.sender === require.cache[emailId].exports, cachedRouteStillObserved: require.cache[adminId].exports === binding.route,
    actualOwningCalls: [...binding.calls], currentHarnessCalls: [...server.evidence().external.mail], syntheticTransportOnly: true });
  const reset = server.reset;
  server.reset = async () => { await reset(); binding.calls.length = 0; scans.length = 0; revocations.length = 0; heldScan = null; };
  return server;
}
function hold(key) {
  let release; heldScan = { key, entered: false, promise: new Promise(resolve => { release = resolve; }), release: () => release() };
  return heldScan;
}
const qualificationReview = { confirmed: true, qualification: 'law_firm_experience', method: 'employer_contact',
  evidence: 'Synthetic independently sourced employer review confirmed three years of law-firm work.' };
async function applicant(server) {
  const actor = await server.createUser('paralegal');
  const User = require('../../../models/User');
  await User.updateOne({ _id: actor.id }, { $set: { status: 'pending', firstName: 'Pending', lastName: 'Qualification ' + actor.id.slice(-6),
    yearsExperience: 3, paralegalQualification: 'law_firm_experience', resumeURL: `paralegal-resumes/${actor.id}/resume.pdf`,
    profileImage: '', avatarURL: '', profilePhotoStatus: 'unsubmitted' }, $unset: { approvedAt: 1 } });
  return { ...actor, ...(await User.findById(actor.id).select('+authVersion').lean()), id: actor.id };
}
async function snapshot(ids) {
  const User = require('../../../models/User');
  const accountRows = await User.find({ _id: { $in: ids } }).select('+authVersion').sort({ _id: 1 }).lean();
  for (const row of accountRows) for (const key of ['password','passwordHash','resetToken','resetTokenHash','emailVerificationToken','emailVerificationTokenHash']) delete row[key];
  const collections = {}, models = { AuditLog: require('../../../models/AuditLog'),
    LpcEvent: require('../../../models/LpcEvent').LpcEvent, Notification: require('../../../models/Notification'),
    SupportTicket: require('../../../models/SupportTicket'), AdminDraft: require('../../../models/AdminDraft') };
  for (const [name, Model] of Object.entries(models)) {
    if (typeof Model?.find !== 'function') throw Object.assign(Error('Invalid actual model export: ' + name), {
      code: 'INCOMPLETE_ADMISSION_RECORD_EXPORT', partialAdmissionSnapshot: JSON.parse(JSON.stringify({ applicants: accountRows, ...collections })) });
    try { collections[name] = await Model.find().sort({ _id: 1 }).lean(); }
    catch (error) { error.partialAdmissionSnapshot = JSON.parse(JSON.stringify({ applicants: accountRows, ...collections })); throw error; }
  }
  return JSON.parse(JSON.stringify({ applicants: accountRows, ...collections }));
}
async function authoritySnapshot() {
  const accounts = await require('../../../models/User').find().select('_id role status disabled deleted +authVersion __v').sort({ _id: 1 }).lean();
  const sessions = await require('../../../models/AuthSession').find().sort({ _id: 1 }).lean();
  return JSON.parse(JSON.stringify({ accounts, sessions: sessions.map(row => ({ id: String(row._id), userId: String(row.userId),
    sidDigest: crypto.createHash('sha256').update(row.sessionId).digest('hex'), revokedAt: row.revokedAt, revokedReason: row.revokedReason,
    expiresAt: row.expiresAt, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, version: row.__v })) }));
}
async function authority(context, server, actor, observations, expected = 200) {
  const response = await context.get(server.origin + '/api/auth/me'), body = await response.json();
  expect(response.status()).toBe(expected);
  if (expected === 200) expect(body.user).toMatchObject({ id: actor.id, role: 'admin', status: 'approved' });
  const account = await require('../../../models/User').findById(actor.id).select('+authVersion').lean();
  const sessions = await require('../../../models/AuthSession').find({ userId: actor.id }).sort({ createdAt: 1 }).lean();
  const cookie = (await context.storageState()).cookies.find(row => row.name === 'token');
  const claims = require('jsonwebtoken').verify(cookie.value, process.env.JWT_SECRET);
  const issuingSession = sessions.find(row => row.sessionId === claims.sid);
  expect(typeof claims.sid).toBe('string'); expect(issuingSession).toBeTruthy();
  expect(claims.av).toBe(Number(account.authVersion || 0)); expect(issuingSession.revokedAt).toBeNull();
  expect(issuingSession.expiresAt.getTime()).toBeGreaterThan(Date.now());
  observations.push({ phase: 'actual-current-admin-authority', httpStatus: response.status(), user: body.user ? { id: body.user.id, role: body.user.role, status: body.user.status } : null,
    currentCookieSidDigest: crypto.createHash('sha256').update(claims.sid).digest('hex'), currentCookieAuthVersion: claims.av, actualCookieSessionMatched: true,
    account: { id: String(account._id), role: account.role, status: account.status, disabled: account.disabled, deleted: account.deleted, authVersion: account.authVersion || 0 },
    sessions: sessions.map(row => ({ userId: String(row.userId), sidDigest: crypto.createHash('sha256').update(row.sessionId).digest('hex'), revokedAt: row.revokedAt, expiresAt: row.expiresAt, version: row.__v })) });
}
async function csrf(context, server) {
  const response = await context.get(server.origin + '/api/csrf'); expect(response.status()).toBe(200);
  const token = (await response.json()).csrfToken; expect(token).toEqual(expect.any(String)); return token;
}
function body(applicant, owner) {
  return { expectedOwnerId: owner.id, reviewedRevision: require('../../../services/admissionReview').admissionRevision(applicant), qualificationReview, note: 'Synthetic consequential owner decision.' };
}
async function revoke(actor, kind) {
  const User = require('../../../models/User'), Session = require('../../../models/AuthSession');
  if (kind === 'disabled') await User.updateOne({ _id: actor.id }, { $set: { disabled: true } });
  else if (kind === 'auth-version') await User.updateOne({ _id: actor.id }, { $inc: { authVersion: 1 } });
  else if (kind === 'managed-session') await Session.updateMany({ userId: actor.id }, { $set: { revokedAt: new Date(), revokedReason: 'Synthetic held admission decision diagnostic.' } });
  else throw Error('Unconfigured admission authority loss.');
  const account = await User.findById(actor.id).select('+authVersion').lean(), sessions = await Session.find({ userId: actor.id }).sort({ createdAt: 1 }).lean();
  revocations.push({ phase: 'independently-read-current-admin-loss', kind, actorId: actor.id,
    account: { role: account.role, status: account.status, disabled: account.disabled, deleted: account.deleted, authVersion: account.authVersion || 0 },
    sessions: sessions.map(row => ({ sidDigest: crypto.createHash('sha256').update(row.sessionId).digest('hex'), userId: String(row.userId), revokedAt: row.revokedAt, expiresAt: row.expiresAt, version: row.__v })) });
}
function finalResponse(page, path, observations) {
  let attempts = 0;
  return page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== path || response.request().method() !== 'POST') return false;
    const payload = await response.json().catch(() => ({})), attempt = ++attempts;
    const csrfRetry = attempt === 1 && response.status() === 403 && payload.code === 'CSRF_INVALID';
    observations.push({ phase: 'actual-native-decision-attempt', path, url: response.url(), status: response.status(), attempt, payload, explicitFirstCsrfRetry: csrfRetry });
    return !csrfRetry;
  });
}
async function finish(server, info, contexts, observations, ids, errors = [], native = false) {
  let actual = null, actualAuthority = null, evidence = null, notice = null, recordExportComplete = false, forbidden = [], closed = 0;
  const permittedPrivateDraftWrites = [];
  const exportErrors = [], closeErrors = [];
  try {
    try { actual = await snapshot(ids); actualAuthority = await authoritySnapshot(); recordExportComplete = true; }
    catch (error) { actual = error.partialAdmissionSnapshot || null; exportErrors.push({ name: error.name, code: error.code || null, message: error.message, scope: 'actual-record-export' }); }
    try { evidence = server.evidence(); notice = server.noticeEvidence(); }
    catch (error) { exportErrors.push({ name: error.name, code: error.code || null, message: error.message, scope: 'request-or-owning-sender-export' }); }
    observations.push({ phase: 'independent-final-admission-bookkeeping', actual, actualAuthority, recordExportComplete, exportErrors,
      scans: [...scans], revocations: [...revocations], notice });
    if (evidence) forbidden = evidence.requests.filter(row => {
      // The current account renderer clears its personal note after an actual
      // successful decision. Allow only that exact subject's successful PUT,
      // with the resulting raw encrypted row owned by the reviewed Admin.
      const target = row.path.match(/^\/api\/admin\/workspace\/drafts\/account\/([a-f0-9]{24})$/);
      const reviewed = observations.find(item => item.phase === 'actual-native-reviewed-application' && item.applicantId === target?.[1]);
      const accepted = observations.find(item => item.phase === 'actual-native-approved-record' && item.status === 200 &&
        item.saved?.applicants?.some(account => String(account._id) === target?.[1] && account.status === 'approved'));
      const drafts = actual?.AdminDraft || [];
      const exactDraft = drafts.find(draft => String(draft.owner) === reviewed?.reviewedAdmin && draft.kind === 'account' && String(draft.recordId) === target?.[1]);
      const onlyReviewedDrafts = drafts.every(draft => String(draft.owner) === reviewed?.reviewedAdmin && draft.kind === 'account' && String(draft.recordId) === target?.[1]);
      if (native && row.method === 'PUT' && row.status === 200 && target && ids.includes(target[1]) && reviewed && accepted && exactDraft && onlyReviewedDrafts &&
          typeof exactDraft.content === 'string' && exactDraft.content && Number.isSafeInteger(exactDraft.revision) && exactDraft.revision > 0) {
        permittedPrivateDraftWrites.push({ ...row, actualDraftId: String(exactDraft._id), ownerId: String(exactDraft.owner), kind: exactDraft.kind,
          recordId: String(exactDraft.recordId), revision: exactDraft.revision, encryptedContentSha256: crypto.createHash('sha256').update(exactDraft.content).digest('hex'),
          boundedByActualSuccessfulDecisionAndRawOwnerSubject: true });
        return false;
      }
      return !['GET','HEAD','OPTIONS'].includes(row.method) &&
      !(row.method === 'POST' && /^\/api\/admin\/users\/[a-f0-9]{24}\/(approve|deny)$/.test(row.path)) &&
      !(row.method === 'POST' && row.status === 200 && ['/api/auth/login','/api/auth/passkeys/authentication-options'].includes(row.path));
    });
  }
  finally {
    // An incomplete record read must never skip API disposal or native capture.
    for (const context of contexts) {
      try { if (native) await context.close(); else await context.dispose(); closed++; }
      catch (error) { closeErrors.push({ name: error.name, message: error.message }); }
    }
    await info.attach('admin-decision-boundary-evidence.json', { body: Buffer.from(JSON.stringify({ observations, actual, actualAuthority, recordExportComplete, exportErrors, closeErrors, notice, scans, errors,
      kind: native ? 'actual-native' : 'actual-handler', contextsCreated: contexts.length, contextsClosed: closed, capturedThroughNormalClose: contexts.length === closed,
      permittedPrivateDraftWrites, forbiddenMutations: forbidden, ...(evidence || {}) })), contentType: 'application/json' });
  }
  expect(recordExportComplete).toBe(true); expect(exportErrors).toEqual([]); expect(closeErrors).toEqual([]);
  expect(forbidden).toEqual([]); expect(server.provider.calls).toHaveLength(0); expect(evidence.external.storage).toHaveLength(0); expect(errors).toEqual([]);
}
module.exports = { start, applicant, snapshot, authority, csrf, body, revoke, hold, scans, finalResponse, finish, qualificationReview };
