const { test, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const { SUPPORTED_VIEWPORTS } = require("../../../playwright.browser-matrix");

function resolveBaseURL() {
  return process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5051";
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

async function expectNoHorizontalOverflow(page) {
  const layout = await page.evaluate(() => {
    const describe = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
          element.classList?.length ? `.${Array.from(element.classList).slice(0, 3).join(".")}` : ""
        }`,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        display: style.display,
        minWidth: style.minWidth,
        overflowX: style.overflowX,
      };
    };

    return {
      viewportWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
      roots: [document.documentElement, document.body, document.querySelector(".case-shell"), document.querySelector(".case-main")]
        .filter(Boolean)
        .map(describe),
      offenders: Array.from(document.querySelectorAll("body *"))
      .map((element) => {
        return describe(element);
      })
      .filter((item) => item.right > document.documentElement.clientWidth + 1 || item.left < -1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 12),
    };
  });
  expect(
    layout.contentWidth,
    `Horizontal overflow: ${JSON.stringify({ roots: layout.roots, offenders: layout.offenders }, null, 2)}`
  ).toBeLessThanOrEqual(layout.viewportWidth + 1);
}

test("attorney dashboard renders a complete, usable desktop and mobile home state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dashboard-attorney.html", { waitUntil: "domcontentloaded" });

  await expect(page.locator("#user-name-heading")).toHaveText(/\S+/);
  await expect(page.locator("[data-attorney-header] .header-skeleton")).toHaveCount(0);
  await expect(page.locator("#attorneyNeedsAttentionList")).not.toContainText("Checking your dashboard");
  await expect(page.locator("#caseCards .skeleton-row")).toHaveCount(0);
  await expect(page.locator("#weeklyNotesGrid")).not.toContainText("Loading…");
  await expect(
    page.locator(
      "#attorneyNeedsAttention:not([hidden]) .queue-item, #attorneyOnboardingAttentionCard:not([hidden])"
    ).first()
  ).toBeVisible();
  await expect(page.locator("#caseCards")).not.toBeEmpty();
  const onboardingAction = page.locator("[data-onboarding-attention-action]");
  await expect(onboardingAction).toBeVisible();
  await expect(onboardingAction).toHaveText("Open payments");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "/tmp/lpc-attorney-dashboard-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const sidebarToggle = page.locator("#sidebarToggle");
  await expect(sidebarToggle).toBeVisible();
  const toggleBox = await sidebarToggle.boundingBox();
  expect(toggleBox?.width).toBeGreaterThanOrEqual(44);
  expect(toggleBox?.height).toBeGreaterThanOrEqual(44);
  const weeklyNotesLayout = await page.evaluate(() => {
    const grid = document.querySelector("#weeklyNotesGrid");
    const card = grid?.querySelector(".weekly-note-day");
    const toggle = document.querySelector("#weeklyNotesToggle");
    return {
      gridWidth: grid?.clientWidth || 0,
      gridScrollWidth: grid?.scrollWidth || 0,
      cardWidth: card?.getBoundingClientRect().width || 0,
      toggleHeight: toggle?.getBoundingClientRect().height || 0,
    };
  });
  expect(weeklyNotesLayout.cardWidth).toBeGreaterThanOrEqual(132);
  expect(weeklyNotesLayout.gridScrollWidth).toBeGreaterThan(weeklyNotesLayout.gridWidth);
  expect(weeklyNotesLayout.toggleHeight).toBeGreaterThanOrEqual(44);
  await expect(page.locator("#sidebarNav")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#sidebarNav")).toHaveAttribute("inert", "");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "/tmp/lpc-attorney-dashboard-mobile.png", fullPage: true });

  await sidebarToggle.click();
  await expect(page.locator("body")).toHaveClass(/nav-open/);
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#sidebarNav")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#sidebarNav")).not.toHaveAttribute("inert", "");
  await expect(page.locator('#sidebarNav [aria-label="Open profile menu"]')).toBeFocused();
  await page.screenshot({ path: "/tmp/lpc-attorney-dashboard-mobile-menu.png", fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.locator("body")).not.toHaveClass(/nav-open/);
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
  await expect(sidebarToggle).toBeFocused();
  await Promise.all([
    page.waitForURL(/profile-settings\.html\?onboardingStep=payment$/),
    onboardingAction.click(),
  ]);
});

test("attorney dashboard and settings have no automated WCAG A/AA violations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const url of ["/dashboard-attorney.html", "/profile-settings.html"]) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(page.locator("main#main")).toBeVisible();
    await page.waitForTimeout(100);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
      .analyze();
    expect(results.violations, `${url}: ${JSON.stringify(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), null, 2)}`).toEqual([]);
    if (url === "/dashboard-attorney.html") {
      const launcher = page.locator(".support-launcher");
      await launcher.click();
      const drawer = page.locator("#supportDrawer");
      await expect(drawer).toBeVisible();
      await expect(drawer.locator("[data-support-textarea]")).toBeFocused();
      const drawerResults = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
        .analyze();
      expect(drawerResults.violations, `open attorney assistant: ${JSON.stringify(drawerResults.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), null, 2)}`).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveAttribute("aria-hidden", "true");
      await expect(launcher).toBeFocused();
    }
  }
});

test("attorney critical product surfaces render accessibly without overflow or runtime failures", async ({ page }) => {
  const pageErrors = [];
  const serverFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const surfaces = [
    { url: "/create-case.html", heading: "Create a New Matter" },
    { url: "/browse-paralegals.html", heading: "Browse Paralegals" },
    { url: "/help.html", heading: "Help for Attorneys" },
    { url: "/profile-settings.html", heading: "Account Settings" },
    { url: "/dashboard-attorney.html#funds", heading: "Payments" },
  ];

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const surface of surfaces) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(surface.url, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/login\.html|legal-acceptance\.html/);
    await expect(page.locator("main#main")).toBeVisible();
    await expect(page.getByRole("heading", { name: surface.heading, exact: true }).first()).toBeVisible();
    await page.waitForTimeout(200);
    if (surface.url.startsWith("/profile-paralegal.html")) {
      const inviteButton = page.getByRole("button", { name: "Invite to Matter", exact: true });
      await expect(inviteButton).toBeVisible();
      const inviteBox = await inviteButton.boundingBox();
      expect(inviteBox?.height).toBeGreaterThanOrEqual(44);
      await inviteButton.click();
      const inviteDialog = page.getByRole("dialog", { name: "Invite to Matter", exact: true });
      await expect(inviteDialog).toBeVisible();
      await expect(inviteDialog.locator("#inviteCaseSelect")).toContainText("Harness Contract Review");
      await inviteDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(inviteDialog).toBeHidden();
    }
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

test("Matter and public profile detail surfaces render real records accessibly", async ({ page }) => {
  const attorneyBootstrap = await page.request.post(
    "/api/admin/ai-control-room/dev/e2e/bootstrap-attorney?seedMatter=true",
    { headers: resolveHarnessHeaders() }
  );
  expect(attorneyBootstrap.ok(), await attorneyBootstrap.text()).toBe(true);
  const attorneyPayload = await attorneyBootstrap.json();
  const paralegalBootstrap = await page.request.post(
    "/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal",
    { headers: resolveHarnessHeaders() }
  );
  expect(paralegalBootstrap.ok(), await paralegalBootstrap.text()).toBe(true);
  const paralegalPayload = await paralegalBootstrap.json();

  const matterId = String(attorneyPayload?.matter?.id || "");
  const attorneyId = String(attorneyPayload?.attorney?.id || "");
  const paralegalId = String(paralegalPayload?.paralegal?.id || "");
  expect(matterId).toMatch(/^[a-f0-9]{24}$/);
  expect(attorneyId).toMatch(/^[a-f0-9]{24}$/);
  expect(paralegalId).toMatch(/^[a-f0-9]{24}$/);

  const pageErrors = [];
  const serverFailures = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const surfaces = [
    {
      url: `/case-detail.html?caseId=${matterId}`,
      heading: "Harness Contract Review",
    },
    {
      url: `/profile-attorney.html?id=${attorneyId}`,
      heading: "Avery Harness",
    },
    {
      url: `/profile-paralegal.html?paralegalId=${paralegalId}`,
      heading: "Parker Harness",
    },
  ];

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const surface of surfaces) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(surface.url, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/login\.html|legal-acceptance\.html/);
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

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
  }

  expect(pageErrors).toEqual([]);
  expect(serverFailures).toEqual([]);
});

test("attorney sends a Matter invitation through the real profile action", async ({ page }) => {
  const attorneyBootstrap = await page.request.post(
    "/api/admin/ai-control-room/dev/e2e/bootstrap-attorney?seedMatter=true&resetMatter=true",
    { headers: resolveHarnessHeaders() }
  );
  expect(attorneyBootstrap.ok(), await attorneyBootstrap.text()).toBe(true);
  const attorneyPayload = await attorneyBootstrap.json();
  const paralegalBootstrap = await page.request.post(
    "/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal",
    { headers: resolveHarnessHeaders() }
  );
  expect(paralegalBootstrap.ok(), await paralegalBootstrap.text()).toBe(true);
  const paralegalPayload = await paralegalBootstrap.json();
  const matterId = String(attorneyPayload?.matter?.id || "");
  const paralegalId = String(paralegalPayload?.paralegal?.id || "");
  expect(matterId).toMatch(/^[a-f0-9]{24}$/);
  expect(paralegalId).toMatch(/^[a-f0-9]{24}$/);

  await page.goto(`/profile-paralegal.html?paralegalId=${paralegalId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: "Parker Harness", exact: true }).first()).toBeVisible();
  const inviteButton = page.getByRole("button", { name: "Invite to Matter", exact: true });
  await expect(inviteButton).toBeVisible();
  await inviteButton.click();

  const inviteDialog = page.getByRole("dialog", { name: "Invite to Matter", exact: true });
  await expect(inviteDialog).toBeVisible();
  await inviteDialog.locator("#inviteCaseSelect").selectOption(matterId);
  const inviteResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === `/api/cases/${matterId}/invite`;
  });
  await inviteDialog.getByRole("button", { name: "Send Invite", exact: true }).click();
  const inviteResponse = await inviteResponsePromise;
  expect(inviteResponse.ok(), await inviteResponse.text()).toBe(true);
  await expect(inviteDialog).toBeHidden();
  await expect(page.locator("#toastBanner")).toHaveText("Invite sent.");
  await expect(inviteButton).toBeFocused();

  const matterResponse = await page.request.get(`/api/cases/${matterId}`);
  expect(matterResponse.ok(), await matterResponse.text()).toBe(true);
  const matter = await matterResponse.json();
  const pendingInvite = (matter?.matterExperience?.applications?.items || []).find(
    (invite) => String(invite?.id || "") === paralegalId
  );
  expect(pendingInvite?.status).toBe("invited");
});

