const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

process.env.S3_BUCKET = process.env.S3_BUCKET || "phase8d-test-bucket";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_phase8d";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";

jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: jest.fn(async () => ({})) }) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));

const User = require("../models/User");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const Notification = require("../models/Notification");
const uploadsRouter = require("../routes/uploads");
const casesRouter = require("../routes/cases");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/uploads", uploadsRouter);
  instance.use("/api/cases", casesRouter);
  instance.use((err, _req, res, _next) => {
    res.status(500).json({ error: err?.message || "Server error" });
  });
  return instance;
})();

function authCookieFor(user) {
  const token = jwt.sign({
    id: String(user._id),
    role: user.role,
    email: user.email,
    status: user.status,
  }, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

async function fixture() {
  const attorney = await User.create({
    firstName: "Jordan",
    lastName: "Lee",
    email: "phase8d.attorney@example.com",
    password: "Password123!",
    role: "attorney",
    status: "approved",
    state: "NY",
  });
  const paralegal = await User.create({
    firstName: "Dana",
    lastName: "Young",
    email: "phase8d.paralegal@example.com",
    password: "Password123!",
    role: "paralegal",
    status: "approved",
    state: "NY",
  });
  const matter = await Case.create({
    title: "Phase 8D Matter",
    details: "Submission lifecycle characterization.",
    status: "in progress",
    attorney: attorney._id,
    attorneyId: attorney._id,
    paralegal: paralegal._id,
    paralegalId: paralegal._id,
    escrowIntentId: "pi_phase8d_funded",
    escrowStatus: "funded",
    totalAmount: 100000,
    currency: "usd",
    tasks: [{ title: "Prepare responses", completed: false }],
  });
  const file = await CaseFile.create({
    caseId: matter._id,
    userId: paralegal._id,
    originalName: "Discovery responses.docx",
    storageKey: `cases/${matter._id}/documents/discovery-responses.docx`,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 2048,
    securityStatus: "not_required",
    securityScanResult: "NOT_REQUIRED",
    uploadedByRole: "paralegal",
    status: "pending_review",
    version: 1,
  });
  return { attorney, paralegal, matter, file };
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

describe("Paralegal V2 submission lifecycle authority", () => {
  test("Home detail follows current CaseFile reviews and excludes attorney references from submission counts", async () => {
    const { attorney, paralegal, matter, file } = await fixture();
    await CaseFile.create({ caseId: matter._id, userId: attorney._id, originalName: "Attorney reference.pdf", storageKey: `cases/${matter._id}/reference.pdf`, uploadedByRole: "attorney", status: "pending_review" });
    const read = () => request(app).get(`/api/cases/${matter._id}`).set("Cookie", authCookieFor(paralegal));
    const before = await read();
    expect(before.status).toBe(200);
    expect(before.body.submissionSummary).toEqual({ totalFiles: 2, awaitingReview: 1, revisions: 0, approved: 0 });
    await request(app).patch(`/api/cases/${matter._id}/files/${file._id}/status`).set("Cookie", authCookieFor(attorney)).send({ status: "attorney_revision", notes: "Correct the dates." }).expect(200);
    const after = await read();
    expect(after.body.submissionSummary).toEqual({ totalFiles: 2, awaitingReview: 0, revisions: 1, approved: 0 });
    expect(after.body.files).toEqual(expect.arrayContaining([expect.objectContaining({ status: "attorney_revision" })]));
    expect(after.body.matterExperience.activity).toEqual(expect.arrayContaining([expect.objectContaining({ code: "file" })]));
    expect(JSON.stringify(after.body.files)).not.toContain("storageKey");
    expect((await Case.findById(matter._id).lean()).files).toHaveLength(0);
  });

  test("replacement Home summaries and history exclude files from before the current assignment", async () => {
    const { attorney, paralegal, matter, file } = await fixture();
    const boundary = new Date("2026-09-01T12:00:00Z");
    await Case.updateOne({ _id: matter._id }, { $set: { withdrawnParalegalId: attorney._id, hiredAt: boundary } });
    await CaseFile.collection.updateOne({ _id: file._id }, { $set: { createdAt: new Date("2026-08-01T12:00:00Z") } });
    await CaseFile.create({ caseId: matter._id, userId: paralegal._id, originalName: "Current assignment.pdf", storageKey: `cases/${matter._id}/current.pdf`, uploadedByRole: "paralegal", status: "pending_review", createdAt: new Date("2026-09-02T12:00:00Z") });
    const response = await request(app).get(`/api/cases/${matter._id}`).set("Cookie", authCookieFor(paralegal));
    expect(response.status).toBe(200);
    expect(response.body.submissionSummary).toEqual({ totalFiles: 1, awaitingReview: 1, revisions: 0, approved: 0 });
    expect(response.body.files).toHaveLength(1);
    expect(JSON.stringify(response.body.files)).not.toContain("Discovery responses");
    expect(JSON.stringify(response.body.matterExperience.activity)).not.toContain("Discovery responses");
  });

  test("an attorney review is reflected in the paralegal-safe file projection", async () => {
    const { attorney, paralegal, matter, file } = await fixture();
    const reviewed = await request(app)
      .patch(`/api/cases/${matter._id}/files/${file._id}/status`)
      .set("Cookie", authCookieFor(attorney))
      .send({ status: "attorney_revision", notes: "Add the signed verification page." });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.file.status).toBe("attorney_revision");

    const projected = await request(app)
      .get(`/api/uploads/case/${matter._id}?presentation=matter`)
      .set("Cookie", authCookieFor(paralegal));
    expect(projected.status).toBe(200);
    expect(projected.body.files).toHaveLength(1);
    expect(projected.body.files[0]).toEqual(expect.objectContaining({
      id: String(file._id),
      status: "attorney_revision",
      revisionNotes: "Add the signed verification page.",
      version: 1,
    }));
    expect(projected.body.files[0].revisionRequestedAt).toBeTruthy();
    expect(projected.body.files[0]).not.toHaveProperty("storageKey");
    expect(projected.body.files[0]).not.toHaveProperty("key");
    expect(projected.body.files[0]).not.toHaveProperty("userId");
  });

  test("a paralegal cannot perform attorney review actions", async () => {
    const { paralegal, matter, file } = await fixture();
    const beforeNotifications = await Notification.countDocuments({ userId: paralegal._id });
    const response = await request(app)
      .patch(`/api/cases/${matter._id}/files/${file._id}/status`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ status: "approved" });
    expect(response.status).toBe(403);
    expect((await CaseFile.findById(file._id).lean()).status).toBe("pending_review");
    expect(await Notification.countDocuments({ userId: paralegal._id })).toBe(beforeNotifications);
  });

  test("revoked Matter access fails closed for submission evidence", async () => {
    const { paralegal, matter } = await fixture();
    await Case.updateOne({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } });
    const response = await request(app)
      .get(`/api/uploads/case/${matter._id}?presentation=matter`)
      .set("Cookie", authCookieFor(paralegal));
    expect(response.status).toBe(403);
    expect(response.body.files).toBeUndefined();
  });
});

