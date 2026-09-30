const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { Types } = require("mongoose"), { Readable, PassThrough } = require("stream");
const { HeadObjectCommand, GetObjectCommand, GetObjectTaggingCommand } = require("@aws-sdk/client-s3");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const mockSend = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockSend }) }));
jest.mock("../utils/stripe", () => ({}));
jest.mock("../utils/email", () => jest.fn());
const Case = require("../models/Case"), User = require("../models/User"), Job = require("../models/Job"), Application = require("../models/Application"), Block = require("../models/Block");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
const bytes = Buffer.from("%PDF-1.7\nSynthetic recorded résumé bytes\n%%EOF\n");
const cookie = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, other, para, admin, caseId, jobId, applicationId, key, head, scan, afterGet, getBody;
const url = () => `/api/cases/${caseId}/application-review/${para._id}/resume`;
const review = (actor = owner, query = {}) => request(app).get(url()).query({ expectedOwnerId: String(actor._id), ...query }).set("Cookie", cookie(actor));
const download = (revision, actor = owner, query = {}) => request(app).get(`${url()}/download`).query({ expectedOwnerId: String(actor._id), revision, ...query }).set("Cookie", cookie(actor)).buffer(true).parse((res, cb) => {
  const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => { const body = Buffer.concat(chunks); cb(null, res.headers["content-type"]?.includes("application/pdf") ? body : JSON.parse(body.toString())); });
});
const change = values => Application.collection.updateOne({ _id: applicationId }, { $set: values });
const stored = () => Promise.all([Case.collection.findOne({ _id: caseId }), Application.collection.findOne({ _id: applicationId }), Job.collection.findOne({ _id: jobId })]);
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); mockSend.mockReset(); afterGet = null; getBody = () => Readable.from([bytes]);
  process.env.S3_BUCKET = "synthetic-resume-bucket"; process.env.S3_REGION = "us-east-1"; process.env.S3_MALWARE_SCAN_REQUIRED = "true";
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@resume.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved" })));
  caseId = new Types.ObjectId(); jobId = new Types.ObjectId(); applicationId = new Types.ObjectId(); key = `paralegal-resumes/${para._id}/recorded.pdf`;
  await Case.collection.insertOne({ _id: caseId, attorney: owner._id, attorneyId: owner._id, title: "Application documents", status: "open", jobId, applicants: [{ paralegalId: para._id, resumeURL: key, status: "pending" }] });
  await Job.collection.insertOne({ _id: jobId, caseId, attorneyId: owner._id });
  await Application.collection.insertOne({ _id: applicationId, jobId, paralegalId: para._id, status: "submitted", resumeURL: key, coverLetter: "PRIVATE_COVER_LETTER" });
  await User.collection.updateOne({ _id: para._id }, { $set: { resumeURL: `paralegal-resumes/${para._id}/current.pdf` } });
  head = { ContentLength: bytes.length, ContentType: "application/pdf", ETag: '"recorded-etag"', VersionId: "recorded-version", LastModified: new Date("2026-01-01") }; scan = "NO_THREATS_FOUND";
  mockSend.mockImplementation(async command => {
    if (command instanceof HeadObjectCommand) return { ...head };
    if (command instanceof GetObjectTaggingCommand) return { TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: scan }] };
    if (command instanceof GetObjectCommand) { const result = { ...head, Body: getBody() }; await afterGet?.(); return result; }
    throw new Error("Unexpected S3 command");
  });
});
afterEach(() => jest.restoreAllMocks());

