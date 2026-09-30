const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest');
const mongoose = require('mongoose'), { randomUUID } = require('crypto');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
jest.mock('../utils/stripe', () => ({}));
jest.mock('../utils/email', () => jest.fn(async () => ({})));
jest.mock('../utils/notifyUser', () => ({ notifyUser: jest.fn(async () => ({})) }));
const User = require('../models/User'), Case = require('../models/Case'), Job = require('../models/Job'), Application = require('../models/Application'), Decision = require('../models/ApplicationDecision');
const app = express(); app.use(cookieParser(), express.json());
const authenticationFailures = [];
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode === 401) authenticationFailures.push({ method: req.method, path: req.originalUrl, cookieHeaderPresent: Boolean(req.headers.cookie), tokenParsed: Boolean(req.cookies?.token), userPresent: Boolean(req.user), authPresent: Boolean(req.auth) });
  });
  next();
});
app.use('/api/cases', require('../routes/cases')); app.use('/api/applications', require('../routes/applications'));
const id = value => String(value).toLowerCase(), upper = value => id(value).toUpperCase();
const savedProfile = { bio: 'Saved application bio', location: 'New York', availability: 'Recorded availability', yearsExperience: 7, languages: ['English'], specialties: ['Immigration'], profileImage: '' };
const cookie = user => `token=${require('jsonwebtoken').sign({ id: id(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
let owner, para, other, admin, caseId, jobId, applicationId;
const get = (path, actor = owner, query = {}) => request(app).get(path).query(query).set('Cookie', cookie(actor));
const read = (surface, query = {}, actor = owner) => get(`/api/cases/${caseId}/${surface}`, actor, { expectedOwnerId: id(actor._id), ...query });
const decisionPath = () => `/api/cases/${caseId}/application-review/${para._id}/decision`;
const reviewDecision = () => get(decisionPath(), owner, { expectedOwnerId: id(owner._id) });
const sendDecision = input => request(app).post(decisionPath()).set('Cookie', cookie(owner)).send({ expectedOwnerId: id(owner._id), ...input });
const stored = () => Promise.all([Case.collection.find({}).sort({ _id: 1 }).toArray(), Job.collection.find({}).sort({ _id: 1 }).toArray(), Application.collection.find({}).sort({ _id: 1 }).toArray()]);
// Use the suite's bounded, serial model setup and shared disposable replica.
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  authenticationFailures.length = 0;
  [owner, para, other, admin] = await User.create(['owner', 'para', 'other', 'admin'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@identity.example`, password: 'Password123!', role: name === 'para' ? 'paralegal' : name === 'admin' ? 'admin' : 'attorney', status: 'approved' })));
  caseId = new mongoose.Types.ObjectId(); jobId = new mongoose.Types.ObjectId(); applicationId = new mongoose.Types.ObjectId();
  await Case.collection.insertOne({ _id: caseId, attorney: owner._id, attorneyId: owner._id, title: 'Application identity agreement', details: 'Private synthetic review.', status: 'open', totalAmount: 60001, jobId, applicants: [{ paralegalId: para._id, status: 'pending', note: 'Preserved letter', profileSnapshot: savedProfile, starredBy: [owner._id, other._id] }], __v: 0 });
  await Job.collection.insertOne({ _id: jobId, attorneyId: owner._id, caseId, title: 'Application identity agreement', description: 'Private synthetic review.', practiceArea: 'Immigration', budget: 600.01, status: 'open', applicantsCount: 1 });
  await Application.collection.insertOne({ _id: applicationId, jobId, paralegalId: para._id, status: 'submitted', coverLetter: 'Preserved letter', profileSnapshot: savedProfile, syncStatus: 'synced', starredBy: [owner._id, other._id], createdAt: new Date('2026-01-01') });
});
afterEach(() => jest.restoreAllMocks());

