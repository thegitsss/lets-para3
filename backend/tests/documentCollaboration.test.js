const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), mongoose = require("mongoose"), jwt = require("jsonwebtoken"), { Readable } = require("stream");
process.env.ONLYOFFICE_DOCUMENT_SERVER_URL = "https://editor.synthetic.test";
process.env.ONLYOFFICE_JWT_SECRET = "synthetic-onlyoffice-secret-at-least-32-characters";
process.env.S3_BUCKET = "synthetic-document-editor";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";
const mockStorage = jest.fn();
jest.mock("../utils/s3Client", () => ({ createS3Client: () => ({ send: mockStorage }) }));
const User = require("../models/User"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Session = require("../models/DocumentEditorSession"), Upload = require("../models/MatterFileUpload"), Audit = require("../models/AuditLog");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { decryptCaseFilePayload } = require("../utils/dataEncryption");
const editor = require("../services/connectedWorkspace/editor");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/document-collaboration", require("../routes/documentCollaboration")); app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const original = Buffer.from("PK\x03\x04 [Content_Types].xml word/document.xml Original"), changed = Buffer.from("PK\x03\x04 [Content_Types].xml word/document.xml Revised");
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
let owner, para, other, matter, file, mockFetch;
const open = (user = owner, fileId = file._id, caseId = matter._id) => request(app).post(`/api/document-collaboration/matters/${caseId}/files/${fileId}/session`).set("Cookie", cookie(user)).send({});
const signed = payload => jwt.sign(payload, process.env.ONLYOFFICE_JWT_SECRET, { algorithm: "HS256", expiresIn: "5m" });
const save = (opened, extras = {}) => request(app).post(`/api/document-collaboration/callback/${opened.sessionId}`).send({ token: signed({ key: opened.config.document.key, status: 6, users: [String(owner._id)], url: "https://editor.synthetic.test/cache/changed.docx", ...extras }) });
const stored = () => CaseFile.collection.findOne({ _id: file._id });

beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); process.env.S3_MALWARE_SCAN_REQUIRED = "false";
  process.env.ONLYOFFICE_DOCUMENT_SERVER_URL = "https://editor.synthetic.test";
  process.env.ONLYOFFICE_JWT_SECRET = "synthetic-onlyoffice-secret-at-least-32-characters";
  [owner, para, other] = await User.create(["owner", "para", "other"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@editor.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : "attorney", status: "approved" })));
  matter = await Case.create({ attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, title: "Synthetic document review", details: "Review the document", status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_editor", totalAmount: 100000 });
  file = await CaseFile.create({ caseId: matter._id, userId: para._id, originalName: "Draft.docx", storageKey: `cases/${matter._id}/documents/original.docx`, mimeType: MIME, size: original.length, uploadedByRole: "paralegal", status: "pending_review", securityStatus: "not_required" });
  const objects = new Map([[`cases/${matter._id}/documents/original.docx`, original]]);
  mockStorage.mockImplementation(async command => {
    if (command.constructor.name === "PutObjectCommand") { objects.set(command.input.Key, command.input.Body); return {}; }
    const buffer = objects.get(command.input.Key) || original;
    return command.constructor.name === "HeadObjectCommand" ? { ETag: `"synthetic-${buffer.length}"`, ContentLength: buffer.length } : command.constructor.name === "GetObjectCommand" ? { Body: Readable.from([buffer]) } : {};
  });
  mockFetch = jest.spyOn(global, "fetch").mockImplementation(async () => ({ status: 200, headers: new Headers({ "content-length": String(changed.length) }), body: Readable.from([changed]) }));
});
afterEach(() => jest.restoreAllMocks());