test("usability: renamed revision retains its requested file/version without granting approval", async () => {
  const { attorney, paralegal, matter, file } = await fixture();
  const reviewed = await request(app).patch(`/api/cases/${matter._id}/files/${file._id}/status`).set("Cookie", authCookieFor(attorney)).send({ status: "attorney_revision", notes: "Correct the dates" }).expect(200);
  const requestedAt = reviewed.body.file.revisionRequestedAt;
  const upload = () => request(app).post(`/api/uploads/case/${matter._id}?presentation=matter`).set("Cookie", authCookieFor(paralegal))
    .field("clientUploadId", "usability-revision-retry-0001").field("revisionOfFileId", String(file._id)).field("revisionRequestAt", requestedAt)
    .attach("file", Buffer.from("%PDF-1.4\nRevised response"), "renamed-response.pdf");
  const response = await upload();
  expect({ status: response.status, error: response.body.error || response.body.msg }).toEqual({ status: 201, error: undefined });
  expect(response.body.file).toEqual(expect.objectContaining({ revisionOfFileId: String(file._id), revisionOfVersion: 1, version: 2, revisionRequestAt: requestedAt, status: "pending_review", originalName: "renamed-response.pdf" }));
  expect(response.body.file).not.toHaveProperty("storageKey");
  const retry = await upload();
  expect(retry.status).toBe(200);
  expect(retry.body.file.id).toBe(response.body.file.id);
  expect(await CaseFile.countDocuments({ revisionOfFileId: file._id })).toBe(1);
  const followup = await request(app).post(`/api/uploads/case/${matter._id}?presentation=matter`).set("Cookie", authCookieFor(paralegal))
    .field("clientUploadId", "usability-revision-next-0002").field("revisionOfFileId", String(file._id)).field("revisionRequestAt", requestedAt)
    .attach("file", Buffer.from("%PDF-1.4\nFurther revision"), "renamed-response.pdf").expect(201);
  expect(followup.body.file.version).toBe(3);
  expect(followup.body.file.revisionOfFileId).toBe(String(file._id));
  expect((await CaseFile.findById(file._id)).status).toBe("attorney_revision");
  const unchanged = await Case.findById(matter._id);
  expect(unchanged.tasks[0].completed).toBe(false);
  expect(unchanged.paymentReleased).toBe(false);
});

