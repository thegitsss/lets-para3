const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { seedAttorneySupportFixtures } = require('./helpers/attorneySupportFixtures');
const { authCookieFor } = require('./helpers/phase2LifecycleFixture');
const { dateOnlyFromZonedInstant, addCalendarDays } = require('../utils/businessDate');
const Case = require('../models/Case');
const CaseDraft = require('../models/CaseDraft');
const User = require('../models/User');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/stripe', () => ({ customers: { retrieve: jest.fn() }, paymentMethods: { retrieve: jest.fn() }, sanitizeStripeError: jest.fn((_error, fallback) => fallback) }));
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use('/api/cases', require('../routes/cases')); app.use('/api/case-drafts', require('../routes/caseDrafts'));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
beforeAll(connect); afterAll(closeDatabase); beforeEach(clearDatabase); afterEach(() => jest.restoreAllMocks());
const get = (user, values = {}) => request(app).get('/api/cases/inventory').query({ expectedOwnerId: String(user._id || user.id), ...values }).set('Cookie', authCookieFor(user));
const old = (url, user) => request(app).get(url).set('Cookie', authCookieFor(user));
const stamp = index => new Date(Date.UTC(2026, 7, 1, 0, index));
const owned = (owner, index, extra = {}) => ({ attorney: owner, attorneyId: owner, title: `Matter ${String(index).padStart(4, '0')}`, status: 'open', archived: false, paymentReleased: false, practiceArea: 'Litigation', applicants: [], updatedAt: stamp(index), createdAt: stamp(index), ...extra });
const modelUrl = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/attorney-v2/read-model.mjs')).href;
function expectedRecords(data, filters) {
  const program = `import * as m from ${JSON.stringify(modelUrl)};import fs from 'node:fs';const {data,filters}=JSON.parse(fs.readFileSync(0,'utf8'));const all=m.mergeRecords(data.active,data.archived,data.drafts);process.stdout.write(JSON.stringify(m.filterRecords(all,filters).map(m.id)));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', program], { input: JSON.stringify({ data, filters }), encoding: 'utf8' }));
}

// Match one inventory read's existing workspace deadline. A complete inventory
// traverses 7 or 14 distinct pages; its total test budget includes every read.
const PAGING_READ_DEADLINE_MS = 30_000;
for (const [view, total] of [['active', 103], ['archived', 102], ['draft', 203]]) {
test(`complete ${view} paging reaches all ${total} records without writes or duplicate pages`, async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney, owner = user._id;
  await Case.collection.insertMany([
    ...Array.from({ length: 103 }, (_, i) => owned(owner, i)),
    ...Array.from({ length: 102 }, (_, i) => owned(owner, 1000 + i, { status: 'completed', paymentReleased: true, archived: true })),
  ]);
  await CaseDraft.collection.insertMany(Array.from({ length: 203 }, (_, i) => ({ owner, title: `Draft ${i}`, status: 'draft', practiceArea: 'Probate', updatedAt: stamp(i) })));
  const before = await Case.collection.find({ attorney: owner }).sort({ _id: 1 }).toArray();
  const seen = [];
  for (let page = 1; page <= Math.ceil(total / 15); page++) {
    const res = await get(user, { view, page }).timeout({ deadline: PAGING_READ_DEADLINE_MS });
    expect({ status: res.status, body: res.status === 200 ? null : res.body }).toEqual({ status: 200, body: null });
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toMatchObject({ ownerId: String(owner), total, page, pageSize: 15, pages: Math.ceil(total / 15), counts: { active: 103, archived: 102, draft: 203, applications: 0 } });
    expect(res.body.items).toHaveLength(Math.min(15, total - (page - 1) * 15));
    seen.push(...res.body.items.map(item => item.id));
    expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThan(256 * 1024);
  }
  expect(new Set(seen).size).toBe(total);
  expect(await Case.collection.find({ attorney: owner }).sort({ _id: 1 }).toArray()).toEqual(before);
  expect(await CaseDraft.countDocuments({ owner })).toBe(203);
}, (Math.ceil(total / 15) + 1) * PAGING_READ_DEADLINE_MS);
}

test('search filters and stable sorting apply before paging including old records and regex punctuation', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney, owner = user._id;
  const today = dateOnlyFromZonedInstant(new Date());
  const docs = Array.from({ length: 130 }, (_, i) => owned(owner, i));
  docs[0] = owned(owner, 0, { title: 'Older (estate) [NY]', practiceArea: 'Probate', deadlineDate: addCalendarDays(today, 2), paralegalId: f.ids.assignedParalegal });
  await Case.collection.insertMany(docs);
  let res = await get(user, { q: '(estate) [NY]', practice: 'Probate', deadline: '7_days', sort: 'deadline' });
  expect(res.status).toBe(200); expect(res.body.total).toBe(1); expect(res.body.items[0].title).toBe('Older (estate) [NY]');
  expect(res.body.practices).toEqual(['Litigation', 'Probate']);
  res = await get(user, { q: '.*' }); expect(res.status).toBe(200); expect(res.body.total).toBe(0);
  await Case.collection.updateMany({ attorney: owner }, { $set: { updatedAt: stamp(1) } });
  const first = await get(user), second = await get(user, { page: 2 }), repeated = await get(user);
  expect(first.body.items.map(item => item.id)).toEqual(repeated.body.items.map(item => item.id));
  expect(new Set([...first.body.items, ...second.body.items].map(item => item.id)).size).toBe(30);
  res = await get(user, { page: 100 }); expect(res.status).toBe(200); expect(res.body).toMatchObject({ total: 130, page: 100, pages: 9, items: [] });
});

test('category archive date and status projections match existing read contracts including legacy aliases and draft identities', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney, owner = user._id;
  const today = dateOnlyFromZonedInstant(new Date());
  const variants = [
    {}, { status: 'active', paralegalId: f.ids.assignedParalegal }, { status: 'assigned' }, { status: 'awaiting_funding' },
    { status: 'closed' }, { status: 'cancelled' }, { status: 'canceled' }, { status: 'completed' },
    { status: 'disputed', paymentReleased: true }, { status: 'disputed' }, { archived: true },
    { status: 'paused', pausedReason: 'paralegal_withdrew' },
    { status: 'paused', pausedReason: 'paralegal_withdrew', relistRequestedAt: new Date(), payoutFinalizedAt: new Date(), payoutFinalizedType: 'partial_attorney' },
    { status: 'paused', pausedReason: 'paralegal_withdrew', disputeDeadlineAt: new Date(Date.now() + 86400000) },
    { applicants: [{ status: 'pending' }] }, { applicants: [{ status: '' }] }, { applicants: [{ status: 'rejected' }] },
    { applicants: [{ status: 'pending' }], paralegalId: f.ids.assignedParalegal },
    { applicants: [{ status: 'pending' }], paralegalId: new (require('mongoose').Types.ObjectId)() },
    { status: 'draft' }, { status: 'COMPLETED' }, { status: 'Paused', payoutFinalizedAt: new Date(), payoutFinalizedType: 'zero_auto' },
  ];
  await Case.collection.insertMany(variants.map((values, i) => owned(owner, i, { deadlineDate: i % 3 ? addCalendarDays(today, i % 3 - 1) : null, ...values, ...(values.applicants ? { applicants: values.applicants.map(entry => ({ paralegalId: new (require("mongoose").Types.ObjectId)(), ...entry })) } : {}) })));
  await CaseDraft.collection.insertMany([{ owner, title: '', updatedAt: stamp(500), deadline: addCalendarDays(today, 3) }, { owner, title: 'Éstate draft', status: 'draft', updatedAt: stamp(501) }]);
  const [active, archived, drafts] = await Promise.all([old('/api/cases/my?withFiles=true&limit=100', user), old('/api/cases/my?withFiles=true&limit=100&archived=true', user), old('/api/case-drafts?limit=200', user)]);
  const data = { active: active.body, archived: archived.body, drafts: drafts.body.items };
  for (const view of ['active', 'archived', 'draft', 'applications']) for (const sort of ['recent', 'alphabetical', 'status', 'deadline']) {
    const filters = { view, sort, search: '', practice: '', deadline: '', updated: '', archiveStatus: 'all', page: 1 };
    const expected = expectedRecords(data, filters), res = await get(user, { view, sort });
    expect({ view, sort, status: res.status, error: res.status === 200 ? null : res.body }).toEqual({ view, sort, status: 200, error: null });
    expect(res.body.total).toBe(expected.length); expect(res.body.items.map(item => item.id)).toEqual(expected.slice(0, 15));
  }
  for (const archiveStatus of ['completed', 'paused', 'archived']) {
    const filters = { view: 'archived', sort: 'alphabetical', search: '', practice: '', deadline: '', updated: '', archiveStatus, page: 1 };
    const expected = expectedRecords(data, filters), res = await get(user, { view: 'archived', sort: 'alphabetical', archiveStatus });
    expect(res.status).toBe(200); expect(res.body.items.map(item => item.id)).toEqual(expected);
  }
});

test('the inventory is owner-bound role-bound and rejects ambiguous or oversized query values', async () => {
  const f = await seedAttorneySupportFixtures();
  const res = await get(f.users.emptyAttorney); expect(res.status).toBe(200); expect(res.body.total).toBe(0);
  expect(JSON.stringify(res.body)).not.toContain(f.cases.active.title);
  expect((await get(f.users.emptyAttorney, { expectedOwnerId: String(f.ids.owner) })).status).toBe(403);
  expect((await get(f.users.assignedParalegal)).status).toBe(403);
  expect((await request(app).get('/api/cases/inventory')).status).toBe(401);
  for (const query of [{ view: 'all' }, { q: { $ne: '' } }, { q: 'x'.repeat(201) }, { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '1000001' }, { sort: 'unsupported' }, { attorney: String(f.ids.owner) }]) expect((await get(f.users.emptyAttorney, query)).status).toBe(400);
  await User.updateOne({ _id: f.ids.emptyAttorney }, { $set: { disabled: true } });
  expect([401, 403]).toContain((await get(f.users.emptyAttorney)).status);
});

test('legacy string ownership references remain scoped to the exact current owner', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  await Case.collection.insertMany([owned(String(user._id), 1), owned(String(f.ids.owner), 2)]);
  await CaseDraft.collection.insertMany([{ owner: String(user._id), title: 'Legacy owned draft' }, { owner: String(f.ids.owner), title: 'Other private draft' }]);
  const active = await get(user), draft = await get(user, { view: 'draft' });
  expect(active.status).toBe(200); expect(active.body.items.map(item => item.title)).toEqual(['Matter 0001']);
  expect(draft.status).toBe(200); expect(draft.body.items.map(item => item.title)).toEqual(['Legacy owned draft']);
});

test('published source retention never changes draft totals filters or paging and preserves editable revision evidence', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney, owner = user._id;
  await CaseDraft.collection.insertMany([
    ...Array.from({ length: 203 }, (_, i) => ({ owner, title: `Editable ${i}`, practiceArea: 'Probate', updatedAt: stamp(i), status: 'draft' })),
    ...Array.from({ length: 7 }, (_, i) => ({ owner, title: `Published source ${i}`, practiceArea: 'Published only', updatedAt: stamp(1000 + i), publishedCaseId: f.caseIds.active, status: 'draft' })),
  ]);
  const before = await CaseDraft.collection.find({ owner }).sort({ _id: 1 }).toArray();
  const last = await get(user, { view: 'draft', page: 14 });
  expect(last.status).toBe(200); expect(last.body).toMatchObject({ total: 203, pages: 14, counts: { draft: 203 }, practices: ['Probate'] });
  expect(last.body.items).toHaveLength(8);
  expect(last.body.items.every(item => /^[a-f0-9]{64}$/.test(item.revision) && !item.publishedCaseId)).toBe(true);
  const published = await get(user, { view: 'draft', q: 'Published source' });
  expect(published.status).toBe(200); expect(published.body.total).toBe(0); expect(published.body.counts.draft).toBe(203);
  expect(await CaseDraft.collection.find({ owner }).sort({ _id: 1 }).toArray()).toEqual(before);
});

test('publication between inventory selection and hydration returns a conflict without a stale draft action', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  const draft = await CaseDraft.create({ owner: user._id, title: 'Publishing now' });
  const original = CaseDraft.collection.find.bind(CaseDraft.collection);
  jest.spyOn(CaseDraft.collection, 'find').mockImplementationOnce(filter => ({ toArray: async () => {
    await CaseDraft.collection.updateOne({ _id: draft._id }, { $set: { publishedCaseId: f.caseIds.active } });
    return original(filter).toArray();
  } }));
  const result = await get(user, { view: 'draft' });
  expect(result.status).toBe(409); expect(result.body.code).toBe('MATTER_LIST_CHANGED');
  expect(JSON.stringify(result.body)).not.toContain('Publishing now');
});

test('ownership changing after selection yields a conflict without returning the old private row', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  const inserted = await Case.collection.insertOne(owned(user._id, 1, { title: 'Do not return after transfer' }));
  const original = Case.collection.find.bind(Case.collection);
  jest.spyOn(Case.collection, 'find').mockImplementationOnce(filter => ({ toArray: async () => {
    await Case.collection.updateOne({ _id: inserted.insertedId }, { $set: { attorney: f.ids.owner, attorneyId: f.ids.owner } });
    return original(filter).toArray();
  } }));
  const res = await get(user);
  expect(res.status).toBe(409); expect(res.body.code).toBe('MATTER_LIST_CHANGED'); expect(JSON.stringify(res.body)).not.toContain('Do not return after transfer');
});

test('page rows preserve exact money and file counts without copying file contents or storage references into the inventory', async () => {
  const f = await seedAttorneySupportFixtures();
  const [inventory, legacy] = await Promise.all([get(f.users.owner, { q: f.cases.active.title }), old('/api/cases/my?withFiles=true&limit=100', f.users.owner)]);
  expect(inventory.status).toBe(200);
  const row = inventory.body.items.find(item => item.id === String(f.caseIds.active));
  const current = legacy.body.find(item => item.id === row.id);
  expect(row).toMatchObject({ remainingAmount: current.remainingAmount, totalAmount: current.totalAmount, currency: current.currency, filesCount: current.filesCount, paralegal: current.paralegal });
  expect(current.filesCount).toBe(1); expect(row.files).toBeUndefined(); expect(row.downloadUrl).toEqual([]);
});

test('date-only filtering and paralegal-name search preserve old, missing and invalid deadline distinctions', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney, owner = user._id;
  const today = dateOnlyFromZonedInstant(new Date());
  await Case.collection.insertMany([
    owned(owner, 1, { deadline: new Date(addCalendarDays(today, -1) + 'T12:00:00Z'), paralegalId: f.ids.assignedParalegal }),
    owned(owner, 2, { deadlineDate: today, updatedAt: new Date() }),
    owned(owner, 3, { deadlineDate: '2026-02-30' }),
    owned(owner, 4, { deadlineDate: addCalendarDays(today, 8) }),
    owned(owner, 5, { deadlineDate: '', deadline: today }),
  ]);
  for (const [deadline, titles] of [['overdue', ['Matter 0001']], ['7_days', ['Matter 0002', 'Matter 0005']], ['none', ['Matter 0003']]]) {
    const res = await get(user, { deadline, sort: 'alphabetical' }); expect(res.status).toBe(200); expect(res.body.items.map(row => row.title)).toEqual(titles);
  }
  const para = await User.findById(f.ids.assignedParalegal).lean();
  const named = await get(user, { q: `${para.firstName} ${para.lastName}` });
  expect(named.status).toBe(200); expect(named.body.items.map(row => row.title)).toEqual(['Matter 0001']);
  const recent = await get(user, { updated: '7_days' }); expect(recent.status).toBe(200); expect(recent.body.items.map(row => row.title)).toEqual(['Matter 0002']);
});

test('older linked Matters resolve to their actual filtered page without disclosing other owners or bypassing filters', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  const inserted = await Case.collection.insertMany(Array.from({ length: 130 }, (_, i) => owned(user._id, i)));
  const targetId = String(inserted.insertedIds[0]);
  const response = await get(user, { targetId });
  expect({ status: response.status, error: response.status === 200 ? null : response.body }).toEqual({ status: 200, error: null });
  expect(response.body).toMatchObject({ total: 130, page: 9, target: { id: targetId, found: true, page: 9 } });
  expect(response.body.items.some(row => row.id === targetId)).toBe(true);
  const filtered = await get(user, { targetId, q: 'No matching title' });
  expect(filtered.status).toBe(200); expect(filtered.body).toMatchObject({ total: 0, page: 1, items: [], target: { id: targetId, found: false, page: null } });
  const other = await get(user, { targetId: String(f.caseIds.inaccessible) });
  expect(other.status).toBe(200); expect(other.body.target.found).toBe(false); expect(JSON.stringify(other.body.items)).not.toContain(String(f.caseIds.inaccessible));
});

test('reverse sorts invert the complete inventory before pagination', async () => {
  const f=await seedAttorneySupportFixtures(), user=f.users.emptyAttorney;
  await Case.collection.insertMany(Array.from({length:18},(_,i)=>owned(user._id,i,{deadlineDate:`2026-12-${String(i+1).padStart(2,'0')}`})));
  for(const sort of ['alphabetical','recent','deadline','status']) {
    const forward=[], reverse=[];
    for(const page of [1,2]) {
      const a=await get(user,{sort,page}), b=await get(user,{sort:`${sort}_reverse`,page});
      expect(a.status).toBe(200);expect(b.status).toBe(200);
      forward.push(...a.body.items.map(x=>String(x.id||x._id)));reverse.push(...b.body.items.map(x=>String(x.id||x._id)));
    }
    expect(reverse).toEqual([...forward].reverse());
  }
},30000);

test('activity ordering follows meaningful events rather than background saves', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  const inserted = await Case.collection.insertMany([owned(user._id, 1, {updatedAt:new Date()}), owned(user._id, 2)]);
  const first = inserted.insertedIds[0], second = inserted.insertedIds[1];
  const at = new Date('2026-08-10T12:00:00Z');
  await require('../models/Message').collection.insertOne({caseId:second, senderRole:'paralegal', type:'text', createdAt:at, updatedAt:new Date(), readBy:[user._id]});
  await require('../models/AuditLog').collection.insertOne({targetType:'case',targetId:String(first),actorRole:'attorney',action:'file_viewed',createdAt:new Date()});
  const res = await get(user);
  expect(res.status).toBe(200);
  expect(String(res.body.items[0]._id || res.body.items[0].id)).toBe(String(second));
  expect(res.body.items[0].lastActivityAt).toBe(at.toISOString());
  const reverse = await get(user,{sort:'recent_reverse'});
  expect(String(reverse.body.items[0]._id || reverse.body.items[0].id)).toBe(String(first));
});