const detail = (actor, suffix = '') => get(`/api/cases/${caseId}${suffix}`, actor, actor.role === 'admin' ? {} : { expectedOwnerId: id(actor._id) });
const summaries = async () => {
  const paths = [['/api/cases/my', owner], ['/api/cases/my-active', owner], ['/api/cases/posted', owner], ['/api/cases/admin', admin], ['/api/cases/posted', admin]];
  return Promise.all(paths.map(async ([path, actor]) => {
    const response = await get(path, actor); expect(response.status).toBe(200);
    const rows = Array.isArray(response.body) ? response.body : response.body.items || response.body.cases;
    const row = rows.find(value => id(value._id || value.id) === id(caseId)); expect(row).toBeDefined();
    return { path, role: actor.role, count: row.applicantsCount };
  }));
};

async function expectInventory(count) {
  const response = await get('/api/cases/inventory', owner, { expectedOwnerId: id(owner._id), view: count ? 'applications' : 'active' });
  expect({ status: response.status, body: response.status === 200 ? null : response.body }).toEqual({ status: 200, body: null });
  expect(response.body.counts.applications).toBe(count ? 1 : 0);
  expect(response.body.items).toHaveLength(1); expect(response.body.items[0].applicantsCount).toBe(count);
}

test.each(['submitted', 'viewed', 'shortlisted', 'accepted', 'rejected', 'withdrawn'])('%s canonical raw reference agrees across both old readers, review inventory and own history', async status => {
  await Application.collection.updateOne({ _id: applicationId }, { $set: { jobId: upper(jobId), paralegalId: upper(para._id), status, starredBy: [upper(owner._id)], coverLetter: 'Canonical saved letter' } });
  const before = await stored();
  for (const actor of [owner, admin, para]) for (const suffix of ['', '/applicants']) {
    const response = await detail(actor, suffix); expect(response.status).toBe(200);
    const rows = response.body.applicants;
    if (status === 'withdrawn') expect(rows).toEqual([]);
    else {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ paralegalId: id(para._id), applicationId: id(applicationId), status, coverLetter: 'Canonical saved letter', appliedAt: '2026-01-01T00:00:00.000Z', starred: actor.role === 'attorney' });
    }
  }
  const inventory = await read('application-inventory'); expect(inventory.status).toBe(200); expect(inventory.body.counts[status]).toBe(1); expect(inventory.body.total).toBe(1);
  const own = await get('/api/applications/my', para); expect(own.status).toBe(200); expect(own.body[0].status).toBe(status);
  expect(await stored()).toEqual(before);
});

test.each(['object', 'string_primary', 'earlier_only', 'reverse_link', 'uppercase_owners', 'lowercase_owners'])('%s records produce the same actionable count on every legacy/admin list', async kind => {
  if (kind === 'string_primary') { const record = await Application.collection.findOne({ _id: applicationId }); await Application.collection.deleteOne({ _id: applicationId }); await Application.collection.insertOne({ ...record, _id: upper(applicationId), jobId: upper(jobId), paralegalId: upper(para._id) }); }
  if (kind.endsWith('_owners')) { const ref = kind === 'uppercase_owners' ? upper : id; await Case.collection.updateOne({ _id: caseId }, { $set: { attorney: ref(owner._id), attorneyId: ref(owner._id) } }); }
  if (kind === 'earlier_only') await Application.collection.deleteMany({});
  if (kind === 'reverse_link') await Case.collection.updateOne({ _id: caseId }, { $unset: { jobId: '' } });
  const before = await stored(); const values = await summaries(); expect(values).toEqual(values.map(value => ({ ...value, count: 1 })));
  expect((await get('/api/applications/my-postings')).body).toHaveLength(1); await expectInventory(1); expect(await stored()).toEqual(before);
});

