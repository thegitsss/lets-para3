const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const http = require("http");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const { connectE2eDatabase } = require("./e2e-database-fixture");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.EMAIL_DISABLE = "true";
process.env.STRIPE_CONNECT_RETURN_URL =
  process.env.STRIPE_CONNECT_RETURN_URL || "http://localhost:5050/stripe/connect/return";
process.env.STRIPE_CONNECT_REFRESH_URL =
  process.env.STRIPE_CONNECT_REFRESH_URL || "http://localhost:5050/stripe/connect/refresh";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5050";

const paymentIntentCaseIds = new Map();
const stripeMock = {
  paymentIntents: {
    retrieve: async (intentId) => ({
      id: intentId,
      status: "succeeded",
      livemode: false,
      amount: 122000,
      amount_received: 122000,
      currency: "usd",
      transfer_group: `case_${paymentIntentCaseIds.get(intentId) || "missing"}`,
      metadata: { caseId: paymentIntentCaseIds.get(intentId) || "" },
      charges: { data: [{ id: "ch_test_123" }] },
    }),
  },
  transfers: {
    create: async (payload) => {
      stripeMock._lastTransferPayload = payload;
      return { id: "tr_test_123" };
    },
  },
  isTransferablePaymentIntent: () => ({ transferable: true, charge: { id: "ch_test_123" } }),
  sanitizeStripeError: (err, fallback) => err?.message || fallback,
  accounts: { create: async () => ({ id: "acct_test" }), retrieve: async () => ({}) },
  customers: { create: async () => ({ id: "cus_test" }), retrieve: async () => ({}) },
  caseTransferGroup: (caseId) => `case_${caseId}`,
  stripeIdempotencyKey: (operation, ...parts) => `test_${operation}_${parts.join("_")}`,
  _lastTransferPayload: null,
};

const caseLifecycleMock = {
  generateArchiveZip: async () => ({ key: "cases/mock/archive.zip", readyAt: new Date() }),
  buildReceiptPdfBuffer: async () => Buffer.from("%PDF-1.4\n%mock"),
  uploadPdfToS3: async () => ({ key: "cases/mock/receipt.pdf" }),
  getReceiptKey: (caseId, kind) => `cases/${caseId}/receipt-${kind}.pdf`,
};

const stripePath = require.resolve("../utils/stripe");
require.cache[stripePath] = { exports: stripeMock };
const caseLifecyclePath = require.resolve("../services/caseLifecycle");
require.cache[caseLifecyclePath] = { exports: caseLifecycleMock };

const User = require("../models/User");
const Case = require("../models/Case");
const Payout = require("../models/Payout");
const PaymentOperation = require("../models/PaymentOperation");
const casesRouter = require("../routes/cases");
const paymentsRouter = require("../routes/payments");

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

async function startServer() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/cases", casesRouter);
  app.use("/api/payments", paymentsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve));
  const { port } = server.address();
  return { server, port };
}

async function main() {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } });
  await connectE2eDatabase(mongoose, mongo.getUri());

  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const attorney = await User.create({
      firstName: "Alex",
      lastName: "Stone",
      email: "attorney+payout@gmail.com",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    });

    const paralegal = await User.create({
      firstName: "Priya",
      lastName: "Ng",
      email: "paralegal+payout@gmail.com",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_amex_business",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });

    const caseDoc = await Case.create({
      title: "Escrow payout test",
      practiceArea: "immigration",
      details: "Case details for payout test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: "pi_test_123",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });
    paymentIntentCaseIds.set(caseDoc.escrowIntentId, String(caseDoc._id));

    const cookie = authCookieFor(attorney);
    const paralegalCookie = authCookieFor(paralegal);

    // Test: Payout transfer created to connected account.
    let res = await fetch(`${baseUrl}/api/cases/${caseDoc._id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    if (res.status !== 200) {
      const operation = await PaymentOperation.findOne({ caseId: caseDoc._id }).select("lastError").lean();
      throw new Error(`Expected 200, got ${res.status}: ${await res.text()}; retained error=${operation?.lastError || "none"}`);
    }

    const payload = stripeMock._lastTransferPayload;
    if (!payload || payload.destination !== "acct_amex_business") {
      throw new Error("Transfer destination mismatch for Amex Business account");
    }

    const payoutDoc = await Payout.findOne({ caseId: caseDoc._id }).lean();
    if (!payoutDoc || payoutDoc.amountPaid !== 82000) {
      throw new Error(`Payout amount incorrect: ${payoutDoc?.amountPaid}`);
    }

    // Test: Paralegal can download payout receipt.
    res = await fetch(`${baseUrl}/api/payments/receipt/paralegal/${caseDoc._id}`, {
      headers: { Cookie: paralegalCookie },
    });
    if (res.status !== 200) {
      throw new Error(`Expected paralegal receipt 200, got ${res.status}`);
    }
    const receiptContentType = res.headers.get("content-type") || "";
    if (!receiptContentType.includes("application/pdf")) {
      throw new Error(`Expected paralegal PDF receipt, got ${receiptContentType}`);
    }

    // Test: Error handling for failed payouts.
    stripeMock.transfers.create = async () => {
      throw new Error("Transfer failed");
    };
    stripeMock._lastTransferPayload = null;

    const caseFail = await Case.create({
      title: "Escrow payout error test",
      practiceArea: "immigration",
      details: "Case details for payout error test.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      paralegal: paralegal._id,
      paralegalId: paralegal._id,
      status: "in progress",
      escrowStatus: "funded",
      escrowIntentId: "pi_test_456",
      lockedTotalAmount: 100000,
      totalAmount: 100000,
      currency: "usd",
      tasks: [{ title: "Finalize and deliver", completed: true }],
    });
    paymentIntentCaseIds.set(caseFail.escrowIntentId, String(caseFail._id));

    res = await fetch(`${baseUrl}/api/cases/${caseFail._id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    const failure = await res.json();
    if (res.status !== 409 || failure.code !== "PAYOUT_RECONCILIATION_REQUIRED") {
      throw new Error(`Expected payout reconciliation 409, got ${res.status}: ${JSON.stringify(failure)}`);
    }
    const [failedMatter, failedPayout, failedOperation] = await Promise.all([
      Case.findById(caseFail._id).lean(), Payout.findOne({ caseId: caseFail._id }).lean(),
      PaymentOperation.findOne({ operationKey: `case_payout:${caseFail._id}` }).lean(),
    ]);
    if (failedPayout || failedMatter.paymentReleased || failedMatter.payoutTransferId ||
        failedMatter.payoutStatus !== "needs_reconciliation" || failedOperation?.status !== "needs_reconciliation") {
      throw new Error("An unconfirmed transfer was not retained for reconciliation without recording a payout.");
    }

    console.log("E2E payouts validation complete.");
  } finally {
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.connection.close();
    await new Promise((resolve) => server.close(resolve));
    await mongo.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
