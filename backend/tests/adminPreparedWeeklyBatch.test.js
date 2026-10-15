jest.mock("axios");
jest.mock("../services/marketing/linkedinPublisher", () => ({
  ...jest.requireActual("../services/marketing/linkedinPublisher"),
  publishLinkedInCompanyPost: jest.fn(),
}));
const express = require("express"), cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken"), request = require("supertest"), axios = require("axios");
const User = require("../models/User"), Packet = require("../models/MarketingDraftPacket");
const Cycle = require("../models/MarketingPublishingCycle"), Task = require("../models/ApprovalTask");
const Intent = require("../models/MarketingPublishIntent"), Attempt = require("../models/MarketingPublishAttempt");
const Record = require("../models/DirectorOutreachRecord"), Event = require("../models/DirectorOutreachEvent");
const publisher = require("../services/marketing/linkedinPublisher");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
process.env.JWT_SECRET = process.env.JWT_SECRET || "admin-prepared-weekly-local-secret";
const app = express(); app.use(cookieParser(), express.json());
for (const [path, module] of [["knowledge", "adminKnowledge"], ["marketing", "adminMarketing"], ["approvals", "adminApprovals"], ["directors", "adminDirectors"]]) {
  app.use("/api/admin/" + path, require("../routes/" + module));
}
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message }));
async function user(role) {
  return User.create({ firstName: "Synthetic", lastName: role, email: `prepared-weekly-${role}@example.test`, password: "Password123!", role, status: "approved", emailVerified: true, state: "CA" });
}
function cookie(actor) {
  return "token=" + jwt.sign({ id: String(actor._id), role: actor.role, email: actor.email, status: actor.status, av: Number(actor.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "2h" });
}
function authenticated(actor, method, path) { return request(app)[method](path).set("Cookie", cookie(actor)); }
beforeAll(connect); afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); axios.get.mockReset(); axios.post.mockReset(); publisher.publishLinkedInCompanyPost.mockReset(); });
afterEach(() => { expect(axios.get).not.toHaveBeenCalled(); expect(axios.post).not.toHaveBeenCalled(); expect(publisher.publishLinkedInCompanyPost).not.toHaveBeenCalled(); });

test("an owner-prepared weekly batch has actual drafts and canonical review records, including older unfinished work", async () => {
  const admin = await user("admin");
  expect((await authenticated(admin, "post", "/api/admin/knowledge/sync").send({})).status).toBe(200);
  const settings = await authenticated(admin, "post", "/api/admin/marketing/publishing/settings")
    .send({ isEnabled: false, cadenceMode: "manual_only", maxOpenCycles: 2 });
  expect(settings.status).toBe(200);
  expect(settings.body.settings).toMatchObject({ isEnabled: false, cadenceMode: "manual_only", maxOpenCycles: 2 });
  const cycles = [];
  for (const cycleLabel of ["Earlier owner-prepared batch", "Current owner-prepared batch"]) {
    const prepared = await authenticated(admin, "post", "/api/admin/marketing/publishing/cycles").send({ cycleLabel });
    expect(prepared.status).toBe(201); expect(prepared.body.created).toBe(true);
    const cycle = prepared.body.cycle; expect(cycle.channels.linkedin_company.packetId).toBeTruthy();
    const packet = await Packet.findById(cycle.channels.linkedin_company.packetId).lean();
    expect(packet).toMatchObject({ workflowType: "linkedin_company_post", approvalState: "pending_review" });
    expect(packet.channelDraft.body).toEqual(expect.any(String)); expect(packet.channelDraft.body.trim().length).toBeGreaterThan(0);
    expect(packet.approvedFactCards.length).toBeGreaterThan(0); expect(packet.citations.length).toBeGreaterThan(0);
    const task = await Task.findOne({ targetType: "marketing_draft_packet", targetId: String(packet._id) }).lean();
    expect(task).toMatchObject({ taskType: "marketing_review", approvalState: "pending" });
    const review = await authenticated(admin, "get", "/api/admin/approvals/items/" + encodeURIComponent("marketing_draft_packet:" + packet._id));
    expect(review.status).toBe(200); expect(review.body.item.workKey).toBe("marketing_draft_packet:" + packet._id);
    expect(review.body.item.currentStatus).toBe("pending"); expect(review.body.item.detail.channelDraft.body).toBe(packet.channelDraft.body);
    const readiness = await authenticated(admin, "post", `/api/admin/marketing/draft-packets/${packet._id}/publish-readiness`).send({});
    expect(readiness.status).toBe(200); expect(readiness.body.readiness).toMatchObject({ status: "blocked", isReady: false });
    expect(readiness.body.readiness.blockers).toContain("Packet must be approved before it can be published.");
    expect(readiness.body.readiness.publishTextLength).toBeGreaterThan(0);
    expect(readiness.body.readiness.connection.status).not.toBe("connected_validated");
    cycles.push(cycle);
  }
  const older = new Date(Date.now() - 8 * 86400000);
  await Packet.collection.updateOne({ _id: (await Packet.findById(cycles[0].channels.linkedin_company.packetId))._id }, { $set: { createdAt: older, updatedAt: older } });
  const snapshot = await Packet.find().sort({ _id: 1 }).lean(), tasks = await Task.find({ targetType: "marketing_draft_packet" }).sort({ _id: 1 }).lean();
  const weekly = await authenticated(admin, "get", "/api/admin/marketing/weekly-review");
  expect(weekly.status).toBe(200); expect(weekly.body.total).toBe(2); expect(weekly.body.limited).toBe(false);
  expect(weekly.body.items).toEqual([
    expect.objectContaining({ id: String(cycles[0].channels.linkedin_company.packetId), title: "Earlier owner-prepared batch", olderPending: true, reviewAvailable: true }),
    expect.objectContaining({ id: String(cycles[1].channels.linkedin_company.packetId), title: "Current owner-prepared batch", olderPending: false, reviewAvailable: true }),
  ]);
  expect(await Packet.find().sort({ _id: 1 }).lean()).toEqual(snapshot);
  expect(await Task.find({ targetType: "marketing_draft_packet" }).sort({ _id: 1 }).lean()).toEqual(tasks);
  expect(await Cycle.countDocuments()).toBe(2); expect(await Intent.countDocuments()).toBe(0); expect(await Attempt.countDocuments()).toBe(0);
  const para = await user("paralegal");
  expect((await authenticated(para, "get", "/api/admin/marketing/weekly-review")).status).toBe(403);
});

