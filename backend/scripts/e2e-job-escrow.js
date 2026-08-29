const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const http = require("http");
const path = require("path");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const { launchPuppeteer, clickVisible } = require("./puppeteerBrowser");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.ENABLE_CSRF = "false";
process.env.EMAIL_DISABLE = "true";
process.env.STRIPE_CONNECT_RETURN_URL =
  process.env.STRIPE_CONNECT_RETURN_URL || "http://localhost:5050/stripe/connect/return";
process.env.STRIPE_CONNECT_REFRESH_URL =
  process.env.STRIPE_CONNECT_REFRESH_URL || "http://localhost:5050/stripe/connect/refresh";
process.env.APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5050";

let createdPaymentIntent = null;
const stripeMock = {
  paymentIntents: {
    create: async (params) => {
      const confirmedHire = params.confirm === true && params.off_session === true;
      createdPaymentIntent = {
        ...params,
        id: confirmedHire ? "pi_ui_hire_123" : "pi_test_123",
        client_secret: confirmedHire ? "cs_ui_hire_123" : "cs_test_123",
        status: confirmedHire ? "succeeded" : "requires_payment_method",
        amount_received: confirmedHire ? params.amount : 0,
        livemode: false,
        charges: {
          data: confirmedHire
            ? [{
                id: "ch_ui_hire_123",
                paid: true,
                refunded: false,
                amount: params.amount,
                amount_refunded: 0,
                currency: params.currency,
                receipt_url: "https://stripe.test/ui-hire-receipt",
              }]
            : [],
        },
      };
      return createdPaymentIntent;
    },
    retrieve: async (intentId) => ({
      ...createdPaymentIntent,
      id: intentId || createdPaymentIntent?.id || "pi_test_123",
      status: "succeeded",
      amount_received: createdPaymentIntent?.amount,
      livemode: false,
      charges: { data: [{ receipt_url: "https://stripe.test/receipt" }] },
    }),
    cancel: async (intentId) => ({ id: intentId, status: "canceled" }),
  },
  customers: {
    create: async () => ({ id: "cus_test" }),
    retrieve: async (customerId) => ({
      id: customerId,
      invoice_settings: { default_payment_method: "pm_test_card" },
    }),
  },
  paymentMethods: {
    retrieve: async (paymentMethodId) => ({
      id: paymentMethodId,
      type: "card",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2035 },
    }),
  },
  refunds: { create: async () => ({ id: "re_test", status: "succeeded" }) },
  caseTransferGroup: (caseId) => `case_${caseId}`,
  stripeIdempotencyKey: (operation, ...parts) => `e2e_${operation}_${parts.join("_")}`,
  sanitizeStripeError: (_error, fallback) => fallback,
  isTransferablePaymentIntent: () => ({ transferable: true, charge: { receipt_url: "https://stripe.test/receipt" } }),
};

