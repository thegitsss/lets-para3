const path = require("path");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const puppeteer = require("puppeteer");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.DISABLE_WITHDRAWAL_WORKER = "true";
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.S3_REGION = process.env.S3_REGION || "us-east-1";

const emailLog = [];
const sendEmailMock = async (to, subject, html, opts = {}) => {
  emailLog.push({ to, subject, html, opts });
  return { mocked: true };
};
sendEmailMock.log = emailLog;

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
      stripeMock._transfers.push(payload);
      return { id: `tr_${Date.now()}` };
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

function patchElementHandleClick() {
  const { ElementHandle } = puppeteer;
  if (!ElementHandle || ElementHandle.prototype.__safeClickPatched) return;
  const original = ElementHandle.prototype.click;
  ElementHandle.prototype.click = async function (...args) {
    try {
      return await this.evaluate((el) => el.click());
    } catch {
      return original.apply(this, args);
    }
  };
  ElementHandle.prototype.__safeClickPatched = true;
}
patchElementHandleClick();

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

async function apiFetch(baseUrl, path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const msg = data?.error || data?.message || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function buildApp() {
  const app = express();
  const frontendDir = path.join(__dirname, "../../frontend");
  const publicDir = path.join(__dirname, "../../public");

  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
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
  const app = buildApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, port };
}

