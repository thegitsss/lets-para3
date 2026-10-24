const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_invitations";
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async () => ({})) }));
const Case = require("../models/Case"), User = require("../models/User");
const { invitationRecords } = require("../services/matterInvitations");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
let owner, other, para, admin, matter;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@invitations.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved" })));
  matter = await Case.create({ title: "Synthetic invitations", details: "Private Matter details", attorney: owner._id, attorneyId: owner._id, paralegal: para._id, status: "open", totalAmount: 40000, internalNotes: { text: "PRIVATE_NOTE" }, invites: [{ paralegalId: para._id, status: "accepted", invitedAt: new Date("2026-01-01"), respondedAt: new Date("2026-01-02") }] });
});
afterEach(() => jest.restoreAllMocks());
const read = (actor = owner, query = "") => request(app).get(`/api/cases/${matter._id}/invites${query}`).set("Cookie", authCookieFor(actor));
const raw = () => Case.collection.findOne({ _id: matter._id });

const queue = (actor = para, query = {}) => request(app).get('/api/cases/invited-to').query(query).set('Cookie', authCookieFor(actor));
const rawInvitation = (n, values = {}) => ({ _id: new (require('mongoose').Types.ObjectId)(), title: `Received invitation ${n}`, attorney: owner._id, attorneyId: owner._id, status: 'open', archived: false, totalAmount: 80000, currency: 'usd', details: 'Reviewable scope', tasks: [{ title: 'Prepare exhibits' }], updatedAt: new Date(Date.UTC(2026, 0, n + 1)), invites: [{ paralegalId: para._id, status: 'pending', invitedAt: new Date('2026-01-01') }], ...values });

test('more than 200 pending invitations are reachable; unrelated array entries cannot displace them before paging', async () => {
  const pending = Array.from({ length: 211 }, (_, i) => rawInvitation(i));
  const noise = Array.from({ length: 300 }, (_, i) => rawInvitation(i + 500, { invites: [{ paralegalId: para._id, status: 'declined' }, { paralegalId: other._id, status: 'pending' }] }));
  const legacy = rawInvitation(213, { invites: [], pendingParalegalId: para._id, pendingParalegalInvitedAt: null });
  const mixedLegacy = rawInvitation(900, { invites: [{ paralegalId: other._id, status: 'pending' }], pendingParalegalId: para._id });
  await Case.collection.insertMany([...pending, ...noise, legacy, mixedLegacy]);
  const before = await Case.collection.find({}).sort({_id:1}).toArray(), found = [];let cursor, revision;
  do {
    const response = await queue(para, cursor ? { cursor } : {});expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
    const value = response.body;expect(value.ownerId).toBe(String(para._id));expect(value.page.total).toBe(213);expect(value.page.offset).toBe(found.length);expect(value.items.length).toBeLessThanOrEqual(50);
    if (revision) expect(value.revision).toBe(revision);revision = value.revision;cursor = value.page.nextCursor;found.push(...value.items);
  } while (cursor);
  expect(new Set(found.map(item=>item.id)).size).toBe(213);expect(found[0].id).toBe(String(mixedLegacy._id));expect(found.at(-1).id).toBe(String(pending[0]._id));
  expect(found.every(item=>item.invites.length===1 && item.invites[0].paralegalId===String(para._id))).toBe(true);
  expect(JSON.stringify(found)).not.toMatch(/PRIVATE_NOTE|email|password/);
  expect(await Case.collection.find({}).sort({_id:1}).toArray()).toEqual(before);expect(require('../utils/notifyUser').notifyUser).not.toHaveBeenCalled();
});

test('archived and blocked invitations are excluded and accepted responses remain out of the pending queue', async () => {
  await Case.collection.insertMany([rawInvitation(1), rawInvitation(2, { archived: true }), rawInvitation(3, { invites: [{paralegalId:para._id,status:'accepted'}] })]);
  expect((await queue()).body.page.total).toBe(1);
  await require('../models/Block').create({blockerId:para._id,blockedId:owner._id,active:true});expect((await queue()).body.page.total).toBe(0);
});

test('a changed queue invalidates its old cursor rather than skipping or duplicating invitations', async () => {
  await Case.collection.insertMany([rawInvitation(1),rawInvitation(2)]);
  const first=await queue(para,{limit:'1'});expect(first.status).toBe(200);
  await Case.collection.insertOne(rawInvitation(3));
  const next=await queue(para,{cursor:first.body.page.nextCursor,limit:'1'});expect(next.status).toBe(409);expect(next.body.code).toBe('INVITATION_CHANGED');expect(next.body.items).toBeUndefined();
});

test('empty and legacy invitations retain truthful dates and the exact reviewable scope without migration', async () => {
  expect((await queue()).body).toMatchObject({items:[],page:{total:0,hasMore:false,nextCursor:null}});
  const legacy=rawInvitation(1,{invites:[],pendingParalegalId:para._id,pendingParalegalInvitedAt:'invalid',state:'New York',deadlineDate:'2026-09-20',lockedTotalAmount:null});
  await Case.collection.insertOne(legacy);const before=await Case.collection.findOne({_id:legacy._id});
  const response=await queue();expect(response.status).toBe(200);expect(response.body.items[0]).toMatchObject({details:'Reviewable scope',state:'New York',totalAmount:80000,lockedTotalAmount:null,inviteInvitedAt:null,inviteStatus:'pending',deadlineDate:'2026-09-20'});
  expect(response.body.items[0].tasks[0].title).toBe('Prepare exhibits');expect(await Case.collection.findOne({_id:legacy._id})).toEqual(before);
});

test('role account query and conflicting ownership guards withhold the queue', async () => {
  expect((await queue(owner)).status).toBe(403);expect((await queue(para,{expectedOwnerId:String(other._id)})).status).toBe(403);
  for(const query of [{limit:'0'},{limit:'201'},{cursor:'bad'},{unexpected:'field'}])expect((await queue(para,query)).status).toBe(400);
  await Case.collection.insertOne(rawInvitation(1,{attorneyId:other._id}));expect((await queue()).status).toBe(409);
});

test.each(['scope', 'account'])('a %s change during hydration cannot return the previous private invitation', async kind => {
  const invitation=rawInvitation(1);await Case.collection.insertOne(invitation);
  const original=Case.find.bind(Case);let changed=false;
  jest.spyOn(Case,'find').mockImplementation((...args)=>{const query=original(...args),lean=query.lean.bind(query);query.lean=async()=>{const docs=await lean();if(!changed){changed=true;if(kind==='scope')await Case.collection.updateOne({_id:invitation._id},{$set:{details:'New private scope'}});else await User.collection.updateOne({_id:para._id},{$set:{disabled:true}});}return docs;};return query;});
  const response=await queue();expect(response.status).toBe(kind==='scope'?409:403);expect(response.body.items).toBeUndefined();expect(JSON.stringify(response.body)).not.toContain('Reviewable scope');
});
