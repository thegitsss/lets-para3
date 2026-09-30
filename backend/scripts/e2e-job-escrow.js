const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const http = require("http");
const path = require("path");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const { connectE2eDatabase } = require("./e2e-database-fixture");
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
        client_secret: confirmedHire ? "pi_ui_hire_123_secret_synthetic" : "pi_test_123_secret_synthetic",
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
    retrieve: async (intentId) => {
      if (!createdPaymentIntent || intentId !== createdPaymentIntent.id) {
        throw new Error(`Unknown synthetic PaymentIntent: ${intentId}`);
      }
      const chargeId = createdPaymentIntent.charges?.data?.[0]?.id || "ch_test_123";
      const charge = {
        id: chargeId,
        payment_intent: intentId,
        status: "succeeded", livemode: false,
        paid: true, captured: true, refunded: false, disputed: false,
        amount: createdPaymentIntent.amount,
        amount_captured: createdPaymentIntent.amount,
        amount_refunded: 0, currency: createdPaymentIntent.currency,
        receipt_url: "https://stripe.test/receipt",
        balance_transaction: {
          id: "txn_test_123", source: chargeId, type: "charge",
          currency: createdPaymentIntent.currency,
          amount: createdPaymentIntent.amount,
          fee: 1445, net: createdPaymentIntent.amount - 1445,
        },
      };
      return {
        ...createdPaymentIntent,
        status: "succeeded", amount_received: createdPaymentIntent.amount,
        latest_charge: charge, charges: { data: [charge] },
      };
    },
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
      customer: "cus_test",
      type: "card",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2035 },
    }),
  },
  refunds: {
    create: async () => ({ id: "re_test", status: "succeeded" }),
    list: async () => ({ data: [], has_more: false }),
  },
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
require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: stripeMock };
const caseLifecyclePath = require.resolve("../services/caseLifecycle");
require.cache[caseLifecyclePath] = { id: caseLifecyclePath, filename: caseLifecyclePath, loaded: true, exports: caseLifecycleMock };

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
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve));
  const { port } = server.address();
  return { server, port };
}

