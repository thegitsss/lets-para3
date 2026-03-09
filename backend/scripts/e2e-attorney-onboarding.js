const path = require("path");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const puppeteer = require("puppeteer");

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createState() {
  return {
    user: {
      id: "attorney-1",
      _id: "attorney-1",
      role: "attorney",
      status: "approved",
      firstName: "Ava",
      lastName: "Stone",
      email: "attorney@example.com",
      lawFirm: "",
      practiceAreas: [],
      practiceDescription: "",
      onboarding: { attorneyTourCompleted: false },
      isFirstLogin: true,
      preferences: { theme: "light", fontSize: "md" },
    },
    paymentMethod: null,
    cases: [],
    archivedCases: [],
    notesByWeek: new Map(),
  };
}

function buildCase(id) {
  return {
    id,
    _id: id,
    title: "Immigration Intake Package",
    practiceArea: "immigration",
    description: "Prepare intake packet and supporting declarations.",
    details: "Prepare intake packet and supporting declarations.",
    status: "in progress",
    state: "CA",
    attorney: "attorney-1",
    attorneyId: "attorney-1",
    paralegal: "paralegal-1",
    paralegalId: "paralegal-1",
    escrowStatus: "funded",
    totalAmount: 40000,
    lockedTotalAmount: 40000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [
      { _id: "task-1", title: "Draft intake packet", completed: false },
    ],
  };
}

