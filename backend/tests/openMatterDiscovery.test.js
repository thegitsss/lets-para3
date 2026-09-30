const express = require("express"), cookieParser = require("cookie-parser"), request = require("supertest"), jwt = require("jsonwebtoken"), mongoose = require("mongoose");
const User = require("../models/User"), Case = require("../models/Case"), Job = require("../models/Job"), Application = require("../models/Application"), Block = require("../models/Block");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { addCalendarDays, dateOnlyFromZonedInstant } = require("../utils/businessDate");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/stripe", () => ({ accounts: { retrieve: jest.fn() } }));
const app = express(); app.use(cookieParser(), express.json()); app.use("/api/jobs", require("../routes/jobs"));
let attorney, viewer;
const id = () => new mongoose.Types.ObjectId();
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, status: user.status }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
const read = query => request(app).get("/api/jobs/open").query({ view: "browse", ...query }).set("Cookie", cookie(viewer));
const matter = (extra = {}) => ({ _id: id(), attorney: attorney._id, attorneyId: attorney._id, paralegal: null, paralegalId: null, title: "Open Matter", details: "Review the supplied scope.", practiceArea: "immigration", state: "CA", totalAmount: 60000, status: "open", archived: false, tasks: [], createdAt: new Date("2026-09-01T12:00:00Z"), ...extra });
const job = (extra = {}) => ({ _id: id(), attorneyId: attorney._id, caseId: null, title: "Standalone posting", description: "Review the supplied scope.", practiceArea: "immigration", state: "CA", budget: 600, status: "open", createdAt: new Date("2026-09-02T12:00:00Z"), ...extra });
beforeAll(async () => { await connect(); await Promise.all([Case.init(), Job.init(), Application.init()]); });
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [attorney, viewer] = await User.create(["attorney", "paralegal"].map(role => ({ firstName: role, lastName: "Discovery", email: `${role}@discovery.test`, password: "Password123!", role, status: "approved", state: role === "paralegal" ? "NY" : "CA", practiceAreas: ["Contract Law"], yearsExperience: 6 })));
});

test("filters and recommendations reach an older matching Matter beyond both former caps", async () => {
  const older = matter({ title: "Older New York contract", practiceArea: "contract law", state: "NY", createdAt: new Date("2020-01-01T12:00:00Z"), totalAmount: 90000 });
  await Case.collection.insertMany([...Array.from({ length: 1001 }, (_, index) => matter({ title: `Other Matter ${index}` })), older]);
  const filtered = await read({ practice: "contract law", state: "New York" });
  expect(filtered.status).toBe(200); expect(filtered.body).toMatchObject({ total: 1, availableTotal: 1002, page: 1, limit: 12 });
  expect(filtered.body.items.map(item => item.title)).toEqual([older.title]);
  expect(filtered.body.facets.states).toEqual(["CA", "NY"]);
  const preferred = await read({}); expect(preferred.body.filters.state).toBe("NY"); expect(preferred.body.items[0].title).toBe(older.title);
  const recommended = await request(app).get("/api/jobs/recommended?limit=1").set("Cookie", cookie(viewer));
  expect(recommended.status).toBe(200); expect(recommended.body.items.map(item => item.title)).toEqual([older.title]); expect(recommended.body.total).toBe(1);
});

test("global sorting, paging and totals include standalone Jobs and stable ties without duplicates", async () => {
  const cases = Array.from({ length: 17 }, (_, index) => matter({ title: `Matter ${index}`, totalAmount: 40000 + index * 1000 }));
  const jobs = Array.from({ length: 9 }, (_, index) => job({ title: `Posting ${index}`, budget: 1000 + index }));
  await Case.collection.insertMany(cases); await Job.collection.insertMany(jobs);
  const seen = [];
  for (const page of [1, 2, 3]) {
    const result = await read({ state: "", page }); expect(result.status).toBe(200); expect(result.body.total).toBe(26);
    seen.push(...result.body.items.map(item => item.id));
    expect(result.body.items.length).toBe(page === 3 ? 2 : 12);
  }
  expect(new Set(seen).size).toBe(26); expect(seen.slice(0, 9).sort()).toEqual(jobs.map(row => String(row._id)).sort());
  const high = await read({ state: "", sort: "payHigh", limit: 1 }); expect(high.body.items[0].title).toBe("Posting 8");
  const low = await read({ state: "", sort: "payLow", limit: 1 }); expect(low.body.items[0].title).toBe("Matter 0");
  const pastEnd = await read({ state: "", page: 999 }); expect(pastEnd.body.page).toBe(3); expect(pastEnd.body.items).toHaveLength(2);
});

