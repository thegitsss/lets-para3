const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const { randomUUID } = require("crypto");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
const { seedAttorneySupportFixtures } = require("./helpers/attorneySupportFixtures");
const CaseDraft = require("../models/CaseDraft");
const User = require("../models/User");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const app = express(); app.use(cookieParser()); app.use(express.json()); app.use("/api/case-drafts", require("../routes/caseDrafts"));
beforeAll(async () => { await connect(); await CaseDraft.init(); }); beforeEach(clearDatabase); afterAll(closeDatabase);
const call = (method, path, user, data) => request(app)[method](`/api/case-drafts${path}`).set("Cookie", authCookieFor(user)).send(data);
const fields = { title: "Synthetic Matter", practiceArea: "Contract Law", state: "NY", compAmount: "400.01", experience: "3+ years", deadline: "2026-11-01", description: "First paragraph.\n\nSecond paragraph.", tasks: [{ title: "Prepare draft" }] };

test("all draft fields, empty titles and legacy metadata survive revision-checked edits", async () => {
  const f = await seedAttorneySupportFixtures();
  const created = await call("post", "", f.users.owner, fields);
  expect(created.status).toBe(201); expect(created.body.draft).toEqual(expect.objectContaining(fields));
  const id = created.body.draft.id;
  await CaseDraft.collection.updateOne({ _id: new CaseDraft({ _id: id })._id }, { $set: { legacyRoot: { keep: true }, "tasks.0.legacyFlag": "retained" } });
  const current = (await call("get", `/${id}`, f.users.owner)).body.draft;
  const updated = await call("put", `/${id}`, f.users.owner, { ...fields, title: "", revision: current.revision });
  expect(updated.status).toBe(200); expect(updated.body.draft.rawTitle).toBe(""); expect(updated.body.draft.title).toBe("Untitled Matter");
  expect(updated.body.draft.description).toBe(fields.description); expect(updated.body.draft.revision).not.toBe(current.revision);
  const raw = await CaseDraft.collection.findOne({ _id: new CaseDraft({ _id: id })._id });
  expect(raw.legacyRoot).toEqual({ keep: true }); expect(raw.tasks[0].legacyFlag).toBe("retained");
  expect((await call("get", `/${id}`, f.users.owner)).body.draft.revision).toBe(updated.body.draft.revision);
  expect((await call("put", `/${id}`, f.users.owner, fields)).status).toBe(428);
  expect((await call("delete", `/${id}`, f.users.owner)).status).toBe(428);
  expect((await call("delete", `/${id}`, f.users.owner, { revision: current.revision })).status).toBe(409);
});

test("concurrent saves and save/delete races have exactly one winner", async () => {
  const f = await seedAttorneySupportFixtures();
  let draft = (await call("post", "", f.users.owner, fields)).body.draft;
  const saves = await Promise.all(["First edit", "Second edit"].map((title) => call("put", `/${draft.id}`, f.users.owner, { ...fields, title, revision: draft.revision })));
  expect(saves.map((r) => r.status).sort()).toEqual([200, 409]);
  draft = saves.find((r) => r.status === 200).body.draft;
  const race = await Promise.all([call("put", `/${draft.id}`, f.users.owner, { ...fields, revision: draft.revision }), call("delete", `/${draft.id}`, f.users.owner, { revision: draft.revision })]);
  expect(race.filter((r) => r.status === 200)).toHaveLength(1);
  expect([404, 409]).toContain(race.find((r) => r.status !== 200).status);
});

test("creation tokens resolve lost responses without duplicates or overwriting subsequent edits", async () => {
  const f = await seedAttorneySupportFixtures(); const clientRequestId = randomUUID();
  const results = await Promise.all([1, 2].map(() => call("post", "", f.users.owner, { ...fields, clientRequestId })));
  expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
  expect(results[0].body.draft.id).toBe(results[1].body.draft.id); expect(await CaseDraft.countDocuments()).toBe(1);
  const draft = results[0].body.draft;
  const edited = await call("put", `/${draft.id}`, f.users.owner, { ...fields, title: "Subsequent edit", revision: draft.revision });
  expect(edited.status).toBe(200);
  expect((await call("post", "", f.users.owner, { ...fields, clientRequestId })).body.draft.title).toBe("Subsequent edit");
  expect((await call("post", "", f.users.owner, { ...fields, title: "Different retry", clientRequestId })).status).toBe(409);
  expect((await call("get", `/resolve/${clientRequestId}`, f.users.owner)).body.draft.id).toBe(draft.id);
  expect((await call("get", `/resolve/${clientRequestId}`, f.users.oneAttorney)).status).toBe(404);
  expect((await call("get", "/resolve/invalid", f.users.owner)).status).toBe(400);
});

