const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_phase3_access_loss";
process.env.EMAIL_DISABLE = "true";
process.env.S3_BUCKET = process.env.S3_BUCKET || "phase3-test-bucket";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/s3Client", () => ({
  createS3Client: () => ({ send: jest.fn(async () => ({ Body: Buffer.from("phase3") })) }),
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(async () => "https://object-storage.test/phase3-signed"),
}));
jest.mock("../utils/stripe", () => ({
  accounts: { retrieve: jest.fn(async () => ({ details_submitted: true, charges_enabled: true, payouts_enabled: true })) },
  customers: { create: jest.fn(), retrieve: jest.fn(), update: jest.fn() },
  paymentMethods: { retrieve: jest.fn(), attach: jest.fn() },
  paymentIntents: { create: jest.fn(), retrieve: jest.fn(), cancel: jest.fn() },
  transfers: { create: jest.fn() },
  refunds: { create: jest.fn() },
  isTransferablePaymentIntent: jest.fn(() => ({ transferable: true })),
  sanitizeStripeError: jest.fn((_error, fallback) => fallback),
  caseTransferGroup: jest.fn((caseId) => `case_${String(caseId)}`),
  getPaymentIntentCharge: jest.fn(() => null),
  stripeIdempotencyKey: jest.fn((operation, ...parts) => `phase3_${operation}_${parts.join("_")}`),
}));
jest.mock("../services/caseLifecycle", () => ({
  generateArchiveZip: jest.fn(async () => ({ key: "cases/phase3/archive.zip", readyAt: new Date() })),
  buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%phase3")),
  uploadPdfToS3: jest.fn(async () => ({ key: "cases/phase3/receipt.pdf" })),
  getReceiptKey: jest.fn((caseId, kind) => `cases/${caseId}/receipt-${kind}.pdf`),
}));

