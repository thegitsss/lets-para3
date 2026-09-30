const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const ENTRY = "/attorney-v2.html#/home";
const ready = (page) => expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
const json = (route, payload, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });

test("real attorney session opens the isolated shell and navigation never remounts it", async ({ page }) => {
  const requests = [];
  const errors = [];
  page.on("request", (request) => { if (request.url().includes("/api/")) requests.push({ url: request.url(), method: request.method() }); });
  page.on("pageerror", (error) => errors.push(error.message));
  const admission = page.waitForResponse(response => response.url().endsWith("/api/auth/me") && response.request().method() === "GET");
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await ready(page);
  const admitted = await admission;
  expect(admitted.status()).toBe(200);
  // Protected financial reads also verify their owner before and after loading.
  // Check actual admission instead of counting those necessary auth requests.
  const admittedUser = (await admitted.json()).user;
  expect(admittedUser).toMatchObject({ role: "attorney", status: "approved" });
  const waitForOwnedRead = path => expect.poll(() => requests.filter(request => new URL(request.url).pathname === path).length).toBeGreaterThan(0);
  // Exercise both owned reads before leaving their routes; an earlier departure
  // correctly cancels the preflight before the inventory request is sent.
  await page.evaluate(() => {
    window.shellNodes = [...document.querySelectorAll("[data-av2-persistent]")];
    window.emptyRenders = 0;
    new MutationObserver(() => { if (!document.querySelector("[data-av2-outlet]").childElementCount) window.emptyRenders++; }).observe(document.querySelector("[data-av2-outlet]"), { childList: true });
  });
  await waitForOwnedRead("/api/cases/inventory/home");
  for (const [name, route] of [["Matters", "matters"], ["Private Tasks", "tasks"], ["Find a Paralegal", "paralegals"], ["Payments", "payments"], ["Profile Settings", "settings"], ["Help", "help"], ["Home", "home"]]) {
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-attorney-route", route);
    await expect(page.locator("main")).toBeFocused();
    if (route === "matters") await waitForOwnedRead("/api/cases/inventory");
  }
  expect(await page.evaluate(() => window.shellNodes.every((element, i) => element === document.querySelectorAll("[data-av2-persistent]")[i]))).toBe(true);
  expect(await page.evaluate(() => window.emptyRenders)).toBe(0);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
  expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  for (const path of ["/api/cases/inventory/home", "/api/cases/inventory"]) {
    const ownedReads = requests.filter(request => new URL(request.url).pathname === path);
    expect(ownedReads.length).toBeGreaterThan(0);
    expect(ownedReads.every(request => new URL(request.url).searchParams.get("expectedOwnerId") === String(admittedUser.id || admittedUser._id))).toBe(true);
  }
  expect(requests.filter((request) => /\/api\/support/.test(request.url))).toEqual([]);
  expect(requests.some(request => request.url.includes("/api/notifications/page?"))).toBe(true);
  expect(requests.some(request => request.url.includes("/api/notifications/unread-count?"))).toBe(true);
  expect(errors).toEqual([]);
});

test("direct routes, reload, history, scroll restoration and unknown routes remain usable", async ({ page }) => {
  await page.goto("/attorney-v2.html#/matters?openApplicants=1", { waitUntil: "domcontentloaded" });
  await ready(page);
  await expect(page.getByRole("link", { name: "Previous workspace", exact: true })).toHaveAttribute("href", "/dashboard-attorney.html?openApplicants=1&workspace=legacy#cases:active");
  await page.reload();
  await ready(page);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-attorney-route", "home");
  await expect(page.locator('[data-av2-region][data-state="loading"]')).toHaveCount(0);
  await page.addStyleTag({ content: ".av2-view { min-height: 2000px; }" });
  await page.locator("main").evaluate((element) => { element.scrollTop = 500; });
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Private Tasks", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-attorney-route", "tasks");
  await page.goBack();
  await expect(page.locator("html")).toHaveAttribute("data-attorney-route", "home");
  // Browsers may quantize a restored scroll position to a fractional CSS pixel.
  await expect.poll(async () => Math.abs(await page.locator("main").evaluate((element) => element.scrollTop) - 500)).toBeLessThan(1);
  await page.goForward();
  await expect(page.locator("html")).toHaveAttribute("data-attorney-route", "tasks");
  await page.evaluate(() => { location.hash = "/missing"; });
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Home" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-attorney-route", "home");
});

