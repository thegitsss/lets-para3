const { test, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const guides = [
  {
    url: "/help.html",
    heading: "Help for Attorneys",
    roleLabel: "Support center · For attorneys",
    activeGuide: "Attorney Help",
    sectionHeadings: [
      "Account & access",
      "Posting a matter",
      "Hiring & managing work",
      "Workflow",
      "Private tasks",
      "Funding, release, and disputes",
    ],
  },
  {
    url: "/paralegalhelp.html",
    heading: "Help for Paralegals",
    roleLabel: "Support center · For paralegals",
    activeGuide: "Paralegal Help",
    sectionHeadings: [
      "Account & access",
      "Invitations & Applying",
      "Working a Matter",
      "Payouts & Stripe Connect",
      "Withdrawals & disputes",
    ],
  },
];

const viewports = [
  { name: "mobile-320", width: 320, height: 844 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1366, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
];

async function waitForHelpPage(page) {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".incident-intake-shell")).toBeVisible();
}

async function readGeometry(page) {
  return page.evaluate(() => {
    const rectOf = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, width: rect.width } : null;
    };
    const mainStyle = getComputedStyle(document.querySelector("main"));
    const bodyStyle = getComputedStyle(document.body);
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyOverflowY: bodyStyle.overflowY,
      mainOverflowY: mainStyle.overflowY,
      mainPosition: mainStyle.position,
      hero: rectOf(".help-hero"),
      main: rectOf(".help-main"),
      footer: rectOf(".home-footer"),
      header: rectOf(".home-header"),
    };
  });
}

