const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const json = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const entry = "/attorney-v2.html#/home";

async function notificationsFixture(page, { href = "", count = 105, delayedRead = false, longContent = false } = {}) {
  const response = await page.request.get("/api/auth/me");
  const identity = (await response.json()).user;
  const ownerId = String(identity.id || identity._id);
  const state = {
    items: Array.from({ length: count }, (_, i) => ({ id: (i + 1).toString(16).padStart(24, "0"), message: longContent ? `Amélie updated the review instructions for the multi-jurisdiction commercial litigation Matter ${i + 1}` : `Notification ${String(i + 1).padStart(3, "0")}`, actorFirstName: "Amélie", read: false, isRead: false, createdAt: new Date(Date.UTC(2026, 8, 9, 12, 0, -i)).toISOString(), action: { href, label: "Open settings" } })),
    mutations: [], delayedRead, release: null, accountChanged: false,
  };
  await page.route("**/api/notifications**", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
    if (pathname === "/api/notifications/stream") return route.fulfill({ status: 204, body: "" });
    if (method === "GET") {
      expect(url.searchParams.get("expectedOwnerId")).toBe(ownerId);
      if (state.accountChanged) return json(route, { code: "ACCOUNT_CHANGED", message: "Your account changed. Refresh before continuing." }, 403);
      if (pathname.endsWith("/unread-count")) return json(route, { count: state.items.filter(item => !item.read).length });
      if (pathname.endsWith("/page")) {
        const rows = url.searchParams.get("unread") === "1" ? state.items.filter(item => !item.read) : state.items;
        const offset = Number(url.searchParams.get("cursor") || 0), limit = Number(url.searchParams.get("limit"));
        const items = rows.slice(offset, offset + limit), hasMore = rows.length > offset + limit;
        return json(route, { items, hasMore, nextCursor: hasMore ? String(offset + limit) : null });
      }
      return json(route, state.items.slice(0, 100));
    }
    expect(request.postDataJSON()).toEqual({ expectedOwnerId: ownerId });
    expect(request.headers()["x-csrf-token"]).toBeTruthy();
    state.mutations.push({ method, pathname });
    if (pathname.endsWith("/read") && state.delayedRead) await new Promise(resolve => { state.release = resolve; });
    if (pathname.endsWith("/read-all")) state.items.forEach(item => { item.read = true; item.isRead = true; });
    else if (pathname.endsWith("/read")) { const id = pathname.split("/").at(-2); state.items.forEach(item => { if (item.id === id) { item.read = true; item.isRead = true; } }); }
    else if (method === "DELETE") state.items = pathname === "/api/notifications" ? [] : state.items.filter(item => item.id !== pathname.split("/").at(-1));
    return json(route, { success: true });
  });
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
  await expect(page.locator("[data-av2-notification-badge]")).toHaveText(count > 99 ? "99+" : String(count));
  return state;
}

test("attorney center manages older notifications with real session and CSRF adapters", async ({ page }) => {
  const state = await notificationsFixture(page);
  const panel = page.locator('[data-av2-panel="notifications"]');
  await page.getByRole("button", { name: "View notifications, 105 unread" }).click();
  expect(state.mutations).toEqual([]);
  await panel.getByRole("button", { name: "Older", exact: true }).click();
  await expect(panel.getByText("Notification 105", { exact: true })).toBeVisible();
  await expect(panel.locator(".v2-notification")).toHaveCount(5);
  await panel.getByRole("button", { name: "Newer", exact: true }).click();
  await panel.getByRole("button", { name: "Notification 001, unread", exact: true }).click();
  await expect(page.getByRole("button", { name: "View notifications, 104 unread" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Notification 001", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Dismiss: Notification 001", exact: true }).click();
  await expect(panel.getByText("Notification 001", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Mark all as read", exact: true }).click();
  await expect(page.locator("[data-av2-notification-badge]")).toBeHidden();
  await panel.getByRole("button", { name: "Unread", exact: true }).click();
  await expect(panel.getByText("No unread notifications.", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "All", exact: true }).click();
  await expect(panel.locator(".v2-notification")).toHaveCount(100);
  await panel.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Clear all notifications?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Clear all", exact: true })).toBeFocused();
  await panel.getByRole("button", { name: "Clear all", exact: true }).click();
  await page.getByRole("dialog", { name: "Clear all notifications?" }).getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByText("No notifications.", { exact: true })).toBeVisible();
  expect(state.items).toHaveLength(0);
  expect(state.mutations).toHaveLength(4);
});

test("closing the attorney center cancels navigation from a delayed read completion", async ({ page }) => {
  const state = await notificationsFixture(page, { href: "/profile-settings.html?tab=security", count: 1, delayedRead: true });
  await page.getByRole("button", { name: "View notifications, 1 unread" }).click();
  await page.getByRole("link", { name: "Notification 001, unread" }).click();
  await expect.poll(() => Boolean(state.release)).toBe(true);
  await page.getByRole("button", { name: "Close notifications", exact: true }).click();
  await page.getByRole("button", { name: "Search your workspace" }).click();
  state.release();
  await expect(page.locator("[data-av2-notification-badge]")).toBeHidden();
  await expect(page.locator('[data-av2-panel="search"]')).toBeVisible();
  await expect(page).toHaveURL(/#\/home$/);
});

test("a notification owner mismatch immediately clears the attorney session boundary", async ({ page }) => {
  const state = await notificationsFixture(page, { count: 1 });
  state.accountChanged = true;
  await page.evaluate(() => window.dispatchEvent(new Event("lpc:notifications-refreshed")));
  await expect(page).toHaveURL(/\/login\.html/);
  await expect(page.getByText("Notification 001", { exact: true })).toHaveCount(0);
});

test("attorney notification presentation stays readable across themes and narrow layouts", async ({ page }, testInfo) => {
  await notificationsFixture(page, { count: 8, longContent: true, href: "/profile-settings.html?tab=profile" });
  for (const [width, theme, size] of [[1440, "light", 16], [390, "light", 16], [390, "dark", 16], [320, "dark", 16], [390, "dark", 20]]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(({ theme, size }) => { document.documentElement.classList.toggle("theme-dark", theme === "dark"); document.documentElement.style.fontSize = `${size}px`; }, { theme, size });
    await page.getByRole("button", { name: "View notifications, 8 unread" }).click();
    const panel = page.locator('[data-av2-panel="notifications"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator(".lpc-notification-avatar").first()).toHaveText("A");
    const dimensions = await panel.evaluate(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, bottom: rect.bottom, scroll: element.scrollWidth, client: element.clientWidth }; });
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(width + 1);
    expect(dimensions.bottom).toBeLessThanOrEqual(845);
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
    expect((await new AxeBuilder({ page }).include('[data-av2-panel="notifications"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
    await panel.screenshot({ path: testInfo.outputPath(`notifications-${width}-${theme}-${size}.png`) });
    await panel.getByRole("button", { name: "Close notifications", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: "View notifications, 8 unread" })).toBeFocused();
  }
});
