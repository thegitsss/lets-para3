"use strict";
const mongoose = require("mongoose");
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mockEmbeddings = jest.fn();
let mockClient = null;
jest.mock("../ai/config", () => ({ getOpenAIClient: () => mockClient }));
const User = require("../models/User");
const Case = require("../models/Case");
const Block = require("../models/Block");
const Decision = require("../models/MatterRequirementDecision");
const Vector = require("../models/ParalegalSearchVector");
const matching = require("../services/connectedWorkspace/matching");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express();
app.use(cookieParser(), express.json());
app.use("/api/paralegal-matching", require("../routes/paralegalMatching"));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
let owner;
const oid = () => new mongoose.Types.ObjectId();
const cookie = user => "token=" + jwt.sign({ id: String(user._id), role: user.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
const req = body => ({ user: { id: String(owner._id), role: "attorney", status: "approved" }, auth: { payload: { av: 0 } }, body });
async function profile(patch = {}) {
  const value = {
    _id: oid(), firstName: "Synthetic", lastName: "Paralegal",
    email: "synthetic-" + oid() + "@matching.test", role: "paralegal", status: "approved",
    authVersion: 0, bio: "I prepare discovery responses and organize litigation materials.",
    skills: ["Clio", "Discovery"], practiceAreas: ["Litigation"], specialties: [],
    resumeURL: "resumes/SENSITIVE-RESUME.pdf", profilePhotoStatus: "approved", profileImage: "photos/synthetic.jpg",
    pendingProfileImage: "", yearsExperience: 6, availability: "Available now",
    availabilityDetails: { status: "available", updatedAt: new Date() },
    preferences: { hideProfile: false }, updatedAt: new Date(),
    phoneNumber: "PRIVATE-PHONE", writingSamples: [{ content: "PRIVATE-LEGAL-WORK" }],
    ...patch,
  };
  await User.collection.insertOne(value);
  return value;
}
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  mockClient = null; mockEmbeddings.mockReset();
  owner = { _id: oid(), firstName: "Synthetic", lastName: "Attorney", email: "owner@matching.test", role: "attorney", status: "approved", authVersion: 0 };
  await User.collection.insertOne(owner);
});
test("matching is restricted to signed-in approved attorneys", async () => {
  expect((await request(app).post("/api/paralegal-matching/search").send({ query: "discovery" })).status).toBe(401);
  const para = await profile();
  expect((await request(app).post("/api/paralegal-matching/search").set("Cookie", cookie(para)).send({ query: "discovery" })).status).toBe(403);
});
test("directory privacy, admission and active-account filters apply before ranking", async () => {
  const visible = await profile();
  await profile({ preferences: { hideProfile: true } });
  await profile({ status: "pending" });
  await profile({ status: "denied" });
  await profile({ disabled: true });
  await profile({ deleted: true });
  await profile({ profilePhotoStatus: "pending_review" });
  const result = await matching.search(req({ query: "discovery responses" }));
  expect(result.items.map(row => row.id)).toEqual([String(visible._id)]);
  expect(JSON.stringify(result)).not.toMatch(/SENSITIVE-RESUME|PRIVATE-PHONE|PRIVATE-LEGAL-WORK|email|resumeURL|writingSamples/);
  expect(result.items[0].evidence.every(item => item.evidenceType === "self_reported")).toBe(true);
});
test.each(["attorney", "paralegal"])("an active block in the %s direction excludes a profile", async direction => {
  const visible = await profile(), blocked = await profile();
  await Block.create({ blockerId: direction === "attorney" ? owner._id : blocked._id, blockedId: direction === "attorney" ? blocked._id : owner._id });
  expect((await matching.search(req({ query: "discovery" }))).items.map(row => row.id)).toEqual([String(visible._id)]);
});
test("experience, explicit required skills and effective availability are hard filters", async () => {
  const visible = await profile();
  await profile({ yearsExperience: 2 });
  await profile({ skills: ["Discovery"] });
  await profile({ availability: "Unavailable", availabilityDetails: { status: "unavailable" } });
  const result = await matching.search(req({ query: "discovery", minimumYears: 5, requiredSkills: ["clio"], availableOnly: true }));
  expect(result.items.map(row => row.id)).toEqual([String(visible._id)]);
});
test("Matter minimum experience and recorded requirement declines cannot be bypassed by relevance", async () => {
  const visible = await profile(), declined = await profile();
  await profile({ yearsExperience: 2 });
  const matter = { _id: oid(), attorney: owner._id, attorneyId: owner._id, minimumYearsExperience: 5, requirements: ["Must know Clio"] };
  await Case.collection.insertOne(matter);
  await Decision.create({ matterKey: String(matter._id), paralegalId: declined._id, requirements: matter.requirements });
  const result = await matching.search(req({ query: "discovery Clio", caseId: String(matter._id) }));
  expect(result.items.map(row => row.id)).toEqual([String(visible._id)]);
  expect(result.items[0].requirements).toEqual([{ text: "Must know Clio", state: "confirmation_required" }]);
  expect(result.requirementsNotice).toMatch(/do not certify eligibility/);
});
test("a foreign or conflicting Matter cannot be used to search with private requirements", async () => {
  const matter = { _id: oid(), attorney: oid(), attorneyId: oid(), requirements: ["PRIVATE-REQUIREMENT"] };
  await Case.collection.insertOne(matter);
  await expect(matching.search(req({ query: "discovery", caseId: String(matter._id) }))).rejects.toMatchObject({ status: 404 });
});
test("embeddings receive only safe public professional text and cache vectors rather than copied text", async () => {
  const value = await profile({ firstName: "PRIVATE-FIRSTNAME", lastName: "PRIVATE-LASTNAME", location: "PRIVATE-LOCATION" });
  mockClient = { embeddings: { create: mockEmbeddings } };
  mockEmbeddings.mockImplementation(async ({ input }) => ({ data: input.map((_text, index) => ({ index, embedding: [1, 0, 0] })) }));
  const result = await matching.search(req({ query: "discovery" }));
  expect(result.mode).toBe("semantic_and_profile_evidence");
  expect(mockEmbeddings).toHaveBeenCalled();
  const input = JSON.stringify(mockEmbeddings.mock.calls.map(([options]) => options.input));
  expect(input).toContain("discovery");
  expect(input).not.toMatch(/PRIVATE-FIRSTNAME|PRIVATE-LASTNAME|PRIVATE-LOCATION|SENSITIVE-RESUME|PRIVATE-PHONE|PRIVATE-LEGAL-WORK|@matching.test/);
  const stored = await Vector.collection.findOne({ userId: value._id });
  expect(stored.embedding).toEqual([1, 0, 0]);
  expect(stored).not.toHaveProperty("bio");
  expect(stored).not.toHaveProperty("resumeURL");
});
test("a profile hidden during the provider request is removed before results return", async () => {
  const value = await profile();
  mockClient = { embeddings: { create: mockEmbeddings } };
  mockEmbeddings.mockImplementation(async ({ input }) => {
    await User.collection.updateOne({ _id: value._id }, { $set: { "preferences.hideProfile": true } });
    return { data: input.map((_text, index) => ({ index, embedding: [1, 0] })) };
  });
  expect((await matching.search(req({ query: "discovery" }))).items).toEqual([]);
});
test("an attorney whose session version changes during ranking cannot receive late results", async () => {
  await profile();
  mockClient = { embeddings: { create: mockEmbeddings } };
  mockEmbeddings.mockImplementation(async ({ input }) => {
    await User.collection.updateOne({ _id: owner._id }, { $inc: { authVersion: 1 } });
    return { data: input.map((_text, index) => ({ index, embedding: [1, 0] })) };
  });
  await expect(matching.search(req({ query: "discovery" }))).rejects.toMatchObject({ status: 403 });
});
test("profile evidence edited during ranking is not returned from an old snapshot", async () => {
  const value = await profile();
  mockClient = { embeddings: { create: mockEmbeddings } };
  mockEmbeddings.mockImplementation(async ({ input }) => {
    await User.collection.updateOne({ _id: value._id }, { $set: { bio: "Updated profile no longer makes the original statement." } });
    return { data: input.map((_text, index) => ({ index, embedding: [1, 0] })) };
  });
  expect((await matching.search(req({ query: "discovery" }))).items).toEqual([]);
});
test("provider failure produces explicit evidence-based fallback and does not manufacture verification", async () => {
  await profile();
  mockClient = { embeddings: { create: mockEmbeddings } };
  mockEmbeddings.mockRejectedValue(new Error("synthetic provider unavailable"));
  const result = await matching.search(req({ query: "discovery" }));
  expect(result.mode).toBe("profile_evidence");
  expect(result.note).toMatch(/unavailable/);
  expect(result.items).toHaveLength(1);
  expect(result.items[0].matchBasis).toMatch(/saved profile/);
});
test("unknown availability is presented as unknown rather than confirmed", async () => {
  await profile({ availability: "", availabilityDetails: {} });
  const result = await matching.search(req({ query: "discovery" }));
  expect(result.items[0].availability).toBe("Availability not confirmed");
});
test("invalid queries and unsupported input fields fail before a provider call", async () => {
  mockClient = { embeddings: { create: mockEmbeddings } };
  await expect(matching.search(req({ query: "x", includePrivateResumes: true }))).rejects.toMatchObject({ status: 400 });
  expect(mockEmbeddings).not.toHaveBeenCalled();
});
