const { test, expect } = require("playwright/test");

const PHASE_THREE_VIEWPORTS = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 900 },
  { width: 1920, height: 1080 },
];

const PROFILE_ID = "64d2f9a72f3b4c5d6e7f8091";
const PROFILE_VERSION = "2026-08-28T12:00:00.000Z";

function directoryProfile(overrides = {}) {
  const id = overrides.id || PROFILE_ID;
  const title = overrides.title || "Alexandria Montgomery-Worthington the Third";
  const canonicalUrl = `/profile-paralegal.html?paralegalId=${id}`;
  return {
    _id: id,
    yearsExperience: overrides.yearsExperience ?? 12,
    avatarURL: overrides.avatarURL ?? "/phase-three-missing-portrait.jpg",
    presentation: {
      schemaVersion: 1,
      source: "server_projection",
      kind: "card",
      objectType: "profile",
      object: { id, title, canonicalUrl, version: PROFILE_VERSION },
      status: { code: "active", label: "Available", tone: "success" },
      attention: null,
      relationship: { code: "public", label: "Public profile" },
      readOnly: true,
      actions: [],
      details: [
        { label: "Location", value: "Washington, District of Columbia" },
        { label: "Practice areas", value: "Administrative Law, Intellectual Property" },
      ],
      summary: "Supports complex multi-jurisdiction litigation, discovery, and detailed filing calendars for growing legal teams.",
      freshness: {
        state: "current",
        sourceUpdatedAt: PROFILE_VERSION,
        projectedAt: PROFILE_VERSION,
      },
      links: { self: canonicalUrl },
    },
  };
}

async function mockDirectory(page, { user = null, responseMode = "populated" } = {}) {
  let mode = responseMode;
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user }),
    })
  );
  await page.route("**/api/csrf", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ csrfToken: "public-directory-phase-three" }),
    })
  );
  await page.route("**/api/cases/my-active", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    })
  );
  await page.route("**/phase-three-missing-portrait.jpg", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "missing" })
  );
  await page.route("**/public/paralegals?**", async (route) => {
    if (mode === "loading") {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (mode === "error") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Paralegal profiles are temporarily unavailable." }),
      });
      return;
    }
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") || 1);
    const items = mode === "empty" ? [] : [directoryProfile()];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items,
        total: mode === "empty" ? 0 : 11,
        pages: mode === "empty" ? 1 : 2,
        page: pageNumber,
      }),
    });
  });
  return {
    setMode(nextMode) {
      mode = nextMode;
    },
  };
}

async function openPopulatedDirectory(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto("/browse-paralegals.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".paralegal-card")).toHaveCount(1);
}

test("directory cards, prompt, and navigation stay inside every required viewport", async ({ page }) => {
  await mockDirectory(page);

  for (const viewport of PHASE_THREE_VIEWPORTS) {
    await openPopulatedDirectory(page, viewport);

    const layout = await page.evaluate(() => {
      const card = document.querySelector(".paralegal-card").getBoundingClientRect();
      const photo = document.querySelector(".paralegal-card img").getBoundingClientRect();
      const filter = document.getElementById("filterToggle").getBoundingClientRect();
      const previous = document.getElementById("prevPage").getBoundingClientRect();
      const next = document.getElementById("nextPage").getBoundingClientRect();
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        card: { left: card.left, right: card.right },
        photo: { width: photo.width, height: photo.height },
        targets: [filter, previous, next].map((rect) => ({ width: rect.width, height: rect.height })),
      };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.card.left).toBeGreaterThanOrEqual(0);
    expect(layout.card.right).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(Math.abs(layout.photo.width - layout.photo.height)).toBeLessThanOrEqual(1);
    layout.targets.forEach((target) => {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    });
    if (viewport.width === 320) expect(layout.photo.width).toBe(112);
    if (viewport.width === 390) expect(layout.photo.width).toBe(150);

    const image = page.locator(".paralegal-card img");
    await expect(image).toHaveAttribute("src", "/assets/avatar-placeholder.svg");
    await expect.poll(() => image.evaluate((node) => node.complete && node.naturalWidth > 0)).toBe(true);

    const profileLink = page.locator(".profile-name-link");
    await profileLink.focus();
    await profileLink.press("Enter");
    const prompt = page.locator("#authBlocker");
    const card = prompt.locator(".auth-blocker__card");
    await expect(prompt).toHaveAttribute("aria-hidden", "false");
    await expect(card).toContainText("You can browse and filter freely.");
    await expect(card).toContainText("Sign in to open full profiles or send an inquiry.");
    await expect(card.getByRole("link", { name: "Sign in", exact: true })).toBeFocused();
    const promptLayout = await card.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const primary = node.querySelector(".btn.primary");
      const secondary = node.querySelector(".btn.secondary");
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: document.documentElement.clientWidth,
        primaryBackground: getComputedStyle(primary).backgroundColor,
        navy: getComputedStyle(document.documentElement).getPropertyValue("--navy").trim(),
        targets: [primary, secondary].map((control) => control.getBoundingClientRect().height),
      };
    });
    expect(promptLayout.left).toBeGreaterThanOrEqual(0);
    expect(promptLayout.right).toBeLessThanOrEqual(promptLayout.viewportWidth);
    expect(promptLayout.primaryBackground).toBe("rgb(39, 57, 77)");
    promptLayout.targets.forEach((height) => expect(height).toBeGreaterThanOrEqual(44));
    await page.keyboard.press("Escape");
    await expect(prompt).toHaveAttribute("aria-hidden", "true");
    await expect(profileLink).toBeFocused();
  }
});