const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Notification = require("../models/Notification");
const Block = require("../models/Block");
const AuthSession = require("../models/AuthSession");
const casesRouter = require("../routes/cases");
const jobsRouter = require("../routes/jobs");
const applicationsRouter = require("../routes/applications");
const messagesRouter = require("../routes/messages");
const uploadsRouter = require("../routes/uploads");
const disputesRouter = require("../routes/disputes");
const blocksRouter = require("../routes/blocks");
const notificationsRouter = require("../routes/notifications");
const accountRouter = require("../routes/account");
const authRouter = require("../routes/auth");
const attorneyDashboardRouter = require("../routes/attorneyDashboard");
const paralegalDashboardRouter = require("../routes/paralegalDashboard");
const adminRouter = require("../routes/admin");
const { getSupportContextSnapshot } = require("../services/support/contextResolverService");
const { executeParalegalSupportTool } = require("../ai/paralegalSupportAgentTools");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const {
  createPhase2Actors,
  createPhase3ActiveMatter,
  createPhase3OpenMatter,
} = require("./helpers/phase2LifecycleFixture");

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", authRouter);
app.use("/api/account", accountRouter);
app.use("/api/cases", casesRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/applications", applicationsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/disputes", disputesRouter);
app.use("/api/blocks", blocksRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/attorney/dashboard", attorneyDashboardRouter);
app.use("/api/paralegal/dashboard", paralegalDashboardRouter);
app.use("/api/admin", adminRouter);
app.use((err, _req, res, _next) => res.status(500).json({ error: err?.message || "Server error" }));

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

function ids(items = []) {
  return new Set((Array.isArray(items) ? items : []).map((item) =>
    String(item?.caseId?._id || item?.caseId || item?.id || item?._id || "")
  ));
}

async function expectWorkspaceDenied(actors, matter, { directCaseStatus = [403, 404] } = {}) {
  const attempts = Object.fromEntries(await Promise.all(Object.entries({
    directCase: request(app).get(`/api/cases/${matter.caseDoc._id}`).set("Cookie", actors.cookies.paralegal),
    listMessages: request(app).get(`/api/messages/${matter.caseDoc._id}`).set("Cookie", actors.cookies.paralegal),
    sendMessage: request(app).post(`/api/messages/${matter.caseDoc._id}`).set("Cookie", actors.cookies.paralegal).send({ text: "stale message" }),
    listFiles: request(app).get(`/api/uploads/case/${matter.caseDoc._id}?presentation=matter`).set("Cookie", actors.cookies.paralegal),
    downloadFile: request(app).get(`/api/uploads/case/${matter.caseDoc._id}/${matter.file._id}/download`).set("Cookie", actors.cookies.paralegal),
  }).map(async ([name, pending]) => [name, await pending])));
  expect(directCaseStatus).toContain(attempts.directCase.status);
  ["listMessages", "sendMessage", "listFiles", "downloadFile"].forEach((name) => {
    if (![400, 403, 404, 409].includes(attempts[name].status)) {
      throw new Error(`${name} remained available with HTTP ${attempts[name].status}`);
    }
  });
  return attempts;
}

async function recommendationExclusions(actors) {
  const response = await request(app)
    .get("/api/applications/recommendation-exclusions")
    .set("Cookie", actors.cookies.paralegal);
  expect(response.status).toBe(200);
  return new Set((response.body.matterIds || []).map(String));
}

describe("Phase 3 loss-of-access characterization", () => {
  test("1. rejection removes the active application but preserves history and recommendation exclusion", async () => {
    const actors = await createPhase2Actors();
    const matter = await createPhase3OpenMatter({ actors, applicantIds: [actors.paralegal._id] });
    const rejected = await request(app)
      .post(`/api/cases/${matter.caseDoc._id}/applicants/${actors.paralegal._id}/reject`)
      .set("Cookie", actors.cookies.attorney);
    expect(rejected.status).toBe(200);
    expect((await Application.findById(matter.applications[0]._id).lean()).status).toBe("rejected");
    const dashboard = await request(app).get("/api/paralegal/dashboard").set("Cookie", actors.cookies.paralegal);
    expect(ids(dashboard.body.myApplications)).not.toContain(String(matter.applications[0]._id));
    const exclusions = await recommendationExclusions(actors);
    expect(exclusions.has(String(matter.job._id)) || exclusions.has(String(matter.caseDoc._id))).toBe(true);
    const staleWithdraw = await request(app)
      .post(`/api/applications/${matter.applications[0]._id}/revoke`)
      .set("Cookie", actors.cookies.paralegal);
    expect([400, 409]).toContain(staleWithdraw.status);
    expect(await Application.countDocuments({ jobId: matter.job._id, paralegalId: actors.paralegal._id })).toBe(1);
  });

  test("2. an admin revokes a pending invitation through the existing decline decision", async () => {
    const actors = await createPhase2Actors();
    const matter = await createPhase3OpenMatter({ actors, invitedParalegalIds: [actors.paralegal._id] });
    const before = await request(app).get("/api/cases/invited-to").set("Cookie", actors.cookies.paralegal);
    expect(ids(before.body.items)).toContain(String(matter.caseDoc._id));
    const revoked = await request(app)
      .post(`/api/cases/${matter.caseDoc._id}/respond-invite`)
      .set("Cookie", actors.cookies.admin)
      .send({ decision: "decline", paralegalId: String(actors.paralegal._id) });
    expect(revoked.status).toBe(200);
    const after = await request(app).get("/api/cases/invited-to").set("Cookie", actors.cookies.paralegal);
    expect(ids(after.body.items)).not.toContain(String(matter.caseDoc._id));
    const stored = await Case.findById(matter.caseDoc._id).lean();
    expect(stored.invites.find((item) => String(item.paralegalId) === String(actors.paralegal._id)).status).toBe("declined");
  });

  test("3. stale invitation acceptance fails after another tab makes it unavailable", async () => {
    const actors = await createPhase2Actors();
    const matter = await createPhase3OpenMatter({ actors, invitedParalegalIds: [actors.paralegal._id] });
    await request(app)
      .post(`/api/cases/${matter.caseDoc._id}/respond-invite`)
      .set("Cookie", actors.cookies.admin)
      .send({ decision: "decline", paralegalId: String(actors.paralegal._id) })
      .expect(200);
    const notificationCount = await Notification.countDocuments({ userId: actors.attorney._id });
    const staleAccept = await request(app)
      .post(`/api/cases/${matter.caseDoc._id}/invite/accept`)
      .set("Cookie", actors.cookies.paralegal);
    expect([400, 409]).toContain(staleAccept.status);
    expect(await Notification.countDocuments({ userId: actors.attorney._id })).toBe(notificationCount);
    expect((await Case.findById(matter.caseDoc._id).lean()).paralegalId).toBeFalsy();
  });

  test("4. hiring another paralegal invalidates stale Apply, Details, and direct links", async () => {
    const actors = await createPhase2Actors();
    const matter = await createPhase3OpenMatter({
      actors,
      applicantIds: [actors.paralegal._id, actors.otherParalegal._id],
    });
    await Promise.all([
      Case.updateOne({ _id: matter.caseDoc._id }, {
        $set: {
          status: "in progress",
          paralegal: actors.otherParalegal._id,
          paralegalId: actors.otherParalegal._id,
          escrowStatus: "funded",
          escrowIntentId: "pi_phase3_hired",
          tasksLocked: true,
          "applicants.0.status": "rejected",
          "applicants.1.status": "accepted",
        },
      }),
      Job.updateOne({ _id: matter.job._id }, { $set: { status: "assigned" } }),
      Application.updateOne({ jobId: matter.job._id, paralegalId: actors.paralegal._id }, { $set: { status: "rejected" } }),
      Application.updateOne({ jobId: matter.job._id, paralegalId: actors.otherParalegal._id }, { $set: { status: "accepted" } }),
    ]);
    const staleApply = await request(app)
      .post(`/api/jobs/${matter.job._id}/apply`)
      .set("Cookie", actors.cookies.paralegal)
      .send({ coverLetter: "stale apply" });
    expect([400, 403, 404, 409]).toContain(staleApply.status);
    const staleDetails = await request(app).get(`/api/cases/${matter.caseDoc._id}`).set("Cookie", actors.cookies.paralegal);
    expect([403, 404]).toContain(staleDetails.status);
    expect(await Application.countDocuments({ jobId: matter.job._id, paralegalId: actors.paralegal._id })).toBe(1);
    const exclusions = await recommendationExclusions(actors);
    expect(exclusions.has(String(matter.job._id)) || exclusions.has(String(matter.caseDoc._id))).toBe(true);
  });

  test("5. active withdrawal closes live workspace while retaining cutoff-limited specialized Assistant evidence", async () => {
    const actors = await createPhase2Actors();
    const matter = await createPhase3ActiveMatter({ actors });
    const withdrawn = await request(app)
      .post(`/api/cases/${matter.caseDoc._id}/withdraw`)
      .set("Cookie", actors.cookies.paralegal);
    expect(withdrawn.status).toBe(200);
    const staleWorkspace = await expectWorkspaceDenied(actors, matter, { directCaseStatus: [200] });
    expect(staleWorkspace.directCase.body.tasks).toEqual([]);
    expect(staleWorkspace.directCase.body.files).toEqual([]);
    const stored = await Case.findById(matter.caseDoc._id).lean();
    expect(stored).toMatchObject({ status: "paused", pausedReason: "paralegal_withdrew", payoutFinalizedType: "zero_auto" });
    expect(String(stored.withdrawnParalegalId)).toBe(String(actors.paralegal._id));
    const specialized = await executeParalegalSupportTool({
      name: "get_paralegal_case_workspace",
      args: { case_reference: matter.caseDoc.title },
      context: { user: actors.paralegal },
    });
    expect(specialized).toMatchObject({ available: true, relationship: "withdrawn", readOnly: true });
    const general = await getSupportContextSnapshot({
      user: actors.paralegal,
      pageContext: { caseId: String(matter.caseDoc._id), pathname: "/case-detail.html" },
    });
    expect(general.supportFacts.caseState.accessible).toBe(false);
    const notifications = await request(app).get("/api/notifications").set("Cookie", actors.cookies.paralegal);
    expect(notifications.status).toBe(200);
    const staleDeepLink = notifications.body.find((item) => String(item.id) === String(matter.notification._id));
    expect(staleDeepLink).toMatchObject({
      message: "This notification is no longer available.",
      action: { label: "", href: "" },
    });
  });

  test("6. an attorney dispute closes active workspace and exposes the dispute to admin", async () => {
    const actors = await createPhase2Actors();
    const matter = await createPhase3ActiveMatter({ actors });
    const disputed = await request(app)
      .post(`/api/disputes/${matter.caseDoc._id}`)
      .set("Cookie", actors.cookies.attorney)
      .send({ message: "Phase 3 authoritative review" });
    expect(disputed.status).toBe(201);
    await expectWorkspaceDenied(actors, matter, { directCaseStatus: [200] });
    const stored = await Case.findById(matter.caseDoc._id).lean();
    expect(stored.status).toBe("disputed");
    expect(stored.disputes.filter((item) => item.status === "open")).toHaveLength(1);
    const admin = await request(app).get("/api/disputes/admin?status=open").set("Cookie", actors.cookies.admin);
    expect(admin.status).toBe(200);
    expect(JSON.stringify(admin.body)).toContain(String(matter.caseDoc._id));
  });

  test("7. completion removes live paralegal workspace and moves the matter to completed history", async () => {
    const actors = await createPhase2Actors();
    const matter = await createPhase3ActiveMatter({ actors });
    const completedAt = new Date("2026-09-03T12:00:00.000Z");
    await Case.updateOne({ _id: matter.caseDoc._id }, { $set: {
      status: "completed",
      archived: true,
      readOnly: true,
      completedAt,
      paymentReleased: true,
      paidOutAt: completedAt,
      payoutFinalizedAt: completedAt,
      payoutFinalizedType: "full",
      paralegalAccessRevokedAt: completedAt,
    } });
    await expectWorkspaceDenied(actors, matter);
    const completed = await request(app).get("/api/cases/my-completed").set("Cookie", actors.cookies.paralegal);
    expect(completed.status).toBe(200);
    expect(ids(completed.body.items)).toContain(String(matter.caseDoc._id));
    const attorneyHistory = await request(app).get("/api/cases/my?archived=true").set("Cookie", actors.cookies.attorney);
    expect(attorneyHistory.status).toBe(200);
    expect(JSON.stringify(attorneyHistory.body)).toContain(String(matter.caseDoc._id));
  });

  test("8. a qualifying application-screening Block suppresses future interaction without deleting history", async () => {
    const actors = await createPhase2Actors();
    const matter = await createPhase3OpenMatter({ actors, applicantIds: [actors.paralegal._id] });
    const blocked = await request(app)
      .post("/api/blocks")
      .set("Cookie", actors.cookies.attorney)
      .send({ caseId: String(matter.caseDoc._id), paralegalId: String(actors.paralegal._id), reason: "Phase 3 safety test" });
    expect(blocked.status).toBe(201);
    expect(await Block.countDocuments({ blockerId: actors.attorney._id, blockedId: actors.paralegal._id, active: true })).toBe(1);
    const browse = await request(app).get("/api/jobs/open").set("Cookie", actors.cookies.paralegal);
    expect(ids(browse.body)).not.toContain(String(matter.caseDoc._id));
    const staleDetails = await request(app).get(`/api/cases/${matter.caseDoc._id}`).set("Cookie", actors.cookies.paralegal);
    expect([403, 404]).toContain(staleDetails.status);
    expect(await Application.countDocuments({ jobId: matter.job._id, paralegalId: actors.paralegal._id })).toBe(1);
  });

  test("9. account deactivation revokes participation but retains the historical application record", async () => {
    const actors = await createPhase2Actors();
    const matter = await createPhase3OpenMatter({ actors, applicantIds: [actors.paralegal._id], invitedParalegalIds: [actors.paralegal._id] });
    const deactivated = await request(app).delete("/api/account/deactivate").set("Cookie", actors.cookies.paralegal);
    expect(deactivated.status).toBe(200);
    const user = await User.findById(actors.paralegal._id).lean();
    expect(user.disabled).toBe(true);
    expect(user.deleted).toBe(true);
    const historical = await Application.findById(matter.applications[0]._id).lean();
    expect(historical.status).toBe("rejected");
    const storedCase = await Case.findById(matter.caseDoc._id).lean();
    expect(storedCase.invites.find((item) => String(item.paralegalId) === String(actors.paralegal._id)).status).toBe("expired");
    const staleDashboard = await request(app).get("/api/paralegal/dashboard").set("Cookie", actors.cookies.paralegal);
    expect(staleDashboard.status).toBe(403);
  });

  test("10. revoking another managed session blocks its stale dashboard and workspace requests", async () => {
    const actors = await createPhase2Actors();
    actors.paralegal.emailVerified = true;
    await actors.paralegal.save();
    const first = request.agent(app);
    const second = request.agent(app);
    const credentials = { email: actors.paralegal.email, password: "Password123!" };
    expect((await first.post("/api/auth/login").send(credentials)).status).toBe(200);
    expect((await second.post("/api/auth/login").send(credentials)).status).toBe(200);
    expect(await AuthSession.countDocuments({ userId: actors.paralegal._id, revokedAt: null })).toBe(2);
    const revoked = await first.post("/api/account/sessions/revoke-others");
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedCount).toBe(1);
    expect((await first.get("/api/paralegal/dashboard")).status).toBe(200);
    expect((await second.get("/api/paralegal/dashboard")).status).toBe(403);
    expect(await AuthSession.countDocuments({ userId: actors.paralegal._id, revokedAt: null })).toBe(1);
  });
});
