const { test, expect } = require('playwright/test');
const { MongoClient, ObjectId } = require('mongoose').mongo;
const { randomUUID } = require('node:crypto');

async function read(api, path) {
  const response = await api.get(path); expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function post(api, path, data) {
  const csrf = await read(api, '/api/csrf');
  const response = await api.post(path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}

for (const entry of ['current', 'v2']) test(`${entry} earlier withdrawal agrees with both roles, requirements and its notification`, async ({ page, playwright, baseURL }, info) => {
  expect(baseURL).toBe('http://127.0.0.1:5888');
  expect(process.env.LPC_EARLIER_HISTORY_MONGO_URI).toBe('mongodb://127.0.0.1:5889/control-room-playwright?directConnection=true');
  const attorney = await playwright.request.newContext({ baseURL });
  const mongo = new MongoClient(process.env.LPC_EARLIER_HISTORY_MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { 'x-ai-control-room-e2e-secret': process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
    const bootstrap = await attorney.post('/api/admin/ai-control-room/dev/e2e/bootstrap-attorney', { headers }); expect(bootstrap.ok()).toBeTruthy();
    const { attorney: account } = await bootstrap.json();
    await post(attorney, '/api/auth/login', { email: account.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_PASSWORD || 'ControlRoomSupport123!' });
    const owner = (await read(attorney, '/api/auth/me')).user, para = (await read(page.request, '/api/auth/me')).user;
    const ownerId = owner.id || owner._id, paraId = para.id || para._id;
    const title = `Synthetic earlier lifecycle ${entry} ${randomUUID().slice(0, 8)}`;
    const { draft } = await post(attorney, '/api/case-drafts', { expectedOwnerId: ownerId, title, practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic history verification.', tasks: [{ title: 'Prepare chronology' }] });
    const { publication } = await post(attorney, '/api/cases/posting/publications', { expectedOwnerId: ownerId, draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' });
    const caseId = publication.caseId;
    await post(page.request, `/api/cases/${caseId}/apply`, { coverLetter: 'Preserve this earlier submitted letter.' });
    await post(attorney, `/api/cases/${caseId}/pre-engagement/${paraId}/request`, { conflictsCheckRequired: true, conflictsDetails: 'Synthetic parties for the earlier application.' });
    // Only this newly created local fixture is converted to a pre-migration
    // record. Every subsequent read and withdrawal uses the real application.
    await mongo.connect(); const db = mongo.db('control-room-playwright');
    const matter = await db.collection('cases').findOne({ _id: new ObjectId(caseId), title }); expect(matter).toBeTruthy();
    const job = await db.collection('jobs').findOne({ caseId: matter._id, attorneyId: new ObjectId(ownerId) }); expect(job).toBeTruthy();
    expect(matter.applicants.some(item => String(item.paralegalId) === paraId && item.status === 'pending')).toBe(true);
    expect((await db.collection('applications').deleteOne({ jobId: job._id, paralegalId: new ObjectId(paraId) })).deletedCount).toBe(1);
    const own = (await read(page.request, '/api/applications/my')).find(item => item.caseId === caseId);
    expect(own).toMatchObject({ applicationSource: 'case_applicant', pending: true, withdrawal: { available: true }, coverLetter: 'Preserve this earlier submitted letter.' });
    await page.goto(entry === 'current' ? `/dashboard-paralegal.html?jobId=${job._id}#cases` : `/paralegal-v2.html#/work?jobId=${job._id}`);
    const dialog = entry === 'current' ? page.locator('#applicationDetailModal') : page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toContainText('Synthetic parties for the earlier application.');
    await dialog.getByRole('button', { name: 'Withdraw application', exact: true }).click();
    const confirmation = entry === 'current' ? page.locator('#revokeConfirmModal') : page.getByRole('dialog', { name: 'Withdraw this application?', exact: true });
    await confirmation.getByRole('button', { name: 'Withdraw application', exact: true }).click();
    await expect(confirmation).toBeHidden();
    const saved = (await read(page.request, '/api/applications/my')).find(item => item.caseId === caseId);
    expect(saved).toMatchObject({ status: 'withdrawn', pending: false, preEngagement: null, coverLetter: own.coverLetter, withdrawal: { available: false } });
    expect(saved.statusHistory).toHaveLength(1);
    const after = await db.collection('cases').findOne({ _id: matter._id }); expect(after.preEngagement.revision).toBe(matter.preEngagement.revision + 1);
    expect((await db.collection('jobs').findOne({ _id: job._id })).applicantsCount).toBe(0);
    expect(await db.collection('applications').countDocuments({ jobId: job._id, paralegalId: new ObjectId(paraId) })).toBe(0);
    const review = await read(attorney, `/api/cases/${caseId}/application-review?expectedOwnerId=${ownerId}&applicantId=${paraId}`);
    expect(review.applications).toHaveLength(1); expect(review.applications[0].status).toBe('withdrawn');
    const notices = (await read(attorney, '/api/notifications')).filter(item => item.context?.caseId === caseId && item.type === 'case_update');
    const withdrawal = notices.filter(item => /withdrew their application/.test(item.message)); expect(withdrawal).toHaveLength(1);
    expect(withdrawal[0].action.href).toContain(`applicantId=${paraId}`); expect(withdrawal[0].action.href).toContain('tab=applications');
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${entry}-earlier-withdrawn.png`) });
  } finally { await mongo.close(); await attorney.dispose(); }
});
