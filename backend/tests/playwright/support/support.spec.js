const { test, expect } = require("playwright/test");

function resolveBaseURL() {
  return process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5050";
}

function resolveHarnessHeaders() {
  const secret = String(process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET || "").trim();
  return secret ? { "x-ai-control-room-e2e-secret": secret } : {};
}

function resolveSupportAttorneyCredentials(payload = {}) {
  const email = String(payload?.attorney?.email || payload?.credentials?.email || "").trim().toLowerCase();
  const password = String(process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_PASSWORD || "").trim() || "ControlRoomSupport123!";
  return { email, password };
}

test("attorney can open the support drawer and send a support message", async ({ page }) => {
  await page.goto("/dashboard-attorney.html", { waitUntil: "domcontentloaded" });

  const launcher = page.locator(".support-launcher");
  await expect(launcher).toBeVisible();

  const conversationReady = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /\/api\/support\/conversation(?:\?|$)/.test(response.url()) &&
      response.ok()
  );

  await launcher.click();
  await conversationReady;

  const drawer = page.locator("#supportDrawer");
  const textarea = drawer.locator("[data-support-textarea]");
  await expect(drawer).toBeVisible();
  await expect(textarea).toBeFocused();
  await expect(drawer.locator("[data-support-subtitle]")).toContainText(
    "Ask a question or describe what's happening. You'll get help right here."
  );
  await expect(drawer.locator("[data-support-composer-hint]")).toHaveCount(0);
  await expect(drawer.locator(".support-quick-prompt")).toHaveText([
    "Where is Billing & Payments?",
    "Where can I see my cases?",
    "I can't send messages",
    "I need help with a case",
  ]);
  await expect(drawer.locator(".support-composer-prompt-text")).toContainText("Ask about");
  await expect(textarea).not.toHaveAttribute("placeholder", /.+/);

  const postMessage = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/support\/conversation\/[^/]+\/messages$/.test(response.url()) &&
      response.ok()
  );

  await textarea.fill("where can i browse paralegals");
  await expect(drawer.locator("[data-support-composer-prompt]")).toHaveClass(/is-hidden/);
  await drawer.locator("[data-support-submit]").click();

  const messageResponse = await postMessage;
  const payload = await messageResponse.json();
  expect(payload.ok).toBe(true);
  expect(String(payload.userMessage?.text || "")).toContain("where can i browse paralegals");
  expect(String(payload.assistantMessage?.text || "")).not.toEqual("");

  await expect(drawer.locator(".support-message--user").last()).toContainText("where can i browse paralegals");
  await expect(drawer.locator(".support-message--assistant").last()).toBeVisible();
  await expect(drawer.locator("[data-support-submit]")).toBeDisabled();
});

test("approved attorney first login lands on a guided dashboard experience", async ({ browser, request }) => {
  const bootstrap = await request.post(
    `${resolveBaseURL()}/api/admin/ai-control-room/dev/e2e/bootstrap-attorney?freshApproval=true`,
    {
      headers: resolveHarnessHeaders(),
    }
  );
  expect(bootstrap.ok()).toBeTruthy();
  const bootstrapPayload = await bootstrap.json();
  const { email, password } = resolveSupportAttorneyCredentials(bootstrapPayload);
  expect(email).toBeTruthy();
  expect(bootstrapPayload?.attorney?.lastLoginAt).toBeFalsy();

  const context = await browser.newContext({
    baseURL: resolveBaseURL(),
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();

  await page.goto("/login.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#loginForm")).toBeVisible();
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await Promise.all([
    page.waitForURL(/dashboard-attorney\.html(?:[#?].*)?$/),
    page.locator("#loginForm button[type='submit']").click(),
  ]);

  await expect(page.locator("[data-attorney-header]")).toBeVisible();
  await expect(page.locator("#attorneyTourModal")).toBeVisible();
  await expect(page.locator("#attorneyTourTitle")).toContainText("Welcome to Let’s-ParaConnect");
  await expect(page.locator("#attorneyTourText")).toContainText("quick walkthrough");
  await expect(page.locator("#attorneyOnboardingAttentionCard")).toBeVisible();
  await expect(page.locator("[data-onboarding-attention-title]")).toContainText("Finish your profile");
  await expect(page.locator("[data-onboarding-attention-text]")).toContainText(
    "Add your profile details so everything is ready before you post your first case."
  );

  await context.close();
});
