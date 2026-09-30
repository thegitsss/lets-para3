const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
process.env.ENABLE_CSRF = 'true';
process.env.REQUIRE_AUTH_SESSION = 'true';
jest.mock('../utils/email', () => Object.assign(jest.fn(async () => ({ ok: true })), { sendAccountDeactivatedEmail: jest.fn(async () => ({ ok: true })) }));
const User = require('../models/User');
const Case = require('../models/Case');
const Job = require('../models/Job');
const Application = require('../models/Application');
const AuthSession = require('../models/AuthSession');
const AuthChallenge = require('../models/AuthChallenge');
const AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService');
const { generateCsrfToken, respondToCsrfError } = require('../utils/csrf');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express();
app.use(cookieParser(), express.json());
app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
app.use('/api/account', require('../routes/account'));
app.use('/api/auth', require('../routes/auth'));
app.use((error, _req, res, _next) => { if (!respondToCsrfError(error, res)) res.status(500).json({ error: 'Synthetic server error' }); });
let para, attorney, other;
async function actor(role, label) {
  const user = await User.create({ firstName: label, lastName: 'Fixture', role, email: `${label.toLowerCase()}@para-closure.example.test`, password: 'Synthetic paralegal closure passphrase!', status: 'approved', state: 'CA', emailVerified: true, resumeURL: `paralegal/resumes/${label}.pdf` });
  const session = await createAuthSession(user, { headers: { 'user-agent': 'Synthetic closure route' }, ip: '192.0.2.20' });
  const cookie = `token=${jwt.sign({ id: String(user._id), role, status: 'approved', av: 0, sid: session.sessionId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  return { user, id: String(user._id), cookie, sessionId: session.sessionId };
}
const review = (who = para, expectedOwnerId = who.id) => request(app).get('/api/account/deactivate-status').query({ expectedOwnerId }).set('Cookie', who.cookie);
const result = (proof, credential = para.cookie) => { const req = request(app).get('/api/account/deactivate-result').set('X-LPC-Closure-Proof', proof); return credential ? req.set('Cookie', credential) : req; };
async function close(current, who = para, extra = {}) {
  const csrf = await request(app).get('/api/csrf').set('Cookie', who.cookie);
  expect(csrf.status).toBe(200);
  return request(app).delete('/api/account/deactivate').set('Cookie', `${who.cookie}; _csrf=${csrf.body.csrfToken}`).set('X-CSRF-Token', csrf.body.csrfToken).send({ expectedOwnerId: para.id, expectedClosureRevision: current.closureRevision, resultProof: current.resultProof, ...extra });
}
async function participation({ status = 'submitted', selected = false, missingJob = false } = {}) {
  const matter = await Case.create({ title: 'Employer-owned retained posting', details: 'Prepare exhibits for attorney review.', practiceArea: 'probate', attorney: attorney.id, attorneyId: attorney.id, paralegal: selected ? para.id : null, paralegalId: selected ? para.id : null, pendingParalegalId: para.id, status: 'open', escrowStatus: 'awaiting_funding', paymentStatus: 'pending', totalAmount: 40000, currency: 'usd', applicants: [{ paralegalId: para.id, status: status === 'accepted' ? 'accepted' : 'pending', resumeURL: para.user.resumeURL }, { paralegalId: other.id, status: 'pending' }], invites: [{ paralegalId: para.id, status: status === 'accepted' ? 'accepted' : 'pending' }] });
  const job = await Job.create({ attorneyId: attorney.id, caseId: matter._id, title: matter.title, description: matter.details, practiceArea: 'probate', budget: 400, status: 'open', applicantsCount: 2 });
  const application = await Application.create({ jobId: job._id, paralegalId: para.id, status, coverLetter: 'Retain my submitted explanation.', resumeURL: para.user.resumeURL });
  const otherApplication = await Application.create({ jobId: job._id, paralegalId: other.id, status: 'submitted', coverLetter: 'Another applicant is still available.' });
  if (missingJob) await Job.deleteOne({ _id: job._id });
  return { matter, job, application, otherApplication };
}
beforeAll(connect, 240000);
afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); para = await actor('paralegal', 'Reporter'); attorney = await actor('attorney', 'Employer'); other = await actor('paralegal', 'Other'); });
afterEach(() => jest.restoreAllMocks());

test('managed Paralegal review signs the same private role-bound result contract', async () => {
  const current = await review();
  expect(current.status).toBe(200);
  expect(current.headers['cache-control']).toMatch(/private.*no-store/);
  expect(current.body).toMatchObject({ ownerId: para.id, canDeactivate: true, blockers: [] });
  expect(current.body.closureRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(Buffer.from(current.body.resultProof.split('.')[0], 'base64url'))).toMatchObject({ ownerId: para.id, role: 'paralegal', audience: '/api/account/deactivate-result' });
  expect((await result(current.body.resultProof)).body).toEqual({ state: 'active' });
  expect((await result(current.body.resultProof, null)).body).toEqual({ state: 'active' });
  expect((await result(current.body.resultProof, attorney.cookie)).status).toBe(403);
  expect((await request(app).get('/api/account/deactivate-status').set('Cookie', para.cookie)).body).toEqual({ canDeactivate: true, blockers: [] });
});

test.each(['submitted', 'accepted'])('guarded %s participation ends while employer postings and other applicants remain', async status => {
  const f = await participation({ status, selected: status === 'accepted' });
  await AuthChallenge.create({ userId: para.id, challengeId: 'para-closure-pending', purpose: 'totp_enrollment', challenge: 'synthetic', expiresAt: new Date(Date.now() + 600000) });
  const current = await review(), response = await close(current.body);
  expect(response.status).toBe(200); expect(response.body).toEqual({ ok: true, deactivated: true }); expect(response.headers['set-cookie']).toBeUndefined();
  const saved = await Application.findById(f.application._id).lean(), matter = await Case.findById(f.matter._id).lean();
  expect(saved).toMatchObject({ status: 'rejected', coverLetter: f.application.coverLetter, resumeURL: f.application.resumeURL });
  expect(saved.statusHistory.at(-1)).toMatchObject({ to: 'rejected', reason: 'account_deactivated', actorId: para.user._id });
  expect((await Application.findById(f.otherApplication._id)).status).toBe('submitted');
  expect(matter).toMatchObject({ status: 'open', archived: false, attorneyId: attorney.user._id, paymentReleased: false, escrowStatus: 'awaiting_funding', totalAmount: 40000 });
  expect(matter.paralegalId).toBeFalsy(); expect(matter.pendingParalegalId).toBeFalsy();
  expect(matter.applicants[0].status).toBe('rejected'); expect(matter.applicants[1].status).toBe('pending'); expect(matter.invites[0].status).toBe('expired');
  expect(await Job.findById(f.job._id).lean()).toMatchObject({ status: 'open', applicantsCount: 1, attorneyId: attorney.user._id });
  expect(await User.findById(para.id).lean()).toMatchObject({ disabled: true, deleted: true, resumeURL: para.user.resumeURL });
  expect((await User.findById(attorney.id)).disabled).toBe(false);
  expect(await AuthSession.countDocuments({ userId: para.id, revokedAt: null })).toBe(0); expect(await AuthChallenge.countDocuments({ userId: para.id })).toBe(0);
  expect(await AuditLog.countDocuments({ targetId: para.id, action: 'account.deactivate' })).toBe(1);
  expect((await result(current.body.resultProof)).body).toEqual({ state: 'deactivated' });
  expect((await request(app).get('/api/auth/me').set('Cookie', para.cookie)).body.user).toBeNull();
  expect((await request(app).get('/api/auth/me').set('Cookie', attorney.cookie)).body.user.id).toBe(attorney.id);
});

test.each(['submitted', 'accepted'])('guarded retained %s application survives a missing Job without blocking closure', async status => {
  const f = await participation({ status, missingJob: true }), current = await review();
  expect(current.body.canDeactivate).toBe(true); expect((await close(current.body)).status).toBe(200);
  expect(await Job.findById(f.job._id)).toBeNull();
  expect(await Application.findById(f.application._id).lean()).toMatchObject({ status: 'rejected', coverLetter: f.application.coverLetter, resumeURL: f.application.resumeURL });
  expect((await Case.findById(f.matter._id)).status).toBe('open');
  expect((await result(current.body.resultProof, null)).body).toEqual({ state: 'deactivated' });
});

test.each([
  ['assigned', { status: 'in progress', escrowStatus: 'funded' }, 'active_matters'],
  ['withdrawn', { status: 'paused', paralegal: null, paralegalId: null, pausedReason: 'paralegal_withdrew', payoutFinalizedAt: null }, 'unresolved_financials'],
  ['hire claimed', { hiringClaimStatus: 'claimed', hiringClaimToken: 'synthetic-current-claim', paralegal: null, paralegalId: null }, 'unresolved_financials'],
  ['dispute', { status: 'disputed', escrowStatus: 'funded' }, 'open_disputes'],
  ['payout pending', { status: 'completed', paymentReleased: true, paidOutAt: null, fundingRequestKey: 'retained' }, 'pending_payouts'],
])('current %s blocker is authoritative for the participating Paralegal', async (_label, changes, expected) => {
  const f = await participation();
  await Case.updateOne({ _id: f.matter._id }, { $set: { paralegal: para.id, paralegalId: para.id, withdrawnParalegalId: para.id, hiringClaimParalegalId: para.id, ...changes } });
  const current = await review(); expect(current.status).toBe(200); expect(current.body.canDeactivate).toBe(false);
  expect(current.body.blockers.map(value => value.code)).toContain(expected);
  expect((await close(current.body)).status).toBe(409); expect((await User.findById(para.id)).disabled).toBe(false);
  expect((await Application.findById(f.application._id)).status).toBe('submitted'); expect(await AuditLog.countDocuments({ action: 'account.deactivate' })).toBe(0);
});

test('a new reviewed participation change conflicts and leaves all records active', async () => {
  const current = await review(), f = await participation(), response = await close(current.body);
  expect(response.status).toBe(409); expect(response.body.code).toBe('ACCOUNT_CLOSURE_CHANGED');
  expect((await Application.findById(f.application._id)).status).toBe('submitted'); expect((await Case.findById(f.matter._id)).status).toBe('open'); expect((await User.findById(para.id)).disabled).toBe(false);
  expect((await result(current.body.resultProof)).body).toEqual({ state: 'active' });
});

test('settled historical funding and unrelated disputes preserve eligible Paralegal closure', async () => {
  const f = await participation();
  await Case.updateOne({ _id: f.matter._id }, { $set: { status: 'completed', paralegalId: para.id, paralegal: para.id, paymentReleased: true, paidOutAt: new Date(), escrowStatus: 'funded', fundingRequestKey: 'retained-paid-reference', paymentIntentId: 'pi_synthetic_retained', applicants: [], invites: [], pendingParalegalId: null } });
  await Application.updateOne({ _id: f.application._id }, { $set: { status: 'rejected' } });
  await Case.create({ title: 'Unrelated dispute', details: 'Another worker.', practiceArea: 'probate', attorney: attorney.id, paralegal: other.id, paralegalId: other.id, status: 'disputed', escrowStatus: 'funded' });
  const before = await Case.findById(f.matter._id).lean(), current = await review();
  expect(current.body.canDeactivate).toBe(true); expect((await close(current.body)).status).toBe(200);
  const after = await Case.findById(f.matter._id).lean();
  for (const field of ['status', 'paymentReleased', 'paidOutAt', 'fundingRequestKey', 'paymentIntentId', 'totalAmount', 'currency']) expect(after[field]).toEqual(before[field]);
  expect((await User.findById(other.id)).disabled).toBe(false);
});

test('wrong owner and missing CSRF cannot deactivate the replacement account', async () => {
  const current = await review(), wrong = await close(current.body, other);
  expect(wrong.status).toBe(403); expect(wrong.body.code).toBe('ACCOUNT_CHANGED');
  const absent = await request(app).delete('/api/account/deactivate').set('Cookie', para.cookie).send({ expectedOwnerId: para.id, expectedClosureRevision: current.body.closureRevision, resultProof: current.body.resultProof });
  expect(absent.status).toBe(403); expect(absent.body.code).toBe('CSRF_INVALID');
  expect((await User.findById(para.id)).disabled).toBe(false); expect((await User.findById(other.id)).disabled).toBe(false);
});

test('revoked initiating managed session cannot mutate while the bounded result stays a read', async () => {
  const current = await review(); await AuthSession.updateOne({ sessionId: para.sessionId }, { $set: { revokedAt: new Date() } });
  expect((await close(current.body)).status).toBe(403); expect((await User.findById(para.id)).disabled).toBe(false);
  expect((await result(current.body.resultProof, null)).body).toEqual({ state: 'active' }); expect(await AuditLog.countDocuments({ action: 'account.deactivate' })).toBe(0);
});
