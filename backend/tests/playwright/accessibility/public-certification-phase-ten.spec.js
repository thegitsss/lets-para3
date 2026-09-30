const fs = require("fs");
const { test, expect } = require("playwright/test");

const VALID_RESET_TOKEN = `0123456789abcdef01234567.${"a".repeat(43)}`;

const VIEWPORTS = [
  { name: "mobile-320", width: 320, height: 844 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1366", width: 1366, height: 900 },
  { name: "wide-1920", width: 1920, height: 1080 },
];

const PUBLIC_PAGES = [
  { name: "home", url: "/index.html", audit: "home" },
  { name: "login", url: "/login.html", audit: "login" },
  { name: "signup", url: "/signup.html", audit: "signup" },
  { name: "browse-paralegals", url: "/browse-paralegals.html", audit: "browse-paralegals" },
  { name: "forgot-password", url: "/forgot-password.html", audit: "forgot-password" },
  { name: "reset-password", url: "/reset-password.html", audit: "reset-password" },
  { name: "verify-email", url: "/verify-email.html", audit: "verify-email" },
  { name: "privacy", url: "/privacy.html", audit: "privacy" },
  { name: "terms", url: "/terms.html", audit: "terms" },
  { name: "accessibility", url: "/accessibility.html", audit: "accessibility" },
  { name: "contact", url: "/contact.html", audit: "contact" },
  { name: "paralegal-admission", url: "/paralegal-admission.html", audit: "paralegal-admission" },
  { name: "attorney-faq", url: "/attorney-faq.html", audit: "attorney-faq" },
  { name: "paralegal-faq", url: "/paralegal-faq.html", audit: "paralegal-faq" },
  { name: "attorney-help", url: "/help.html", audit: "attorney-help" },
  { name: "paralegal-help", url: "/paralegalhelp.html", audit: "paralegal-help" },
  { name: "not-found", url: "/phase-ten-unknown-route", audit: "not-found", status: 404 },
];

const PROTECTED_DOCUMENTS = [
  "active-cases.html",
  "admin-dashboard.html",
  "admin-directors.html",
  "billing-attorney.html",
  "browse-jobs.html",
  "case-applications.html",
  "case-detail.html",
  "create-case-step2.html",
  "create-case-step5.html",
  "create-case.html",
  "dashboard-attorney.html",
  "dashboard-paralegal.html",
  "director-portal.html",
  "paralegal-applications.html",
  "paralegal-assigned.html",
  "paralegal-invitations.html",
  "profile-attorney.html",
  "profile-paralegal.html",
  "profile-settings.html",
];

const PUBLIC_HEADER_PAGES = PUBLIC_PAGES.filter(({ name }) => ![
  "login",
  "signup",
  "forgot-password",
  "reset-password",
  "verify-email",
].includes(name));

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockPublicNetwork(page) {
  await page.route("https://challenges.cloudflare.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: "window.turnstile=window.turnstile||{};",
  }));
  await page.route("**/public/paralegals?**", (route) => json(route, {
    items: [],
    total: 0,
    pages: 1,
    page: 1,
  }));
  await page.route("**/api/**", (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === "/api/auth/me") return json(route, { user: null });
    if (requestUrl.pathname === "/api/csrf") return json(route, { csrfToken: "phase-ten-csrf" });
    if (requestUrl.pathname === "/api/health") return json(route, { ok: true });
    return json(route, { ok: true });
  });
}

async function settlePublicPage(page, item) {
  const response = await page.goto(item.url, { waitUntil: "load" });
  expect(response?.status(), `${item.name} response status`).toBe(item.status || 200);
  await page.locator("main").waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);
  if (item.name === "browse-paralegals") {
    await expect(page.locator("#resultsStatus")).toHaveText("No paralegals match your filters yet.");
  }
  if (item.name === "verify-email") {
    await expect(page.locator("#verificationPanel")).toHaveAttribute("data-state", "error");
  }
  if (item.name === "reset-password") {
    await expect(page.locator("#resetPanel")).toHaveAttribute("data-state", "error");
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function pageHealth(page, item) {
  return page.evaluate(({ pageName }) => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && node.getClientRects().length > 0;
    };
    const persistentLoading = [...document.querySelectorAll("body *")]
      .filter(visible)
      .map((node) => node.childElementCount === 0 ? node.textContent.trim() : "")
      .filter((text) => /^(?:loading|sending|saving|verifying|submitting)(?:…|\.{3})?$/i.test(text));
    const brokenImages = [...document.images]
      .filter((image) => visible(image) && (!image.complete || image.naturalWidth === 0))
      .map((image) => image.currentSrc || image.src || image.alt || "unnamed image");
    const zeroSizeGraphics = [...document.querySelectorAll("img, svg, canvas")]
      .filter(visible)
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width === 0 || rect.height === 0;
      })
      .map((node) => `${node.tagName.toLowerCase()}.${node.className?.baseVal || node.className || ""}`);
    const skipLink = document.querySelector(".skip-link");
    const skipLinkRect = skipLink?.getBoundingClientRect();
    return {
      pageName,
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight,
      persistentLoading,
      brokenImages,
      zeroSizeGraphics,
      hiddenSkipLinkBottom: skipLinkRect?.bottom ?? 0,
    };
  }, { pageName: item.name });
}

