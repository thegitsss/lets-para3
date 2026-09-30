const path = require("path");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const { clickVisible, launchPuppeteer } = require("./puppeteerBrowser");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const { connectE2eDatabase } = require("./e2e-database-fixture");
const {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
} = require("../utils/legalDocuments");

const ACCOUNT_PASSWORD = "Correct-Horse-Battery-Staple-9";
const BROWSER_STEP_TIMEOUT_MS = 45_000;
const paymentIntentCaseIds = new Map();

function launchReadyAccountFields() {
  const acceptedAt = new Date();
  return {
    emailVerified: true,
    termsAccepted: true,
    termsVersion: CURRENT_TERMS_VERSION,
    termsAcceptedAt: acceptedAt,
    privacyVersion: CURRENT_PRIVACY_VERSION,
    privacyAcknowledgedAt: acceptedAt,
  };
}

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.S3_REGION = process.env.S3_REGION || "us-east-1";
process.env.CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || "http://127.0.0.1:5050";

const emailLog = [];
const sendEmailMock = async (to, subject, html, opts = {}) => {
  emailLog.push({ to, subject, html, opts });
  return { mocked: true };
};
sendEmailMock.log = emailLog;

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
  paymentMethods: {
    retrieve: async () => ({ id: "pm_test", card: { brand: "visa", last4: "4242" } }),
  },
  transfers: {
    create: async (payload) => {
      stripeMock._transfers.push(payload);
      return { ...payload, id: `tr_${Date.now()}`, object: "transfer", livemode: false, reversed: false, amount_reversed: 0 };
    },
  },
  refunds: {
    create: async () => ({ id: `re_${Date.now()}` }),
  },
  accounts: {
    create: async () => ({ id: `acct_${Date.now()}` }),
    retrieve: async () => ({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    }),
  },
  customers: {
    create: async () => ({ id: `cus_${Date.now()}` }),
    retrieve: async () => ({ invoice_settings: { default_payment_method: "pm_test" } }),
  },
  isTransferablePaymentIntent: () => ({ transferable: true, charge: { id: "ch_test_123" } }),
  sanitizeStripeError: (err, fallback) => err?.message || fallback,
  caseTransferGroup: (caseId) => `case_${caseId}`,
  stripeIdempotencyKey: (operation, ...parts) => `test_${operation}_${parts.join("_")}`,
  _transfers: [],
};

const caseLifecycleMock = {
  generateArchiveZip: async () => ({ key: "cases/mock/archive.zip", readyAt: new Date() }),
  buildReceiptPdfBuffer: async () => Buffer.from("%PDF-1.4\n%mock"),
  uploadPdfToS3: async ({ key }) => ({ key }),
  getReceiptKey: (caseId, kind) => `cases/${caseId}/receipt-${kind}.pdf`,
};

const stripePath = require.resolve("../utils/stripe");
require.cache[stripePath] = { exports: stripeMock };
const caseLifecyclePath = require.resolve("../services/caseLifecycle");
require.cache[caseLifecyclePath] = { exports: caseLifecycleMock };
const emailPath = require.resolve("../utils/email");
require.cache[emailPath] = { exports: sendEmailMock };

const authRouter = require("../routes/auth");
const casesRouter = require("../routes/cases");
const disputesRouter = require("../routes/disputes");
const paymentsRouter = require("../routes/payments");
const jobsRouter = require("../routes/jobs");
const applicationsRouter = require("../routes/applications");
const attorneyDashboardRouter = require("../routes/attorneyDashboard");
const paralegalDashboardRouter = require("../routes/paralegalDashboard");
const notificationsRouter = require("../routes/notifications");
const messagesRouter = require("../routes/messages");

