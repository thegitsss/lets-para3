process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_document_review";
process.env.S3_BUCKET = "synthetic-document-review";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";
const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../services/lpcEvents/publishEventService", () => ({ publishEventSafe: jest.fn(async () => ({ ok: true })) }));
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), User = require("../models/User");
const account = require("../services/attorneyAccountBoundary"), { decryptCaseFilePayload } = require("../utils/dataEncryption");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases")); app.use("/api/uploads", require("../routes/uploads"));
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, doc, file;
beforeAll(async () => { await connect(); await Promise.all([Case.init(), CaseFile.init(), User.init(), require("../models/AuditLog").init(), require("../models/Notification").init()]); }, 60000);
afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); [owner, other, para] = await User.create(["owner", "other", "para"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@files.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  doc = await Case.create({ attorney: owner._id, attorneyId: owner._id, title: "Lease document review", details: "Review the lease.", practiceArea: "contract law", state: "New York", paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_files", tasks: [{ title: "Review", completed: false }] });
  file = await CaseFile.create({ caseId: doc._id, userId: para._id, originalName: "Lease.txt", storageKey: `cases/${doc._id}/documents/lease.txt`, mimeType: "text/plain", size: 40, uploadedByRole: "paralegal", securityStatus: "not_required" });
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { retainedUnknown: { evidence: "PRESERVE" } } });
});
const read = (query = {}, user = owner) => request(app).get(`/api/cases/${doc._id}/files/review`).query({ expectedOwnerId: String(user._id), ...query }).set("Cookie", cookie(user));
const review = async () => { const result = await read(); expect(result.status).toBe(200); return result.body.files[0]; };
const save = (selected, status = "approved", notes = "", user = owner) => request(app).post(`/api/cases/${doc._id}/files/${selected.id}/review`).set("Cookie", cookie(user)).send({ expectedOwnerId: String(user._id), reviewedRevision: selected.reviewRevision, status, notes });
test("document pages expose safe version/review metadata and exact links past fifty records", async () => {
  const before = await CaseFile.collection.findOne({ _id: file._id });
  await CaseFile.collection.insertMany(Array.from({ length: 55 }, (_, i) => ({ _id: new mongoose.Types.ObjectId(), caseId: i % 2 ? doc._id : String(doc._id), originalName: `Extra ${i}`, storageKey: `cases/${doc._id}/documents/${i}`, version: 1 })));
  const first = await read({ fileId: String(file._id) }); expect(first.status).toBe(200); expect(first.body.files).toHaveLength(50); expect(first.body.selectedFile).toMatchObject({ id: String(file._id), canReview: true, uploadedByRole: "paralegal" }); expect(first.body.files.some(item => item.id === String(file._id))).toBe(false);
  expect(JSON.stringify(first.body)).not.toMatch(/storageKey|userId|retainedUnknown|PRESERVE|documents\//); expect(first.headers["cache-control"]).toBe("private, no-store");
  const next = await read({ cursor: first.body.nextCursor }); expect(next.body.files).toHaveLength(6); expect(new Set([...first.body.files, ...next.body.files].map(item => item.id)).size).toBe(56); expect(next.body.nextCursor).toBeNull(); expect(await CaseFile.collection.findOne({ _id: file._id })).toEqual(before);
  expect((await read({ fileId: String(new mongoose.Types.ObjectId()) })).body.selection).toBe("unavailable"); expect((await read({ cursor: "bad" })).status).toBe(400);
});
test("approval, reopening and revision instructions preserve unknown fields and both existing dashboards' file contract", async () => {
  const before = await Case.collection.findOne({ _id: doc._id }); let selected = await review();
  for (const status of ["approved", "pending_review", "attorney_revision"]) {
    const response = await save(selected, status, status === "attorney_revision" ? "Identify the missing exhibit.\nKeep the original numbering." : ""); expect(response.status).toBe(200); selected = response.body.file; expect(selected.status).toBe(status);
    const stored = decryptCaseFilePayload(await CaseFile.collection.findOne({ _id: file._id })); expect(stored.retainedUnknown).toEqual({ evidence: "PRESERVE" }); expect(stored.status).toBe(status);
    for (const user of [owner, para]) { const current = await request(app).get(`/api/uploads/case/${doc._id}?presentation=matter`).set("Cookie", cookie(user)); expect(current.status).toBe(200); expect(current.body.files[0].status).toBe(status); }
  }
  expect(selected.notes).toContain("original numbering"); expect(selected.requestedAt).not.toBeNull(); const after = await Case.collection.findOne({ _id: doc._id }); expect(after.tasks).toEqual(before.tasks); expect(after.escrowIntentId).toBe(before.escrowIntentId); expect(after.paymentReleased).toBe(before.paymentReleased);
});
test("stale decisions, replacement bytes and changed instructions cannot overwrite the reviewed version", async () => {
  const old = await review(); expect((await save(old, "attorney_revision", "Earlier instructions")).status).toBe(200); expect((await save(old)).status).toBe(409);
  const current = await review(); await CaseFile.collection.updateOne({ _id: file._id }, { $set: { version: 2, storageKey: `cases/${doc._id}/documents/replaced.txt` } }); expect((await save(current)).status).toBe(409); expect((await CaseFile.findById(file._id)).status).toBe("attorney_revision");
});
test.each([{ status: "paused" }, { archived: true }, { readOnly: true }, { escrowStatus: "unfunded" }, { completionClaimStatus: "claimed" }, { completionClaimToken: "claimed" }, { hiringClaimToken: "claimed" }, { paralegalAccessRevokedAt: new Date() }])("Matter restriction %j denies review while preserving authorized reference reads", async patch => {
  await Case.collection.updateOne({ _id: doc._id }, { $set: patch }); const selected = await review(); expect(selected.canReview).toBe(false); expect((await save(selected)).status).toBe(403);
});
test.each(["pending", "blocked", "error"])("%s security status prevents direct approval", async securityStatus => { await CaseFile.collection.updateOne({ _id: file._id }, { $set: { securityStatus } }); const selected = await review(); expect(selected.canReview).toBe(false); expect((await save(selected)).status).toBe(403); });
test("completion, purging and dispute close individual documents without changing archive authority", async () => {
  for (const patch of [{ status: "completed" }, { status: "disputed" }, { status: "in progress", purgedAt: new Date() }]) { await Case.collection.updateOne({ _id: doc._id }, { $set: patch }); const response = await read({ fileId: String(file._id) }); expect(response.status).toBe(200); expect(response.body.files).toEqual([]); expect(response.body.selectedFile).toBeNull(); expect(response.body.canUpload).toBe(false); }
});
test("wrong account, role, owner aliases and account revocation reveal no file metadata", async () => {
  for (const user of [other, para]) expect([403, 404]).toContain((await read({}, user)).status);
  expect((await read({ expectedOwnerId: String(other._id) })).status).toBe(403);
  await Case.collection.updateOne({ _id: doc._id }, { $set: { attorneyId: other._id } });
  const beforeMatter = await Case.collection.findOne({ _id: doc._id }), beforeFile = await CaseFile.collection.findOne({ _id: file._id });
  const conflict = await read();
  expect(conflict.status).toBe(409);
  expect(conflict.body).toEqual({ code: "CASE_IDENTITY_CONFLICT", error: "Matter participant records need review before continuing." });
  expect(await Case.collection.findOne({ _id: doc._id })).toEqual(beforeMatter);
  expect(await CaseFile.collection.findOne({ _id: file._id })).toEqual(beforeFile);
  await Case.collection.updateOne({ _id: doc._id }, { $set: { attorneyId: owner._id } }); await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); expect((await read()).status).toBe(403);
});
test("a lifecycle write winning before the review transaction's Case write prevents approval", async () => {
  const selected = await review(), original = Case.collection.updateOne.bind(Case.collection); let once = false;
  jest.spyOn(Case.collection, "updateOne").mockImplementation(async (filter, change, options) => { if (!once && options?.session) { once = true; await original({ _id: doc._id }, { $set: { status: "paused" } }); } return original(filter, change, options); });
  expect((await save(selected)).status).toBe(409); expect((await CaseFile.findById(file._id)).status).toBe("pending_review"); expect((await Case.findById(doc._id)).status).toBe("paused");
});
test("a replacement winning before the transaction file write rolls back the Case guard", async () => {
  const selected = await review(), original = CaseFile.collection.updateOne.bind(CaseFile.collection); let once = false; const before = await Case.collection.findOne({ _id: doc._id });
  jest.spyOn(CaseFile.collection, "updateOne").mockImplementation(async (filter, change, options) => { if (!once && options?.session) { once = true; await original({ _id: file._id }, { $set: { version: 2, originalName: "Replacement.txt" } }); } return original(filter, change, options); });
  expect((await save(selected)).status).toBe(409); expect((await CaseFile.findById(file._id)).status).toBe("pending_review"); expect(await Case.collection.findOne({ _id: doc._id })).toEqual(before);
});
test("revocation immediately before commit aborts both review writes", async () => {
  const selected = await review(), original = account.read; let calls = 0;
  jest.spyOn(account, "read").mockImplementation(async (...args) => { if (++calls === 3) await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } }); return original(...args); });
  expect((await save(selected)).status).toBe(403); expect((await CaseFile.findById(file._id)).status).toBe("pending_review");
});
test("explicit revision lineage survives review without approving an earlier document", async () => {
  const selected = await review(); const requested = await save(selected, "attorney_revision", "Review exhibit B."); expect(requested.status).toBe(200);
  const revised = await CaseFile.create({ caseId: doc._id, userId: para._id, originalName: "Lease revised.txt", storageKey: `cases/${doc._id}/documents/revised.txt`, mimeType: "text/plain", size: 50, version: 2, uploadedByRole: "paralegal", securityStatus: "not_required", revisionOfFileId: file._id, revisionOfVersion: 1, revisionRequestAt: requested.body.file.requestedAt });
  const current = (await read({ fileId: String(revised._id) })).body.selectedFile; expect(current.revisionOf).toMatchObject({ id: String(file._id), version: 1 }); expect((await save(current)).status).toBe(200); expect((await CaseFile.findById(file._id)).status).toBe("attorney_revision");
  const paraRead = await request(app).get(`/api/uploads/case/${doc._id}?presentation=matter`).set("Cookie", cookie(para)); expect(paraRead.body.files.find(item => String(item.id || item._id) === String(file._id)).revisionResolution.approvedFileId).toBe(String(revised._id));
});

