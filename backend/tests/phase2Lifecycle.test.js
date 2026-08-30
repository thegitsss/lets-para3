const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_phase2_lifecycle";
process.env.EMAIL_DISABLE = "true";
process.env.S3_BUCKET = process.env.S3_BUCKET || "phase2-test-bucket";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";

const mockStripeState = {
  defaultPaymentMethodId: null,
};
const mockObjectStoreSend = jest.fn(async (command) => {
  const commandName = command?.constructor?.name || "";
  if (commandName === "HeadObjectCommand") {
    return { ContentLength: 26, ContentType: "application/pdf" };
  }
  if (commandName === "GetObjectCommand") {
    return {
      Body: {
        transformToByteArray: async () => Buffer.from("%PDF-1.4\nphase2 document"),
      },
    };
  }
  return {};
});

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/s3Client", () => ({
  createS3Client: () => ({ send: mockObjectStoreSend }),
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(async () => "https://object-storage.test/phase2-signed"),
}));
jest.mock("../utils/stripe", () => ({
  customers: {
    create: jest.fn(async () => ({ id: "cus_phase2_attorney" })),
    retrieve: jest.fn(async () => ({
      id: "cus_phase2_attorney",
      invoice_settings: { default_payment_method: mockStripeState.defaultPaymentMethodId },
    })),
    update: jest.fn(async (_customerId, update) => {
      mockStripeState.defaultPaymentMethodId = update?.invoice_settings?.default_payment_method || null;
      return { id: "cus_phase2_attorney", invoice_settings: update.invoice_settings };
    }),
  },
  paymentMethods: {
    retrieve: jest.fn(async (id) => ({
      id,
      type: "card",
      customer: "cus_phase2_attorney",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    })),
    attach: jest.fn(async (id) => ({ id, type: "card", customer: "cus_phase2_attorney" })),
  },
  setupIntents: { create: jest.fn() },
  accounts: {
    create: jest.fn(),
    retrieve: jest.fn(async () => ({ details_submitted: true, charges_enabled: true, payouts_enabled: true })),
  },
  paymentIntents: {
    create: jest.fn(async (params) => ({
      id: "pi_phase2_funding",
      status: "succeeded",
      amount: params.amount,
      amount_received: params.amount,
      currency: params.currency,
      transfer_group: params.transfer_group,
      metadata: params.metadata,
      latest_charge: { id: "ch_phase2_funding", paid: true, captured: true },
    })),
    retrieve: jest.fn(async () => ({
      id: "pi_phase2_funding",
      status: "succeeded",
      amount: 48_800,
      amount_received: 48_800,
      currency: "usd",
      transfer_group: "case_phase2",
      metadata: {},
      latest_charge: { id: "ch_phase2_funding", paid: true, captured: true },
    })),
    cancel: jest.fn(),
  },
  refunds: { create: jest.fn() },
  transfers: {
    create: jest.fn(async (params) => ({
      id: "tr_phase2_payout",
      amount: params.amount,
      currency: params.currency,
      destination: params.destination,
      transfer_group: params.transfer_group,
    })),
  },
  isTransferablePaymentIntent: jest.fn(() => ({
    transferable: true,
    charge: { id: "ch_phase2_funding", receipt_url: "https://stripe.test/phase2-receipt" },
  })),
  sanitizeStripeError: jest.fn((_error, fallback) => fallback),
  caseTransferGroup: jest.fn((caseId) => `case_${String(caseId)}`),
  getPaymentIntentCharge: jest.fn(() => ({
    id: "ch_phase2_funding",
    receipt_url: "https://stripe.test/phase2-receipt",
  })),
  stripeIdempotencyKey: jest.fn((operation, ...parts) => `phase2_${operation}_${parts.join("_")}`),
}));

jest.mock("../services/caseLifecycle", () => ({
  generateArchiveZip: jest.fn(async () => ({
    key: "cases/phase2/archive.zip",
    readyAt: new Date("2026-09-02T18:00:00.000Z"),
  })),
  buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%phase2")),
  uploadPdfToS3: jest.fn(async () => ({ key: "cases/phase2/receipt.pdf" })),
  getReceiptKey: jest.fn((caseId, kind) => `cases/${caseId}/receipt-${kind}.pdf`),
}));

