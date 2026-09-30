const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { seedAttorneySupportFixtures } = require('./helpers/attorneySupportFixtures');
const { authCookieFor } = require('./helpers/phase2LifecycleFixture');
const Case = require('../models/Case');
const User = require('../models/User');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/stripe', () => ({ customers: { retrieve: jest.fn() }, paymentMethods: { retrieve: jest.fn() }, sanitizeStripeError: jest.fn((_error, fallback) => fallback) }));
const app = express();
app.use(cookieParser()); app.use(express.json()); app.use('/api/cases', require('../routes/cases'));
app.use('/api/messages', require('../routes/messages'));
app.use('/api/uploads', require('../routes/uploads'));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
beforeAll(connect); beforeEach(clearDatabase); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
const get = (user, query = {}) => request(app).get('/api/cases/workspace-choices').query({ expectedOwnerId: String(user._id), ...query }).set('Cookie', authCookieFor(user));
const record = (attorney, paralegal, n, extra = {}) => ({ attorney, paralegal, title: `Matter ${String(n).padStart(4, '0')}`, status: 'in progress', archived: false, practiceArea: 'Litigation', details: 'PRIVATE_WORK', internalNotes: { text: 'PRIVATE_NOTES' }, ...extra });

test.each(['attorney', 'paralegal'])('%s can page and search every current Matter without draft, closed or foreign work', async role => {
  const f = await seedAttorneySupportFixtures(), attorney = f.users.emptyAttorney, paralegal = f.users.applicantParalegal;
  const user = role === 'attorney' ? attorney : paralegal; await Case.deleteMany({});
  const rows = Array.from({ length: 303 }, (_, n) => record(attorney._id, paralegal._id, n, n === 0 ? { status: 'disputed' } : n === 1 ? { status: 'paused' } : {}));
  await Case.collection.insertMany([...rows,
    ...['draft', 'COMPLETED', ' closed ', 'cancelled', 'canceled', 'expired', 'archived'].map(status => record(attorney._id, paralegal._id, 999, { title: `HIDDEN ${status}`, status })),
    record(attorney._id, paralegal._id, 999, { title: 'HIDDEN archive', archived: true }),
    record(attorney._id, paralegal._id, 999, { title: 'HIDDEN released', paymentReleased: true }),
    record(f.ids.owner, f.ids.owner, 999, { title: 'HIDDEN foreign', applicants: [{ paralegalId: paralegal._id, status: 'pending' }], pendingParalegalId: paralegal._id }),
  ]);
  const before = await Case.collection.find({}).sort({ _id: 1 }).toArray(), ids = [];
  for (let page = 1; page <= 31; page++) {
    const response = await get(user, { page: String(page) }); expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ownerId: String(user._id), total: 303, page, pages: 31, pageSize: 10 });
    expect(response.headers['cache-control']).toBe('private, no-store');
    ids.push(...response.body.items.map(item => item.id)); expect(JSON.stringify(response.body)).not.toMatch(/HIDDEN|PRIVATE_/);
  }
  expect(new Set(ids).size).toBe(303);
  const oldest = await get(user, { q: 'Matter 0000', selectedId: String(rows[302]._id) });
  expect(oldest.body.items).toEqual([expect.objectContaining({ id: String(rows[0]._id), status: 'disputed' })]);
  expect(oldest.body.selected.id).toBe(String(rows[302]._id));
  expect(await Case.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
});

test('revoked assignment stays hidden from the paralegal while the owner can manage the paused Matter', async () => {
  const f = await seedAttorneySupportFixtures(), attorney = f.users.emptyAttorney, paralegal = f.users.applicantParalegal; await Case.deleteMany({});
  const { insertedId } = await Case.collection.insertOne(record(String(attorney._id).toUpperCase(), String(paralegal._id).toUpperCase(), 1, { paralegalAccessRevokedAt: new Date(), status: 'paused' }));
  const denied = await get(paralegal, { selectedId: String(insertedId) }); expect(denied.body).toMatchObject({ total: 0, items: [], selected: null });
  const owned = await get(attorney, { selectedId: String(insertedId) }); expect(owned.body.total).toBe(1); expect(owned.body.selected.id).toBe(String(insertedId));
});

