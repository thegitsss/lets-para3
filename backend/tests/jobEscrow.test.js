const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");

const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));

jest.mock("../utils/stripe", () => {
  const paymentIntents = {
    create: jest.fn(),
    retrieve: jest.fn(),
    cancel: jest.fn(),
  };
  return {
    paymentIntents,
    refunds: { create: jest.fn() },
    customers: {
      create: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
    },
    paymentMethods: {
      retrieve: jest.fn(),
      attach: jest.fn(),
    },
    setupIntents: {
      create: jest.fn(),
    },
    accounts: {
      create: jest.fn(),
    },
    checkout: {
      sessions: {
        create: jest.fn(),
      },
    },
    isTransferablePaymentIntent: jest.fn(() => ({
      transferable: true,
      charge: { id: "ch_test_transferable", receipt_url: "https://stripe.test/receipt" },
    })),
    sanitizeStripeError: jest.fn((_err, fallback) => fallback),
    caseTransferGroup: jest.fn((caseId) => `case_${String(caseId)}`),
    getPaymentIntentCharge: jest.fn(() => ({ receipt_url: "https://stripe.test/receipt" })),
    stripeIdempotencyKey: jest.fn((operation, ...parts) => `test_${operation}_${parts.join("_")}`),
  };
});

jest.mock("../services/caseLifecycle", () => ({
  buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%mock")),
  uploadPdfToS3: jest.fn(async () => ({ key: "cases/mock/receipt.pdf" })),
  getReceiptKey: jest.fn((caseId, kind) => `cases/${caseId}/receipt-${kind}-v2.pdf`),
}));

const stripe = require("../utils/stripe");
const caseLifecycle = require("../services/caseLifecycle");
const sendEmail = require("../utils/email");
const casesRouter = require("../routes/cases");
const paymentsRouter = require("../routes/payments");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/cases", casesRouter);
  instance.use("/api/payments", paymentsRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
  });
  return instance;
})();

function authCookieFor(user) {
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

afterAll(async () => {
  await closeDatabase();
});

beforeAll(async () => {
  await connect();
});

beforeEach(async () => {
  await clearDatabase();
  stripe.paymentIntents.create.mockReset();
  stripe.paymentIntents.retrieve.mockReset();
  stripe.paymentIntents.cancel.mockReset();
  stripe.refunds.create.mockReset();
  stripe.isTransferablePaymentIntent.mockClear();
  stripe.customers.retrieve.mockReset();
  stripe.customers.create.mockReset();
  stripe.customers.retrieve.mockResolvedValue({
    invoice_settings: { default_payment_method: "pm_test_default" },
  });
  stripe.paymentMethods.retrieve.mockReset();
  caseLifecycle.buildReceiptPdfBuffer.mockClear();
  sendEmail.mockClear();
});

test("reading payment readiness does not create a Stripe customer for an attorney without one", async () => {
  const attorney = await User.create({
    firstName: "Avery",
    lastName: "No Card",
    email: "attorney-no-card@example.com",
    password: "Password123!",
    role: "attorney",
    status: "approved",
    state: "CA",
  });

  const response = await request(app)
    .get("/api/payments/payment-method/default")
    .set("Cookie", authCookieFor(attorney));

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    customerId: null,
    hasDefault: false,
    paymentMethod: null,
  });
  expect(stripe.customers.create).not.toHaveBeenCalled();
  expect(stripe.customers.retrieve).not.toHaveBeenCalled();
  expect(stripe.paymentMethods.retrieve).not.toHaveBeenCalled();
});