test("discovery joins mixed Case references without scanning unrelated open Jobs", async () => {
  const cases = Array.from({ length: 48 }, (_, index) => matter({ title: `Indexed Matter ${index}` }));
  const linked = cases.map((row, index) => job({ caseId: index % 2 ? String(row._id) : row._id, attorneyId: index % 3 ? attorney._id : String(attorney._id) }));
  cases.forEach((row, index) => { row.jobId = linked[index]._id; });
  await Case.collection.insertMany(cases);
  await Job.collection.insertMany([...linked, ...Array.from({ length: 320 }, () => job({ caseId: id() }))]);
  const { catalogPipeline } = require("../services/openMatterDiscovery");
  const pipeline = catalogPipeline(String(viewer._id), [], "newest");
  const rows = await Case.aggregate(pipeline).option({ maxTimeMS: 15000 });
  expect(rows).toHaveLength(cases.length);
  expect(rows.map(row => [String(row.caseDoc._id), String(row.job._id), row.directJobCount]).sort())
    .toEqual(cases.map((row, index) => [String(row._id), String(linked[index]._id), 1]).sort());
  const plan = await Case.aggregate(pipeline).option({ maxTimeMS: 15000 }).explain("executionStats");
  const direct = plan.stages.find(stage => stage.$lookup?.as === "_directJobs");
  expect(direct.indexesUsed).toContain("discovery_case_reference");
  expect(Number(direct.collectionScans)).toBe(0);
  expect(Number(direct.totalDocsExamined)).toBeLessThanOrEqual(cases.length * 2);
});

test("direct, retained reverse and ambiguous posting identities retain one authoritative application target", async () => {
  const directCase = matter({ title: "Direct" }), reverseCase = matter({ title: "Reverse" });
  const directJob = job({ caseId: directCase._id }), reverseJob = job(); reverseCase.jobId = String(reverseJob._id);
  const sharedJob = job(), first = matter({ title: "Ambiguous first", jobId: sharedJob._id }), second = matter({ title: "Ambiguous second", job: String(sharedJob._id) });
  await Case.collection.insertMany([directCase, reverseCase, first, second]); await Job.collection.insertMany([directJob, reverseJob, sharedJob]);
  const result = await read({ state: "" }); expect(result.status).toBe(200); expect(result.body.total).toBe(4);
  const byTitle = new Map(result.body.items.map(item => [item.title, item]));
  expect(byTitle.get("Direct").jobId).toBe(String(directJob._id)); expect(byTitle.get("Reverse").jobId).toBe(String(reverseJob._id));
  expect(byTitle.get("Ambiguous first").jobId).toBeNull(); expect(byTitle.get("Ambiguous second").jobId).toBeNull();
  const detail = await read({ state: "NY", matterId: String(reverseJob._id) }); expect(detail.body.items).toHaveLength(0); expect(detail.body.selected.id).toBe(String(reverseCase._id));
});

test("blocked, assigned, archived and stale reverse-linked postings stay excluded while finalized relists remain available", async () => {
  const blockedOwner = await User.create({ firstName: "Blocked", lastName: "Owner", email: "blocked@discovery.test", password: "Password123!", role: "attorney", status: "approved" });
  await Block.collection.insertOne({ blockerId: viewer._id, blockedId: blockedOwner._id, active: true });
  const closedJob = job(), assignedJob = job();
  await Job.collection.insertMany([closedJob, assignedJob, job({ attorneyId: blockedOwner._id })]);
  await Case.collection.insertMany([
    matter({ status: "closed", job: String(closedJob._id) }), matter({ paralegalId: viewer._id, jobId: assignedJob._id }),
    matter({ archived: true }), matter({ attorney: String(blockedOwner._id), attorneyId: blockedOwner._id }),
    matter({ title: "Finalized relist", status: "paused", payoutFinalizedAt: new Date(), payoutFinalizedType: "expired_zero" }),
    matter({ status: "paused", relistRequestedAt: new Date() }),
  ]);
  const result = await read({ state: "" }); expect(result.status).toBe(200); expect(result.body.items.map(item => item.title)).toEqual(["Finalized relist"]);
});

