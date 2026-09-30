const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

async function waitForFoundation(page) {
  await expect(page).not.toHaveURL(/login\.html|paralegal-admission\.html/);
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
}

async function waitForRoute(page, name) {
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", name);
}

function json(route, payload, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

test("first-time guidance completes explicitly and never strands primary navigation", async ({ page }) => {
  const completed = {
    paralegalTourCompleted: false,
    paralegalProfileTourCompleted: false,
  };
  const patches = [];
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.user.onboarding = { ...completed };
    return json(route, payload, response.status());
  });
  await page.route("**/api/users/me/onboarding", async (route) => {
    if (route.request().method() === "GET") return json(route, { onboarding: { ...completed } });
    const patch = route.request().postDataJSON();
    patches.push(patch);
    Object.assign(completed, patch);
    return json(route, { onboarding: { ...completed } });
  });

  try {
    await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
    await waitForFoundation(page);
    const workspaceTour = page.locator('[data-v2-onboarding-dialog="workspace"]');
    await expect(workspaceTour).toBeVisible();
    await workspaceTour.getByRole("button", { name: "Skip tour" }).click();
    await expect.poll(() => patches).toContainEqual({ paralegalTourCompleted: true });

    await page.getByRole("link", { name: "Profile Settings" }).click();
    await waitForRoute(page, "settings");
    const profileTour = page.locator('[data-v2-onboarding-dialog="profile"]');
    await expect(profileTour).toBeVisible();
    await profileTour.getByRole("button", { name: "Skip tour" }).click();
    await expect.poll(() => patches).toContainEqual({ paralegalProfileTourCompleted: true });

    await page.getByRole("link", { name: "LPC Home", exact: true }).click();
    await waitForRoute(page, "home");
    await expect(page.locator("[data-v2-onboarding-dialog][open]")).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("V2 navigation changes only the view and preserves shell state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
  await waitForFoundation(page);

  await page.evaluate(() => {
    const shell = window.__LPC_PARALEGAL_V2__.shell;
    shell.sidebar.dataset.testIdentity = "sidebar-instance";
    shell.header.dataset.testIdentity = "header-instance";
    shell.assistant.dataset.testIdentity = "assistant-instance";
    window.__v2InitialNavigationEntries = performance.getEntriesByType("navigation").length;
  });

  const closedFrame = await page.locator("[data-v2-persistent='application-frame']").boundingBox();
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("body")).toHaveClass(/support-drawer-open/);
  const assistantBox = await page.locator("[data-v2-persistent='assistant']").boundingBox();
  expect(assistantBox.width).toBe(420);
  await expect.poll(async () => {
    const frame = await page.locator("[data-v2-persistent='application-frame']").boundingBox();
    return Math.round(closedFrame.width - frame.width);
  }).toBe(Math.round(assistantBox.width));
  const openFrame = await page.locator("[data-v2-persistent='application-frame']").boundingBox();
  expect(Math.abs(assistantBox.x - (openFrame.x + openFrame.width))).toBeLessThanOrEqual(1);
  const threadBox = await page.locator(".support-thread").boundingBox();
  expect(Math.abs((threadBox.x + threadBox.width) - (assistantBox.x + assistantBox.width))).toBeLessThanOrEqual(1);

  const assistantBubble = page.locator(".support-message--assistant .support-message-bubble").first();
  await expect(assistantBubble).toBeVisible();
  expect(await assistantBubble.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe("0px");

  const composer = page.locator(".support-composer textarea");
  await composer.focus();
  const focusTreatment = await composer.evaluate((node) => ({
    textareaOutline: getComputedStyle(node).outlineStyle,
    shellOutline: getComputedStyle(node.closest(".support-composer-shell")).outlineStyle,
    shellOutlineWidth: getComputedStyle(node.closest(".support-composer-shell")).outlineWidth,
    shellOutlineColor: getComputedStyle(node.closest(".support-composer-shell")).outlineColor,
  }));
  expect(focusTreatment).toEqual({ textareaOutline: "none", shellOutline: "solid", shellOutlineWidth: "2px", shellOutlineColor: "rgb(55, 105, 177)" });

  const openBrowse = async () => {
    const link = page.locator(".v2-nav").getByRole("link", { name: /^Browse matters$/i });
    if (!await link.isVisible()) await page.locator('.v2-nav summary').filter({ hasText: 'More' }).click();
    await link.click();
  };
  await openBrowse();
  await expect(page).toHaveURL(/#\/browse(?:\?|$)/);
  await waitForRoute(page, "browse");
  await expect(page.getByRole("heading", { level: 1, name: "Browse matters", exact: true })).toBeVisible();
  const browseUrl = page.url();
  await expect(page.locator("body")).toHaveClass(/support-drawer-open/);

  await page.getByRole("link", { name: "Profile Settings" }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await waitForRoute(page, "settings");
  await page.goBack();
  await expect(page).toHaveURL(browseUrl);
  await waitForRoute(page, "browse");
  await page.goForward();
  await expect(page).toHaveURL(/#\/settings$/);
  await waitForRoute(page, "settings");

  await page.addStyleTag({ content: "[data-v2-rendered-route] { min-height: 1800px !important; }" });
  await page.getByRole("link", { name: "LPC Home", exact: true }).click();
  await waitForRoute(page, "home");
  const homeScrollPosition = await page.locator("[data-v2-route-outlet]").evaluate((node) => {
    node.scrollTop = 420;
    return Math.round(node.scrollTop);
  });
  expect(homeScrollPosition).toBe(420);
  await openBrowse();
  await waitForRoute(page, "browse");
  await page.locator("[data-v2-route-outlet]").evaluate((node) => { node.scrollTop = 90; });
  await page.getByRole("link", { name: "LPC Home", exact: true }).click();
  await waitForRoute(page, "home");
  await expect.poll(() => page.locator("[data-v2-route-outlet]").evaluate((node) => Math.round(node.scrollTop))).toBe(homeScrollPosition);

  const identity = await page.evaluate(() => ({
    sidebar: document.querySelector('[data-v2-persistent="sidebar"]')?.dataset.testIdentity,
    header: document.querySelector('[data-v2-persistent="header"]')?.dataset.testIdentity,
    assistant: document.querySelector('[data-v2-persistent="assistant"]')?.dataset.testIdentity,
    navigations: performance.getEntriesByType("navigation").length,
    initialNavigations: window.__v2InitialNavigationEntries,
  }));
  expect(identity).toEqual({
    sidebar: "sidebar-instance",
    header: "header-instance",
    assistant: "assistant-instance",
    navigations: identity.initialNavigations,
    initialNavigations: identity.initialNavigations,
  });
});

test("primary navigation keeps a stable painted view and a shared content origin", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  let releaseBrowse;
  const browseGate = new Promise((resolve) => { releaseBrowse = resolve; });
  await page.route("**/api/jobs/open?*", async (route) => {
    await browseGate;
    await route.continue();
  });
  await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
  await waitForFoundation(page);

  const homeOrigin = await page.locator("[data-v2-route-outlet]").evaluate((node) => node.getBoundingClientRect().x);
  await page.locator("[data-v2-route-outlet]").evaluate((outlet) => {
    window.__v2MinimumRouteChildren = outlet.childElementCount;
    window.__v2RouteObserver = new MutationObserver(() => {
      window.__v2MinimumRouteChildren = Math.min(window.__v2MinimumRouteChildren, outlet.childElementCount);
    });
    window.__v2RouteObserver.observe(outlet, { childList: true });
  });

  const browseLink = page.locator(".v2-nav").getByRole("link", { name: /^Browse matters$/i });
  if (!await browseLink.isVisible()) await page.locator('.v2-nav summary').filter({ hasText: 'More' }).click();
  await browseLink.click();
  await expect(page).toHaveURL(/#\/browse$/);
  await expect(page.locator("[data-v2-home]")).toBeVisible();
  await expect(page.locator(".v2-browse--loading")).toHaveCount(0);
  await expect(page.locator("[data-v2-route-outlet]")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("[data-v2-route-outlet]")).not.toBeFocused();

  releaseBrowse();
  await waitForRoute(page, "browse");
  await expect(page.locator("[data-v2-browse]")).toBeVisible();
  const browseOrigin = await page.locator("[data-v2-route-outlet]").evaluate((node) => node.getBoundingClientRect().x);

  await page.getByRole("link", { name: "My Matters & Applications" }).click();
  await waitForRoute(page, "work");
  const workOrigin = await page.locator("[data-v2-route-outlet]").evaluate((node) => node.getBoundingClientRect().x);

  await page.getByRole("link", { name: "Profile Settings" }).click();
  await waitForRoute(page, "settings");
  const settingsOrigin = await page.locator("[data-v2-route-outlet]").evaluate((node) => node.getBoundingClientRect().x);

  const continuity = await page.evaluate(() => {
    window.__v2RouteObserver?.disconnect();
    return {
      minimumChildren: window.__v2MinimumRouteChildren,
      navigationEntries: performance.getEntriesByType("navigation").length,
    };
  });
  expect(continuity.minimumChildren).toBeGreaterThanOrEqual(1);
  expect(continuity.navigationEntries).toBe(1);
  [browseOrigin, workOrigin, settingsOrigin].forEach((origin) => {
    expect(Math.abs(origin - homeOrigin)).toBeLessThanOrEqual(1);
  });
});

test("wheel gestures over the navigation bar scroll the active view and acknowledge an empty page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
  await waitForFoundation(page);

  const sidebar = page.locator('[data-v2-persistent="sidebar"]');
  const outlet = page.locator("[data-v2-route-outlet]");
  const sidebarBefore = await sidebar.boundingBox();
  const tallViewStyle = await page.addStyleTag({ content: "[data-v2-route-outlet] > :first-child { min-height: 1800px !important; }" });
  await sidebar.hover({ position: { x: 90, y: 40 } });
  await page.mouse.wheel(0, 420);
  await expect.poll(() => outlet.evaluate((node) => Math.round(node.scrollTop))).toBeGreaterThan(0);
  expect((await sidebar.boundingBox()).y).toBe(sidebarBefore.y);

  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  const beforeAssistantScroll = await outlet.evaluate((node) => node.scrollTop);
  await sidebar.hover({ position: { x: 90, y: 40 } });
  await page.mouse.wheel(0, 240);
  await expect.poll(() => outlet.evaluate((node) => node.scrollTop)).toBeGreaterThan(beforeAssistantScroll);
  expect((await sidebar.boundingBox()).y).toBe(sidebarBefore.y);

  await tallViewStyle.evaluate((style) => style.remove());
  await page.evaluate(() => {
    const view = document.querySelector("[data-v2-route-outlet]");
    view.scrollTop = 0;
    view.firstElementChild.replaceChildren();
    view.firstElementChild.style.minHeight = "0";
    view.firstElementChild.style.height = "1px";
  });
  await sidebar.hover({ position: { x: 90, y: 40 } });
  await page.mouse.wheel(0, 160);
  await expect(outlet).toHaveClass(/v2-view--empty-scroll-forward/);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(240);
  await page.mouse.wheel(0, -160);
  await expect(outlet).not.toHaveClass(/v2-view--empty-scroll-(?:forward|back)/);
});

test("desktop sidebar collapses without replacing the workspace and becomes a keyboard-operable mobile menu", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
  await waitForFoundation(page);
  const bar = page.locator('[data-v2-persistent="sidebar"]');
  const frame = page.locator('[data-v2-persistent="application-frame"]');
  const grip = page.getByRole('button', { name: 'Collapse sidebar', exact: true });
  expect(await bar.boundingBox()).toMatchObject({ x: 0, y: 0, width: 230, height: 900 });
  expect(await frame.boundingBox()).toMatchObject({ x: 230, y: 0, width: 1210, height: 900 });
  await bar.evaluate(node => { node.dataset.testInstance = 'retained-left-sidebar'; });
  await grip.click();
  await expect(page.locator('body')).toHaveClass(/v2-sidebar-collapsed/);
  await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await bar.boundingBox()).width).toBe(64);
  await expect.poll(async () => (await frame.boundingBox()).x).toBe(64);
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(grip).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await bar.boundingBox()).width).toBe(230);
  await expect(bar).toHaveAttribute('data-test-instance', 'retained-left-sidebar');
  const browse = bar.getByRole('link', { name: /^Browse matters$/i });
  if (!await browse.isVisible()) await bar.locator('summary').filter({ hasText: 'More' }).click();
  await browse.click();
  await waitForRoute(page, 'browse');
  await expect(page.locator('.v2-nav').getByRole('link', { name: /^Browse matters$/i })).toHaveAttribute('aria-current', 'page');
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  await menu.click();
  await expect.poll(async () => (await bar.boundingBox()).width).toBe(340);
  const navigation = page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
  expect(await navigation.evaluate(node => node.matches(':modal'))).toBe(true);
  await expect(browse).toBeFocused();
  await page.locator('[data-v2-route-outlet]').evaluate(node => node.focus());
  await expect(browse).toBeFocused();
  await bar.getByRole('link', { name: 'Profile Settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  await waitForRoute(page, 'settings');
  await expect(page.locator('body')).not.toHaveClass(/v2-nav-open/);
  await expect(navigation).not.toBeVisible();
  await expect(page.locator('[data-v2-route-outlet]')).toBeFocused();
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
});

