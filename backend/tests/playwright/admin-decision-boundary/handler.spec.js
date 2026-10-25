const { test, expect, request } = require('playwright/test');
const f = require('./fixture.cjs');
let server;
test.beforeAll(async () => { test.setTimeout(360000); server = await f.start(); });
test.beforeEach(async () => server.reset()); test.afterAll(async () => server?.close());
async function contextFor(actor) {
  return request.newContext({ baseURL: server.origin, storageState: { cookies: [{ ...actor.cookie, url: undefined,
    domain: new URL(server.origin).hostname, path: '/', expires: -1, secure: false }], origins: [] } });
}
const path = applicant => '/api/admin/users/' + applicant.id + '/approve';
test('current managed Admin approval stores the exact qualification once and an acknowledged repeat does not repeat its decision or synthetic notice', async ({}, info) => {
  test.setTimeout(30000); const actor = await server.createUser('admin'), applicant = await f.applicant(server), context = await contextFor(actor), observations = [];
  try {
    await f.authority(context, server, actor, observations); const before = await f.snapshot([applicant.id]), token = await f.csrf(context, server);
    const first = await context.post(path(applicant) + '?expectedOwnerId=' + actor.id, { data: f.body(applicant, actor), headers: { 'X-CSRF-Token': token } });
    const firstBody = await first.json(), accepted = await f.snapshot([applicant.id]);
    const repeat = await context.post(path(applicant) + '?expectedOwnerId=' + actor.id, { data: f.body(applicant, actor), headers: { 'X-CSRF-Token': token } });
    const after = await f.snapshot([applicant.id]); observations.push({ phase: 'actual-managed-decision-and-repeat', before, accepted, after, first: { status: first.status(), payload: firstBody }, repeat: { status: repeat.status(), payload: await repeat.json() }, notice: server.noticeEvidence() });
    expect(first.status()).toBe(200); expect(repeat.status()).toBe(200); expect(after).toEqual(accepted);
    expect(after.applicants[0].status).toBe('approved'); expect(after.applicants[0].audit).toHaveLength(1);
    expect(after.applicants[0].audit[0].adminId).toBe(actor.id); expect(after.applicants[0].audit[0].qualificationReview).toMatchObject({ qualification: 'law_firm_experience', method: 'employer_contact' });
    expect(server.noticeEvidence().actualOwningCalls.filter(row => row[0] === applicant.email)).toHaveLength(1);
  } finally { await f.finish(server, info, [context], observations, [applicant.id]); }
});
test('a second current managed Admin cannot use the first reviewed Admin intent to decide an application', async ({}, info) => {
  test.setTimeout(30000); const actor = await server.createUser('admin'), newer = await server.createUser('admin'), applicant = await f.applicant(server);
  const contexts = [await contextFor(actor), await contextFor(newer)], observations = [];
  try {
    await f.authority(contexts[0], server, actor, observations); await f.authority(contexts[1], server, newer, observations);
    const before = await f.snapshot([applicant.id]), token = await f.csrf(contexts[1], server);
    const response = await contexts[1].post(path(applicant) + '?expectedOwnerId=' + actor.id, { data: f.body(applicant, actor), headers: { 'X-CSRF-Token': token } });
    const after = await f.snapshot([applicant.id]); observations.push({ phase: 'actual-reviewed-owner-conflict', reviewedOwner: actor.id, currentOwner: newer.id, status: response.status(), payload: await response.json(), before, after });
    expect(response.status()).toBe(403); expect(after).toEqual(before); expect(f.scans).toHaveLength(0); expect(server.noticeEvidence().actualOwningCalls).toHaveLength(0);
  } finally { await f.finish(server, info, contexts, observations, [applicant.id]); }
});
for (const kind of ['disabled','auth-version','managed-session']) test('an admission decision cannot commit after current Admin ' + kind + ' loss during the actual clean-tag storage read', async ({}, info) => {
  test.setTimeout(30000); const actor = await server.createUser('admin'), applicant = await f.applicant(server), context = await contextFor(actor), observations = [];
  const gate = f.hold(applicant.resumeURL); let pending;
  try {
    await f.authority(context, server, actor, observations); const before = await f.snapshot([applicant.id]), token = await f.csrf(context, server);
    pending = context.post(path(applicant) + '?expectedOwnerId=' + actor.id, { data: f.body(applicant, actor), headers: { 'X-CSRF-Token': token } });
    await expect.poll(() => gate.entered).toBe(true); await f.revoke(actor, kind);
    const denied = await context.get('/api/admin/pending-users'); expect(denied.status()).toBe(403);
    observations.push({ phase: 'actual-admin-revoked-before-admission-write', kind, deniedStatus: denied.status(), deniedPayload: await denied.json() });
    gate.release(); const response = await pending, after = await f.snapshot([applicant.id]);
    observations.push({ phase: 'actual-revoked-admission-result', kind, before, after, status: response.status(), payload: await response.json(), notice: server.noticeEvidence() });
    expect(response.status()).toBe(403); expect(after).toEqual(before); expect(server.noticeEvidence().actualOwningCalls).toHaveLength(0);
  } finally { gate.release(); if (pending) await pending.catch(() => {}); await f.finish(server, info, [context], observations, [applicant.id]); }
});
test('a changed application document during the held safety read preserves the latest pending application and rejects the stale approval', async ({}, info) => {
  test.setTimeout(30000); const actor = await server.createUser('admin'), applicant = await f.applicant(server), context = await contextFor(actor), observations = [];
  const gate = f.hold(applicant.resumeURL); let pending;
  try {
    await f.authority(context, server, actor, observations); const token = await f.csrf(context, server);
    pending = context.post(path(applicant) + '?expectedOwnerId=' + actor.id, { data: f.body(applicant, actor), headers: { 'X-CSRF-Token': token } });
    await expect.poll(() => gate.entered).toBe(true);
    await require('../../../models/User').updateOne({ _id: applicant.id }, { $set: { resumeURL: `paralegal-resumes/${applicant.id}/newer.pdf` } });
    const latest = await f.snapshot([applicant.id]); gate.release(); const response = await pending, after = await f.snapshot([applicant.id]);
    observations.push({ phase: 'actual-newer-document-revision', latest, after, status: response.status(), payload: await response.json() });
    expect(response.status()).toBe(409); expect(after).toEqual(latest); expect(server.noticeEvidence().actualOwningCalls).toHaveLength(0);
  } finally { gate.release(); if (pending) await pending.catch(() => {}); await f.finish(server, info, [context], observations, [applicant.id]); }
});
test('a current reviewed Admin denial records the exact owner reason once without repeating the synthetic decision notice', async ({}, info) => {
  test.setTimeout(30000); const actor = await server.createUser('admin'), applicant = await f.applicant(server), context = await contextFor(actor), observations = [];
  try {
    await f.authority(context, server, actor, observations); const token = await f.csrf(context, server), data = { ...f.body(applicant, actor), note: 'Synthetic owner denial reason.' };
    const route = '/api/admin/users/' + applicant.id + '/deny?expectedOwnerId=' + actor.id;
    const first = await context.post(route, { data, headers: { 'X-CSRF-Token': token } }), accepted = await f.snapshot([applicant.id]);
    const repeat = await context.post(route, { data, headers: { 'X-CSRF-Token': token } }), after = await f.snapshot([applicant.id]);
    observations.push({ phase: 'actual-denial-and-repeat', accepted, after, first: { status: first.status(), payload: await first.json() }, repeat: { status: repeat.status(), payload: await repeat.json() } });
    expect(first.status()).toBe(200); expect(repeat.status()).toBe(200); expect(after).toEqual(accepted); expect(after.applicants[0].status).toBe('denied');
    expect(after.applicants[0].audit).toHaveLength(1); expect(after.applicants[0].audit[0]).toMatchObject({ adminId: actor.id, note: data.note, action: 'denied' });
    expect(server.noticeEvidence().actualOwningCalls.filter(row => row[0] === applicant.email)).toHaveLength(1);
  } finally { await f.finish(server, info, [context], observations, [applicant.id]); }
});