for (const viewport of viewports) {
  test(`both Help guides share the public shell at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const guideGeometry = [];

    for (const guide of guides) {
      await page.goto(guide.url, { waitUntil: "domcontentloaded" });
      await waitForHelpPage(page);

      await expect(page.locator("body")).toHaveClass(/public-site-chrome/);
      await expect(page.getByRole("heading", { name: guide.heading, exact: true })).toBeVisible();
      await expect(page.locator(".help-eyebrow")).toHaveText(guide.roleLabel);
      await expect(page.getByRole("link", { name: guide.activeGuide, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.locator("[data-public-header]")).toBeVisible();
      await expect(page.locator("[data-public-footer]")).toBeAttached();
      await expect(page.locator(".sidebar, #sidebarNav, .sidebar-toggle")).toHaveCount(0);
      await expect(page.getByText("Member", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Dashboard", { exact: true })).toHaveCount(0);
      await expect(page.locator('a[href*="dashboard-attorney"], a[href*="dashboard-paralegal"], a[href*="profile-settings"]')).toHaveCount(0);

      for (const heading of guide.sectionHeadings) {
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeAttached();
      }

      const geometry = await readGeometry(page);
      expect(geometry.documentWidth, `${guide.url} overflows at ${viewport.name}`).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(geometry.bodyOverflowY).not.toBe("hidden");
      expect(geometry.mainOverflowY).not.toBe("auto");
      expect(geometry.mainOverflowY).not.toBe("scroll");
      expect(geometry.mainPosition).not.toBe("fixed");
      for (const [name, rect] of Object.entries({ header: geometry.header, hero: geometry.hero, main: geometry.main, footer: geometry.footer })) {
        expect(rect, `${guide.url} is missing ${name}`).not.toBeNull();
        expect(rect.left, `${guide.url} ${name} clips left at ${viewport.name}`).toBeGreaterThanOrEqual(-1);
        expect(rect.right, `${guide.url} ${name} clips right at ${viewport.name}`).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      }
      guideGeometry.push({ left: geometry.main.left, width: geometry.main.width });

      if (viewport.width <= 960) {
        const toggle = page.locator("[data-mobile-nav-toggle]");
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-label", "Open navigation");
        const toggleBox = await toggle.boundingBox();
        expect(toggleBox.width).toBeGreaterThanOrEqual(44);
        expect(toggleBox.height).toBeGreaterThanOrEqual(44);
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(toggle).toHaveAttribute("aria-label", "Close navigation");
        await expect(page.locator("[data-mobile-nav]")).toHaveAttribute("aria-hidden", "false");
        const mobileBounds = await page.locator("[data-mobile-nav]").evaluate((menu) => ({
          menu: menu.getBoundingClientRect().toJSON(),
          controls: [...menu.querySelectorAll("a, button")]
            .filter((control) => getComputedStyle(control).visibility !== "hidden" && control.getClientRects().length)
            .map((control) => ({ label: control.textContent.trim(), rect: control.getBoundingClientRect().toJSON() })),
        }));
        expect(mobileBounds.menu.left).toBeGreaterThanOrEqual(-1);
        expect(mobileBounds.menu.right).toBeLessThanOrEqual(viewport.width + 1);
        for (const control of mobileBounds.controls) {
          expect(control.rect.left, `${control.label} clips left`).toBeGreaterThanOrEqual(-1);
          expect(control.rect.right, `${control.label} clips right`).toBeLessThanOrEqual(viewport.width + 1);
        }
        await page.keyboard.press("Escape");
        await expect(toggle).toHaveAttribute("aria-label", "Open navigation");
        await expect(toggle).toBeFocused();
      } else {
        await expect(page.locator(".home-nav--desktop")).toBeVisible();
      }

      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
        .analyze();
      expect(
        axe.violations,
        `${guide.url} at ${viewport.name}: ${JSON.stringify(axe.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), null, 2)}`
      ).toEqual([]);
    }

    expect(Math.abs(guideGeometry[0].left - guideGeometry[1].left)).toBeLessThanOrEqual(1);
    expect(Math.abs(guideGeometry[0].width - guideGeometry[1].width)).toBeLessThanOrEqual(1);
  });
}

test("signed-in users retain structured reporting and the Assistant on the public Help shell", async ({ page }) => {
  const user = {
    _id: "64f000000000000000000001",
    id: "64f000000000000000000001",
    role: "attorney",
    status: "approved",
    firstName: "Avery",
    lastName: "Harness",
  };
  const conversation = { id: "help-phase-five-conversation", escalation: { requested: false } };

  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user }) }));
  await page.route("**/api/csrf", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ csrfToken: "phase-five-token" }) }));
  await page.route("**/api/incidents", async (route) => {
    expect(route.request().method()).toBe("POST");
    const payload = route.request().postDataJSON();
    expect(payload.summary).toBe("Payment status is stale");
    expect(payload.description).toContain("Matter payment status");
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        incident: { publicId: "INC-PHASE5", userVisibleStatus: "received" },
        reporterAccessToken: "phase-five-access",
      }),
    });
  });
  await page.route("**/api/support/conversation**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/messages")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversation,
          messages: [{ id: "welcome", sender: "assistant", text: "Welcome back, Avery.", createdAt: new Date().toISOString() }],
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversation }) });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/help.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".incident-intake-form")).toBeVisible();
  await page.locator("#incidentSummary").fill("Payment status is stale");
  await page.locator("#incidentDescription").fill("The Matter payment status did not update after funding.");
  await page.getByRole("button", { name: "Submit issue", exact: true }).click();
  await expect(page.locator(".incident-status-title")).toHaveText("Report received");
  await expect(page.locator(".incident-status-meta")).toContainText("INC-PHASE5");

  const assistantLauncher = page.getByRole("button", { name: "Open AI help chat", exact: true });
  await expect(assistantLauncher).toBeVisible();
  await assistantLauncher.click();
  await expect(page.locator("#supportDrawer")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#supportDrawer")).toContainText("Attorney Assistant");
  await expect(page.locator("#supportDrawer [data-support-textarea]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#supportDrawer")).toHaveAttribute("aria-hidden", "true");
  await expect(assistantLauncher).toBeFocused();
});