async function startStubServer() {
  const app = express();
  const state = createState();
  const frontendDir = path.join(__dirname, "../../frontend");
  const publicDir = path.join(__dirname, "../../public");

  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(publicDir));
  app.use(express.static(frontendDir));
  app.get("/favicon.ico", (_req, res) => res.status(204).end());

  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "test-csrf" }));

  app.get("/api/auth/me", (_req, res) => {
    return res.json({ user: state.user });
  });

  app.post("/api/auth/logout", (_req, res) => {
    return res.json({ success: true });
  });

  app.get("/api/users/me", (_req, res) => {
    return res.json(state.user);
  });

  app.patch("/api/users/me", (req, res) => {
    const updates = req.body || {};
    state.user = { ...state.user, ...updates };
    return res.json(state.user);
  });

  app.get("/api/users/me/onboarding", (_req, res) => {
    return res.json({ onboarding: state.user.onboarding || {} });
  });

  app.patch("/api/users/me/onboarding", (req, res) => {
    state.user.onboarding = {
      ...(state.user.onboarding || {}),
      ...(req.body || {}),
    };
    return res.json({ onboarding: state.user.onboarding });
  });

  app.get("/api/users/me/weekly-notes", (req, res) => {
    const weekStart = String(req.query?.weekStart || "").slice(0, 10);
    const key = `${state.user.id}:${weekStart}`;
    const notes = state.notesByWeek.get(key) || Array(7).fill("");
    return res.json({ weekStart, notes, updatedAt: new Date().toISOString() });
  });

  app.put("/api/users/me/weekly-notes", (req, res) => {
    const weekStart = String(req.body?.weekStart || "").slice(0, 10);
    const notes = Array.isArray(req.body?.notes)
      ? req.body.notes.slice(0, 7)
      : Array(7).fill("");
    const key = `${state.user.id}:${weekStart}`;
    state.notesByWeek.set(key, notes);
    return res.json({ weekStart, notes, updatedAt: new Date().toISOString() });
  });

  app.get("/api/messages/unread-count", (_req, res) => res.json({ count: 0 }));
  app.get("/api/messages/summary", (_req, res) => res.json({ items: [] }));
  app.get("/api/messages/:caseId", (_req, res) => res.json({ messages: [] }));
  app.post("/api/messages/:caseId/read", (_req, res) =>
    res.json({ updatedLegacy: 0, updatedReceipts: 0 })
  );

  app.get("/api/notifications", (_req, res) => res.json([]));
  app.post("/api/notifications/:id/read", (_req, res) => res.json({ ok: true }));
  app.get("/api/notifications/unread-count", (_req, res) =>
    res.json({ unread: 0, count: 0 })
  );
  const openSse = (res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("event: ready\ndata: {}\n\n");
    const heartbeat = setInterval(() => {
      try {
        res.write("event: ping\ndata: {}\n\n");
      } catch {
        /* noop */
      }
    }, 20000);
    res.on("close", () => clearInterval(heartbeat));
  };
  app.get("/api/notifications/stream", (_req, res) => openSse(res));

  app.get("/api/cases/my", (req, res) => {
    const archived = String(req.query?.archived || "false") === "true";
    return res.json(archived ? state.archivedCases : state.cases);
  });

  app.get("/api/cases/posted", (_req, res) => {
    return res.json(state.cases);
  });

  app.get("/api/cases/:caseId", (req, res) => {
    const caseId = String(req.params.caseId || "");
    const found = [...state.cases, ...state.archivedCases].find(
      (item) => String(item.id || item._id) === caseId
    );
    return res.json(found || buildCase(caseId || "case-1"));
  });
  app.get("/api/cases/:caseId/stream", (_req, res) => openSse(res));

  app.get("/api/cases/:caseId/status-history", (_req, res) => {
    return res.json({ history: [] });
  });

  app.get("/api/cases/:caseId/applicants", (_req, res) => {
    return res.json({ applicants: [] });
  });

  app.get("/api/payments/payment-method/default", (_req, res) => {
    return res.json({ paymentMethod: state.paymentMethod });
  });

  app.post("/api/payments/payment-method/default", (req, res) => {
    const paymentMethodId = String(req.body?.paymentMethodId || "pm_test_123");
    state.paymentMethod = {
      id: paymentMethodId,
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
    };
    return res.json({ ok: true, paymentMethod: state.paymentMethod });
  });

  app.post("/api/payments/payment-method/setup-intent", (_req, res) => {
    return res.json({ clientSecret: "seti_test_123" });
  });

  app.get("/api/payments/escrow/active", (_req, res) => res.json({ items: [] }));
  app.get("/api/payments/escrow/pending", (_req, res) => res.json({ items: [] }));
  app.get("/api/payments/summary", (_req, res) => res.json({}));
  app.get("/api/payments/history", (_req, res) => res.json({ items: [] }));
  app.post("/api/payments/portal", (_req, res) => {
    return res.json({ url: "/dashboard-attorney.html#billing" });
  });

  app.get("/api/uploads/case/:caseId", (_req, res) =>
    res.json({ files: [], documents: [] })
  );
  app.get("/api/uploads/:caseId", (_req, res) =>
    res.json({ files: [], documents: [] })
  );

  app.post("/__test/set-state", (req, res) => {
    const body = req.body || {};
    if (body.user && typeof body.user === "object") {
      state.user = { ...state.user, ...body.user };
    }
    if (Object.prototype.hasOwnProperty.call(body, "paymentMethod")) {
      state.paymentMethod = body.paymentMethod;
    }
    if (Array.isArray(body.cases)) {
      state.cases = body.cases;
    }
    if (Array.isArray(body.archivedCases)) {
      state.archivedCases = body.archivedCases;
    }
    return res.json({ ok: true });
  });

  app.use("/api", (_req, res) => res.json({}));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, port, state };
}

async function setTestState(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/__test/set-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) throw new Error("Unable to update test state");
}

async function waitForCardStep(page, step) {
  await page.waitForFunction(
    (expected) => {
      const card = document.getElementById("attorneyOnboardingAttentionCard");
      if (!card) return false;
      const hidden = card.hidden || card.getAttribute("aria-hidden") === "true";
      if (hidden) return false;
      return String(card.dataset.step || "") === expected;
    },
    { timeout: 15_000 },
    step
  );
}