const caseLifecycleMock = {
  buildReceiptPdfBuffer: async () => Buffer.from("%PDF-1.4\n%mock"),
  generateArchiveZip: async () => ({ key: "cases/mock/archive.zip", readyAt: new Date() }),
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
const caseDraftsRouter = require("../routes/caseDrafts");
const paymentsRouter = require("../routes/payments");
const usersRouter = require("../routes/users");
const verifyToken = require("../utils/verifyToken");
const frontendRoot = path.resolve(__dirname, "../../frontend");

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
  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "e2e-csrf-token" }));
  app.get("/api/auth/me", verifyToken, async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id).lean();
      if (!user) return res.status(404).json({ user: null });
      return res.json({
        user: {
          id: user._id,
          _id: user._id,
          role: user.role,
          status: user.status,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
      });
    } catch (error) {
      return next(error);
    }
  });
  app.use("/api/cases", casesRouter);
  app.use("/api/case-drafts", caseDraftsRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/paralegals", usersRouter.paralegalRouter);
  app.get("/assets/vendor/web-vitals-6.1.1.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.resolve(__dirname, "../node_modules/web-vitals/dist/web-vitals.js"));
  });
  app.use(express.static(frontendRoot));

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
  let browser;

  try {
    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Stone",
      // Use a Stripe-bypass email to allow case posting without a stored payment method.
      email: "game4funwithme1+1@gmail.com",
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

    browser = await launchPuppeteer();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCookie({
      name: "token",
      value: cookie.slice("token=".length),
      url: baseUrl,
      httpOnly: true,
      sameSite: "Lax",
    });
    const pageErrors = [];
    const failedLocalAssets = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin === baseUrl && !url.pathname.startsWith("/api/") && response.status() >= 400) {
        failedLocalAssets.push(`${response.status()} ${url.pathname}`);
      }
    });

    await page.goto(`${baseUrl}/create-case.html`, { waitUntil: "networkidle0" });
    await page.waitForSelector("#create-step-details:not([hidden])");
    await page.type("#caseTitleInput", "Immigration filing support");
    await page.select("#specialty", "Immigration Law");
    await page.select("#state", "California");
    await page.type("#comp", "399");
    await clickVisible(page, "#detailsNextBtn");
    await page.waitForSelector('#comp[aria-invalid="true"]');
    const minimumError = await page.$eval("#comp-error", (node) => node.textContent.trim());
    if (minimumError !== "Enter a compensation amount of at least $400.") {
      throw new Error(`Unexpected minimum-compensation error: ${minimumError}`);
    }

    await page.focus("#comp");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.type("#comp", "400");
    const correctedCompensation = await page.$eval("#comp", (input) => input.value);
    if (correctedCompensation !== "400") {
      throw new Error(`Compensation replacement failed: ${correctedCompensation}`);
    }
    await clickVisible(page, "#detailsNextBtn");
    await page.waitForSelector("#create-step-description:not([hidden])");
    await page.type(
      "#caseDescription",
      "Prepare immigration filing exhibits, review the supporting record, and organize the final submission package."
    );
    await page.type("#caseTaskInput", "Organize supporting exhibits");
    await clickVisible(page, "#addCaseTaskBtn");
    await page.waitForFunction(() => document.querySelectorAll("#caseTaskList li").length === 1);
    await clickVisible(page, '#create-step-description [data-step-switch="review"]');
    await page.waitForSelector("#create-step-review:not([hidden])");

    const reviewText = await page.$eval("#reviewSummary", (node) => node.textContent);
    if (!reviewText.includes("Immigration filing support") || !reviewText.includes("Organize supporting exhibits")) {
      throw new Error("Review step did not preserve the entered Matter details and task.");
    }
    await clickVisible(page, "#previewBtn");
    await page.waitForSelector("#previewModal.active");
    const previewTitle = await page.$eval("#previewTitle", (node) => node.textContent.trim());
    if (previewTitle !== "Immigration filing support") {
      throw new Error(`Unexpected Matter preview title: ${previewTitle}`);
    }
    await page.keyboard.press("Escape");
    await page.waitForSelector('#previewModal[aria-hidden="true"][inert]');

    const createResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/cases" && response.request().method() === "POST";
    });
    await clickVisible(page, "#postBtn");
    const createResponse = await createResponsePromise;
    if (createResponse.status() !== 201) {
      throw new Error(`Expected UI Matter creation 201, got ${createResponse.status()}`);
    }
    const createdMatterPayload = await createResponse.json();
    await page.waitForFunction(() => location.pathname === "/dashboard-attorney.html" && location.hash === "#cases");
    await page.waitForSelector('#casePostedModal.is-active[aria-hidden="false"]');

    const uiPostedCase = await Case.findOne({ title: "Immigration filing support" }).lean();
    if (!uiPostedCase) throw new Error("The real create-Matter UI did not persist a Case record.");
    if (uiPostedCase.totalAmount !== 40000 || uiPostedCase.practiceArea !== "immigration") {
      throw new Error(`Unexpected persisted UI Matter: ${JSON.stringify(uiPostedCase)}`);
    }
    if (uiPostedCase.tasks?.length !== 1 || uiPostedCase.tasks[0]?.title !== "Organize supporting exhibits") {
      throw new Error(`Unexpected persisted task scope: ${JSON.stringify(uiPostedCase.tasks)}`);
    }
    if (String(createdMatterPayload?.id || createdMatterPayload?._id || "") !== String(uiPostedCase._id)) {
      throw new Error(`Created Matter response did not match persistence: ${JSON.stringify(createdMatterPayload)}`);
    }
    const postedNoticeText = await page.$eval("#casePostedText", (node) => node.textContent.trim());
    if (!postedNoticeText.includes("Immigration filing support") || !postedNoticeText.includes("open to applications")) {
      throw new Error(`Missing post-success Matter confirmation: ${postedNoticeText}`);
    }
    if (pageErrors.length) throw new Error(`Create-Matter UI page errors:\n${pageErrors.join("\n")}`);
    if (failedLocalAssets.length) throw new Error(`Create-Matter UI asset failures:\n${failedLocalAssets.join("\n")}`);

    const uiHireCase = await Case.create({
      title: "Browser Hire Matter",
      practiceArea: "immigration",
      details: "Review the filing record and prepare the final immigration exhibit index.",
      attorney: attorney._id,
      attorneyId: attorney._id,
      status: "open",
      totalAmount: 80000,
      lockedTotalAmount: 80000,
      currency: "usd",
      tasks: [{ title: "Prepare exhibit index", completed: false }],
      applicants: [{
        paralegalId: paralegal._id,
        status: "pending",
        note: "I can prepare and verify this filing package.",
        appliedAt: new Date(),
      }],
    });
    const applicantReturnTo = `/dashboard-attorney.html?caseId=${uiHireCase._id}&applicantId=${paralegal._id}&returnFromProfile=1#cases:inquiries`;
    const applicantProfileUrl = `${baseUrl}/profile-paralegal.html?paralegalId=${paralegal._id}&returnTo=${encodeURIComponent(applicantReturnTo)}`;
    await page.goto(applicantProfileUrl, { waitUntil: "networkidle0" });
    await page.waitForFunction(
      () => document.querySelector("#profileName")?.textContent?.trim() === "Jamie Lopez"
    );
    await page.waitForFunction(
      () => document.querySelector("#inviteToCaseBtn")?.dataset?.mode === "hire"
    );
    const hireEntryLabel = await page.$eval("#inviteToCaseBtn", (button) => button.textContent.trim());
    if (hireEntryLabel !== "Hire for Browser Hire Matter") {
      throw new Error(`Unexpected hire entry label: ${hireEntryLabel}`);
    }
    await clickVisible(page, "#inviteToCaseBtn");
    await page.waitForSelector('.hire-confirm-overlay.is-visible [data-hire-step="pre-engagement"]');
    const noneSelected = await page.$eval(
      '[data-pre-option="none"]',
      (input) => input.checked === true
    );
    if (!noneSelected) throw new Error("The optional pre-engagement step did not default to None.");
    await clickVisible(page, "[data-pre-next]");
    await page.waitForSelector('[data-hire-step="fund-hire"]');
    const hireSummary = await page.$eval(".hire-confirm-summary", (node) => node.textContent);
    if (!hireSummary.includes("$800.00") || !hireSummary.includes("$176.00") || !hireSummary.includes("$976.00")) {
      throw new Error(`Unexpected hire fee summary: ${hireSummary}`);
    }
    const hireResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" &&
        url.pathname === `/api/cases/${uiHireCase._id}/hire/${paralegal._id}`;
    });
    await clickVisible(page, "[data-hire-confirm]");
    const hireResponse = await hireResponsePromise;
    if (hireResponse.status() !== 200) {
      throw new Error(`Expected UI hire 200, got ${hireResponse.status()}: ${await hireResponse.text()}`);
    }
    await page.waitForSelector("[data-hire-success]:not([hidden])");
    const hireSuccess = await page.$eval("[data-hire-success]", (node) => node.textContent.trim());
    if (hireSuccess !== "Matter funded. Work can begin.") {
      throw new Error(`Unexpected hire confirmation: ${hireSuccess}`);
    }
    const hiredMatter = await Case.findById(uiHireCase._id).lean();
    if (
      String(hiredMatter?.paralegalId || "") !== String(paralegal._id) ||
      String(hiredMatter?.paralegal || "") !== String(paralegal._id) ||
      String(hiredMatter?.status || "").toLowerCase() !== "in progress" ||
      hiredMatter?.escrowStatus !== "funded" ||
      hiredMatter?.paymentStatus !== "succeeded" ||
      hiredMatter?.escrowIntentId !== "pi_ui_hire_123" ||
      hiredMatter?.feeAttorneyAmount !== 17600 ||
      hiredMatter?.feeParalegalAmount !== 14400 ||
      hiredMatter?.tasksLocked !== true
    ) {
      throw new Error(`Unexpected persisted UI hire state: ${JSON.stringify(hiredMatter)}`);
    }
    if (pageErrors.length) throw new Error(`Hire UI page errors:\n${pageErrors.join("\n")}`);
    if (failedLocalAssets.length) throw new Error(`Hire UI asset failures:\n${failedLocalAssets.join("\n")}`);

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
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
