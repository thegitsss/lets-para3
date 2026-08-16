const { test, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const { SUPPORTED_VIEWPORTS } = require("../../../playwright.browser-matrix");

async function readLayout(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main#main");
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      mainWidth: main?.clientWidth || 0,
      mainScrollWidth: main?.scrollWidth || 0,
    };
  });
}

test("director portal is complete, accessible, responsive, and free of implicit write actions", async ({ page }) => {
  const pageErrors = [];
  const serverFailures = [];
  const writes = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/api/director/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    ) {
      writes.push(`${request.method()} ${url.pathname}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      serverFailures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/director-portal.html", { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/login\.html|legal-acceptance\.html/);
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Director Portal", exact: true })).toBeVisible();
  await expect(page.locator("#directorIdentity")).toContainText("Drew Harness");
  await expect(page.locator("#recordsBody")).not.toContainText("Loading");
  await page.waitForTimeout(200);

  const desktopLayout = await readLayout(page);
  expect(desktopLayout.documentWidth).toBeLessThanOrEqual(desktopLayout.viewportWidth + 1);
  expect(desktopLayout.mainScrollWidth).toBeLessThanOrEqual(desktopLayout.mainWidth + 1);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(
    results.violations,
    JSON.stringify(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), null, 2)
  ).toEqual([]);
  await page.screenshot({ path: "/tmp/lpc-director-portal-desktop.png", fullPage: true });

  for (const viewport of SUPPORTED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const layout = await readLayout(page);
    expect(layout.documentWidth, viewport.name).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.mainScrollWidth, viewport.name).toBeLessThanOrEqual(layout.mainWidth + 1);
    await expect(page.getByRole("button", { name: "Sync Zoho" }), viewport.name).toBeVisible();
    if (viewport.name === "mobile") {
      await page.screenshot({ path: "/tmp/lpc-director-portal-mobile.png", fullPage: true });
    }
  }

  expect(writes).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(serverFailures).toEqual([]);
});