test("compact filter and pagination targets retain their behavior", async ({ page }) => {
  await mockDirectory(page);
  await openPopulatedDirectory(page, { width: 320, height: 844 });

  const filterToggle = page.locator("#filterToggle");
  const filterPanel = page.locator("#filterMenu");
  await filterToggle.click();
  await expect(filterPanel).toBeVisible();
  const filterGeometry = await page.evaluate(() => {
    const panel = document.getElementById("filterMenu").getBoundingClientRect();
    const controls = [
      document.querySelector("[data-filter-close]"),
      document.getElementById("experience"),
      document.getElementById("specialtyInput"),
      document.getElementById("stateInput"),
      document.getElementById("applyFilters"),
      document.getElementById("clearFilters"),
    ];
    return {
      panel: { left: panel.left, right: panel.right },
      viewportWidth: document.documentElement.clientWidth,
      heights: controls.map((control) => control.getBoundingClientRect().height),
    };
  });
  expect(filterGeometry.panel.left).toBeGreaterThanOrEqual(0);
  expect(filterGeometry.panel.right).toBeLessThanOrEqual(filterGeometry.viewportWidth);
  filterGeometry.heights.forEach((height) => expect(height).toBeGreaterThanOrEqual(44));
  await page.locator("[data-filter-close]").click();
  await expect(filterPanel).toBeHidden();
  await expect(filterToggle).toBeFocused();

  await expect(page.locator("#prevPage")).toBeDisabled();
  await expect(page.locator("#nextPage")).toBeEnabled();
  const pageTwoRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/public/paralegals" && url.searchParams.get("page") === "2";
  });
  await page.locator("#nextPage").click();
  await pageTwoRequest;
  await expect(page.locator("#paginationLabel")).toContainText("Page 2 of 2");
  await expect(page.locator("#prevPage")).toBeEnabled();
  await expect(page.locator("#nextPage")).toBeDisabled();
});

test("loading, populated, empty, error, fallback-photo, and account-required states remain available", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const directory = await mockDirectory(page, { responseMode: "loading" });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/browse-paralegals.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#resultsStatus")).toHaveText("Loading paralegals…");
  await expect(page.locator(".paralegal-card")).toHaveCount(1);
  await expect(page.locator(".paralegal-card img")).toHaveAttribute("src", "/assets/avatar-placeholder.svg");

  directory.setMode("empty");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#resultsStatus")).toHaveText("No paralegals match your filters yet.");

  directory.setMode("error");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#resultsStatus")).toHaveText("Paralegal profiles are temporarily unavailable.");
  await expect(page.locator("#resultsStatus")).toHaveClass(/error/);

  directory.setMode("populated");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".paralegal-card")).toHaveCount(1);
  await page.locator(".profile-photo-link").click();
  await expect(page.locator("#authBlocker")).toHaveAttribute("aria-hidden", "false");
  await page.locator("#authBlocker").click({ position: { x: 2, y: 2 } });
  await expect(page.locator("#authBlocker")).toHaveAttribute("aria-hidden", "true");
});

test("signed-in public chrome cannot intercept the authenticated sidebar", async ({ page }) => {
  const user = {
    id: "phase-three-attorney",
    firstName: "Avery",
    lastName: "Counsel",
    role: "attorney",
    status: "approved",
  };
  await mockDirectory(page, { user });
  await openPopulatedDirectory(page, { width: 1366, height: 900 });

  await expect(page.locator("body")).toHaveClass(/authenticated-browse/);
  await expect(page.locator("[data-public-header]")).toBeHidden();
  await expect(page.locator("[data-public-footer]")).toBeHidden();
  await expect(page.locator("[data-auth-sidebar]")).toBeVisible();
  const shell = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    headerDisplay: getComputedStyle(document.querySelector("[data-public-header]")).display,
    footerDisplay: getComputedStyle(document.querySelector("[data-public-footer]")).display,
  }));
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.viewportWidth);
  expect(shell.headerDisplay).toBe("none");
  expect(shell.footerDisplay).toBe("none");

  const trigger = page.locator(".authenticated-browse-sidebar .lpc-sidebar-profile-trigger");
  const menu = page.locator("body > .lpc-sidebar-account-menu");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".lpc-account-menu-user-name")).toHaveText("Avery Counsel");
});