test('owner, role, query and concurrent-source boundaries remain enforced', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney; await Case.deleteMany({});
  expect((await request(app).get('/api/cases/workspace-choices')).status).toBe(401);
  expect((await get(user, { expectedOwnerId: String(f.ids.owner) })).status).toBe(403);
  for (const query of [{ page: '0' }, { page: '1.5' }, { q: 'x'.repeat(201) }, { q: { $ne: '' } }, { selectedId: '../other' }, { role: 'paralegal' }]) expect((await get(user, query)).status).toBe(400);
  const { insertedId } = await Case.collection.insertOne(record(user._id, f.ids.owner, 1, { title: 'Literal (A) [B] .*' }));
  expect((await get(user, { q: '.*' })).body.total).toBe(1);
  const original = Case.aggregate.bind(Case); let reads = 0;
  jest.spyOn(Case, 'aggregate').mockImplementation((...args) => {
    const aggregate = original(...args), then = aggregate.then.bind(aggregate);
    aggregate.then = (resolve, reject) => then(async value => { if (++reads === 1) await Case.collection.updateOne({ _id: insertedId }, { $set: { archived: true } }); return value; }).then(resolve, reject);
    return aggregate;
  });
  const changed = await get(user); expect(changed.status).toBe(409); expect(changed.body).not.toHaveProperty('items');
  jest.restoreAllMocks(); await User.updateOne({ _id: user._id }, { $set: { disabled: true } }); expect([401, 403]).toContain((await get(user)).status);
});

test.each(['messages', 'uploads/case'])('%s refuses a switched-account write before any message or file operation', async endpoint => {
  const f = await seedAttorneySupportFixtures(), user = f.users.assignedParalegal;
  const Message = require('../models/Message'), CaseFile = require('../models/CaseFile');
  const before = [await Message.countDocuments({}), await CaseFile.countDocuments({})];
  const path = `/api/${endpoint}/${f.caseIds.active}`;
  const changed = await request(app).post(path).set('Cookie', authCookieFor(user)).set('X-LPC-Owner-Id', String(f.ids.owner)).send({ text: 'Do not send under the replacement account.' });
  expect(changed.status).toBe(403); expect(changed.body.code).toBe('ACCOUNT_CHANGED');
  const invalid = await request(app).post(path).set('Cookie', authCookieFor(user)).set('X-LPC-Owner-Id', 'invalid').send({ text: 'Invalid owner.' });
  expect(invalid.status).toBe(400);
  expect([await Message.countDocuments({}), await CaseFile.countDocuments({})]).toEqual(before);
});

test('a matching owner header retains the participant conversation read contract', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.assignedParalegal;
  const response = await request(app).get(`/api/messages/${f.caseIds.active}`).set('Cookie', authCookieFor(user)).set('X-LPC-Owner-Id', String(user._id));
  expect(response.status).toBe(200);
});

test.each(['attorney', 'paralegal'])('%s receives its own persisted retry identifier without exposing it in the other participant feed', async role => {
  const f = await seedAttorneySupportFixtures(), attorney = await User.findById(f.ids.owner), paralegal = f.users.assignedParalegal;
  const user = role === 'attorney' ? attorney : paralegal, other = role === 'attorney' ? paralegal : attorney;
  const clientMessageId = `workspace-${role}-request-0001`, path = `/api/messages/${f.caseIds.active}`;
  const send = text => request(app).post(path).set('Cookie', authCookieFor(user)).set('X-LPC-Owner-Id', String(user._id)).send({ text, clientMessageId });
  const first = await send('Confirm this synthetic message.'); expect(first.status).toBe(201); expect(first.body.message.clientMessageId).toBe(clientMessageId);
  const retry = await send('Confirm this synthetic message.'); expect(retry.status).toBe(200); expect(retry.body).toMatchObject({ idempotent: true, message: { _id: first.body.message._id, clientMessageId } });
  expect((await send('Changed text must not reuse the earlier request.')).status).toBe(409);
  expect((await send('x'.repeat(2001))).status).toBe(400);
  expect((await send(42)).status).toBe(400);
  expect((await request(app).post(path).set('Cookie', authCookieFor(user)).set('X-LPC-Owner-Id', String(user._id))).status).toBe(400);
  const feed = await request(app).get(path).set('Cookie', authCookieFor(other)); expect(feed.status).toBe(200); expect(JSON.stringify(feed.body)).not.toContain(clientMessageId);
  expect(await require('../models/Message').countDocuments({ caseId: f.caseIds.active, senderId: user._id, clientMessageId })).toBe(1);
});