test("usability: revision reference rejects other Matters, stale requests and prior assignments", async () => {
  const { paralegal, matter, file } = await fixture();
  const requestedAt = new Date("2026-09-01T12:00:00Z");
  await CaseFile.updateOne({ _id: file._id }, { $set: { status: "attorney_revision", revisionRequestedAt: requestedAt } });
  const upload = (target, at) => request(app).post(`/api/uploads/case/${matter._id}?presentation=matter`).set("Cookie", authCookieFor(paralegal))
    .field("revisionOfFileId", String(target)).field("revisionRequestAt", at).attach("file", Buffer.from("%PDF-1.4\nrevision"), "revision.pdf");
  const foreignFile = await CaseFile.create({ caseId: "64b000000000000000009999", userId: paralegal._id, originalName: "Other Matter.pdf", storageKey: "cases/other/request.pdf", uploadedByRole: "paralegal", status: "attorney_revision", revisionRequestedAt: requestedAt });
  await upload(foreignFile._id, requestedAt.toISOString()).expect(409);
  await upload(file._id, "2026-08-01T12:00:00.000Z").expect(409);
  await Case.updateOne({ _id: matter._id }, { $set: { withdrawnParalegalId: paralegal._id, hiredAt: new Date("2026-09-02T12:00:00Z") } });
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { createdAt: new Date("2026-08-01T12:00:00Z") } });
  await upload(file._id, requestedAt.toISOString()).expect(409);
  expect(await CaseFile.countDocuments({ revisionOfFileId: file._id })).toBe(0);
});