test("draft reads and writes require the approved owning attorney", async () => {
  const f = await seedAttorneySupportFixtures(); const draft = (await call("post", "", f.users.owner, fields)).body.draft;
  for (const method of ["get", "put", "delete"]) expect((await call(method, `/${draft.id}`, f.users.oneAttorney, method === "get" ? undefined : { ...fields, revision: draft.revision })).status).toBe(404);
  expect((await call("post", "", f.users.assignedParalegal, fields)).status).toBe(403);
  await User.updateOne({ _id: f.ids.owner }, { $set: { disabled: true } });
  expect([401, 403]).toContain((await call("put", `/${draft.id}`, f.users.owner, { ...fields, revision: draft.revision })).status);
  expect(await CaseDraft.countDocuments()).toBe(1);
});

test("an account change after client preflight cannot create a draft under the new session", async () => {
  const f = await seedAttorneySupportFixtures(); const clientRequestId = randomUUID();
  const blocked = await call("post", "", f.users.oneAttorney, { ...fields, clientRequestId, expectedOwnerId: String(f.ids.owner) });
  expect(blocked.status).toBe(403); expect(blocked.body.code).toBe("DRAFT_ACCOUNT_CHANGED"); expect(await CaseDraft.countDocuments()).toBe(0);
  const accepted = await call("post", "", f.users.owner, { ...fields, clientRequestId, expectedOwnerId: String(f.ids.owner) });
  expect(accepted.status).toBe(201);
});

test('the original description persists separately from generated scope and survives older-client edits', async () => {
  const f=await seedAttorneySupportFixtures();
  const sourceDescription='Organize 1,200 pages of records.\n\nHighlight gaps in treatment.';
  const created=await call('post','',f.users.owner,{...fields,sourceDescription});
  expect(created.status).toBe(201);expect(created.body.draft.sourceDescription).toBe(sourceDescription);
  const saved=await call('put',`/${created.body.draft.id}`,f.users.owner,{...fields,description:'Structured scope.',revision:created.body.draft.revision});
  expect(saved.status).toBe(200);expect(saved.body.draft.sourceDescription).toBe(sourceDescription);expect(saved.body.draft.description).toBe('Structured scope.');
  const fetched=await call('get',`/${created.body.draft.id}`,f.users.owner);expect(fetched.body.draft.sourceDescription).toBe(sourceDescription);
});
test('creation replay tokens issued before source-description support still resolve without duplication', async () => {
  const f=await seedAttorneySupportFixtures(),clientRequestId=randomUUID();
  const original={...fields,requirements:[],status:'draft'};
  const record=await CaseDraft.create({owner:f.users.owner._id,...original,clientRequestId,creationFingerprint:require('../services/matterDraftRevision').fingerprint(original)});
  const replay=await call('post','',f.users.owner,{...fields,clientRequestId});
  expect(replay.status).toBe(200);expect(replay.body.draft.id).toBe(String(record._id));expect(replay.body.replayed).toBe(true);expect(await CaseDraft.countDocuments()).toBe(1);
});

test('latest notes and last applied notes persist independently through autosave',async()=>{
 const f=await seedAttorneySupportFixtures();const sourceDescription='Prepare a summary. Budget is $750.',appliedSourceDescription='Prepare a summary.';
 const created=await call('post','',f.users.owner,{...fields,sourceDescription,appliedSourceDescription});expect(created.status).toBe(201);
 const current=created.body.draft;expect(current.appliedSourceDescription).toBe(appliedSourceDescription);
 const fetched=await call('get',`/${current.id}`,f.users.owner);expect(fetched.body.draft.sourceDescription).toBe(sourceDescription);expect(fetched.body.draft.appliedSourceDescription).toBe(appliedSourceDescription);
 const updated=await call('put',`/${current.id}`,f.users.owner,{...fields,sourceDescription,appliedSourceDescription:sourceDescription,revision:current.revision});expect(updated.status).toBe(200);expect(updated.body.draft.appliedSourceDescription).toBe(sourceDescription);expect(updated.body.draft.revision).not.toBe(current.revision);
});

test('unfinished requirement text is revision protected and survives older client saves', async () => {
  const f = await seedAttorneySupportFixtures();
  const created = await call('post', '', f.users.owner, {...fields, pendingRequirement:'Virginia litigation experience'});
  expect(created.status).toBe(201);
  let draft=created.body.draft;
  expect(draft.pendingRequirement).toBe('Virginia litigation experience');
  expect(draft.requirements).toEqual([]);
  const legacy=await call('put',`/${draft.id}`,f.users.owner,{...fields,title:'Edited title',revision:draft.revision});
  expect(legacy.status).toBe(200);draft=legacy.body.draft;
  expect(draft.pendingRequirement).toBe('Virginia litigation experience');
  const accepted=await call('put',`/${draft.id}`,f.users.owner,{...fields,requirements:[draft.pendingRequirement],pendingRequirement:'',revision:draft.revision});
  expect(accepted.status).toBe(200);
  const saved=(await call('get',`/${draft.id}`,f.users.owner)).body.draft;
  expect(saved.pendingRequirement).toBe('');expect(saved.requirements).toEqual(['Virginia litigation experience']);
  expect((await call('put',`/${draft.id}`,f.users.owner,{...fields,pendingRequirement:'stale',revision:draft.revision})).status).toBe(409);
});
