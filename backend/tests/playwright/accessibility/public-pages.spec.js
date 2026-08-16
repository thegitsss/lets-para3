const { test, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const pages = [
  ["home", "/index.html"],
  ["login", "/login.html"],
  ["signup", "/signup.html"],
  ["browse paralegals", "/browse-paralegals.html"],
  ["forgot password", "/forgot-password.html"],
  ["reset password", "/reset-password.html?token=invalid"],
  ["verify email", "/verify-email.html?token=invalid"],
  ["privacy", "/privacy.html"],
  ["terms", "/terms.html"],
  ["legal re-acceptance", "/legal-acceptance.html"],
  ["accessibility statement", "/accessibility.html"],
  ["contact", "/contact.html"],
  ["paralegal admission", "/paralegal-admission.html"],
  ["attorney FAQ", "/attorney-faq.html"],
  ["paralegal FAQ", "/paralegal-faq.html"],
  ["unsubscribe", "/unsubscribe.html"],
  ["not found", "/this-page-does-not-exist", 404],
];
const visualAuditPages = new Set(["home", "login", "signup", "not found"]);
const homeVisualSelectors = [
  ".hero-bridge__inner",
  ".workflow__intro",
  ".assistant-showcase__intro",
  ".assistant-stage",
  ".path-scene--attorney .path-scene__copy",
  ".path-scene--attorney .audience-interface",
  ".path-scene--paralegal .path-scene__copy",
  ".path-scene--paralegal .audience-interface",
  ".closing-scene__content",
];

const readHomeVisualState = (page) => page.evaluate((selectors) => ({
  viewportHeight: window.innerHeight,
  pageHeight: document.documentElement.scrollHeight,
  unavailable: selectors.filter((selector) => {
    const element = document.querySelector(selector);
    if (!element) return true;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.99 || rect.height < 1;
  }),
}), homeVisualSelectors);

for (const [name, url, expectedStatus = 200] of pages) {
  test(`${name} has no automated WCAG A/AA violations`, async ({ page }) => {
    await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());
    if (visualAuditPages.has(name)) {
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    expect(response.status()).toBe(expectedStatus);
    await page.locator("main").waitFor({ state: "attached" });
    if (name === "home") {
      const layout = await readHomeVisualState(page);
      expect(layout.unavailable, "homepage content must not depend on scroll-triggered entrance effects").toEqual([]);
      expect(layout.pageHeight, "desktop homepage exceeds its 12-viewport information-density budget")
        .toBeLessThanOrEqual(layout.viewportHeight * 12);
      await page.locator('[data-workflow-select="6"]').evaluate((control) => control.click());
      await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-workflow-state", "6");
      await expect(page.locator('[data-workflow-select="6"]')).toHaveAttribute("aria-pressed", "true");
      await page.locator('[data-workflow-select="1"]').evaluate((control) => control.click());
      await page.locator('[data-assistant-view-select="paralegal"]').evaluate((control) => control.click());
      await expect(page.locator("[data-assistant-role]")).toHaveText("Paralegal Assistant");
      await expect(page.locator('[data-assistant-view-select="paralegal"]')).toHaveAttribute("aria-pressed", "true");
      await page.locator('[data-assistant-view-select="attorney"]').evaluate((control) => control.click());
      await expect(page.locator("[data-assistant-role]")).toHaveText("Attorney Assistant");
    }
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
      .analyze();
    const summary = results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    }));
    expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
    if (visualAuditPages.has(name)) {
      const fileName = name.replace(/\s+/g, "-");
      await page.screenshot({ path: `/tmp/lpc-public-${fileName}-desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      const mobileLayout = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
      }));
      expect(mobileLayout.contentWidth, `${name} mobile horizontal overflow`)
        .toBeLessThanOrEqual(mobileLayout.viewportWidth + 1);
      if (name === "home") {
        await page.locator('[data-workflow-select="6"]').evaluate((control) => control.click());
        await expect(page.locator('[data-workflow-chapter="6"] .workflow-mobile-canvas')).toBeVisible();
        await expect(page.locator('[data-workflow-chapter="1"] .workflow-mobile-canvas')).toBeHidden();
        await page.locator('[data-workflow-select="1"]').evaluate((control) => control.click());
        const layout = await readHomeVisualState(page);
        expect(layout.unavailable, "mobile homepage content must remain immediately renderable").toEqual([]);
        expect(layout.pageHeight, "mobile homepage exceeds its 14-viewport information-density budget")
          .toBeLessThanOrEqual(layout.viewportHeight * 14);
      }
      await page.screenshot({ path: `/tmp/lpc-public-${fileName}-mobile.png`, fullPage: true });
    }
  });
}
