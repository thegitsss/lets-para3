const { test, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const VALID_RESET_TOKEN = `0123456789abcdef01234567.${"a".repeat(43)}`;
const VIEWPORTS = [
  { width: 320, height: 700 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];

const AUTH_PAGES = [
  {
    name: "sign in",
    url: "/login.html",
    panel: ".left-panel",
    art: ".login-aside-copy",
    controls: ["#email", ".google-auth-button", ".login-btn"],
  },
  {
    name: "create account",
    url: "/signup.html",
    panel: ".left-panel",
    art: ".signup-aside-copy",
    controls: ["#fullName", ".google-auth-button", "#nextStepBtn"],
  },
  {
    name: "forgot password",
    url: "/forgot-password.html",
    panel: ".recovery-panel",
    art: ".recovery-art",
    controls: ["#email", "#resetForm button[type='submit']"],
  },
  {
    name: "reset password",
    url: `/reset-password.html?token=${VALID_RESET_TOKEN}`,
    panel: ".recovery-panel",
    art: ".recovery-art",
    controls: ["#newPassword", "#resetForm button[type='submit']"],
  },
  {
    name: "verify email",
    url: "/verify-email.html",
    panel: ".verification-panel",
    art: ".verification-art",
    controls: [],
  },
];

async function expectNoAxeViolations(page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  }));
  expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
}

test("auth pages share one responsive family across the Phase 7 viewport matrix", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const authPage of AUTH_PAGES) {
      await page.goto(authPage.url, { waitUntil: "domcontentloaded" });
      await page.locator(authPage.panel).waitFor({ state: "visible" });

      const layout = await page.evaluate(({ panelSelector, artSelector }) => {
        const panel = document.querySelector(panelSelector);
        const art = document.querySelector(artSelector);
        const panelRect = panel.getBoundingClientRect();
        const artStyle = getComputedStyle(art);
        return {
          viewportWidth: document.documentElement.clientWidth,
          entryLayout: document.body.classList.contains("auth-entry"),
          recoveryLayout: document.body.classList.contains("password-recovery-page"),
          containerWidth: document.querySelector(".overlay")?.clientWidth,
          contentWidth: document.documentElement.scrollWidth,
          panelLeft: panelRect.left,
          panelRight: panelRect.right,
          panelWidth: panelRect.width,
          artDisplay: artStyle.display,
          artVisible: artStyle.display !== "none" && art.getBoundingClientRect().width > 0,
        };
      }, { panelSelector: authPage.panel, artSelector: authPage.art });

      expect(layout.contentWidth, `${authPage.name} overflows at ${viewport.width}px`)
        .toBeLessThanOrEqual(layout.viewportWidth + 1);

      if (viewport.width <= 768) {
        expect(layout.artDisplay, `${authPage.name} has the intended mobile artwork`).toBe(layout.entryLayout || layout.recoveryLayout ? "none" : "block");
        expect(layout.panelLeft).toBeGreaterThanOrEqual(-1);
        expect(layout.panelRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
        const cardInset = layout.entryLayout ? (viewport.width <= 360 ? 24 : 32) : (viewport.width <= 360 ? 24 : 40);
        const expectedWidth = layout.entryLayout ? layout.viewportWidth - cardInset : Math.min(470, layout.viewportWidth - cardInset);
        expect(layout.panelWidth).toBeGreaterThanOrEqual(expectedWidth - 2);
        expect(layout.panelWidth).toBeLessThanOrEqual(expectedWidth + 2);
      } else {
        expect(layout.artVisible, `${authPage.name} has the intended desktop artwork`).toBe(!layout.recoveryLayout);
        if (layout.entryLayout) {
          expect(layout.panelWidth / (layout.containerWidth - 20)).toBeCloseTo(0.48, 2);
        } else {
          expect(layout.panelWidth).toBeCloseTo(470, 0);
          expect(Math.abs(layout.panelLeft - (layout.viewportWidth - layout.panelWidth) / 2)).toBeLessThanOrEqual(1);
        }
      }

      for (const selector of authPage.controls) {
        const control = page.locator(selector).first();
        await expect(control, `${authPage.name}: ${selector}`).toBeVisible();
        const geometry = await control.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            height: element.getBoundingClientRect().height,
            radius: parseFloat(style.borderTopLeftRadius),
          };
        });
        const minimumHeight = layout.entryLayout && viewport.width > 768 ? 44 : 49;
        expect(geometry.height, `${authPage.name}: ${selector} height`).toBeGreaterThanOrEqual(minimumHeight);
        expect(geometry.radius, `${authPage.name}: ${selector} radius`).toBeGreaterThanOrEqual(7);
        expect(geometry.radius, `${authPage.name}: ${selector} radius`).toBeLessThanOrEqual(9);
      }
    }
  }
});

