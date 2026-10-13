const path = require("path");
const http = require("http");
const express = require("express");
const { clickVisible, launchPuppeteer } = require("./puppeteerBrowser");

const PARALEGAL = {
  id: "507f191e810c19729de860ea",
  _id: "507f191e810c19729de860ea",
  role: "paralegal",
  status: "approved",
  firstName: "Priya",
  lastName: "Ng",
  email: "samanthasider+56@gmail.com", // always Stripe bypass
  profileImage: "/assets/avatar-placeholder.svg",
};

const ATTORNEYS = {
  a1: {
    _id: "507f1f77bcf86cd799439011",
    firstName: "Taylor",
    lastName: "Reed",
    lawFirm: "Reed & Co",
    completedJobs: 3,
    profileImage: "",
  },
  a2: {
    _id: "507f1f77bcf86cd799439012",
    firstName: "Morgan",
    lastName: "Lee",
    lawFirm: "Lee Legal",
    completedJobs: 1,
    profileImage: "",
  },
};

const JOBS = [
  {
    _id: "64b7f1f77bcf86cd79943901",
    jobId: "64b7f1f77bcf86cd79943901",
    title: "Immigration filing support",
    practiceArea: "Immigration",
    description: "Assist with client intake and USCIS packet review for a family-based filing.",
    budget: 600,
    state: "CA",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    attorneyId: ATTORNEYS.a1._id,
  },
  {
    _id: "64b7f1f77bcf86cd79943902",
    jobId: "64b7f1f77bcf86cd79943902",
    title: "Contract review",
    practiceArea: "Business Law",
    description: "Review vendor contracts and summarize key risk areas for counsel.",
    budget: 500,
    state: "NY",
    createdAt: new Date().toISOString(),
    attorneyId: ATTORNEYS.a2._id,
  },
];

function startStubServer() {
  const app = express();
  const frontendDir = path.join(__dirname, "../../frontend");
  const publicDir = path.join(__dirname, "../../public");
  const applicationRequests = [];
  const applications = [];

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));
  app.use(express.static(frontendDir));

  app.get("/assets/vendor/web-vitals-6.1.1.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.resolve(__dirname, "../node_modules/web-vitals/dist/web-vitals.js"));
  });

  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "test-csrf" }));

  app.get("/api/auth/me", (_req, res) => {
    res.json({ user: PARALEGAL });
  });

  app.get("/api/jobs/open", (req, res) => {
    const filters = {
      practice: String(req.query.practice || ""), state: String(req.query.state || ""),
      minPay: Number(req.query.minPay || 0), sort: String(req.query.sort || "newest"),
      deadline: String(req.query.deadline || ""), posted: String(req.query.posted || ""), page: 1,
    };
    const available = JOBS.filter(job => !applications.some(application => application.jobId._id === job._id))
      .map(job => ({ ...job, applicationEligibility: { ready: true, allowed: true, blockers: [] } }));
    const matches = available.filter(job => (!filters.practice || job.practiceArea === filters.practice) &&
      (!filters.state || job.state === filters.state) && job.budget >= filters.minPay);
    matches.sort((a, b) => filters.sort === "payHigh" ? b.budget - a.budget : filters.sort === "payLow" ? a.budget - b.budget : Date.parse(b.createdAt) - Date.parse(a.createdAt));
    res.json({ items: matches, selected: available.find(job => job._id === req.query.matterId) || null,
      viewerId: PARALEGAL.id, total: matches.length, availableTotal: available.length,
      page: 1, limit: Number(req.query.limit), totalPages: 1, filters,
      facets: { states: [...new Set(available.map(job => job.state))], practices: [...new Set(available.map(job => job.practiceArea))] },
    });
  });

  app.get("/api/applications/my", (_req, res) => {
    res.json(applications);
  });

  app.post("/api/jobs/:jobId/apply", async (req, res) => {
    const job = JOBS.find((item) => item._id === req.params.jobId);
    if (!job) return res.status(404).json({ error: "Matter not found" });
    applicationRequests.push({ jobId: req.params.jobId, body: req.body });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const application = {
      _id: `64b7f1f77bcf86cd79943${String(applications.length + 20).padStart(3, "0")}`,
      jobId: { _id: job._id },
      coverLetter: String(req.body?.coverLetter || ""),
      createdAt: new Date().toISOString(),
    };
    applications.push(application);
    return res.status(201).json(application);
  });

  app.get("/api/payments/connect/status", (_req, res) => {
    res.json({ connected: true, details_submitted: true, payouts_enabled: true });
  });

  app.get("/api/notifications", (_req, res) => {
    res.json({ notifications: [], unread: 0 });
  });
  app.get("/api/notifications/unread-count", (_req, res) => res.json({ count: 0 }));
  app.get("/api/notifications/stream", (_req, res) => res.status(204).end());

  app.get("/api/users/attorneys/:id", (req, res) => {
    const id = String(req.params.id || "");
    const match = Object.values(ATTORNEYS).find((attorney) => attorney._id === id);
    if (!match) return res.status(404).json({ error: "Attorney not found" });
    res.json(match);
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const { port } = server.address();
      resolve({ server, port, applicationRequests });
    });
  });
}

