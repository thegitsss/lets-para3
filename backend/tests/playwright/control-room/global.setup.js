const fs = require("fs");
const path = require("path");
const { chromium, request: playwrightRequest } = require("playwright/test");

const STORAGE_STATE_PATH = path.join(__dirname, "../.auth/control-room-admin.json");

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function resolveBaseURL() {
  return process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5050";
}

function resolveHarnessHeaders() {
  const secret = String(process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET || "").trim();
  return secret ? { "x-ai-control-room-e2e-secret": secret } : {};
}

async function ensureHarnessAdmin(baseURL) {
  const api = await playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: resolveHarnessHeaders(),
  });

  const response = await api.post("/api/admin/ai-control-room/dev/e2e/bootstrap-admin");
  if (!response.ok()) {
    const body = await response.text();
    await api.dispose();
    throw new Error(`Unable to bootstrap Control Room e2e admin (${response.status()}): ${body}`);
  }

  const payload = await response.json();
  await api.dispose();

  return {
    email:
      String(process.env.CONTROL_ROOM_E2E_ADMIN_EMAIL || "").trim().toLowerCase() ||
      String(payload?.admin?.email || "").trim().toLowerCase(),
    password: String(process.env.CONTROL_ROOM_E2E_ADMIN_PASSWORD || "").trim() || "ControlRoomHarness123!",
  };
}

async function loginAsAdmin({ baseURL, email, password }) {
  const browser = await chromium.launch({ headless: !truthy(process.env.PLAYWRIGHT_HEADED) });
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  await page.goto("/login.html", { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await Promise.all([
    page.waitForURL(/admin-dashboard\.html(?:[#?].*)?$/),
    page.locator("#loginForm button[type='submit']").click(),
  ]);
  await page.waitForLoadState("networkidle");

  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });
  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}

module.exports = async () => {
  const baseURL = resolveBaseURL();
  const credentials = await ensureHarnessAdmin(baseURL);
  await loginAsAdmin({
    baseURL,
    email: credentials.email,
    password: credentials.password,
  });
};