test("status reports a missing provider without inventing a working editor", async () => {
  delete process.env.ONLYOFFICE_JWT_SECRET;
  const result = await request(app).get("/api/document-collaboration/status").set("Cookie", cookie(owner));
  expect(result.status).toBe(200); expect(result.body.configured).toBe(false);
  expect((await open()).status).toBe(503); expect(await Session.countDocuments()).toBe(0);
});
test("configuration restricts HTTP and credentials to explicit local development", () => {
  const env = { NODE_ENV: "production", ONLYOFFICE_DOCUMENT_SERVER_URL: "http://editor.test", APP_BASE_URL: "https://lpc.test", ONLYOFFICE_JWT_SECRET: "a".repeat(32), S3_BUCKET: "bucket", JWT_SECRET: "source-secret" };
  expect(editor.configuration(env).configured).toBe(false);
  expect(editor.configuration({ ...env, NODE_ENV: "development", ONLYOFFICE_DOCUMENT_SERVER_URL: "http://localhost:8080", APP_BASE_URL: "http://localhost:5050" }).configured).toBe(true);
  expect(editor.configuration({ ...env, ONLYOFFICE_DOCUMENT_SERVER_URL: "https://user:password@editor.test" }).configured).toBe(false);
});
test("both authorized participants receive the same co-editing key and signed tracked-change configuration", async () => {
  const a = await open(), b = await open(para);
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  expect(a.body.config.document.key).toBe(b.body.config.document.key);
  expect(a.body.config.editorConfig.customization.review.trackChanges).toBe(true);
  expect(jwt.verify(a.body.config.token, process.env.ONLYOFFICE_JWT_SECRET).document.key).toBe(a.body.config.document.key);
  expect(await Session.countDocuments()).toBe(1);
  const session = await Session.findById(a.body.sessionId).select("+participants").lean();
  expect(session.participants.map(x => String(x.userId)).sort()).toEqual([String(owner._id), String(para._id)].sort());
  expect(JSON.stringify(a.body)).not.toContain(process.env.ONLYOFFICE_JWT_SECRET);
});
test("unrelated accounts, crossed Matter files, unsupported formats, and unfunded work never open a session", async () => {
  expect((await open(other)).status).toBe(403);
  const otherMatter = await Case.create({ attorney: owner._id, title: "Other matter", details: "Synthetic second matter", status: "open", totalAmount: 40000 });
  expect((await open(owner, file._id, otherMatter._id)).status).toBe(403);
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { mimeType: "application/pdf" } }); expect((await open()).status).toBe(415);
  expect(await Session.countDocuments()).toBe(0);
});
test("signed source delivery binds to its session and repeats current approval and assignment checks", async () => {
  const opened = (await open(para)).body;
  const url = new URL(opened.config.document.url);
  expect((await request(app).get(url.pathname + url.search)).status).toBe(200);
  expect((await request(app).get(`/api/document-collaboration/source/${new mongoose.Types.ObjectId()}${url.search}`)).status).toBe(403);
  await User.collection.updateOne({ _id: para._id }, { $inc: { authVersion: 1 } });
  expect((await request(app).get(url.pathname + url.search)).status).toBe(403);
});
test("a replacement paralegal cannot open a previous assignment's document", async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { withdrawnParalegalId: other._id, hiredAt: new Date(Date.now() + 1000) } });
  expect((await open(para)).status).toBe(404);
});
test("a cookie or editor-configuration token cannot authorize a provider save", async () => {
  const opened = (await open()).body;
  const invalid = await request(app).post(`/api/document-collaboration/callback/${opened.sessionId}`).set("Cookie", cookie(owner)).send({ key: opened.config.document.key, status: 2, url: "https://editor.synthetic.test/cache/x.docx" });
  expect(invalid.status).toBe(403);
  const configReplay = await request(app).post(`/api/document-collaboration/callback/${opened.sessionId}`).send({ token: opened.config.token }); expect(configReplay.status).toBe(403);
  expect(mockFetch).not.toHaveBeenCalled();
});
test.each(["https://other.test/file.docx", "https://editor.synthetic.test:8443/file.docx", "https://editor.synthetic.test@evil.test/file.docx", "http://127.0.0.1:9000/private"])('callback rejects out-of-scope download origin %s before fetching', async url => {
  const opened = (await open()).body; expect((await save(opened, { url })).status).toBe(403); expect(mockFetch).not.toHaveBeenCalled();
});
test("header-wrapped callbacks use signed parameters even when unsigned fields disagree", async () => {
  const opened = (await open()).body;
  const result = await request(app).post(`/api/document-collaboration/callback/${opened.sessionId}`).set("Authorization", `Bearer ${signed({ operation: "callback", payload: { key: opened.config.document.key, status: 4 } })}`).send({ key: opened.config.document.key, status: 2, url: "https://evil.test/" });
  expect(result.status).toBe(200); expect(result.body.error).toBe(0); expect(mockFetch).not.toHaveBeenCalled(); expect((await Session.findById(opened.sessionId)).state).toBe("closed");
});
test("a successful force save preserves originals, resets review, advances the version, and records audit atomically", async () => {
  const opened = (await open()).body, result = await save(opened);
  expect(result.status).toBe(200); expect(result.body.error).toBe(0);
  const raw = await stored(), plain = decryptCaseFilePayload(raw);
  expect(plain.history).toHaveLength(1); expect(plain.history[0].storageKey).toBe(`cases/${matter._id}/documents/original.docx`);
  expect(plain.storageKey).toMatch(/\/documents\/scan-required-/); expect(raw.version).toBe(2); expect(raw.status).toBe("pending_review");
  expect(await Upload.countDocuments({ status: "recorded", kind: "replacement" })).toBe(1);
  expect(await Audit.countDocuments({ action: "document.collaboration.saved" })).toBe(1);
  expect(JSON.stringify(await Audit.findOne({ action: "document.collaboration.saved" }))).not.toContain("Draft.docx");
  const state = await request(app).get(`/api/document-collaboration/sessions/${opened.sessionId}`).set("Cookie", cookie(owner));
  expect(state.body).toMatchObject({ state: "open", savedVersion: 2 });
});
test("duplicate and out-of-order force-save callbacks cannot create duplicate versions or revert a newer save", async () => {
  const opened = (await open()).body;
  expect((await save(opened)).body.error).toBe(0);
  expect((await save(opened)).body.error).toBe(0);
  expect((await save(opened, { url: "https://editor.synthetic.test/cache/newer.docx" })).body.error).toBe(0);
  const before = await stored(), calls = mockFetch.mock.calls.length;
  expect((await save(opened)).body.error).toBe(0);
  expect((await stored()).version).toBe(3); expect((await stored()).storageKey).toBe(before.storageKey); expect(mockFetch).toHaveBeenCalledTimes(calls);
  expect(await Upload.countDocuments({ status: "recorded" })).toBe(2);
});
test("the last status-2 save closes the editing session and a later opening uses a fresh key", async () => {
  const opened = (await open()).body;
  expect((await save(opened, { status: 2 })).body.error).toBe(0);
  expect((await Session.findById(opened.sessionId)).state).toBe("closed");
  const next = await open(); expect(next.status).toBe(200); expect(next.body.config.document.key).not.toBe(opened.config.document.key);
});
test("a paralegal's save is attributed to the paralegal and still requires attorney review", async () => {
  const opened = (await open(para)).body;
  expect((await save(opened, { users: [String(para._id)] })).body.error).toBe(0);
  expect(await stored()).toMatchObject({ userId: para._id, uploadedByRole: "paralegal", status: "pending_review" });
});
test("access revoked while the provider downloads cannot produce a late file replacement", async () => {
  const opened = (await open()).body;
  mockFetch.mockImplementation(async () => { await Case.collection.updateOne({ _id: matter._id }, { $set: { readOnly: true } }); return { status: 200, headers: new Headers(), body: Readable.from([changed]) }; });
  expect((await save(opened)).status).toBe(403);
  expect((await stored()).version).toBe(1); expect(decryptCaseFilePayload(await stored()).history).toHaveLength(0);
  expect((await Upload.findOne()).status).toBe("unconfirmed");
});
test("security scan changes do not split an existing co-editing session", async () => {
  const opened = (await open()).body;
  await CaseFile.collection.updateOne({ _id: file._id }, { $set: { securityStatus: "clean" }, $inc: { __v: 1 } });
  const joined = await open(para); expect(joined.status).toBe(200); expect(joined.body.sessionId).toBe(opened.sessionId);
});
test("a document changed outside the editing session cannot be overwritten", async () => {
  const opened = (await open()).body;
  await CaseFile.collection.updateOne({ _id: file._id }, { $inc: { version: 1 } });
  expect((await save(opened)).status).toBe(409); expect(mockFetch).not.toHaveBeenCalled();
});
test("provider redirects and oversized bodies fail without following a redirect or replacing a file", async () => {
  const opened = (await open()).body;
  mockFetch.mockResolvedValueOnce({ status: 302, headers: new Headers({ location: "https://other.test/file" }) });
  expect((await save(opened)).status).toBe(502);
  expect(mockFetch.mock.calls[0][1].redirect).toBe("manual"); expect((await stored()).version).toBe(1);
  mockFetch.mockResolvedValueOnce({ status: 200, headers: new Headers({ "content-length": String(editor.MAX_BYTES + 1) }) });
  expect((await save(opened)).status).toBe(413); expect((await stored()).version).toBe(1);
});
test("a missing commit acknowledgement is recovered from the transactional save receipt", async () => {
  const opened = (await open()).body, start = mongoose.startSession.bind(mongoose);
  jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => { const session = await start(...args), commit = session.commitTransaction.bind(session); session.commitTransaction = async () => { await commit(); throw new Error("Synthetic lost acknowledgement"); }; return session; });
  expect((await save(opened)).body.error).toBe(0); expect((await stored()).version).toBe(2); expect(await Audit.countDocuments({ action: "document.collaboration.saved" })).toBe(1);
});