async function runTour(page, baseUrl) {
  await page.goto(`${baseUrl}/dashboard-attorney.html#home`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#attorneyTourModal.is-active", { timeout: 15_000 });
  await page.click("#attorneyTourStartBtn");
  await page.waitForSelector("#attorneyTourTooltip.is-active", { timeout: 10_000 });

  for (let i = 0; i < 8; i += 1) {
    const label = await page.$eval("#attorneyTourNextBtn", (el) =>
      (el.textContent || "").trim()
    );
    await page.click("#attorneyTourNextBtn");
    if (label.toLowerCase().includes("let's get started")) break;
    await wait(350);
  }

  await page.waitForFunction(() => {
    const tooltip = document.getElementById("attorneyTourTooltip");
    return tooltip && !tooltip.classList.contains("is-active");
  }, { timeout: 10_000 });
}

async function validateOnboardingFlow(page, baseUrl) {
  await runTour(page, baseUrl);

  await waitForCardStep(page, "profile");

  const staysVisible = await page.evaluate(async () => {
    const card = document.getElementById("attorneyOnboardingAttentionCard");
    if (!card) return false;
    const initial = !card.hidden && card.getAttribute("aria-hidden") !== "true";
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const later = !card.hidden && card.getAttribute("aria-hidden") !== "true";
    return initial && later;
  });
  if (!staysVisible) {
    throw new Error("Onboarding attention card became hidden while steps were incomplete.");
  }

  await page.goto(
    `${baseUrl}/profile-settings.html?onboardingStep=profile&profilePrompt=1`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForFunction(
    () =>
      document.getElementById("attorneyOnboardingModal")?.classList.contains("is-active") &&
      String(document.getElementById("attorneyOnboardingText")?.textContent || "")
        .toLowerCase()
        .includes("step 1 of 3"),
    { timeout: 15_000 }
  );

  await setTestState(baseUrl, {
    user: {
      practiceAreas: ["Immigration"],
      practiceDescription:
        "We handle high-volume immigration filings with clear process controls and proactive client communication.",
      isFirstLogin: false,
    },
  });

  await page.goto(`${baseUrl}/dashboard-attorney.html#home`, { waitUntil: "domcontentloaded" });
  await waitForCardStep(page, "payment");

  await page.goto(`${baseUrl}/profile-settings.html?onboardingStep=payment`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () =>
      document.getElementById("attorneyOnboardingModal")?.classList.contains("is-active") &&
      String(document.getElementById("attorneyOnboardingText")?.textContent || "")
        .toLowerCase()
        .includes("step 2 of 3"),
    { timeout: 15_000 }
  );

  await setTestState(baseUrl, {
    paymentMethod: {
      id: "pm_123",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
    },
  });

  await page.goto(`${baseUrl}/dashboard-attorney.html#home`, { waitUntil: "domcontentloaded" });
  await waitForCardStep(page, "case");

  await page.evaluate(() => {
    sessionStorage.setItem("lpc_attorney_onboarding_step", "case");
  });
  await page.goto(`${baseUrl}/dashboard-attorney.html#cases`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.getElementById("attorneyCaseOnboardingModal")?.classList.contains("is-active") &&
      String(document.getElementById("attorneyCaseOnboardingText")?.textContent || "")
        .toLowerCase()
        .includes("step 3 of 3"),
    { timeout: 10_000 }
  );

  await setTestState(baseUrl, {
    cases: [buildCase("case-1")],
  });
}

async function validateCaseDetailResponsiveLayout(page, baseUrl) {
  await page.setJavaScriptEnabled(false);
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto(`${baseUrl}/case-detail.html?caseId=case-1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".case-workspace", { timeout: 10_000 });

  const medium = await page.evaluate(() => {
    const countTracks = (raw = "") => {
      let depth = 0;
      let token = "";
      let count = 0;
      for (const ch of String(raw)) {
        if (ch === "(") depth += 1;
        if (ch === ")") depth = Math.max(0, depth - 1);
        if (ch === " " && depth === 0) {
          if (token.trim()) {
            count += 1;
            token = "";
          }
          continue;
        }
        token += ch;
      }
      if (token.trim()) count += 1;
      return count;
    };
    const workspace = document.querySelector(".case-workspace");
    const thread = document.querySelector(".case-thread");
    if (!workspace || !thread) return null;
    const rawCols = getComputedStyle(workspace).gridTemplateColumns;
    const cols = countTracks(rawCols);
    const threadRowSpan = getComputedStyle(thread).gridRow;
    return { cols, rawCols, threadRowSpan };
  });

  if (!medium || medium.cols < 2) {
    throw new Error(
      `Expected 2-panel case workspace layout at ~1000px width (got cols=${medium?.cols}, raw='${medium?.rawCols}').`
    );
  }

  await page.setViewport({ width: 850, height: 900 });
  await page.goto(`${baseUrl}/case-detail.html?caseId=case-1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".case-workspace", { timeout: 10_000 });

  const small = await page.evaluate(() => {
    const workspace = document.querySelector(".case-workspace");
    const thread = document.querySelector(".case-thread");
    if (!workspace || !thread) return null;
    const threadHeight = parseFloat(getComputedStyle(thread).height || "0");
    const hasHorizontalOverflow =
      document.documentElement.scrollWidth > window.innerWidth + 1;
    return { threadHeight, hasHorizontalOverflow };
  });

  if (!small) {
    throw new Error(
      "Expected case workspace to render on mobile-sized viewport."
    );
  }

  if (!(small.threadHeight > 0)) {
    throw new Error("Expected case thread panel height to be rendered on small screens.");
  }

  if (small.hasHorizontalOverflow) {
    throw new Error("Expected no horizontal overflow on mobile-sized case workspace.");
  }
  await page.setJavaScriptEnabled(true);
}

async function run() {
  const { server, port } = await startStubServer();
  const baseUrl = `http://localhost:${port}`;

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 120_000,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);
  page.on("pageerror", (err) => {
    console.error("[pageerror]", err?.message || err);
  });
  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      console.error(`[console:${type}]`, msg.text());
    }
  });

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      const parsed = new URL(url);
      if (parsed.origin !== baseUrl && !parsed.pathname.startsWith("/api/")) {
        const type = request.resourceType();
        if (type === "script") {
          return request.respond({
            status: 200,
            contentType: "application/javascript",
            body: "window.Stripe=window.Stripe||function(){return {elements:function(){return {};},confirmPayment:async function(){return {};},confirmSetup:async function(){return {}}};};",
          });
        }
        if (type === "stylesheet") {
          return request.respond({
            status: 200,
            contentType: "text/css",
            body: "",
          });
        }
        if (type === "image") {
          return request.respond({
            status: 200,
            contentType: "image/svg+xml",
            body: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"></svg>",
          });
        }
        if (type === "font") {
          return request.respond({
            status: 200,
            contentType: "font/woff2",
            body: "",
          });
        }
        return request.respond({ status: 204, body: "" });
      }
    }
    return request.continue();
  });

  try {
    await page.evaluateOnNewDocument((user) => {
      localStorage.setItem("lpc_user", JSON.stringify(user));
      sessionStorage.removeItem("lpc_attorney_tour_completed");
      sessionStorage.removeItem("lpc_attorney_tour_active");
      sessionStorage.removeItem("lpc_attorney_tour_step");
      sessionStorage.removeItem("lpc_attorney_onboarding_step");
    }, {
      id: "attorney-1",
      _id: "attorney-1",
      firstName: "Ava",
      lastName: "Stone",
      role: "attorney",
      status: "approved",
      isFirstLogin: true,
      preferences: { theme: "light", fontSize: "md" },
    });

    await page.setViewport({ width: 1365, height: 900 });

    await validateOnboardingFlow(page, baseUrl);
    await validateCaseDetailResponsiveLayout(page, baseUrl);

    console.log("Attorney onboarding flow, step-card stability, and case-detail responsive layout verified.");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
