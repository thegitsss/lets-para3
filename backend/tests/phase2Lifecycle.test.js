process.env.STRIPE_SECRET_KEY = "sk_test_phase2_synthetic";
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const { randomUUID } = require("crypto");

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_phase2_lifecycle";
process.env.EMAIL_DISABLE = "true";
process.env.S3_BUCKET = process.env.S3_BUCKET || "phase2-test-bucket";
process.env.S3_MALWARE_SCAN_REQUIRED = "false";

const mockStripeState = {
  defaultPaymentMethodId: null,
  captureAvailable: true,
  paymentIntent: null,
  refund: null,
  refundStatus: "succeeded",
  cardDispute: null,
};
function mockFundingCharge() {
  return {
    id: "ch_phase2_funding", payment_intent: "pi_phase2_funding", currency: "usd",
    paid: true, captured: true, disputed: Boolean(mockStripeState.cardDispute), livemode: false, status: "succeeded",
    object: "charge", created: Date.parse("2026-09-01T15:00:00.000Z") / 1000,
    amount: 48_800, amount_captured: 48_800, amount_refunded: mockStripeState.refund?.status === "succeeded" ? mockStripeState.refund.amount : 0,
    refunded: mockStripeState.refund?.status === "succeeded" && mockStripeState.refund.amount === 48_800,
    balance_transaction: {
      id: "txn_phase2_funding", type: "charge", source: "ch_phase2_funding",
      amount: 48_800, fee: 1_400, net: 47_400, currency: "usd",
    },
  };
}
function mockTransfer(params, id = "tr_phase2_payout") {
  return { id, object: "transfer", ...params, livemode: false, reversed: false, amount_reversed: 0, created: Math.floor(Date.now() / 1000) };
}
function mockCardDispute(caseId, { created = Math.floor(Date.now() / 1000) } = {}) {
  const id = "dp_phase2_card";
  return { id, object: "dispute", status: "under_review", amount: 48_800, currency: "usd", livemode: false, charge: "ch_phase2_funding", payment_intent: "pi_phase2_funding", created, metadata: { caseId }, balance_transactions: [{ id: "txn_phase2_card_debit", object: "balance_transaction", type: "adjustment", reporting_category: "dispute", source: id, amount: -48_800, fee: 1500, net: -50_300, currency: "usd", created }] };
}
function mockCardRecovery(created = Math.floor(Date.now() / 1000)) {
  mockStripeState.cardDispute.status = "won";
  mockStripeState.cardDispute.balance_transactions.push({ id: "txn_phase2_card_credit", object: "balance_transaction", type: "adjustment", reporting_category: "dispute_reversal", source: mockStripeState.cardDispute.id, amount: 48_800, fee: -1500, net: 50_300, currency: "usd", created });
}
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
jest.mock("../utils/opsAlerting", () => ({ sendOwnerAlert: jest.fn(async () => ({ ok: true })) }));
jest.mock("../utils/s3Client", () => ({
  createS3Client: () => ({ send: mockObjectStoreSend }),
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(async () => "https://object-storage.test/phase2-signed"),
}));
jest.mock("../utils/stripe", () => ({
  webhooks: { constructEvent: jest.fn((body, signature) => {
    if (!Buffer.isBuffer(body) || signature !== "synthetic-phase2-signature") throw Error("Invalid synthetic delivery");
    return JSON.parse(body.toString());
  }) },
  customers: {
    create: jest.fn(async () => ({ id: "cus_phase2_attorney", object: "customer", livemode: false })),
    retrieve: jest.fn(async () => ({
      id: "cus_phase2_attorney", object: "customer", livemode: false,
      invoice_settings: { default_payment_method: mockStripeState.defaultPaymentMethodId },
    })),
    update: jest.fn(async (_customerId, update) => {
      mockStripeState.defaultPaymentMethodId = update?.invoice_settings?.default_payment_method || null;
      return { id: "cus_phase2_attorney", object: "customer", livemode: false, invoice_settings: update.invoice_settings };
    }),
  },
  paymentMethods: {
    retrieve: jest.fn(async (id) => ({
      id, object: "payment_method", livemode: false,
      type: "card",
      customer: "cus_phase2_attorney",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    })),
    attach: jest.fn(async (id) => ({ id, object: "payment_method", livemode: false, type: "card", customer: "cus_phase2_attorney", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } })),
  },
  setupIntents: { create: jest.fn() },
  charges: { retrieve: jest.fn(async id => {
    if (id !== "ch_phase2_funding") throw Error("Unknown synthetic funding charge");
    if (!mockStripeState.captureAvailable) throw Error("Synthetic charge lookup unavailable");
    return mockFundingCharge();
  }) },
  disputes: { retrieve: jest.fn(async id => { if (id !== mockStripeState.cardDispute?.id) throw Error("Unknown synthetic card dispute"); return structuredClone(mockStripeState.cardDispute); }) },
  balanceTransactions: { retrieve: jest.fn(async id => { const value = mockStripeState.cardDispute?.balance_transactions.find(row => row.id === id); if (!value) throw Error("Unknown synthetic card-dispute balance transaction"); return structuredClone(value); }) },
  accounts: {
    create: jest.fn(),
    retrieve: jest.fn(async () => ({ details_submitted: true, charges_enabled: true, payouts_enabled: true })),
  },
  paymentIntents: {
    create: jest.fn(async (params) => (mockStripeState.paymentIntent = {
      id: "pi_phase2_funding",
      object: "payment_intent",
      status: "succeeded",
      amount: params.amount,
      amount_received: params.amount,
      currency: params.currency,
      customer: params.customer,
      transfer_group: params.transfer_group,
      metadata: params.metadata,
      latest_charge: { id: "ch_phase2_funding", payment_intent: "pi_phase2_funding", currency: "usd", paid: true, captured: true, disputed: false, amount_captured: 48_800, amount_refunded: 0 },
      livemode: false,
    })),
    retrieve: jest.fn(async id => {
      if (!mockStripeState.paymentIntent || id !== mockStripeState.paymentIntent.id) throw Error("Unknown synthetic PaymentIntent");
      return { ...mockStripeState.paymentIntent, latest_charge: mockStripeState.captureAvailable ? mockFundingCharge() : "ch_phase2_funding" };
    }),
    cancel: jest.fn(),
  },
  refunds: {
    create: jest.fn(async params => {
      if (params.payment_intent !== "pi_phase2_funding") throw Error("Unknown synthetic refund payment");
      return (mockStripeState.refund = { id: "re_phase2_settlement", object: "refund", amount: params.amount, currency: "usd", payment_intent: params.payment_intent, charge: "ch_phase2_funding", metadata: params.metadata, status: mockStripeState.refundStatus, livemode: false, created: Math.floor(Date.now() / 1000), balance_transaction: mockStripeState.refundStatus === "succeeded" ? "txn_phase2_refund" : null });
    }),
    retrieve: jest.fn(async id => { if (id !== mockStripeState.refund?.id) throw Error("Unknown synthetic refund"); return mockStripeState.refund; }),
    list: jest.fn(async () => ({ data: mockStripeState.refund ? [mockStripeState.refund] : [], has_more: false })),
  },
  transfers: {
    create: jest.fn(async (params) => mockTransfer(params)),
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
  instance.use((_req, res, next) => { res.set("X-LPC-Test-Server", "phase2-lifecycle"); next(); });
  instance.use("/api/webhooks/stripe", require("../routes/paymentsWebhook"));
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/cases", casesRouter);
  instance.use("/api/jobs", jobsRouter);
  instance.use("/api/applications", applicationsRouter);
  instance.use("/api/payments", paymentsRouter);
  instance.use("/api/disputes", require("../routes/disputes"));
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

let server;
beforeAll(async () => {
  await connect();
  // Supertest otherwise creates an unspecified-family listener per request.
  // Keep one explicit IPv4 loopback listener for this cross-role journey.
  server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.on("error", reject);
  });
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await closeDatabase();
});
afterEach(() => jest.useRealTimers());

beforeEach(async () => {
  await clearDatabase();
  mockStripeState.defaultPaymentMethodId = null;
  mockStripeState.captureAvailable = true;
  mockStripeState.paymentIntent = null;
  mockStripeState.refund = null;
  mockStripeState.refundStatus = "succeeded";
  mockStripeState.cardDispute = null;
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
    const response = await request(server).get(path).set("Cookie", cookie).catch(error => {
      error.message = `Lifecycle projection ${path}: ${error.message}`; throw error;
    });
    expect(response.headers["x-lpc-test-server"]).toBe("phase2-lifecycle");
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
    paralegalHome.myApplications.filter((item) => item.pending === true).length
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

async function loadFinancialRoles(actors, label) {
  const reads = {
    attorney: ["/api/payments/summary", "attorney"],
    history: ["/api/payments/attorney-financial-history", "attorney"],
    held: ["/api/payments/escrow/active", "attorney"],
    paralegal: ["/api/paralegal/dashboard", "paralegal"],
    admin: ["/api/admin/analytics", "admin"],
    receipts: ["/api/payments/receipts", "admin"],
  };
  const responses = Object.fromEntries(await Promise.all(Object.entries(reads).map(async ([key, [path, role]]) => {
    const response = await request(server).get(path)
      .query({ expectedOwnerId: String(actors[role]._id) }).set("Cookie", actors.cookies[role]).catch(error => {
        error.message = `${label}, financial read ${path}: ${error.message}`; throw error;
      });
    expect({ label, path, status: response.status }).toEqual({ label, path, status: 200 });
    expect(response.headers["x-lpc-test-server"]).toBe("phase2-lifecycle");
    return [key, response.body];
  })));
  return responses;
}

async function assertFinancialCheckpoint({ actors, caseId, label, funded = false, completed = false, unverified = false }) {
  const responses = await loadFinancialRoles(actors, label);
  const { attorney, history, held, paralegal, admin, receipts } = responses;
  expect({ label, amounts: {
    originalFunding: attorney.totalSpent,
    attorneyHeld: held.total,
    paralegalExpected: paralegal.metrics.expectedPayouts,
    paralegalPaid: paralegal.metrics.earningsTotal,
    adminHeld: admin.escrowMetrics.totalEscrowHeld,
    adminPending: admin.escrowMetrics.pendingPayouts,
    adminPaid: admin.payoutMetrics.totalRecorded,
    adminFees: admin.revenueMetrics.totalRevenue,
  } }).toEqual({ label, amounts: {
    originalFunding: unverified ? null : funded ? 48_800 : 0,
    attorneyHeld: unverified ? null : funded && !completed ? 40_000 : 0,
    paralegalExpected: unverified ? null : funded && !completed ? 328 : 0,
    paralegalPaid: completed ? 328 : 0,
    adminHeld: unverified ? null : funded && !completed ? 40_000 : 0,
    // Admin's pending queue contains completed work awaiting payout; an active
    // assignment is expected paralegal compensation, not a queued payment.
    adminPending: 0,
    adminPaid: completed ? 32_800 : 0,
    adminFees: completed ? 16_000 : 0,
  } });
  expect(history.entries).toHaveLength(funded ? completed ? 2 : 1 : 0);
  expect(receipts.items).toHaveLength(history.entries.length);
  if (funded) {
    expect(history.entries.find(row => row.type === "funding")).toMatchObject({
      caseId: String(caseId), state: unverified ? "needs_review" : "recorded", currency: "USD", amount: 48_800,
    });
    expect(admin.ledger.find(row => row.type === "funding")).toMatchObject({
      caseId: String(caseId), state: unverified ? "needs_review" : "recorded", currency: "USD", stripeMode: unverified ? "unknown" : "test",
      grossAmount: unverified ? null : 48_800, processingFeeAmount: unverified ? null : 1_400, netAmount: unverified ? null : 47_400,
    });
    expect(receipts.items.find(row => row.type === "Funding")).toMatchObject({
      caseId: String(caseId), state: unverified ? "needs_review" : "recorded", amountCents: unverified ? null : 48_800,
    });
  }
  if (completed) expect(history.entries.find(row => row.type === "payout")).toMatchObject({
    caseId: String(caseId), state: "recorded", currency: "USD", amount: 32_800,
  });
  return responses;
}

async function deliverFunding(eventId) {
  const event = {
    id: eventId, type: "payment_intent.succeeded", livemode: false,
    created: Math.floor(PHASE2_CLOCK.hired.getTime() / 1000),
    data: { object: { ...mockStripeState.paymentIntent } },
  };
  return request(server).post("/api/webhooks/stripe").set("Stripe-Signature", "synthetic-phase2-signature")
    .set("Content-Type", "application/json").send(JSON.stringify(event));
}

function deliverCardEvent(eventId, status = mockStripeState.cardDispute.status, type = "charge.dispute.updated") {
  return request(server).post("/api/webhooks/stripe").set("Stripe-Signature", "synthetic-phase2-signature").set("Content-Type", "application/json").send(JSON.stringify({ id: eventId, type, livemode: false, created: mockStripeState.cardDispute.created, data: { object: { ...mockStripeState.cardDispute, status } } }));
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

  test.each(["available", "delayed"])("one Case, Job, and primary Application remain coherent through the complete cross-role lifecycle with %s capture evidence", async capture => {
    jest.useFakeTimers({
      now: PHASE2_CLOCK.draft,
      doNotFake: ["nextTick", "setImmediate", "setTimeout", "clearTimeout", "queueMicrotask", "hrtime", "performance"],
    });
    const actors = await createPhase2Actors();

    // 1. Draft
    const drafted = await request(server)
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
    const published = await request(server)
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
    await request(server)
      .delete(`/api/case-drafts/${draftId}`)
      .set("Cookie", actors.cookies.attorney)
      .send({ revision: drafted.body.draft.revision })
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

    const preHireMessageAttempt = await request(server)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", actors.cookies.paralegal)
      .send({ text: "This hidden workspace action must remain unavailable before hire." });
    expect([403, 404]).toContain(preHireMessageAttempt.status);

    // 3. Application submitted
    jest.setSystemTime(PHASE2_CLOCK.applied);
    const applied = await request(server)
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
    const requested = await request(server)
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
    const firstResponse = await request(server)
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
    const changesRequested = await request(server)
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
    const revisedResponse = await request(server)
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
    const approved = await request(server)
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
    const hireWithoutCard = await request(server)
      .post(`/api/cases/${caseDoc._id}/hire/${actors.paralegal._id}`)
      .set("Cookie", actors.cookies.attorney)
      .send({});
    expect(hireWithoutCard.status).toBe(400);
    expect(hireWithoutCard.body.error).toMatch(/payment method before hiring/i);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();

    // 11. Payment method added through the existing payment route.
    const paymentMethodAdded = await request(server)
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

    await assertFinancialCheckpoint({ actors, caseId: caseDoc._id, label: "11 before funding" });

    // Add one losing candidate after proving the other eligible paralegal remained recommended.
    const alternateApplied = await request(server)
      .post(`/api/jobs/${job._id}/apply`)
      .set("Cookie", actors.cookies.otherParalegal)
      .send({ coverLetter: "I am also qualified and available for this immigration filing engagement." });
    expect(alternateApplied.status).toBe(201);
    const alternateApplicationId = alternateApplied.body._id || alternateApplied.body.id;
    const isolatedPreview = await request(server)
      .get(`/api/cases/${caseDoc._id}/applications/${primaryApplicationId}/preview`)
      .set("Cookie", actors.cookies.otherParalegal);
    expect(isolatedPreview.status).toBe(404);

    // 12. Paralegal hired and matter funded
    jest.setSystemTime(PHASE2_CLOCK.hired);
    mockStripeState.captureAvailable = capture === "available";
    const hired = await request(server)
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

    if (capture === "delayed") {
      await assertFinancialCheckpoint({ actors, caseId: caseDoc._id, label: "12 capture not verified", funded: true, unverified: true });
      expect(await PaymentOperation.findOne({ caseId: caseDoc._id, kind: "funding" }).lean()).toMatchObject({
        status: "needs_reconciliation", lastError: "charge_unmatched",
      });
    }
    mockStripeState.captureAvailable = true;
    const fundingEvent = await deliverFunding("evt_phase2_funding");
    expect(fundingEvent.status).toBe(200);
    const fundedFinancial = await assertFinancialCheckpoint({ actors, caseId: caseDoc._id, label: "12 hire funded", funded: true });
    expect((await deliverFunding("evt_phase2_funding")).body.deduped).toBe(true);
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);

    const outsiderWorkspace = await request(server)
      .get(`/api/messages/${caseDoc._id}`)
      .set("Cookie", actors.cookies.otherParalegal);
    expect([403, 404]).toContain(outsiderWorkspace.status);

    // 13. Message sent and read
    const sentMessage = await request(server)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", actors.cookies.paralegal)
      .send({ text: "The filing package is ready for your review." });
    expect(sentMessage.status).toBe(201);
    const messageId = sentMessage.body.message._id || sentMessage.body.message.id;
    const messageCreatedAt = sentMessage.body.message.createdAt;
    const readMessage = await request(server)
      .post(`/api/messages/${caseDoc._id}/read`)
      .set("Cookie", actors.cookies.attorney)
      .send({ upTo: new Date(new Date(messageCreatedAt).getTime() + 1000).toISOString() });
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
    const attached = await request(server)
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
    const fileApproved = await request(server)
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
    const tasksCompleted = await request(server)
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

    // 18–19. Completion synchronously releases payout under the existing lifecycle.
    jest.setSystemTime(PHASE2_CLOCK.completed);
    const completionReview = await request(server).get(`/api/cases/${caseDoc._id}/completion-review`)
      .query({ expectedOwnerId: String(actors.attorney._id) }).set("Cookie", actors.cookies.attorney);
    expect(completionReview.status).toBe(200);
    expect(completionReview.body).toMatchObject({ canComplete: true, grossCents: 40_000, feeCents: 7_200, payoutCents: 32_800 });
    const completionCommand = {
      expectedOwnerId: String(actors.attorney._id), requestId: randomUUID(),
      confirmation: require("../services/attorneyCompletion").confirmation(completionReview.body),
    };
    const completed = await request(server)
      .post(`/api/cases/${caseDoc._id}/complete`)
      .set("Cookie", actors.cookies.attorney)
      .send(completionCommand);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ completionRecorded: true, requestId: completionCommand.requestId });
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

    const completedFinancial = await assertFinancialCheckpoint({ actors, caseId: caseDoc._id, label: "18-19 completion paid", funded: true, completed: true });
    const retry = await request(server).post(`/api/cases/${caseDoc._id}/complete`)
      .set("Cookie", actors.cookies.attorney).send(completionCommand);
    expect(retry.status).toBe(200);
    expect(retry.body.review.operation.status).toBe("recorded");
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
    const staleCsv = await request(server).get("/api/payments/attorney-financial-history/csv")
      .query({ expectedOwnerId: String(actors.attorney._id), revision: fundedFinancial.history.revision })
      .set("Cookie", actors.cookies.attorney);
    expect(staleCsv.status).toBe(409);
    const currentCsv = await request(server).get("/api/payments/attorney-financial-history/csv")
      .query({ expectedOwnerId: String(actors.attorney._id), revision: completedFinancial.history.revision })
      .set("Cookie", actors.cookies.attorney);
    expect(currentCsv.status).toBe(200);
    expect(currentCsv.text).toContain('"Matter funding","Recorded","USD","488.00"');
    // Attorney exports confirm release without revealing the paralegal's private net payout.
    // The cross-role checkpoint and paralegal receipt below still verify the actual $328 payout.
    expect(currentCsv.text).toContain('"Paralegal payout","Recorded","USD","","Payment release record; see Matter release amount"');
    expect(currentCsv.text).not.toContain('"328.00"');
    // A delayed original-funding callback observes current evidence without
    // reopening paid work or creating another original charge or payout.
    expect((await deliverFunding("evt_phase2_funding_late")).status).toBe(200);
    await assertFinancialCheckpoint({ actors, caseId: caseDoc._id, label: "19 late funding callback", funded: true, completed: true });
    expect((await Case.findById(caseDoc._id).lean()).status).toBe("completed");
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);

    // 20. Historical Case, Job, Applications, payment evidence, messages, files, and notifications remain.
    expect(await Case.countDocuments({ _id: caseDoc._id })).toBe(1);
    expect(await Job.countDocuments({ _id: job._id })).toBe(1);
    expect(await Application.countDocuments({ jobId: job._id })).toBe(2);
    expect(await Message.countDocuments({ caseId: caseDoc._id })).toBe(1);
    expect(await CaseFile.countDocuments({ caseId: caseDoc._id })).toBe(1);
    expect(await Payout.countDocuments({ caseId: caseDoc._id, status: "paid" })).toBe(1);
    expect(await PaymentOperation.countDocuments({ caseId: caseDoc._id, status: "succeeded", kind: "funding" })).toBe(1);
    expect(await PaymentOperation.countDocuments({ caseId: caseDoc._id, status: "succeeded", kind: "case_payout" })).toBe(1);
    expect(await PaymentOperation.countDocuments({ caseId: caseDoc._id })).toBe(2);
    expect(await PlatformIncome.countDocuments({ caseId: caseDoc._id })).toBe(1);
    expect(await Notification.countDocuments({ "payload.caseId": caseDoc._id })).toBeGreaterThan(0);
    const payoutNotices = await Notification.find({ userId: actors.paralegal._id, type: "payout_released", "payload.caseId": { $in: [caseDoc._id, String(caseDoc._id)] } }).lean();
    expect(payoutNotices).toHaveLength(1);
    expect(payoutNotices[0].payload).toMatchObject({ outcome: "matter_completion_recorded", summary: "Matter completed and archived.", link: `/dashboard-paralegal.html?highlightCase=${caseDoc._id}#cases-completed` });
    const completionEmails = await require("../models/MatterPaymentNotification").find({ caseId: caseDoc._id, kind: "completion" }).lean();
    expect(completionEmails).toHaveLength(2); expect(completionEmails.every(row => row.status === "pending")).toBe(true);
    expect(completionEmails.map(row => String(row.userId)).sort()).toEqual([String(actors.attorney._id), String(actors.paralegal._id)].sort());

    const receiptReview = await request(server).get(`/api/payments/receipt/attorney/${caseDoc._id}/review`)
      .query({ expectedOwnerId: String(actors.attorney._id) }).set("Cookie", actors.cookies.attorney);
    expect(receiptReview.status).toBe(200);
    expect(receiptReview.body).toMatchObject({ reason: "available", receipt: {
      currency: "USD", stripeMode: "test", status: "received", total: { amount: 48_800 },
      lines: [{ label: "Matter amount", amount: 40_000 }, { label: "Platform fee (22%)", amount: 8_800 }],
    } });
    const receiptRenderer = require("../services/caseLifecycle").buildReceiptPdfBuffer;
    const earlierPdfCalls = receiptRenderer.mock.calls.length;
    const attorneyReceipt = await request(server)
      .get(`/api/payments/receipt/attorney/${caseDoc._id}`)
      .set("Cookie", actors.cookies.attorney)
      .buffer(true);
    const paralegalReceipt = await request(server)
      .get(`/api/payments/receipt/paralegal/${caseDoc._id}`)
      .set("Cookie", actors.cookies.paralegal)
      .buffer(true);
    expect(attorneyReceipt.status).toBe(200);
    expect(paralegalReceipt.status).toBe(200);
    expect(attorneyReceipt.headers["content-type"]).toContain("application/pdf");
    expect(paralegalReceipt.headers["content-type"]).toContain("application/pdf");
    expect(receiptRenderer.mock.calls.slice(earlierPdfCalls).map(([payload]) => payload)).toEqual([
      expect.objectContaining({ title: "Payment receipt", testMode: true, partyName: "Phase Two Attorney", totalAmount: "$488.00", lineItems: [{ label: "Matter amount", value: "$400.00" }, { label: "Platform fee (22%)", value: "$88.00" }] }),
      expect.objectContaining({ title: "Payout receipt", testMode: true, partyName: "Phase Two Paralegal", totalAmount: "$328.00", lineItems: [{ label: "Gross amount", value: "$400.00" }, { label: "Platform fee (18%)", value: "$72.00" }] }),
    ]);
    const otherPayeeReceipt = await request(server).get(`/api/payments/receipt/paralegal/${caseDoc._id}`)
      .set("Cookie", actors.cookies.otherParalegal);
    expect([403, 404]).toContain(otherPayeeReceipt.status);
    expect(receiptRenderer.mock.calls).toHaveLength(earlierPdfCalls + 2);

    const hiddenMessageAction = await request(server)
      .post(`/api/messages/${caseDoc._id}`)
      .set("Cookie", actors.cookies.paralegal)
      .send({ text: "A completed workspace must not accept new messages." });
    expect([403, 404]).toContain(hiddenMessageAction.status);
    const hiddenTaskAction = await request(server)
      .patch(`/api/cases/${caseDoc._id}`)
      .set("Cookie", actors.cookies.attorney)
      .send({ tasks: completedTasks });
    expect(hiddenTaskAction.status).toBe(403);
  });

  test.each(["partial", "zero", "expired", "partial_card_hold"])("one funded Matter preserves both payees through %s withdrawal, replacement hire and completion", async outcome => {
    jest.useFakeTimers({ now: PHASE2_CLOCK.published, doNotFake: ["nextTick", "setImmediate", "setTimeout", "clearTimeout", "queueMicrotask", "hrtime", "performance"] });
    const actors = await createPhase2Actors(), title = `Phase 2 ${outcome} replacement lifecycle`;
    const act = async (role, method, path, body = {}) => {
      const response = await request(server)[method](path).set("Cookie", actors.cookies[role]).send(body);
      if (response.status >= 400) throw Error(`${outcome} replacement ${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
      return response;
    };
    await act("attorney", "post", "/api/cases", {
      title, practiceArea: "immigration", description: "Prepare the filing and organize supporting exhibits for attorney review.",
      totalAmount: 400, state: "CA", experience: "5+ years", deadline: "2026-09-15",
      tasks: [{ title: "Prepare filing package" }, { title: "Organize supporting exhibits" }],
    });
    const matter = await Case.findOne({ title }).lean(), caseId = String(matter._id);
    const job = await Job.findOne({ caseId: matter._id }).lean();
    await act("paralegal", "post", `/api/jobs/${job._id}/apply`, { coverLetter: "I am available and qualified to prepare the immigration filing and its supporting exhibits." });
    await act("attorney", "post", "/api/payments/payment-method/default", { paymentMethodId: "pm_phase2_visa" });
    jest.setSystemTime(PHASE2_CLOCK.hired);
    await act("attorney", "post", `/api/cases/${caseId}/hire/${actors.paralegal._id}`);
    await assertFinancialCheckpoint({ actors, caseId, label: `${outcome} original hire`, funded: true });

    const originalFunding = await PaymentOperation.findOne({ caseId, kind: "funding" }).lean();
    const partial = outcome.startsWith("partial"), formerGross = partial ? 10_000 : 0, formerNet = partial ? 8_200 : 0;
    const remaining = 40_000 - formerGross, replacementNet = 32_800 - formerNet;
    const updateTasks = async completed => {
      const current = await Case.findById(caseId).lean();
      await act("attorney", "patch", `/api/cases/${caseId}`, { tasks: current.tasks.map((task, index) => ({ ...task, completed: completed === "all" || index === 0 && completed === "first" })) });
    };
    if (outcome !== "zero") await updateTasks("first");
    jest.setSystemTime(new Date(PHASE2_CLOCK.hired.getTime() + 3_600_000));
    const withdrawn = await act("paralegal", "post", `/api/cases/${caseId}/withdraw`);
    expect(withdrawn.body.withdrawalOutcome).toBe(outcome !== "zero" ? "awaiting_attorney_decision" : "zero_auto");
    if (outcome !== "zero") {
      const review = await request(server).get(`/api/cases/${caseId}/withdrawal-review`)
        .query({ expectedOwnerId: String(actors.attorney._id) }).set("Cookie", actors.cookies.attorney);
      expect(review.status).toBe(200); expect(review.body.canDecide).toBe(true);
      if (partial) stripe.transfers.create.mockImplementationOnce(async params => mockTransfer(params, "tr_phase2_partial"));
      const command = { expectedOwnerId: String(actors.attorney._id), requestId: randomUUID(), action: partial ? "partial" : "reject", reviewedRevision: review.body.revision, ...(partial ? { amountCents: formerGross } : {}) };
      const paid = await act("attorney", "post", `/api/cases/${caseId}/withdrawal-decision`, command);
      if (partial) expect(paid.body.decision).toMatchObject({ type: "partial_attorney", amountCents: formerGross, netCents: formerNet, payoutState: "recorded" });
      expect((await act("attorney", "post", `/api/cases/${caseId}/withdrawal-decision`, command)).body.operation.status).toBe("recorded");
      if (!partial) {
        const waiting = await Case.findById(caseId).lean(); expect(waiting.payoutFinalizedAt).toBeNull();
        jest.setSystemTime(new Date(new Date(waiting.disputeDeadlineAt).getTime() + 1000));
        const expire = require("../services/withdrawalLifecycle").processExpiredWithdrawalWindows;
        expect(await expire({ now: new Date(), limit: 10 })).toEqual({ scanned: 1, finalized: 1, failed: 0 });
        expect(await expire({ now: new Date(), limit: 10 })).toEqual({ scanned: 0, finalized: 0, failed: 0 });
        expect((await Case.findById(caseId)).payoutFinalizedType).toBe("expired_zero");
      }
    }
    expect(stripe.transfers.create).toHaveBeenCalledTimes(partial ? 1 : 0);
    expect((await Job.findById(job._id)).status).toBe("open");

    const checkMoney = async (label, { held = remaining, expected = 0, paid = 0, fees = formerGross - formerNet } = {}) => {
      const values = await loadFinancialRoles(actors, label);
      const replacement = await request(server).get("/api/paralegal/dashboard")
        .query({ expectedOwnerId: String(actors.otherParalegal._id) }).set("Cookie", actors.cookies.otherParalegal);
      expect(replacement.status).toBe(200);
      expect({ label, original: values.attorney.totalSpent, held: values.held.total,
        formerPaid: values.paralegal.metrics.earningsTotal, formerExpected: values.paralegal.metrics.expectedPayouts,
        replacementPaid: replacement.body.metrics.earningsTotal, replacementExpected: replacement.body.metrics.expectedPayouts,
        adminHeld: values.admin.escrowMetrics.totalEscrowHeld, adminPaid: values.admin.payoutMetrics.totalRecorded, fees: values.admin.revenueMetrics.totalRevenue,
      }).toEqual({ label, original: 48_800, held, formerPaid: formerNet / 100, formerExpected: 0, replacementPaid: paid / 100, replacementExpected: expected / 100, adminHeld: held, adminPaid: formerNet + paid, fees });
      const payouts = values.history.entries.filter(row => row.type === "payout");
      expect(payouts.every(row => row.state === "recorded" && row.currency === "USD")).toBe(true);
      expect(payouts.map(row => row.amount).sort((a, b) => a - b)).toEqual([formerNet, paid].filter(Boolean).sort((a, b) => a - b));
      expect(values.history.entries.filter(row => row.type === "withdrawal")).toEqual([expect.objectContaining({ amount: formerGross, state: "decision_recorded" })]);
      return values;
    };
    const withdrawnFinancial = await checkMoney(`${outcome} withdrawal finalized`);
    const earlier = withdrawnFinancial.receipts.items.find(row => row.type === (partial ? "Withdrawal release" : "No-payout decision"));
    expect(earlier).toMatchObject({ amountCents: formerGross, currency: "USD" });
    const renderer = require("../services/caseLifecycle").buildReceiptPdfBuffer;
    const formerReceipt = async () => {
      const response = await request(server).get(`/api/payments/receipt/paralegal/${caseId}`)
        .query({ expectedOwnerId: String(actors.paralegal._id), receiptId: earlier.selectionId }).set("Cookie", actors.cookies.paralegal).buffer(true);
      expect(response.status).toBe(200); return renderer.mock.calls.at(-1)[0];
    };
    const earlierPayload = await formerReceipt();
    expect(earlierPayload.totalAmount).toBe(partial ? "$82.00" : "$0.00");

    jest.setSystemTime(new Date(Math.max(PHASE2_CLOCK.hired.getTime() + 7_200_000, Date.now() + 3_600_000)));
    await act("otherParalegal", "post", `/api/jobs/${job._id}/apply`, { coverLetter: "I am qualified and available to finish the remaining immigration filing and exhibit work." });
    if (outcome === "partial_card_hold") {
      const Payout = require("../models/Payout"), earlierPayouts = await Payout.find({ caseId }).lean();
      mockStripeState.cardDispute = mockCardDispute(caseId);
      expect((await deliverCardEvent("evt_phase2_withdrawal_card", "under_review", "charge.dispute.created")).status).toBe(200);
      const operation = await PaymentOperation.findOne({ caseId, kind: "chargeback" }).lean();
      expect(operation.payoutPosition).toBe("post_payout");
      const readHiring = () => request(server).get(`/api/cases/${caseId}/hiring-review/${actors.otherParalegal._id}`).query({ expectedOwnerId: String(actors.attorney._id) }).set("Cookie", actors.cookies.attorney);
      const blocked = await readHiring(); expect(blocked.status).toBe(200); expect(blocked.body).toMatchObject({ canHire: false, reason: "withdrawal_review_required" });
      const held = await loadFinancialRoles(actors, "prior partial payout under card hold"); expect(held.paralegal.metrics.earningsTotal).toBe(82); expect(held.held.total).toBeNull(); expect(held.admin.payoutMetrics.totalRecorded).toBe(8200);
      jest.setSystemTime(new Date(Date.now() + 120_000)); mockCardRecovery();
      await act("admin", "post", `/api/admin/chargebacks/${operation._id}/reconcile`);
      expect((await readHiring()).body.canHire).toBe(false);
      expect((await act("admin", "post", `/api/admin/chargebacks/${operation._id}/clear-hold`)).body.changed).toBe(true);
      expect(await Payout.find({ caseId }).lean()).toEqual(earlierPayouts);
    }
    const hireReview = await request(server).get(`/api/cases/${caseId}/hiring-review/${actors.otherParalegal._id}`)
      .query({ expectedOwnerId: String(actors.attorney._id) }).set("Cookie", actors.cookies.attorney);
    expect(hireReview.status).toBe(200);
    if (!hireReview.body.canHire) throw new Error(`Replacement hiring review: ${JSON.stringify(hireReview.body)}`);
    expect(hireReview.body).toMatchObject({ canHire: true, relisted: true, chargeCents: 0, remainingCents: remaining });
    const replacementHire = await act("attorney", "post", `/api/cases/${caseId}/hire/${actors.otherParalegal._id}`, { expectedOwnerId: String(actors.attorney._id), reviewedRevision: hireReview.body.revision });
    expect(replacementHire.body.hiringConfirmation).toMatchObject({ mode: "replacement", chargeCents: 0, remainingCents: remaining });
    const replaced = await Case.findById(caseId).lean();
    expect(String(replaced.paralegalId)).toBe(String(actors.otherParalegal._id));
    expect(replaced.remainingAmount).toBe(remaining);
    const earlierHistory = await request(server).get(`/api/payments/receipt/attorney/${caseId}/history`)
      .query({ expectedOwnerId: String(actors.attorney._id) }).set("Cookie", actors.cookies.attorney);
    expect(earlierHistory.status).toBe(200);
    expect(earlierHistory.body.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: earlier.selectionId, amount: formerGross, paralegalName: "Phase Two Paralegal", needsReview: false })]));
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    await checkMoney(`${outcome} replacement hired`, { expected: replacementNet });
    expect(await formerReceipt()).toEqual(earlierPayload);
    expect((await deliverFunding(`evt_phase2_${outcome}_replacement_late`)).status).toBe(200);
    await checkMoney(`${outcome} late original funding after replacement`, { expected: replacementNet });

    await updateTasks("all"); jest.setSystemTime(PHASE2_CLOCK.completed);
    const completion = await request(server).get(`/api/cases/${caseId}/completion-review`)
      .query({ expectedOwnerId: String(actors.attorney._id) }).set("Cookie", actors.cookies.attorney);
    expect(completion.status).toBe(200);
    expect(completion.body).toMatchObject({ canComplete: true, grossCents: remaining, payoutCents: replacementNet });
    await act("attorney", "post", `/api/cases/${caseId}/complete`, { expectedOwnerId: String(actors.attorney._id), requestId: randomUUID(), confirmation: require("../services/attorneyCompletion").confirmation(completion.body) });
    const finalFinancial = await checkMoney(`${outcome} replacement completed`, { held: 0, paid: replacementNet, fees: 16_000 });
    expect(await formerReceipt()).toEqual(earlierPayload);
    const replacementReceipt = await request(server).get(`/api/payments/receipt/paralegal/${caseId}`)
      .query({ expectedOwnerId: String(actors.otherParalegal._id) }).set("Cookie", actors.cookies.otherParalegal).buffer(true);
    expect(replacementReceipt.status).toBe(200);
    expect(renderer.mock.calls.at(-1)[0]).toMatchObject({ partyName: "Phase Two Alternate", totalAmount: partial ? "$246.00" : "$328.00" });
    expect(stripe.transfers.create).toHaveBeenCalledTimes(partial ? 2 : 1);
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(await PaymentOperation.countDocuments({ caseId, kind: "funding" })).toBe(1);
    const retainedFunding = await PaymentOperation.findById(originalFunding._id).lean();
    for (const field of ["grossAmount", "processingFeeAmount", "netAmount", "stripePaymentIntentId", "stripeChargeId", "stripeBalanceTransactionId", "evidenceVerifiedAt"]) expect(retainedFunding[field]).toEqual(originalFunding[field]);
    expect(finalFinancial.receipts.items.filter(row => row.type === "Payout").map(row => row.amountCents).sort((a,b) => a-b)).toEqual([formerNet, replacementNet].filter(Boolean).sort((a,b) => a-b));
    expect(await Case.countDocuments()).toBe(1); expect(await Job.countDocuments()).toBe(1);
  });

  test.each(["refund", "refund_pending", "release_partial", "release_full"])("one funded Matter retains exact three-role records through %s dispute settlement", async outcome => {
    jest.useFakeTimers({ now: PHASE2_CLOCK.published, doNotFake: ["nextTick", "setImmediate", "setTimeout", "clearTimeout", "queueMicrotask", "hrtime", "performance"] });
    const actors = await createPhase2Actors(), title = `Phase 2 ${outcome} dispute settlement`;
    const act = async (role, method, path, body = {}) => {
      const response = await request(server)[method](path).set("Cookie", actors.cookies[role]).send(body);
      if (response.status >= 400) throw Error(`${outcome} settlement ${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
      return response;
    };
    await act("attorney", "post", "/api/cases", { title, practiceArea: "immigration", description: "Prepare the filing and organize supporting exhibits for attorney review.", totalAmount: 400, state: "CA", experience: "5+ years", deadline: "2026-09-15", tasks: [{ title: "Prepare filing package" }, { title: "Organize supporting exhibits" }] });
    const matter = await Case.findOne({ title }).lean(), caseId = String(matter._id), job = await Job.findOne({ caseId: matter._id }).lean();
    await act("paralegal", "post", `/api/jobs/${job._id}/apply`, { coverLetter: "I am available and qualified to prepare the immigration filing and its supporting exhibits." });
    await act("attorney", "post", "/api/payments/payment-method/default", { paymentMethodId: "pm_phase2_visa" });
    jest.setSystemTime(PHASE2_CLOCK.hired);
    await act("attorney", "post", `/api/cases/${caseId}/hire/${actors.paralegal._id}`);
    const funded = await assertFinancialCheckpoint({ actors, caseId, label: `${outcome} before dispute`, funded: true });
    const originalFunding = await PaymentOperation.findOne({ caseId, kind: "funding" }).lean();
    const review = await request(server).get(`/api/disputes/${caseId}/attorney-review`).query({ expectedOwnerId: String(actors.attorney._id) }).set("Cookie", actors.cookies.attorney);
    expect(review.status).toBe(200);
    const opening = { expectedOwnerId: String(actors.attorney._id), action: "open", text: "The filing work requires review before the remaining payment is released.", requestId: randomUUID(), reviewedRevision: review.body.revision };
    const opened = await act("attorney", "post", `/api/disputes/${caseId}/attorney-action`, opening), disputeId = opened.body.operation.disputeId;
    expect(opened.body.operation).toMatchObject({ status: "recorded", action: "open" });
    expect((await act("attorney", "post", `/api/disputes/${caseId}/attorney-action`, opening)).body.operation.disputeId).toBe(disputeId);
    const disputed = await Case.findById(caseId).lean(); expect(disputed.status).toBe("disputed"); expect(disputed.disputes).toHaveLength(1);
    const Notice = require("../models/Notification");
    expect(await Notice.countDocuments({ "payload.caseId": caseId, type: "dispute_opened" })).toBe(3);
    stripe.isTransferablePaymentIntent.mockImplementation(() => ({ transferable: true, charge: mockFundingCharge() }));
    const partial = outcome === "release_partial", paid = outcome.startsWith("release"), payout = partial ? 16_400 : paid ? 32_800 : 0, refundAmount = partial ? 24_400 : paid ? 0 : 48_800;
    const action = outcome === "refund_pending" ? "refund" : outcome;
    const body = { action, disputeId, ...(partial ? { payoutAmountCents: payout } : {}) };
    const settle = () => request(server).post(`/api/payments/dispute/settle/${caseId}`).set("Cookie", actors.cookies.admin).send(body);
    const receiptReview = () => request(server).get(`/api/payments/receipt/attorney/${caseId}/review`).query({ expectedOwnerId: String(actors.attorney._id), receiptId: "payment" }).set("Cookie", actors.cookies.attorney);
    const refundEvent = (eventId, status = mockStripeState.refund?.status) => request(server).post("/api/webhooks/stripe").set("Stripe-Signature", "synthetic-phase2-signature").set("Content-Type", "application/json").send(JSON.stringify({ id: eventId, type: "refund.updated", livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { ...mockStripeState.refund, status } } }));
    const initialReceipt = await receiptReview(); expect(initialReceipt.status).toBe(200); expect(initialReceipt.body.reason).toBe("available");
    if (outcome === "refund_pending") {
      mockStripeState.refundStatus = "pending";
      const pending = await settle(); expect({ status: pending.status, body: pending.body }).toMatchObject({ status: 409 });
      const stillOpen = await Case.findById(caseId).lean(); expect(stillOpen.status).toBe("disputed"); expect(stillOpen.disputeSettlement.resolvedAt).toBeNull();
      const pendingRoles = await loadFinancialRoles(actors, "pending refund");
      expect(pendingRoles.history.entries.find(row => row.type === "refund")).toMatchObject({ state: "pending", amount: 48_800 });
      const pendingReceipt = await receiptReview(); expect(pendingReceipt.status).toBe(200); expect(pendingReceipt.body).toMatchObject({ reason: "available", receipt: { status: "refund_pending", total: { amount: 48_800 } } });
      expect((await refundEvent("evt_phase2_refund_pending")).status).toBe(200);
      expect((await Case.findById(caseId)).status).toBe("disputed");
      mockStripeState.refund = { ...mockStripeState.refund, status: "succeeded", balance_transaction: "txn_phase2_refund" };
    }
    const settled = await settle();
    if (settled.status !== 200) throw Error(`${outcome} settlement result: ${settled.status} ${JSON.stringify(settled.body)}`);
    expect((await settle()).body.alreadySettled).toBe(true);
    const saved = await Case.findById(caseId).lean(); expect(saved.status).toBe("closed"); expect(saved.disputes[0].status).toBe("resolved"); expect(saved.paymentReleased).toBe(paid);
    expect(saved.disputeSettlement).toMatchObject({ action, payoutAmount: payout, refundAmount });
    const finalRoles = await loadFinancialRoles(actors, `${outcome} settled`);
    const amounts = values => ({ original: values.attorney.totalSpent, attorneyHeld: values.held.total, expected: values.paralegal.metrics.expectedPayouts, paid: values.paralegal.metrics.earningsTotal, adminHeld: values.admin.escrowMetrics.totalEscrowHeld, adminPaid: values.admin.payoutMetrics.totalRecorded, fees: values.admin.revenueMetrics.totalRevenue });
    expect(amounts(finalRoles)).toEqual({ original: 48_800, attorneyHeld: 0, expected: 0, paid: payout / 100, adminHeld: 0, adminPaid: payout, fees: partial ? 8000 : paid ? 16000 : 0 });
    expect(finalRoles.history.entries.find(row => row.type === "funding")).toMatchObject({ state: "recorded", amount: 48_800 });
    if (refundAmount) expect(finalRoles.history.entries.find(row => row.type === "refund")).toMatchObject({ state: "recorded", amount: refundAmount });
    if (paid) expect(finalRoles.history.entries.find(row => row.type === "payout")).toMatchObject({ state: "recorded", amount: payout });
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1); expect(stripe.refunds.create).toHaveBeenCalledTimes(refundAmount ? 1 : 0); expect(stripe.transfers.create).toHaveBeenCalledTimes(paid ? 1 : 0);
    expect(await PaymentOperation.findOne({ caseId, kind: "funding" }).lean()).toEqual(originalFunding);
    expect(await Case.countDocuments()).toBe(1); expect(await Job.countDocuments()).toBe(1);
    const staleCsv = await request(server).get("/api/payments/attorney-financial-history/csv").query({ expectedOwnerId: String(actors.attorney._id), revision: funded.history.revision }).set("Cookie", actors.cookies.attorney); expect(staleCsv.status).toBe(409);
    const resolvedNotices = await Notice.find({ "payload.caseId": caseId, type: "dispute_resolved" }).lean();
    expect(resolvedNotices).toHaveLength(2); expect(new Set(resolvedNotices.map(row => String(row.userId)))).toEqual(new Set([String(actors.attorney._id), String(actors.paralegal._id)]));
    for (const role of ["attorney", "paralegal"]) {
      const notifications = await request(server).get("/api/notifications/page").query({ expectedOwnerId: String(actors[role]._id) }).set("Cookie", actors.cookies[role]);
      expect(notifications.status).toBe(200);
      const notice = notifications.body.items.find(row => row.type === "dispute_resolved" && row.context.caseId === caseId);
      expect(notice).toMatchObject({ available: true, action: { label: "View resolution" } }); expect(notice.action.href).toContain(caseId);
    }
    const currentReceipt = await receiptReview(); expect(currentReceipt.status).toBe(200);
    expect(currentReceipt.body).toMatchObject({ reason: "available", receipt: { status: refundAmount === 48_800 ? "refunded" : refundAmount ? "partially_refunded" : "received", total: { amount: 48_800 - refundAmount } } });
    const renderer = require("../services/caseLifecycle").buildReceiptPdfBuffer;
    const attorneyPdf = await request(server).get(`/api/payments/receipt/attorney/${caseId}`).query({ expectedOwnerId: String(actors.attorney._id), receiptId: "payment", revision: currentReceipt.body.revision }).set("Cookie", actors.cookies.attorney).buffer(true);
    expect(attorneyPdf.status).toBe(200); expect(renderer.mock.calls.at(-1)[0].totalAmount).toBe(refundAmount === 48_800 ? "$0.00" : refundAmount ? "$244.00" : "$488.00");
    if (paid) {
      const payoutPdf = await request(server).get(`/api/payments/receipt/paralegal/${caseId}`).query({ expectedOwnerId: String(actors.paralegal._id), receiptId: "completion" }).set("Cookie", actors.cookies.paralegal).buffer(true);
      expect(payoutPdf.status).toBe(200); expect(renderer.mock.calls.at(-1)[0]).toMatchObject({ totalAmount: partial ? "$164.00" : "$328.00", lineItems: [{ label: "Gross amount", value: partial ? "$200.00" : "$400.00" }, { label: "Platform fee (18%)", value: partial ? "$36.00" : "$72.00" }] });
    }
    if (refundAmount) {
      const oldReceipt = await request(server).get(`/api/payments/receipt/attorney/${caseId}`).query({ expectedOwnerId: String(actors.attorney._id), receiptId: "payment", revision: initialReceipt.body.revision }).set("Cookie", actors.cookies.attorney); expect(oldReceipt.status).toBe(409);
      expect((await refundEvent("evt_phase2_refund_settled", "pending")).status).toBe(200);
      expect((await refundEvent("evt_phase2_refund_settled", "pending")).body.deduped).toBe(true);
    }
    const beforeLateFunding = await Case.findById(caseId).lean();
    expect((await deliverFunding(`evt_phase2_${outcome}_funding_after_settlement`)).status).toBe(200);
    const afterCallbacks = await Case.findById(caseId).lean();
    for (const key of ["paymentStatus", "escrowStatus", "fundingIntegrityStatus"]) expect(afterCallbacks[key]).toEqual(beforeLateFunding[key]);
    const retainedFunding = await PaymentOperation.findOne({ caseId, kind: "funding" }).lean();
    for (const key of ["caseId", "amount", "currency", "stripePaymentIntentId", "stripeChargeId", "stripeBalanceTransactionId", "grossAmount", "processingFeeAmount", "netAmount", "stripeMode", "livemode", "evidenceVerifiedAt"]) expect(retainedFunding[key]).toEqual(originalFunding[key]);
    for (const key of ["status", "paymentReleased", "disputeSettlement", "payoutTransferId", "payoutStatus"]) expect(afterCallbacks[key]).toEqual(saved[key]);
    const retained = await loadFinancialRoles(actors, `${outcome} after callbacks`); expect(amounts(retained)).toEqual(amounts(finalRoles));
    expect(retained.history.entries.map(({ type, state, amount }) => ({ type, state, amount })).sort((a, b) => a.type.localeCompare(b.type))).toEqual(finalRoles.history.entries.map(({ type, state, amount }) => ({ type, state, amount })).sort((a, b) => a.type.localeCompare(b.type)));
    const currentCsv = await request(server).get("/api/payments/attorney-financial-history/csv").query({ expectedOwnerId: String(actors.attorney._id), revision: retained.history.revision }).set("Cookie", actors.cookies.attorney); expect(currentCsv.status).toBe(200); expect(currentCsv.text).toContain('"Matter funding","Recorded","USD","488.00"');
    if (refundAmount) expect(currentCsv.text).toContain(`"Refund","Recorded","USD","${(refundAmount / 100).toFixed(2)}"`);
    expect(await Notice.countDocuments({ "payload.caseId": caseId, type: "dispute_resolved" })).toBe(2);
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1); expect(stripe.refunds.create).toHaveBeenCalledTimes(refundAmount ? 1 : 0); expect(stripe.transfers.create).toHaveBeenCalledTimes(paid ? 1 : 0);

  });


  test.each(["pre_won", "pre_lost", "post_won", "post_lost"])("one funded Matter preserves money and payout authority through a %s card dispute", async outcome => {
    jest.useFakeTimers({ now: PHASE2_CLOCK.published, doNotFake: ["nextTick", "setImmediate", "setTimeout", "clearTimeout", "queueMicrotask", "hrtime", "performance"] });
    const actors = await createPhase2Actors(), title = `Phase 2 ${outcome} card dispute`, postPayout = outcome.startsWith("post"), won = outcome.endsWith("won");
    const act = async (role, method, path, body = {}) => {
      const response = await request(server)[method](path).set("Cookie", actors.cookies[role]).send(body);
      if (response.status >= 400) throw Error(`${outcome} card dispute ${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
      return response;
    };
    await act("attorney", "post", "/api/cases", { title, practiceArea: "immigration", description: "Prepare the filing and organize supporting exhibits for attorney review.", totalAmount: 400, state: "CA", experience: "5+ years", deadline: "2026-09-15", tasks: [{ title: "Prepare filing package" }, { title: "Organize supporting exhibits" }] });
    const matter = await Case.findOne({ title }).lean(), caseId = String(matter._id), job = await Job.findOne({ caseId: matter._id }).lean();
    await act("paralegal", "post", `/api/jobs/${job._id}/apply`, { coverLetter: "I am available and qualified to prepare the immigration filing and its supporting exhibits." });
    await act("attorney", "post", "/api/payments/payment-method/default", { paymentMethodId: "pm_phase2_visa" }); jest.setSystemTime(PHASE2_CLOCK.hired);
    await act("attorney", "post", `/api/cases/${caseId}/hire/${actors.paralegal._id}`);
    await assertFinancialCheckpoint({ actors, caseId, label: `${outcome} original funding`, funded: true });
    const funded = await Case.findById(caseId).lean(); await act("attorney", "patch", `/api/cases/${caseId}`, { tasks: funded.tasks.map(task => ({ ...task, completed: true })) });
    const completionReview = () => request(server).get(`/api/cases/${caseId}/completion-review`).query({ expectedOwnerId: String(actors.attorney._id) }).set("Cookie", actors.cookies.attorney);
    const finish = async () => {
      const review = await completionReview(); expect(review.status).toBe(200); expect(review.body).toMatchObject({ canComplete: true, payoutCents: 32_800 });
      const body = { expectedOwnerId: String(actors.attorney._id), requestId: randomUUID(), confirmation: require("../services/attorneyCompletion").confirmation(review.body) };
      expect((await act("attorney", "post", `/api/cases/${caseId}/complete`, body)).body.completionRecorded).toBe(true);
    };
    if (postPayout) await finish();
    const before = await Case.findById(caseId).lean(), Payout = require("../models/Payout"), Income = require("../models/PlatformIncome"), Adjustment = require("../models/FinancialAdjustment");
    const earlierPayouts = await Payout.find({ caseId }).lean(), earlierIncome = await Income.find({ caseId }).lean();
    jest.setSystemTime(new Date(PHASE2_CLOCK.hired.getTime() + 300_000));
    const created = Math.floor(Date.now() / 1000);
    mockStripeState.cardDispute = mockCardDispute(caseId, { created });
    const event = deliverCardEvent;
    const opened = await event("evt_phase2_card_opened", "under_review", "charge.dispute.created"); expect({ status: opened.status, body: opened.body }).toMatchObject({ status: 200 });
    expect((await event("evt_phase2_card_opened", "under_review", "charge.dispute.created")).body.deduped).toBe(true);
    const operation = await PaymentOperation.findOne({ caseId, kind: "chargeback" }).lean();
    expect(operation).toMatchObject({ processorStatus: "under_review", evidenceStatus: "verified", administrativeStatus: "pending_review", payoutPosition: postPayout ? "post_payout" : "pre_payout" });
    const debits = await Adjustment.find({ caseId, direction: "debit" }).sort({ _id: 1 }).lean();
    expect(debits.map(row => [row.adjustmentType, row.amount]).sort()).toEqual([["chargeback_principal", 48_800], ["processor_dispute_fee", 1500]]);
    const checkMoney = async (label, paid, held = !paid) => {
      const values = await loadFinancialRoles(actors, label);
      expect({ original: values.attorney.totalSpent, held: values.held.total, expected: values.paralegal.metrics.expectedPayouts, paid: values.paralegal.metrics.earningsTotal, adminHeld: values.admin.escrowMetrics.totalEscrowHeld, adminPaid: values.admin.payoutMetrics.totalRecorded, fees: values.admin.revenueMetrics.totalRevenue }).toEqual({ original: 48_800, held: paid ? 0 : held ? null : 40_000, expected: paid ? 0 : held ? null : 328, paid: paid ? 328 : 0, adminHeld: paid ? 0 : held ? null : 40_000, adminPaid: paid ? 32_800 : 0, fees: paid ? 16_000 : 0 });
      expect(values.history.entries.find(row => row.type === "funding")).toMatchObject({ state: "recorded", amount: 48_800 }); return values;
    };
    const report = async () => {
      const response = await request(server).get("/api/admin/chargebacks").query({ expectedOwnerId: String(actors.admin._id), id: String(operation._id) }).set("Cookie", actors.cookies.admin);
      expect(response.status).toBe(200); expect(response.body.total).toBe(1); return response.body.items[0];
    };
    expect(await report()).toMatchObject({ debitEvidence: 50_300, creditEvidence: 0, netExposure: 50_300, evidenceCount: 2, payoutHold: !postPayout });
    await checkMoney(`${outcome} under review`, postPayout);
    if (!postPayout) { const blocked = await completionReview(); expect(blocked.status).toBe(200); expect(blocked.body.canComplete).toBe(false); expect(stripe.transfers.create).not.toHaveBeenCalled(); }
    const decide = (action, role = "admin") => request(server).post(`/api/admin/chargebacks/${operation._id}/${action}`).set("Cookie", actors.cookies[role]).send({});
    for (const role of ["attorney", "paralegal"]) expect((await decide("clear-hold", role)).status).toBe(403);
    expect((await decide("acknowledge")).status).toBe(200);
    if (!postPayout) { expect((await decide("clear-hold")).status).toBe(409); expect((await completionReview()).body.canComplete).toBe(false); }
    jest.setSystemTime(new Date((created + 120) * 1000));
    mockStripeState.cardDispute.status = won ? "won" : "lost";
    if (won) mockCardRecovery(created + 120);
    const reconciled = await decide("reconcile"); expect({ status: reconciled.status, body: reconciled.body }).toMatchObject({ status: 200 });
    expect(await report()).toMatchObject({ debitEvidence: 50_300, creditEvidence: won ? 50_300 : 0, netExposure: won ? 0 : 50_300, evidenceCount: won ? 4 : 2, payoutHold: !postPayout });
    expect(await Adjustment.find({ caseId, direction: "debit" }).sort({ _id: 1 }).lean()).toEqual(debits);
    if (!postPayout && won) {
      expect((await completionReview()).body.canComplete).toBe(false);
      expect((await decide("clear-hold")).body.changed).toBe(true); expect((await decide("clear-hold")).body.changed).toBe(false);
      await checkMoney(`${outcome} hold cleared`, false, false);
      await finish();
    } else if (!postPayout) { expect((await decide("clear-hold")).status).toBe(409); expect((await completionReview()).body.canComplete).toBe(false); }
    expect((await event("evt_phase2_card_stale", "under_review")).status).toBe(200);
    expect((await PaymentOperation.findById(operation._id)).processorStatus).toBe(won ? "won" : "lost");
    await checkMoney(`${outcome} final`, postPayout || won);
    const beforeLateFunding = await Case.findById(caseId).lean(), originalFunding = await PaymentOperation.findOne({ caseId, kind: "funding" }).lean();
    expect((await deliverFunding(`evt_phase2_${outcome}_late_card_funding`)).status).toBe(200);
    const afterLateFunding = await Case.findById(caseId).lean();
    for (const key of ["status", "paymentStatus", "escrowStatus", "fundingIntegrityStatus", "paymentReleased", "payoutStatus", "payoutTransferId"]) expect(afterLateFunding[key]).toEqual(beforeLateFunding[key]);
    const retainedFunding = await PaymentOperation.findOne({ caseId, kind: "funding" }).lean();
    for (const key of ["amount", "stripePaymentIntentId", "stripeChargeId", "stripeBalanceTransactionId", "grossAmount", "processingFeeAmount", "netAmount", "stripeMode", "evidenceVerifiedAt"]) expect(retainedFunding[key]).toEqual(originalFunding[key]);
    await checkMoney(`${outcome} after late funding`, postPayout || won);
    if (postPayout || won) {
      const receipt = await request(server).get(`/api/payments/receipt/paralegal/${caseId}`).query({ expectedOwnerId: String(actors.paralegal._id), receiptId: "completion" }).set("Cookie", actors.cookies.paralegal).buffer(true);
      expect(receipt.status).toBe(200); expect(require("../services/caseLifecycle").buildReceiptPdfBuffer.mock.calls.at(-1)[0].totalAmount).toBe("$328.00");
    }
    if (postPayout) {
      const after = await Case.findById(caseId).lean();
      for (const key of ["status", "archived", "readOnly", "completedAt", "paymentReleased", "payoutTransferId"]) expect(after[key]).toEqual(before[key]);
      expect(await Payout.find({ caseId }).lean()).toEqual(earlierPayouts); expect(await Income.find({ caseId }).lean()).toEqual(earlierIncome);
    }
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1); expect(stripe.refunds.create).not.toHaveBeenCalled(); expect(stripe.transfers.create).toHaveBeenCalledTimes(postPayout || won ? 1 : 0);
    expect(await PaymentOperation.countDocuments({ caseId, kind: "chargeback" })).toBe(1); expect(await Case.countDocuments()).toBe(1); expect(await Job.countDocuments()).toBe(1);
  });

});