const stripe = require("../utils/stripe");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const CaseDraft = require("../models/CaseDraft");
const CaseFile = require("../models/CaseFile");
const Message = require("../models/Message");
const Notification = require("../models/Notification");
const PaymentOperation = require("../models/PaymentOperation");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const casesRouter = require("../routes/cases");
const jobsRouter = require("../routes/jobs");
const applicationsRouter = require("../routes/applications");
const paymentsRouter = require("../routes/payments");
const caseDraftsRouter = require("../routes/caseDrafts");
const messagesRouter = require("../routes/messages");
const notificationsRouter = require("../routes/notifications");
const attorneyDashboardRouter = require("../routes/attorneyDashboard");
const paralegalDashboardRouter = require("../routes/paralegalDashboard");
const adminRouter = require("../routes/admin");
const { setApplicationStatus } = require("../services/applicationService");
const {
  ATTORNEY_WORKFLOW_STAGES,
  MIN_MATTER_AMOUNT_CENTS,
  evaluateApplicationEligibility,
  evaluateMatterPosting,
  isAttorneyPaymentMethodRequired,
} = require("../services/attorneyWorkflowPolicy");
const { getCurrentPlatformFeePolicy } = require("../services/platformFeePolicy");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { PHASE2_CLOCK, createPhase2Actors } = require("./helpers/phase2LifecycleFixture");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/cases", casesRouter);
  instance.use("/api/jobs", jobsRouter);
  instance.use("/api/applications", applicationsRouter);
  instance.use("/api/payments", paymentsRouter);
  instance.use("/api/case-drafts", caseDraftsRouter);
  instance.use("/api/messages", messagesRouter);
  instance.use("/api/notifications", notificationsRouter);
  instance.use("/api/attorney/dashboard", attorneyDashboardRouter);
  instance.use("/api/paralegal/dashboard", paralegalDashboardRouter);
  instance.use("/api/admin", adminRouter);
  instance.use((err, _req, res, _next) => {
    res.status(500).json({ error: err?.message || "Server error" });
  });
  return instance;
})();

beforeAll(connect);
afterAll(closeDatabase);
afterEach(() => jest.useRealTimers());

beforeEach(async () => {
  await clearDatabase();
  mockStripeState.defaultPaymentMethodId = null;
  jest.clearAllMocks();
  mockObjectStoreSend.mockClear();
});

function includesId(items, id, keys = ["id", "_id", "caseId"]) {
  return (Array.isArray(items) ? items : []).some((item) =>
    keys.some((key) => String(item?.[key]?._id || item?.[key] || "") === String(id))
  );
}

function listingIdentities(item = {}) {
  return [item.id, item._id, item.caseId, item.contextCaseId, item.jobId]
    .map((value) => String(value?._id || value || ""))
    .filter(Boolean);
}

async function loadLifecycleProjections({ actors, caseId, jobId }) {
  const paths = {
    attorneyDashboard: ["/api/attorney/dashboard", actors.cookies.attorney],
    paralegalDashboard: ["/api/paralegal/dashboard", actors.cookies.paralegal],
    posted: ["/api/cases/posted", actors.cookies.attorney],
    attorneyActive: ["/api/cases/my-active", actors.cookies.attorney],
    attorneyCompleted: ["/api/cases/my?archived=true", actors.cookies.attorney],
    paralegalAssigned: ["/api/cases/my-assigned", actors.cookies.paralegal],
    paralegalCompleted: ["/api/cases/my-completed", actors.cookies.paralegal],
    invitations: ["/api/cases/invited-to", actors.cookies.paralegal],
    browse: ["/api/jobs/open", actors.cookies.paralegal],
    otherBrowse: ["/api/jobs/open", actors.cookies.otherParalegal],
    exclusions: ["/api/applications/recommendation-exclusions", actors.cookies.paralegal],
    otherExclusions: ["/api/applications/recommendation-exclusions", actors.cookies.otherParalegal],
    applications: ["/api/applications/my", actors.cookies.paralegal],
    candidates: ["/api/applications/my-postings", actors.cookies.attorney],
    applicantPanel: [`/api/cases/${caseId}/applicants`, actors.cookies.attorney],
    adminCases: ["/api/admin/cases?limit=50", actors.cookies.admin],
    attorneyNotifications: ["/api/notifications", actors.cookies.attorney],
    paralegalNotifications: ["/api/notifications", actors.cookies.paralegal],
    search: ["/api/cases/search?q=immigration&types=matter", actors.cookies.paralegal],
    directAttorney: [`/api/cases/${caseId}`, actors.cookies.attorney],
    directParalegal: [`/api/cases/${caseId}`, actors.cookies.paralegal],
    paymentSummaryAttorney: ["/api/payments/summary", actors.cookies.attorney],
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([key, [path, cookie]]) => {
    const response = await request(app).get(path).set("Cookie", cookie);
    return [key, response];
  }));
  const result = Object.fromEntries(entries);
  result.caseDoc = await Case.findById(caseId).lean();
  result.job = await Job.findById(jobId).lean();
  result.application = await Application.findOne({ jobId, paralegalId: actors.paralegal._id }).lean();
  return result;
}