const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Notification = require("../models/Notification");

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, { timeout = 10_000, interval = 200 } = {}) {
  const start = Date.now();
  while (true) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function buildApp(completedMutations) {
  const app = express();
  const frontendDir = path.join(__dirname, "../../frontend");
  const publicDir = path.join(__dirname, "../../public");

  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    if (req.method === "POST") {
      let failure = null;
      const originalJson = res.json;
      res.json = function (body) {
        if (res.statusCode >= 400) failure = { code: body?.code, error: body?.error || body?.msg };
        return originalJson.call(this, body);
      };
      res.once("finish", () => {
        completedMutations.push({
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          failure,
        });
      });
    }
    next();
  });
  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "test-csrf" }));

  app.use("/api/auth", authRouter);
  app.use("/api/cases", casesRouter);
  app.use("/api/disputes", disputesRouter);
  app.use("/api/payments", paymentsRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/applications", applicationsRouter);
  app.use("/api/attorney/dashboard", attorneyDashboardRouter);
  app.use("/api/paralegal/dashboard", paralegalDashboardRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/messages", messagesRouter);

  const emptyUploads = (_req, res) => res.json({ files: [], documents: [] });
  app.get("/api/uploads/case/:caseId", emptyUploads);
  app.get("/api/uploads/:caseId", emptyUploads);
  app.get("/api/uploads", emptyUploads);
  app.get("/api/uploads/view", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.get("/api/uploads/signed-get", (_req, res) => res.json({ url: "" }));
  app.get("/api/uploads/case/:caseId/:fileId/download", (_req, res) =>
    res.status(404).json({ error: "Not found" })
  );

  app.use(express.static(publicDir));
  app.use(express.static(frontendDir));

  return app;
}

async function startServer() {
  const completedMutations = [];
  const app = buildApp(completedMutations);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve));
  const { port } = server.address();
  return { server, port, completedMutations };
}

async function seedData() {
  const admin = await User.create({
    ...launchReadyAccountFields(),
    firstName: "Admin",
    lastName: "User",
    email: "admin@letsparaconnect.com",
    password: ACCOUNT_PASSWORD,
    role: "admin",
    status: "approved",
  });

  const attorney = await User.create({
    ...launchReadyAccountFields(),
    firstName: "Claire",
    lastName: "Attorney",
    email: "samanthasider+attorney@gmail.com",
    password: ACCOUNT_PASSWORD,
    role: "attorney",
    status: "approved",
    state: "CA",
    stripeCustomerId: "cus_test",
    attorneyPricingAccepted: true,
  });

  const paralegal1 = await User.create({
    ...launchReadyAccountFields(),
    firstName: "Priya",
    lastName: "Ng",
    email: "samanthasider+11@gmail.com",
    password: ACCOUNT_PASSWORD,
    role: "paralegal",
    status: "approved",
    state: "CA",
    stripeAccountId: "acct_para_1",
    stripeOnboarded: true,
    stripePayoutsEnabled: true,
    stripeChargesEnabled: true,
  });

  const paralegal2 = await User.create({
    ...launchReadyAccountFields(),
    firstName: "Sara",
    lastName: "Testing",
    email: "samanthasider+56@gmail.com",
    password: ACCOUNT_PASSWORD,
    role: "paralegal",
    status: "approved",
    state: "CA",
    stripeAccountId: "acct_para_2",
    stripeOnboarded: true,
    stripePayoutsEnabled: true,
    stripeChargesEnabled: true,
  });

  const paralegal3 = await User.create({
    ...launchReadyAccountFields(),
    firstName: "Avery",
    lastName: "Third",
    email: "samanthasider+0@gmail.com",
    password: ACCOUNT_PASSWORD,
    role: "paralegal",
    status: "approved",
    state: "CA",
    stripeAccountId: "acct_para_3",
    stripeOnboarded: true,
    stripePayoutsEnabled: true,
    stripeChargesEnabled: true,
  });

  const baseCase = {
    attorney: attorney._id,
    attorneyId: attorney._id,
    practiceArea: "immigration",
    details: "E2E withdrawal flow case.",
    status: "in progress",
    escrowStatus: "funded",
    lockedTotalAmount: 100000,
    totalAmount: 100000,
    currency: "usd",
  };

  const caseZero = await Case.create({
    ...baseCase,
    title: "Withdrawal zero tasks",
    escrowIntentId: "pi_withdrawal_zero",
    paralegal: paralegal1._id,
    paralegalId: paralegal1._id,
    tasks: [
      { title: "Draft intake", completed: false },
      { title: "Outline case", completed: false },
    ],
  });
  paymentIntentCaseIds.set(caseZero.escrowIntentId, String(caseZero._id));

  const casePartial = await Case.create({
    ...baseCase,
    title: "Withdrawal partial payout",
    escrowIntentId: "pi_withdrawal_partial",
    paralegal: paralegal1._id,
    paralegalId: paralegal1._id,
    tasks: [
      { title: "Collect docs", completed: true },
      { title: "Prepare draft", completed: false },
      { title: "Review filings", completed: false },
    ],
  });
  paymentIntentCaseIds.set(casePartial.escrowIntentId, String(casePartial._id));

  const caseDispute = await Case.create({
    ...baseCase,
    title: "Withdrawal dispute flow",
    escrowIntentId: "pi_withdrawal_dispute",
    paralegal: paralegal1._id,
    paralegalId: paralegal1._id,
    tasks: [
      { title: "Draft memo", completed: true },
      { title: "Summarize exhibits", completed: false },
    ],
  });
  paymentIntentCaseIds.set(caseDispute.escrowIntentId, String(caseDispute._id));

  const caseCycle = await Case.create({
    ...baseCase,
    title: "Withdrawal multi-cycle",
    escrowIntentId: "pi_withdrawal_cycle",
    paralegal: paralegal1._id,
    paralegalId: paralegal1._id,
    tasks: [
      { title: "Initial draft", completed: true },
      { title: "Revise draft", completed: false },
    ],
  });
  paymentIntentCaseIds.set(caseCycle.escrowIntentId, String(caseCycle._id));

  return {
    admin,
    attorney,
    paralegal1,
    paralegal2,
    paralegal3,
    caseZero,
    casePartial,
    caseDispute,
    caseCycle,
  };
}

