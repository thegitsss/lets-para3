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

function createState() {
  return {
    user: {
      id: "paralegal-1",
      _id: "paralegal-1",
      role: "paralegal",
      status: "approved",
      firstName: "Priya",
      lastName: "Ng",
      email: "paralegal@example.com",
      isFirstLogin: true,
      onboarding: {
        paralegalWelcomeDismissed: false,
        paralegalTourCompleted: false,
        paralegalProfileTourCompleted: false,
      },
      preferences: { theme: "light", fontSize: "md" },
    },
  };
}

async function startStubServer() {
  const app = express();
  const state = createState();
  const frontendDir = path.join(__dirname, "../../frontend");
  const publicDir = path.join(__dirname, "../../public");

  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));
  app.use(express.static(frontendDir));

  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "test-csrf" }));

  app.get("/api/auth/me", (_req, res) => {
    res.json({ user: state.user });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.json({ success: true });
  });

  app.get("/api/users/me", (_req, res) => {
    res.json(state.user);
  });

  app.patch("/api/users/me", (req, res) => {
    const updates = req.body || {};
    state.user = { ...state.user, ...updates };
    res.json(state.user);
  });

  app.get("/api/users/me/onboarding", (_req, res) => {
    res.json({ onboarding: state.user.onboarding || {} });
  });

  app.patch("/api/users/me/onboarding", (req, res) => {
    state.user.onboarding = {
      ...(state.user.onboarding || {}),
      ...(req.body || {}),
    };
    res.json({ onboarding: state.user.onboarding });
  });

  app.get("/api/payments/connect/status", (_req, res) => {
    res.json({ connected: true, details_submitted: true, payouts_enabled: true });
  });

  app.post("/api/payments/connect", (_req, res) => {
    res.json({ url: "/dashboard-paralegal.html" });
  });

  app.get("/api/paralegal/dashboard", (_req, res) => {
    res.json({
      metrics: {
        activeCases: 0,
        earnings: 0,
        earningsTotal: 0,
        earningsLast30Days: 0,
        nextPayoutDate: "",
      },
      activeCases: [],
    });
  });

  app.get("/api/cases/invited-to", (_req, res) => res.json({ items: [] }));
  app.get("/api/events", (_req, res) => res.json({ items: [] }));
  app.get("/api/messages/threads", (_req, res) => res.json({ threads: [] }));
  app.get("/api/messages/unread-count", (_req, res) => res.json({ count: 0 }));
  app.get("/api/cases/my-assigned", (_req, res) => res.json({ items: [] }));
  app.get("/api/jobs/open", (_req, res) => res.json({ items: [] }));
  app.get("/api/applications/my", (_req, res) => res.json({ items: [] }));

  app.get("/api/notifications", (_req, res) => res.json([]));
  app.get("/api/notifications/unread-count", (_req, res) =>
    res.json({ unread: 0, count: 0 })
  );
  app.post("/api/notifications/:id/read", (_req, res) => res.json({ ok: true }));

  app.get("/api/users/me/blocked", (_req, res) => res.json({ blocked: [] }));

  app.use("/api", (_req, res) => res.json({}));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return { server, port };
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

  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      const parsed = new URL(url);
      if (parsed.origin !== baseUrl && !parsed.pathname.startsWith("/api/")) {
        return request.abort();
      }
    }
    return request.continue();
  });

  try {
    await page.evaluateOnNewDocument((user) => {
      localStorage.setItem("lpc_user", JSON.stringify(user));
      sessionStorage.removeItem("lpc_paralegal_replay_tour");
    }, {
      id: "paralegal-1",
      _id: "paralegal-1",
      role: "paralegal",
      status: "approved",
      firstName: "Priya",
      lastName: "Ng",
      email: "paralegal@example.com",
      isFirstLogin: true,
      onboarding: {
        paralegalWelcomeDismissed: false,
        paralegalTourCompleted: false,
        paralegalProfileTourCompleted: false,
      },
      preferences: { theme: "light", fontSize: "md" },
    });

    await page.setViewport({ width: 1365, height: 900 });
    await page.goto(`${baseUrl}/dashboard-paralegal.html`, { waitUntil: "domcontentloaded" });

    await page.waitForSelector("#paralegalTourModal.is-active", { timeout: 15_000 });

    await page.click("#startTourBtn");
    await page.waitForSelector("#profileTourTooltip.is-active", { timeout: 10_000 });

    const tooltipVisible = await page.evaluate(() => {
      const overlay = document.getElementById("paralegalTourOverlay");
      const tooltip = document.getElementById("profileTourTooltip");
      const link = document.getElementById("profileSettingsLink");
      return (
        overlay?.classList.contains("is-active") &&
        overlay?.classList.contains("spotlight") &&
        tooltip?.classList.contains("is-active") &&
        link?.classList.contains("tour-highlight")
      );
    });
    if (!tooltipVisible) {
      throw new Error("Paralegal profile spotlight step did not render correctly.");
    }

    await page.click("#tourBackBtn");
    await page.waitForSelector("#paralegalTourModal.is-active", { timeout: 10_000 });

    await page.click("#startTourBtn");
    await page.waitForSelector("#profileTourTooltip.is-active", { timeout: 10_000 });
    await page.click("#tourNextBtn");

    await page.waitForFunction(
      () =>
        window.location.pathname.endsWith("/profile-settings.html") &&
        window.location.search.includes("tour=1"),
      { timeout: 15_000 }
    );

    console.log("Paralegal dashboard tour smoke test passed.");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
