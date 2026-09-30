const { test, expect } = require("playwright/test");

const PUBLIC_PAGES = [
  ["home", "/index.html"],
  ["login", "/login.html"],
  ["signup", "/signup.html"],
  ["browse", "/browse-paralegals.html"],
  ["forgot password", "/forgot-password.html"],
  ["reset password", "/reset-password.html?token=invalid"],
  ["verify email", "/verify-email.html"],
  ["privacy", "/privacy.html"],
  ["terms", "/terms.html"],
  ["accessibility", "/accessibility.html"],
  ["contact", "/contact.html"],
  ["admission", "/paralegal-admission.html"],
  ["attorney FAQ", "/attorney-faq.html"],
  ["paralegal FAQ", "/paralegal-faq.html"],
  ["attorney Help", "/help.html"],
  ["paralegal Help", "/paralegalhelp.html"],
  ["not found", "/phase-nine-unknown-route", 404],
];

const PUBLIC_HEADER_PAGES = [
  "/index.html",
  "/browse-paralegals.html",
  "/privacy.html",
  "/terms.html",
  "/accessibility.html",
  "/contact.html",
  "/paralegal-admission.html",
  "/attorney-faq.html",
  "/paralegal-faq.html",
  "/help.html",
  "/paralegalhelp.html",
  "/phase-nine-unknown-route",
];

const PUBLIC_PATHS = new Set([
  "/",
  "/index.html",
  "/login.html",
  "/signup.html",
  "/browse-paralegals.html",
  "/forgot-password.html",
  "/reset-password.html",
  "/verify-email.html",
  "/privacy.html",
  "/terms.html",
  "/accessibility.html",
  "/contact.html",
  "/paralegal-admission.html",
  "/attorney-faq.html",
  "/paralegal-faq.html",
  "/help.html",
  "/paralegalhelp.html",
]);

async function mockPublicBoundaries(page) {
  await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: null }),
  }));
  await page.route("**/api/csrf", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ csrfToken: "phase-nine-csrf" }),
  }));
  await page.route("**/public/paralegals?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], total: 0, pages: 1, page: 1 }),
  }));
}

async function openPublicPage(page, url, expectedStatus = 200) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  expect(response?.status(), `${url} status`).toBe(expectedStatus);
  await page.locator("main").waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrast(rgbA, rgbB) {
  const luminance = ([red, green, blue]) => (
    (0.2126 * channel(red)) + (0.7152 * channel(green)) + (0.0722 * channel(blue))
  );
  const first = luminance(rgbA);
  const second = luminance(rgbB);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function parseRgb(value) {
  const match = String(value).match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

async function expectStrongFocus(locator, surfaceRgb, label) {
  await locator.focus();
  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.outlineColor,
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
    };
  });
  expect(focus.style, `${label} focus style`).not.toBe("none");
  expect(focus.width, `${label} focus width`).toBeGreaterThanOrEqual(2);
  const outlineRgb = parseRgb(focus.color);
  expect(outlineRgb, `${label} focus color`).not.toBeNull();
  expect(contrast(outlineRgb, surfaceRgb), `${label} focus contrast`).toBeGreaterThanOrEqual(3);
}

