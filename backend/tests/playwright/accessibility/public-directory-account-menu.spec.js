const { test, expect } = require("playwright/test");

const PHASE_ONE_VIEWPORTS = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 900 },
  { width: 1920, height: 1080 },
];

async function mockDirectory(page, user = null) {
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
      body: JSON.stringify({ csrfToken: "public-directory-phase-one" }),
    })
  );
  await page.route("**/public/paralegals?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, pages: 1, page: 1 }),
    })
  );
}

test("signed-out directory never mounts authenticated account UI after the footer", async ({ page }) => {
  await mockDirectory(page);

  for (const viewport of PHASE_ONE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/browse-paralegals.html", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#resultsStatus")).toHaveText("No paralegals match your filters yet.");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    await expect(page.locator(".lpc-sidebar-account-menu")).toHaveCount(0);
    await expect(page.locator("[data-auth-sidebar]")).toBeHidden();
    await expect(page.locator("[data-public-footer]")).toBeVisible();

    const layout = await page.evaluate(() => {
      const footer = document.querySelector("[data-public-footer]");
      const footerBottom = footer.getBoundingClientRect().bottom + window.scrollY;
      const rogueAccountControls = document.querySelectorAll(
        "body > .profile-dropdown a, body > .profile-dropdown button, body > [data-profile-menu] a, body > [data-profile-menu] button"
      ).length;
      return {
        footerBottom: Math.round(footerBottom),
        scrollHeight: document.documentElement.scrollHeight,
        trailingLayout: Math.round(
          document.documentElement.scrollHeight - Math.max(window.innerHeight, footerBottom)
        ),
        rogueAccountControls,
      };
    });

    expect(layout.rogueAccountControls).toBe(0);
    expect(
      Math.abs(layout.trailingLayout),
      `${viewport.width}x${viewport.height} has layout content after the public footer: ${JSON.stringify(layout)}`
    ).toBeLessThanOrEqual(1);
  }
});

test("authenticated directory retains its legitimate account-menu DOM and toggle behavior", async ({ page }) => {
  const user = {
    id: "phase-one-attorney",
    firstName: "Avery",
    lastName: "Counsel",
    role: "attorney",
    status: "approved",
  };
  await mockDirectory(page, user);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/browse-paralegals.html", { waitUntil: "domcontentloaded" });

  await expect(page.locator("body")).toHaveClass(/authenticated-browse/);
  await expect(page.locator("[data-auth-sidebar]")).toBeVisible();
  await expect(page.locator("[data-public-footer]")).toHaveAttribute("hidden", "");

  const trigger = page.locator(".authenticated-browse-sidebar .lpc-sidebar-profile-trigger");
  const menu = page.locator("body > .lpc-sidebar-account-menu");
  await expect(trigger).toHaveCount(1);
  await expect(menu).toHaveCount(1);
  await expect(menu).toHaveAttribute("aria-hidden", "true");
  await expect(menu).toBeHidden();

  await trigger.dispatchEvent("click");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toHaveAttribute("aria-hidden", "false");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".lpc-account-menu-user-name")).toHaveText("Avery Counsel");
  await expect(menu.locator("[data-account-settings]")).toBeVisible();
  await expect(menu.locator("[data-logout]")).toBeVisible();
});
