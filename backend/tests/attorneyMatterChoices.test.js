const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { seedAttorneySupportFixtures } = require('./helpers/attorneySupportFixtures');
const { authCookieFor } = require('./helpers/phase2LifecycleFixture');
const Case = require('../models/Case'), CaseDraft = require('../models/CaseDraft'), User = require('../models/User');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/stripe', () => ({ customers: { retrieve: jest.fn() }, paymentMethods: { retrieve: jest.fn() }, sanitizeStripeError: jest.fn((_error, fallback) => fallback) }));
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use('/api/cases', require('../routes/cases')); app.use('/api/checklist', require('../routes/checklist'));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
beforeAll(connect); beforeEach(clearDatabase); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
const get = (user, values = {}) => request(app).get('/api/cases/inventory/choices').query({ expectedOwnerId: String(user._id), ...values }).set('Cookie', authCookieFor(user));
const owned = (owner, n, extra = {}) => ({ attorney: owner, attorneyId: owner, title: `Matter ${String(n).padStart(4, '0')}`, status: 'open', archived: false, practiceArea: 'Litigation', details: 'PRIVATE_DETAILS', internalNotes: { text: 'PRIVATE_NOTES' }, ...extra });

test('search and paging include every current and historical Case beyond former caps while excluding separate drafts and private payloads', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  const rows = Array.from({ length: 303 }, (_, n) => owned(user._id, n, n < 151 ? { status: 'completed', archived: true } : n === 302 ? { status: 'draft' } : {}));
  await Case.collection.insertMany(rows); await CaseDraft.collection.insertMany(Array.from({ length: 203 }, (_, n) => ({ owner: user._id, title: `Unpublished private draft ${n}` })));
  const before = await Case.collection.find({ attorney: user._id }).sort({ _id: 1 }).toArray(), ids = [];
  for (let page = 1; page <= 31; page++) {
    const res = await get(user, { page: String(page) }); expect(res.status).toBe(200); expect(res.body).toMatchObject({ total: 303, page, pages: 31, pageSize: 10, selected: null });
    expect(res.headers['cache-control']).toBe('private, no-store'); expect(res.body.items).toHaveLength(Math.min(10, 303 - (page - 1) * 10));
    ids.push(...res.body.items.map(item => item.id)); expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE_|Unpublished private draft/);
  }
  expect(new Set(ids).size).toBe(303);
  const oldest = await get(user, { q: 'Matter 0000' }); expect(oldest.body.total).toBe(1); expect(oldest.body.items[0]).toMatchObject({ title: 'Matter 0000', archived: true });
  const selected = await get(user, { selectedId: oldest.body.items[0].id, q: 'Matter 0302' });
  expect(selected.body.items[0].status).toBe('draft'); expect(selected.body.selected.title).toBe('Matter 0000');
  expect(await Case.collection.find({ attorney: user._id }).sort({ _id: 1 }).toArray()).toEqual(before);
  const created = await request(app).post('/api/checklist').set('Cookie', authCookieFor(user)).send({ title: 'Private historical planning', caseId: selected.body.selected.id });
  expect(created.status).toBe(201);
  const tasks = await request(app).get('/api/checklist').query({ caseId: selected.body.selected.id }).set('Cookie', authCookieFor(user));
  expect(tasks.body.items).toEqual([expect.objectContaining({ id: created.body.id, caseId: selected.body.selected.id })]);
});

test('literal punctuation, stable title ties, missing selected records and owner aliases remain exact', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  const docs = await Case.collection.insertMany([owned(String(user._id), 1, { title: 'Review (A) [B] .*' }), ...Array.from({ length: 12 }, () => owned(user._id, 2, { title: 'Same title' }))]);
  const literal = await get(user, { q: '.*' }); expect(literal.status).toBe(200); expect(literal.body.total).toBe(1);
  const first = await get(user, { q: 'same title' }), second = await get(user, { q: 'same title', page: '2' }), repeated = await get(user, { q: 'same title' });
  expect(first.body.items.map(item => item.id)).toEqual(repeated.body.items.map(item => item.id)); expect(new Set([...first.body.items, ...second.body.items].map(item => item.id)).size).toBe(12);
  const hidden = await get(user, { selectedId: String(f.caseIds.active) }); expect(hidden.body.selected).toBeNull(); expect(JSON.stringify(hidden.body.items)).not.toContain(f.cases.active.title);
  await Case.collection.deleteOne({ _id: docs.insertedIds[0] });
  const missing = await get(user, { selectedId: String(docs.insertedIds[0]), page: '99' }); expect(missing.body.selected).toBeNull(); expect(missing.body.items).toEqual([]); expect(missing.body.total).toBe(12);
  const unavailable = await request(app).post('/api/checklist').set('Cookie', authCookieFor(user)).send({ title: 'Do not create against a removed Matter', caseId: String(docs.insertedIds[0]) });
  expect(unavailable.status).toBe(404);
});

test('choice requests remain owner-bound, role-bound and strict, and a changing source never becomes a misleading result', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  expect((await get(user, { expectedOwnerId: String(f.ids.owner) })).status).toBe(403);
  expect((await get(f.users.assignedParalegal)).status).toBe(403); expect((await request(app).get('/api/cases/inventory/choices')).status).toBe(401);
  for (const query of [{ page: '0' }, { page: '1.5' }, { q: 'x'.repeat(201) }, { q: { $ne: '' } }, { selectedId: '../other' }, { selectedId: ['a'.repeat(24), 'b'.repeat(24)] }, { attorney: String(f.ids.owner) }]) expect((await get(user, query)).status).toBe(400);
  const { insertedId } = await Case.collection.insertOne(owned(user._id, 1));
  const original = Case.aggregate.bind(Case); let reads = 0;
  jest.spyOn(Case, 'aggregate').mockImplementation((...args) => {
    const aggregate = original(...args), then = aggregate.then.bind(aggregate);
    aggregate.then = (resolve, reject) => then(async value => { if (++reads === 1) await Case.collection.updateOne({ _id: insertedId }, { $set: { title: 'Changed title' } }); return value; }).then(resolve, reject);
    return aggregate;
  });
  const changed = await get(user); expect(changed.status).toBe(409); expect(changed.body.code).toBe('MATTER_CHOICES_CHANGED'); expect(changed.body.items).toBeUndefined();
  jest.restoreAllMocks(); await User.updateOne({ _id: user._id }, { $set: { disabled: true } }); expect([401, 403]).toContain((await get(user)).status);
});

test('picker response validation rejects duplicate IDs, contradictory pages and invalid selected identities', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  await Case.collection.insertOne(owned(user._id, 1)); const res = await get(user); expect(res.status).toBe(200);
  const url = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/attorney-v2/matter-picker.mjs')).href;
  execFileSync(process.execPath, ['--input-type=module', '--eval', `import assert from 'node:assert/strict'; import {readMatterChoices} from ${JSON.stringify(url)};
    const data=${JSON.stringify(res.body)}, owner=${JSON.stringify(String(user._id))}, filters={search:'',page:1,selectedId:''};
    assert.equal(readMatterChoices(data,owner,filters).total,1);
    for(const value of [{...data,ownerId:'a'.repeat(24)},{...data,total:null},{...data,page:2},{...data,items:[data.items[0],data.items[0]],total:2},{...data,selected:data.items[0]},{...data,items:[{...data.items[0],id:'bad'}]}])assert.throws(()=>readMatterChoices(value,owner,filters));
  `], { stdio: 'pipe' });
});