test("sidebar controls are bounded and keyboard-operable at the required widths", async ({ page }, info) => {
  const tabKey = info.project.name === "webkit" ? "Alt+Tab" : "Tab";
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await ready(page);
  for (const width of [320, 360, 390, 768, 1024, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const button = page.locator("[data-av2-nav-toggle]");
    const box = await button.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    if (width <= 900) {
      await expect(page.locator("#av2-sidebar")).toHaveAttribute("inert", "");
      await button.click();
      await expect(page.locator("#av2-sidebar")).not.toHaveAttribute("inert", "");
      const drawer = page.getByRole("dialog", { name: "Attorney navigation", exact: true });
      await expect(drawer.getByRole("link", { name: "Home", exact: true })).toBeFocused();
      await drawer.getByRole("link", { name: "Let’s-ParaConnect Home" }).focus();
      await page.keyboard.press("Shift+" + tabKey);
      await expect(drawer.getByRole("button", { name: "Sign out", exact: true })).toBeFocused();
      await page.keyboard.press(tabKey);
      await expect(page.getByRole("link", { name: "Let’s-ParaConnect Home" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(button).toBeFocused();
      await expect(button).toHaveAttribute("aria-expanded", "false");
    }
  }
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(page.getByRole("button", { name: "Expand navigation" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Matters", exact: true })).toBeVisible();
  expect(Math.round((await page.locator("#av2-sidebar").boundingBox()).width)).toBe(76);
});

test("opening search and notifications reads safely without marking records", async ({ page }) => {
  const mutations = [];
  page.on("request", (request) => { if (request.url().includes("/api/") && request.method() !== "GET") mutations.push(request.url()); });
  let unsafeSearch = true;
  await page.route("**/api/cases/search?**", route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("expectedOwnerId")).toMatch(/^[a-f\d]{24}$/i);
    const matter = { type: "matter", id: "aaaaaaaaaaaaaaaaaaaaaaaa", title: "Synthetic contract review", practiceArea: "Contracts", status: { code: "in_progress", label: "In progress" }, relationship: { code: "owner", label: "Your matter" }, attention: null, nextAction: { href: "/case-detail.html?caseId=aaaaaaaaaaaaaaaaaaaaaaaa&tab=files" } };
    return json(route, { ownerId: url.searchParams.get("expectedOwnerId"), query: url.searchParams.get("q"), types: ["matter", "profile"], results: { matters: [matter, ...(unsafeSearch ? [{ ...matter, id: "bbbbbbbbbbbbbbbbbbbbbbbb", title: "Unsafe result", nextAction: { href: "https://evil.test/" } }] : [])], profiles: [] } });
  });
  await page.route("**/api/notifications/page?**", (route) => json(route, { items: [{ id: "aaaaaaaaaaaaaaaaaaaaaaa1", read: true, isRead: true, message: "Synthetic Matter update", action: { href: "/dashboard-attorney.html#cases" } }], nextCursor: null, hasMore: false }));
  await page.route("**/api/notifications/unread-count?**", (route) => json(route, { count: 0 }));
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await ready(page);
  await page.getByRole("button", { name: "Search your workspace" }).click();
  await page.getByRole("combobox", { name: "Search your workspace" }).fill("contract");
  await page.getByRole("combobox", { name: "Search your workspace" }).press("Enter");
  await expect(page.locator("#av2-search").getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText("Unsafe result")).toHaveCount(0);
  await expect(page.getByRole("option", { name: /Synthetic contract review/ })).toHaveCount(0);
  unsafeSearch = false;
  await page.locator("#av2-search").getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("option", { name: /Synthetic contract review/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Synthetic contract review/ })).toHaveAttribute("href", "/attorney-v2.html#/matters/aaaaaaaaaaaaaaaaaaaaaaaa/files");
  await page.getByRole("combobox", { name: "Search your workspace" }).fill("a");
  await expect(page.getByRole("option", { name: /Synthetic contract review/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Search your workspace" })).toBeFocused();
  await page.getByRole("button", { name: "View notifications" }).click();
  await expect(page.getByRole("link", { name: "Synthetic Matter update" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "View notifications" })).toBeFocused();
  expect(mutations).toEqual([]);
});

test("session failure stays protected, supports retry, and rejects a different account", async ({ page }) => {
  let mode = "error";
  await page.route("**/api/auth/me", async (route) => {
    if (mode === "error") return json(route, { error: "temporarily unavailable" }, 503);
    if (mode === "changed") return json(route, { user: { id: "bbbbbbbbbbbbbbbbbbbbbbbb", role: "attorney", status: "approved", firstName: "Another account" } });
    return route.continue();
  });
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("We couldn’t verify your session.", { exact: false })).toBeVisible();
  await expect(page.locator("[data-av2-shell]")).toHaveAttribute("inert", "");
  mode = "ready";
  await page.getByRole("button", { name: "Try again" }).click();
  await ready(page);
  mode = "changed";
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user", newValue: '{"id":"untrusted"}' })));
  await expect(page).toHaveURL(/dashboard-attorney\.html/);
  await expect(page.locator("[data-av2-shell]")).toHaveCount(0);
});

test("role and account states fail closed even when the browser snapshot says attorney", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lpc_user", JSON.stringify({ id: "cached", role: "attorney", status: "approved" })));
  await page.route("**/api/auth/me", (route) => json(route, { user: { id: "aaaaaaaaaaaaaaaaaaaaaaaa", role: "paralegal", status: "approved" } }));
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/dashboard-paralegal\.html/);
  await expect(page.locator("[data-av2-shell]")).toHaveCount(0);
});

test("session loss and BFCache restoration revalidate before revealing workspace content", async ({ page }) => {
  let expired = false;
  await page.route("**/api/auth/me", (route) => expired ? json(route, { error: "Session expired" }, 401) : route.continue());
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await ready(page);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
  });
  await expect(page.locator("[data-av2-shell]")).toHaveAttribute("inert", "");
  await expect(page.locator("main")).toBeEmpty();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await ready(page);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expired = true;
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user", newValue: null })));
  await expect(page).toHaveURL(/login\.html/);
});

// Each accessibility state gets its own bounded test and actionable trace.
// The shared test timeout and all AA assertions are unchanged.
for (const state of ["home", "search", "notifications"]) {
  test(`primary shell ${state} state passes automated WCAG AA checks`, async ({ page }) => {
    await page.route("**/api/notifications/page?**", (route) => json(route, { items: [], nextCursor: null, hasMore: false }));
    await page.route("**/api/notifications/unread-count?**", (route) => json(route, { count: 0 }));
    await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
    await ready(page);
    await expect(page.locator('[data-av2-region][data-state="loading"]')).toHaveCount(0);
    if (state === "search") await page.getByRole("button", { name: "Search your workspace" }).click();
    if (state === "notifications") await page.getByRole("button", { name: "View notifications" }).click();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
    await page.keyboard.press("Escape");
  });
}
test("primary shell supports text enlargement and reduced motion", async ({ page }) => {
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await ready(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("main .av2-button")).toBeVisible();
});

test("existing Assistant opens through its adapter without overlapping the attorney frame", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await ready(page);
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("#supportDrawer")).toHaveAttribute("aria-hidden", "false");
  await expect(page.getByRole("button", { name: "Open LPC Assistant" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("body")).toHaveClass(/support-drawer-pinned/);
  const bounds = await page.evaluate(() => ({ main: document.querySelector(".av2-frame").getBoundingClientRect().right, drawer: document.querySelector("#supportDrawer").getBoundingClientRect().left }));
  expect(bounds.main).toBeLessThanOrEqual(bounds.drawer + 1);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Matters", exact: true }).click();
  await expect(page.locator("#supportDrawer")).toHaveAttribute("aria-hidden", "false");
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("#supportDrawer")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Open LPC Assistant" })).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("#supportDrawer")).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("body")).not.toHaveClass(/support-drawer-pinned/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#supportDrawer")).toHaveAttribute("aria-hidden", "true");
});

test("a slow search cannot reappear after route navigation or session loss", async ({ page }) => {
  let release;
  let requested;
  const requestStarted = new Promise((resolve) => { requested = resolve; });
  const responseReady = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/cases/search?**", async route => {
    const url = new URL(route.request().url()); requested(); await responseReady;
    await json(route, { ownerId: url.searchParams.get("expectedOwnerId"), query: url.searchParams.get("q"), types: ["matter", "profile"], results: { matters: [{ type: "matter", id: "aaaaaaaaaaaaaaaaaaaaaaaa", title: "Late confidential result", practiceArea: "Contracts", status: { code: "open", label: "Posted" }, relationship: { code: "owner", label: "Your matter" }, attention: null, nextAction: { href: "/case-detail.html?caseId=aaaaaaaaaaaaaaaaaaaaaaaa" } }], profiles: [] } });
  });
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await ready(page);
  await page.getByRole("button", { name: "Search your workspace" }).click();
  await page.getByRole("combobox", { name: "Search your workspace" }).fill("contract");
  await page.getByRole("combobox", { name: "Search your workspace" }).press("Enter");
  await requestStarted;
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Matters", exact: true }).click();
  release();
  await expect(page.locator("html")).toHaveAttribute("data-attorney-route", "matters");
  await expect(page.locator("#av2-search")).toBeHidden();
  await expect(page.getByText("Late confidential result")).toHaveCount(0);
});

test("dark appearance keeps the shell accessible and does not write preferences", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.user.preferences = { ...payload.user.preferences, theme: "mountain-dark" };
    return json(route, payload);
  });
  await page.goto(ENTRY, { waitUntil: "domcontentloaded" });
  await ready(page);
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});