async function assertLifecycleCheckpoint({
  label,
  actors,
  caseId,
  jobId,
  applicationId,
  caseStatus,
  jobStatus,
  applicationStatus,
  attorneySection,
  paralegalSection,
  browseVisible,
  primaryHistoricallyExcluded,
  otherHistoricallyExcluded = false,
  preEngagementStatus = null,
  funded = false,
  paymentReleased = false,
  searchVisible = true,
}) {
  const state = await loadLifecycleProjections({ actors, caseId, jobId });
  for (const [name, response] of Object.entries(state)) {
    if (["caseDoc", "job", "application", "directParalegal"].includes(name)) continue;
    if (response.status !== 200) {
      throw new Error(`${label}: ${name} returned ${response.status} ${JSON.stringify(response.body)}`);
    }
  }

  expect(String(state.caseDoc?._id)).toBe(String(caseId));
  expect(String(state.caseDoc?.jobId)).toBe(String(jobId));
  expect(String(state.job?._id)).toBe(String(jobId));
  expect(String(state.job?.caseId)).toBe(String(caseId));
  expect(state.caseDoc?.status).toBe(caseStatus);
  expect(state.job?.status).toBe(jobStatus);
  expect(state.caseDoc?.paymentReleased === true).toBe(paymentReleased);
  expect(String(state.caseDoc?.escrowStatus || "") === "funded").toBe(funded);

  if (applicationStatus) {
    expect(String(state.application?._id)).toBe(String(applicationId));
    expect(state.application?.status).toBe(applicationStatus);
    expect(state.application?.syncStatus).toBe("synced");
  }
  expect(String(state.caseDoc?.postingSyncStatus || "synced")).toBe("synced");
  expect(state.caseDoc?.preEngagement?.status || null).toBe(preEngagementStatus);

  const attorneyHome = state.attorneyDashboard.body;
  const paralegalHome = state.paralegalDashboard.body;
  expect(attorneyHome.metrics.openJobs).toBe(attorneyHome.openJobs.length);
  expect(attorneyHome.metrics.pendingApplications).toBe(
    attorneyHome.pendingApplications.length
  );
  expect(paralegalHome.metrics.activeCases).toBe(
    paralegalHome.activeCases.length
  );
  expect(paralegalHome.metrics.pendingApplications).toBe(
    paralegalHome.myApplications.filter((item) => item.status === "submitted").length
  );

  const inAttorneyOpen = includesId(attorneyHome.openJobs, jobId, ["jobId", "_id", "id"]);
  const inAttorneyActive = includesId(attorneyHome.activeCases, caseId);
  const inAttorneyCompleted = includesId(state.attorneyCompleted.body, caseId);
  expect(inAttorneyOpen).toBe(attorneySection === "open");
  expect(inAttorneyActive).toBe(attorneySection === "active");
  expect(inAttorneyCompleted).toBe(attorneySection === "completed");
  expect(Number(inAttorneyActive) + Number(inAttorneyCompleted))
    .toBeLessThanOrEqual(1);

  const activeApplicationStatuses = new Set(["submitted", "viewed", "shortlisted"]);
  const inParalegalApplications = activeApplicationStatuses.has(applicationStatus) &&
    includesId(paralegalHome.myApplications, applicationId, ["applicationId", "_id", "id"]);
  const inParalegalActive = includesId(state.paralegalAssigned.body.items, caseId);
  const inParalegalCompleted = includesId(state.paralegalCompleted.body.items, caseId);
  expect(inParalegalApplications).toBe(
    paralegalSection === "application"
  );
  expect(inParalegalActive).toBe(paralegalSection === "active");
  expect(inParalegalCompleted).toBe(
    paralegalSection === "completed"
  );
  expect(Number(inParalegalActive) + Number(inParalegalCompleted))
    .toBeLessThanOrEqual(1);

  const browseListing = state.browse.body.find((item) => listingIdentities(item).includes(String(caseId)));
  expect(Boolean(browseListing)).toBe(browseVisible);
  const exclusionIds = new Set(state.exclusions.body.matterIds.map(String));
  const primaryExcluded = [String(caseId), String(jobId)].some((id) => exclusionIds.has(id));
  expect(primaryExcluded).toBe(primaryHistoricallyExcluded);
  const otherExclusionIds = new Set(state.otherExclusions.body.matterIds.map(String));
  expect([String(caseId), String(jobId)].some((id) => otherExclusionIds.has(id)))
    .toBe(otherHistoricallyExcluded);

  expect(state.invitations.body.items).toEqual([]);
  expect(includesId(state.adminCases.body.cases, caseId)).toBe(true);
  expect(includesId(state.search.body.results.matters, caseId)).toBe(searchVisible);
  expect(state.directAttorney.status).toBe(200);
  if (paymentReleased) {
    expect([403, 404]).toContain(state.directParalegal.status);
  } else {
    expect(state.directParalegal.status).toBe(200);
  }

  const activeCandidateStatuses = new Set(["submitted", "viewed", "shortlisted"]);
  const candidateActive = activeCandidateStatuses.has(applicationStatus);
  expect(includesId(state.candidates.body, applicationId)).toBe(
    candidateActive
  );
  expect(includesId(attorneyHome.pendingApplications, applicationId, ["applicationId", "_id", "id"]))
    .toBe(candidateActive);

  return state;
}

