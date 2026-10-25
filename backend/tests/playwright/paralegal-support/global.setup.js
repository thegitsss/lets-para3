const path = require("path");
const fs = require("node:fs/promises");
const { chromium, request: playwrightRequest } = require("playwright/test");
const { writeStorageStateOwnerOnly } = require("../auth-state");

const STORAGE_STATE_PATH = path.join(__dirname, "../.auth/support-paralegal.json");

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function resolveBaseURL() {
  return process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5052";
}

function resolveHarnessHeaders() {
  const secret = String(process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET || "").trim();
  return secret ? { "x-ai-control-room-e2e-secret": secret } : {};
}

async function ensureHarnessParalegal(baseURL) {
  const api = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: resolveHarnessHeaders(),
  });
  const response = await api.post("/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal");
  if (!response.ok()) {
    const body = await response.text();
    await api.dispose();
    throw new Error(`Unable to bootstrap support paralegal (${response.status()}): ${body}`);
  }
  const payload = await response.json();
  await api.dispose();
  return {
    email: String(payload?.paralegal?.email || "").trim().toLowerCase(),
    password:
      String(process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || "").trim() ||
      "ControlRoomSupport123!",
  };
}

async function loginAsParalegal({ baseURL, email, password }) {
  const browser = await chromium.launch({ headless: !truthy(process.env.PLAYWRIGHT_HEADED) });
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const authResponses = [], pageErrors = [], failedRequests = [];
  const requestStarts = new WeakMap();
  page.on("request", request => requestStarts.set(request, Date.now()));
  await page.addInitScript(() => {
    window.__loginSubmitDiagnostics = [];
    document.addEventListener("submit", event => {
      window.__loginSubmitDiagnostics.push({ form: event.target.id, prevented: event.defaultPrevented });
    });
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => failedRequests.push({ path: new URL(request.url()).pathname, failure: request.failure()?.errorText, elapsedMs: Date.now() - (requestStarts.get(request) || Date.now()) }));
  page.on("response", response => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith("/api/auth/") || pathname === "/api/csrf") authResponses.push({ path: pathname, status: response.status(), elapsedMs: Date.now() - (requestStarts.get(response.request()) || Date.now()) });
  });

  try {
    await page.goto("/login.html", { waitUntil: "domcontentloaded" });
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await Promise.all([
      page.waitForURL(/dashboard-paralegal\.html(?:[#?].*)?$/),
      page.locator("#loginForm button[type='submit']").click(),
    ]);
    await page.waitForLoadState("domcontentloaded");
    await page.locator("body").waitFor({ state: "visible" });
    const sessionResponse = await page.request.get("/api/users/me");
    const sessionPayload = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok() || String(sessionPayload?.role || "").toLowerCase() !== "paralegal") {
      throw new Error(`Support paralegal session verification failed (${sessionResponse.status()}).`);
    }

    await writeStorageStateOwnerOnly(context, STORAGE_STATE_PATH);
    if (process.env.LPC_GLOBAL_SETUP_ARTIFACTS) {
      const artifacts = process.env.LPC_GLOBAL_SETUP_ARTIFACTS;
      await fs.mkdir(artifacts, { recursive: true });
      await fs.writeFile(path.join(artifacts, "login-success.json"), JSON.stringify({ role: "paralegal", sessionVerified: true, authResponses, pageErrors, failedRequests }, null, 2));
    }
  } catch (error) {
    const artifacts = process.env.LPC_GLOBAL_SETUP_ARTIFACTS;
    if (artifacts) {
      await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: path.join(artifacts, "login-failure.png"), fullPage: true }).catch(() => {});
      await fs.writeFile(path.join(artifacts, "login-failure.json"), JSON.stringify({ path: new URL(page.url()).pathname, authResponses, pageErrors, failedRequests, form: await page.evaluate(() => ({ readyState: document.readyState, submissions: window.__loginSubmitDiagnostics || [], valid: document.querySelector("#loginForm")?.checkValidity(), button: document.querySelector("#loginForm button[type='submit']")?.textContent, emailPresent: Boolean(document.querySelector("#email")?.value), passwordPresent: Boolean(document.querySelector("#password")?.value) })), error: error.message }, null, 2));
    }
    throw error;
  } finally {
    await browser.close();
  }
}

module.exports = async () => {
  const baseURL = resolveBaseURL();
  const credentials = await ensureHarnessParalegal(baseURL);
  await loginAsParalegal({
    baseURL,
    email: credentials.email,
    password: credentials.password,
  });
};