describe("Job posting + escrow", () => {
  test("Attorney can post a case with minimum $400", async () => {
    // Description: Create a case with $400 budget.
    // Input values: title="Immigration support", practiceArea="immigration", budget=400.
    // Expected result: case saved with totalAmount=40000 cents.

    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Stone",
      email: "samanthasider+attorney@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
      stripeCustomerId: "cus_attorney_test_1",
    });
    const admin = await User.create({
      firstName: "Admin",
      lastName: "Reviewer",
      email: "admin@example.com",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    });

    const cookie = authCookieFor(attorney);

    const res = await request(app)
      .post("/api/cases")
      .set("Cookie", cookie)
      .send({
        title: "Immigration support",
        practiceArea: "immigration",
        description: "Need help preparing filings and reviewing documents.",
        totalAmount: 400,
        state: "CA",
      });

    expect(res.status).toBe(201);

    const created = await Case.findOne({ title: "Immigration support" }).lean();
    expect(created).toBeTruthy();
    expect(created.totalAmount).toBe(40000);
    expect(sendEmail).toHaveBeenCalledWith(
      admin.email,
      "New attorney Matter posted: Immigration support",
      expect.stringContaining("Review Matter posting in Admin")
    );
  });

  test("Posting fails on invalid values", async () => {
    // Description: Attempt to create a case with invalid practice area and zero budget.
    // Input values: practiceArea="invalid", totalAmount=0.
    // Expected result: 400 error response.

    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Stone",
      email: "samanthasider+attorney@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
      stripeCustomerId: "cus_attorney_test_2",
    });

    const cookie = authCookieFor(attorney);

    const res = await request(app)
      .post("/api/cases")
      .set("Cookie", cookie)
      .send({
        title: "Bad case",
        practiceArea: "invalid",
        description: "Short description but invalid practice area.",
        totalAmount: 0,
        state: "CA",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  test("Posting fails when budget is below $400", async () => {
    // Description: Attempt to create a case with budget below the $400 minimum.
    // Input values: totalAmount=399 (USD).
    // Expected result: 400 error response with minimum budget message.

    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Stone",
      email: "samanthasider+attorney@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
      stripeCustomerId: "cus_attorney_test_3",
    });

    const cookie = authCookieFor(attorney);

    const res = await request(app)
      .post("/api/cases")
      .set("Cookie", cookie)
      .send({
        title: "Below minimum",
        practiceArea: "immigration",
        description: "Need help preparing filings and reviewing documents.",
        totalAmount: 399,
        state: "CA",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least \$400/i);
  });

  test("Concurrent hire requests atomically select one paralegal and create one charge", async () => {
    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Stone",
      email: "concurrent-hire-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
      stripeCustomerId: "cus_concurrent_hire",
    });
    const [firstParalegal, secondParalegal] = await User.create([
      {
        firstName: "Jamie",
        lastName: "Lopez",
        email: "concurrent-hire-one@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        stripeAccountId: "acct_concurrent_one",
        stripeOnboarded: true,
        stripePayoutsEnabled: true,
      },
      {
        firstName: "Priya",
        lastName: "Ng",
        email: "concurrent-hire-two@example.com",
        password: "Password123!",
        role: "paralegal",
        status: "approved",
        stripeAccountId: "acct_concurrent_two",
        stripeOnboarded: true,
        stripePayoutsEnabled: true,
      },
    ]);
    const caseDoc = await Case.create({
      title: "Concurrent hire protection",
      practiceArea: "business law",
      details: "Only one paralegal may be selected and funded for this matter.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 40000,
      lockedTotalAmount: 40000,
      currency: "usd",
      tasks: [{ title: "Prepare intake summary", completed: false }],
      applicants: [
        { paralegalId: firstParalegal._id, status: "pending" },
        { paralegalId: secondParalegal._id, status: "pending" },
      ],
    });
    const job = await Job.create({
      caseId: caseDoc._id,
      attorneyId: attorney._id,
      title: caseDoc.title,
      practiceArea: caseDoc.practiceArea,
      description: caseDoc.details,
      budget: 400,
      status: "open",
      applicantsCount: 2,
    });
    caseDoc.jobId = job._id;
    await caseDoc.save();
    await Application.create([
      { jobId: job._id, paralegalId: firstParalegal._id, coverLetter: "First qualified application." },
      { jobId: job._id, paralegalId: secondParalegal._id, coverLetter: "Second qualified application." },
    ]);

    stripe.paymentIntents.create.mockImplementation(async (params) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        id: "pi_concurrent_hire",
        status: "succeeded",
        amount: params.amount,
        currency: params.currency,
        transfer_group: params.transfer_group,
        metadata: params.metadata,
        livemode: false,
        latest_charge: { id: "ch_concurrent_hire", paid: true, captured: true },
      };
    });

    const cookie = authCookieFor(attorney);
    const responses = await Promise.all([
      request(app)
        .post(`/api/cases/${caseDoc._id}/hire/${firstParalegal._id}`)
        .set("Cookie", cookie)
        .send({}),
      request(app)
        .post(`/api/cases/${caseDoc._id}/hire/${secondParalegal._id}`)
        .set("Cookie", cookie)
        .send({}),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    const stored = await Case.findById(caseDoc._id).lean();
    expect([String(firstParalegal._id), String(secondParalegal._id)]).toContain(
      String(stored?.paralegalId || "")
    );
    expect(String(stored?.paralegalId || "")).toBe(String(stored?.paralegal || ""));
    expect(stored?.escrowIntentId).toBe("pi_concurrent_hire");
    expect(stored?.escrowStatus).toBe("funded");
    expect(stored?.hiringClaimStatus).toBeNull();
    expect(stored?.hiringClaimToken).toBe("");
    expect(await Application.countDocuments({ jobId: job._id, status: "accepted" })).toBe(1);
    expect(await Application.countDocuments({ jobId: job._id, status: "rejected" })).toBe(1);
    expect((await Job.findById(job._id).lean())?.applicantsCount).toBe(0);
  });

  test("a successful hire charge survives a local save failure and retry without another charge", async () => {
    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Recovery",
      email: "hire-recovery-attorney@example.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "NY",
      stripeCustomerId: "cus_hire_recovery",
    });
    const paralegal = await User.create({
      firstName: "Parker",
      lastName: "Recovery",
      email: "hire-recovery-paralegal@example.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "NY",
      stripeAccountId: "acct_hire_recovery",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });
    const caseDoc = await Case.create({
      title: "Recoverable hire funding",
      practiceArea: "business law",
      details: "The successful charge must be reused after a local write interruption.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 40000,
      lockedTotalAmount: 40000,
      currency: "usd",
      tasks: [{ title: "Prepare intake summary", completed: false }],
      applicants: [{ paralegalId: paralegal._id, status: "pending" }],
    });
    const paymentIntent = {
      id: "pi_hire_recovery",
      status: "succeeded",
      amount: 48800,
      amount_received: 48800,
      currency: "usd",
      transfer_group: `case_${caseDoc._id}`,
      metadata: {
        caseId: String(caseDoc._id),
        attorneyId: String(attorney._id),
        paralegalId: String(paralegal._id),
      },
      livemode: false,
      latest_charge: { id: "ch_hire_recovery", paid: true, captured: true },
    };
    stripe.paymentIntents.create.mockResolvedValue(paymentIntent);
    stripe.paymentIntents.retrieve.mockResolvedValue(paymentIntent);

    const saveSpy = jest.spyOn(Case.prototype, "save").mockImplementationOnce(async function failHireSave() {
      throw new Error("simulated hire persistence interruption");
    });
    const first = await request(app)
      .post(`/api/cases/${caseDoc._id}/hire/${paralegal._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({});
    saveSpy.mockRestore();

    expect(first.status).toBe(500);
    expect(first.body.code).toBe("HIRE_RECONCILIATION_REQUIRED");
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    const interrupted = await Case.findById(caseDoc._id).lean();
    expect(interrupted.hiringClaimStatus).toBe("needs_reconciliation");
    expect(interrupted.hiringClaimPaymentIntentId).toBe("pi_hire_recovery");
    expect(interrupted.paralegalId).toBeNull();

    const retry = await request(app)
      .post(`/api/cases/${caseDoc._id}/hire/${paralegal._id}`)
      .set("Cookie", authCookieFor(attorney))
      .send({});
    expect(retry.status).toBe(200);
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(stripe.paymentIntents.retrieve).toHaveBeenCalledWith("pi_hire_recovery");
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    const recovered = await Case.findById(caseDoc._id).lean();
    expect(recovered.hiringClaimStatus).toBeNull();
    expect(recovered.hiringClaimPaymentIntentId).toBe("");
    expect(String(recovered.paralegalId)).toBe(String(paralegal._id));
    expect(recovered.status).toBe("in progress");
    expect(recovered.paymentStatus).toBe("succeeded");
  });

  test("Stripe escrow can be funded in test mode and receipt is returned", async () => {
    // Description: Create an escrow intent, confirm it succeeds, then fetch the receipt.
    // Input values: lockedTotalAmount=40000 cents, Stripe intent status=succeeded.
    // Expected result: confirm returns ok and receipt endpoint returns PDF.

    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Stone",
      email: "samanthasider+attorney@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Jamie",
      lastName: "Lopez",
      email: "samanthasider+paralegal@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Escrow test",
      practiceArea: "immigration",
      details: "Detailed case description for escrow test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "assigned",
      totalAmount: 40000,
      lockedTotalAmount: 40000,
      currency: "usd",
    });

    stripe.paymentIntents.create.mockResolvedValue({
      id: "pi_test_123",
      client_secret: "cs_test_123",
      status: "requires_payment_method",
      amount: 48800,
      currency: "usd",
      transfer_group: `case_${caseDoc._id}`,
    });

    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_test_123",
      status: "succeeded",
      amount: 48800,
      currency: "usd",
      transfer_group: `case_${caseDoc._id}`,
      metadata: { caseId: String(caseDoc._id) },
      latest_charge: { id: "ch_test_123", receipt_url: "https://stripe.test/receipt" },
    });

    const cookie = authCookieFor(attorney);

    const intentRes = await request(app)
      .post(`/api/payments/intent/${caseDoc._id}`)
      .set("Cookie", cookie)
      .send({});

    expect(intentRes.status).toBe(200);
    expect(intentRes.body.clientSecret).toBe("cs_test_123");
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 48800,
        currency: "usd",
      }),
      expect.any(Object)
    );

    const confirmRes = await request(app)
      .post(`/api/payments/confirm/${caseDoc._id}`)
      .set("Cookie", cookie)
      .send({});

    if (confirmRes.status !== 200) {
      throw new Error(
        `Escrow confirm failed: ${confirmRes.status} ${JSON.stringify(confirmRes.body)}`
      );
    }

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.ok).toBe(true);

    const refreshed = await Case.findById(caseDoc._id).lean();
    expect(refreshed.escrowStatus).toBe("funded");
    expect(refreshed.feeAttorneyPct).toBe(22);
    expect(refreshed.feeAttorneyAmount).toBe(8800);
    expect(refreshed.feeParalegalPct).toBe(18);
    expect(refreshed.feeParalegalAmount).toBe(7200);

    const receiptRes = await request(app)
      .get(`/api/payments/receipt/attorney/${caseDoc._id}`)
      .set("Cookie", cookie)
      .buffer(true);

    expect(receiptRes.status).toBe(200);
    expect(receiptRes.headers["content-type"]).toMatch(/application\/pdf/);
    expect(Buffer.isBuffer(receiptRes.body)).toBe(true);
    expect(receiptRes.body.length).toBeGreaterThan(5);
    expect(caseLifecycle.buildReceiptPdfBuffer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lineItems: expect.arrayContaining([
          expect.objectContaining({ label: "Matter amount", value: "$400.00" }),
          expect.objectContaining({ label: "Platform fee (22%)", value: "$88.00" }),
        ]),
        totalAmount: "$488.00",
      })
    );
  });

  test("Attorney receipt recomputes platform fee when historical snapshot is zero", async () => {
    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Stone",
      email: "samanthasider+attorney@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Historical receipt test",
      practiceArea: "immigration",
      details: "Historical funding record with a bad fee snapshot.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      totalAmount: 40000,
      lockedTotalAmount: 40000,
      feeAttorneyPct: 22,
      feeAttorneyAmount: 0,
      paymentIntentId: "pi_historical_123",
      escrowIntentId: "pi_historical_123",
      currency: "usd",
    });

    stripe.paymentIntents.retrieve.mockResolvedValue({
      id: "pi_historical_123",
      status: "succeeded",
      amount: 48800,
      currency: "usd",
      latest_charge: {
        id: "ch_historical_123",
        payment_method_details: { card: { brand: "visa", last4: "4242" } },
      },
    });

    const cookie = authCookieFor(attorney);
    const receiptRes = await request(app)
      .get(`/api/payments/receipt/attorney/${caseDoc._id}`)
      .set("Cookie", cookie)
      .buffer(true);

    expect(receiptRes.status).toBe(200);
    expect(caseLifecycle.buildReceiptPdfBuffer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lineItems: expect.arrayContaining([
          expect.objectContaining({ label: "Matter amount", value: "$400.00" }),
          expect.objectContaining({ label: "Platform fee (22%)", value: "$88.00" }),
        ]),
        totalAmount: "$488.00",
      })
    );
  });

  test("Budget update fails when below $400", async () => {
    // Description: Attempt to update case budget below $400 via payments endpoint.
    // Input values: amountUsd=399.
    // Expected result: 400 error response with minimum budget message.

    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Stone",
      email: "samanthasider+attorney@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const caseDoc = await Case.create({
      title: "Budget update test",
      practiceArea: "immigration",
      details: "Detailed case description for budget update test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 40000,
      currency: "usd",
    });

    const cookie = authCookieFor(attorney);

    const res = await request(app)
      .patch(`/api/payments/${caseDoc._id}/budget`)
      .set("Cookie", cookie)
      .send({ amountUsd: 399 });

    expect(res.status).toBe(400);
    expect(res.body.msg || res.body.error).toMatch(/at least \$400/i);
  });
});