test("usability: pending invitation includes reviewable scope with an unlocked compensation amount", async () => {
  const { attorney, paralegal } = await fixture();
  const invitation = await Case.create({ title: "Reviewable invitation", details: "The complete invitation scope.", briefSummary: "Short summary", attorney: attorney._id, attorneyId: attorney._id, state: "New York", practiceArea: "Civil Litigation", minimumYearsExperience: 5, tasks: [{ title: "Verify the exhibits" }], totalAmount: 80000, lockedTotalAmount: null, deadlineDate: "2026-09-20", invites: [{ paralegalId: paralegal._id, status: "pending", invitedAt: new Date() }] });
  const response = await request(app).get('/api/cases/invited-to').set('Cookie', authCookieFor(paralegal)).expect(200);
  const item = response.body.items.find(item => item.id === String(invitation._id));
  expect(item).toEqual(expect.objectContaining({ details: "The complete invitation scope.", state: "New York", minimumYearsExperience: 5, totalAmount: 80000, lockedTotalAmount: null, deadlineDate: "2026-09-20" }));
  expect(item.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Verify the exhibits" })]));
  expect(item.attorney.id).toBe(String(attorney._id));
  const unchanged = await Case.findById(invitation._id);
  expect(unchanged.invites[0].status).toBe("pending");
  expect(unchanged.paralegal).toBeFalsy();
});

async function requestRevision({ attorney, matter }, file, notes = 'Please revise this version.') {
  return (await request(app).patch(`/api/cases/${matter._id}/files/${file._id}/status`).set('Cookie', authCookieFor(attorney)).send({ status: 'attorney_revision', notes }).expect(200)).body.file;
}
async function respondToRevision({ paralegal, matter }, source, name) {
  return (await request(app).post(`/api/uploads/case/${matter._id}?presentation=matter`).set('Cookie', authCookieFor(paralegal))
    .field('revisionOfFileId', String(source.id)).field('revisionRequestAt', source.revisionRequestedAt || '')
    .attach('file', Buffer.from('%PDF-1.4\nRevised work'), name).expect(201)).body.file;
}

test('follow-up: approval resolves the linked revision in Home and Files without approving the original work', async () => {
  const f = await fixture();
  const source = await requestRevision(f, f.file);
  const revised = await respondToRevision(f, source, 'Revised dates.pdf');
  const readHome = () => request(app).get(`/api/cases/${f.matter._id}`).set('Cookie', authCookieFor(f.paralegal));
  expect((await readHome()).body.submissionSummary.revisions).toBe(1);
  await request(app).patch(`/api/cases/${f.matter._id}/files/${revised.id}/status`).set('Cookie', authCookieFor(f.attorney)).send({ status: 'approved' }).expect(200);
  const home = await readHome();
  expect(home.body.submissionSummary).toMatchObject({ revisions: 0, awaitingReview: 0, approved: 1 });
  const projected = await request(app).get(`/api/uploads/case/${f.matter._id}?presentation=matter`).set('Cookie', authCookieFor(f.paralegal)).expect(200);
  expect(projected.body.files.find(file => file.id === source.id)).toMatchObject({ status: 'attorney_revision', revisionResolution: { approvedFileId: revised.id } });
  expect((await CaseFile.findById(source.id)).status).toBe('attorney_revision');
  const unchanged = await Case.findById(f.matter._id);
  expect(unchanged.tasks[0].completed).toBe(false);
  expect(unchanged.paymentReleased).toBe(false);
  await request(app).post(`/api/uploads/case/${f.matter._id}?presentation=matter`).set('Cookie', authCookieFor(f.paralegal))
    .field('revisionOfFileId', source.id).field('revisionRequestAt', source.revisionRequestedAt)
    .attach('file', Buffer.from('%PDF-1.4\nStale response'), 'Stale response.pdf').expect(409);
  await requestRevision(f, await CaseFile.findById(revised.id), 'A further correction is needed.');
  expect((await readHome()).body.submissionSummary.revisions).toBe(2);
});

test('follow-up: approval resolves a multi-round revision chain but cannot resolve a newer request on an earlier version', async () => {
  const f = await fixture();
  const original = await requestRevision(f, f.file);
  const second = await respondToRevision(f, original, 'Second version.pdf');
  const secondRequest = await requestRevision(f, await CaseFile.findById(second.id));
  const third = await respondToRevision(f, secondRequest, 'Third version.pdf');
  await request(app).patch(`/api/cases/${f.matter._id}/files/${third.id}/status`).set('Cookie', authCookieFor(f.attorney)).send({ status: 'approved' }).expect(200);
  const read = () => request(app).get(`/api/cases/${f.matter._id}`).set('Cookie', authCookieFor(f.paralegal));
  expect((await read()).body.submissionSummary.revisions).toBe(0);
  const laterRequest = new Date(new Date(original.revisionRequestedAt).getTime() + 1000);
  await CaseFile.updateOne({ _id: original.id }, { $set: { revisionRequestedAt: laterRequest, revisionNotes: 'New instructions for the original.' } });
  expect((await read()).body.submissionSummary.revisions).toBe(1);
});