test.each(['rejected', 'withdrawn', 'canonical_only', 'assigned', 'funded', 'posting_closed', 'blocked'])('%s canonical outcome and context determine actionable counts without repairing stored mirrors', async kind => {
  if (['rejected', 'withdrawn'].includes(kind)) await Application.collection.updateOne({ _id: applicationId }, { $set: { status: kind } });
  if (kind === 'canonical_only') await Case.collection.updateOne({ _id: caseId }, { $set: { applicants: [] } });
  if (kind === 'assigned') await Case.collection.updateOne({ _id: caseId }, { $set: { paralegal: para._id } });
  if (kind === 'funded') await Case.collection.updateOne({ _id: caseId }, { $set: { escrowStatus: 'funded' } });
  if (kind === 'posting_closed') await Job.collection.updateOne({ _id: jobId }, { $set: { status: 'closed' } });
  if (kind === 'blocked') await require('../models/Block').collection.insertOne({ blockerId: owner._id, blockedId: para._id, active: true });
  const before = await stored(), expected = kind === 'canonical_only' ? 1 : 0;
  const values = await summaries(); expect(values).toEqual(values.map(value => ({ ...value, count: expected })));
  expect((await get('/api/applications/my-postings')).body).toHaveLength(expected); await expectInventory(expected); expect(await stored()).toEqual(before);
});

test.each(['duplicate_person', 'duplicate_primary', 'wrong_posting_owner'])('%s is unavailable through old readers and list counts without disclosing arbitrary application evidence', async kind => {
  if (kind === 'wrong_posting_owner') await Job.collection.updateOne({ _id: jobId }, { $set: { attorneyId: other._id } });
  else { const record = await Application.collection.findOne({ _id: applicationId }); await Application.collection.insertOne({ ...record, _id: kind === 'duplicate_primary' ? upper(applicationId) : new mongoose.Types.ObjectId(), jobId: upper(jobId), coverLetter: 'PRIVATE_DUPLICATE' }); }
  const before = await stored();
  for (const actor of [owner, admin]) for (const suffix of ['', '/applicants']) {
    const response = await detail(actor, suffix); expect(response.status).toBe(409); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_DUPLICATE');
  }
  for (const [path, actor] of [['/api/cases/my', owner], ['/api/cases/admin', admin]]) expect((await get(path, actor)).status).toBe(409);
  expect(await stored()).toEqual(before);
});

test('retained rejected applications and unaccepted invitations do not claim applications ready for review', async () => {
  await Application.collection.updateOne({ _id: applicationId }, { $set: { status: 'rejected' } });
  await Case.collection.updateOne({ _id: caseId }, { $set: { 'applicants.0.status': 'rejected', invites: [{ paralegalId: new mongoose.Types.ObjectId(), status: 'pending' }] } });
  const response = await detail(owner); expect(response.status).toBe(200);
  expect(response.body.applicants).toHaveLength(1);
  expect(response.body.matterExperience.header.primaryAction.code).toBe('view_posting');
  expect(response.body.matterExperience.header.attention).toBeNull();
});


test.each(['viewed', 'shortlisted', 'rejected', 'withdrawn'])('%s selected preview agrees with its canonical raw application and retains existing self-access boundaries', async status => {
  await Application.collection.updateOne({ _id: applicationId }, { $set: { jobId: upper(jobId), paralegalId: upper(para._id), status, coverLetter: 'Canonical preview letter' } });
  const before = await stored();
  for (const actor of [owner, para, other, admin]) {
    const response = await get(`/api/cases/${caseId}/applications/${upper(para._id)}/preview`, actor);
    const available = actor === owner && status !== 'withdrawn' || actor === para && !['withdrawn', 'rejected'].includes(status);
    expect({ status: response.status, error: response.status === 401 ? String(response.body?.message || response.body?.msg || response.body?.error || '') : '', authenticationFailures: authenticationFailures.map(value => ({ ...value, expectedActorRole: actor.role })) }).toEqual({ status: available ? 200 : 404, error: '', authenticationFailures: [] });
    if (available) expect(response.body.application).toMatchObject({ id: id(applicationId), candidateId: id(para._id), status, coverLetter: 'Canonical preview letter', submittedAt: '2026-01-01T00:00:00.000Z' });
  }
  expect(await stored()).toEqual(before);
});

