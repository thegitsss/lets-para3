const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { authCookieFor } = require("./helpers/phase2LifecycleFixture");
const { seedAttorneySupportFixtures } = require("./helpers/attorneySupportFixtures");
const User = require("../models/User");
const Case = require("../models/Case");
const ChecklistTask = require("../models/ChecklistTask");
const WeeklyNote = require("../models/WeeklyNote");
const Block = require("../models/Block");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const app = express(); app.use(cookieParser()); app.use(express.json());
const users = require("../routes/users");
app.use("/api/users", users); app.use("/api/paralegals", users.paralegalRouter);
app.use("/api/checklist", require("../routes/checklist"));
app.use("/api/public/paralegals", require("../routes/publicParalegalDirectory"));
app.use("/public/paralegals", require("../routes/publicParalegalDirectory"));
beforeAll(connect); beforeEach(clearDatabase); afterAll(closeDatabase);
const call = (method, path, user, data) => request(app)[method](path).set("Cookie", authCookieFor(user)).send(data);

test("private tasks support real paging, details, association and owner-only mutations without shared-task changes", async () => {
  const f = await seedAttorneySupportFixtures();
  const before = await Case.findById(f.caseIds.active).lean();
  const create = await call("post", "/api/checklist", f.users.owner, { title: "Private preparation", notes: "Attorney-only details", caseId: String(f.caseIds.active), due: "2026-01-01T12:00:00Z" });
  expect(create.status).toBe(201);
  await ChecklistTask.insertMany(Array.from({ length: 21 }, (_, i) => ({ owner: f.ids.owner, title: `Private ${i}` })));
  const first = await call("get", "/api/checklist?status=all&limit=20&page=1", f.users.owner);
  const second = await call("get", "/api/checklist?status=all&limit=20&page=2", f.users.owner);
  expect(first.body.total).toBe(22); expect(first.body.items).toHaveLength(20); expect(second.body.items).toHaveLength(2);
  const overdue = await call("get", "/api/checklist?status=open&overdue=true", f.users.owner);
  expect(overdue.body.items).toEqual([expect.objectContaining({ id: create.body.id, notes: "Attorney-only details" })]);
  expect((await call("get", "/api/checklist?status=all", f.users.oneAttorney)).body.total).toBe(0);
  expect((await call("get", "/api/checklist", f.users.assignedParalegal)).status).toBe(403);
  expect((await call("post", `/api/checklist/${create.body.id}/toggle`, f.users.oneAttorney)).status).toBe(404);
  expect((await call("delete", `/api/checklist/${create.body.id}`, f.users.oneAttorney)).status).toBe(404);
  expect((await call("post", `/api/checklist/${create.body.id}/toggle`, f.users.owner)).body.done).toBe(true);
  expect((await call("post", "/api/checklist", f.users.owner, { title: "Foreign Matter", caseId: String(f.caseIds.inaccessible) })).status).toBe(403);
  expect((await call("delete", `/api/checklist/${create.body.id}`, f.users.owner)).body.ok).toBe(true);
  expect((await Case.findById(f.caseIds.active).lean()).tasks).toEqual(before.tasks);
});

test("weekly notes are user-scoped, survive new sessions, and retain the requested calendar week", async () => {
  const f = await seedAttorneySupportFixtures();
  const weekStart = "2026-08-31";
  const notes = ["Private Monday draft", "", "", "", "", "", "Private Sunday draft"];
  const initial = await call("get", `/api/users/me/weekly-notes?weekStart=${weekStart}`, f.users.owner);
  const save = await call("put", "/api/users/me/weekly-notes", f.users.owner, { weekStart, notes, revision: initial.body.revision });
  expect(save.status).toBe(200); expect(save.body.notes).toEqual(notes);
  const read = await call("get", `/api/users/me/weekly-notes?weekStart=${weekStart}`, f.users.owner);
  expect(read.body.notes).toEqual(notes);
  expect((await call("get", `/api/users/me/weekly-notes?weekStart=${weekStart}`, f.users.oneAttorney)).body.notes).toEqual(Array(7).fill(""));
  expect(await WeeklyNote.countDocuments({ userId: f.ids.owner })).toBe(1);
  expect(read.body.weekStart).toBe(weekStart);
  expect(read.body.revision).not.toBe(initial.body.revision);
  await User.updateOne({ _id: f.ids.owner }, { $set: { disabled: true } });
  expect([401, 403]).toContain((await call("get", `/api/users/me/weekly-notes?weekStart=${weekStart}`, f.users.owner)).status);
});

test("directory aliases agree on sorting/paging/readiness/blocks and public profiles omit member documents", async () => {
  const f = await seedAttorneySupportFixtures();
  const profiles = [];
  for (let index = 0; index < 12; index++) {
    const _id = new User()._id;
    profiles.push({ _id, firstName: `Candidate ${String(index).padStart(2, "0")}`, lastName: "Synthetic", email: `candidate-${_id}@phase3.invalid`, password: "synthetic-hash", role: "paralegal", status: "approved", state: "CA", location: "California", bio: "Synthetic profile", skills: ["Research"], practiceAreas: ["Contract Law"], yearsExperience: index + 1, resumeURL: `paralegal-resumes/${_id}/resume.pdf`, profilePhotoStatus: "approved", profileImage: `https://test-bucket.s3.us-east-1.amazonaws.com/profile-photos/${_id}/photo.jpg`, avatarURL: `https://test-bucket.s3.us-east-1.amazonaws.com/profile-photos/${_id}/photo.jpg`, preferences: { hideProfile: false }, createdAt: new Date(2026, 0, index + 1), updatedAt: new Date(2026, 0, index + 1) });
  }
  await User.collection.insertMany(profiles);
  const query = "?q=Candidate&location=California&practice=Contract%20Law&sort=alpha&limit=10";
  const [current, alias] = await Promise.all([call("get", `/api/public/paralegals${query}`, f.users.owner), call("get", `/public/paralegals${query}`, f.users.owner)]);
  const stable = (body) => JSON.parse(JSON.stringify(body), (key, value) => key === "projectedAt" ? undefined : value);
  expect(current.status).toBe(200); expect(stable(current.body)).toEqual(stable(alias.body)); expect(current.body.total).toBe(12); expect(current.body.items).toHaveLength(10);
  expect((await call("get", `/api/public/paralegals${query}&page=2`, f.users.owner)).body.items).toHaveLength(2);
  const candidate = profiles[0];
  const publicProfile = await call("get", `/api/public/paralegals/${candidate._id}`, f.users.owner);
  const member = await call("get", `/api/paralegals/${candidate._id}`, f.users.owner);
  expect(publicProfile.status).toBe(200); expect(publicProfile.body.resumeURL).toBeUndefined();
  expect(member.status).toBe(200); expect(member.body.resumeURL).toBe(candidate.resumeURL); expect(member.body.email).toBeUndefined();
  await User.updateOne({ _id: profiles[1]._id }, { $set: { "preferences.hideProfile": true } });
  await User.updateOne({ _id: profiles[2]._id }, { $set: { status: "pending" } });
  await Block.create({ blockerId: f.ids.owner, blockedId: candidate._id });
  expect((await call("get", `/api/public/paralegals${query}`, f.users.owner)).body.total).toBe(9);
  expect((await call("get", `/api/paralegals/${candidate._id}`, f.users.owner)).status).toBe(403);
  expect((await call("get", `/api/public/paralegals/${candidate._id}`, f.users.owner)).status).toBe(403);
});
