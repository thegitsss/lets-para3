const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { seedAttorneySupportFixtures } = require('./helpers/attorneySupportFixtures');
const { authCookieFor } = require('./helpers/phase2LifecycleFixture');
const { dateOnlyFromZonedInstant, startOfWeekDateOnly, addCalendarDays } = require('../utils/businessDate');
const Case = require('../models/Case');
const CaseDraft = require('../models/CaseDraft');
const User = require('../models/User');
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../utils/stripe', () => ({ customers: { retrieve: jest.fn() }, paymentMethods: { retrieve: jest.fn() }, sanitizeStripeError: jest.fn((_error, fallback) => fallback) }));
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use('/api/cases', require('../routes/cases'));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
beforeAll(connect); afterAll(closeDatabase); beforeEach(clearDatabase); afterEach(() => jest.restoreAllMocks());
const get = (user, values = {}) => request(app).get('/api/cases/inventory/home').query({ expectedOwnerId: String(user._id), ...values }).set('Cookie', authCookieFor(user));
const stamp = index => new Date(Date.UTC(2026, 7, 1, 0, index));
const owned = (owner, index, extra = {}) => ({ attorney: owner, attorneyId: owner, title: `Matter ${index}`, status: 'open', archived: false, paymentReleased: false, practiceArea: 'Litigation', applicants: [], updatedAt: stamp(index), createdAt: stamp(index), ...extra });

test('Home uses complete shared categories, reaches older attention and pages every weekly deadline without private record payloads', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney, owner = user._id;
  const start = startOfWeekDateOnly(dateOnlyFromZonedInstant(new Date()));
  const docs = Array.from({ length: 106 }, (_, index) => owned(owner, index, {
    ...(index < 7 ? { files: [{ status: 'pending_review', filename: 'PRIVATE_FILENAME' }] } : {}),
    ...(index < 8 ? { deadlineDate: addCalendarDays(start, index % 7) } : {}),
    ...(index === 0 ? { moderationStatus: 'flagged', applicants: [{ status: 'pending', paralegalId: f.ids.assignedParalegal }] } : {}),
    details: 'PRIVATE_DESCRIPTION', internalNotes: { text: 'PRIVATE_NOTE' },
  }));
  await Case.collection.insertMany([...docs,
    ...Array.from({ length: 103 }, (_, index) => owned(owner, 1000 + index, { status: 'completed', archived: true, paymentReleased: true })),
    owned(owner, 3000, { status: 'draft', files: [{ status: 'pending_review' }] }),
  ]);
  await CaseDraft.collection.insertMany(Array.from({ length: 203 }, (_, index) => ({ owner, title: `Private draft ${index}`, updatedAt: stamp(index) })));
  const before = await Case.collection.find({ attorney: owner }).sort({ _id: 1 }).toArray();
  const first = await get(user);
  expect({ status: first.status, error: first.status === 200 ? null : first.body }).toEqual({ status: 200, error: null });
  expect(first.headers['cache-control']).toBe('private, no-store');
  expect(first.body.counts).toEqual({ active: 105, applications: 1, archived: 103, draft: 204 });
  expect(first.body).toMatchObject({ postedCount: 209, attention: { total: 7, pages: 2 }, recent: { total: 106 }, completed: { total: 103 }, week: { total: 8, pages: 3 } });
  expect(first.body.recent.items[0].title).toBe('Matter 105');
  expect(first.body.completed.items[0].title).toBe('Matter 1102');
  expect(JSON.stringify(first.body)).not.toMatch(/PRIVATE_|Private draft|Matter 3000/);
  expect(Buffer.byteLength(JSON.stringify(first.body))).toBeLessThan(16000);
  const inventory = await request(app).get('/api/cases/inventory').query({ expectedOwnerId: String(owner) }).set('Cookie', authCookieFor(user));
  expect(inventory.status).toBe(200); expect(first.body.counts).toEqual(inventory.body.counts);
  const second = await get(user, { attentionPage: '2', deadlinePage: '2' }), third = await get(user, { deadlinePage: '3' });
  expect(second.status).toBe(200); expect(third.status).toBe(200);
  const attention = [...first.body.attention.items, ...second.body.attention.items];
  expect(new Set(attention.map(item => item.id)).size).toBe(7);
  expect(attention.find(item => item.title === 'Matter 0').actions).toEqual(['files', 'moderation']);
  const deadlines = [first, second, third].flatMap(value => value.body.week.items);
  expect(new Set(deadlines.map(item => item.id)).size).toBe(8);
  expect(deadlines.map(item => item.dueDate)).toEqual(deadlines.map(item => item.dueDate).sort());
  const beyond = await get(user, { attentionPage: '99', deadlinePage: '99' });
  expect(beyond.body.attention).toMatchObject({ total: 7, page: 99, items: [] });
  expect(beyond.body.week).toMatchObject({ total: 8, page: 99, items: [] });
  expect(await Case.collection.find({ attorney: owner }).sort({ _id: 1 }).toArray()).toEqual(before);
});

