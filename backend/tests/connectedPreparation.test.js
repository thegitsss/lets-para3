"use strict";
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
process.env.S3_MALWARE_SCAN_REQUIRED = "false";
jest.mock("../ai/config", () => ({ createStructuredResponse: jest.fn(), isAiEnabled: () => false }));
const User = require("../models/User");
const Case = require("../models/Case");
const File = require("../models/CaseFile");
const Preparation = require("../models/MatterPreparation");
const service = require("../services/connectedWorkspace/preparation");
const { decryptString } = require("../utils/dataEncryption");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express();
app.use(cookieParser(), express.json());
app.use("/api/matter-preparation", require("../routes/matterPreparation"));
app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: error.message }));
const oid = () => new mongoose.Types.ObjectId();
const authoritativeState = value => Object.fromEntries(["title", "details", "tasks", "tasksLocked", "deadlineDate", "deadline", "status", "attorney", "attorneyId", "paralegal", "paralegalId", "totalAmount", "escrowStatus", "escrowIntentId", "paymentReleased"].map(field => [field, value[field]]));
const cookie = user => "token=" + jwt.sign({ id: String(user._id), role: user.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
let owner, para, other, matter, file;
const scopeQuote = "Prepare a chronology and an exhibit index.";
function req(user = owner, body = {}) { return { user: { id: String(user._id), role: user.role, status: "approved" }, auth: { payload: { av: 0 } }, params: { caseId: String(matter._id) }, body }; }
function proposal() { return { summary: "", items: [{ title: "Prepare chronology", citations: [{ sourceId: "scope", quote: scopeQuote }] }], questions: [], observations: [] }; }
function input(patch = {}) { return { fileIds: [String(file._id)], requestId: crypto.randomUUID(), kind: "preparation", ...patch }; }
const sourceReader = jest.fn(async () => ({ byteHash: "synthetic-byte-hash", pages: [{ page: 1, section: null, text: "The transaction occurred on March 3, 2026." }], unreadablePages: [] }));
const propose = jest.fn(async () => ({ data: proposal() }));
const generate = (body = input(), user = owner, overrides = {}) => service.generate(req(user, body), { sourceReader, propose, ...overrides });
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); sourceReader.mockClear(); propose.mockReset(); propose.mockImplementation(async () => ({ data: proposal() }));
  [owner, para, other] = ["owner", "para", "other"].map(name => ({ _id: oid(), role: name === "para" ? "paralegal" : "attorney", status: "approved", authVersion: 0, email: name + "@preparation.test", firstName: "Synthetic", lastName: name }));
  await User.collection.insertMany([owner, para, other]);
  matter = { _id: oid(), title: "Synthetic chronology", details: scopeQuote, tasks: [{ title: "Prepare chronology", completed: false }], attorney: owner._id, attorneyId: owner._id, paralegal: para._id, paralegalId: para._id, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_preparation", totalAmount: 100000, hiredAt: new Date("2026-01-01"), __v: 0 };
  await Case.collection.insertOne(matter);
  file = await File.create({ caseId: matter._id, userId: para._id, originalName: "Transaction.txt", storageKey: "cases/" + matter._id + "/documents/transaction.txt", mimeType: "text/plain", size: 48, uploadedByRole: "paralegal", status: "pending_review", securityStatus: "not_required" });
});
test("preparation endpoints require authentication and active participation", async () => {
  expect((await request(app).get("/api/matter-preparation/matters/" + matter._id)).status).toBe(401);
  expect((await request(app).get("/api/matter-preparation/matters/" + matter._id).set("Cookie", cookie(other))).status).toBe(403);
  const response = await request(app).get("/api/matter-preparation/matters/" + matter._id).set("Cookie", cookie(owner));
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toContain("no-store");
  expect(response.body.aiConfigured).toBe(false);
});
test.each([{ escrowStatus: "pending" }, { status: "completed", paymentReleased: true }, { paralegalAccessRevokedAt: new Date() }, { readOnly: true }])("preparation cannot bypass the existing funded active-Matter boundary: %j", async patch => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: patch });
  await expect(generate()).rejects.toMatchObject({ status: 403 });
  expect(sourceReader).not.toHaveBeenCalled(); expect(propose).not.toHaveBeenCalled();
});
test("a generated plan stores quoted evidence encrypted and changes no authoritative scope or payment data", async () => {
  const before = await Case.collection.findOne({ _id: matter._id });
  const result = await generate();
  expect(result.preparation.status).toBe("proposed");
  expect(result.preparation.items[0].citations[0]).toMatchObject({ sourceId: "scope", quote: scopeQuote, name: "Agreed Matter instructions" });
  const stored = await Preparation.collection.findOne({ _id: new mongoose.Types.ObjectId(result.preparation.id) });
  expect(stored.encryptedPayload).toMatch(/^enc:v1:/);
  expect(stored.encryptedPayload).not.toContain(scopeQuote);
  expect(JSON.parse(decryptString(stored.encryptedPayload)).items).toHaveLength(1);
  expect(authoritativeState(await Case.collection.findOne({ _id: matter._id }))).toEqual(authoritativeState(before));
});
test("repeating an identical generation request returns one saved plan without calling the provider again", async () => {
  const body = input();
  const first = await generate(body), retry = await generate(body);
  expect(retry.reused).toBe(true);
  expect(retry.preparation.id).toBe(first.preparation.id);
  expect(await Preparation.countDocuments()).toBe(1);
  expect(propose).toHaveBeenCalledTimes(1);
});
test("a request identity cannot be reused with different selected documents", async () => {
  const body = input(); await generate(body);
  await expect(generate({ ...body, fileIds: [] })).rejects.toMatchObject({ status: 409, publicCode: "PREPARATION_REQUEST_CHANGED" });
});
test("foreign or duplicate selected source IDs fail before extraction", async () => {
  await expect(generate(input({ fileIds: [String(oid())] }))).rejects.toMatchObject({ status: 404 });
  await expect(generate(input({ fileIds: [String(file._id), String(file._id)] }))).rejects.toMatchObject({ status: 404 });
  expect(sourceReader).not.toHaveBeenCalled();
});
test("source citations must name a provided source and quote an exact passage", async () => {
  propose.mockResolvedValueOnce({ data: { ...proposal(), items: [{ title: "Invented event", citations: [{ sourceId: "scope", quote: "An invented deadline" }] }] } });
  await expect(generate()).rejects.toMatchObject({ status: 502, publicCode: "PREPARATION_EVIDENCE_INVALID" });
  expect(await Preparation.countDocuments()).toBe(0);
});
test("PDF citations retain file identity, document version and actual page", async () => {
  propose.mockResolvedValueOnce({ data: { ...proposal(), observations: [{ title: "Check the transaction date", citations: [{ sourceId: String(file._id) + ":p1", quote: "March 3, 2026" }] }] } });
  const result = await generate();
  expect(result.preparation.observations[0].citations[0]).toMatchObject({ fileId: String(file._id), version: 1, page: 1, name: "Transaction.txt" });
});
test("a source replacement while the provider runs invalidates the result and stores nothing", async () => {
  propose.mockImplementationOnce(async () => { await File.collection.updateOne({ _id: file._id }, { $set: { version: 2 } }); return { data: proposal() }; });
  await expect(generate()).rejects.toMatchObject({ status: 409, publicCode: "PREPARATION_SOURCE_CHANGED" });
  expect(await Preparation.countDocuments()).toBe(0);
});
test("a newly blocked source during generation invalidates the result and stores nothing", async () => {
  propose.mockImplementationOnce(async () => { await File.collection.updateOne({ _id: file._id }, { $set: { securityStatus: "blocked" } }); return { data: proposal() }; });
  await expect(generate()).rejects.toMatchObject({ status: 409, publicCode: "PREPARATION_SOURCE_CHANGED" });
  expect(await Preparation.countDocuments()).toBe(0);
});
test("changed agreed scope or revoked actor during generation cannot save a late result", async () => {
  propose.mockImplementationOnce(async () => { await Case.collection.updateOne({ _id: matter._id }, { $set: { details: "Changed scope" } }); return { data: proposal() }; });
  await expect(generate()).rejects.toMatchObject({ status: 409 });
  expect(await Preparation.countDocuments()).toBe(0);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { details: scopeQuote } });
  propose.mockImplementationOnce(async () => { await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } }); return { data: proposal() }; });
  await expect(generate()).rejects.toMatchObject({ status: 403 });
  expect(await Preparation.countDocuments()).toBe(0);
});
test("a replacement paralegal cannot read the previous assignment's suggestions or dated source documents", async () => {
  await generate();
  const replacement = { _id: oid(), role: "paralegal", status: "approved", authVersion: 0, email: "replacement@preparation.test" };
  await User.collection.insertOne(replacement);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegal: replacement._id, paralegalId: replacement._id, withdrawnParalegalId: para._id, hiredAt: new Date(Date.now() + 1000) } });
  const result = await service.list(req(replacement));
  expect(result.preparation).toBeNull(); expect(result.submission).toBeNull(); expect(result.files).toEqual([]);
});
test("only the attorney may accept a checklist and acceptance changes only the preparation record", async () => {
  const result = await generate(), body = { preparationId: result.preparation.id, revision: result.preparation.revision, items: ["Prepare the chronology for counsel review"], confirmed: true };
  await expect(service.accept(req(para, body))).rejects.toMatchObject({ status: 403 });
  const before = await Case.collection.findOne({ _id: matter._id });
  const accepted = await service.accept(req(owner, body));
  expect(accepted.preparation.status).toBe("accepted");
  expect(accepted.preparation.items[0]).toMatchObject({ title: body.items[0], editedByAttorney: true });
  expect(authoritativeState(await Case.collection.findOne({ _id: matter._id }))).toEqual(authoritativeState(before));
});
test("an accepted checklist retry cannot report changed edited text as saved", async () => {
  const result = await generate(), body = { preparationId: result.preparation.id, revision: result.preparation.revision, items: ["Chronology for counsel"], confirmed: true };
  await service.accept(req(owner, body));
  const same = await service.accept(req(owner, body));
  expect(same.reused).toBe(true);
  await expect(service.accept(req(owner, { ...body, items: ["Changed text which was never accepted"] }))).rejects.toMatchObject({ status: 409 });
});
test("attorney checklist edits can add and remove rows without attaching model evidence to newly authored work", async () => {
  propose.mockResolvedValueOnce({ data: { ...proposal(), items: [...proposal().items, { title: "Prepare exhibit index", citations: [{ sourceId: "scope", quote: scopeQuote }] }] } });
  const result = await generate(), before = await Case.collection.findOne({ _id: matter._id });
  const body = { preparationId: result.preparation.id, revision: result.preparation.revision, items: [{ title: "Chronology for counsel review", sourceIndex: 0 }, { title: "Attorney-authored working reminder", sourceIndex: null }], confirmed: true };
  const accepted = await service.accept(req(owner, body));
  expect(accepted.preparation.items).toHaveLength(2);
  expect(accepted.preparation.items[0]).toMatchObject({ title: body.items[0].title, originalTitle: "Prepare chronology", editedByAttorney: true, citations: [{ sourceId: "scope", quote: scopeQuote }] });
  expect(accepted.preparation.items[1]).toEqual({ title: body.items[1].title, citations: [], authoredByAttorney: true });
  expect(accepted.preparation.items.some(item => item.title === "Prepare exhibit index")).toBe(false);
  expect((await service.accept(req(owner, body))).reused).toBe(true);
  expect(authoritativeState(await Case.collection.findOne({ _id: matter._id }))).toEqual(authoritativeState(before));
});
test("duplicate or invented source indexes cannot relabel model evidence during checklist acceptance", async () => {
  const result = await generate(), base = { preparationId: result.preparation.id, revision: result.preparation.revision, confirmed: true };
  await expect(service.accept(req(owner, { ...base, items: [{ title: "One", sourceIndex: 0 }, { title: "Two", sourceIndex: 0 }] }))).rejects.toMatchObject({ status: 400, publicCode: "PREPARATION_INVALID" });
  await expect(service.accept(req(owner, { ...base, items: [{ title: "Unprovided source", sourceIndex: 29 }] }))).rejects.toMatchObject({ status: 400, publicCode: "PREPARATION_INVALID" });
  expect((await service.list(req())).preparation.status).toBe("proposed");
});
test("changed sources prevent checklist acceptance and old stored plans are explicitly stale", async () => {
  const result = await generate();
  await File.collection.updateOne({ _id: file._id }, { $set: { version: 2 } });
  expect((await service.list(req())).preparation.stale).toBe(true);
  await expect(service.accept(req(owner, { preparationId: result.preparation.id, revision: result.preparation.revision, items: ["Prepare chronology"], confirmed: true }))).rejects.toMatchObject({ status: 409 });
});
test("submission review uses the accepted checklist while retaining the original Matter scope", async () => {
  const result = await generate();
  await service.accept(req(owner, { preparationId: result.preparation.id, revision: result.preparation.revision, items: ["Chronology for counsel"], confirmed: true }));
  await generate(input({ kind: "submission" }));
  const context = JSON.parse(propose.mock.calls[1][0].input);
  expect(context.acceptedWorkingChecklist).toEqual(["Chronology for counsel"]);
  expect(context.sources[0].text).toContain(scopeQuote);
});
test("bounded extraction reads synthetic text and rejects invalid bytes without keeping temporary files", async () => {
  const parsed = await service.extract(Buffer.from("First paragraph.\n\nSecond paragraph."), "txt");
  expect(parsed.pages).toEqual([{ page: null, section: 1, text: "First paragraph." }, { page: null, section: 2, text: "Second paragraph." }]);
  await expect(service.extract(Buffer.from([0xff, 0xfe, 0]), "txt")).rejects.toMatchObject({ status: 422 });
});
