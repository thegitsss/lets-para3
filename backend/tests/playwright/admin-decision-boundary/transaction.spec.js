const { test, expect, request } = require('playwright/test');
const f = require('./fixture.cjs');
let server;
test.beforeAll(async () => { test.setTimeout(360000); server = await f.start(); });
test.beforeEach(async () => server.reset()); test.afterAll(async () => server?.close());
async function ready() {
  const actor = await server.createUser('admin'), applicant = await f.applicant(server), observations = [];
  const context = await request.newContext({ baseURL: server.origin, storageState: { cookies: [{ ...actor.cookie, url: undefined,
    domain: new URL(server.origin).hostname, path: '/', expires: -1, secure: false }], origins: [] } });
  await f.authority(context, server, actor, observations);
  const token = await f.csrf(context, server);
  const post = () => context.post('/api/admin/users/' + applicant.id + '/approve?expectedOwnerId=' + actor.id,
    { data: f.body(applicant, actor), headers: { 'X-CSRF-Token': token } });
  return { actor, applicant, observations, context, post };
}
test('a strict decision-audit failure rolls back the actual applicant status and embedded audit without event or notice', async ({}, info) => {
  test.setTimeout(30000); const x = await ready(), AuditLog = require('../../../models/AuditLog'), original = AuditLog.logFromReq;
  try {
    const before = await f.snapshot([x.applicant.id]);
    AuditLog.logFromReq = function(req, action, options) {
      if (action === 'admin.user.approved') {
        x.observations.push({ phase: 'actual-decision-audit-failure-inside-transaction', activeTransaction: options?.session?.inTransaction() });
        expect(options.session.inTransaction()).toBe(true); throw Error('Synthetic strict admission audit write failure.');
      }
      return original.call(this, req, action, options);
    };
    const response = await x.post(), after = await f.snapshot([x.applicant.id]);
    x.observations.push({ phase: 'actual-strict-audit-rollback', before, after, status: response.status(), payload: await response.json(), notice: server.noticeEvidence() });
    expect(response.status()).toBe(500); expect(after).toEqual(before); expect(server.noticeEvidence().actualOwningCalls).toHaveLength(0);
  } finally { AuditLog.logFromReq = original; await f.finish(server, info, [x.context], x.observations, [x.applicant.id]); }
});
test('natural managed-session expiry after the actual transactional audit write aborts both applicant and audit before commit', async ({}, info) => {
  test.setTimeout(30000); const x = await ready(), AuditLog = require('../../../models/AuditLog'), original = AuditLog.logFromReq;
  try {
    const before = await f.snapshot([x.applicant.id]), Session = require('../../../models/AuthSession');
    const claims = require('jsonwebtoken').verify(x.actor.cookie.value, process.env.JWT_SECRET);
    const deadline = Date.now() + 1500;
    await Session.updateOne({ sessionId: claims.sid, userId: x.actor.id }, { $set: { expiresAt: new Date(deadline) } });
    const current = await Session.findOne({ sessionId: claims.sid }).lean(); expect(current.expiresAt.getTime()).toBe(deadline);
    AuditLog.logFromReq = async function(req, action, options) {
      const saved = await original.call(this, req, action, options);
      if (action === 'admin.user.approved') {
        expect(options.session.inTransaction()).toBe(true);
        x.observations.push({ phase: 'actual-audit-written-before-natural-session-expiry', activeTransaction: true, auditId: String(saved._id), expiresAt: current.expiresAt });
        while (Date.now() <= deadline) await new Promise(resolve => setTimeout(resolve, 20));
      }
      return saved;
    };
    const response = await x.post(), after = await f.snapshot([x.applicant.id]);
    x.observations.push({ phase: 'actual-expired-managed-session-transaction-rollback', before, after, status: response.status(), payload: await response.json(), notice: server.noticeEvidence() });
    expect(x.observations.some(row => row.phase === 'actual-audit-written-before-natural-session-expiry')).toBe(true);
    expect(response.status()).toBe(403); expect(after).toEqual(before); expect(server.noticeEvidence().actualOwningCalls).toHaveLength(0);
  } finally { AuditLog.logFromReq = original; await f.finish(server, info, [x.context], x.observations, [x.applicant.id]); }
});
test('a real committed admission with a synthetic lost commit acknowledgement reports unconfirmed and cannot send or resend a notice', async ({}, info) => {
  test.setTimeout(30000); const x = await ready(), mongoose = require('mongoose'), original = mongoose.startSession;
  try {
    const before = await f.snapshot([x.applicant.id]); let actualCommits = 0;
    mongoose.startSession = async function(...args) {
      const session = await original.apply(this, args), commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => {
        await commit(); actualCommits++;
        x.observations.push({ phase: 'actual-driver-commit-before-synthetic-lost-acknowledgement', actualCommits, transactionStillActive: session.inTransaction() });
        throw Object.assign(Error('Synthetic lost transaction acknowledgement.'), { hasErrorLabel: label => label === 'UnknownTransactionCommitResult' });
      };
      return session;
    };
    const response = await x.post(); mongoose.startSession = original;
    const saved = await f.snapshot([x.applicant.id]), payload = await response.json(), repeat = await x.post(), after = await f.snapshot([x.applicant.id]);
    x.observations.push({ phase: 'actual-committed-unconfirmed-admission-and-idempotent-read', before, saved, after,
      response: { status: response.status(), payload }, repeat: { status: repeat.status(), payload: await repeat.json() }, actualCommits, notice: server.noticeEvidence() });
    expect(actualCommits).toBe(1); expect(response.status()).toBe(503); expect(payload.code).toBe('ACCOUNT_WRITE_UNCONFIRMED');
    expect(payload.msg).toMatch(/could not be confirmed.*current state/i);
    expect(saved.applicants[0].status).toBe('approved'); expect(saved.applicants[0].audit).toHaveLength(1);
    expect(saved.AuditLog.filter(row => row.action === 'admin.user.approved')).toHaveLength(1);
    expect(saved.LpcEvent).toEqual(before.LpcEvent); expect(repeat.status()).toBe(200);
    expect((await repeat.json()).notification).toEqual({ delivery: 'unconfirmed', recorded: false });
    expect(after).toEqual(saved); expect(server.noticeEvidence().actualOwningCalls).toHaveLength(0);
  } finally { mongoose.startSession = original; await f.finish(server, info, [x.context], x.observations, [x.applicant.id]); }
});
for (const loss of ['role', 'deleted', 'approval']) test('current Admin ' + loss + ' loss during a held clean-tag scan cannot commit admission bookkeeping', async ({}, info) => {
  test.setTimeout(30000); const x = await ready(), gate = f.hold(x.applicant.resumeURL); let pending;
  try {
    const before = await f.snapshot([x.applicant.id]); pending = x.post(); await expect.poll(() => gate.entered).toBe(true);
    const update = loss === 'role' ? { role: 'attorney' } : loss === 'deleted' ? { deleted: true } : { status: 'pending' };
    await require('../../../models/User').updateOne({ _id: x.actor.id }, { $set: update });
    const lost = await require('../../../models/User').findById(x.actor.id).select('+authVersion').lean();
    x.observations.push({ phase: 'independently-read-actual-admin-' + loss + '-loss', ownerId: x.actor.id, account: { role: lost.role, status: lost.status, deleted: lost.deleted, authVersion: lost.authVersion || 0 } });
    gate.release(); const response = await pending, after = await f.snapshot([x.applicant.id]);
    x.observations.push({ phase: 'actual-admin-' + loss + '-loss-no-decision', before, after, status: response.status(), payload: await response.json(), notice: server.noticeEvidence() });
    expect(response.status()).toBe(403); expect(after).toEqual(before); expect(server.noticeEvidence().actualOwningCalls).toHaveLength(0);
  } finally { gate.release(); if (pending) await pending.catch(() => {}); await f.finish(server, info, [x.context], x.observations, [x.applicant.id]); }
});