const legacyRead = (user = owner) => request(app).get(`/api/uploads/case/${doc._id}?presentation=matter`).set("Cookie", cookie(user));
test("both attorney screens bind decisions to the same persisted document and freshly verified account", async () => {
  let current = await legacyRead(); expect(current.status).toBe(200); expect(current.headers["cache-control"]).toBe("private, no-store");
  const displayed = current.body.files[0]; expect(displayed.reviewRevision).toBe((await review()).reviewRevision); expect(displayed.reviewOwnerId).toBe(String(owner._id)); expect(displayed.canReview).toBe(true);
  const saved = await save(displayed); expect(saved.status).toBe(200); current = await legacyRead(); expect(current.body.files[0].reviewRevision).toBe(saved.body.file.reviewRevision);
  expect((await legacyRead(para)).body.files[0].reviewRevision).toBeUndefined();
  await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); expect((await legacyRead()).status).toBe(403);
});
test("an earlier raw record without model defaults receives the exact review revision that can be saved", async () => {
  await CaseFile.collection.updateOne({ _id: file._id }, { $unset: { version: "", history: "", revisionOfFileId: "", approvedAt: "", revisionRequestedAt: "", revisionNotes: "" } });
  const displayed = (await legacyRead()).body.files[0]; expect(displayed.reviewRevision).toBe((await review()).reviewRevision); expect((await save(displayed)).status).toBe(200);
});
test("renaming a replacement cannot reuse an earlier displayed approval even when its displayed version is still one", async () => {
  const displayed = (await legacyRead()).body.files[0];
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { originalName: "New exhibits.txt", storageKey: `cases/${doc._id}/documents/new-exhibits.txt`, version: 1 } });
  expect((await save(displayed)).status).toBe(409); expect((await CaseFile.collection.findOne({ _id: file._id })).status).toBe("pending_review");
  const refreshed = (await legacyRead()).body.files[0]; expect(refreshed.version).toBe(1); expect((await save(refreshed)).status).toBe(200);
});
test("a token-only completion claim after display blocks the same decision in both clients", async () => {
  const displayed = (await legacyRead()).body.files[0]; await Case.collection.updateOne({ _id: doc._id }, { $set: { completionClaimToken: "winner" } });
  expect((await save(displayed)).status).toBe(409); const refreshed = (await legacyRead()).body.files[0]; expect(refreshed.canReview).toBe(false); expect((await save(refreshed)).status).toBe(403);
});