test('invitation-only preview remains available without inventing a pending application', async () => {
  await Application.collection.deleteMany({}); await Case.collection.updateOne({ _id: caseId }, { $set: { applicants: [], invites: [{ paralegalId: para._id, status: 'pending', invitedAt: new Date('2026-02-01') }] } });
  for (const actor of [owner, para]) {
    const response = await get(`/api/cases/${caseId}/applications/${para._id}/preview`, actor); expect(response.status).toBe(200);
    expect(response.body.application).toMatchObject({ id: null, source: 'invitation', status: 'pending' });
  }
  await expectInventory(0);
});

test.each(['detail', 'applicants', 'my', 'admin', 'inventory', 'preview'])('%s rejects an application changing during its read instead of returning stale evidence or counts', async surface => {
  const original = Application.collection.find.bind(Application.collection); let changed = false;
  jest.spyOn(Application.collection, 'find').mockImplementation((query, ...args) => {
    const cursor = original(query, ...args), toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async (...values) => {
      const rows = await toArray(...values);
      if (!changed && query.jobId) { changed = true; await Application.collection.updateOne({ _id: applicationId }, { $set: { status: 'withdrawn' } }); }
      return rows;
    };
    return cursor;
  });
  const response = surface === 'detail' ? await detail(owner) : surface === 'applicants' ? await detail(owner, '/applicants') : surface === 'preview' ? await get(`/api/cases/${caseId}/applications/${para._id}/preview`) : surface === 'inventory' ? await get('/api/cases/inventory', owner, { expectedOwnerId: id(owner._id), view: 'applications' }) : await get(`/api/cases/${surface}`, surface === 'admin' ? admin : owner);
  expect(changed).toBe(true); expect(response.status).toBe(409);
  expect(JSON.stringify(response.body)).not.toContain('Preserved letter');
});

test.each(['duplicate_earlier', 'invalid_earlier'])('%s makes list categories unavailable rather than reporting zero applications', async kind => {
  const entry = { paralegalId: kind === 'duplicate_earlier' ? upper(para._id) : 'invalid', status: 'pending' };
  await Case.collection.updateOne({ _id: caseId }, { $push: { applicants: entry } });
  for (const [path, actor, query] of [['/api/cases/my', owner, {}], ['/api/cases/admin', admin, {}], ['/api/cases/inventory', owner, { expectedOwnerId: id(owner._id), view: 'applications' }]]) {
    const response = await get(path, actor, query); expect(response.status).toBe(409);
  }
});

test('251 canonical applications are counted once without a selected-page or embedded-array limit', async () => {
  await Application.collection.insertMany(Array.from({ length: 250 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), jobId: index % 2 ? upper(jobId) : jobId, paralegalId: new mongoose.Types.ObjectId(), status: index % 2 ? 'shortlisted' : 'submitted' })));
  const before = await stored(); const values = await summaries(); expect(values.every(value => value.count === 251)).toBe(true);
  await expectInventory(251); expect(await stored()).toEqual(before);
});


test('another applicant does not expose their count or current identity in a paralegal Matter view', async () => {
  await Application.collection.insertOne({ _id: new mongoose.Types.ObjectId(), jobId, paralegalId: new mongoose.Types.ObjectId(), status: 'submitted', coverLetter: 'PRIVATE_OTHER_LETTER' });
  const response = await detail(para); expect(response.status).toBe(200);
  expect(response.body.applicants).toHaveLength(1); expect(response.body.matterExperience.applications.pendingCount).toBe(1);
  expect(JSON.stringify(response.body)).not.toContain('PRIVATE_OTHER_LETTER');
});