test("V2 shell remains bounded and operable at every required width", async ({ page }) => {
  await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
  await waitForFoundation(page);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await page.locator('[data-v2-persistent="application-frame"]').boundingBox()).x).toBe(viewport.width <= 900 ? 0 : 230);
    const geometry = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      };
      return {
        viewport: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        sidebar: rect('[data-v2-persistent="sidebar"]'),
        header: rect("[data-v2-home] :is(.lc-heading, .ld-heading)"),
        frame: rect("[data-v2-persistent='application-frame']"),
        outlet: rect("[data-v2-route-outlet]"),
        menu: rect("[data-v2-mobile-menu]"),
      };
    });
    expect(geometry.scrollWidth, `${viewport.width}px horizontal overflow`).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.frame.x, `${viewport.width}px workspace origin`).toBe(viewport.width <= 900 ? 0 : 230);
    expect(geometry.frame.y, `${viewport.width}px outer frame`).toBe(0);
    expect(geometry.frame.height, `${viewport.width}px frame height`).toBeCloseTo(viewport.height, 1);
    expect(geometry.header.height, `${viewport.width}px Home header height`).toBeCloseTo(viewport.width <= 900 ? 88 : 84, 1);
    expect(geometry.outlet.y, `${viewport.width}px content inside frame`).toBeGreaterThanOrEqual(geometry.frame.y);
    if (viewport.width > 900) expect(geometry.sidebar.width, `${viewport.width}px sidebar width`).toBe(230);

    if (viewport.width <= 900) {
      expect(geometry.menu.width, `${viewport.width}px menu width`).toBeGreaterThanOrEqual(44);
      expect(geometry.menu.height, `${viewport.width}px menu height`).toBeGreaterThanOrEqual(44);
      await page.locator("[data-v2-mobile-menu]").click();
      await expect(page.locator("body")).toHaveClass(/v2-nav-open/);
      await expect(page.locator("[data-v2-mobile-menu]")).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(page.locator("body")).not.toHaveClass(/v2-nav-open/);
      await expect(page.locator("[data-v2-mobile-menu]")).toBeFocused();
    }
  }
});