test("all public pages retain valid heading, hidden-content, and decorative-art semantics", async ({ page }) => {
  test.setTimeout(120_000);
  await mockPublicBoundaries(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const [name, url, status = 200] of PUBLIC_PAGES) {
    await openPublicPage(page, url, status);
    const semantics = await page.evaluate(() => {
      const isVisible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
        .filter(isVisible)
        .map((heading) => ({ level: Number(heading.tagName.slice(1)), text: heading.textContent.trim() }));
      const jumps = headings.slice(1).filter((heading, index) => heading.level > headings[index].level + 1);
      const hiddenFocusable = [...document.querySelectorAll('[aria-hidden="true"]')].flatMap((container) => {
        if (container.hasAttribute("inert")) return [];
        return [...container.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
          .filter((control) => !control.disabled && isVisible(control))
          .map((control) => control.outerHTML.slice(0, 140));
      });
      const decorativeArt = [...document.querySelectorAll("canvas, [data-matter-field-host], .recovery-art, .verification-art")];
      return {
        h1Count: headings.filter((heading) => heading.level === 1).length,
        firstLevel: headings[0]?.level || 0,
        jumps,
        hiddenFocusable,
        prohibitedCompletionNames: document.querySelectorAll('i[aria-label], .is-done:not([aria-hidden="true"])').length,
        exposedDecorativeArt: decorativeArt
          .filter((element) => element.getAttribute("aria-hidden") !== "true" && !element.closest('[aria-hidden="true"]'))
          .map((element) => element.outerHTML.slice(0, 140)),
      };
    });

    expect(semantics.h1Count, `${name} must expose one page-level heading`).toBe(1);
    expect(semantics.firstLevel, `${name} must begin its visible heading order at h1`).toBe(1);
    expect(semantics.jumps, `${name} skips a visible heading level`).toEqual([]);
    expect(semantics.hiddenFocusable, `${name} exposes focus inside aria-hidden content`).toEqual([]);
    expect(semantics.prohibitedCompletionNames, `${name} contains prohibited completion-icon ARIA`).toBe(0);
    expect(semantics.exposedDecorativeArt, `${name} exposes decorative artwork`).toEqual([]);
  }
});

test("all public pages reflow without horizontal overflow at the 200%-equivalent width", async ({ page }) => {
  test.setTimeout(120_000);
  await mockPublicBoundaries(page);
  await page.setViewportSize({ width: 720, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const [name, url, status = 200] of PUBLIC_PAGES) {
    await openPublicPage(page, url, status);
    const reflow = await page.evaluate(() => ({
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    expect(reflow.documentWidth, `${name} document overflows at 720px`).toBeLessThanOrEqual(reflow.viewportWidth + 1);
    expect(reflow.bodyWidth, `${name} body overflows at 720px`).toBeLessThanOrEqual(reflow.viewportWidth + 1);
  }
});

test("every public mobile header supports keyboard entry, Escape, focus restoration, and inert closure", async ({ page }) => {
  test.setTimeout(120_000);
  await mockPublicBoundaries(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const url of PUBLIC_HEADER_PAGES) {
    const expectedStatus = url.includes("unknown-route") ? 404 : 200;
    await openPublicPage(page, url, expectedStatus);
    const toggle = page.locator("[data-mobile-nav-toggle]");
    const menu = page.locator("[data-mobile-nav]");
    await expect(toggle, `${url} menu trigger`).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toHaveAttribute("aria-hidden", "true");
    await expect(menu).toHaveAttribute("inert", "");

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toHaveAttribute("aria-hidden", "false");
    await expect(menu).not.toHaveAttribute("inert", "");
    await expect(toggle).toBeFocused();
    const firstMenuLink = menu.locator("a").first();
    await expect(firstMenuLink, `${url} renders its navigation links`).toBeVisible();
    await firstMenuLink.focus();
    await expect(firstMenuLink, `${url} exposes focusable navigation links`).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toHaveAttribute("aria-hidden", "true");
    await expect(menu).toHaveAttribute("inert", "");
    await expect(toggle).toBeFocused();
  }
});

test("public internal links and hash destinations resolve without deleted-page references", async ({ page, request }) => {
  test.setTimeout(120_000);
  await mockPublicBoundaries(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  const links = new Map();

  for (const [name, url, status = 200] of PUBLIC_PAGES) {
    await openPublicPage(page, url, status);
    const pageOrigin = new URL(page.url()).origin;
    const currentPath = new URL(page.url()).pathname;
    const currentLinks = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => anchor.href));
    for (const href of currentLinks) {
      const target = new URL(href);
      if (target.origin !== pageOrigin || target.pathname.startsWith("/api/")) continue;
      expect(target.pathname, `${name} links to a deleted page`).not.toMatch(/\/(?:legal-acceptance|unsubscribe)\.html$/i);
      if (status === 404 && target.pathname === currentPath && target.hash) {
        const hashId = decodeURIComponent(target.hash.slice(1));
        expect(await page.evaluate((id) => Boolean(document.getElementById(id)), hashId), `${target.href} has no target`).toBe(true);
        continue;
      }
      expect(PUBLIC_PATHS.has(target.pathname), `${name} links to a protected or unknown path: ${target.pathname}`).toBe(true);
      links.set(`${target.pathname}${target.search}${target.hash}`, {
        href: `${target.pathname}${target.search}${target.hash}`,
        pathname: target.pathname,
        search: target.search,
        hash: target.hash,
      });
    }
  }

  for (const target of links.values()) {
    const response = await request.get(`${target.pathname}${target.search}`);
    expect(response.status(), `${target.href} did not resolve`).toBe(200);
    if (!target.hash) continue;
    await page.goto(`${target.pathname}${target.search}`, { waitUntil: "domcontentloaded" });
    const hashId = decodeURIComponent(target.hash.slice(1));
    expect(await page.evaluate((id) => Boolean(document.getElementById(id)), hashId), `${target.href} has no target`).toBe(true);
  }

  await page.goto("/paralegal-admission.html", { waitUntil: "domcontentloaded" });
  const admissionDestinations = await page.locator(".home-footer__directory a").evaluateAll((anchors) => (
    anchors.map((anchor) => `${new URL(anchor.href).pathname}${new URL(anchor.href).hash}`)
  ));
  expect(admissionDestinations).toEqual(expect.arrayContaining([
    "/index.html#how",
    "/index.html#for-attorneys",
    "/index.html#for-paralegals",
  ]));
});

test("Help links remain public and account-state copy remains truthful", async ({ page }) => {
  await mockPublicBoundaries(page);
  for (const url of ["/help.html", "/paralegalhelp.html"]) {
    await openPublicPage(page, url);
    const pageOrigin = new URL(page.url()).origin;
    const helpTargets = await page.locator("main a[href]").evaluateAll((anchors) => anchors.map((anchor) => {
      const target = new URL(anchor.href);
      return { origin: target.origin, pathname: target.pathname };
    }));
    for (const target of helpTargets) {
      expect(target.origin).toBe(pageOrigin);
      expect(PUBLIC_PATHS.has(target.pathname), `${url} points Help readers into protected UI`).toBe(true);
    }
  }

  await openPublicPage(page, "/browse-paralegals.html");
  await expect(page.locator("#authBlocker")).toContainText("You can browse and filter freely.");
  await expect(page.locator("#authBlocker")).toContainText("Sign in to open full profiles or send an inquiry.");

  await page.route("**/api/auth/verify-email", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  }));
  await openPublicPage(page, "/verify-email.html?token=phase-nine");
  await expect(page.locator("#verificationTitle")).toHaveText("Your email is verified.");
  await expect(page.locator("#verificationStatus")).toHaveText(
    "Your application is under review, and we’ll contact you when your LPC account is ready."
  );
  await expect(page.getByRole("link", { name: "Return home" })).toBeVisible();
  await expect(page.getByRole("link", { name: /sign in/i })).toHaveCount(0);

  await openPublicPage(page, "/signup.html");
  const confirmationCopy = await page.locator("#signupConfirmation").textContent();
  expect(confirmationCopy).toContain("Your submission is already under review.");
  expect(confirmationCopy).toContain("Verify your email so we can confirm the address for account notices.");
  expect(confirmationCopy).not.toMatch(/review begins|continue to sign in|go to sign in/i);
});

test("focus indicators and selected states remain perceivable beyond thin borders", async ({ page }) => {
  await mockPublicBoundaries(page);
  await page.setViewportSize({ width: 1366, height: 900 });

  await openPublicPage(page, "/index.html");
  await expectStrongFocus(page.locator(".home-nav--desktop a").first(), [252, 251, 248], "homepage header link");

  await openPublicPage(page, "/privacy.html");
  await expectStrongFocus(page.locator(".legal-document a").first(), [255, 255, 255], "legal document link");

  await openPublicPage(page, "/browse-paralegals.html");
  await expectStrongFocus(page.locator("#sortMenuTrigger"), [255, 255, 255], "Browse sort trigger");
  await page.locator("#filterToggle").click();
  await expectStrongFocus(page.locator("#specialtyInput"), [255, 255, 255], "Browse filter field");
  await page.locator("#sortMenuTrigger").click();
  const selectedSort = page.locator('#sortMenuOptions [aria-selected="true"]');
  const unselectedSort = page.locator('#sortMenuOptions [aria-selected="false"]').first();
  const sortStates = await Promise.all([selectedSort, unselectedSort].map((locator) => locator.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    selected: element.getAttribute("aria-selected"),
  }))));
  expect(sortStates[0].selected).toBe("true");
  expect(sortStates[0].background).not.toBe(sortStates[1].background);

  await openPublicPage(page, "/help.html");
  await expectStrongFocus(page.locator(".help-directory nav a").first(), [255, 255, 255], "Help directory link");

  await openPublicPage(page, "/login.html");
  await expectStrongFocus(page.locator("#email"), [255, 255, 255], "login email field");

  await openPublicPage(page, "/signup.html");
  await expectStrongFocus(page.locator("#fullName"), [255, 255, 255], "signup name field");
  const roleStates = await page.locator(".seg button").evaluateAll((buttons) => buttons.map((button) => ({
    background: getComputedStyle(button).backgroundColor,
    pressed: button.getAttribute("aria-pressed"),
  })));
  expect(roleStates.find(({ pressed }) => pressed === "true")?.background)
    .not.toBe(roleStates.find(({ pressed }) => pressed === "false")?.background);

  await openPublicPage(page, "/attorney-faq.html");
  await expectStrongFocus(page.locator(".faq-cta__button"), [13, 23, 35], "FAQ call to action");

  await openPublicPage(page, "/phase-nine-unknown-route", 404);
  await expectStrongFocus(page.locator(".error-actions a").first(), [255, 255, 255], "404 action");
});

test("reduced motion disables public navigation transitions and smooth scrolling", async ({ page }) => {
  await mockPublicBoundaries(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });

  for (const url of ["/index.html", "/privacy.html", "/help.html"]) {
    await openPublicPage(page, url);
    const motion = await page.evaluate(() => {
      const menu = document.querySelector("[data-mobile-nav]");
      const menuStyle = getComputedStyle(menu);
      return {
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        transitionDuration: menuStyle.transitionDuration,
      };
    });
    expect(motion.scrollBehavior, `${url} retains smooth scrolling`).toBe("auto");
    expect(motion.transitionDuration.split(",").every((duration) => parseFloat(duration) <= 0.00001), `${url} menu still animates`).toBe(true);
  }
});
