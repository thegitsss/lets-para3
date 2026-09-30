const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { randomUUID } = require("crypto");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
const { clearDatabase } = require("./helpers/db");
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_postings";
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const Case = require("../models/Case");
const Job = require("../models/Job");
const CaseDraft = require("../models/CaseDraft");
const MatterPublication = require("../models/MatterPublication");
const Application = require("../models/Application");
const User = require("../models/User");
const app = express(); app.use(cookieParser()); app.use(express.json());
app.use("/api/case-drafts", require("../routes/caseDrafts"));
app.use("/api/cases", require("../routes/cases"));
let mongo, owner, other, para;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } });
  await mongoose.connect(mongo.getUri("matter-postings-tests"));
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 60000);
beforeEach(async () => {
  await clearDatabase();
  [owner, other, para] = await User.create(["owner", "other", "para"].map((name) => ({ firstName: "Synthetic", lastName: name, email: `${name}@posting.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
const fields = { title: "Synthetic contract posting", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "First paragraph.\n\nSecond paragraph.", tasks: [{ title: "Prepare contract" }] };
const call = (method, path, data, user = owner) => request(app)[method](path).set("Cookie", authCookieFor(user)).send(data);
const posting = (method, path, data, user = owner) => call(method, `/api/cases/posting${path}`, method === "get" ? undefined : { ...data, expectedOwnerId: String(user._id) }, user);
const draft = async (changes = {}) => (await call("post", "/api/case-drafts", { ...fields, ...changes })).body.draft;
const review = (value) => ({ requestId: randomUUID(), draftId: value.id, revision: value.revision, practiceArea: "contract law" });
async function publish() {
  const source = await draft(), body = review(source), response = await posting("post", "/publications", body);
  expect(response.status).toBe(201);
  return { source, body, receipt: response.body.publication, current: (await posting("get", `/${response.body.publication.caseId}`)).body.posting };
}

async function retainedDraft(extra = {}) {
  const doc = { _id: new mongoose.Types.ObjectId(), attorney: owner._id, attorneyId: owner._id, status: 'draft', currency: 'usd', title: fields.title,
    practiceArea: fields.practiceArea, state: fields.state, totalAmount: 40001, experiencePreference: fields.experience,
    deadlineDate: fields.deadline, details: fields.description, tasks: [{ _id: new mongoose.Types.ObjectId(), title: fields.tasks[0].title, completed: false, retainedFlag: 'keep' }],
    updates: [{ date: new Date('2026-01-01'), text: 'Earlier private draft', by: owner._id }], legacyRoot: { retained: true }, ...extra };
  await Case.collection.insertOne(doc);
  return { doc, current: (await posting('get', `/${doc._id}?source=case`)).body.posting };
}
const retainedReview = current => ({ requestId: randomUUID(), draftId: current.id, revision: current.revision, practiceArea: 'contract law', source: 'case' });

test('retained drafts save privately and publish the same Case with its raw metadata and long description', async () => {
  const { doc, current } = await retainedDraft({ details: 'Long retained paragraph.\n\n'.repeat(300) });
  expect(current.isDraft).toBe(true); expect(current.permissions.canEdit).toBe(true); expect(current.values.description).toBe(doc.details);
  const saved = await posting('patch', `/${doc._id}`, { revision: current.revision, changes: { title: 'Continued draft' } });
  expect(saved.status).toBe(200); expect(await Job.countDocuments()).toBe(0);
  const body = retainedReview(saved.body.posting), result = await posting('post', '/publications', body);
  expect(result.status).toBe(201); expect(result.body.publication.caseId).toBe(String(doc._id));
  const raw = await Case.collection.findOne({ _id: doc._id });
  expect(raw).toMatchObject({ status: 'open', title: 'Continued draft', details: doc.details, legacyRoot: doc.legacyRoot });
  expect(raw.tasks).toEqual(doc.tasks); expect(raw.updates[0]).toEqual(doc.updates[0]);
  expect(await Case.countDocuments()).toBe(1); expect(await Job.countDocuments()).toBe(1); expect(await CaseDraft.countDocuments()).toBe(0);
  expect((await posting('get', `/drafts/${doc._id}?source=case`)).body.publication).toEqual(result.body.publication);
  expect((await posting('post', `/publications/${body.requestId}/cleanup`, {})).body.ok).toBe(true);
  expect((await posting('post', '/publications', body)).body.publication).toEqual(result.body.publication);
  expect(await Case.countDocuments()).toBe(1);
});

test('retained partial saves allow incomplete fields while publication requires completed fields', async () => {
  const { doc, current } = await retainedDraft();
  const saved = await posting('patch', `/${doc._id}`, { revision: current.revision, changes: { title: '', description: '', compAmount: '', tasks: [], practiceArea: 'Private unsorted label' } });
  expect(saved.status).toBe(200); expect(saved.body.posting.values).toMatchObject({ title: '', description: '', compAmount: '', tasks: [], practiceArea: 'Private unsorted label' });
  expect((await posting('post', '/publications', retainedReview(saved.body.posting))).status).toBe(400);
  expect((await Case.findById(doc._id)).status).toBe('draft'); expect(await Job.countDocuments()).toBe(0);
});

test('retained publication preserves a single existing private Job link and rejects conflicting public history', async () => {
  const jobId = new mongoose.Types.ObjectId(); const { doc, current } = await retainedDraft({ jobId });
  expect(current).toBeUndefined();
  await Job.collection.insertOne({ _id: jobId, caseId: doc._id, attorneyId: owner._id, status: 'draft', legacyJob: 'keep' });
  const loaded = (await posting('get', `/${doc._id}?source=case`)).body.posting;
  expect((await posting('post', '/publications', retainedReview(loaded))).status).toBe(201);
  const job = await Job.collection.findOne({ _id: jobId }); expect(job).toMatchObject({ status: 'open', legacyJob: 'keep', caseId: doc._id });
  expect(await Job.countDocuments()).toBe(1);
});

test('retained publication rollback and concurrent edits keep the original identity without partial publication', async () => {
  const { doc, current } = await retainedDraft(), body = retainedReview(current);
  jest.spyOn(Job, 'create').mockRejectedValueOnce(new Error('synthetic retained Job failure'));
  expect((await posting('post', '/publications', body)).status).toBe(503);
  expect((await Case.findById(doc._id)).status).toBe('draft'); expect(await MatterPublication.countDocuments()).toBe(0);
  const results = await Promise.all([posting('post', '/publications', body), posting('patch', `/${doc._id}`, { revision: current.revision, changes: { title: 'Concurrent edit' } })]);
  expect(results.filter(result => result.status < 300)).toHaveLength(1); expect(results.filter(result => result.status === 409)).toHaveLength(1);
  expect(await Case.countDocuments()).toBe(1);
});

test('retained duplicate publication requests resolve to one Case, Job and durable receipt', async () => {
  const { current } = await retainedDraft(), first = retainedReview(current);
  const results = await Promise.all([first, first, retainedReview(current)].map(body => posting('post', '/publications', body)));
  expect(results.map(result => result.status).sort()).toEqual([200, 200, 201]);
  expect(await Case.countDocuments()).toBe(1); expect(await Job.countDocuments()).toBe(1); expect(await MatterPublication.countDocuments()).toBe(1);
});

test.each([{ paymentIntentId: 'pi_retained' }, { withdrawalHistory: [{}] }, { paralegalId: new mongoose.Types.ObjectId() }, { archived: true }, { readOnly: true }, { lockedTotalAmount: 40000 }, { escrowStatus: 'funded' }, { payoutFinalizedType: 'zero_auto' }, { feeAttorneyAmount: 8800 }, { statusHistory: [{ from: 'open', to: 'draft' }] }])('retained draft history is not editable or publishable: %j', async evidence => {
  const { doc } = await retainedDraft(evidence);
  const ordinary = (await posting('get', `/${doc._id}`)).body.posting;
  const before = await Case.collection.findOne({ _id: doc._id });
  expect((await posting('get', `/${doc._id}?source=case`)).body.code).toBe(evidence.archived ? 'DRAFT_ARCHIVED' : 'DRAFT_RETAINED_REVIEW_REQUIRED');
  expect((await posting('patch', `/${doc._id}`, { revision: ordinary.revision, changes: { title: 'Must not change' } })).status).toBe(409);
  expect((await posting('post', '/publications', retainedReview(ordinary))).status).toBe(409);
  expect(await Case.collection.findOne({ _id: doc._id })).toEqual(before); expect(await Job.countDocuments()).toBe(0);
});

test('separate payment evidence, conflicting owners and draft identity collisions cannot become a new publication', async () => {
  const { doc, current } = await retainedDraft();
  await mongoose.model('PaymentOperation').collection.insertOne({ caseId: doc._id, operationKey: 'retained-payment' });
  expect((await posting('post', '/publications', retainedReview(current))).body.code).toBe('DRAFT_RETAINED_REVIEW_REQUIRED');
  await mongoose.model('PaymentOperation').deleteMany({});
  await Case.collection.updateOne({ _id: doc._id }, { $set: { attorneyId: other._id } });
  expect((await posting('get', `/${doc._id}?source=case`)).status).toBe(409);
  await Case.collection.updateOne({ _id: doc._id }, { $set: { attorneyId: owner._id } });
  await CaseDraft.collection.insertOne({ _id: doc._id, owner: owner._id });
  expect((await posting('get', `/${doc._id}?source=case`)).status).toBe(409);
  expect((await posting('get', `/${doc._id}?source=case`, undefined, other)).status).toBe(404);
});

test('retained deletion removes only a revision-checked private draft and keeps drafts with file history', async () => {
  let value = await retainedDraft();
  expect((await posting('delete', `/${value.doc._id}`, { revision: value.current.revision })).body.ok).toBe(true);
  expect(await Case.countDocuments()).toBe(0);
  value = await retainedDraft({ files: [{ originalName: 'Retained file' }] });
  expect(value.current.permissions.canDelete).toBe(false);
  expect((await posting('delete', `/${value.doc._id}`, { revision: value.current.revision })).status).toBe(409);
  expect(await Case.countDocuments()).toBe(1);
});

test('retained reminder history keeps deletion unavailable after a private save', async () => {
  const { doc } = await retainedDraft();
  await mongoose.model('Event').collection.insertOne({ owner: owner._id, caseId: doc._id, title: 'Retained private reminder' });
  const current = (await posting('get', `/${doc._id}?source=case`)).body.posting;
  expect(current.permissions).toMatchObject({ canEdit: true, canDelete: false });
  const saved = await posting('patch', `/${doc._id}`, { revision: current.revision, changes: { title: 'Continued with reminder' } });
  expect(saved.status).toBe(200); expect(saved.body.posting.permissions.canDelete).toBe(false);
  expect((await posting('delete', `/${doc._id}`, { revision: saved.body.posting.revision })).status).toBe(409);
  expect(await mongoose.model('Event').countDocuments({ caseId: doc._id })).toBe(1);
});

test('an archived retained draft can be restored, continued and published without losing its archive receipt', async () => {
  const { doc } = await retainedDraft({ archived: true });
  expect((await posting('get', `/${doc._id}?source=case`)).body.code).toBe('DRAFT_ARCHIVED');
  const path = `/api/cases/${doc._id}/archive`, archive = (await call('get', path)).body;
  expect((await call('patch', path, { expectedOwnerId: String(owner._id), revision: archive.revision, requestId: randomUUID(), archived: false })).status).toBe(200);
  const restored = await Case.collection.findOne({ _id: doc._id }); expect(restored.status).toBe('draft'); expect(restored.archiveReceipt).toBeTruthy();
  const current = (await posting('get', `/${doc._id}?source=case`)).body.posting; expect(current.permissions.canEdit).toBe(true);
  expect((await posting('post', '/publications', retainedReview(current))).status).toBe(201);
  expect((await Case.collection.findOne({ _id: doc._id })).archiveReceipt).toEqual(restored.archiveReceipt);
});

test('retained published sources do not count as unfinished drafts before or after cleanup', async () => {
  const pending = await draft({ title: 'Still editable' });
  const { source, body, receipt } = await publish();
  const inventory = () => call('get', `/api/cases/inventory?expectedOwnerId=${owner._id}&view=draft`);
  const before = await inventory();
  expect(before.status).toBe(200);
  expect(before.body.counts.draft).toBe(1);
  expect(before.body.items.map(item => item.id)).toEqual([pending.id]);
  const retained = await CaseDraft.findById(source.id).lean();
  expect(String(retained.publishedCaseId)).toBe(receipt.caseId);
  expect(retained.description).toBe(fields.description);
  expect((await posting('get', `/drafts/${source.id}`)).body.publication.caseId).toBe(receipt.caseId);
  expect((await posting('post', `/publications/${body.requestId}/cleanup`, {})).status).toBe(200);
  expect((await inventory()).body.counts.draft).toBe(1);
  expect(await Case.countDocuments()).toBe(1);
  expect(await Job.countDocuments()).toBe(1);
});

test('current deletion rejects a changed account or malformed owner guard without removing the Matter or Job', async () => {
  const { receipt } = await publish(), path = `/api/cases/${receipt.caseId}`;
  for (const expectedOwnerId of [String(other._id), null, { id: String(owner._id) }, [String(owner._id)]]) {
    const result = await call('delete', path, { expectedOwnerId }); expect(result.status).toBe(403); expect(result.body.code).toBe('MATTER_DELETE_ACCOUNT_CHANGED');
    expect(await Case.findById(receipt.caseId)).not.toBeNull(); expect(await Job.countDocuments({ caseId: receipt.caseId })).toBe(1);
  }
  expect((await call('delete', path, { 'expectedOwnerId.foo': String(owner._id) })).status).toBe(400);
  expect((await call('delete', path, { expectedOwnerId: String(owner._id) })).body).toEqual({ ok: true });
  expect(await Case.findById(receipt.caseId)).toBeNull(); expect(await Job.countDocuments({ caseId: receipt.caseId })).toBe(0);
});

test('a matching expected account cannot authorize another attorney to delete the Matter', async () => {
  const { receipt } = await publish();
  const result = await call('delete', `/api/cases/${receipt.caseId}`, { expectedOwnerId: String(other._id) }, other);
  expect([403, 404]).toContain(result.status); expect(await Case.findById(receipt.caseId)).not.toBeNull(); expect(await Job.countDocuments({ caseId: receipt.caseId })).toBe(1);
});

test("publication preserves fields, locks its source and resolves cleanup failure or lost responses", async () => {
  const { source, body, receipt, current } = await publish();
  expect(current.values).toEqual({ ...fields, requirements: [], practiceArea: "contract law" });
  const job = await Job.findOne({ caseId: receipt.caseId }).lean();
  expect(job.budget).toBe(400.01); expect(job.description).toBe(fields.description); expect(job.state).toBe(fields.state);
  expect((await call("put", `/api/case-drafts/${source.id}`, { ...fields, title: "Do not duplicate", revision: source.revision })).body.code).toBe("DRAFT_PUBLISHED");
  expect((await posting("post", "/publications", body)).status).toBe(200);
  expect((await posting("get", `/drafts/${source.id}`)).body.publication).toEqual(receipt);
  expect((await posting("get", `/publications/${body.requestId}`)).body.publication).toEqual(receipt);
  expect((await posting("post", `/publications/${body.requestId}/cleanup`, {})).status).toBe(200);
  expect((await posting("post", `/publications/${body.requestId}/cleanup`, {})).status).toBe(200);
  expect(await CaseDraft.findById(source.id)).toBeNull();
  expect((await posting("post", "/publications", body)).body.publication).toEqual(receipt);
  expect(await Case.countDocuments()).toBe(1); expect(await Job.countDocuments()).toBe(1); expect(await MatterPublication.countDocuments()).toBe(1);
});

test("two tabs and duplicate requests produce exactly one Case and Job", async () => {
  const source = await draft(), first = review(source);
  const results = await Promise.all([first, first, review(source)].map((body) => posting("post", "/publications", body)));
  expect(results.map((result) => result.status).sort()).toEqual([200, 200, 201]);
  expect(new Set(results.map((result) => result.body.publication.caseId)).size).toBe(1);
  expect(await Case.countDocuments()).toBe(1); expect(await Job.countDocuments()).toBe(1);
  expect((await posting("post", "/publications", { ...first, practiceArea: "family law" })).body.code).toBe("PUBLICATION_REQUEST_REUSED");
});

test("an aborted Case/Job transaction leaves no posting or receipt and allows an explicit retry", async () => {
  const source = await draft(), body = review(source);
  const broken = jest.spyOn(Job, "create").mockRejectedValueOnce(new Error("synthetic Job failure"));
  expect((await posting("post", "/publications", body)).status).toBe(503);
  expect(await Case.countDocuments()).toBe(0); expect(await Job.countDocuments()).toBe(0); expect(await MatterPublication.countDocuments()).toBe(0);
  expect((await CaseDraft.findById(source.id)).publishedCaseId).toBeNull(); broken.mockRestore();
  expect((await posting("post", "/publications", body)).status).toBe(201);
});

test("unsupported practice, task overflow and stale draft reviews cannot publish", async () => {
  const source = await draft();
  expect((await posting("post", "/publications", { ...review(source), practiceArea: "not a supported practice" })).status).toBe(400);
  await call("put", `/api/case-drafts/${source.id}`, { ...fields, title: "Changed elsewhere", revision: source.revision });
  expect((await posting("post", "/publications", review(source))).status).toBe(409);
  const many = await draft({ tasks: Array.from({ length: 26 }, (_, i) => ({ title: `Task ${i}` })) });
  expect((await posting("post", "/publications", review(many))).status).toBe(400);
  expect(await Case.countDocuments()).toBe(0); expect((await CaseDraft.findById(many.id)).tasks).toHaveLength(26);
});

test("a draft save racing publication either saves first or locks the published source", async () => {
  const source = await draft();
  const results = await Promise.all([posting("post", "/publications", review(source)), call("put", `/api/case-drafts/${source.id}`, { ...fields, title: "Concurrent draft edit", revision: source.revision })]);
  expect(results.filter((result) => result.status < 300)).toHaveLength(1);
  expect(results.filter((result) => result.status === 409)).toHaveLength(1);
});

test("posted edits preserve cents, paragraphs, untouched legacy fields and task metadata and mirror Job", async () => {
  const { receipt } = await publish(); const caseId = new mongoose.Types.ObjectId(receipt.caseId);
  await Case.collection.updateOne({ _id: caseId }, { $set: { legacyRoot: { retained: true }, "tasks.0.completed": true, "tasks.0.legacyFlag": "retained", details: "Long description.\n\n".repeat(400) } });
  let current = (await posting("get", `/${caseId}`)).body.posting;
  const response = await posting("patch", `/${caseId}`, { revision: current.revision, changes: { title: "Revised title", state: "California", compAmount: "501.23", experience: "5+ years", deadline: "" } });
  expect(response.status).toBe(200); expect(response.body.posting.values.description.length).toBeGreaterThan(4000);
  const raw = await Case.collection.findOne({ _id: caseId });
  expect(raw.legacyRoot).toEqual({ retained: true }); expect(raw.tasks[0]).toMatchObject({ completed: true, legacyFlag: "retained" });
  const job = await Job.findById(raw.jobId).lean(); expect(job).toMatchObject({ budget: 501.23, state: "California", locationState: "California", experiencePreference: "5+ years", minimumYearsExperience: 5, description: raw.details });
  expect(raw.deadline).toBeNull(); expect(raw.deadlineDate).toBe("");
  current = response.body.posting;
  const changedTasks = await posting("patch", `/${caseId}`, { revision: current.revision, changes: { tasks: [...fields.tasks, { title: "New task" }] } });
  expect(changedTasks.status).toBe(200); expect((await Case.collection.findOne({ _id: caseId })).tasks[0].legacyFlag).toBe("retained");
});

test("two posted edits and edit/delete races require a current revision", async () => {
  let { current } = await publish();
  expect((await posting("patch", `/${current.id}`, { changes: { title: "Missing revision" } })).status).toBe(428);
  const edits = await Promise.all(["First", "Second"].map((title) => posting("patch", `/${current.id}`, { revision: current.revision, changes: { title } })));
  expect(edits.map((result) => result.status).sort()).toEqual([200, 409]); current = edits.find((result) => result.status === 200).body.posting;
  const race = await Promise.all([posting("patch", `/${current.id}`, { revision: current.revision, changes: { state: "TX" } }), posting("delete", `/${current.id}`, { revision: current.revision })]);
  expect(race.filter((result) => result.status === 200)).toHaveLength(1); expect([404, 409]).toContain(race.find((result) => result.status !== 200).status);
});

test("failed Job synchronization rolls back the Case edit", async () => {
  const { current } = await publish();
  jest.spyOn(Job, "findOneAndUpdate").mockRejectedValueOnce(new Error("synthetic synchronization failure"));
  expect((await posting("patch", `/${current.id}`, { revision: current.revision, changes: { title: "Must not persist" } })).status).toBe(503);
  expect((await Case.findById(current.id)).title).toBe(fields.title);
});

test("first-application amount lock does not prevent unrelated edits", async () => {
  const { current } = await publish();
  await Case.updateOne({ _id: current.id }, { $set: { lockedTotalAmount: 40001 } });
  const locked = (await posting("get", `/${current.id}`)).body.posting; expect(locked.permissions.amountLocked).toBe(true);
  expect((await posting("patch", `/${current.id}`, { revision: locked.revision, changes: { compAmount: "450.00" } })).body.code).toBe("POSTING_AMOUNT_LOCKED");
  expect((await posting("patch", `/${current.id}`, { revision: locked.revision, changes: { title: "Allowed title" } })).status).toBe(200);
});

test.each([{ hiredAt: new Date() }, { hiringClaimStatus: "claimed" }, { paralegalId: new mongoose.Types.ObjectId() }, { status: "completed" }, { readOnly: true }])("lifecycle changes block posted edits and deletion: %j", async (change) => {
  const { current } = await publish(); await Case.collection.updateOne({ _id: new mongoose.Types.ObjectId(current.id) }, { $set: change });
  const latest = (await posting("get", `/${current.id}`)).body.posting;
  expect(latest.permissions.canEdit).toBe(false); expect(latest.permissions.canDelete).toBe(false);
  expect((await posting("patch", `/${current.id}`, { revision: latest.revision, changes: { title: "Blocked" } })).status).toBe(409);
  expect((await posting("delete", `/${current.id}`, { revision: latest.revision })).status).toBe(409);
});

test.each([{ escrowIntentId: "pi_synthetic" }, { paymentReleased: true }, { payoutFinalizedAt: new Date() }, { disputes: [{ reason: "Synthetic" }] }, { withdrawalHistory: [{ withdrawnParalegalId: new mongoose.Types.ObjectId() }] }])("engagement/financial history is retained: %j", async (change) => {
  const { current } = await publish(); await Case.collection.updateOne({ _id: new mongoose.Types.ObjectId(current.id) }, { $set: change });
  const latest = (await posting("get", `/${current.id}`)).body.posting;
  expect((await posting("delete", `/${current.id}`, { revision: latest.revision })).status).toBe(409); expect(await Case.countDocuments()).toBe(1);
});

test("deletion removes the listing and applications but retains duplicate-publication protection", async () => {
  const { current, receipt, body } = await publish(); const job = await Job.findOne({ caseId: current.id });
  await Application.collection.insertOne({ jobId: job._id, paralegalId: para._id, status: "pending" });
  expect((await posting("delete", `/${current.id}`, { revision: current.revision })).status).toBe(200);
  expect(await Case.countDocuments()).toBe(0); expect(await Job.countDocuments()).toBe(0); expect(await Application.countDocuments()).toBe(0);
  expect((await posting("post", "/publications", body)).body.publication).toEqual({ ...receipt, status: "removed" });
  expect(await Case.countDocuments()).toBe(0);
});

test("owner/role/account boundaries apply to all posting operations", async () => {
  const { current, source, body } = await publish();
  for (const path of [`/${current.id}`, `/drafts/${source.id}`, `/publications/${body.requestId}`]) expect((await posting("get", path, null, other)).status).toBe(404);
  expect((await posting("patch", `/${current.id}`, { revision: current.revision, changes: { title: "Foreign" } }, other)).status).toBe(404);
  expect((await posting("delete", `/${current.id}`, { revision: current.revision }, other)).status).toBe(404);
  expect((await posting("get", "/options", null, para)).status).toBe(403);
  expect((await call("post", "/api/cases/posting/publications", { ...body, expectedOwnerId: String(other._id) })).body.code).toBe("DRAFT_ACCOUNT_CHANGED");
  await User.updateOne({ _id: owner._id }, { $set: { disabled: true } });
  expect([401, 403]).toContain((await posting("get", `/${current.id}`)).status);
});

test("a hiring claim acquired during the edit transaction prevents the edit on retry", async () => {
  const { current } = await publish();
  const original = Case.collection.findOneAndUpdate.bind(Case.collection);
  const spy = jest.spyOn(Case.collection, "findOneAndUpdate").mockImplementationOnce(async (...args) => {
    await Case.collection.updateOne({ _id: new mongoose.Types.ObjectId(current.id) }, { $set: { hiringClaimStatus: "claimed", hiringClaimToken: "synthetic-hire-claim" } });
    return original(...args);
  });
  expect((await posting("patch", `/${current.id}`, { revision: current.revision, changes: { title: "Must lose to hiring" } })).status).toBe(409);
  spy.mockRestore(); expect((await Case.findById(current.id)).title).toBe(fields.title);
});

test("publication fails closed if required unique receipt indexes are unavailable", async () => {
  const source = await draft();
  jest.spyOn(MatterPublication.collection, "listIndexes").mockReturnValueOnce({ toArray: async () => [] });
  expect((await posting("post", "/publications", review(source))).body.code).toBe("POSTING_INDEX_REQUIRED");
  expect(await Case.countDocuments()).toBe(0);
});


test('requirements survive draft publication and synchronized posting edits; stale confirmations are rejected', async () => {
  const requirements=['Clio proficiency','Virginia litigation experience'];
  const source=await draft({requirements});expect(source.requirements).toEqual(requirements);
  const published=await posting('post','/publications',review(source));expect(published.status).toBe(201);
  const caseId=published.body.publication.caseId;
  const matter=await Case.findById(caseId),job=await Job.findOne({caseId});
  expect(matter.requirements).toEqual(requirements);expect(job.requirements).toEqual(requirements);
  const {assertRequirements}=require('../services/matterRequirements');
  await expect(assertRequirements(job,matter,para._id,requirements.map(requirement=>({requirement,meets:true})))).resolves.toHaveLength(2);
  await expect(assertRequirements(job,matter,para._id,[])).rejects.toMatchObject({status:400});
  const current=(await posting('get',`/${caseId}`)).body.posting;
  const changed=await posting('patch',`/${caseId}`,{revision:current.revision,changes:{requirements:['Clio proficiency']}});
  expect(changed.status).toBe(200);expect(changed.body.posting.values.requirements).toEqual(['Clio proficiency']);
  const nextMatter=await Case.findById(caseId),nextJob=await Job.findById(job._id);
  expect(nextMatter.requirements).toEqual(['Clio proficiency']);expect(nextJob.requirements).toEqual(['Clio proficiency']);
  await expect(assertRequirements(nextJob,nextMatter,para._id,requirements.map(requirement=>({requirement,meets:true})))).rejects.toMatchObject({status:400});
});
