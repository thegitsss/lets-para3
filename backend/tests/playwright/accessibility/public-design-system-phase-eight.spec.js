const { test, expect } = require("playwright/test");
const { directoryProfile } = require("./public-directory-fixture");

const VIEWPORTS = [
  { name: "compact", width: 320, height: 844 },
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1366, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
];

const PUBLIC_PAGES = [
  { name: "Home", url: "/index.html", chrome: true },
  { name: "Browse", url: "/browse-paralegals.html", chrome: true },
  { name: "Login", url: "/login.html" },
  { name: "Signup", url: "/signup.html" },
  { name: "Forgot password", url: "/forgot-password.html" },
  { name: "Reset password", url: "/reset-password.html?token=phase-eight" },
  { name: "Verify email", url: "/verify-email.html?token=phase-eight" },
  { name: "Privacy", url: "/privacy.html", chrome: true },
  { name: "Terms", url: "/terms.html", chrome: true },
  { name: "Accessibility", url: "/accessibility.html", chrome: true },
  { name: "Contact", url: "/contact.html", chrome: true },
  { name: "Admission", url: "/paralegal-admission.html", chrome: true },
  { name: "Attorney FAQ", url: "/attorney-faq.html", chrome: true },
  { name: "Paralegal FAQ", url: "/paralegal-faq.html", chrome: true },
  { name: "Attorney help", url: "/help.html", chrome: true },
  { name: "Paralegal help", url: "/paralegalhelp.html", chrome: true },
  { name: "404", url: "/phase-eight/missing-page", chrome: true, status: 404 },
];

const ALLOWED_ACTION_ROLES = ["primary", "secondary", "text", "icon", "pagination", "destructive"];
const WORKFLOW_ART_SELECTOR = ".workflow-canvas, .workflow-mobile-canvas, .workflow-mobile-stage__canvas";

async function settle(page, item) {
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => document.fonts?.ready);
  if (item.chrome) {
    await expect(page.locator("body")).toHaveClass(/public-site-chrome/);
    await expect(page.locator(".home-header")).toBeAttached();
    await expect(page.locator(".home-footer")).toBeAttached();
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function pageContract(page) {
  return page.evaluate(({ allowedRoles, workflowArtSelector }) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const buttons = Array.from(document.querySelectorAll("button"));
    const unclassifiedButtons = buttons.filter((button) => {
      if (!visible(button)) return false;
      if (button.matches('[tabindex="-1"]') && button.closest(workflowArtSelector)) return false;
      return !button.hasAttribute("data-public-action");
    }).map((button) => ({
      text: button.textContent.trim().replace(/\s+/g, " ").slice(0, 80),
      className: button.className,
      ariaLabel: button.getAttribute("aria-label"),
    }));
    const invalidRoles = Array.from(document.querySelectorAll("[data-public-action]"))
      .filter((element) => !allowedRoles.includes(element.dataset.publicAction))
      .map((element) => element.dataset.publicAction);
    const undersizedMobileActions = innerWidth > 960 ? [] : Array.from(document.querySelectorAll("[data-public-action]"))
      .filter(visible)
      .filter((element) => element.getBoundingClientRect().height < 43.5)
      .map((element) => ({
        role: element.dataset.publicAction,
        text: element.textContent.trim().replace(/\s+/g, " ").slice(0, 80),
        height: element.getBoundingClientRect().height,
        className: element.className,
      }));
    const goldPrimaryActions = Array.from(document.querySelectorAll('[data-public-action="primary"]'))
      .filter(visible)
      .filter((element) => {
        const style = getComputedStyle(element);
        return ["rgb(180, 151, 90)", "rgb(162, 134, 77)", "rgb(156, 130, 76)"].includes(style.backgroundColor);
      })
      .map((element) => element.textContent.trim().replace(/\s+/g, " "));
    return {
      hasDesignSystem: Boolean(document.querySelector('link[href*="public-design-system.css"]')),
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyFont: getComputedStyle(document.body).fontFamily,
      unclassifiedButtons,
      invalidRoles,
      undersizedMobileActions,
      goldPrimaryActions,
    };
  }, { allowedRoles: ALLOWED_ACTION_ROLES, workflowArtSelector: WORKFLOW_ART_SELECTOR });
}

