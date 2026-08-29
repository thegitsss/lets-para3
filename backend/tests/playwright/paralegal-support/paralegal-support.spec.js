const { test, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const { SUPPORTED_VIEWPORTS } = require("../../../playwright.browser-matrix");

function resolveHarnessHeaders() {
  const secret = String(process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET || "").trim();
  return secret ? { "x-ai-control-room-e2e-secret": secret } : {};
}

async function expectNoHorizontalOverflow(page) {
  const layout = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.contentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
}

test("paralegal dashboard renders a complete, usable desktop and mobile home state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });

  await expect(page.locator("#user-name-heading")).toHaveText(/\S+/);
  await expect(page.locator(".summary .skeleton-line")).toHaveCount(0);
  await expect(page.locator(".case-panels .skeleton-card")).toHaveCount(0);
  await expect(page.locator("[data-paralegal-priority-count]")).not.toHaveText("Loading…");
  await expect(page.locator("[data-paralegal-priority-list]")).not.toContainText("Checking your workspace");
  await expect(page.locator("[data-paralegal-priority-list] .lpc-priority-item").first()).toBeVisible();
  await expect(page.locator("#messageBox")).toBeDisabled();
  await expect(page.locator("#messageLabel")).toHaveText("No unread messages");
  for (const metric of await page.locator(".summary .info-value").allTextContents()) {
    expect(metric.trim()).not.toEqual("");
  }
  await expect.poll(() => page.locator(".sidebar-profile-cluster img").evaluate((image) => ({
    complete: image.complete,
    naturalWidth: image.naturalWidth,
  }))).toEqual({ complete: true, naturalWidth: 220 });
  const availabilityButton = page.getByRole("button", { name: "Update availability" });
  await availabilityButton.click();
  await expect(page.locator("#availabilityModal")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#availabilityStatusInput")).toBeFocused();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await page.locator("#availabilityStatusInput").selectOption("unavailable");
  await page.locator("#availabilityDateInput").fill(futureDate);
  await page.locator("#saveAvailabilityBtn").click();
  await expect(page.locator("#availabilityModal")).toHaveAttribute("aria-hidden", "true");
  await expect(availabilityButton).toBeFocused();
  await availabilityButton.click();
  await expect(page.locator("#availabilityStatusInput")).toHaveValue("unavailable");
  await expect(page.locator("#availabilityDateInput")).toHaveValue(futureDate);
  await expect(page.locator("#availabilityCurrentSummary")).toContainText("Available on");
  await page.locator("#availabilityStatusInput").selectOption("available");
  await page.locator("#saveAvailabilityBtn").click();
  await expect(page.locator("#availabilityModal")).toHaveAttribute("aria-hidden", "true");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "/tmp/lpc-paralegal-dashboard-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const sidebarToggle = page.locator("#sidebarToggle");
  await expect(sidebarToggle).toBeVisible();
  const toggleBox = await sidebarToggle.boundingBox();
  expect(toggleBox?.width).toBeGreaterThanOrEqual(44);
  expect(toggleBox?.height).toBeGreaterThanOrEqual(44);
  const mobileMetrics = await page.evaluate(() => {
    const summary = document.querySelector(".summary");
    const card = document.querySelector(".summary .info-box");
    return {
      columns: summary ? getComputedStyle(summary).gridTemplateColumns.split(" ").length : 0,
      cardHeight: card?.getBoundingClientRect().height || 0,
      priorityTop: document.querySelector("#paralegalPriorityQueue")?.getBoundingClientRect().top || 0,
      earningsToggleWidth: document.querySelector("#earningsToggle")?.getBoundingClientRect().width || 0,
      earningsToggleHeight: document.querySelector("#earningsToggle")?.getBoundingClientRect().height || 0,
    };
  });
  expect(mobileMetrics.columns).toBe(2);
  expect(mobileMetrics.cardHeight).toBeLessThanOrEqual(140);
  expect(mobileMetrics.priorityTop).toBeLessThanOrEqual(700);
  expect(mobileMetrics.earningsToggleWidth).toBeGreaterThanOrEqual(44);
  expect(mobileMetrics.earningsToggleHeight).toBeGreaterThanOrEqual(44);
  await expect(page.locator("#sidebarNav")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#sidebarNav")).toHaveAttribute("inert", "");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "/tmp/lpc-paralegal-dashboard-mobile.png", fullPage: true });

  await sidebarToggle.click();
  await expect(page.locator("body")).toHaveClass(/nav-open/);
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#sidebarNav")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#sidebarNav")).not.toHaveAttribute("inert", "");
  await expect(page.locator('#sidebarNav [aria-label="Open profile menu"]')).toBeFocused();
  await page.screenshot({ path: "/tmp/lpc-paralegal-dashboard-mobile-menu.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/nav-open/);
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
  await expect(sidebarToggle).toBeFocused();
});

test("paralegal dashboard has no automated WCAG A/AA violations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("main#main")).toBeVisible();
  await page.waitForTimeout(100);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), null, 2)).toEqual([]);
  const launcher = page.locator(".support-launcher");
  await launcher.click();
  const drawer = page.locator("#supportDrawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("[data-support-textarea]")).toBeFocused();
  const drawerResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(drawerResults.violations, JSON.stringify(drawerResults.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), null, 2)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveAttribute("aria-hidden", "true");
  await expect(launcher).toBeFocused();
});

test("paralegal critical product surfaces render accessibly without overflow or runtime failures", async ({ page }) => {
  const pageErrors = [];
  const serverFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const surfaces = [
    { url: "/browse-jobs.html", heading: "Browse matters" },
    { url: "/paralegalhelp.html", heading: "Help for Paralegals" },
    { url: "/profile-settings.html", heading: "Account Settings" },
    { url: "/dashboard-paralegal.html#cases", heading: "My Matters & Applications" },
  ];

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const surface of surfaces) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(surface.url, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/login\.html/);
    await expect(page.locator("main#main")).toBeVisible();
    await expect(page.getByRole("heading", { name: surface.heading, exact: true }).first()).toBeVisible();
    await page.waitForTimeout(200);
    await expectNoHorizontalOverflow(page);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
      .analyze();
    expect(
      results.violations,
      `${surface.url}: ${JSON.stringify(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), null, 2)}`
    ).toEqual([]);

    for (const viewport of SUPPORTED_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expect(page.locator("main#main"), `${surface.url} at ${viewport.name}`).toBeVisible();
      await expect(
        page.getByRole("heading", { name: surface.heading, exact: true }).first(),
        `${surface.url} heading at ${viewport.name}`
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  }

  expect(pageErrors).toEqual([]);
  expect(serverFailures).toEqual([]);
});

test("legacy paralegal workflow URLs preserve context and converge on the canonical dashboard", async ({ page }) => {
  const objectId = "64f000000000000000000004";
  const redirects = [
    {
      from: `/paralegal-applications.html?applicationId=${objectId}`,
      parameter: "applicationId",
      hash: "#cases",
      view: "cases",
    },
    {
      from: `/paralegal-assigned.html?highlightCase=${objectId}`,
      parameter: "highlightCase",
      hash: "#cases",
      view: "cases",
    },
    {
      from: `/paralegal-invitations.html?inviteCase=${objectId}`,
      parameter: "inviteCase",
      hash: "",
      view: "home",
    },
  ];

  for (const redirect of redirects) {
    const canonicalRequests = [];
    const recordNavigationRequest = (request) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      const url = new URL(request.url());
      if (url.pathname.endsWith("/dashboard-paralegal.html")) canonicalRequests.push(url);
    };
    page.on("request", recordNavigationRequest);
    await page.goto(redirect.from, { waitUntil: "domcontentloaded" });
    await page.waitForURL(
      (url) => url.pathname.endsWith("/dashboard-paralegal.html"),
      { waitUntil: "domcontentloaded" }
    );
    page.off("request", recordNavigationRequest);
    const redirectedTarget = canonicalRequests[0];
    expect(new URL(page.url()).hash).toBe(redirect.hash);
    expect(redirectedTarget?.searchParams.get(redirect.parameter)).toBe(objectId);
    await expect(page.locator("main#main")).toBeVisible();
    await expect(page.locator(redirect.view === "cases" ? "#paralegalCasesView" : "#paralegalHomeView")).toHaveClass(/is-active/);
  }
});

