const express = require("express");
const http = require("http");
const path = require("path");
const { clickVisible, launchPuppeteer } = require("./puppeteerBrowser");

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const frontendDir = path.join(__dirname, "../../frontend");
  app.use(express.static(frontendDir));

  app.get("/api/csrf", (_req, res) => {
    res.json({ csrfToken: "test-csrf" });
  });

  app.post("/api/auth/login", (_req, res) => {
    res.status(400).json({ msg: "Invalid credentials" });
  });

  app.post("/api/auth/register", (_req, res) => {
    res.status(400).json({ msg: "Invalid signup request" });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve));
  const { port } = server.address();
  return { server, port };
}

async function run() {
  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await launchPuppeteer({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 120_000,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(60_000);
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith(baseUrl)) return req.continue();
    if (url.startsWith("data:") || url.startsWith("about:")) return req.continue();
    return req.abort();
  });

  try {
    // UI error message: login shows server error message in toast.
    console.log("E2E error handling: login message");
    await page.goto(`${baseUrl}/login.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#email", { timeout: 15_000 });
    await page.waitForSelector("#password", { timeout: 15_000 });
    await page.type("#email", "bad@example.com");
    await page.type("#password", "WrongPassword");

    const dialogPromise = new Promise((resolve) => {
      const handler = async (dialog) => {
        const message = dialog.message();
        await dialog.dismiss();
        resolve(message);
      };
      page.once("dialog", handler);
    });

    await clickVisible(page, "button[type=submit]");

    const toastShown = await page
      .waitForFunction(
        () => {
          const el = document.getElementById("toastBanner");
          return el && el.textContent.trim().length > 0;
        },
        { timeout: 15_000 }
      )
      .then(() => true)
      .catch(() => false);

    let dialogMessage = "";
    if (!toastShown) {
      dialogMessage = await Promise.race([
        dialogPromise,
        page.waitForTimeout(15_000).then(() => ""),
      ]);
    }

    let toastText = "";
    if (toastShown) {
      toastText = await page.$eval("#toastBanner", (el) => el.textContent.trim());
    }
    const loginMsg = toastText || dialogMessage || "";
    if (!/invalid credentials|login failed|network error/i.test(loginMsg)) {
      throw new Error("Login error message did not appear");
    }

    // Form validation: signup blocks step advance on missing required fields.
    console.log("E2E error handling: signup validation");
    await page.goto(`${baseUrl}/signup.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#nextStepBtn", { timeout: 15_000 });
    await clickVisible(page, "#nextStepBtn");
    await page.waitForFunction(
      () => {
        const el = document.getElementById("msg");
        return el && el.textContent.trim().length > 0;
      },
      { timeout: 15_000 }
    );
    const msgText = await page.$eval("#msg", (el) => el.textContent.trim());
    if (!/please complete your basic account information|please fill all required fields|enter a valid email/i.test(msgText)) {
      throw new Error(`Unexpected signup validation message: ${msgText}`);
    }

    console.log("E2E error handling validation complete.");
  } catch (err) {
    console.error("❌ E2E error handling failed:", err?.message || err);
    process.exitCode = 1;
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run();