test('Home preserves paid, paused and draft distinctions and does not turn saved drafts into a posted first Matter', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney, owner = user._id;
  await Case.collection.insertMany([owned(owner, 1, { status: 'draft' }), owned(owner, 2, { status: 'draft', archived: true })]);
  await CaseDraft.collection.insertOne({ owner, title: 'Saved draft' });
  let res = await get(user);
  expect(res.status).toBe(200); expect(res.body.postedCount).toBe(0); expect(res.body.recent.items).toEqual([]);
  await Case.collection.insertMany([
    owned(owner, 3, { status: 'disputed', paymentReleased: true, files: [{ status: 'pending_review' }] }),
    owned(owner, 4, { status: 'paused', pausedReason: 'paralegal_withdrew' }),
    owned(owner, 5, { status: 'paused', pausedReason: 'paralegal_withdrew', payoutFinalizedAt: new Date() }),
    owned(owner, 6, { status: 'in_progress', paralegalId: f.ids.assignedParalegal, escrowStatus: 'pending' }),
    owned(owner, 7, { status: 'active', paralegalId: f.ids.assignedParalegal, escrowStatus: 'funded', deadlineDate: '2026-12-15' }),
  ]);
  res = await get(user); expect(res.status).toBe(200);
  expect(res.body.recent.items.find(item => item.title === 'Matter 7').assignedParalegalName).toBe([f.users.assignedParalegal.firstName, f.users.assignedParalegal.lastName].filter(Boolean).join(' '));
  expect(res.body.recent.items.find(item => item.title === 'Matter 7').lastActivityAt).toBe(stamp(7).toISOString());
  expect(res.body.completed.items.map(item => item.title)).toEqual(['Matter 3']);
  expect(res.body.completed.items[0].label).toBe('Disputed');
  expect(res.body.attention.items.map(item => [item.title, item.actions])).toEqual([['Matter 6', ['payment']], ['Matter 4', ['withdrawal']]]);
});

test('Home is owner-bound and role-bound with strict query validation and truthful source-change failure', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  const empty = await get(user); expect(empty.status).toBe(200); expect(empty.body.postedCount).toBe(0);
  expect(JSON.stringify(empty.body)).not.toContain(f.cases.active.title);
  expect((await get(user, { expectedOwnerId: String(f.ids.owner) })).status).toBe(403);
  expect((await get(f.users.assignedParalegal)).status).toBe(403);
  expect((await request(app).get('/api/cases/inventory/home')).status).toBe(401);
  for (const query of [{ attentionPage: '0' }, { deadlinePage: '-1' }, { attentionPage: '1.5' }, { deadlinePage: '1000000' }, { attentionPage: { $ne: '' } }, { attorney: String(f.ids.owner) }]) expect((await get(user, query)).status).toBe(400);
  const inserted = await Case.collection.insertOne(owned(user._id, 1));
  const original = Case.aggregate.bind(Case); let reads = 0;
  jest.spyOn(Case, 'aggregate').mockImplementation((...args) => {
    const aggregate = original(...args), then = aggregate.then.bind(aggregate);
    aggregate.then = (resolve, reject) => then(async value => {
      if (++reads === 1) await Case.collection.updateOne({ _id: inserted.insertedId }, { $set: { title: 'Changed while loading' } });
      return value;
    }).then(resolve, reject);
    return aggregate;
  });
  const changed = await get(user); expect(changed.status).toBe(409); expect(changed.body.code).toBe('HOME_INVENTORY_CHANGED'); expect(changed.body.counts).toBeUndefined();
  jest.restoreAllMocks(); await User.updateOne({ _id: user._id }, { $set: { disabled: true } });
  expect([401, 403]).toContain((await get(user)).status);
});

test('Home readers reject missing counts, stale pages, invalid destinations and conflicting ownership', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  const res = await get(user); expect(res.status).toBe(200);
  const url = pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts/attorney-v2/home-inventory-model.mjs')).href;
  execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'; import { readHomeInventory, readHomeApplications } from ${JSON.stringify(url)};
    const data=${JSON.stringify(res.body)}, owner=${JSON.stringify(String(user._id))};
    assert.equal(readHomeInventory(data,owner).postedCount,0);
    for(const altered of [{...data,ownerId:'a'.repeat(24)},{...data,counts:{}},{...data,postedCount:null},{...data,attention:{...data.attention,total:1}},{...data,week:{...data.week,page:2}}]) assert.throws(()=>readHomeInventory(altered,owner));
    assert.throws(()=>readHomeApplications([{id:'x',caseId:'bad',jobTitle:'Private'}]));
    assert.throws(()=>readHomeApplications([{id:'x',jobTitle:'A'},{id:'x',jobTitle:'B'}]));
    assert.equal(readHomeApplications([{id:'case:'+owner+':'+owner,caseId:owner,jobTitle:'Older Matter'}]).length,1);
  `], { stdio: 'pipe' });
});


test('Recent Matters follows meaningful activity and ignores background saves and read receipts', async () => {
  const f = await seedAttorneySupportFixtures(), user = f.users.emptyAttorney;
  const inserted = await Case.collection.insertMany([owned(user._id, 1, {updatedAt:new Date()}), owned(user._id, 2)]);
  const first = inserted.insertedIds[0], second = inserted.insertedIds[1];
  const messageAt = new Date('2026-08-10T12:00:00Z');
  await require('../models/Message').collection.insertOne({caseId:first, senderRole:'paralegal', type:'text', createdAt:messageAt, updatedAt:new Date(), readBy:[user._id]});
  let res = await get(user);
  expect(res.status).toBe(200);
  expect(res.body.recent.items[0]).toMatchObject({id:String(first), lastActivityAt:messageAt.toISOString()});
  const taskAt = new Date('2026-08-11T12:00:00Z');
  await require('../models/AuditLog').collection.insertOne({targetType:'case', targetId:String(second), actorRole:'attorney', action:'case.task.review', createdAt:taskAt});
  await require('../models/AuditLog').collection.insertOne({targetType:'case', targetId:String(first), actorRole:'attorney', action:'file_viewed', createdAt:new Date()});
  res = await get(user);
  expect(res.body.recent.items[0]).toMatchObject({id:String(second), lastActivityAt:taskAt.toISOString()});
});
