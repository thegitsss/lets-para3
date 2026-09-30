const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
process.env.S3_BUCKET = "synthetic-pre-engagement-tests";
const mockS3Send = jest.fn(async () => ({}));
jest.mock("@aws-sdk/client-s3", () => ({ ...jest.requireActual("@aws-sdk/client-s3"), S3Client: jest.fn(() => ({ send: mockS3Send })) }));
jest.mock("../utils/stripe", () => ({}));
jest.mock("../utils/email", () => jest.fn(async () => ({})));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async (_id, _type, _payload, options = {}) => options.deferDispatch ? async () => {} : ({})) }));
const Case = require("../models/Case"), User = require("../models/User");
const { DeleteObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, para, caseId, originalKey;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, para] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: "Synthetic", lastName: role, email: `${role}@pre-engagement-review.test`, password: "Synthetic123!", role, status: "approved" })));
  caseId = new mongoose.Types.ObjectId(); originalKey = `cases/${caseId}/pre-engagement/123-synthetic-agreement.pdf`;
  await Case.create({ _id: caseId, title: "Synthetic confidentiality review", details: "Synthetic pre-engagement document retention verification.", attorney: owner._id, attorneyId: owner._id, status: "open", totalAmount: 40000, tasks: [{ title: "Prepare agreement" }], applicants: [{ paralegalId: para._id, status: "pending" }], preEngagement: { revision: 2, status: "requested", requestedParalegalId: para._id, requestedBy: owner._id, confidentialityAgreementRequired: true, confidentialityDocument: { key: originalKey, name: "agreement.pdf", mimeType: "application/pdf", size: 20 }, requestedAt: new Date() } });
});
afterEach(() => jest.restoreAllMocks());
function raceWithNewerRequest() {
  const original = Case.findOneAndUpdate.bind(Case);
  jest.spyOn(Case, "findOneAndUpdate").mockImplementationOnce(async (...args) => {
    await Case.collection.updateOne({ _id: caseId }, { $set: { "preEngagement.revision": 3, "preEngagement.conflictsDetails": "A newer request must be preserved." } });
    return original(...args);
  });
}
const send = () => request(app).post(`/api/cases/${caseId}/pre-engagement/${para._id}/request`).set("Cookie", cookie(owner));
test("a conflicting request preserves a confidentiality document reused from the saved request", async () => {
  raceWithNewerRequest();
  const response = await send().send({ confidentialityAgreementRequired: true });
  expect(response.status).toBe(409); expect(response.body.code).toBe("PRE_ENGAGEMENT_CONFLICT");
  expect(mockS3Send).not.toHaveBeenCalled();
  const doc = await Case.findById(caseId).lean(); expect(doc.preEngagement).toMatchObject({ revision: 3, conflictsDetails: "A newer request must be preserved.", confidentialityDocument: { key: originalKey } });
});
test("a conflicting replacement removes only this request's newly uploaded document", async () => {
  raceWithNewerRequest();
  const response = await send().field("confidentialityAgreementRequired", "true").attach("confidentialityFile", Buffer.from("%PDF-1.4\nSynthetic confidentiality agreement\n%%EOF"), { filename: "replacement.pdf", contentType: "application/pdf" });
  expect(response.status).toBe(409);
  const commands = mockS3Send.mock.calls.map(([command]) => command), upload = commands.find(command => command instanceof PutObjectCommand), deletes = commands.filter(command => command instanceof DeleteObjectCommand);
  expect(upload).toBeDefined(); expect(upload.input.Key).not.toBe(originalKey); expect(deletes).toHaveLength(1); expect(deletes[0].input.Key).toBe(upload.input.Key);
  expect((await Case.findById(caseId).lean()).preEngagement.confidentialityDocument.key).toBe(originalKey);
});
test("a successful request can retain its existing confidentiality document without storage deletion", async () => {
  const conflictsDetails = "Review the listed parties.\n\nDisclose any prior work involving the witnesses.";
  const response = await send().send({ confidentialityAgreementRequired: true, conflictsCheckRequired: true, conflictsDetails });
  expect(response.status).toBe(200); expect(response.body.preEngagement.confidentialityDocument.key).toBe(originalKey); expect(mockS3Send).not.toHaveBeenCalled();
  expect((await Case.findById(caseId).lean()).preEngagement.revision).toBe(3);
  expect(response.body.preEngagement.conflictsDetails).toBe(conflictsDetails);
  expect((await Case.findById(caseId).lean()).preEngagement.conflictsDetails).toBe(conflictsDetails);
});
test.each(['agreement', 'conflicts'])('a paralegal cannot submit against the earlier displayed %s requirements', async kind => {
  await Case.collection.updateOne({ _id: caseId }, { $set: { 'preEngagement.revision': 3, ...(kind === 'agreement' ? { 'preEngagement.confidentialityDocument.key': `cases/${caseId}/pre-engagement/replacement.pdf` } : { 'preEngagement.conflictsCheckRequired': true, 'preEngagement.conflictsDetails': 'A newly added opposing party.' }) } });
  const before = await Case.collection.findOne({ _id: caseId });
  const response = await request(app).post(`/api/cases/${caseId}/pre-engagement/respond`).set('Cookie', cookie(para)).field('expectedPreEngagementRevision', '2').field('confidentialityAcknowledged', 'true').field('conflictsResponseType', 'none_known').attach('paralegalConfidentialityFile', Buffer.from('%PDF-1.4\nEarlier signed agreement\n%%EOF'), { filename: 'signed.pdf', contentType: 'application/pdf' });
  expect(response.status).toBe(409); expect(response.body.code).toBe('PRE_ENGAGEMENT_CONFLICT');
  expect(await Case.collection.findOne({ _id: caseId })).toEqual(before);
  expect(mockS3Send).not.toHaveBeenCalled(); expect(require('../utils/notifyUser').notifyUser).not.toHaveBeenCalled();
});
test.each([0, 2])('the displayed paralegal revision %i records one response and rejects an old repeat', async revision => {
  if (revision === 0) await Case.collection.updateOne({ _id: caseId }, { $unset: { 'preEngagement.revision': '' } });
  const respond = () => request(app).post(`/api/cases/${caseId}/pre-engagement/respond`).set('Cookie', cookie(para)).send({ expectedPreEngagementRevision: revision, confidentialityAcknowledged: true });
  const result = await respond(); expect(result.status).toBe(200); expect(result.body.preEngagement).toMatchObject({ revision: revision + 1, status: 'submitted', confidentialityAcknowledged: true });
  expect((await respond()).status).toBe(409); expect(require('../utils/notifyUser').notifyUser).toHaveBeenCalledTimes(1); expect(mockS3Send).not.toHaveBeenCalled();
});
test('an invalid displayed paralegal revision cannot acknowledge the saved agreement', async () => {
  const before = await Case.collection.findOne({ _id: caseId });
  const result = await request(app).post(`/api/cases/${caseId}/pre-engagement/respond`).set('Cookie', cookie(para)).send({ expectedPreEngagementRevision: '2x', confidentialityAcknowledged: true });
  expect(result.status).toBe(400); expect(result.body.code).toBe('PRE_ENGAGEMENT_REVISION_INVALID');
  expect(await Case.collection.findOne({ _id: caseId })).toEqual(before); expect(mockS3Send).not.toHaveBeenCalled();
});
test('a change during a reviewed paralegal upload rejects the response and removes only its new upload', async () => {
  raceWithNewerRequest();
  const result = await request(app).post(`/api/cases/${caseId}/pre-engagement/respond`).set('Cookie', cookie(para)).field('expectedPreEngagementRevision', '2').field('confidentialityAcknowledged', 'true').attach('paralegalConfidentialityFile', Buffer.from('%PDF-1.4\nPrivate signed copy\n%%EOF'), { filename: 'signed.pdf', contentType: 'application/pdf' });
  expect(result.status).toBe(409);
  const commands = mockS3Send.mock.calls.map(([command]) => command), upload = commands.find(command => command instanceof PutObjectCommand), deletions = commands.filter(command => command instanceof DeleteObjectCommand);
  expect(upload).toBeDefined(); expect(deletions).toHaveLength(1); expect(deletions[0].input.Key).toBe(upload.input.Key); expect(deletions[0].input.Key).not.toBe(originalKey);
  expect((await Case.collection.findOne({ _id: caseId })).preEngagement).toMatchObject({ revision: 3, status: 'requested', confidentialityDocument: { key: originalKey }, confidentialityAcknowledged: false });
  expect(require('../utils/notifyUser').notifyUser).not.toHaveBeenCalled();
});
const readReview = (actor = owner, query = `expectedOwnerId=${owner._id}`) => request(app).get(`/api/cases/${caseId}/pre-engagement/review/${para._id}?${query}`).set("Cookie", cookie(actor));
const strictRequest = review => send().send({ confidentialityAgreementRequired: true, expectedOwnerId: String(owner._id), reviewedRevision: review.revision });
const reviewSubmission = (review, action = "request_changes") => request(app).post(`/api/cases/${caseId}/pre-engagement/review`).set("Cookie", cookie(owner)).send({ action, applicantId: String(para._id), expectedOwnerId: String(owner._id), reviewedRevision: review.revision });
test("read review reports exact saved requirements and document metadata without changing the Matter", async () => {
  const before = await Case.collection.findOne({ _id: caseId }), response = await readReview();
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ caseId: String(caseId), ownerId: String(owner._id), applicantId: String(para._id), canRequest: true, canReview: false, selectedRequest: true, request: { revision: 2, status: "requested", documents: [{ key: originalKey, kind: "attorney" }] } });
  expect(await Case.collection.findOne({ _id: caseId })).toEqual(before); expect(mockS3Send).not.toHaveBeenCalled();
});
test("a reviewed request retains its document, advances the hire interlock, and rejects a stale repeat", async () => {
  const read = await readReview(); expect(read.status).toBe(200);
  const response = await strictRequest(read.body); expect(response.status).toBe(200);
  expect(await Case.collection.findOne({ _id: caseId })).toMatchObject({ __v: 1, preEngagement: { revision: 3, confidentialityDocument: { key: originalKey } } });
  expect((await strictRequest(read.body)).status).toBe(409); expect(mockS3Send).not.toHaveBeenCalled();
});
test.each(["tasks", "revision", "applicant", "block", "profile"])("%s changed after display prevents a pre-engagement request", async kind => {
  const read = await readReview(); expect(read.status).toBe(200);
  if (kind === "tasks") await Case.collection.updateOne({ _id: caseId }, { $set: { tasks: [] } });
  if (kind === "revision") await Case.collection.updateOne({ _id: caseId }, { $set: { "preEngagement.revision": 3 } });
  if (kind === "applicant") await Case.collection.updateOne({ _id: caseId }, { $set: { "applicants.0.status": "rejected" } });
  if (kind === "block") await require("../models/Block").collection.insertOne({ blockerId: owner._id, blockedId: para._id, active: true });
  if (kind === "profile") await User.collection.updateOne({ _id: para._id }, { $set: { disabled: true } });
  const before = await Case.collection.findOne({ _id: caseId }), response = await strictRequest(read.body);
  expect([400, 403, 409]).toContain(response.status); expect(await Case.collection.findOne({ _id: caseId })).toEqual(before); expect(mockS3Send).not.toHaveBeenCalled();
});
test("raw revision binding preserves earlier text aliases and unknown fields", async () => {
  await Case.collection.updateOne({ _id: caseId }, { $set: { attorney: String(owner._id), attorneyId: String(owner._id), "applicants.0.paralegalId": String(para._id), "applicants.0.retainedEvidence": "Keep this", retainedMatterField: { private: true } } });
  const read = await readReview(); expect(read.status).toBe(200); expect((await strictRequest(read.body)).status).toBe(200);
  const result = await Case.collection.findOne({ _id: caseId }); expect(result.attorney).toBe(String(owner._id)); expect(result.applicants[0]).toMatchObject({ paralegalId: String(para._id), retainedEvidence: "Keep this" }); expect(result.retainedMatterField).toEqual({ private: true });
});
test("review changes only the submitted response actually shown, preserving disclosure and earlier evidence", async () => {
  await Case.collection.updateOne({ _id: caseId }, { $set: { "preEngagement.status": "submitted", "preEngagement.conflictsDisclosureText": "Synthetic disclosed connection", "preEngagement.retainedEvidence": "Keep response evidence" } });
  const read = await readReview(); expect(read.status).toBe(200); expect(read.body.canReview).toBe(true);
  const response = await reviewSubmission(read.body); expect(response.status).toBe(200);
  expect(await Case.collection.findOne({ _id: caseId })).toMatchObject({ __v: 1, preEngagement: { revision: 3, status: "changes_requested", conflictsDisclosureText: "Synthetic disclosed connection", retainedEvidence: "Keep response evidence" } });
  expect((await reviewSubmission(read.body)).status).toBe(409);
});
test("a replacement submission with the same apparent status cannot receive an earlier approval", async () => {
  await Case.collection.updateOne({ _id: caseId }, { $set: { "preEngagement.status": "submitted" } });
  const read = await readReview(); expect(read.status).toBe(200);
  await Case.collection.updateOne({ _id: caseId }, { $set: { "preEngagement.conflictsDisclosureText": "New response" } });
  const before = await Case.collection.findOne({ _id: caseId }); expect((await reviewSubmission(read.body, "approve")).status).toBe(409); expect(await Case.collection.findOne({ _id: caseId })).toEqual(before);
});
test("request CAS rejects a change after the final review without deleting the reused document", async () => {
  const read = await readReview(); expect(read.status).toBe(200);
  const original = Case.collection.findOneAndUpdate.bind(Case.collection);
  jest.spyOn(Case.collection, "findOneAndUpdate").mockImplementationOnce(async (...args) => {
    await Case.collection.updateOne({ _id: caseId }, { $set: { "preEngagement.revision": 3 } }); return original(...args);
  });
  expect((await strictRequest(read.body)).status).toBe(409); expect(mockS3Send).not.toHaveBeenCalled();
});
test("an account mismatch, stale token, and non-attorney cannot load private pre-engagement review", async () => {
  expect((await readReview(owner, `expectedOwnerId=${para._id}`)).status).toBe(403);
  expect([403, 404]).toContain((await readReview(para)).status);
  await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); expect([401, 403]).toContain((await readReview()).status);
});
test("unsafe document keys are explicit but cannot become download requests", async () => {
  await Case.collection.updateOne({ _id: caseId }, { $set: { "preEngagement.confidentialityDocument.key": `cases/${caseId}/pre-engagement/../private.pdf` } });
  const read = await readReview(); expect(read.status).toBe(200); expect(read.body.request.documents[0].key).toBeNull();
});
test("an incomplete submitted response can be returned for changes but cannot be approved", async () => {
  await Case.collection.updateOne({ _id: caseId }, { $set: { "preEngagement.status": "submitted", "preEngagement.confidentialityAcknowledged": false } });
  const read = await readReview(); expect(read.status).toBe(200); expect(read.body).toMatchObject({ canReview: true, canApprove: false });
  expect((await reviewSubmission(read.body, "approve")).status).toBe(409); expect((await reviewSubmission(read.body)).status).toBe(200);
});