async function run() {
  const { server, port, applicationRequests } = await startStubServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await launchPuppeteer({
    headless: "new",
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
  const closeContext = async (ctx) => {
    if (ctx && ctx !== defaultContext && typeof ctx.close === "function") {
      await ctx.close();
    }
  };

  const context = await createContext();
  const page = await context.newPage();
  const pageErrors = [];
  const failedLocalAssets = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === baseUrl && !url.pathname.startsWith("/api/") && response.status() >= 400) {
      failedLocalAssets.push(`${response.status()} ${url.pathname}`);
    }
  });
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);

  await page.evaluateOnNewDocument((user) => {
    localStorage.setItem("lpc_user", JSON.stringify(user));
    window.getSessionData = async () => ({ user, role: user.role, status: user.status });
    window.checkSession = async () => ({ user, role: user.role, status: user.status });
    window.redirectUserDashboard = () => {};
    window.refreshSession = async () => ({ user, role: user.role, status: user.status });
  }, PARALEGAL);

  try {
    // Test: Paralegals can see all posted jobs.
    // Input values: 2 jobs from /api/jobs/open.
    // Expected result: two job cards render.
    await page.goto(`${baseUrl}/browse-jobs.html`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".job-card");
    const initialPanelState = await page.evaluate(() => ({
      openPanels: document.querySelectorAll("[data-notification-panel].show").length,
      visibleHiddenPanels: Array.from(document.querySelectorAll("[data-notification-panel].hidden"))
        .filter((panel) => {
          const style = getComputedStyle(panel);
          return style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0;
        }).length,
    }));
    if (initialPanelState.openPanels || initialPanelState.visibleHiddenPanels) {
      throw new Error(`Notifications opened without user action: ${JSON.stringify(initialPanelState)}`);
    }
    const initialCount = await page.$$eval(".job-card", (cards) => cards.length);
    if (initialCount !== JOBS.length) {
      throw new Error(`Expected ${JOBS.length} jobs, saw ${initialCount}`);
    }
    const desktopLayout = await page.evaluate(() => {
      const shell = document.querySelector(".browse-page-shell")?.getBoundingClientRect();
      const main = document.querySelector(".jobs-shell")?.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll(".job-card"), (card) => card.getBoundingClientRect());
      const boundary = Math.min(window.innerWidth, shell?.right || window.innerWidth);
      return {
        boundary,
        mainRight: main?.right || 0,
        clippedCards: cards.filter((card) => card.right > boundary + 1).length,
      };
    });
    if (desktopLayout.mainRight > desktopLayout.boundary + 1 || desktopLayout.clippedCards) {
      throw new Error(`Browse Matters desktop content is clipped: ${JSON.stringify(desktopLayout)}`);
    }
    await page.screenshot({ path: "/tmp/lpc-prompt5-paralegal-browse-matters-list-desktop.png", fullPage: true });

    // Test: Filter by state works (CA).
    // Input values: filterState=CA, apply filters.
    // Expected result: only the CA job remains.
    await page.select("#filterState", "CA");
    await clickVisible(page, "#applyFilters");
    await page.waitForFunction(
      () => document.querySelectorAll(".job-card").length === 1,
      { timeout: 5000 }
    );
    const stateTitles = await page.$$eval(".job-card h3", (els) => els.map((el) => el.textContent.trim()));
    if (!stateTitles[0].includes("Immigration")) {
      throw new Error(`State filter failed, got: ${stateTitles.join(", ")}`);
    }

    // Test: Filter by practice area works (Business Law).
    // Input values: filterPracticeArea=Business Law, apply filters.
    // Expected result: only the Business Law job remains.
    await clickVisible(page, "#clearFilters");
    await page.waitForFunction(
      () => document.querySelectorAll(".job-card").length === 2,
      { timeout: 5000 }
    );
    await page.select("#filterPracticeArea", "Business Law");
    await clickVisible(page, "#applyFilters");
    await page.waitForFunction(
      () => document.querySelectorAll(".job-card").length === 1,
      { timeout: 5000 }
    );
    const practiceTitles = await page.$$eval(".job-card h3", (els) => els.map((el) => el.textContent.trim()));
    if (!practiceTitles[0].includes("Contract review")) {
      throw new Error(`Practice area filter failed, got: ${practiceTitles.join(", ")}`);
    }

    // Test: Filter failure case (no matches).
    // Input values: state=CA + practiceArea=Business Law.
    // Expected result: empty-state message shown.
    await page.select("#filterState", "CA");
    await page.select("#filterPracticeArea", "Business Law");
    await clickVisible(page, "#applyFilters");
    await page.waitForFunction(() => {
      const text = document.querySelector(".jobs-grid")?.textContent || "";
      return text.includes("No matters match these filters.");
    }, { timeout: 5000 });

    // Test: Selecting a Matter shows full details.
    // Input values: click "View Matter" on a Matter card.
    // Expected result: expanded job card renders with full description.
    await clickVisible(page, "#clearFilters");
    await page.waitForFunction(
      () => document.querySelectorAll(".job-card").length === 2,
      { timeout: 5000 }
    );
    const viewButtons = await page.$$(".job-card .clear-button");
    if (!viewButtons.length) throw new Error("No View Matter buttons found");
    await clickVisible(page, ".job-card .clear-button");
    await page.waitForSelector(".job-card.expanded .rich-text.main-description");
    const description = await page.$eval(
      ".job-card.expanded .rich-text.main-description",
      (el) => el.textContent.trim()
    );
    if (!JOBS.some((job) => description.includes(job.description))) {
      throw new Error(`Expanded job details missing description: ${description}`);
    }
    const expandedTitle = await page.$eval(".job-card.expanded h3", (el) => el.textContent.trim());

    await page.screenshot({ path: "/tmp/lpc-prompt5-paralegal-browse-matters-desktop.png", fullPage: true });

    // Test: Application dialog is named, labeled, keyboard-contained, and restores focus.
    const applySelector = ".job-card.expanded .apply-button";
    await page.waitForSelector(applySelector);
    await page.focus(applySelector);
    await clickVisible(page, applySelector);
    await page.waitForSelector(".job-apply-overlay.show");
    const dialogState = await page.evaluate(() => ({
      labelledBy: document.querySelector(".job-apply-dialog")?.getAttribute("aria-labelledby"),
      focusedId: document.activeElement?.id || "",
      hasLabel: Boolean(document.querySelector('label[for="jobApplyCoverLetter"]')),
      title: document.querySelector("#jobApplyTitle")?.textContent || "",
    }));
    if (dialogState.labelledBy !== "jobApplyTitle" || dialogState.focusedId !== "jobApplyCoverLetter" || !dialogState.hasLabel) {
      throw new Error(`Application dialog accessibility failed: ${JSON.stringify(dialogState)}`);
    }
    if (!dialogState.title.includes(expandedTitle)) {
      throw new Error(`Application dialog lost Matter title: ${dialogState.title}`);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".job-apply-overlay.show"));
    const restored = await page.evaluate((selector) => document.activeElement === document.querySelector(selector), applySelector);
    if (!restored) throw new Error("Application dialog did not restore focus to its launch control");

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot({ path: "/tmp/lpc-prompt5-paralegal-browse-matters-mobile.png", fullPage: true });
    const mobileMetrics = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      applyHeight: document.querySelector(".job-card.expanded .apply-button")?.getBoundingClientRect().height || 0,
    }));
    if (mobileMetrics.scrollWidth > mobileMetrics.viewport + 1 || mobileMetrics.applyHeight < 44) {
      throw new Error(`Browse Matters mobile layout failed: ${JSON.stringify(mobileMetrics)}`);
    }

    await clickVisible(page, ".job-card.expanded .ghost-button");
    await page.waitForFunction(() => document.querySelectorAll(".job-card").length === 2);
    await page.waitForFunction(() => document.activeElement?.matches('.job-card .clear-button[data-job-id]'));
    const mobileListMetrics = await page.evaluate(() => {
      const toggle = document.querySelector("#filterToggle")?.getBoundingClientRect();
      const navigationToggle = document.querySelector("#sidebarToggle")?.getBoundingClientRect();
      const clippedCards = Array.from(document.querySelectorAll(".job-card"))
        .filter((card) => card.getBoundingClientRect().right > window.innerWidth + 1).length;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        toggleWidth: toggle?.width || 0,
        toggleHeight: toggle?.height || 0,
        navigationToggleWidth: navigationToggle?.width || 0,
        navigationToggleHeight: navigationToggle?.height || 0,
        listScrollTop: document.querySelector(".browse-page-shell")?.scrollTop || 0,
        returnFocusLabel: document.activeElement?.textContent?.trim() || "",
        clippedCards,
      };
    });
    if (
      mobileListMetrics.scrollWidth > mobileListMetrics.viewport + 1 ||
      mobileListMetrics.toggleWidth < 44 ||
      mobileListMetrics.toggleHeight < 44 ||
      mobileListMetrics.navigationToggleWidth < 44 ||
      mobileListMetrics.navigationToggleHeight < 44 ||
      mobileListMetrics.listScrollTop > 1 ||
      mobileListMetrics.returnFocusLabel !== "Details" ||
      mobileListMetrics.clippedCards
    ) {
      throw new Error(`Browse Matters mobile list failed: ${JSON.stringify(mobileListMetrics)}`);
    }
    await page.screenshot({ path: "/tmp/lpc-prompt5-paralegal-browse-matters-list-mobile.png", fullPage: true });
    await clickVisible(page, "#sidebarToggle");
    await page.waitForFunction(() => document.body.classList.contains("nav-open") && document.querySelector("#sidebarNav")?.getBoundingClientRect().left >= -1);
    const mobileNavigationState = await page.evaluate(() => ({
      expanded: document.querySelector("#sidebarToggle")?.getAttribute("aria-expanded"),
      sidebarLeft: document.querySelector("#sidebarNav")?.getBoundingClientRect().left,
      activeElement: document.activeElement?.closest("#sidebarNav")?.id || "",
    }));
    if (
      mobileNavigationState.expanded !== "true" ||
      mobileNavigationState.sidebarLeft < -1 ||
      mobileNavigationState.activeElement !== "sidebarNav"
    ) {
      throw new Error(`Browse Matters mobile navigation failed: ${JSON.stringify(mobileNavigationState)}`);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.body.classList.contains("nav-open"));
    const restoredNavigationFocus = await page.evaluate(() => document.activeElement?.id === "sidebarToggle");
    if (!restoredNavigationFocus) throw new Error("Browse Matters mobile navigation did not restore focus");
    // Escape restores focus before the closing sidebar animation finishes.
    // Wait for the real hit target before exercising the next pointer action.
    await page.waitForFunction(() => {
      const button = document.querySelector(".job-card .clear-button");
      const rect = button?.getBoundingClientRect();
      return rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button;
    });

    // Test: a paralegal submits a real application through the visible dialog.
    const applyingMatter = await page.$eval(".job-card", (card) => ({
      id: card.querySelector(".clear-button")?.dataset?.jobId || "",
      title: card.querySelector("h3")?.textContent?.trim() || "",
    }));
    await clickVisible(page, ".job-card .clear-button");
    await page.waitForSelector(".job-card.expanded .apply-button");
    await clickVisible(page, ".job-card.expanded .apply-button");
    await page.waitForSelector(".job-apply-overlay.show");
    await clickVisible(page, "[data-apply-submit]");
    await page.waitForFunction(() =>
      document.querySelector("[data-apply-status]")?.textContent.includes("Add a short cover letter")
    );
    if (applicationRequests.length !== 0) {
      throw new Error("An empty application reached the server.");
    }

    const coverLetter = "I have eight years of immigration filing experience and can organize the submission immediately.";
    await page.type("#jobApplyCoverLetter", coverLetter);
    const applicationResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.pathname.endsWith("/apply");
    });
    await clickVisible(page, "[data-apply-submit]");
    await page.waitForFunction(() => {
      const button = document.querySelector("[data-apply-submit]");
      return Boolean(button?.disabled && button.textContent?.trim() === "Applying…");
    });
    const applicationResponse = await applicationResponsePromise;
    if (applicationResponse.status() !== 201) {
      throw new Error(`Expected application 201, received ${applicationResponse.status()}`);
    }
    await page.waitForSelector(".apply-confirm-overlay.show");
    const confirmation = await page.$eval("[data-apply-confirm-message]", (node) => node.textContent.trim());
    if (!confirmation.includes(applyingMatter.title)) {
      throw new Error(`Application confirmation lost the Matter title: ${confirmation}`);
    }
    if (
      applicationRequests.length !== 1 ||
      applicationRequests[0].jobId !== applyingMatter.id ||
      applicationRequests[0].body?.coverLetter !== coverLetter
    ) {
      throw new Error(`Unexpected application request: ${JSON.stringify(applicationRequests)}`);
    }
    await clickVisible(page, "[data-apply-confirm-close]");
    await page.waitForFunction(() => !document.querySelector(".apply-confirm-overlay.show"));
    await page.waitForFunction(() => document.activeElement?.matches('.clear-button[data-job-id]'));
    const remainingTitles = await page.$$eval(".job-card h3", (nodes) => nodes.map((node) => node.textContent.trim()));
    if (remainingTitles.includes(applyingMatter.title)) {
      throw new Error(`Applied Matter remained in the open list: ${remainingTitles.join(", ")}`);
    }
    if (pageErrors.length) throw new Error(`Browse Matters UI page errors:\n${pageErrors.join("\n")}`);
    if (failedLocalAssets.length) throw new Error(`Browse Matters UI asset failures:\n${failedLocalAssets.join("\n")}`);

    console.log("E2E matching + discovery validation complete.");
  } catch (error) {
    const state = await page.evaluate(() => {
      const details = document.querySelector(".job-card .clear-button");
      const rect = details?.getBoundingClientRect();
      return { url: location.href, bodyClass: document.body.className,
        grid: document.querySelector(".jobs-grid")?.textContent?.trim(),
        focused: { tag: document.activeElement?.tagName, id: document.activeElement?.id, className: document.activeElement?.className },
        pointerTarget: rect ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML?.slice(0, 500) : null,
      };
    }).catch(() => ({ unavailable: true }));
    console.error("Matching failure state:", JSON.stringify(state), "page errors:", pageErrors);
    await page.screenshot({ path: "/tmp/lpc-prompt5-paralegal-browse-matters-failure.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await page.close();
    await closeContext(context);
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
