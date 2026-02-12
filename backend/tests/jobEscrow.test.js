const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const User = require("../models/User");
const Case = require("../models/Case");

const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

jest.mock("../utils/stripe", () => {
  const paymentIntents = {
    create: jest.fn(),
    retrieve: jest.fn(),
  };
  return {
    paymentIntents,
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
      charge: { receipt_url: "https://stripe.test/receipt" },
    })),
    getPaymentIntentCharge: jest.fn(() => ({ receipt_url: "https://stripe.test/receipt" })),
  };
});

jest.mock("../services/caseLifecycle", () => ({
  buildReceiptPdfBuffer: jest.fn(async () => Buffer.from("%PDF-1.4\n%mock")),
  uploadPdfToS3: jest.fn(async () => ({ key: "cases/mock/receipt.pdf" })),
  getReceiptKey: jest.fn((caseId, kind) => `cases/${caseId}/receipt-${kind}-v2.pdf`),
}));

const stripe = require("../utils/stripe");
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
  stripe.isTransferablePaymentIntent.mockClear();
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
      charges: { data: [{ receipt_url: "https://stripe.test/receipt" }] },
    });

    const cookie = authCookieFor(attorney);

    const intentRes = await request(app)
      .post(`/api/payments/intent/${caseDoc._id}`)
      .set("Cookie", cookie)
      .send({});

    expect(intentRes.status).toBe(200);
    expect(intentRes.body.clientSecret).toBe("cs_test_123");

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

    const receiptRes = await request(app)
      .get(`/api/payments/receipt/attorney/${caseDoc._id}`)
      .set("Cookie", cookie)
      .buffer(true);

    expect(receiptRes.status).toBe(200);
    expect(receiptRes.headers["content-type"]).toMatch(/application\/pdf/);
    expect(Buffer.isBuffer(receiptRes.body)).toBe(true);
    expect(receiptRes.body.length).toBeGreaterThan(5);
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