async function loginUI(page, baseUrl, email, password, expectedPath) {
  await page.goto(`${baseUrl}/login.html`, { waitUntil: "networkidle0" });
  await page.type("#email", email);
  await page.type("#password", password);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/auth/login") && response.request().method() === "POST",
    { timeout: BROWSER_STEP_TIMEOUT_MS }
  );
  await clickVisible(page, "button.login-btn");
  const response = await responsePromise;
  if (!response.ok()) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`Login failed (${response.status()}): ${payload?.error || payload?.msg || "unknown error"}`);
  }
  try {
    await page.waitForFunction(
      (pathFragment) => window.location.pathname.includes(pathFragment),
      { timeout: BROWSER_STEP_TIMEOUT_MS },
      expectedPath
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: window.location.href,
      toast: document.getElementById("toastBanner")?.textContent?.trim() || "",
    }));
    throw new Error(`${error.message}; login state=${JSON.stringify(state)}`);
  }
}

async function browserOperation(label, action) {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  }
}

async function openMatterActions(page, baseUrl, caseId) {
  await browserOperation("open matter", () =>
    page.goto(`${baseUrl}/case-detail.html?caseId=${caseId}`, { waitUntil: "domcontentloaded" })
  );
  await browserOperation("wait for matter actions", () =>
    page.waitForFunction(
      () => Boolean(document.querySelector("#caseDisputeButton:not([hidden])")),
      { timeout: BROWSER_STEP_TIMEOUT_MS }
    )
  );
  let overlay = await page.$(".case-flag-overlay.is-visible");
  if (!overlay) {
    await browserOperation("open work tab", () => clickVisible(page, '[data-matter-tab="work"]'));
    await browserOperation("wait for work panel", () =>
      page.waitForSelector('[data-matter-panel="work"]:not([hidden])', { visible: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    overlay = await page.$(".case-flag-overlay.is-visible");
  }
  if (!overlay) {
    await browserOperation("open matter action menu", () => clickVisible(page, "#caseDisputeButton"));
  }
  await browserOperation("wait for matter action menu", () =>
    page.waitForSelector(".case-flag-overlay.is-visible", { visible: true })
  );
}

async function createPostRequestWaiter(page, pathFragment) {
  const client = await page.createCDPSession();
  await client.send("Network.enable");
  let settled = false;
  let cancelWaiter = null;

  const request = new Promise((resolve, reject) => {
    const observedPostUrls = [];
    const cleanup = () => {
      clearTimeout(timeoutId);
      client.off("Network.requestWillBeSent", onRequest);
      void client.detach().catch(() => {});
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    cancelWaiter = (error) => finish(reject, error);
    const onRequest = ({ requestId, request }) => {
      if (request.method !== "POST") return;
      observedPostUrls.push(request.url);
      if (request.url.includes(pathFragment)) {
        finish(resolve, { requestId, url: request.url });
      }
    };
    const timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          `Timed out waiting for POST response: ${pathFragment}; observed POSTs=${JSON.stringify(observedPostUrls)}`
        )
      );
    }, BROWSER_STEP_TIMEOUT_MS);
    client.on("Network.requestWillBeSent", onRequest);
  });

  return {
    request,
    cancel(error = new Error(`Cancelled POST request wait: ${pathFragment}`)) {
      if (settled || !cancelWaiter) return;
      cancelWaiter(error);
    },
  };
}