test("owner and admin receive only recorded résumé metadata and exact bytes without writes or current-profile substitution", async () => {
  const before = await stored();
  for (const actor of [owner, admin]) {
    const response = await review(actor); expect(response.status).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toMatchObject({ caseId: String(caseId), ownerId: String(actor._id), applicantId: String(para._id), applicationId: String(applicationId), name: "Application resume.pdf", size: bytes.length });
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|recorded-etag|recorded-version|recorded.pdf|current.pdf|s3|resumeURL/);
    const result = await download(response.body.revision, actor); expect(result.status).toBe(200); expect(result.body).toEqual(bytes); expect(result.headers["cache-control"]).toBe("private, no-store"); expect(result.headers["x-content-type-options"]).toBe("nosniff"); expect(result.headers["content-disposition"]).toContain("Application resume.pdf");
  }
  expect(await stored()).toEqual(before);
  for (const [command, options] of mockSend.mock.calls) { expect(command.input.Key).toBe(key); expect(options.abortSignal).toBeDefined(); if (command instanceof GetObjectCommand) expect(command.input).toMatchObject({ IfMatch: head.ETag, VersionId: head.VersionId }); }
});
test("anonymous, unrelated attorney, paralegal and wrong expected account are refused before storage access", async () => {
  expect((await request(app).get(url())).status).toBe(401);
  for (const actor of [other, para]) { expect([403, 404]).toContain((await review(actor)).status); expect([403, 404]).toContain((await download("a".repeat(64), actor)).status); }
  expect((await review(owner, { expectedOwnerId: String(other._id) })).status).toBe(403); expect(mockSend).not.toHaveBeenCalled();
});
test('an uppercase selected identity opens only its normalized recorded resume reference', async () => {
  await Application.collection.updateOne({ _id: applicationId }, { $set: { jobId: String(jobId).toUpperCase(), paralegalId: String(para._id).toUpperCase() } });
  await Case.collection.updateOne({ _id: caseId }, { $set: { 'applicants.0.paralegalId': String(para._id).toUpperCase() } });
  const selected = `/api/cases/${String(caseId).toUpperCase()}/application-review/${String(para._id).toUpperCase()}/resume`, before = await stored();
  const response = await request(app).get(selected).query({ expectedOwnerId: String(owner._id) }).set('Cookie', cookie(owner));
  expect(response.status).toBe(200); expect(response.body).toMatchObject({ caseId: String(caseId), applicantId: String(para._id), applicationId: String(applicationId) });
  expect(mockSend.mock.calls.every(([command]) => command.input.Key === key)).toBe(true); expect(await stored()).toEqual(before);
});
test.each(["key", "url", "cursor", "revision"])('review refuses the unrecognized "%s" query', async field => {
  expect((await review(owner, { [field]: "ignored" })).status).toBe(400); expect(mockSend).not.toHaveBeenCalled();
});
test.each([undefined, "bad", ["a".repeat(64), "b".repeat(64)]])("download requires one valid revision: %p", async revision => {
  expect((await download(revision)).status).toBe(400); expect(mockSend).not.toHaveBeenCalled();
});
test.each(["foreign_owner", "foreign_matter", "duplicate", "missing_application"])("%s records cannot serve a résumé", async kind => {
  if (kind === "foreign_owner") await Job.collection.updateOne({ _id: jobId }, { $set: { attorneyId: other._id } });
  if (kind === "foreign_matter") await Job.collection.updateOne({ _id: jobId }, { $set: { caseId: new Types.ObjectId() } });
  if (kind === "duplicate") await Application.collection.insertOne({ jobId: String(jobId), paralegalId: String(para._id), resumeURL: key });
  if (kind === "missing_application") { await Application.deleteMany({}); await Case.collection.updateOne({ _id: caseId }, { $set: { applicants: [] } }); }
  expect([404, 409]).toContain((await review()).status); expect(mockSend).not.toHaveBeenCalled();
});
test("earlier Matter-only applications retain their recorded résumé and canonical/mirror disagreement never picks the mirror file", async () => {
  await Case.collection.updateOne({ _id: caseId }, { $set: { "applicants.0.resumeURL": `paralegal-resumes/${para._id}/earlier.pdf` } });
  let response = await review(); expect(response.status).toBe(200); expect(mockSend.mock.calls[0][0].input.Key).toBe(key);
  await Application.deleteMany({}); mockSend.mockClear(); response = await review(); expect(response.status).toBe(200); expect(response.body.applicationId).toBeNull(); expect(mockSend.mock.calls[0][0].input.Key).toContain("/earlier.pdf");
});
test.each(["rejected", "withdrawn", "archived", "blocked", "profile_deleted"])("%s retains document evidence under Matter ownership", async kind => {
  if (["rejected", "withdrawn"].includes(kind)) await change({ status: kind });
  if (kind === "archived") await Case.collection.updateOne({ _id: caseId }, { $set: { archived: true, status: "completed" } });
  if (kind === "blocked") await Block.collection.insertOne({ blockerId: owner._id, blockedId: para._id, active: true });
  if (kind === "profile_deleted") await User.deleteOne({ _id: para._id });
  const response = await review(); expect(response.status).toBe(200); expect((await download(response.body.revision)).status).toBe(200);
});
test.each(["https://untrusted.test/resume.pdf", "https://synthetic-resume-bucket.s3.amazonaws.com/other/resume.pdf", "paralegal-resumes/000000000000000000000000/resume.pdf", "../resume.pdf", "javascript:alert(1)"])("untrusted or wrong-owner reference is rejected: %s", async ref => {
  await change({ resumeURL: ref }); const response = await review(); expect({ status: response.status, body: response.body }).toMatchObject({ status: 422, body: { code: "APPLICATION_REVIEW_RESUME_REFERENCE_INVALID" } }); expect(mockSend).not.toHaveBeenCalled();
});
test("configured S3 references resolve locally, while missing or absent records never fall back to the current résumé", async () => {
  await change({ resumeURL: `https://synthetic-resume-bucket.s3.amazonaws.com/${key}` }); expect((await review()).status).toBe(200);
  mockSend.mockRejectedValue(Object.assign(new Error("missing"), { name: "NoSuchKey" })); expect((await review()).body.code).toBe("APPLICATION_REVIEW_RESUME_MISSING");
  await change({ resumeURL: "" }); mockSend.mockClear(); expect((await review()).body.code).toBe("APPLICATION_REVIEW_RESUME_NOT_RECORDED"); expect(mockSend).not.toHaveBeenCalled();
});
test.each([["", 423, "SCAN_PENDING"], ["THREATS_FOUND", 422, "BLOCKED"], ["FAILED", 503, "SCAN_ERROR"]])("security result %s refuses review and download", async (next, status, suffix) => {
  const first = await review(); scan = next;
  for (const response of [await review(), await download(first.body.revision)]) { expect(response.status).toBe(status); expect(response.body.code).toBe(`APPLICATION_REVIEW_RESUME_${suffix}`); }
  expect(mockSend.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(false);
});
test.each(["etag", "version", "size", "application"])("a changed %s invalidates the prior review before fetching bytes", async changeKind => {
  const first = await review(); mockSend.mockClear();
  if (changeKind === "etag") head.ETag = '"new-etag"';
  if (changeKind === "version") head.VersionId = "new-version";
  if (changeKind === "size") head.ContentLength++;
  if (changeKind === "application") await change({ resumeURL: `paralegal-resumes/${para._id}/different.pdf` });
  expect((await download(first.body.revision)).body.code).toBe("APPLICATION_REVIEW_RESUME_CHANGED"); expect(mockSend.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(false);
});
test.each(["owner", "auth_version", "deleted_application", "object", "security"])("%s changes during download discard every byte", async kind => {
  const first = await review(); afterGet = async () => {
    if (kind === "owner") await Case.collection.updateOne({ _id: caseId }, { $set: { attorney: other._id, attorneyId: other._id } });
    if (kind === "auth_version") await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 1 } });
    if (kind === "deleted_application") { await Application.deleteMany({}); await Case.collection.updateOne({ _id: caseId }, { $set: { applicants: [] } }); }
    if (kind === "object") head.ETag = '"replacement"';
    if (kind === "security") scan = "THREATS_FOUND";
  };
  const result = await download(first.body.revision); expect([403, 404, 409, 422]).toContain(result.status); expect(result.headers["content-type"]).toContain("application/json"); expect(JSON.stringify(result.body)).not.toContain("Synthetic recorded");
});
test("renewed nonzero token versions remain valid", async () => {
  await User.collection.updateOne({ _id: owner._id }, { $set: { authVersion: 2 } }); owner.authVersion = 2;
  const response = await review(); expect(response.status).toBe(200); expect((await download(response.body.revision)).body).toEqual(bytes);
});
test("revoking the tracked session during a transfer refuses the completed bytes", async () => {
  const { createAuthSession, revokeSession } = require("../services/authSessionService");
  const { sessionId } = await createAuthSession(owner, {});
  const token = require("jsonwebtoken").sign({ id: String(owner._id), role: owner.role, av: 0, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const first = await review(); afterGet = () => revokeSession(sessionId, owner._id);
  const response = await download(first.body.revision).set("Cookie", `token=${token}`);
  expect(response.status).toBe(403); expect(response.body.code).toBe("APPLICATION_REVIEW_ACCOUNT_CHANGED");
});
test.each(["large", "mime", "empty_etag", "wrong_signature", "short_body", "long_body", "get_metadata"])("%s file refuses delivery", async kind => {
  const first = await review();
  if (kind === "large") head.ContentLength = 10 * 1024 * 1024 + 1;
  if (kind === "mime") head.ContentType = "text/html";
  if (kind === "empty_etag") head.ETag = "";
  if (kind === "wrong_signature") getBody = () => Readable.from([Buffer.alloc(bytes.length, 65)]);
  if (kind === "short_body") getBody = () => Readable.from([bytes.subarray(0, -1)]);
  if (kind === "long_body") getBody = () => Readable.from([bytes, Buffer.from("extra")]);
  if (kind === "get_metadata") { const original = mockSend.getMockImplementation(); mockSend.mockImplementation(async command => { const result = await original(command); if (command instanceof GetObjectCommand) result.ETag = '"wrong"'; return result; }); }
  const response = await download(first.body.revision); expect([409, 413, 422]).toContain(response.status); expect(response.headers["content-type"]).toContain("application/json");
});
test("IfMatch failures are changed-file errors; unversioned objects still require the reviewed ETag", async () => {
  delete head.VersionId; const first = await review(); expect((await download(first.body.revision)).status).toBe(200);
  const command = mockSend.mock.calls.find(([value]) => value instanceof GetObjectCommand)[0]; expect(command.input.IfMatch).toBe(head.ETag); expect(command.input.VersionId).toBeUndefined();
  const original = mockSend.getMockImplementation(); mockSend.mockImplementation(command => command instanceof GetObjectCommand ? Promise.reject(Object.assign(new Error("changed"), { name: "PreconditionFailed" })) : original(command));
  expect((await download(first.body.revision)).body.code).toBe("APPLICATION_REVIEW_RESUME_CHANGED");
});
test("cancellation destroys a pending object stream without finishing a download", async () => {
  const { read } = require("../services/applicationResumes"), controller = new AbortController(), stream = new PassThrough();
  const first = await review(); let arrived; const started = new Promise(resolve => { arrived = resolve; });
  getBody = () => { arrived(); return stream; };
  const pending = read({ user: { id: String(owner._id), role: "attorney" }, auth: { payload: { av: 0 } }, params: { caseId: String(caseId), applicantId: String(para._id) }, query: { expectedOwnerId: String(owner._id), revision: first.body.revision }, resumeSignal: controller.signal }, true);
  await started; controller.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(stream.destroyed).toBe(true);
});