test("auth vocabulary and password toggles are consistent and accessible", async ({ page }) => {
  await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());

  await page.goto("/login.html", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Sign in – Let’s-ParaConnect");
  await page.waitForTimeout(250);
  await expect(page.locator("#toastBanner")).not.toHaveClass(/show/);
  await expect(page.locator(".show-toggle")).toHaveText("Show password");
  await page.locator(".show-toggle").click();
  await expect(page.locator(".show-toggle")).toHaveText("Hide password");
  await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();

  await page.goto("/signup.html", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Create an account – Let’s-ParaConnect");
  await expect(page.locator("#togglePw")).toHaveText("Show password");
  await page.locator("#togglePw").click();
  await expect(page.locator("#togglePw")).toHaveText("Hide password");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

  await page.goto(`/reset-password.html?token=${VALID_RESET_TOKEN}`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Choose a new password – Let’s-ParaConnect");
  await expect(page.locator(".toggle-password")).toHaveText(["Show password", "Show password"]);
  await page.locator(".toggle-password").first().click();
  await expect(page.locator(".toggle-password").first()).toHaveText("Hide password");
  await expect(page.getByRole("button", { name: "Reset password" })).toBeVisible();
});

test("forgot password preserves its request and confirmation-dialog behavior", async ({ page }) => {
  let submittedEmail = "";
  await page.route("**/api/csrf", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ csrfToken: "phase-seven-csrf" }),
  }));
  await page.route("**/api/auth/request-password-reset", async (route) => {
    submittedEmail = JSON.parse(route.request().postData() || "{}").email || "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto("/forgot-password.html", { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill("alex.morgan@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();

  await expect(page.locator("#confirmationModal")).toBeVisible();
  expect(submittedEmail).toBe("alex.morgan@example.com");
  await expect(page.locator("#confirmationModal")).toHaveAttribute("aria-hidden", "false");
  await expect(page.getByRole("button", { name: "Done" })).toBeFocused();
  await expectNoAxeViolations(page);

  await page.keyboard.press("Escape");
  await expect(page.locator("#confirmationModal")).toBeHidden();
  await expect(page.locator("#confirmationModal")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#confirmationModal")).toHaveAttribute("inert", "");
});

test("reset password presents stable malformed, expired, and success states", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(
      callback,
      delay === 3000 ? 60_000 : delay,
      ...args
    );
  });

  let resetOutcome = "expired";
  await page.route("**/api/csrf", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ csrfToken: "phase-seven-csrf" }),
  }));
  await page.route("**/api/auth/reset-password", (route) => route.fulfill({
    status: resetOutcome === "success" ? 200 : 400,
    contentType: "application/json",
    body: JSON.stringify(resetOutcome === "success" ? { ok: true } : { msg: "Invalid or expired token" }),
  }));

  await page.goto("/reset-password.html?token=malformed", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#resetTitle")).toHaveText("This reset link can’t be used.");
  await expect(page.locator("#resetForm")).toBeHidden();
  await expect(page.getByRole("link", { name: "Request another reset link" })).toBeVisible();

  await page.goto(`/reset-password.html?token=${VALID_RESET_TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.locator("#newPassword").fill("Correct-Horse-Battery-Staple-2026");
  await page.locator("#confirmPassword").fill("Correct-Horse-Battery-Staple-2026");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.locator("#resetTitle")).toHaveText("This reset link can’t be used.");
  await expect(page.locator("#resetForm")).toBeHidden();

  resetOutcome = "success";
  await page.goto(`/reset-password.html?token=${VALID_RESET_TOKEN}`, { waitUntil: "domcontentloaded" });
  await page.locator("#newPassword").fill("Correct-Horse-Battery-Staple-2026");
  await page.locator("#confirmPassword").fill("Correct-Horse-Battery-Staple-2026");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.locator("#resetTitle")).toHaveText("Your password is reset.");
  await expect(page.locator("#message")).toHaveText("Taking you to sign in…");
  await expect(page.locator("#resetForm")).toBeHidden();
  await expect(page.locator("body")).not.toContainText(/✅|❌|Saving\.\.\.|Redirecting\.\.\./);
  await expectNoAxeViolations(page);
});

test("verification and submitted application states tell the truth without a sign-in CTA", async ({ page }) => {
  test.setTimeout(60_000);
  let verificationOutcome = "success";
  let registrationRequests = 0;

  await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());
  await page.route("**/api/csrf", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ csrfToken: "phase-seven-csrf" }),
  }));
  await page.route("**/api/auth/verify-email", (route) => route.fulfill({
    status: verificationOutcome === "success" ? 200 : 400,
    contentType: "application/json",
    body: JSON.stringify(
      verificationOutcome === "success" ? { ok: true } : { msg: "This verification link is invalid or expired." }
    ),
  }));
  await page.route("**/api/auth/register", (route) => {
    registrationRequests += 1;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, verificationEmailStatus: "sent", emailVerified: false }),
    });
  });

  await page.goto("/verify-email.html?token=phase-seven", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#verificationTitle")).toHaveText("Your email is verified.");
  await expect(page.locator("#verificationStatus")).toHaveText(
    "Your application is under review, and we’ll contact you when your LPC account is ready."
  );
  await expect(page.locator(".verification-action-row a")).toHaveText("Return home");
  await expect(page.locator(".verification-action-row a")).toHaveCount(1);
  await expect(page.locator(".verification-panel")).not.toContainText(/sign in/i);

  verificationOutcome = "error";
  await page.goto("/verify-email.html?token=phase-seven", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#verificationTitle")).toHaveText("We couldn’t verify this email.");
  await expect(page.locator("#verificationPanel")).toHaveAttribute("data-state", "error");

  await page.goto("/signup.html", { waitUntil: "domcontentloaded" });
  await page.locator("#fullName").fill("Alex Morgan");
  await page.locator("#email").fill("alex.morgan@example.com");
  await page.locator("#password").fill("Correct-Horse-Battery-Staple-2026");
  await page.locator("#nextStepBtn").click();
  await page.locator("#bar").fill("NY123456");
  await page.locator("#barState").selectOption("NY");
  await page.locator("#attorneyGoodStanding").check();

  await page.locator("#submitBtn").click();
  await expect(page.locator("#msg")).toContainText("Verification failed to load");
  expect(registrationRequests, "registration must stay behind the existing Turnstile boundary").toBe(0);

  await page.locator("#signupForm").evaluate((form) => {
    const token = document.createElement("input");
    token.type = "hidden";
    token.name = "cf-turnstile-response";
    token.value = "phase-seven-turnstile";
    form.append(token);
  });
  await page.locator("#submitBtn").click();

  await expect(page.locator("#signupConfirmation")).toBeVisible();
  await expect(page.locator("#signupForm")).toBeHidden();
  await expect(page.locator("#signupIntroduction")).toBeHidden();
  await expect(page.locator("#signupConfirmation")).toContainText("Your submission is under review.");
  await expect(page.locator("#signupConfirmation")).toContainText("Verify your address for account notices.");
  await expect(page.getByRole("link", { name: "Return home" })).toBeVisible();
  await expect(page.locator("#signupConfirmation")).not.toContainText(/sign in|three steps|creating an account is free|✓|✅/i);
  expect(registrationRequests).toBe(1);
  await expectNoAxeViolations(page);
});