test("paralegal accepts a Matter invitation through the real dashboard action", async ({ page }) => {
  const bootstrap = await page.request.post(
    "/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal?seedInvitation=true&resetMatter=true",
    { headers: resolveHarnessHeaders() }
  );
  expect(bootstrap.ok(), await bootstrap.text()).toBe(true);
  const fixture = await bootstrap.json();
  const matterId = String(fixture?.matter?.id || "");
  expect(matterId).toMatch(/^[a-f0-9]{24}$/);
  expect(fixture?.invitation).toEqual({ sent: true, alreadyPending: false });

  const pageErrors = [];
  const serverFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  await page.goto(`/dashboard-paralegal.html?inviteCase=${matterId}#home`, {
    waitUntil: "domcontentloaded",
  });
  const inviteOverlay = page.locator("#inviteOverlay");
  await expect(inviteOverlay).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#inviteCaseTitle")).toHaveText("You've been invited to a Matter");
  await expect(page.locator("#inviteJobTitle")).toHaveText("Harness Contract Review");
  await expect(page.locator("#inviteDetails")).toContainText("Review a commercial services agreement");
  const acceptButton = page.getByRole("button", { name: "Accept Invitation", exact: true });
  await expect(acceptButton).toBeEnabled();
  await expect(acceptButton).toBeFocused();

  const acceptResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === `/api/cases/${matterId}/invite/accept`;
  });
  await acceptButton.click();
  const acceptResponse = await acceptResponsePromise;
  expect(acceptResponse.ok(), await acceptResponse.text()).toBe(true);
  expect(await acceptResponse.json()).toEqual({
    success: true,
    alreadyProcessed: false,
    reconciliationPending: false,
  });

  await expect(page.locator("#toastBanner")).toHaveText("Invitation accepted.");
  await expect(page.locator("#inviteCaseTitle")).toHaveText("Await attorney action");
  await expect(page.locator("#inviteLead")).toHaveText(
    "You accepted this invitation. The attorney must confirm hire and fund the Matter next."
  );
  await expect(page.getByRole("button", { name: "Accepted", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Revoke application", exact: true })).toBeFocused();

  const pendingInvitesResponse = await page.request.get("/api/cases/invited-to");
  expect(pendingInvitesResponse.ok(), await pendingInvitesResponse.text()).toBe(true);
  const pendingInvites = await pendingInvitesResponse.json();
  expect((pendingInvites?.items || []).some((item) => String(item?.id || item?._id || "") === matterId)).toBe(false);

  const applicationsResponse = await page.request.get("/api/applications/my");
  expect(applicationsResponse.ok(), await applicationsResponse.text()).toBe(true);
  const applications = await applicationsResponse.json();
  const acceptedApplication = applications.find((application) => String(application?.caseId || "") === matterId);
  expect(acceptedApplication).toMatchObject({
    status: "submitted",
    coverLetter: "Accepted invitation",
    applicationSource: "invite_accept",
  });
  expect(acceptedApplication?.jobId?.title).toBe("Harness Contract Review");
  expect(pageErrors).toEqual([]);
  expect(serverFailures).toEqual([]);
});

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

test("paralegal drawer renders a concise manager answer, one action, and working feedback", async ({ page, browserName }) => {
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
  await page.screenshot({ path: `/tmp/lpc-paralegal-assistant-${browserName}.png`, fullPage: true });

  await answer.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(answer.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("desktop sidebar grip collapses and restores the paralegal navigation", async ({ page }) => {
  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  const sidebarGrip = page.locator(".lpc-sidebar-grip");
  await expect(sidebarGrip).toBeVisible();
  await sidebarGrip.click();
  await expect(page.locator("body")).toHaveClass(/nav-collapsed/);
  await expect(sidebarGrip).toHaveAttribute("aria-label", "Expand sidebar");
  await sidebarGrip.click();
  await expect(page.locator("body")).not.toHaveClass(/nav-collapsed/);
  await expect(sidebarGrip).toHaveAttribute("aria-label", "Collapse sidebar");
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
