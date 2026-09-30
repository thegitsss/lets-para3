const path = require("path");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const { launchPuppeteer } = require("./puppeteerBrowser");
const { installWorkspaceReads } = require("./e2e-workspace-fixture");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createState() {
  return {
    user: {
      id: "507f1f77bcf86cd799439011",
      _id: "507f1f77bcf86cd799439011",
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
    attorney: "507f1f77bcf86cd799439011",
    attorneyId: "507f1f77bcf86cd799439011",
    paralegal: "507f191e810c19729de860ea",
    paralegalId: "507f191e810c19729de860ea",
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
  installWorkspaceReads(app, () => state.user, () => state.cases);
  app.get("/assets/vendor/simplewebauthn-13.3.0.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(
      __dirname,
      "../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js"
    ));
  });
  app.get("/assets/vendor/web-vitals-6.1.1.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(__dirname, "../node_modules/web-vitals/dist/web-vitals.js"));
  });
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
    return res.json(found || buildCase(caseId || "507f1f77bcf86cd799439022"));
  });
  app.get("/api/cases/:caseId/stream", (_req, res) => openSse(res));

  app.get("/api/cases/:caseId/status-history", (_req, res) => {
    return res.json({ history: [] });
  });

  app.get("/api/cases/:caseId/applicants", (_req, res) => {
    return res.json({ applicants: [] });
  });

  app.get("/api/payments/payment-method/default", (_req, res) => {
    return res.json({ hasDefault: Boolean(state.paymentMethod), paymentMethod: state.paymentMethod });
  });

  app.post("/api/payments/payment-method/default", (req, res) => {
    const paymentMethodId = String(req.body?.paymentMethodId || "pm_test_123");
    state.paymentMethod = {
      id: paymentMethodId,
      type: "card",
      brand: "visa",
      last4: "4242",
      exp_month: 12,
      exp_year: 2030,
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
    return res.json({ url: "/dashboard-attorney.html#funds" });
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
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve));
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
      type: "card",
      brand: "visa",
      last4: "4242",
      exp_month: 12,
      exp_year: 2030,
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
    cases: [buildCase("507f1f77bcf86cd799439022")],
  });
}

async function validateCaseDetailResponsiveLayout(page, baseUrl) {
  await page.setJavaScriptEnabled(false);
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto(`${baseUrl}/case-detail.html?caseId=507f1f77bcf86cd799439022`, { waitUntil: "domcontentloaded" });
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
    const rail = document.querySelector(".case-rail-stack");
    const stage = document.querySelector(".matter-stage");
    const tabs = document.querySelector(".matter-tabs");
    const overview = document.querySelector('[data-matter-panel="overview"]');
    if (!workspace || !rail || !stage || !tabs || !overview) return null;
    const rawCols = getComputedStyle(workspace).gridTemplateColumns;
    const cols = countTracks(rawCols);
    const workspaceRect = workspace.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    return {
      display: getComputedStyle(workspace).display,
      cols,
      rawCols,
      workspaceWidth: workspaceRect.width,
      railWidth: railRect.width,
      stageWidth: stageRect.width,
      stacked: stageRect.top >= railRect.bottom - 1,
      tabsContained: tabs.scrollWidth <= tabs.clientWidth + 1,
      overviewVisible: getComputedStyle(overview).display !== "none" && overview.getBoundingClientRect().height > 0,
    };
  });

  if (
    !medium ||
    medium.display !== "grid" ||
    medium.cols !== 1 ||
    !medium.stacked ||
    !medium.tabsContained ||
    !medium.overviewVisible ||
    Math.abs(medium.railWidth - medium.workspaceWidth) > 2 ||
    Math.abs(medium.stageWidth - medium.workspaceWidth) > 2
  ) {
    throw new Error(
      `Expected the compact Matter toolbar and full-width stage at 1000px: ${JSON.stringify(medium)}.`
    );
  }

  await page.setViewport({ width: 850, height: 900 });
  await page.goto(`${baseUrl}/case-detail.html?caseId=507f1f77bcf86cd799439022`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".case-workspace", { timeout: 10_000 });

  const small = await page.evaluate(() => {
    const workspace = document.querySelector(".case-workspace");
    const stage = document.querySelector(".matter-stage");
    const overview = document.querySelector('[data-matter-panel="overview"]');
    const tabs = document.querySelector(".matter-tabs");
    const firstTab = tabs?.querySelector("button");
    const matterTitle = document.querySelector("#caseTitle");
    if (!workspace || !stage || !overview || !tabs || !firstTab || !matterTitle) return null;
    const hasHorizontalOverflow =
      document.documentElement.scrollWidth > window.innerWidth + 1;
    return {
      display: getComputedStyle(workspace).display,
      stageHeight: stage.getBoundingClientRect().height,
      overviewHeight: overview.getBoundingClientRect().height,
      tabHeight: firstTab.getBoundingClientRect().height,
      titleHeight: matterTitle.getBoundingClientRect().height,
      titleContained: matterTitle.getBoundingClientRect().right <= window.innerWidth + 1,
      tabStripContained: tabs.getBoundingClientRect().right <= window.innerWidth + 1,
      hasHorizontalOverflow,
    };
  });

  if (!small) {
    throw new Error(
      "Expected case workspace to render on mobile-sized viewport."
    );
  }

  if (
    small.display !== "block" ||
    small.stageHeight <= 0 ||
    small.overviewHeight <= 0 ||
    small.tabHeight < 44 ||
    small.titleHeight <= 0 ||
    !small.titleContained ||
    !small.tabStripContained ||
    small.hasHorizontalOverflow
  ) {
    throw new Error(`Expected an operable, overflow-free tablet Matter workspace: ${JSON.stringify(small)}.`);
  }
  await page.setJavaScriptEnabled(true);
}

async function run() {
  const { server, port } = await startStubServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await launchPuppeteer({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 120_000,
  });

  const page = await browser.newPage();
  const localResourceFailures = [];
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
  page.on("response", (response) => {
    const request = response.request();
    const type = request.resourceType();
    if (
      response.url().startsWith(baseUrl) &&
      response.status() >= 400 &&
      ["document", "stylesheet", "script", "image", "font"].includes(type)
    ) {
      localResourceFailures.push(`${response.status()} ${type} ${response.url()}`);
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
      id: "507f1f77bcf86cd799439011",
      _id: "507f1f77bcf86cd799439011",
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
    if (localResourceFailures.length) {
      throw new Error(`Local onboarding resources failed: ${[...new Set(localResourceFailures)].join(" | ")}`);
    }

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