test("Stripe Checkout returns preserve Matter context and explain success or cancellation", async ({ page }) => {
  const caseId = "64f000000000000000000001";
  await page.goto(`/billing-attorney.html?checkout=success&caseId=${caseId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForURL((url) => url.pathname.endsWith("/dashboard-attorney.html") && url.hash === "#funds");
  await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
  await expect(page.locator("#toastBanner")).toHaveText(
    "Payment submitted. Funding status will update after Stripe confirms it."
  );
  expect(new URL(page.url()).searchParams.has("payment")).toBe(false);
  expect(new URL(page.url()).searchParams.has("caseId")).toBe(false);

  await page.goto(`/dashboard-attorney.html?payment=cancel&caseId=${caseId}#funds`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
  await expect(page.locator("#toastBanner")).toHaveText(
    "Payment was not completed. No payment was processed."
  );
  expect(new URL(page.url()).searchParams.has("payment")).toBe(false);
  expect(new URL(page.url()).searchParams.has("caseId")).toBe(false);
});

test("legacy candidate review URL preserves Matter context and opens canonical inquiries", async ({ page }) => {
  const caseId = "64f000000000000000000001";
  const canonicalNavigations = [];
  const recordNavigation = (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = new URL(frame.url());
    if (url.pathname.endsWith("/dashboard-attorney.html")) canonicalNavigations.push(url);
  };

  page.on("framenavigated", recordNavigation);
  await page.goto(`/case-applications.html?caseId=${caseId}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(
    (url) => url.pathname.endsWith("/dashboard-attorney.html"),
    { waitUntil: "domcontentloaded" }
  );
  page.off("framenavigated", recordNavigation);

  const redirectedTarget = canonicalNavigations[0];
  expect(redirectedTarget?.hash).toBe("#cases:inquiries");
  expect(redirectedTarget?.searchParams.get("openApplicants")).toBe("1");
  expect(redirectedTarget?.searchParams.get("caseId")).toBe(caseId);
  await expect(page.locator("main#main")).toBeVisible();
});

test("legacy attorney Matter URLs preserve context and converge on canonical workflows", async ({ page }) => {
  const caseId = "64f000000000000000000001";
  const draftId = "draft-launch-contract";
  const redirects = [
    {
      from: `/active-cases.html?caseId=${caseId}`,
      pathname: "/dashboard-attorney.html",
      hash: "#cases",
      parameters: { caseId },
    },
    {
      from: `/create-case-step2.html?draftId=${draftId}&caseId=${caseId}`,
      pathname: "/create-case.html",
      hash: "#description",
      parameters: { draftId, caseId },
    },
    {
      from: `/create-case-step5.html?draftId=${draftId}&caseId=${caseId}`,
      pathname: "/create-case.html",
      hash: "#review",
      parameters: { draftId, caseId },
    },
  ];

  for (const redirect of redirects) {
    const canonicalNavigations = [];
    const recordNavigation = (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = new URL(frame.url());
      if (url.pathname === redirect.pathname) canonicalNavigations.push(url);
    };
    page.on("framenavigated", recordNavigation);
    await page.goto(redirect.from, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname === redirect.pathname, {
      waitUntil: "domcontentloaded",
    });
    page.off("framenavigated", recordNavigation);

    const redirectedTarget = canonicalNavigations[0];
    expect(redirectedTarget?.hash).toBe(redirect.hash);
    for (const [name, value] of Object.entries(redirect.parameters)) {
      expect(redirectedTarget?.searchParams.get(name)).toBe(value);
    }
    await expect(page.locator("main#main")).toBeVisible();
  }
});

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
  await expect(drawer.locator("[data-support-subtitle]")).toBeHidden();
  await expect(drawer).toHaveAttribute("data-support-role", "attorney");
  await expect(drawer.locator(".support-grounded-badge")).toHaveCount(0);
  await expect(drawer.locator("[data-support-composer-hint]")).toHaveCount(0);
  const pinButton = drawer.locator("[data-support-pin]");
  await expect(pinButton).toHaveAttribute("aria-pressed", "false");
  await pinButton.click();
  await expect(pinButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("body")).toHaveClass(/support-drawer-pinned/);
  await expect(drawer).toHaveAttribute("aria-modal", "false");
  await expect(page.locator("[data-support-backdrop]")).toBeHidden();
  await page.waitForTimeout(350);
  const dockLayout = await page.evaluate(() => {
    const main = document.querySelector("main.main, main");
    const drawer = document.querySelector("#supportDrawer");
    if (!main || !drawer) return null;
    const mainBounds = main.getBoundingClientRect();
    const drawerBounds = drawer.getBoundingClientRect();
    return { mainRight: mainBounds.right, drawerLeft: drawerBounds.left };
  });
  expect(dockLayout).not.toBeNull();
  expect(dockLayout.mainRight).toBeLessThanOrEqual(dockLayout.drawerLeft + 1);
  await pinButton.click();
  await expect(pinButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("body")).not.toHaveClass(/support-drawer-pinned/);
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  await expect(drawer.locator(".support-quick-prompt")).toHaveText([
    "Where are Payments?",
    "Where can I see my Matters?",
    "I can't send messages",
    "I need help with a Matter",
  ]);
  await expect(drawer.locator(".support-composer-prompt-text")).toContainText("Ask about");
  await expect(textarea).not.toHaveAttribute("placeholder", /.+/);
  const composerAlignment = await drawer.evaluate((element) => {
    const textarea = element.querySelector("[data-support-textarea]");
    const prompt = element.querySelector("[data-support-composer-prompt]");
    if (!textarea || !prompt) return null;
    const textareaBounds = textarea.getBoundingClientRect();
    const promptBounds = prompt.getBoundingClientRect();
    const textareaStyles = getComputedStyle(textarea);
    return {
      textX: textareaBounds.left + parseFloat(textareaStyles.paddingLeft || "0"),
      textY: textareaBounds.top + parseFloat(textareaStyles.paddingTop || "0"),
      promptX: promptBounds.left,
      promptY: promptBounds.top,
    };
  });
  expect(composerAlignment).not.toBeNull();
  expect(Math.abs(composerAlignment.textX - composerAlignment.promptX)).toBeLessThanOrEqual(1);
  expect(Math.abs(composerAlignment.textY - composerAlignment.promptY)).toBeLessThanOrEqual(1);

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
  await expect(assistantMessage.locator(".support-message-identity")).toHaveCount(0);
  await expect(assistantMessage.locator(".support-message-identity-mark")).toHaveCount(0);
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

test("attorney can create, complete, and delete a private planning task", async ({ page }) => {
  const title = `Launch readiness task ${Date.now()}`;
  await page.goto("/dashboard-attorney.html#tasks", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByText("Matter-linked tasks here do not change the agreed work scope.")).toBeVisible();
  const tasksAudit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(tasksAudit.violations, JSON.stringify(tasksAudit.violations, null, 2)).toEqual([]);

  await page.getByRole("button", { name: "New task" }).click();
  const createDialog = page.getByRole("dialog", { name: "New task" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByLabel("Task", { exact: true })).toBeFocused();
  await createDialog.getByLabel("Task", { exact: true }).fill(title);
  await createDialog.getByLabel(/^Notes/).fill("Verify the exact launch candidate evidence.");

  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/api\/checklist$/.test(response.url()) && response.status() === 201
  );
  await createDialog.getByRole("button", { name: "Create task" }).click();
  await created;

  const taskCard = page.getByRole("button", { name: `Open task: ${title}` });
  await expect(taskCard).toBeVisible();
  await taskCard.click();
  const detailDialog = page.getByRole("dialog", { name: title });
  await expect(detailDialog).toBeVisible();

  const toggled = page.waitForResponse((response) =>
    response.request().method() === "POST" && /\/api\/checklist\/[^/]+\/toggle$/.test(response.url()) && response.ok()
  );
  await detailDialog.getByRole("button", { name: "Mark Complete" }).click();
  await toggled;

  const completedColumn = page.locator(".task-column").filter({
    has: page.getByRole("heading", { name: "Completed", exact: true }),
  });
  await expect(completedColumn.getByRole("button", { name: `Open task: ${title}` })).toBeVisible();
  await completedColumn.getByRole("button", { name: `Open task: ${title}` }).click();
  await expect(detailDialog).toBeVisible();

  await detailDialog.getByRole("button", { name: "Delete task" }).click();
  const deleted = page.waitForResponse((response) =>
    response.request().method() === "DELETE" && /\/api\/checklist\/[^/?]+(?:\?|$)/.test(response.url()) && response.ok()
  );
  await detailDialog.getByRole("button", { name: "Confirm delete" }).click();
  await deleted;
  await expect(page.getByRole("button", { name: `Open task: ${title}` })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({
    columns: getComputedStyle(document.querySelector("#taskColumns")).gridTemplateColumns.split(" ").length,
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  expect(mobileLayout.columns).toBe(1);
  expect(mobileLayout.contentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth + 1);
});

test("desktop sidebar grip collapses and restores the attorney navigation", async ({ page }) => {
  await page.goto("/dashboard-attorney.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveClass(/sidebar-layout-ready/);
  await expect(page.locator("#sidebarNav")).toBeVisible();
  const sidebarGrip = page.locator(".lpc-sidebar-grip");
  await expect(sidebarGrip).toBeVisible();
  const gripBox = await sidebarGrip.boundingBox();
  expect(gripBox?.width).toBeGreaterThanOrEqual(24);
  expect(gripBox?.height).toBeGreaterThanOrEqual(24);
  await sidebarGrip.click();
  await expect(page.locator("body")).toHaveClass(/nav-collapsed/);
  await expect(sidebarGrip).toHaveAttribute("aria-label", "Expand sidebar");
  await sidebarGrip.click();
  await expect(page.locator("body")).not.toHaveClass(/nav-collapsed/);
  await expect(sidebarGrip).toHaveAttribute("aria-label", "Collapse sidebar");

  await page.setViewportSize({ width: 900, height: 720 });
  await expect(sidebarGrip).toBeHidden();
  const sidebarToggle = page.locator("#sidebarToggle");
  await expect(sidebarToggle).toBeVisible();
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
  await sidebarToggle.click();
  await expect(page.locator("body")).toHaveClass(/nav-open/);
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
});

test("profile settings uses its mobile navigation instead of a top-stacked sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await page.goto("/profile-settings.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveClass(/sidebar-layout-ready/);
  const sidebarToggle = page.locator("#sidebarToggle");
  await expect(sidebarToggle).toBeVisible();
  const bodyDirection = await page.locator("body").evaluate((element) => getComputedStyle(element).flexDirection);
  expect(bodyDirection).toBe("row");
  await sidebarToggle.click();
  await expect(page.locator("body")).toHaveClass(/nav-open/);
  await expect(page.locator("#sidebarNav")).toBeVisible();
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
    text: "Open Payments.",
    metadata: {
      kind: "assistant_reply",
      provider: "openai_manager",
      grounded: true,
      primaryAsk: "billing_navigation",
      responseMode: "DIRECT_ANSWER",
      navigation: {
        ctaLabel: "Payments",
        ctaHref: "dashboard-attorney.html#funds",
        inlineLinkText: "Payments",
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
  await expect(response.locator(".support-message-bubble")).toHaveText("Open Payments.");
  const inlineLink = response.locator("[data-support-inline-link]");
  await expect(inlineLink).toHaveText("Payments");
  await expect(inlineLink).toHaveAttribute("href", /dashboard-attorney\.html#funds$/);
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
  let context;
  try {
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

    context = await browser.newContext({
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

    await expect(page.locator(".lpc-universal-header-shell")).toBeVisible();
    await expect(page.locator("#attorneyTourModal")).toBeVisible();
    await expect(page.locator("#attorneyTourTitle")).toContainText("Welcome to Let’s-ParaConnect");
    await expect(page.locator("#attorneyTourText")).toContainText("quick walkthrough");
    await expect(page.locator("#attorneyOnboardingAttentionCard")).toBeVisible();
    await expect(page.locator("[data-onboarding-attention-title]")).toContainText("Finish your profile");
    await expect(page.locator("[data-onboarding-attention-text]")).toContainText(
      "Add your profile details so everything is ready before you post your first Matter."
    );
  } finally {
    await context?.close();
    const restore = await request.post(
      `${resolveBaseURL()}/api/admin/ai-control-room/dev/e2e/bootstrap-attorney`,
      { headers: resolveHarnessHeaders() }
    );
    expect(restore.ok()).toBeTruthy();
  }
});
