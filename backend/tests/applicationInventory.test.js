const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest");
const { Types } = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const authCookieFor = user => `token=${require("jsonwebtoken").sign({ id: String(user._id), role: user.role, email: user.email, status: user.status, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_application_review";
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn(async () => ({})) }));
const Case = require("../models/Case"), User = require("../models/User"), Job = require("../models/Job"), Application = require("../models/Application"), Block = require("../models/Block");
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/cases", require("../routes/cases"));
let owner, other, para, admin, matter, jobId, applicationId;
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  [owner, other, para, admin] = await User.create(["owner", "other", "para", "admin"].map(name => ({ firstName: "Synthetic", lastName: name, email: `${name}@application-review.test`, password: "Synthetic123!", role: name === "para" ? "paralegal" : name === "admin" ? "admin" : "attorney", status: "approved" })));
  jobId = new Types.ObjectId(); applicationId = new Types.ObjectId();
  const profileSnapshot = { bio: "Experience when applying", yearsExperience: 3, location: "New York", availability: "Weekdays", languages: ["English"], specialties: ["Contracts"] };
  matter = await Case.create({ title: "Synthetic application Matter", details: "PRIVATE_MATTER_DETAILS", attorney: owner._id, attorneyId: owner._id, status: "open", totalAmount: 40000, jobId, applicants: [{ paralegalId: para._id, status: "pending", note: "Synthetic cover letter", profileSnapshot }] });
  await Job.collection.insertOne({ _id: jobId, caseId: matter._id, attorneyId: owner._id });
  await Application.collection.insertOne({ _id: applicationId, jobId, paralegalId: para._id, status: "submitted", coverLetter: "Synthetic cover letter", createdAt: new Date("2026-01-01"), profileSnapshot, syncStatus: "synced", syncError: "PRIVATE_SYNC_ERROR", starredBy: [owner._id], statusHistory: [{ from: "", to: "submitted", at: new Date("2026-01-01"), actorId: para._id, reason: "PRIVATE_REASON" }] });
});
afterEach(() => jest.restoreAllMocks());
const read = (actor = owner, query = "") => request(app).get(`/api/cases/${matter._id}/application-review?expectedOwnerId=${actor._id}${query}`).set("Cookie", authCookieFor(actor));
const raw = () => Promise.all([Case.collection.findOne({ _id: matter._id }), Job.collection.findOne({ _id: jobId }), Application.collection.findOne({ _id: applicationId })]);

const inventory = (actor = owner, query = {}) => request(app).get(`/api/cases/${matter._id}/application-inventory`).query({ expectedOwnerId: String(actor._id), ...query }).set("Cookie", authCookieFor(actor));

test('mixed canonical and earlier inventory has complete counts and one chronological order beyond 100 rows', async () => {
  const entries = Array.from({ length: 105 }, (_, n) => ({ _id: new Types.ObjectId(), jobId, paralegalId: new Types.ObjectId(), status: n % 2 ? 'rejected' : 'withdrawn', createdAt: new Date(Date.UTC(2026, 1, 1, 0, n)), coverLetter: `Canonical ${n}`, syncStatus: 'synced' }));
  await Application.collection.insertMany(entries);
  const earlier = Array.from({ length: 30 }, (_, n) => ({ paralegalId: new Types.ObjectId(), note: `Earlier ${n}`, status: 'pending', appliedAt: new Date(Date.UTC(2026, 2, 1, 0, n)) }));
  await Case.collection.updateOne({ _id: matter._id }, { $push: { applicants: { $each: earlier } } });
  const before = await raw(), seen = [];
  for (let page = 1; page <= 6; page++) {
    const response = await inventory(owner, { page });
    expect({ status: response.status, error: response.status === 200 ? null : response.body }).toEqual({ status: 200, error: null });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({ total: 136, page, pageSize: 25, pages: 6, complete: true, counts: { submitted: 31, rejected: 52, withdrawn: 53 }, filters: { page, sort: 'newest', status: 'all', search: '', applicantId: '' } });
    seen.push(...response.body.applications);
  }
  expect(seen).toHaveLength(136); expect(new Set(seen.map(row => row.applicantId)).size).toBe(136);
  expect(seen[0].coverLetter).toBe('Earlier 29'); expect(seen.at(-1).applicationId).toBe(String(applicationId));
  expect(seen.map(row => row.appliedAt)).toEqual([...seen.map(row => row.appliedAt)].sort().reverse());
  expect(await raw()).toEqual(before); expect(require('../utils/notifyUser').notifyUser).not.toHaveBeenCalled();
});

test('filters sorting and selected history apply across the inventory without changing saved application evidence', async () => {
  await User.collection.updateOne({ _id: para._id }, { $set: { firstName: 'Élodie', lastName: 'Morgan' } });
  await Application.collection.insertOne({ jobId, paralegalId: other._id, status: 'rejected', createdAt: new Date('2026-02-01'), coverLetter: 'Unavailable profile history' });
  let response = await inventory(owner, { q: 'élodie', sort: 'name' });
  expect(response.status).toBe(200); expect(response.body.total).toBe(1); expect(response.body.applications[0]).toMatchObject({ name: 'Élodie Morgan', profileSnapshot: { bio: 'Experience when applying' } });
  response = await inventory(owner, { status: 'rejected', sort: 'oldest' }); expect(response.body.total).toBe(1); expect(response.body.applications[0].status).toBe('rejected');
  response = await inventory(owner, { sort: 'starred' }); expect(response.body.applications[0].applicantId).toBe(String(para._id));
  response = await inventory(owner, { status: 'rejected', applicantId: String(para._id).toUpperCase(), page: 99 }); expect(response.body).toMatchObject({ total: 1, page: 1, selectedApplicantId: String(para._id) });
  expect(response.body.applications[0].applicantId).toBe(String(para._id));
  response = await inventory(owner, { page: 9 }); expect(response.body).toMatchObject({ total: 2, page: 9, pages: 1, applications: [] });
  response = await inventory(owner, { q: '.*' }); expect(response.body.total).toBe(0);
});

test('more than 2000 earlier records remain countable and selected document authority remains readable', async () => {
  const earlier = Array.from({ length: 2001 }, (_, n) => ({ paralegalId: new Types.ObjectId(), note: `Earlier ${n}`, status: 'pending', appliedAt: new Date(Date.UTC(2026, 1, 1, 0, n)), resumeURL: `resumes/synthetic-${n}.pdf` }));
  await Case.collection.updateOne({ _id: matter._id }, { $set: { applicants: earlier } });
  const response = await inventory(owner, { page: 81 });
  expect({ status: response.status, body: response.status === 200 ? null : response.body }).toEqual({ status: 200, body: null });
  expect(response.body).toMatchObject({ total: 2002, pages: 81, applications: expect.any(Array) }); expect(response.body.applications).toHaveLength(2);
  const selected = await read(owner, `&applicantId=${earlier[2000].paralegalId}`);
  expect(selected.status).toBe(200); expect(selected.body.applications[0]).toMatchObject({ coverLetter: 'Earlier 2000', resumeRecorded: true });
});

test('duplicates across canonical BSON and text references fail closed even when separated across pages', async () => {
  const duplicate = { _id: new Types.ObjectId('000000000000000000000001'), jobId: String(jobId), paralegalId: String(para._id), status: 'submitted', coverLetter: 'PRIVATE_DUPLICATE' };
  await Application.collection.insertOne(duplicate);
  const response = await inventory(); expect(response.status).toBe(409); expect(response.body.code).toBe('APPLICATION_REVIEW_SOURCE_INVALID'); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_DUPLICATE');
});

test('missing or malformed sources report incomplete readable counts and never disclose private fields', async () => {
  await Job.deleteOne({ _id: jobId });
  await Case.collection.updateOne({ _id: matter._id }, { $push: { applicants: { paralegalId: 'broken', note: 'PRIVATE_MALFORMED' } } });
  const response = await inventory(); expect(response.status).toBe(200); expect(response.body).toMatchObject({ total: 1, complete: false, warnings: ['posting_missing', 'unreadable_records'] });
  expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|resumeURL|linkedInURL|actorId|password|email|syncError/);
});

test('owner role account and query guards precede inventory presentation', async () => {
  for (const actor of [other, para]) expect([403,404]).toContain((await inventory(actor)).status);
  expect((await inventory(admin)).status).toBe(200);
  for (const query of [{ page: '0' }, { page: '1000001' }, { sort: 'random' }, { status: 'paid' }, { q: 'x'.repeat(201) }, { applicantId: 'wrong' }, { cursor: 'm:25' }]) expect((await inventory(owner, query)).status).toBe(400);
  expect((await request(app).get(`/api/cases/${matter._id}/application-inventory`).query({expectedOwnerId:String(other._id)}).set('Cookie',authCookieFor(owner))).status).toBe(403);
});

test('a changed letter during page hydration withholds the earlier page', async () => {
  const original = Application.collection.find.bind(Application.collection); let changed = false;
  jest.spyOn(Application.collection, 'find').mockImplementation((...args) => {
    const cursor = original(...args), toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async () => { const rows = await toArray(); if (!changed) { changed = true; await Application.collection.updateOne({_id:applicationId},{$set:{coverLetter:'Later letter'}}); } return rows; }; return cursor;
  });
  const response = await inventory(); expect(response.status).toBe(409); expect(response.body.code).toBe('APPLICATION_REVIEW_CHANGED'); expect(JSON.stringify(response.body)).not.toContain('Synthetic cover letter');
});
