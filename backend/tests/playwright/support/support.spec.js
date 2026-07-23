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
  await expect(drawer.locator("[data-support-title]")).toHaveText("Attorney Assistant");
  await expect(drawer.locator("[data-support-subtitle]")).toContainText(
    "Matters, billing, messages, and account help."
  );
  await expect(drawer.locator(".support-grounded-badge")).toHaveCount(0);
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
  const assistantMessage = drawer.locator(".support-message--assistant").last();
  await expect(assistantMessage).toBeVisible();
  await expect(assistantMessage.locator(".support-message-meta")).toBeVisible();
  await expect(assistantMessage.getByRole("button", { name: "Copy", exact: true })).toBeVisible();

  const feedbackResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/support\/conversation\/[^/]+\/messages\/[^/]+\/feedback$/.test(response.url()) &&
      response.ok()
  );
  await assistantMessage.getByRole("button", { name: "Helpful", exact: true }).click();
  await feedbackResponse;
  await expect(assistantMessage.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(drawer.locator("[data-support-submit]")).toBeDisabled();

  const humanContactResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/support\/conversation\/[^/]+\/messages$/.test(response.url()) &&
      response.ok()
  );
  await textarea.fill("Can I talk to a real person?");
  await drawer.locator("[data-support-submit]").click();
  const humanContactPayload = await (await humanContactResponse).json();
  expect(humanContactPayload.assistantMessage?.metadata?.primaryAsk).toBe("human_contact");
  expect(humanContactPayload.assistantMessage?.metadata?.needsEscalation).toBe(false);

  const humanContactMessage = drawer.locator(".support-message--assistant").last();
  await expect(humanContactMessage.locator(".support-message-bubble")).toContainText(
    "Our team monitors those messages closely"
  );
  await expect(humanContactMessage.locator("[data-support-inline-link]")).toHaveCount(0);
  await expect(humanContactMessage.getByRole("button", { name: "Contact Us", exact: true })).toBeVisible();
  await expect(humanContactMessage.locator(".support-escalation-card")).toHaveCount(0);
});

test("attorney drawer renders a concise manager answer, verified link, relevant suggestions, and feedback", async ({ page }) => {
  const createdAt = "2026-07-22T16:00:00.000Z";
  const userMessage = {
    id: "p6-user-message",
    conversationId: "p6-conversation",
    sender: "user",
    text: "Where is billing?",
    metadata: { kind: "user_message" },
    createdAt,
  };
  const assistantMessage = {
    id: "p6-assistant-message",
    conversationId: "p6-conversation",
    sender: "assistant",
    text: "Open Billing & Payments.",
    metadata: {
      kind: "assistant_reply",
      provider: "openai_manager",
      grounded: true,
      primaryAsk: "billing_navigation",
      responseMode: "DIRECT_ANSWER",
      navigation: {
        ctaLabel: "Billing & payments",
        ctaHref: "dashboard-attorney.html#billing",
        inlineLinkText: "Billing & Payments",
      },
      actions: [],
      suggestedReplies: ["Do I have a saved payment method?", "What have I paid?"],
      needsEscalation: false,
      escalation: null,
    },
    createdAt,
  };

  await page.route(/\/api\/support\/conversation\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, userMessage, assistantMessage }),
    });
  });
  await page.route(/\/api\/support\/conversation\/[^/]+\/messages\/p6-assistant-message\/feedback$/, async (route) => {
    const payload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        message: {
          ...assistantMessage,
          metadata: {
            ...assistantMessage.metadata,
            feedback: { rating: payload.rating, submittedAt: createdAt },
          },
        },
      }),
    });
  });

  await page.goto("/dashboard-attorney.html", { waitUntil: "domcontentloaded" });
  await page.locator(".support-launcher").click();
  const drawer = page.locator("#supportDrawer");
  const textarea = drawer.locator("[data-support-textarea]");
  await expect(textarea).toBeFocused();
  await textarea.fill("Where is billing?");
  await drawer.locator("[data-support-submit]").click();

  const response = drawer.locator(".support-message--assistant").last();
  await expect(response.locator(".support-message-bubble")).toHaveText("Open Billing & Payments.");
  const inlineLink = response.locator("[data-support-inline-link]");
  await expect(inlineLink).toHaveText("Billing & Payments");
  await expect(inlineLink).toHaveAttribute("href", /dashboard-attorney\.html#billing$/);
  await expect(response.locator(".support-suggested-reply")).toHaveText([
    "Do I have a saved payment method?",
    "What have I paid?",
  ]);
  await expect(response.locator(".support-message-action")).toHaveCount(0);
  await expect(response.locator(".support-escalation-card")).toHaveCount(0);
  await expect(response.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await expect(response.getByRole("button", { name: "Helpful", exact: true })).toBeVisible();
  await expect(response.getByRole("button", { name: "Not helpful", exact: true })).toBeVisible();

  await response.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(response.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("attorney drawer renders validation fallback without noisy actions or escalation", async ({ page }) => {
  const createdAt = "2026-07-22T16:05:00.000Z";
  await page.route(/\/api\/support\/conversation\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        userMessage: {
          id: "p6-fallback-user",
          conversationId: "p6-conversation",
          sender: "user",
          text: "How many matters have I completed?",
          metadata: { kind: "user_message" },
          createdAt,
        },
        assistantMessage: {
          id: "p6-fallback-assistant",
          conversationId: "p6-conversation",
          sender: "assistant",
          text: "I couldn’t produce a reliable answer from the verified LPC information. Please try again.",
          metadata: {
            kind: "assistant_reply",
            provider: "openai_manager_safe_fallback",
            grounded: false,
            primaryAsk: "answer_validation_failed",
            responseMode: "DIRECT_ANSWER",
            navigation: null,
            actions: [],
            suggestedReplies: [],
            needsEscalation: false,
            escalation: null,
          },
          createdAt,
        },
      }),
    });
  });

  await page.goto("/dashboard-attorney.html", { waitUntil: "domcontentloaded" });
  await page.locator(".support-launcher").click();
  const drawer = page.locator("#supportDrawer");
  await drawer.locator("[data-support-textarea]").fill("How many matters have I completed?");
  await drawer.locator("[data-support-submit]").click();

  const response = drawer.locator(".support-message--assistant").last();
  await expect(response.locator(".support-message-bubble")).toHaveText(
    "I couldn’t produce a reliable answer from the verified LPC information. Please try again."
  );
  await expect(response.locator(".support-suggested-reply")).toHaveCount(0);
  await expect(response.locator(".support-message-action")).toHaveCount(0);
  await expect(response.locator(".support-escalation-card")).toHaveCount(0);
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