async function seedData() {
  const admin = await User.create({
    firstName: "Admin",
    lastName: "User",
    email: "admin@letsparaconnect.com",
    password: "Password123!",
    role: "admin",
    status: "approved",
  });

  const attorney = await User.create({
    firstName: "Claire",
    lastName: "Attorney",
    email: "samanthasider+attorney@gmail.com",
    password: "Password123!",
    role: "attorney",
    status: "approved",
    state: "CA",
    stripeCustomerId: "cus_test",
  });

  const paralegal1 = await User.create({
    firstName: "Priya",
    lastName: "Ng",
    email: "samanthasider+11@gmail.com",
    password: "Password123!",
    role: "paralegal",
    status: "approved",
    state: "CA",
    stripeAccountId: "acct_para_1",
    stripeOnboarded: true,
    stripePayoutsEnabled: true,
    stripeChargesEnabled: true,
  });

  const paralegal2 = await User.create({
    firstName: "Sara",
    lastName: "Testing",
    email: "samanthasider+56@gmail.com",
    password: "Password123!",
    role: "paralegal",
    status: "approved",
    state: "CA",
    stripeAccountId: "acct_para_2",
    stripeOnboarded: true,
    stripePayoutsEnabled: true,
    stripeChargesEnabled: true,
  });

  const paralegal3 = await User.create({
    firstName: "Avery",
    lastName: "Third",
    email: "samanthasider+0@gmail.com",
    password: "Password123!",
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
    escrowIntentId: "pi_test_123",
    lockedTotalAmount: 100000,
    totalAmount: 100000,
    currency: "usd",
  };

  const caseZero = await Case.create({
    ...baseCase,
    title: "Withdrawal zero tasks",
    paralegal: paralegal1._id,
    paralegalId: paralegal1._id,
    tasks: [
      { title: "Draft intake", completed: false },
      { title: "Outline case", completed: false },
    ],
  });

  const casePartial = await Case.create({
    ...baseCase,
    title: "Withdrawal partial payout",
    paralegal: paralegal1._id,
    paralegalId: paralegal1._id,
    tasks: [
      { title: "Collect docs", completed: true },
      { title: "Prepare draft", completed: false },
      { title: "Review filings", completed: false },
    ],
  });

  const caseDispute = await Case.create({
    ...baseCase,
    title: "Withdrawal dispute flow",
    paralegal: paralegal1._id,
    paralegalId: paralegal1._id,
    tasks: [
      { title: "Draft memo", completed: true },
      { title: "Summarize exhibits", completed: false },
    ],
  });

  const caseCycle = await Case.create({
    ...baseCase,
    title: "Withdrawal multi-cycle",
    paralegal: paralegal1._id,
    paralegalId: paralegal1._id,
    tasks: [
      { title: "Initial draft", completed: true },
      { title: "Revise draft", completed: false },
    ],
  });

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
  await Promise.all([
    page.waitForURL((url) => url.pathname.includes(expectedPath), { timeout: 20_000 }),
    page.click("button.login-btn"),
  ]);
}

async function withdrawCaseViaUI(page, baseUrl, caseId) {
  await page.goto(`${baseUrl}/case-detail.html?caseId=${caseId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#caseDisputeButton", { visible: true });
  await page.click("#caseDisputeButton");
  await page.waitForSelector(".case-flag-overlay.is-visible");
  await page.click('[data-flag-action="withdraw"]');
  await page.waitForSelector(".case-withdraw-overlay.is-visible");
  await page.click("[data-withdraw-confirm]");
  await page.waitForURL((url) => url.pathname.includes("dashboard-paralegal.html"), { timeout: 20_000 });
}

async function getOpenJobForCase(baseUrl, caseId, cookie) {
  return waitFor(async () => {
    try {
      const jobs = await apiFetch(baseUrl, "/api/jobs/open", { cookie });
      const match = jobs.find((job) => String(job.caseId) === String(caseId));
      return match || null;
    } catch {
      return null;
    }
  }, { timeout: 20_000 });
}

async function applyAndHire({ baseUrl, caseId, paralegal, attorney, coverLetter }) {
  const paraCookie = authCookieFor(paralegal);
  const attorneyCookie = authCookieFor(attorney);
  const job = await getOpenJobForCase(baseUrl, caseId, paraCookie);
  await apiFetch(baseUrl, "/api/applications", {
    method: "POST",
    cookie: paraCookie,
    body: {
      jobId: job._id || job.jobId,
      coverLetter: coverLetter || "Applying for this role. I can start immediately.",
    },
  });
  await apiFetch(baseUrl, `/api/cases/${caseId}/hire/${paralegal._id}`, {
    method: "POST",
    cookie: attorneyCookie,
  });
}

async function assertCaseNotification(userId, type, caseId) {
  const found = await Notification.findOne({
    userId,
    type,
    "payload.caseId": caseId,
  }).lean();
  expect(found, `Expected notification ${type} for user ${userId} on case ${caseId}`);
}

async function completeCaseAsAttorney(baseUrl, caseId, attorney) {
  const doc = await Case.findById(caseId);
  const completedTasks = (doc.tasks || []).map((task) => ({
    ...task,
    completed: true,
  }));
  await Case.findByIdAndUpdate(caseId, { tasks: completedTasks });
  await apiFetch(baseUrl, `/api/cases/${caseId}/complete`, {
    method: "POST",
    cookie: authCookieFor(attorney),
  });
}

async function run() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "e2e" });
  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;
  let browser;

  try {
    const seed = await seedData();
    const attorneyCookie = authCookieFor(seed.attorney);
    const paralegalCookie = authCookieFor(seed.paralegal1);

    const headless = process.env.HEADLESS === "false" ? false : "new";
    browser = await puppeteer.launch({
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

    await loginUI(pagePara, baseUrl, seed.paralegal1.email, "Password123!", "dashboard-paralegal.html");
    await loginUI(pageAttorney, baseUrl, seed.attorney.email, "Password123!", "dashboard-attorney.html");

    // Scenario 1: Withdrawal with 0 tasks completed -> auto $0 payout + auto relist
    await withdrawCaseViaUI(pagePara, baseUrl, seed.caseZero._id);
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

    // Scenario 2: Withdrawal with 1+ tasks -> attorney partial payout -> relist -> hire -> complete
    await pageAttorney.goto(`${baseUrl}/case-detail.html?caseId=${seed.casePartial._id}`, {
      waitUntil: "domcontentloaded",
    });
    await pageAttorney.waitForSelector("#caseDisputeButton", { visible: true });
    await withdrawCaseViaUI(pagePara, baseUrl, seed.casePartial._id);

    await pageAttorney.waitForSelector(".tour-modal.is-active", { timeout: 20_000 });
    await pageAttorney.click("[data-withdrawal-next]");
    await pageAttorney.click('.decision-card[data-decision="partial"]');
    await pageAttorney.click("[data-payout-input]");
    await pageAttorney.type("[data-payout-input]", "400");
    await pageAttorney.waitForFunction(() => {
      const btn = document.querySelector("[data-withdrawal-submit]");
      return btn && !btn.disabled;
    });
    await pageAttorney.click("[data-withdrawal-submit]");
    await pageAttorney.waitForFunction(() => !document.querySelector(".tour-modal.is-active"));

    const casePartial = await waitFor(async () => {
      const doc = await Case.findById(seed.casePartial._id).lean();
      return doc?.payoutFinalizedType === "partial_attorney" ? doc : null;
    });
    expect(casePartial.partialPayoutAmount === 40000, "Partial payout amount should be recorded (400.00)");
    expect(casePartial.remainingAmount === 60000, "Remaining amount should be updated after partial payout");

    await applyAndHire({
      baseUrl,
      caseId: seed.casePartial._id,
      paralegal: seed.paralegal2,
      attorney: seed.attorney,
      coverLetter: "Applying for this role. I can start immediately and deliver quickly.",
    });

    await completeCaseAsAttorney(baseUrl, seed.casePartial._id, seed.attorney);
    const completedCase = await waitFor(async () => {
      const doc = await Case.findById(seed.casePartial._id).lean();
      return doc?.paymentReleased ? doc : null;
    });
    expect(completedCase.status === "completed", "Case should be completed after release funds");
    expect(emailLog.some((msg) => msg.to === seed.attorney.email), "Attorney should receive an email");
    expect(emailLog.some((msg) => msg.to === seed.paralegal2.email), "Paralegal should receive an email");

    // Scenario 3: Close without release -> dispute -> admin settlement -> relist
    await pageAttorney.goto(`${baseUrl}/case-detail.html?caseId=${seed.caseDispute._id}`, {
      waitUntil: "domcontentloaded",
    });
    await pageAttorney.waitForSelector("#caseDisputeButton", { visible: true });
    await withdrawCaseViaUI(pagePara, baseUrl, seed.caseDispute._id);

    await pageAttorney.waitForSelector(".tour-modal.is-active", { timeout: 20_000 });
    await pageAttorney.click("[data-withdrawal-next]");
    await pageAttorney.click('.decision-card[data-decision="deny"]');
    await pageAttorney.waitForFunction(() => {
      const btn = document.querySelector("[data-withdrawal-submit]");
      return btn && !btn.disabled;
    });
    await pageAttorney.click("[data-withdrawal-submit]");
    await pageAttorney.waitForFunction(() => !document.querySelector(".tour-modal.is-active"));

    const caseDispute = await waitFor(async () => {
      const doc = await Case.findById(seed.caseDispute._id).lean();
      return doc?.disputeDeadlineAt ? doc : null;
    });
    expect(caseDispute.payoutFinalizedAt == null, "Close without release should not finalize payout");

    await apiFetch(baseUrl, `/api/disputes/${seed.caseDispute._id}`, {
      method: "POST",
      cookie: paralegalCookie,
      body: { message: "Disputing the withdrawal payout decision." },
    });

    const disputedCase = await waitFor(async () => {
      const doc = await Case.findById(seed.caseDispute._id).lean();
      return doc?.status === "disputed" ? doc : null;
    });
    expect(disputedCase.pausedReason === "dispute", "Case should enter dispute status");
    await assertCaseNotification(seed.admin._id, "dispute_opened", seed.caseDispute._id);

    await apiFetch(baseUrl, `/api/payments/dispute/settle/${seed.caseDispute._id}`, {
      method: "POST",
      cookie: authCookieFor(seed.admin),
      body: { action: "refund" },
    });

    const settledCase = await waitFor(async () => {
      const doc = await Case.findById(seed.caseDispute._id).lean();
      return doc?.payoutFinalizedType === "admin" ? doc : null;
    });
    expect(settledCase.tasks.every((task) => !task.completed), "Tasks should reset after admin $0 settlement");
    await assertCaseNotification(seed.paralegal1._id, "dispute_resolved", seed.caseDispute._id);
    await assertCaseNotification(seed.attorney._id, "dispute_resolved", seed.caseDispute._id);

    await apiFetch(baseUrl, `/api/cases/${seed.caseDispute._id}/relist`, {
      method: "POST",
      cookie: attorneyCookie,
    });

    await applyAndHire({
      baseUrl,
      caseId: seed.caseDispute._id,
      paralegal: seed.paralegal2,
      attorney: seed.attorney,
      coverLetter: "Available for the relisted case.",
    });

    // Scenario 4: second withdrawal cycle -> third hire -> completion
    await apiFetch(baseUrl, `/api/cases/${seed.caseCycle._id}/withdraw`, {
      method: "POST",
      cookie: paralegalCookie,
    });
    await apiFetch(baseUrl, `/api/cases/${seed.caseCycle._id}/partial-payout`, {
      method: "POST",
      cookie: attorneyCookie,
      body: { amountCents: 30000 },
    });

    await applyAndHire({
      baseUrl,
      caseId: seed.caseCycle._id,
      paralegal: seed.paralegal2,
      attorney: seed.attorney,
      coverLetter: "Taking over the cycle case.",
    });

    await apiFetch(baseUrl, `/api/cases/${seed.caseCycle._id}/withdraw`, {
      method: "POST",
      cookie: authCookieFor(seed.paralegal2),
    });
    await apiFetch(baseUrl, `/api/cases/${seed.caseCycle._id}/partial-payout`, {
      method: "POST",
      cookie: attorneyCookie,
      body: { amountCents: 20000 },
    });

    await applyAndHire({
      baseUrl,
      caseId: seed.caseCycle._id,
      paralegal: seed.paralegal3,
      attorney: seed.attorney,
      coverLetter: "Final handoff, ready to complete.",
    });
    await completeCaseAsAttorney(baseUrl, seed.caseCycle._id, seed.attorney);

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
