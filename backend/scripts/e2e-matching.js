const path = require("path");
const http = require("http");
const express = require("express");
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

const PARALEGAL = {
  id: "507f191e810c19729de860ea",
  _id: "507f191e810c19729de860ea",
  role: "paralegal",
  status: "approved",
  firstName: "Priya",
  lastName: "Ng",
  email: "samanthasider+56@gmail.com", // always Stripe bypass
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

async function safeClick(page, selector) {
  await page.evaluate((sel) => document.querySelector(sel)?.click(), selector);
}

function startStubServer() {
  const app = express();
  const frontendDir = path.join(__dirname, "../../frontend");
  const publicDir = path.join(__dirname, "../../public");

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));
  app.use(express.static(frontendDir));

  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "test-csrf" }));

  app.get("/api/auth/me", (_req, res) => {
    res.json({ user: PARALEGAL });
  });

  app.get("/api/jobs/open", (_req, res) => {
    res.json(JOBS);
  });

  app.get("/api/users/attorneys/:id", (req, res) => {
    const id = String(req.params.id || "");
    const match = Object.values(ATTORNEYS).find((attorney) => attorney._id === id);
    if (!match) return res.status(404).json({ error: "Attorney not found" });
    res.json(match);
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function run() {
  const { server, port } = await startStubServer();
  const baseUrl = `http://localhost:${port}`;

  const browser = await puppeteer.launch({
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
    const initialCount = await page.$$eval(".job-card", (cards) => cards.length);
    if (initialCount !== JOBS.length) {
      throw new Error(`Expected ${JOBS.length} jobs, saw ${initialCount}`);
    }

    // Test: Filter by state works (CA).
    // Input values: filterState=CA, apply filters.
    // Expected result: only the CA job remains.
    await page.select("#filterState", "CA");
    await safeClick(page, "#applyFilters");
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
    await safeClick(page, "#clearFilters");
    await page.waitForFunction(
      () => document.querySelectorAll(".job-card").length === 2,
      { timeout: 5000 }
    );
    await page.select("#filterPracticeArea", "Business Law");
    await safeClick(page, "#applyFilters");
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
    await safeClick(page, "#applyFilters");
    await page.waitForFunction(() => {
      const text = document.querySelector(".jobs-grid")?.textContent || "";
      return text.includes("No matters match your filters yet");
    }, { timeout: 5000 });

    // Test: Selecting a job shows full details.
    // Input values: click "View Case" on a job card.
    // Expected result: expanded job card renders with full description.
    await safeClick(page, "#clearFilters");
    await page.waitForFunction(
      () => document.querySelectorAll(".job-card").length === 2,
      { timeout: 5000 }
    );
    const viewButtons = await page.$$(".job-card .clear-button");
    if (!viewButtons.length) throw new Error("No View Case buttons found");
    await page.evaluate(() => document.querySelector(".job-card .clear-button")?.click());
    await page.waitForSelector(".job-card.expanded .rich-text.main-description");
    const description = await page.$eval(
      ".job-card.expanded .rich-text.main-description",
      (el) => el.textContent.trim()
    );
    if (!description.includes("USCIS packet review")) {
      throw new Error(`Expanded job details missing description: ${description}`);
    }

    console.log("E2E matching + discovery validation complete.");
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