for (const viewport of VIEWPORTS) {
  test(`all 17 public surfaces render cleanly at ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await mockPublicNetwork(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ reducedMotion: "reduce" });

    const consoleErrors = [];
    const pageErrors = [];
    const resourceFailures = [];
    let currentPage = "";
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`${currentPage}: ${message.text()}`);
    });
    page.on("pageerror", (error) => pageErrors.push(`${currentPage}: ${error.message}`));
    page.on("response", (response) => {
      const type = response.request().resourceType();
      if (["stylesheet", "script", "font", "image"].includes(type) && response.status() >= 400) {
        resourceFailures.push(`${currentPage}: ${response.status()} ${response.url()}`);
      }
    });

    for (const item of PUBLIC_PAGES) {
      currentPage = item.name;
      const errorStart = consoleErrors.length;
      const pageErrorStart = pageErrors.length;
      const resourceStart = resourceFailures.length;
      await settlePublicPage(page, item);
      const health = await pageHealth(page, item);

      expect(health.documentWidth, `${item.name} document overflow`).toBeLessThanOrEqual(health.viewportWidth + 1);
      expect(health.bodyWidth, `${item.name} body overflow`).toBeLessThanOrEqual(health.viewportWidth + 1);
      expect(health.bodyHeight, `${item.name} has no rendered page height`).toBeGreaterThan(0);
      expect(health.persistentLoading, `${item.name} retains loading copy`).toEqual([]);
      expect(health.brokenImages, `${item.name} has broken visible images`).toEqual([]);
      expect(health.zeroSizeGraphics, `${item.name} has zero-size visible graphics`).toEqual([]);
      expect(health.hiddenSkipLinkBottom, `${item.name} exposes part of its unfocused skip link`).toBeLessThanOrEqual(0);
      const currentConsoleErrors = consoleErrors.slice(errorStart);
      const unexpectedConsoleErrors = item.status === 404
        ? currentConsoleErrors.filter((message) => !/Failed to load resource:.*404 \(Not Found\)/.test(message))
        : currentConsoleErrors;
      expect(unexpectedConsoleErrors, `${item.name} unexpected console errors`).toEqual([]);
      expect(pageErrors.slice(pageErrorStart), `${item.name} page errors`).toEqual([]);
      expect(resourceFailures.slice(resourceStart), `${item.name} resource failures`).toEqual([]);

      // Long legal pages exceed Firefox's 32,767-pixel capture limit on mobile.
      // Retain every part at CSS-pixel scale instead of dropping page evidence.
      const captureSize = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      }));
      const tileHeight = 16000;
      for (let top = 0, part = 1; top < captureSize.height; top += tileHeight, part += 1) {
        const suffix = captureSize.height > tileHeight ? `-part-${part}` : "";
        const screenshotPath = testInfo.outputPath(`${item.name}-${viewport.name}${suffix}.png`);
        await page.screenshot({
          path: screenshotPath, fullPage: true, animations: "disabled", scale: "css",
          clip: { x: 0, y: top, width: captureSize.width, height: Math.min(tileHeight, captureSize.height - top) },
        });
        expect(fs.statSync(screenshotPath).size, `${item.name} screenshot part ${part} is empty`).toBeGreaterThan(0);
      }
    }
  });
}

test("compact landscape keeps public navigation, Help, and form surfaces usable", async ({ page }) => {
  test.setTimeout(120_000);
  await mockPublicNetwork(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const item of PUBLIC_PAGES) {
    await settlePublicPage(page, item);
    const health = await pageHealth(page, item);
    expect(health.documentWidth, `${item.name} landscape overflow`).toBeLessThanOrEqual(health.viewportWidth + 1);
    expect(health.bodyWidth, `${item.name} landscape body overflow`).toBeLessThanOrEqual(health.viewportWidth + 1);
  }

  for (const item of PUBLIC_HEADER_PAGES) {
    await settlePublicPage(page, item);
    const toggle = page.locator("[data-mobile-nav-toggle]");
    await expect(toggle, `${item.name} landscape mobile navigation`).toBeVisible();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("[data-mobile-nav]")).toHaveAttribute("aria-hidden", "false");
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
});

test("iPhone 13 Pro Max clears the completed-matter card before the Assistant section", async ({ page }) => {
  await mockPublicNetwork(page);
  await page.setViewportSize({ width: 428, height: 926 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/index.html", { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  const geometry = await page.evaluate(() => {
    const absoluteTop = (node) => node.getBoundingClientRect().top + window.scrollY;
    return {
      lastChapterTop: absoluteTop(document.querySelector(".workflow-chapter:last-child")),
      pathsDocumentTop: absoluteTop(document.querySelector(".assistant-spotlight")),
    };
  });

  await page.evaluate((scrollY) => window.scrollTo(0, scrollY), geometry.lastChapterTop + 120);
  await page.waitForTimeout(350);
  await expect(page.locator(".workflow-chapters")).toHaveAttribute("data-workflow-state", "6");
  await expect(page.locator(".workflow-mobile-stage__number")).toHaveText("06");
  await expect(page.locator(".workflow-mobile-stage__heading h3")).toHaveText("Close the matter.");
  const fullStep = await page.evaluate(() => {
    const header = document.querySelector(".home-header").getBoundingClientRect();
    const heading = document.querySelector(".workflow-mobile-stage__heading").getBoundingClientRect();
    return {
      headerBottom: header.bottom,
      headingTop: heading.top,
      headingBottom: heading.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(fullStep.headingTop).toBeGreaterThanOrEqual(fullStep.headerBottom + 12);
  expect(fullStep.headingBottom).toBeLessThan(fullStep.viewportHeight * 0.42);

  await page.evaluate((scrollY) => window.scrollTo(0, scrollY), geometry.pathsDocumentTop - 500);
  await page.waitForTimeout(350);

  await expect(page.locator(".workflow-chapters")).toHaveAttribute("data-workflow-state", "6");
  const handoff = await page.evaluate(() => {
    const completedCard = document.querySelector(
      '.workflow-mobile-stage__canvas .workflow-state.is-active .payment-summary',
    );
    const pathsHeading = document.querySelector(".assistant-spotlight__copy h2");
    const paths = document.querySelector(".assistant-spotlight");
    return {
      completedCardBottom: completedCard.getBoundingClientRect().bottom,
      pathsHeadingTop: pathsHeading.getBoundingClientRect().top,
      pathsMarginTop: Number.parseFloat(getComputedStyle(paths).marginTop),
    };
  });

  expect(handoff.pathsMarginTop).toBeGreaterThanOrEqual(-64);
  expect(handoff.completedCardBottom).toBeLessThan(handoff.pathsHeadingTop - 24);
});

test("all 19 protected frontend documents still redirect anonymous visitors to sign in", async ({ page }) => {
  test.setTimeout(120_000);
  await mockPublicNetwork(page);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const documentName of PROTECTED_DOCUMENTS) {
    await page.goto(`/${documentName}`, { waitUntil: "domcontentloaded" });
    await expect(page, `${documentName} did not preserve anonymous access protection`).toHaveURL(/\/login\.html(?:$|[?#])/);
    await expect(page.getByRole("heading", { name: /^Sign in$/i })).toBeVisible();
  }
});

test("login retains validation, loading, pending-review, Google, and passkey boundaries", async ({ page }) => {
  test.setTimeout(60_000);
  await page.route("**/assets/vendor/simplewebauthn-13.3.0.js", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: "window.SimpleWebAuthnBrowser={browserSupportsWebAuthn:()=>true,startAuthentication:async()=>({id:'phase-ten'})};",
  }));
  await mockPublicNetwork(page);
  let loginRequests = 0;
  let passkeyRequests = 0;
  await page.route("**/api/auth/login", async (route) => {
    loginRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return json(route, { msg: "Your account is still under review. We’ll email you as soon as it’s approved." }, 403);
  });
  await page.route("**/api/auth/passkeys/authentication-options", (route) => {
    passkeyRequests += 1;
    return json(route, { error: "No passkey is available for this sign-in." }, 400);
  });

  await page.goto("/login.html", { waitUntil: "load" });
  await expect(page.locator(".google-auth-button")).toHaveAttribute("href", "/api/auth/google?intent=login");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect(loginRequests).toBe(0);
  await expect(page.locator("#email:invalid")).toHaveCount(1);

  await page.locator("#email").fill("pending@example.com");
  await page.locator("#password").fill("Correct-Horse-Battery-Staple-2026");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  await expect(page.locator("#toastBanner")).toContainText("still under review");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect(loginRequests).toBe(1);

  const passkey = page.getByRole("button", { name: "Sign in with a passkey" });
  await expect(passkey).toBeVisible();
  const passkeyRequestsBeforeClick = passkeyRequests;
  await passkey.click();
  await expect.poll(() => passkeyRequests).toBeGreaterThanOrEqual(passkeyRequestsBeforeClick + 1);
  await expect(page.locator("#toastBanner")).toContainText("No passkey is available");
});

test("signup retains both role transitions and the Turnstile submission boundary", async ({ page }) => {
  await page.route("https://challenges.cloudflare.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript",
    body: "window.turnstile=window.turnstile||{};",
  }));
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "phase-ten-csrf" }));
  let registrationRequests = 0;
  await page.route("**/api/auth/register", (route) => {
    registrationRequests += 1;
    return json(route, { ok: true, emailVerified: false, verificationEmailStatus: "sent" }, 201);
  });

  await page.goto("/signup.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#btnA")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#googleSignupButton")).toHaveAttribute("href", /role=attorney/);
  await page.locator("#btnP").click();
  await expect(page.locator("#btnP")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#googleSignupButton")).toHaveAttribute("href", /role=paralegal/);
  await page.locator("#fullName").fill("Alex Morgan");
  await page.locator("#email").fill("alex.morgan@example.com");
  await page.locator("#password").fill("Correct-Horse-Battery-Staple-2026");
  await page.locator("#nextStepBtn").click();
  await expect(page.getByRole("heading", { name: "Apply to join LPC" })).toBeVisible();
  await expect(page.locator("#paralegalExperience")).toBeVisible();

  await page.goto("/signup.html?role=attorney", { waitUntil: "domcontentloaded" });
  await page.locator("#fullName").fill("Alex Morgan");
  await page.locator("#email").fill("alex.morgan@example.com");
  await page.locator("#password").fill("Correct-Horse-Battery-Staple-2026");
  await page.locator("#nextStepBtn").click();
  await page.locator("#bar").fill("NY123456");
  await page.locator("#barState").selectOption("NY");
  await page.locator("#attorneyGoodStanding").check();
  await page.locator("#submitBtn").click();
  await expect(page.locator("#msg")).toContainText("Verification failed to load");
  expect(registrationRequests).toBe(0);

  await page.locator("#signupForm").evaluate((form) => {
    const token = document.createElement("input");
    token.type = "hidden";
    token.name = "cf-turnstile-response";
    token.value = "phase-ten-turnstile";
    form.append(token);
  });
  await page.locator("#submitBtn").click();
  await expect(page.locator("#signupConfirmation")).toBeVisible();
  await expect(page.locator("#signupConfirmation")).toContainText("Your submission is under review.");
  await expect(page.locator("#signupConfirmation").getByRole("link", { name: "Return home", exact: true })).toBeVisible();
  expect(registrationRequests).toBe(1);
});

test("forgot-password covers validation, loading, confirmation focus, and error", async ({ page }) => {
  let outcome = "success";
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "phase-ten-csrf" }));
  await page.route("**/api/auth/request-password-reset", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return outcome === "success"
      ? json(route, { ok: true })
      : json(route, { message: "Password reset is temporarily unavailable." }, 503);
  });

  await page.goto("/forgot-password.html", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.locator("#email:invalid")).toHaveCount(1);
  await page.locator("#email").fill("alex.morgan@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("button", { name: "Sending…" })).toBeDisabled();
  await expect(page.locator("#confirmationModal")).toBeVisible();
  await expect(page.getByRole("button", { name: "Done" })).toBeFocused();
  await page.getByRole("button", { name: "Done" }).click();

  outcome = "error";
  await page.locator("#email").fill("alex.morgan@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.locator("#resetStatus")).toHaveText("Password reset is temporarily unavailable.");
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeEnabled();
});

test("reset-password covers missing, validation, loading, generic error, expired, and success states", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 3000 ? 60_000 : delay, ...args);
  });
  let outcome = "error";
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "phase-ten-csrf" }));
  await page.route("**/api/auth/reset-password", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (outcome === "success") return json(route, { ok: true });
    if (outcome === "expired") return json(route, { msg: "Invalid or expired token" }, 400);
    return json(route, { msg: "Password service is temporarily unavailable." }, 503);
  });

  await page.goto("/reset-password.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#resetTitle")).toHaveText("This reset link can’t be used.");
  await page.goto(`/reset-password.html?token=${VALID_RESET_TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.locator("#newPassword").fill("short");
  await page.locator("#confirmPassword").fill("short");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.locator("#newPassword:invalid")).toHaveCount(1);
  await expect(page.locator("#message")).toHaveText("");
  await page.locator("#newPassword").fill("Correct-Horse-Battery-Staple-2026");
  await page.locator("#confirmPassword").fill("Different-Horse-Battery-Staple-2026");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.locator("#message")).toHaveText("Passwords do not match.");

  await page.locator("#confirmPassword").fill("Correct-Horse-Battery-Staple-2026");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(page.locator("#message")).toHaveText("Password service is temporarily unavailable.");

  outcome = "expired";
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.locator("#resetTitle")).toHaveText("This reset link can’t be used.");
  await expect(page.locator("#resetForm")).toBeHidden();

  outcome = "success";
  await page.goto(`/reset-password.html?token=${VALID_RESET_TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.locator("#newPassword").fill("Correct-Horse-Battery-Staple-2026");
  await page.locator("#confirmPassword").fill("Correct-Horse-Battery-Staple-2026");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.locator("#resetTitle")).toHaveText("Your password is reset.");
  await expect(page.locator("#message")).toHaveText("Taking you to sign in…");
});

test("verify-email covers loading, success, missing, invalid, and expired results without a sign-in CTA", async ({ page }) => {
  let outcome = "success";
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "phase-ten-csrf" }));
  await page.route("**/api/auth/verify-email", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (outcome === "success") return json(route, { ok: true });
    const message = outcome === "expired"
      ? "This verification link has expired."
      : "This verification link is invalid.";
    return json(route, { msg: message }, 400);
  });

  const pendingNavigation = page.goto("/verify-email.html?token=phase-ten", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#verificationPanel")).toHaveAttribute("data-state", "loading");
  await expect(page.locator("#verificationStatus")).toHaveText("Please wait while we verify this link.");
  await pendingNavigation;
  await expect(page.locator("#verificationTitle")).toHaveText("Your email is verified.");
  await expect(page.locator("#verificationStatus")).toContainText("application is under review");
  await expect(page.locator(".verification-action-row a")).toHaveText("Return home");
  await expect(page.locator(".verification-panel")).not.toContainText(/sign in/i);

  await page.goto("/verify-email.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#verificationStatus")).toHaveText("This verification link is missing or invalid.");
  outcome = "invalid";
  await page.goto("/verify-email.html?token=phase-ten", { waitUntil: "load" });
  await expect(page.locator("#verificationStatus")).toHaveText("This verification link is invalid.");
  outcome = "expired";
  await page.goto("/verify-email.html?token=phase-ten", { waitUntil: "load" });
  await expect(page.locator("#verificationStatus")).toHaveText("This verification link has expired.");
  await expect(page.locator(".verification-action-row a")).toHaveCount(1);
  await expect(page.locator(".verification-action-row a")).toHaveText("Return home");
});

test("contact covers browser validation, loading, success, error, and responsive actions", async ({ page }) => {
  let outcome = "success";
  await page.route("**/api/auth/me", (route) => json(route, { user: null }));
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "phase-ten-csrf" }));
  await page.route("**/api/public/contact", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return outcome === "success"
      ? json(route, { ok: true })
      : json(route, { msg: "Contact support is temporarily unavailable." }, 503);
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/contact.html", { waitUntil: "domcontentloaded" });
  const submit = page.getByRole("button", { name: "Submit message" });
  await submit.click();
  await expect(page.locator("#name:invalid")).toHaveCount(1);

  const fillContact = async () => {
    await page.locator("#name").fill("Alex Morgan");
    await page.locator("#email").fill("alex.morgan@example.com");
    await page.locator("#role").selectOption("attorney");
    await page.locator("#subject").fill("Phase 10 certification");
    await page.locator("#message").fill("Confirm the public contact state remains available.");
  };
  await fillContact();
  await submit.click();
  await expect(page.getByRole("button", { name: "Sending…" })).toBeDisabled();
  await expect(page.locator("#formStatus")).toHaveText("Message sent. We’ll reply to the email address you provided.");
  await expect(page.locator("#formStatus")).toHaveClass(/success/);

  outcome = "error";
  await fillContact();
  await submit.click();
  await expect(page.locator("#formStatus")).toHaveText("Contact support is temporarily unavailable.");
  await expect(page.locator("#formStatus")).toHaveClass(/error/);
  const action = await submit.boundingBox();
  expect(action.width).toBeLessThanOrEqual(280);
  expect(action.height).toBeGreaterThanOrEqual(48);
});