test("Director oversight respects its displayed limit while full CSV and canonical history retain every real record", async () => {
  const admin = await user("admin"), director = await user("director");
  const records = await Record.insertMany(Array.from({ length: 51 }, (_, index) => ({
    directorUserId: director._id, directorEmail: director.email,
    attorneyEmail: `actual-referral-${index}@example.test`, attorneyName: `Synthetic referral ${index}`,
    state: "CA", stage: "founder_attention", founderAttentionAt: new Date(Date.now() - index * 1000),
    metadata: { localEvidence: true },
  })));
  const overview = await authenticated(admin, "get", "/api/admin/directors/overview?limit=50");
  expect(overview.status).toBe(200); expect(overview.body.ownerId).toBe(String(admin._id));
  expect(overview.headers["cache-control"]).toContain("no-store"); expect(overview.body.totalRecords).toBe(51); expect(overview.body.records).toHaveLength(50);
  expect(overview.body.directors).toHaveLength(1); expect(overview.body.directors[0].userId).toBe(String(director._id));
  const shown = new Set(overview.body.records.map(record => record.id)), excluded = records.find(record => !shown.has(String(record._id)));
  expect(excluded).toBeTruthy();
  const event = await Event.create({ recordId: excluded._id, directorUserId: director._id, directorEmail: director.email,
    attorneyEmail: excluded.attorneyEmail, eventType: "reply_received", summary: "Retained synthetic reply history", provider: "local", providerMessageId: "bounded-full-history" });
  const csv = await authenticated(admin, "get", "/api/admin/directors/records.csv");
  expect(csv.status).toBe(200); expect(csv.headers["content-type"]).toContain("text/csv");
  expect(csv.text.trim().split(/\r?\n/)).toHaveLength(52);
  for (const record of records) expect(csv.text).toContain(record.attorneyEmail);
  const history = await authenticated(admin, "get", `/api/admin/directors/records/${excluded._id}/audit`);
  expect(history.status).toBe(200); expect(history.body.record.id).toBe(String(excluded._id));
  expect(history.body.events).toEqual(expect.arrayContaining([expect.objectContaining({ id: String(event._id), summary: "Retained synthetic reply history" })]));
  expect(await Record.countDocuments()).toBe(51);
  for (const record of await Record.find().lean()) { expect(record.commissionPayoutStatus).toBe("unpaid"); expect(record.commissionPaymentVersion).toBe(0); }
  expect((await authenticated(director, "get", "/api/admin/directors/records.csv")).status).toBe(403);
});
