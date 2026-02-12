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
    create: async () => ({
      id: "pi_test_123",
      client_secret: "cs_test_123",
      status: "requires_payment_method",
      amount: 48800,
      currency: "usd",
      transfer_group: "case_test",
    }),
    retrieve: async () => ({
      id: "pi_test_123",
      status: "succeeded",
      amount: 48800,
      currency: "usd",
      transfer_group: "case_test",
      charges: { data: [{ receipt_url: "https://stripe.test/receipt" }] },
    }),
  },
  customers: { create: async () => ({ id: "cus_test" }), retrieve: async () => ({}) },
  isTransferablePaymentIntent: () => ({ transferable: true, charge: { receipt_url: "https://stripe.test/receipt" } }),
};

const caseLifecycleMock = {
  buildReceiptPdfBuffer: async () => Buffer.from("%PDF-1.4\n%mock"),
  uploadPdfToS3: async () => ({ key: "cases/mock/receipt.pdf" }),
  getReceiptKey: (caseId, kind) => `cases/${caseId}/receipt-${kind}-v2.pdf`,
};

const stripePath = require.resolve("../utils/stripe");
require.cache[stripePath] = { exports: stripeMock };
const caseLifecyclePath = require.resolve("../services/caseLifecycle");
require.cache[caseLifecyclePath] = { exports: caseLifecycleMock };

const User = require("../models/User");
const Case = require("../models/Case");
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

    const cookie = authCookieFor(attorney);

    // Test: Attorney can post a $400 case (valid values).
    // Expected result: 201 Created.
    let res = await fetch(`${baseUrl}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Immigration support",
        practiceArea: "immigration",
        description: "Need help preparing filings and reviewing documents.",
        totalAmount: 400,
        state: "CA",
      }),
    });
    if (res.status !== 201) {
      throw new Error(`Expected 201, got ${res.status}`);
    }
    const postedCase = await res.json().catch(() => ({}));

    // Test: Posting fails on invalid values.
    // Expected result: 400 Bad Request.
    res = await fetch(`${baseUrl}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Bad case",
        practiceArea: "invalid",
        description: "Short description but invalid practice area.",
        totalAmount: 0,
        state: "CA",
      }),
    });
    if (res.status !== 400) {
      throw new Error(`Expected 400, got ${res.status}`);
    }

    // Test: Posting fails when budget is below $400.
    // Expected result: 400 Bad Request.
    res = await fetch(`${baseUrl}/api/cases`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: "Below minimum",
        practiceArea: "immigration",
        description: "Need help preparing filings and reviewing documents.",
        totalAmount: 399,
        state: "CA",
      }),
    });
    if (res.status !== 400) {
      throw new Error(`Expected 400 for below minimum, got ${res.status}`);
    }

    // Test: Budget update endpoint rejects below $400.
    // Expected result: 400 Bad Request.
    if (postedCase?._id || postedCase?.id) {
      const caseId = postedCase._id || postedCase.id;
      res = await fetch(`${baseUrl}/api/payments/${caseId}/budget`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ amountUsd: 399 }),
      });
      if (res.status !== 400) {
        throw new Error(`Expected 400 for budget update below minimum, got ${res.status}`);
      }
    }

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

    // Test: Stripe escrow can be funded in test mode.
    res = await fetch(`${baseUrl}/api/payments/intent/${caseDoc._id}`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) {
      throw new Error(`Expected intent 200, got ${res.status}`);
    }

    // Test: Escrow success returns receipt.
    res = await fetch(`${baseUrl}/api/payments/confirm/${caseDoc._id}`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) {
      throw new Error(`Expected confirm 200, got ${res.status}`);
    }

    res = await fetch(`${baseUrl}/api/payments/receipt/attorney/${caseDoc._id}`, {
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) {
      throw new Error(`Expected receipt 200, got ${res.status}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/pdf")) {
      throw new Error(`Expected PDF receipt, got ${contentType}`);
    }

    console.log("E2E job posting + escrow validation complete.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