async function clickMutationAndRequireSuccess(page, selector, pathFragment, completedMutations) {
  const baseline = completedMutations.length;
  const waiter = await createPostRequestWaiter(page, pathFragment);
  try {
    await clickVisible(page, selector);
  } catch (error) {
    waiter.cancel(error);
    await waiter.request.catch(() => {});
    throw error;
  }
  await waiter.request;
  const response = await waitFor(
    async () => completedMutations.slice(baseline).find(
      (entry) => entry.method === "POST" && entry.path.includes(pathFragment)
    ) || null,
    { timeout: BROWSER_STEP_TIMEOUT_MS, interval: 25 }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${pathFragment} failed (${response.status}): ${JSON.stringify(response.failure)}`);
  }
}

async function withdrawCaseViaUI(page, baseUrl, caseId, completedMutations) {
  await openMatterActions(page, baseUrl, caseId);
  await browserOperation("choose withdrawal", () => clickVisible(page, '[data-flag-action="withdraw"]'));
  await browserOperation("wait for withdrawal confirmation", () =>
    page.waitForSelector(".case-withdraw-overlay.is-visible", { visible: true })
  );
  await browserOperation("submit withdrawal", () =>
    clickMutationAndRequireSuccess(
      page,
      "[data-withdraw-confirm]",
      `/api/cases/${caseId}/withdraw`,
      completedMutations
    )
  );
  await browserOperation("wait for withdrawal redirect", () =>
    waitFor(
      async () => {
        if (!page.url().includes("dashboard-paralegal.html")) return false;
        return page.evaluate(() => document.readyState === "complete").catch(() => false);
      },
      { timeout: BROWSER_STEP_TIMEOUT_MS, interval: 100 }
    )
  );
}

async function finalizePartialPayoutViaUI(page, baseUrl, caseId, amount, completedMutations) {
  await openMatterActions(page, baseUrl, caseId);
  await clickVisible(page, '[data-flag-action="partial"]');
  await page.waitForSelector(".case-payout-overlay.is-visible", { visible: true });
  await page.type("[data-payout-input]", amount);
  await clickMutationAndRequireSuccess(
    page,
    "[data-payout-confirm]",
    `/api/cases/${caseId}/partial-payout`,
    completedMutations
  );
  await page.waitForSelector("[data-payout-close]", { visible: true });
  await clickVisible(page, "[data-payout-close]");
}

async function rejectPayoutViaUI(page, baseUrl, caseId, completedMutations) {
  await openMatterActions(page, baseUrl, caseId);
  await clickVisible(page, '[data-flag-action="reject"]');
  await page.waitForSelector(".case-reject-overlay.is-visible", { visible: true });
  await clickMutationAndRequireSuccess(
    page,
    "[data-reject-confirm]",
    `/api/cases/${caseId}/reject-payout`,
    completedMutations
  );
}

async function runBrowserStep(label, page, action) {
  try {
    return await action();
  } catch (error) {
    const state = await page
      .evaluate(() => ({
        url: window.location.href,
        readyState: document.readyState,
        toast: document.getElementById("toastBanner")?.textContent?.trim() || "",
        visibleOverlay: Array.from(
          document.querySelectorAll(
            ".case-flag-overlay.is-visible, .case-withdraw-overlay.is-visible, .case-payout-overlay.is-visible, .case-reject-overlay.is-visible"
          )
        ).map((element) => element.className),
      }))
      .catch(() => ({ unavailable: true }));
    throw new Error(`${label}: ${error.message}; browser state=${JSON.stringify(state)}`, {
      cause: error,
    });
  }
}

async function assertCaseNotification(userId, type, caseId) {
  const found = await Notification.findOne({
    userId,
    type,
    "payload.caseId": String(caseId),
  }).lean();
  expect(found, `Expected notification ${type} for user ${userId} on case ${caseId}`);
}


async function run() {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" } });
  await connectE2eDatabase(mongoose, mongo.getUri());
  const { server, port, completedMutations } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser;

  try {
    const seed = await seedData();

    const headless = process.env.HEADLESS === "false" ? false : "new";
    browser = await launchPuppeteer({
      headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      protocolTimeout: 120_000,
    });

    const defaultContext = browser.defaultBrowserContext();
    const createContext = async () => {
      if (typeof browser.createIncognitoBrowserContext === "function") {
        return browser.createIncognitoBrowserContext();
      }
      if (typeof browser.createBrowserContext === "function") {
        return browser.createBrowserContext();
      }
      return defaultContext;
    };

    const paraContext = await createContext();
    const attorneyContext = await createContext();
    const pagePara = await paraContext.newPage();
    const pageAttorney = await attorneyContext.newPage();
    pagePara.setDefaultTimeout(60_000);
    pageAttorney.setDefaultTimeout(60_000);

    await runBrowserStep("paralegal login", pagePara, () =>
      loginUI(pagePara, baseUrl, seed.paralegal1.email, ACCOUNT_PASSWORD, "dashboard-paralegal.html")
    );
    await runBrowserStep("attorney login", pageAttorney, () =>
      loginUI(pageAttorney, baseUrl, seed.attorney.email, ACCOUNT_PASSWORD, "dashboard-attorney.html")
    );

    // Scenario 1: Withdrawal with 0 tasks completed -> auto $0 payout + auto relist
    await runBrowserStep("zero-task withdrawal", pagePara, () =>
      withdrawCaseViaUI(pagePara, baseUrl, seed.caseZero._id, completedMutations)
    );
    const caseZero = await waitFor(async () => {
      const doc = await Case.findById(seed.caseZero._id).lean();
      return doc?.payoutFinalizedType === "zero_auto" ? doc : null;
    });
    expect(caseZero.status === "paused", "Case should be paused after withdrawal");
    expect(caseZero.partialPayoutAmount === 0, "Case should record a $0 payout");
    const jobZero = await Job.findOne({ caseId: seed.caseZero._id }).lean();
    expect(jobZero && jobZero.status === "open", "Case should relist to open job after $0 payout");
    await assertCaseNotification(seed.attorney._id, "case_update", seed.caseZero._id);
    await assertCaseNotification(seed.paralegal1._id, "case_update", seed.caseZero._id);

    // Scenario 2: Withdrawal with completed work -> attorney partial payout and remaining-balance accounting.
    await pageAttorney.goto(`${baseUrl}/case-detail.html?caseId=${seed.casePartial._id}`, {
      waitUntil: "domcontentloaded",
    });
    await runBrowserStep("partial-work withdrawal", pagePara, () =>
      withdrawCaseViaUI(pagePara, baseUrl, seed.casePartial._id, completedMutations)
    );
    await runBrowserStep("attorney partial payout", pageAttorney, () =>
      finalizePartialPayoutViaUI(
        pageAttorney,
        baseUrl,
        seed.casePartial._id,
        "400.00",
        completedMutations
      )
    );

    const casePartial = await waitFor(async () => {
      const doc = await Case.findById(seed.casePartial._id).lean();
      return doc?.payoutFinalizedType === "partial_attorney" ? doc : null;
    });
    expect(casePartial.partialPayoutAmount === 40000, "Partial payout amount should be recorded (400.00)");
    expect(casePartial.remainingAmount === 60000, "Remaining amount should be updated after partial payout");

    // Scenario 3: Close without release -> 24-hour dispute window starts
    await pageAttorney.goto(`${baseUrl}/case-detail.html?caseId=${seed.caseDispute._id}`, {
      waitUntil: "domcontentloaded",
    });
    await runBrowserStep("dispute-path withdrawal", pagePara, () =>
      withdrawCaseViaUI(pagePara, baseUrl, seed.caseDispute._id, completedMutations)
    );
    await runBrowserStep("attorney payout rejection", pageAttorney, () =>
      rejectPayoutViaUI(pageAttorney, baseUrl, seed.caseDispute._id, completedMutations)
    );

    const caseDispute = await waitFor(async () => {
      const doc = await Case.findById(seed.caseDispute._id).lean();
      return doc?.disputeDeadlineAt ? doc : null;
    });
    expect(caseDispute.payoutFinalizedAt == null, "Close without release should not finalize payout");

    console.log("E2E withdrawal flow complete.");
  } finally {
    if (browser) await browser.close();
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.connection.close();
    await new Promise((resolve) => server.close(resolve));
    await mongo.stop();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
