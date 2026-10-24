const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { seedAttorneySupportFixtures } = require('./helpers/attorneySupportFixtures');
const { authCookieFor } = require('./helpers/phase2LifecycleFixture');
const Case = require('../models/Case'), User = require('../models/User');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/stripe', () => ({ customers: { retrieve: jest.fn() }, paymentMethods: { retrieve: jest.fn() }, sanitizeStripeError: jest.fn((_error, fallback) => fallback) }));
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api/cases', require('../routes/cases'));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
beforeAll(connect); beforeEach(clearDatabase); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
const get = (user, values = {}) => request(app).get('/api/cases/assigned-choices').query({ expectedOwnerId: String(user._id), ...values }).set('Cookie', authCookieFor(user));
const owned = (owner, n, extra = {}) => ({ paralegal: owner, paralegalId: owner, title: `Assigned Matter ${String(n).padStart(4, '0')}`, status: 'in progress', archived: false, practiceArea: 'Litigation', details: 'PRIVATE_DETAILS', internalNotes: { text: 'PRIVATE_NOTES' }, ...extra });

test('all assigned current Matters can be searched and paged without admitting applications, history or revoked access', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.applicantParalegal; await Case.deleteMany({});
  const rows = Array.from({ length: 303 }, (_, n) => owned(n % 2 ? String(user._id) : user._id, n, { updatedAt: new Date(2026, 0, 1, 0, n), ...(n === 0 ? { status: 'disputed' } : n === 1 ? { status: 'paused' } : {}) }));
  await Case.collection.insertMany(rows);
  await Case.collection.insertMany([
    ...['draft', 'COMPLETED', 'closed', 'cancelled', 'canceled', 'expired', 'archived'].map(status => owned(user._id, 999, { title: `HIDDEN ${status}`, status })),
    owned(user._id, 999, { title: 'HIDDEN archived', archived: true }), owned(user._id, 999, { title: 'HIDDEN released', paymentReleased: true }), owned(user._id, 999, { title: 'HIDDEN revoked', paralegalAccessRevokedAt: new Date() }),
    owned(f.ids.owner, 999, { title: 'HIDDEN application', applicants: [{ paralegalId: user._id, status: 'pending' }] }),
    owned(f.ids.owner, 999, { title: 'HIDDEN invitation', pendingParalegalId: user._id, invites: [{ paralegalId: user._id, status: 'pending' }] }),
    owned(f.ids.owner, 999, { title: 'HIDDEN withdrawn', withdrawnParalegalId: user._id }),
  ]);
  const before = await Case.collection.find({}).sort({ _id: 1 }).toArray(), ids = [];
  for (let page = 1; page <= 31; page++) {
    const res = await get(user, { page: String(page) }); expect(res.status).toBe(200); expect(res.body).toMatchObject({ total: 303, page, pages: 31, pageSize: 10, selected: null });
    expect(res.headers['cache-control']).toBe('private, no-store'); ids.push(...res.body.items.map(item => item.id)); expect(JSON.stringify(res.body)).not.toMatch(/HIDDEN|PRIVATE_/);
  }
  expect(new Set(ids).size).toBe(303);
  const oldest = await get(user, { q: 'Matter 0000' }); expect(oldest.body.total).toBe(1); expect(oldest.body.items[0].status).toBe('disputed');
  expect(await Case.collection.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
});

test('literal search, exact assignment aliases and changing access preserve the participant boundary', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.applicantParalegal; await Case.deleteMany({});
  const { insertedId } = await Case.collection.insertOne(owned(null, 0, { paralegalId: String(user._id).toUpperCase(), title: 'Review (A) [NY] .*' }));
  const res = await get(user, { q: '.*' }); expect(res.status).toBe(200); expect(res.body.total).toBe(1);
  const original = Case.aggregate.bind(Case); let reads = 0;
  jest.spyOn(Case, 'aggregate').mockImplementation((...args) => {
    const aggregate = original(...args), then = aggregate.then.bind(aggregate);
    aggregate.then = (resolve, reject) => then(async value => { if (++reads === 1) await Case.collection.updateOne({ _id: insertedId }, { $set: { paralegalAccessRevokedAt: new Date() } }); return value; }).then(resolve, reject); return aggregate;
  });
  const changed = await get(user); expect(changed.status).toBe(409); expect(changed.body.code).toBe('MATTER_CHOICES_CHANGED'); expect(changed.body.items).toBeUndefined();
  jest.restoreAllMocks(); const revoked = await get(user, { selectedId: String(insertedId) }); expect(revoked.body.total).toBe(0); expect(revoked.body.selected).toBeNull();
  jest.spyOn(Case, 'aggregate').mockImplementation(() => { throw new Error('Synthetic database unavailable'); });
  const unavailable = await get(user); expect(unavailable.status).toBe(500); expect(unavailable.body.total).toBeUndefined();
});

test('signed-in owner, approved role and strict query remain required', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.applicantParalegal;
  expect((await get(user, { expectedOwnerId: String(f.ids.owner) })).status).toBe(403); expect((await get(f.users.emptyAttorney)).status).toBe(403);
  expect((await request(app).get('/api/cases/assigned-choices')).status).toBe(401);
  for (const query of [{ page: '0' }, { page: '1.5' }, { q: 'x'.repeat(201) }, { q: { $ne: '' } }, { selectedId: '../other' }, { paralegal: String(f.ids.owner) }]) expect((await get(user, query)).status).toBe(400);
  await User.updateOne({ _id: user._id }, { $set: { disabled: true } }); expect([401, 403]).toContain((await get(user)).status);
});
