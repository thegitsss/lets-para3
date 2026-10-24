const { test, expect } = require("playwright/test");
const { directoryProfile } = require("./public-directory-fixture");

async function install(page, user = null) {
  const reads = [];
  await page.route("**/api/auth/me", r => r.fulfill({ json: { user } }));
  await page.route("**/api/csrf", r => r.fulfill({ json: { csrfToken: "directory-layout" } }));
  await page.route("**/paralegal-v2.html", r => r.fulfill({ contentType: "text/html", body: "<h1>Paralegal workspace</h1>" }));
  await page.route("**/public/paralegals?**", r => {
    reads.push(r.request().url());
    const items = Array.from({ length: 6 }, (_, index) => ({
      ...directoryProfile({ id: (index + 1).toString(16).padStart(24, "0"), title: index === 0 ? "Alexandria Montgomery-Worthington the Third" : `Directory Member ${index + 1}`, avatarURL: "/assets/avatar-placeholder.svg" }),
      state: "New York",
    }));
    return r.fulfill({ json: { items, page: 1, pages: 1, total: 6 } });
  });
  return reads;
}

test("compact centered cards form four desktop columns and become the approved mobile reading layout", async ({ page }) => {
  await install(page);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/browse-paralegals.html");
    await expect(page.locator(".paralegal-card")).toHaveCount(6);
    const geometry = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".paralegal-card")];
      const first = cards[0].getBoundingClientRect();
      const portrait = cards[0].querySelector("img").getBoundingClientRect();
      return {
        width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
        topRow: cards.filter(c => Math.abs(c.getBoundingClientRect().top - first.top) < 1).length,
        centered: Math.abs((first.left + first.width / 2) - (portrait.left + portrait.width / 2)),
        border: getComputedStyle(cards[0]).borderTopWidth,
        radius: getComputedStyle(cards[0]).borderTopLeftRadius,
      };
    });
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.topRow).toBe(width === 1440 ? 4 : width === 1024 ? 3 : width === 768 ? 2 : 1);
    if (width >= 768) {
      expect(geometry.centered).toBeLessThanOrEqual(1);
      expect(geometry.border).toBe("1px");
      expect(parseFloat(geometry.radius)).toBeGreaterThan(0);
    }
    await expect(page.locator(".card-location").first()).toHaveText("New York");
    await expect(page.locator(".card-bio").first()).toBeVisible();
    await expect(page.getByText(/view profile/i)).toHaveCount(0);
    await expect(page.locator("#sortMenuTrigger")).toHaveAccessibleName("Sort paralegals: Name A–Z");
    await expect(page.locator("#sortMenuValue")).toHaveCSS("clip-path", "inset(50%)");
  }
});

for (const role of ["public", "attorney"]) {
  test(`${role} directory reflows during resizing and keeps enlarged text and open menus inside the window`, async ({ page }) => {
    test.setTimeout(90_000);
    await install(page, role === "attorney" ? { id: "directory-attorney", role: "attorney", status: "approved", firstName: "Avery" } : null);
    await page.goto("/browse-paralegals.html");
    await expect(page.locator(".paralegal-card")).toHaveCount(6);
    const checkPage = async () => {
      const geometry = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const outside = [...document.querySelectorAll(".paralegal-card, .profile-photo-link, .card-identity, .card-practice, .card-bio, .card-meta, .card-actions .action-btn, .results-controls button, #pagination")]
          .filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().height)
          .filter(e => { const r = e.getBoundingClientRect(); return r.left < -1 || r.right > width + 1; })
          .map(e => e.className || e.id);
        return { width, scrollWidth: document.documentElement.scrollWidth, outside };
      });
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
      expect(geometry.outside).toEqual([]);
    };
    for (const width of [1920, 1440, 1280, 1100, 1024, 960, 900, 800, 768, 767, 640, 480, 428, 390, 360, 320, 600, 1024, 1440]) {
      await page.setViewportSize({ width, height: 720 });
      await checkPage();
    }
    for (const fontSize of [24, 32]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 600 });
        await checkPage();
      }
    }
    const checkPanel = async selector => {
      await expect.poll(() => page.locator(selector).evaluate(e => {
        const b = e.getBoundingClientRect();
        return b.left >= 0 && b.right <= innerWidth + 1 && b.top >= 0 && b.bottom <= innerHeight + 1;
      })).toBe(true);
      const r = await page.locator(selector).evaluate(e => {
        const b = e.getBoundingClientRect();
        const header = document.querySelector("[data-public-header]");
        const h = header?.getBoundingClientRect();
        const headerBottom = h?.height && ["fixed", "sticky"].includes(getComputedStyle(header).position) && h.top <= 12 ? h.bottom : 0;
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: innerWidth, height: innerHeight, headerBottom };
      });
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.right).toBeLessThanOrEqual(r.width + 1);
      expect(r.top).toBeGreaterThanOrEqual(r.headerBottom);
      expect(r.bottom).toBeLessThanOrEqual(r.height + 1);
    };
    for (const [trigger, panel] of [["#sortMenuTrigger", "#sortMenuOptions"], ["#filterToggle", "#filterMenu"]]) {
      await page.locator(trigger).click();
      for (const width of [1280, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 480 });
        await checkPanel(panel);
        await checkPage();
      }
      await page.keyboard.press("Escape");
    }
  });
}

test("signed-in paralegals return to their workspace without requesting directory profiles", async ({ page }) => {
  const reads = await install(page, { id: "directory-paralegal", role: "paralegal", status: "approved", firstName: "Jamie" });
  await page.goto("/browse-paralegals.html?view=saved");
  await expect(page).toHaveURL(/\/paralegal-v2\.html#\/home$/);
  await expect(page.getByRole("heading", { name: "Paralegal workspace" })).toBeVisible();
  expect(reads).toEqual([]);
});

test("a public directory tab leaves when the session changes to a paralegal", async ({ page }) => {
  await install(page);
  await page.goto("/browse-paralegals.html");
  await expect(page.locator(".paralegal-card")).toHaveCount(6);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { user: { id: "signed-in-paralegal", role: "paralegal" } } })));
  await expect(page).toHaveURL(/\/paralegal-v2\.html#\/home$/);
});

test("an incompatible directory response reports unavailable profiles rather than showing a blank page", async ({ page }) => {
  await install(page);
  await page.route("**/public/paralegals?**", r => r.fulfill({ json: { items: [{ _id: "000000000000000000000001", name: "Old record" }], page: 1, pages: 1, total: 1 } }));
  await page.goto("/browse-paralegals.html");
  await expect(page.locator("#resultsStatus")).toHaveText("Some profiles could not be displayed. Please try again shortly.");
});