describe("Phase 2 payment-at-hire contract", () => {
  test("payment is required only at hire and funding", () => {
    expect(isAttorneyPaymentMethodRequired(ATTORNEY_WORKFLOW_STAGES.POST_MATTER)).toBe(false);
    expect(isAttorneyPaymentMethodRequired(ATTORNEY_WORKFLOW_STAGES.RECEIVE_APPLICATIONS)).toBe(false);
    expect(isAttorneyPaymentMethodRequired(ATTORNEY_WORKFLOW_STAGES.HIRE_AND_FUND)).toBe(true);

    expect(evaluateMatterPosting({
      paymentMethodSaved: false,
      title: "Phase 2 immigration matter",
      details: "Prepare the filing package and supporting evidence for attorney review.",
      practiceArea: "Immigration",
      amountCents: MIN_MATTER_AMOUNT_CENTS,
      deadlineProvided: false,
      deadlineValid: true,
    })).toMatchObject({ ready: true, blockers: [] });

    expect(evaluateApplicationEligibility({
      attorneyPaymentMethodSaved: false,
      applicantApproved: true,
      partiesBlocked: false,
      caseStatus: "open",
      jobStatus: "open",
      archived: false,
      paralegalAssigned: false,
      duplicateApplication: false,
      profilePhotoReady: true,
      payoutSetupReady: true,
    })).toMatchObject({ ready: true, blockers: [] });

    expect(getCurrentPlatformFeePolicy()).toMatchObject({ attorneyPercent: 22 });
    expect(MIN_MATTER_AMOUNT_CENTS).toBe(40_000);
  });

  test("one Case, Job, and primary Application remain coherent through the complete cross-role lifecycle", async () => {
    jest.useFakeTimers({
      now: PHASE2_CLOCK.draft,
      doNotFake: ["nextTick", "setImmediate", "setTimeout", "clearTimeout", "queueMicrotask", "hrtime", "performance"],
    });
    const actors = await createPhase2Actors();

    // 1. Draft
    const drafted = await request(app)
      .post("/api/case-drafts")
      .set("Cookie", actors.cookies.attorney)
      .send({
        title: "Phase 2 immigration lifecycle",
        practiceArea: "immigration",
        description: "Prepare an immigration filing package and organize supporting evidence for attorney review.",
        compAmount: "400",
        state: "CA",
        experience: "5+ years",
        deadline: "2026-09-15",
        tasks: [{ title: "Prepare filing package" }],
      });
    if (drafted.status !== 201) {
      throw new Error(`Draft creation failed: ${drafted.status} ${JSON.stringify(drafted.body)}`);
    }
    const draftId = drafted.body.draft.id;
    expect(await CaseDraft.countDocuments({ owner: actors.attorney._id, status: "draft" })).toBe(1);
    expect(await Case.countDocuments({ title: "Phase 2 immigration lifecycle" })).toBe(0);
    expect(await Job.countDocuments({ title: "Phase 2 immigration lifecycle" })).toBe(0);
    expect(await Application.countDocuments()).toBe(0);

    // 2. Published/open
    jest.setSystemTime(PHASE2_CLOCK.published);
    const published = await request(app)
      .post("/api/cases")
      .set("Cookie", actors.cookies.attorney)
      .send({
        title: "Phase 2 immigration lifecycle",
        practiceArea: "immigration",
        description: "Prepare an immigration filing package and organize supporting evidence for attorney review.",
        totalAmount: 400,
        state: "CA",
        experience: "5+ years",
        deadline: "2026-09-15",
        tasks: [{ title: "Prepare filing package" }],
      });

    expect(published.status).toBe(201);
    const caseDoc = await Case.findOne({ title: "Phase 2 immigration lifecycle" }).lean();
    const job = await Job.findOne({ caseId: caseDoc?._id }).lean();
    expect(caseDoc).toMatchObject({ status: "open", totalAmount: 40_000 });
    expect(job).toMatchObject({ status: "open", budget: 400 });
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    await request(app)
      .delete(`/api/case-drafts/${draftId}`)
      .set("Cookie", actors.cookies.attorney)
      .expect(200);

    await assertLifecycleCheckpoint({
      label: "2 published",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: null,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: null,
      attorneySection: "open",
      paralegalSection: "none",
      browseVisible: true,
      primaryHistoricallyExcluded: false,
    });

    const preHireMessageAttempt = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", actors.cookies.paralegal)
      .send({ text: "This hidden workspace action must remain unavailable before hire." });
    expect([403, 404]).toContain(preHireMessageAttempt.status);

    // 3. Application submitted
    jest.setSystemTime(PHASE2_CLOCK.applied);
    const applied = await request(app)
      .post(`/api/jobs/${job._id}/apply`)
      .set("Cookie", actors.cookies.paralegal)
      .send({ coverLetter: "I have eight years of relevant immigration filing experience." });

    expect(applied.status).toBe(201);
    const application = await Application.findOne({
      jobId: job._id,
      paralegalId: actors.paralegal._id,
    }).lean();
    expect(application).toMatchObject({ status: "submitted" });
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    const primaryApplicationId = application._id;

    await assertLifecycleCheckpoint({
      label: "3 application submitted",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: "submitted",
      attorneySection: "open",
      paralegalSection: "application",
      browseVisible: true,
      primaryHistoricallyExcluded: true,
    });

    // 4. Application viewed
    await setApplicationStatus({
      jobId: job._id,
      caseId: caseDoc._id,
      paralegalId: actors.paralegal._id,
      status: "viewed",
    });
    await assertLifecycleCheckpoint({
      label: "4 application viewed",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: "viewed",
      attorneySection: "open",
      paralegalSection: "application",
      browseVisible: true,
      primaryHistoricallyExcluded: true,
    });

    // 5. Shortlisted
    await setApplicationStatus({
      jobId: job._id,
      caseId: caseDoc._id,
      paralegalId: actors.paralegal._id,
      status: "shortlisted",
    });
    await assertLifecycleCheckpoint({
      label: "5 shortlisted",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: "shortlisted",
      attorneySection: "open",
      paralegalSection: "application",
      browseVisible: true,
      primaryHistoricallyExcluded: true,
    });

    // 6. Pre-engagement information requested
    const requested = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/${actors.paralegal._id}/request`)
      .set("Cookie", actors.cookies.attorney)
      .send({
        confidentialityAgreementRequired: false,
        conflictsCheckRequired: true,
        conflictsDetails: "Disclose any current or former representation involving the named parties.",
      });
    expect(requested.status).toBe(200);
    await assertLifecycleCheckpoint({
      label: "6 pre-engagement requested",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: "shortlisted",
      attorneySection: "open",
      paralegalSection: "application",
      browseVisible: true,
      primaryHistoricallyExcluded: true,
      preEngagementStatus: "requested",
    });

    // 7. Paralegal response submitted
    const firstResponse = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/respond`)
      .set("Cookie", actors.cookies.paralegal)
      .send({ conflictsResponseType: "none_known" });
    expect(firstResponse.status).toBe(200);
    await assertLifecycleCheckpoint({
      label: "7 pre-engagement submitted",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: "shortlisted",
      attorneySection: "open",
      paralegalSection: "application",
      browseVisible: true,
      primaryHistoricallyExcluded: true,
      preEngagementStatus: "submitted",
    });

    // 8. Changes requested
    const changesRequested = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/review`)
      .set("Cookie", actors.cookies.attorney)
      .send({ action: "request_changes" });
    expect(changesRequested.status).toBe(200);
    await assertLifecycleCheckpoint({
      label: "8 changes requested",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: "shortlisted",
      attorneySection: "open",
      paralegalSection: "application",
      browseVisible: true,
      primaryHistoricallyExcluded: true,
      preEngagementStatus: "changes_requested",
    });

    // 9. Revised response submitted
    const revisedResponse = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/respond`)
      .set("Cookie", actors.cookies.paralegal)
      .send({
        conflictsResponseType: "disclosure",
        conflictsDisclosureText: "A former consultation was screened and presents no known conflict.",
      });
    expect(revisedResponse.status).toBe(200);
    await assertLifecycleCheckpoint({
      label: "9 revised response submitted",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: "shortlisted",
      attorneySection: "open",
      paralegalSection: "application",
      browseVisible: true,
      primaryHistoricallyExcluded: true,
      preEngagementStatus: "submitted",
    });

    // 10. Pre-engagement approved
    const approved = await request(app)
      .post(`/api/cases/${caseDoc._id}/pre-engagement/review`)
      .set("Cookie", actors.cookies.attorney)
      .send({ action: "approve" });
    expect(approved.status).toBe(200);
    await assertLifecycleCheckpoint({
      label: "10 pre-engagement approved",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: "shortlisted",
      attorneySection: "open",
      paralegalSection: "application",
      browseVisible: true,
      primaryHistoricallyExcluded: true,
      preEngagementStatus: "approved",
    });

    // Hiring remains safely blocked until state 11.
    const hireWithoutCard = await request(app)
      .post(`/api/cases/${caseDoc._id}/hire/${actors.paralegal._id}`)
      .set("Cookie", actors.cookies.attorney)
      .send({});
    expect(hireWithoutCard.status).toBe(400);
    expect(hireWithoutCard.body.error).toMatch(/payment method before hiring/i);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();

    // 11. Payment method added through the existing payment route.
    const paymentMethodAdded = await request(app)
      .post("/api/payments/payment-method/default")
      .set("Cookie", actors.cookies.attorney)
      .send({ paymentMethodId: "pm_phase2_visa" });
    expect(paymentMethodAdded.status).toBe(200);
    expect(mockStripeState.defaultPaymentMethodId).toBe("pm_phase2_visa");
    await assertLifecycleCheckpoint({
      label: "11 payment method added",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "open",
      jobStatus: "open",
      applicationStatus: "shortlisted",
      attorneySection: "open",
      paralegalSection: "application",
      browseVisible: true,
      primaryHistoricallyExcluded: true,
      preEngagementStatus: "approved",
    });

    // Add one losing candidate after proving the other eligible paralegal remained recommended.
    const alternateApplied = await request(app)
      .post(`/api/jobs/${job._id}/apply`)
      .set("Cookie", actors.cookies.otherParalegal)
      .send({ coverLetter: "I am also qualified and available for this immigration filing engagement." });
    expect(alternateApplied.status).toBe(201);
    const alternateApplicationId = alternateApplied.body._id || alternateApplied.body.id;
    const isolatedPreview = await request(app)
      .get(`/api/cases/${caseDoc._id}/applications/${primaryApplicationId}/preview`)
      .set("Cookie", actors.cookies.otherParalegal);
    expect(isolatedPreview.status).toBe(404);

    // 12. Paralegal hired and matter funded
    jest.setSystemTime(PHASE2_CLOCK.hired);
    const hired = await request(app)
      .post(`/api/cases/${caseDoc._id}/hire/${actors.paralegal._id}`)
      .set("Cookie", actors.cookies.attorney)
      .send({});
    expect(hired.status).toBe(200);
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 48_800, payment_method: "pm_phase2_visa" }),
      expect.any(Object)
    );
    const hiredCase = await Case.findById(caseDoc._id).lean();
    expect(hiredCase).toMatchObject({
      status: "in progress",
      escrowStatus: "funded",
      fundingIntegrityStatus: "verified",
    });
    expect(String(hiredCase.paralegalId)).toBe(String(actors.paralegal._id));
    expect((await Application.findById(alternateApplicationId).lean()).status).toBe("rejected");
    await assertLifecycleCheckpoint({
      label: "12 hired and funded",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "in progress",
      jobStatus: "assigned",
      applicationStatus: "accepted",
      attorneySection: "active",
      paralegalSection: "active",
      browseVisible: false,
      primaryHistoricallyExcluded: true,
      otherHistoricallyExcluded: true,
      preEngagementStatus: "approved",
      funded: true,
    });

    const outsiderWorkspace = await request(app)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", actors.cookies.otherParalegal);
    expect([403, 404]).toContain(outsiderWorkspace.status);

    // 13. Message sent and read
    const sentMessage = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", actors.cookies.paralegal)
      .send({ text: "The filing package is ready for your review." });
    expect(sentMessage.status).toBe(201);
    const messageId = sentMessage.body.message._id || sentMessage.body.message.id;
    const readMessage = await request(app)
      .post(`/api/messages/${caseDoc._id}/read`)
      .set("Cookie", actors.cookies.attorney)
      .send({ upTo: "2026-09-02T12:00:00.000Z" });
    expect(readMessage.status).toBe(200);
    expect((await Message.findById(messageId).lean()).readBy.map(String)).toContain(String(actors.attorney._id));
    await assertLifecycleCheckpoint({
      label: "13 message sent and read",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "in progress",
      jobStatus: "assigned",
      applicationStatus: "accepted",
      attorneySection: "active",
      paralegalSection: "active",
      browseVisible: false,
      primaryHistoricallyExcluded: true,
      otherHistoricallyExcluded: true,
      preEngagementStatus: "approved",
      funded: true,
    });

    // 14. File uploaded to mocked storage and approved
    const documentKey = `cases/${caseDoc._id}/documents/final-work.pdf`;
    const attached = await request(app)
      .post(`/api/cases/${caseDoc._id}/files`)
      .set("Cookie", actors.cookies.paralegal)
      .send({
        key: documentKey,
        original: "final-work.pdf",
        mime: "application/pdf",
        size: 26,
      });
    expect(attached.status).toBe(201);
    const caseFile = await CaseFile.findOne({ caseId: caseDoc._id }).lean();
    const fileApproved = await request(app)
      .patch(`/api/cases/${caseDoc._id}/files/${caseFile._id}/status`)
      .set("Cookie", actors.cookies.attorney)
      .send({ status: "approved" });
    expect(fileApproved.status).toBe(200);
    expect((await CaseFile.findById(caseFile._id).lean()).status).toBe("approved");
    await assertLifecycleCheckpoint({
      label: "14 file approved",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "in progress",
      jobStatus: "assigned",
      applicationStatus: "accepted",
      attorneySection: "active",
      paralegalSection: "active",
      browseVisible: false,
      primaryHistoricallyExcluded: true,
      otherHistoricallyExcluded: true,
      preEngagementStatus: "approved",
      funded: true,
    });

    // 15. The authoritative Case deadline created at publication remains shared.
    expect((await Case.findById(caseDoc._id).lean()).deadlineDate).toBe("2026-09-15");
    await assertLifecycleCheckpoint({
      label: "15 matter deadline retained",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "in progress",
      jobStatus: "assigned",
      applicationStatus: "accepted",
      attorneySection: "active",
      paralegalSection: "active",
      browseVisible: false,
      primaryHistoricallyExcluded: true,
      otherHistoricallyExcluded: true,
      preEngagementStatus: "approved",
      funded: true,
    });

    // 16. Scope tasks completed through the existing Case task CAS behavior.
    const beforeTaskUpdate = await Case.findById(caseDoc._id).lean();
    const completedTasks = beforeTaskUpdate.tasks.map((task) => ({
      id: task._id,
      _id: task._id,
      title: task.title,
      completed: true,
    }));
    const tasksCompleted = await request(app)
      .patch(`/api/cases/${caseDoc._id}`)
      .set("Cookie", actors.cookies.attorney)
      .send({ tasks: completedTasks });
    expect(tasksCompleted.status).toBe(200);
    expect((await Case.findById(caseDoc._id).lean()).tasks.every((task) => task.completed)).toBe(true);
    await assertLifecycleCheckpoint({
      label: "16 scope tasks completed",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "in progress",
      jobStatus: "assigned",
      applicationStatus: "accepted",
      attorneySection: "active",
      paralegalSection: "active",
      browseVisible: false,
      primaryHistoricallyExcluded: true,
      otherHistoricallyExcluded: true,
      preEngagementStatus: "approved",
      funded: true,
    });

    // 17. Existing file-review and task completion are the completed-work approval evidence.
    expect(await CaseFile.countDocuments({ caseId: caseDoc._id, status: "approved" })).toBe(1);
    expect((await Case.findById(caseDoc._id).lean()).tasks.every((task) => task.completed)).toBe(true);
    expect((await Case.findById(caseDoc._id).lean()).submissionStatus).toBeUndefined();
    await assertLifecycleCheckpoint({
      label: "17 completed work approved",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "in progress",
      jobStatus: "assigned",
      applicationStatus: "accepted",
      attorneySection: "active",
      paralegalSection: "active",
      browseVisible: false,
      primaryHistoricallyExcluded: true,
      otherHistoricallyExcluded: true,
      preEngagementStatus: "approved",
      funded: true,
    });

    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_phase2_funding",
      status: "succeeded",
      amount: 48_800,
      amount_received: 48_800,
      currency: "usd",
      transfer_group: `case_${caseDoc._id}`,
      metadata: {
        caseId: String(caseDoc._id),
        attorneyId: String(actors.attorney._id),
        paralegalId: String(actors.paralegal._id),
      },
      latest_charge: { id: "ch_phase2_funding", paid: true, captured: true },
    });

    // 18–19. Completion synchronously releases payout under the existing lifecycle.
    jest.setSystemTime(PHASE2_CLOCK.completed);
    const completed = await request(app)
      .post(`/api/cases/${caseDoc._id}/complete`)
      .set("Cookie", actors.cookies.attorney)
      .send({});
    expect(completed.status).toBe(200);
    const completedCase = await Case.findById(caseDoc._id).lean();
    expect(completedCase).toMatchObject({
      status: "completed",
      archived: true,
      readOnly: true,
      paymentReleased: true,
      payoutTransferId: "tr_phase2_payout",
    });
    expect(stripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 32_800, destination: "acct_phase2_paralegal" }),
      expect.any(Object)
    );
    await assertLifecycleCheckpoint({
      label: "18-19 completed and payout released",
      actors,
      caseId: caseDoc._id,
      jobId: job._id,
      applicationId: primaryApplicationId,
      caseStatus: "completed",
      jobStatus: "assigned",
      applicationStatus: "accepted",
      attorneySection: "completed",
      paralegalSection: "completed",
      browseVisible: false,
      primaryHistoricallyExcluded: true,
      otherHistoricallyExcluded: true,
      preEngagementStatus: "approved",
      funded: true,
      paymentReleased: true,
      searchVisible: false,
    });

    // 20. Historical Case, Job, Applications, payment evidence, messages, files, and notifications remain.
    expect(await Case.countDocuments({ _id: caseDoc._id })).toBe(1);
    expect(await Job.countDocuments({ _id: job._id })).toBe(1);
    expect(await Application.countDocuments({ jobId: job._id })).toBe(2);
    expect(await Message.countDocuments({ caseId: caseDoc._id })).toBe(1);
    expect(await CaseFile.countDocuments({ caseId: caseDoc._id })).toBe(1);
    expect(await Payout.countDocuments({ caseId: caseDoc._id, status: "paid" })).toBe(1);
    expect(await PaymentOperation.countDocuments({ caseId: caseDoc._id, status: "succeeded" })).toBe(1);
    expect(await PlatformIncome.countDocuments({ caseId: caseDoc._id })).toBe(1);
    expect(await Notification.countDocuments({ "payload.caseId": caseDoc._id })).toBeGreaterThan(0);

    const attorneyReceipt = await request(app)
      .get(`/api/payments/receipt/attorney/${caseDoc._id}`)
      .set("Cookie", actors.cookies.attorney)
      .buffer(true);
    const paralegalReceipt = await request(app)
      .get(`/api/payments/receipt/paralegal/${caseDoc._id}`)
      .set("Cookie", actors.cookies.paralegal)
      .buffer(true);
    expect(attorneyReceipt.status).toBe(200);
    expect(paralegalReceipt.status).toBe(200);

    const hiddenMessageAction = await request(app)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", actors.cookies.paralegal)
      .send({ text: "A completed workspace must not accept new messages." });
    expect([403, 404]).toContain(hiddenMessageAction.status);
    const hiddenTaskAction = await request(app)
      .patch(`/api/cases/${caseDoc._id}`)
      .set("Cookie", actors.cookies.attorney)
      .send({ tasks: completedTasks });
    expect(hiddenTaskAction.status).toBe(403);
  });
});
