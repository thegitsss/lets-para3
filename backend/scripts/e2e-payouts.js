const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const http = require("http");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.EMAIL_DISABLE = "true";
process.env.STRIPE_CONNECT_RETURN_URL =
  process.env.STRIPE_CONNECT_RETURN_URL || "http://localhost:5050/stripe/connect/return";
process.env.STRIPE_CONNECT_REFRESH_URL =
  process.env.STRIPE_CONNECT_REFRESH_URL || "http://localhost:5050/stripe/connect/refresh";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5050";

const stripeMock = {
  paymentIntents: {
    retrieve: async () => ({
      id: "pi_test_123",
      status: "succeeded",
      currency: "usd",
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
const casesRouter = require("../routes/cases");

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

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, port };
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "e2e" });

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

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
    });

    const cookie = authCookieFor(attorney);

    // Test: Payout transfer created to connected account.
    let res = await fetch(`${baseUrl}/api/cases/${caseDoc._id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    if (res.status !== 200) {
      throw new Error(`Expected 200, got ${res.status}`);
    }

    const payload = stripeMock._lastTransferPayload;
    if (!payload || payload.destination !== "acct_amex_business") {
      throw new Error("Transfer destination mismatch for Amex Business account");
    }

    const payoutDoc = await Payout.findOne({ caseId: caseDoc._id }).lean();
    if (!payoutDoc || payoutDoc.amountPaid !== 82000) {
      throw new Error(`Payout amount incorrect: ${payoutDoc?.amountPaid}`);
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
    });

    res = await fetch(`${baseUrl}/api/cases/${caseFail._id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    if (res.status !== 400) {
      throw new Error(`Expected 400 for failed payout, got ${res.status}`);
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
