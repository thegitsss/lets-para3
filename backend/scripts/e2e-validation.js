const path = require("path");
const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
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

function startStubServer() {
  const app = express();
  const frontendDir = path.join(__dirname, "../../frontend");
  const publicDir = path.join(__dirname, "../../public");
  const upload = multer();

  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));
  app.use(express.static(frontendDir));

  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "test-csrf" }));
  app.post("/api/auth/register", upload.any(), (_req, res) => {
    res.json({ msg: "Registered successfully. Await admin approval." });
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function gotoSignup(page, baseUrl) {
  await page.goto(`${baseUrl}/signup.html`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#signupForm");
  await page.evaluate(() => {
    const form = document.getElementById("signupForm");
    if (!form) return;
    let input = form.querySelector("input[name='cf-turnstile-response']");
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "cf-turnstile-response";
      form.appendChild(input);
    }
    input.value = "test-token";
  });
}

async function safeClick(page, selector) {
  await page.evaluate((sel) => document.querySelector(sel)?.click(), selector);
}

async function fillStepOne(page, { firstName, lastName, email, password }) {
  await page.type("#firstName", firstName);
  await page.type("#lastName", lastName);
  await page.type("#email", email);
  await page.type("#password", password);
  await page.type("#passwordConfirm", password);
  await safeClick(page, "#termsAccept");
  await safeClick(page, "#nextStepBtn");
  await page.waitForSelector("#stepTwoPanel:not(.hidden-step)");
}

async function submitAttorneySignup(page, { barNumber, barState, goodStanding = true }) {
  await page.type("#bar", barNumber);
  if (barState) {
    await page.select("#barState", barState);
  }
  if (goodStanding) {
    await safeClick(page, "#attorneyGoodStanding");
  }
  await safeClick(page, "#submitBtn");
  await page.waitForSelector("#msg.show");
  return page.$eval("#msg", (el) => el.textContent.trim());
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
  const configurePage = (page) => {
    page.setDefaultTimeout(60_000);
    page.setDefaultNavigationTimeout(60_000);
  };

  try {
    // Test: Bar number rejects invalid format.
    // Input values: barNumber="CA" with barState="CA".
    // Expected result: "Enter a valid bar number." error message shown.
    {
      const context = await createContext();
      const page = await context.newPage();
      configurePage(page);
      await page.setViewport({ width: 1280, height: 720 });
      await gotoSignup(page, baseUrl);
      await safeClick(page, "#btnA");
      await fillStepOne(page, {
        firstName: "Test",
        lastName: "Attorney",
        email: "invalidbar@example.com",
        password: "Password123!",
      });
      const msg = await submitAttorneySignup(page, {
        barNumber: "CA",
        barState: "CA",
      });
      if (!msg.includes("Enter a valid bar number")) {
        throw new Error(`Expected invalid bar message, got: ${msg}`);
      }
      await closeContext(context);
    }

    // Test: State dropdown required on attorney form.
    // Input values: barNumber="12345" with no barState selected.
    // Expected result: "Please select the state for your bar number." error message shown.
    {
      const context = await createContext();
      const page = await context.newPage();
      configurePage(page);
      await page.setViewport({ width: 1280, height: 720 });
      await gotoSignup(page, baseUrl);
      await safeClick(page, "#btnA");
      await fillStepOne(page, {
        firstName: "Test",
        lastName: "Attorney",
        email: "missingstate@example.com",
        password: "Password123!",
      });
      const msg = await submitAttorneySignup(page, {
        barNumber: "12345",
        barState: "",
      });
      if (!msg.includes("Please select the state for your bar number")) {
        throw new Error(`Expected bar state message, got: ${msg}`);
      }
      await closeContext(context);
    }

    // Test: Bar number accepts valid formats for CA, NY, TX, FL.
    // Input values:
    // - CA: "CA12345"
    // - NY: "NY-98765"
    // - TX: "TX 12345"
    // - FL: "FLA9876"
    // Expected result: "Application submitted. Await approval." shown.
    const validCases = [
      { state: "CA", bar: "CA12345", email: "validca@example.com" },
      { state: "NY", bar: "NY-98765", email: "validny@example.com" },
      { state: "TX", bar: "TX 12345", email: "validtx@example.com" },
      { state: "FL", bar: "FLA9876", email: "validfl@example.com" },
    ];

    for (const testCase of validCases) {
      const context = await createContext();
      const page = await context.newPage();
      configurePage(page);
      await page.setViewport({ width: 1280, height: 720 });
      await gotoSignup(page, baseUrl);
      await safeClick(page, "#btnA");
      await fillStepOne(page, {
        firstName: "Valid",
        lastName: "Attorney",
        email: testCase.email,
        password: "Password123!",
      });
      const msg = await submitAttorneySignup(page, {
        barNumber: testCase.bar,
        barState: testCase.state,
      });
      if (!msg.includes("Application submitted")) {
        throw new Error(`Expected success message for ${testCase.state}, got: ${msg}`);
      }
      await closeContext(context);
    }

    console.log("E2E validation logic checks complete.");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