async function main() {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } });
  await connectE2eDatabase(mongoose, mongo.getUri());

  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser, page, hiringRead;

  try {
    const attorney = await User.create({
      firstName: "Ava",
      lastName: "Stone",
      email: "attorney+job-escrow@example.test",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
      stripeCustomerId: "cus_test",
    });

    const paralegal = await User.create({
      firstName: "Jamie",
      lastName: "Lopez",
      email: "paralegal+job-escrow@example.test",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stripeAccountId: "acct_test_paralegal",
      stripeOnboarded: true,
      stripePayoutsEnabled: true,
    });

    const cookie = authCookieFor(attorney);

    browser = await launchPuppeteer();
    page = await browser.newPage();
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
    await page.waitForFunction(() => document.getElementById("postBtn")?.disabled === false);

    const createResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/cases/posting/publications" && response.request().method() === "POST";
    });
    // Preserve an earlier interaction error if cleanup closes this pending wait.
    // The original promise is still awaited below and still rejects on failure.
    createResponsePromise.catch(() => {});
    await clickVisible(page, "#postBtn");
    await page.waitForSelector("#matter-publishing-practice");
    await page.select("#matter-publishing-practice", "immigration");
    await page.locator("::-p-text(Confirm and publish Matter)").click();
    const createResponse = await createResponsePromise;
    if (createResponse.status() !== 201) {
      throw new Error(`Expected UI Matter creation 201, got ${createResponse.status()}: ${await createResponse.text()}`);
    }
    const createdMatterPayload = await createResponse.json();
    await page.waitForSelector('[aria-label="Publication status"][data-state="complete"]');

    const uiPostedCase = await Case.findOne({ title: "Immigration filing support" }).lean();
    if (!uiPostedCase) throw new Error("The real create-Matter UI did not persist a Case record.");
    if (uiPostedCase.totalAmount !== 40000 || uiPostedCase.practiceArea !== "immigration") {
      throw new Error(`Unexpected persisted UI Matter: ${JSON.stringify(uiPostedCase)}`);
    }
    if (uiPostedCase.tasks?.length !== 1 || uiPostedCase.tasks[0]?.title !== "Organize supporting exhibits") {
      throw new Error(`Unexpected persisted task scope: ${JSON.stringify(uiPostedCase.tasks)}`);
    }
    if (String(createdMatterPayload?.publication?.caseId || "") !== String(uiPostedCase._id)) {
      throw new Error(`Created Matter response did not match persistence: ${JSON.stringify(createdMatterPayload)}`);
    }
    const postedNoticeText = await page.$eval('[aria-label="Publication status"]', (node) => node.textContent.trim());
    if (!postedNoticeText.includes("Matter posted") || !postedNoticeText.includes("Publishing does not charge you")) {
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
    if (hireEntryLabel !== "Review hire") {
      throw new Error(`Unexpected hire entry label: ${hireEntryLabel}`);
    }
    const hiringReadPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/cases/${uiHireCase._id}/hiring-review/${paralegal._id}` && response.request().method() === "GET");
    hiringReadPromise.catch(() => {});
    await clickVisible(page, "#inviteToCaseBtn");
    const hiringReadResponse = await hiringReadPromise;
    hiringRead = { status: hiringReadResponse.status(), body: await hiringReadResponse.json() };
    if (hiringRead.status !== 200 || hiringRead.body.reason !== "ready") throw new Error(`Hiring review was not ready: ${JSON.stringify(hiringRead)}`);
    await page.waitForSelector('dialog.lpc-engagement-dialog[open] [data-hiring][data-state="ready"]');
    await page.locator('::-p-aria(Review pre-engagement requirements)').click();
    await page.waitForSelector('dialog[open] [data-pre-engagement][data-state="ready"]');
    const noneSelected = await page.$eval('[data-pre-engagement]', section =>
      section.textContent.includes("No pre-engagement requirements have been recorded for this Matter.") &&
      section.querySelectorAll('input[type="checkbox"]').length === 2 &&
      [...section.querySelectorAll('input[type="checkbox"]')].every(input => !input.checked));
    if (!noneSelected) throw new Error("The optional pre-engagement step did not default to None.");
    await page.locator('::-p-aria(Continue to hiring review)').click();
    await page.waitForSelector('dialog[open] [data-hiring][data-state="ready"]');
    await page.locator('::-p-aria(Review hiring confirmation)').click();
    const hireSummary = await page.$eval("dialog[open] [data-hiring]", (node) => node.textContent);
    if (!hireSummary.includes("$800.00") || !hireSummary.includes("$176.00") || !hireSummary.includes("$976.00")) {
      throw new Error(`Unexpected hire fee summary: ${hireSummary}`);
    }
    const hireResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" &&
        url.pathname === `/api/cases/${uiHireCase._id}/hire/${paralegal._id}`;
    });
    hireResponsePromise.catch(() => {});
    await page.locator('::-p-aria(Hire and charge $976.00)').click();
    const hireResponse = await hireResponsePromise;
    if (hireResponse.status() !== 200) {
      throw new Error(`Expected UI hire 200, got ${hireResponse.status()}: ${await hireResponse.text()}`);
    }
    await page.waitForFunction(() => document.querySelector('dialog[open] [data-hiring][data-state="ready"]')?.textContent.includes("This paralegal is assigned, and the Matter's funding is verified."));
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
      throw new Error(`Expected intent 200, got ${res.status}: ${await res.text()}`);
    }

    // Test: Escrow success returns receipt.
    res = await fetch(`${baseUrl}/api/payments/confirm/${caseDoc._id}`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) {
      throw new Error(`Expected confirm 200, got ${res.status}: ${await res.text()}`);
    }

    res = await fetch(`${baseUrl}/api/payments/receipt/attorney/${caseDoc._id}`, {
      headers: { Cookie: cookie },
    });
    if (res.status !== 200) {
      throw new Error(`Expected receipt 200, got ${res.status}: ${await res.text()}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/pdf")) {
      throw new Error(`Expected PDF receipt, got ${contentType}`);
    }

    console.log("E2E job posting + escrow validation complete.");
  } catch (error) {
    const state = await page?.evaluate(() => ({ url: location.href,
      dialog: document.querySelector('dialog[open]')?.textContent?.trim(),
      publication: document.querySelector('[aria-label="Publication status"]')?.textContent?.trim(),
    })).catch(() => null);
    console.error("Publishing/hiring failure state:", JSON.stringify({ ...state, hiringRead }));
    throw error;
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
