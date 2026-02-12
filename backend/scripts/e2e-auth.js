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

const VALID_EMAIL = "attorney@example.com";
const VALID_PASSWORD = "Password123!";

function startStubServer() {
  const app = express();
  const frontendDir = path.join(__dirname, "../../frontend");
  const publicDir = path.join(__dirname, "../../public");
  const sessionCookie = "lpc_session";

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));
  app.use(express.static(frontendDir));

  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "test-csrf" }));
  function hasSession(req) {
    const raw = req.headers.cookie || "";
    return raw.split(";").some((pair) => pair.trim().startsWith(`${sessionCookie}=1`));
  }

  app.get("/api/auth/me", (req, res) => {
    if (!hasSession(req)) return res.status(401).json({ user: null });
    return res.json({
      user: {
        id: "test-user",
        role: "attorney",
        status: "approved",
      },
    });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie(sessionCookie);
    res.json({ success: true });
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body || {};
    if (email === VALID_EMAIL && password === VALID_PASSWORD) {
      res.cookie(sessionCookie, "1", { httpOnly: true, sameSite: "lax" });
      return res.json({
        success: true,
        user: {
          id: "test-user",
          role: "attorney",
          status: "approved",
        },
      });
    }
    return res.status(400).json({ msg: "Invalid credentials" });
  });

  const server = http.createServer(app);

  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function runLoginFlow(page, baseUrl, { email, password }) {
  await page.goto(`${baseUrl}/login.html`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#loginForm");
  await page.type("#email", email);
  await page.type("#password", password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.evaluate((selector) => document.querySelector(selector)?.click(), "#loginForm button[type=\"submit\"]"),
  ]);
}

async function runInvalidLoginFlow(page, baseUrl) {
  await page.goto(`${baseUrl}/login.html`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#loginForm");
  await page.type("#email", "bad@example.com");
  await page.type("#password", "wrong");
  await page.evaluate((selector) => document.querySelector(selector)?.click(), "#loginForm button[type=\"submit\"]");
  await page.waitForSelector("#toastBanner.show");
  const toastText = await page.$eval("#toastBanner", (el) => el.textContent.trim());
  if (!toastText || !toastText.toLowerCase().includes("invalid credentials")) {
    throw new Error(`Expected toast error, got: "${toastText}"`);
  }
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
  const closeContext = async (context) => {
    if (context && context !== defaultContext && typeof context.close === "function") {
      await context.close();
    }
  };

  try {
    const desktopContext = await createContext();
    const desktopPage = await desktopContext.newPage();
    desktopPage.setDefaultTimeout(60_000);
    desktopPage.setDefaultNavigationTimeout(60_000);
    await desktopPage.setViewport({ width: 1280, height: 720 });
    await runLoginFlow(desktopPage, baseUrl, { email: VALID_EMAIL, password: VALID_PASSWORD });
    const desktopUrl = desktopPage.url();
    if (!desktopUrl.endsWith("/dashboard-attorney.html")) {
      throw new Error(`Desktop login redirect failed: ${desktopUrl}`);
    }

    const mobileContext = await createContext();
    const mobilePage = await mobileContext.newPage();
    mobilePage.setDefaultTimeout(60_000);
    mobilePage.setDefaultNavigationTimeout(60_000);
    await mobilePage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await runLoginFlow(mobilePage, baseUrl, { email: VALID_EMAIL, password: VALID_PASSWORD });
    const mobileUrl = mobilePage.url();
    if (!mobileUrl.endsWith("/dashboard-attorney.html")) {
      throw new Error(`Mobile login redirect failed: ${mobileUrl}`);
    }

    const invalidContext = await createContext();
    const invalidPage = await invalidContext.newPage();
    invalidPage.setDefaultTimeout(60_000);
    invalidPage.setDefaultNavigationTimeout(60_000);
    await invalidPage.setViewport({ width: 1280, height: 720 });
    await runInvalidLoginFlow(invalidPage, baseUrl);

    await closeContext(desktopContext);
    await closeContext(mobileContext);
    await closeContext(invalidContext);

    console.log("E2E auth validation complete.");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