for (const viewport of VIEWPORTS) {
  test(`Phase 8 public system remains consistent at ${viewport.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ reducedMotion: "reduce" });

    const chromeSamples = [];
    for (const item of PUBLIC_PAGES) {
      const response = await page.goto(item.url, { waitUntil: "domcontentloaded" });
      expect(response.status(), `${item.name} response`).toBe(item.status || 200);
      await settle(page, item);

      const contract = await pageContract(page);
      expect(contract.hasDesignSystem, `${item.name} does not load the public design system`).toBe(true);
      expect(contract.scrollWidth, `${item.name} overflows at ${viewport.name}`).toBeLessThanOrEqual(contract.width + 1);
      expect(contract.bodyFont, `${item.name} lost Sarabun body typography`).toContain("Sarabun");
      expect(contract.unclassifiedButtons, `${item.name} has visible buttons without a documented role`).toEqual([]);
      expect(contract.invalidRoles, `${item.name} uses an undocumented action role`).toEqual([]);
      expect(contract.undersizedMobileActions, `${item.name} has a mobile action below 44px`).toEqual([]);
      expect(contract.goldPrimaryActions, `${item.name} uses gold as a primary-action fill`).toEqual([]);

      if (!item.chrome) continue;
      const chrome = await page.evaluate(() => {
        const header = document.querySelector(".home-header");
        const footer = document.querySelector(".home-footer");
        const menu = document.querySelector(".mobile-nav-toggle");
        const accessibility = footer.querySelector(".accessibility-toggle");
        const headerRect = header.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const accessibilityRect = accessibility.getBoundingClientRect();
        const menuStyle = getComputedStyle(menu);
        return {
          headerHeight: headerRect.height,
          footerBackground: getComputedStyle(footer).backgroundColor,
          footerFont: getComputedStyle(footer).fontFamily,
          menuWidth: menuRect.width || parseFloat(menuStyle.width),
          menuHeight: menuRect.height || parseFloat(menuStyle.height),
          accessibilityWidth: accessibilityRect.width,
          accessibilityHeight: accessibilityRect.height,
          accessibilityFont: getComputedStyle(accessibility).fontSize,
        };
      });
      chromeSamples.push({ name: item.name, ...chrome });
    }

    const expectedHeaderHeight = viewport.width <= 960 ? 66 : 72;
    chromeSamples.forEach((sample) => {
      expect(Math.abs(sample.headerHeight - expectedHeaderHeight), `${sample.name} header height`).toBeLessThanOrEqual(1);
      expect(sample.footerBackground, `${sample.name} footer surface`).toBe("rgb(7, 19, 31)");
      expect(sample.footerFont, `${sample.name} footer type`).toContain("Sarabun");
      expect(sample.menuWidth, `${sample.name} menu width`).toBeGreaterThanOrEqual(44);
      expect(sample.menuHeight, `${sample.name} menu height`).toBeGreaterThanOrEqual(44);
      expect(sample.accessibilityHeight, `${sample.name} Accessibility height`).toBeGreaterThanOrEqual(44);
      expect(sample.accessibilityWidth, `${sample.name} Accessibility width`).toBeGreaterThanOrEqual(76);
    });
    expect(new Set(chromeSamples.map((sample) => sample.accessibilityFont)).size).toBe(1);
    expect(Math.max(...chromeSamples.map((sample) => sample.accessibilityHeight)) - Math.min(...chromeSamples.map((sample) => sample.accessibilityHeight))).toBeLessThanOrEqual(1);
  });
}

test("Phase 8 preserves the shared mobile navigation behavior", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const url of ["/index.html", "/privacy.html", "/help.html"]) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page, { chrome: true });
    const toggle = page.locator(".mobile-nav-toggle");
    const nav = page.locator(".mobile-nav");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(nav).toHaveAttribute("aria-hidden", "false");
    await expect.poll(async () => {
      const linkHeights = await nav.locator("nav a").evaluateAll((links) => links.map((link) => link.getBoundingClientRect().height));
      return linkHeights.every((height) => height >= 58);
    }).toBe(true);
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
  }
});

test("Phase 8 reconciles the documented control geometries", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const samples = [
    { url: "/contact.html", selector: ".contact-content .btn", height: 48, pill: true },
    { url: "/phase-eight/control-missing", selector: ".error-action--primary", height: 48, pill: true },
    { url: "/login.html", selector: ".login-btn", height: 50, radius: 8 },
    { url: "/signup.html", selector: "#nextStepBtn", height: 50, radius: 8 },
    { url: "/forgot-password.html", selector: 'button[type="submit"]', height: 50, radius: 8 },
  ];
  for (const sample of samples) {
    await page.goto(sample.url, { waitUntil: "domcontentloaded" });
    const control = page.locator(sample.selector).first();
    await expect(control).toBeVisible();
    const geometry = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, radius: parseFloat(getComputedStyle(element).borderRadius) };
    });
    expect(geometry.height).toBeGreaterThanOrEqual(sample.height);
    if (sample.pill) expect(geometry.radius).toBeGreaterThan(20);
    if (sample.radius) expect(Math.abs(geometry.radius - sample.radius)).toBeLessThanOrEqual(1);
  }

  // Pagination is intentionally hidden for a failed directory read. Measure
  // its controls against a complete populated response, as the directory
  // responsiveness suite does, rather than the static server's API 404.
  await page.route("**/public/paralegals?**", route => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") || 1);
    const limit = Number(url.searchParams.get("limit") || 10);
    const profiles = Array.from({ length: 11 }, (_, index) => directoryProfile({
      id: (index + 1).toString(16).padStart(24, "0"),
      title: `Geometry Paralegal ${index + 1}`,
      avatarURL: "/Cleanfav.png",
    }));
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      items: profiles.slice((pageNumber - 1) * limit, pageNumber * limit),
      total: profiles.length, pages: Math.ceil(profiles.length / limit), page: pageNumber,
    }) });
  });
  await page.goto("/browse-paralegals.html", { waitUntil: "domcontentloaded" });
  await settle(page, { chrome: true });
  await expect(page.locator("#prevPage")).toBeVisible();
  await expect(page.locator("#nextPage")).toBeVisible();
  await page.locator("#filterToggle").click();
  await expect(page.locator("#filterMenu")).toBeVisible();
  for (const selector of ["#sortMenuTrigger", "#filterToggle", "#applyFilters", "#clearFilters", "#prevPage", "#nextPage"]) {
    const control = page.locator(selector);
    const height = await control.evaluate((element) => element.getBoundingClientRect().height);
    expect(height, selector).toBeGreaterThanOrEqual(44);
  }
});
