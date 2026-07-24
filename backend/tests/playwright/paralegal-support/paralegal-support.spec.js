const { test, expect } = require("playwright/test");

function assistantReply({
  id,
  text,
  provider = "openai_manager_paralegal",
  navigation = null,
  actions = [],
  suggestions = [],
}) {
  return {
    id,
    conversationId: "p6-paralegal-conversation",
    sender: "assistant",
    text,
    metadata: {
      kind: "assistant_reply",
      provider,
      grounded: true,
      primaryAsk: "package_6_paralegal_browser",
      responseMode: "DIRECT_ANSWER",
      navigation,
      actions,
      suggestedReplies: suggestions,
      needsEscalation: false,
      escalation: null,
    },
    createdAt: "2026-07-23T16:00:00.000Z",
  };
}

test("paralegal drawer renders a concise manager answer, one action, and working feedback", async ({ page }) => {
  const userMessage = {
    id: "p6-paralegal-user",
    conversationId: "p6-paralegal-conversation",
    sender: "user",
    text: "Where can I see completed cases?",
    metadata: { kind: "user_message" },
    createdAt: "2026-07-23T16:00:00.000Z",
  };
  const responseMessage = assistantReply({
    id: "p6-paralegal-answer",
    text: "Start by browsing open cases here. Review the case details, then submit an application for work that matches your experience.",
    navigation: {
      ctaLabel: "Completed cases",
      ctaHref: "dashboard-paralegal.html#cases-completed",
      inlineLinkText: "here",
    },
    actions: [
      { label: "Duplicate action", href: "dashboard-paralegal.html#cases-completed" },
      { label: "Extra action", href: "profile-settings.html" },
    ],
    suggestions: ["Where is my latest payout?"],
  });

  await page.route(/\/api\/support\/conversation\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, userMessage, assistantMessage: responseMessage }),
    });
  });
  await page.route(
    /\/api\/support\/conversation\/[^/]+\/messages\/p6-paralegal-answer\/feedback$/,
    async (route) => {
      const payload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          message: {
            ...responseMessage,
            metadata: {
              ...responseMessage.metadata,
              feedback: {
                rating: payload.rating,
                submittedAt: "2026-07-23T16:01:00.000Z",
              },
            },
          },
        }),
      });
    }
  );

  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  await page.locator(".support-launcher").click();
  const drawer = page.locator("#supportDrawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("[data-support-title]")).toHaveText("Paralegal Assistant");
  await expect(drawer.locator("[data-support-subtitle]")).toBeHidden();

  await drawer.locator("[data-support-textarea]").fill("Where can I see completed cases?");
  await drawer.locator("[data-support-submit]").click();

  const answer = drawer.locator(".support-message--assistant").last();
  await expect(answer.locator(".support-message-identity")).toHaveCount(0);
  await expect(answer.locator(".support-message-identity-mark")).toHaveCount(0);
  await expect(answer.locator(".support-message-bubble")).toHaveText(
    "Start by browsing open cases. Review the case details, then submit an application for work that matches your experience."
  );
  await expect(answer.locator("[data-support-inline-link]")).toHaveCount(0);
  await expect(answer.locator(".support-message-action")).toHaveCount(1);
  await expect(answer.locator(".support-message-action")).toHaveText("Duplicate action");
  await expect(answer.locator(".support-suggested-reply")).toHaveCount(1);
  await expect(answer.locator(".support-suggested-reply")).toHaveText("Where is my latest payout?");
  await expect(answer.getByRole("button", { name: "Helpful", exact: true })).toBeVisible();
  await expect(answer.getByRole("button", { name: "Not helpful", exact: true })).toBeVisible();

  await answer.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(answer.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("desktop sidebar tab collapses and restores the paralegal navigation", async ({ page }) => {
  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  const sidebarTab = page.locator(".support-sidebar-collapse-tab");
  await expect(sidebarTab).toBeVisible();
  await sidebarTab.click();
  await expect(page.locator("body")).toHaveClass(/support-sidebar-collapsed/);
  await sidebarTab.click();
  await expect(page.locator("body")).not.toHaveClass(/support-sidebar-collapsed/);
});

test("paralegal drawer renders the safe fallback without links, actions, suggestions, or review cards", async ({ page }) => {
  const fallbackMessage = assistantReply({
    id: "p6-paralegal-fallback",
    text: "I can’t verify that information right now. Please try again shortly.",
    provider: "openai_manager_paralegal_safe_fallback",
  });
  fallbackMessage.metadata.grounded = false;

  await page.route(/\/api\/support\/conversation\/[^/]+\/messages$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        userMessage: {
          id: "p6-paralegal-fallback-user",
          conversationId: "p6-paralegal-conversation",
          sender: "user",
          text: "Has it hit my bank?",
          metadata: { kind: "user_message" },
          createdAt: "2026-07-23T16:05:00.000Z",
        },
        assistantMessage: fallbackMessage,
      }),
    });
  });

  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  await page.locator(".support-launcher").click();
  const drawer = page.locator("#supportDrawer");
  await drawer.locator("[data-support-textarea]").fill("Has it hit my bank?");
  await drawer.locator("[data-support-submit]").click();

  const answer = drawer.locator(".support-message--assistant").last();
  await expect(answer.locator(".support-message-bubble")).toHaveText(
    "I can’t verify that information right now. Please try again shortly."
  );
  await expect(answer.locator("[data-support-inline-link]")).toHaveCount(0);
  await expect(answer.locator(".support-message-action")).toHaveCount(0);
  await expect(answer.locator(".support-suggested-reply")).toHaveCount(0);
  await expect(answer.locator(".support-escalation-card")).toHaveCount(0);
});