test("sidebar Search expands for typing and keeps results adjacent without moving persistent tools", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
  await waitForFoundation(page);

  const searchForm = page.locator("[data-v2-search-form]");
  const searchInput = page.getByRole("combobox", { name: "Search your workspace" });
  const searchIcon = searchForm.locator("svg");
  await expect(searchIcon).toHaveCSS("width", "20px");
  await expect(searchIcon).toHaveCSS("min-width", "20px");
  await page.getByRole("button", { name: "View notifications" }).hover();
  await expect(page.getByRole("button", { name: "View notifications" })).toHaveAttribute("data-tooltip", "Notifications");
  await expect.poll(() => page.getByRole("button", { name: "View notifications" }).evaluate((node) => getComputedStyle(node, "::after").opacity)).toBe("1");
  await page.getByRole("button", { name: "Open LPC Assistant" }).hover();
  await expect(page.getByRole("button", { name: "Open LPC Assistant" })).toHaveAttribute("data-tooltip", "LPC Assistant");
  await expect.poll(() => page.getByRole("button", { name: "Open LPC Assistant" }).evaluate((node) => getComputedStyle(node, "::after").opacity)).toBe("1");
  await expect(searchIcon).toHaveCSS("width", "20px");

  const before = await page.locator("[data-v2-persistent='header']").boundingBox();
  const collapsed = await searchForm.boundingBox();
  await searchForm.hover();
  await expect.poll(async () => (await searchForm.boundingBox())?.width).toBeGreaterThan(200);
  await searchInput.click();
  await expect(searchInput).toBeFocused();
  await expect(page.locator("[data-v2-search-panel]")).toBeHidden();
  const after = await page.locator("[data-v2-persistent='header']").boundingBox();
  expect(after).toEqual(before);
  expect(collapsed.width).toBeLessThanOrEqual(46);
  await searchInput.fill("ma");
  await expect(page.locator("[data-v2-search-panel]")).toBeVisible();
  const panel = await page.locator("[data-v2-search-panel]").boundingBox();
  expect(panel.width).toBeLessThanOrEqual(440);
  const rail = await page.locator('[data-v2-persistent="sidebar"]').boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(rail.x + rail.width);
  expect(panel.y).toBeGreaterThanOrEqual(8);
  expect(panel.x + panel.width).toBeLessThanOrEqual(1440 - 8);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-v2-search-panel]")).toBeHidden();
  await expect(searchInput).toBeFocused();
});

test("V2 foundation has no detectable WCAG A/AA violations in its primary shell states", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
  await waitForFoundation(page);
  const closed = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(closed.violations).toEqual([]);

  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  const open = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(open.violations).toEqual([]);
});

test("V2 leaves the protected shell when another tab clears the session snapshot", async ({ page }) => {
  await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
  await waitForFoundation(page);
  await page.evaluate(() => {
    window.dispatchEvent(new StorageEvent("storage", {
      key: "lpc_user",
      oldValue: JSON.stringify({ id: "previous-session" }),
      newValue: null,
      storageArea: localStorage,
    }));
  });
  await expect(page).toHaveURL(/login\.html$/);
});