test("active and historical applications retain their distinct Browse, eligibility and recommendation rules", async () => {
  const ordinary = matter({ state: "NY", practiceArea: "contract law", title: "Applied" }), relist = matter({ state: "NY", practiceArea: "contract law", title: "Relisted", status: "paused", payoutFinalizedAt: new Date(), relistRequestedAt: new Date() });
  const jobs = [job({ caseId: ordinary._id }), job({ caseId: relist._id })];
  await Case.collection.insertMany([ordinary, relist]); await Job.collection.insertMany(jobs);
  await Application.collection.insertMany(jobs.map(value => ({ jobId: value._id, paralegalId: viewer._id, status: "rejected", createdAt: new Date() })));
  const result = await read({ state: "" }); expect(result.status).toBe(200); expect(result.body.items.map(item => item.title)).toEqual(["Relisted"]);
  const raw = await request(app).get("/api/jobs/open").set("Cookie", cookie(viewer)); expect(raw.body).toHaveLength(2);
  const recommended = await request(app).get("/api/jobs/recommended").set("Cookie", cookie(viewer)); expect(recommended.body.items).toEqual([]);
});

test("date and amount filters use retained deadline dates and exact remaining cents", async () => {
  const today = dateOnlyFromZonedInstant(), later = addCalendarDays(today, 5);
  await Case.collection.insertMany([
    matter({ title: "Soon", deadlineDate: later, remainingAmount: 40001 }),
    matter({ title: "No remainder", totalAmount: 90000, remainingAmount: 0 }),
    matter({ title: "Missing date", remainingAmount: 50000 }),
    matter({ title: "Invalid retained date", deadlineDate: "2026-02-31", remainingAmount: 55000 }),
  ]);
  const result = await read({ state: "", sort: "deadline", deadline: "7_days", minPay: "400.01" });
  expect(result.status).toBe(200); expect(result.body.items.map(item => item.title)).toEqual(["Soon"]);
  const none = await read({ state: "", deadline: "none" }); expect(none.body.items.map(item => item.title).sort()).toEqual(["Invalid retained date", "Missing date"]);
});

test("invalid queries and unavailable catalog reads never masquerade as an empty successful page", async () => {
  for (const query of [{ page: "0" }, { limit: "word" }, { sort: "random" }, { matterId: "not-an-id" }, { minPay: "Infinity" }, { state: ["NY", "CA"] }]) expect((await read(query)).status).toBe(400);
  const aggregate = jest.spyOn(Case, "aggregate").mockImplementationOnce(() => { throw new Error("Synthetic catalog outage"); });
  try { expect((await read({ state: "" })).status).toBe(500); } finally { aggregate.mockRestore(); }
  expect((await request(app).get("/api/jobs/open?view=browse").set("Cookie", cookie(attorney))).status).toBe(403);
});

test("inconsistent posting links remain reviewable without promising an application the attorney cannot reconcile", async () => {
  const earlier = job(), first = matter({ title: "Earlier reverse", state: "NY", practiceArea: "contract law", jobId: earlier._id });
  const missing = matter({ title: "Missing posting", jobId: id() });
  const duplicate = matter({ title: "Duplicate postings" });
  await Case.collection.insertMany([first, missing, duplicate]);
  await Job.collection.insertMany([earlier, job({ caseId: duplicate._id }), job({ caseId: String(duplicate._id) })]);
  const result = await read({ state: "" }); expect(result.status).toBe(200); expect(result.body.total).toBe(3);
  for (const item of result.body.items) {
    expect(item.applicationTargetVerified).toBe(false);
    expect(item.applicationEligibility.ready).toBe(false);
    expect(item.applicationEligibility.blockers).toContain("posting_verification_required");
  }
  const recommended = await request(app).get("/api/jobs/recommended").set("Cookie", cookie(viewer));
  expect(recommended.status).toBe(200); expect(recommended.body.items).toEqual([]);
});

test("unknown retained posting dates cannot qualify as recently posted", async () => {
  await Case.collection.insertMany([matter({ createdAt: "unknown" }), matter({ createdAt: null }), matter({ title: "Recent", createdAt: new Date() })]);
  const result = await read({ state: "", posted: "7_days" });
  expect(result.status).toBe(200); expect(result.body.items.map(item => item.title)).toEqual(["Recent"]);
});

test.each(["jobId", "job"])("retained string %s links preserve permanent recommendation exclusions after the old Job closes", async field => {
  const posting = job({ status: "closed" }), doc = matter({ state: "NY", practiceArea: "contract law", [field]: String(posting._id) });
  await Job.collection.insertOne(posting); await Case.collection.insertOne(doc);
  await Application.collection.insertOne({ jobId: posting._id, paralegalId: String(viewer._id), status: "withdrawn", createdAt: new Date() });
  const browse = await read({ state: "" }); expect(browse.status).toBe(200); expect(browse.body.items[0].id).toBe(String(doc._id)); expect(browse.body.items[0].jobId).toBeNull();
  const recommended = await request(app).get("/api/jobs/recommended").set("Cookie", cookie(viewer)); expect(recommended.status).toBe(200); expect(recommended.body.items).toEqual([]);
});
