const { test, expect } = require("playwright/test");

const journeys = [
  ["home", "/index.html", 550 * 1024],
  ["login", "/login.html", 450 * 1024],
  ["signup", "/signup.html", 550 * 1024],
  ["password recovery", "/forgot-password.html", 700 * 1024],
];

for (const [name, url, transferBudget] of journeys) {
  test(`${name} stays inside launch performance budgets`, async ({ page }) => {
    await page.addInitScript(() => {
      window.__lpcLabVitals = { cls: 0, lcp: 0 };
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__lpcLabVitals.cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        window.__lpcLabVitals.lcp = entries.at(-1)?.startTime || window.__lpcLabVitals.lcp;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });
    await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());
    await page.goto(url, { waitUntil: "load" });
    await expect(page.locator("main")).toBeVisible();
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForTimeout(500);

    const result = await page.evaluate(() => {
      const entries = performance.getEntriesByType("resource");
      const navigation = performance.getEntriesByType("navigation")[0];
      const transferredBytes = entries.reduce(
        (sum, entry) => sum + (entry.transferSize || entry.encodedBodySize || 0),
        navigation?.transferSize || navigation?.encodedBodySize || 0
      );
      return {
        cls: window.__lpcLabVitals.cls,
        lcp: window.__lpcLabVitals.lcp,
        transferredBytes,
      };
    });

    console.log(
      `[performance] ${test.info().project.name}/${name}: ` +
      `LCP=${result.lcp.toFixed(1)}ms CLS=${result.cls.toFixed(4)} ` +
      `transfer=${(result.transferredBytes / 1024).toFixed(1)}KiB`
    );

    expect(result.cls, `CLS was ${result.cls}`).toBeLessThanOrEqual(0.1);
    expect(result.lcp, `LCP was ${result.lcp}ms`).toBeGreaterThan(0);
    expect(result.lcp, `LCP was ${result.lcp}ms`).toBeLessThanOrEqual(2500);
    expect(
      result.transferredBytes,
      `Transferred ${(result.transferredBytes / 1024).toFixed(1)} KiB; budget ${(transferBudget / 1024).toFixed(0)} KiB`
    ).toBeLessThanOrEqual(transferBudget);
  });
}
