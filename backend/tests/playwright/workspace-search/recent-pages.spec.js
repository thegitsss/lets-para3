const { expect } = require("playwright/test");
const { test } = require("./shell-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const OWNER = "111111111111111111111111", OTHER = "222222222222222222222222", MATTER = "333333333333333333333333", PROFILE = "444444444444444444444444";
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const matter = (title = "Litigation review") => ({ type: "matter", id: MATTER, title, practiceArea: "Litigation", status: { code: "open", label: "Posted" }, relationship: { code: "owner", label: "Your matter" }, attention: null, nextAction: { label: "Open Matter", href: `/case-detail.html?caseId=${MATTER}` } });
const profile = () => ({ type: "profile", id: PROFILE, title: "Amélie Rivera", headline: "Litigation", location: "New York", practiceAreas: ["Litigation"], nextAction: { label: "View profile", href: `/profile-paralegal.html?paralegalId=${PROFILE}` } });

async function fixture(page, role) {
  const state = {
    user: { id: OWNER, _id: OWNER, role, status: "approved", firstName: "Dana", lastName: "Young", preferences: { theme: "light", fontSize: "md" }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } },
    calls: [], searchCalls: [], respond: null,
  };
  await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} }; });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    state.calls.push({ path: pathname, query: Object.fromEntries(url.searchParams), method: request.method() });
    if (pathname === "/api/auth/me") {
      if (state.authRespond) return state.authRespond(route);
      return json(route, { user: state.user });
    }
    if (pathname === "/api/users/me") return json(route, state.user);
    if (pathname === "/api/csrf") return json(route, { csrfToken: "workspace-search-csrf" });
    if (pathname === "/api/account/preferences") return json(route, state.user.preferences);
    if (pathname === "/api/users/me/onboarding") return json(route, { onboarding: state.user.onboarding });
    if (pathname === "/api/cases/search") {
      const query = url.searchParams.get("q"), types = (url.searchParams.get("types") || "matter,profile").split(",");
      state.searchCalls.push({ query, types, expectedOwnerId: url.searchParams.get("expectedOwnerId") });
      if (state.respond) return state.respond(route, { query, types, url });
      return json(route, { ownerId: state.user.id, query, types, results: { matters: [matter()], profiles: role === "attorney" ? [profile()] : [] } });
    }
    if (pathname.startsWith("/api/notifications")) {
      if (pathname.endsWith("/unread-count")) return json(route, { count: 0 });
      if (pathname.endsWith("/page")) return json(route, { items: [], hasMore: false, nextCursor: null });
      return json(route, []);
    }
    const empty = { "/api/paralegal/dashboard": { activeCases: [], completedCases: [] }, "/api/payments/connect/status": { readiness: { ready: true, accountPresent: true, evidenceState: "verified" } }, "/api/messages/unread-count": { count: 0 }, "/api/support/conversation": { conversation: { id: "workspace-search-support", status: "open" }, messages: [] } };
    return json(route, empty[pathname] || { items: [], total: 0, page: 1, pages: 0 });
  });
  await page.goto(`/${role}-v2.html#/help`);
  await expect(page.locator(role === "attorney" ? "html" : "body")).toHaveAttribute(role === "attorney" ? "data-attorney-state" : "data-v2-session", "ready");
  const input = page.locator(role === "attorney" ? "#av2-query" : "[data-v2-search-input]");
  const panel = page.locator(role === "attorney" ? '[data-av2-panel="search"]' : "[data-v2-search-panel]");
  const open = async ({ expectFocus = true } = {}) => {
    if (role === "attorney") await page.getByRole("button", { name: "Search your workspace", exact: true }).click();
    else await page.keyboard.press("ControlOrMeta+KeyK");
    if (expectFocus) await expect(input).toBeFocused();
  };
  await open();
  return { state, input, panel, open };
}

async function visit(page, role, hash, name) {
  await page.keyboard.press("Escape");
  await page.evaluate(hash => { location.hash = hash; }, hash);
  await expect(page.locator("html")).toHaveAttribute(role === "attorney" ? "data-attorney-route" : "data-lpc-v2-committed-route", name);
}
for (const role of ["attorney", "paralegal"]) {
  test(`${role} recent pages reflect committed navigation without duplicate quick links`, async ({ page }) => {
    const { input, panel, open } = await fixture(page, role);
    await expect(panel.getByRole("group", { name: "Recent pages", exact: true })).toHaveCount(0);
    await visit(page, role, "/home", "home");
    await visit(page, role, "/help", "help");
    await open();
    const recent = panel.getByRole("group", { name: "Recent pages", exact: true });
    await expect(recent).toBeVisible();
    await expect(recent.getByRole("option")).toHaveText(["Help›", "Home›"]);
    await expect(panel.getByRole("option", { name: "Help", exact: true })).toHaveCount(1);
    await expect(panel.getByRole("option", { name: "Home", exact: true })).toHaveCount(1);
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${role}-v2\\.html#/home$`));
    await expect(panel).toBeHidden();
  });
}

const pagesKey = role => `lpc-v2-search-pages:${role === "attorney" ? "av2-search" : "v2-search"}:${OWNER}`;
for (const role of ["attorney", "paralegal"]) {
  test(`${role} recent pages survive reload with only three allowed distinct destinations`, async ({ page }) => {
    const { panel, open } = await fixture(page, role);
    await page.keyboard.press("Escape");
    const prefix = `/${role}-v2.html#`;
    await page.evaluate(({ key, prefix }) => sessionStorage.setItem(key, JSON.stringify([
      `${prefix}/help`, `${prefix}/home`, `${prefix}/help`, "https://example.com/private", `${prefix}/matter/private`,
      `${prefix}/settings?tab=security`, `${prefix}/settings?tab=preferences`, { label: "Private name", href: `${prefix}/home` },
    ])), { key: pagesKey(role), prefix });
    await page.reload();
    await expect(page.locator(role === "attorney" ? "html" : "body")).toHaveAttribute(role === "attorney" ? "data-attorney-state" : "data-v2-session", "ready");
    await open();
    const recent = panel.getByRole("group", { name: "Recent pages", exact: true });
    await expect(recent.getByRole("option")).toHaveText(["Help›", "Home›", "Security settings›"]);
    expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), pagesKey(role))).toEqual([
      `${prefix}/help`, `${prefix}/home`, `${prefix}/settings?tab=security`,
    ]);
    await expect(panel).not.toContainText("Private name");
  });

  test(`${role} recent pages wait for current-account verification and offer deliberate retry`, async ({ page }) => {
    const { state, input, panel, open } = await fixture(page, role);
    await visit(page, role, "/home", "home");
    let release;
    state.authRespond = route => new Promise(resolve => { release = () => json(route, { error: "Private diagnostics" }, 503).catch(() => {}).finally(resolve); });
    await open();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(panel.getByRole("group", { name: "Recent pages", exact: true })).toHaveCount(0);
    await expect(panel.getByText("Loading recent pages…", { exact: true })).toBeVisible();
    release();
    await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(panel).not.toContainText("Private diagnostics");
    expect(state.searchCalls).toHaveLength(0);
    state.authRespond = null;
    await panel.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(panel.getByRole("group", { name: "Recent pages", exact: true })).toBeVisible();
    await expect(input).toBeFocused();
  });

  test(`${role} recent pages clear on account replacement without displaying old history`, async ({ page }) => {
    const { state, panel, open } = await fixture(page, role);
    await visit(page, role, "/home", "home");
    state.user = { ...state.user, id: OTHER, _id: OTHER };
    await open({ expectFocus: false });
    await expect(page).toHaveURL(/\/login\.html/);
    expect(await page.evaluate(key => sessionStorage.getItem(key), pagesKey(role))).toBeNull();
    await expect(panel).toHaveCount(0);
  });

  test(`${role} typing a query cancels late recent pages and close prevents reopening`, async ({ page }) => {
    const { state, input, panel, open } = await fixture(page, role);
    await visit(page, role, "/home", "home");
    let release;
    state.authRespond = route => new Promise(resolve => { release = () => json(route, { user: state.user }).catch(() => {}).finally(resolve); });
    await open();
    await expect.poll(() => Boolean(release)).toBe(true);
    state.authRespond = null;
    await input.fill("litigation"); await input.press("Enter");
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    release();
    await expect(panel.getByRole("group", { name: "Recent pages", exact: true })).toHaveCount(0);
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    release = null;
    state.authRespond = route => new Promise(resolve => { release = () => json(route, { user: state.user }).catch(() => {}).finally(resolve); });
    await input.fill("");
    await expect.poll(() => Boolean(release)).toBe(true);
    await input.press("Escape");
    release();
    await expect(panel).toBeHidden();
  });

  test(`${role} malformed or unavailable optional storage does not break search`, async ({ page }) => {
    const { input, panel, open } = await fixture(page, role);
    await page.keyboard.press("Escape");
    await page.evaluate(key => sessionStorage.setItem(key, "{bad json"), pagesKey(role));
    await open();
    await expect(panel.getByRole("group", { name: "Recent pages", exact: true })).toHaveCount(0);
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); }; });
    await input.fill("litigation"); await input.press("Enter");
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
  });

  test(`${role} recent pages remain usable at 320px with enlarged dark text`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const { input, panel, open } = await fixture(page, role);
    await visit(page, role, "/home", "home");
    await visit(page, role, "/help", "help");
    await page.evaluate(() => { document.documentElement.classList.add("theme-dark"); document.documentElement.style.fontSize = "200%"; document.body.classList.add("theme-dark"); });
    await open();
    await expect(panel.getByRole("group", { name: "Recent pages", exact: true })).toBeVisible();
    await input.press("ArrowDown");
    const geometry = await input.evaluate(element => ({ x: element.getBoundingClientRect().x, right: element.getBoundingClientRect().right, width: innerWidth, visible: element.getBoundingClientRect().top >= 0 }));
    expect(geometry.x).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.width); expect(geometry.visible).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("recent-pages-320.png"), fullPage: true });
    const violations = await new AxeBuilder({ page }).include(role === "attorney" ? '[data-av2-panel="search"]' : '[data-v2-search-panel]').analyze();
    expect(violations.violations).toEqual([]);
  });
}

for (const role of ["attorney", "paralegal"]) {
  test(`${role} default Settings aliases share one canonical recent page`, async ({ page }) => {
    const { panel, open } = await fixture(page, role);
    await visit(page, role, "/settings", "settings");
    await visit(page, role, "/help", "help");
    await open();
    const recent = panel.getByRole("group", { name: "Recent pages", exact: true });
    const title = "Profile Settings";
    const href = `/${role}-v2.html#/settings${role === "attorney" ? "" : "?tab=profile"}`;
    await expect(recent.getByRole("option", { name: title, exact: true })).toHaveAttribute("href", href);
    await visit(page, role, "/settings?tab=profile", "settings");
    await open();
    await expect(recent.getByRole("option").first()).toHaveAttribute("href", href);
    await expect(recent.getByRole("option", { name: title, exact: true })).toHaveCount(1);
    await expect(panel.getByRole("option", { name: title, exact: true })).toHaveCount(1);
  });

  test(`${role} recent verification times out visibly and announces successful retry`, async ({ page }) => {
    const { state, input, panel, open } = await fixture(page, role);
    await visit(page, role, "/home", "home");
    await page.clock.install(); await page.clock.pauseAt(new Date(Date.now() + 100));
    let release;
    state.authRespond = route => new Promise(resolve => { release = () => json(route, { user: state.user }).catch(() => {}).finally(resolve); });
    await open(); await expect.poll(() => Boolean(release)).toBe(true);
    await page.clock.runFor(15100);
    await expect(panel.getByText("Recent pages took too long. Please try again.", { exact: true })).toBeVisible();
    await expect(panel.getByRole("group", { name: "Recent pages", exact: true })).toHaveCount(0);
    state.authRespond = null; release();
    await panel.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(panel.getByRole("group", { name: "Recent pages", exact: true })).toBeVisible();
    await expect(panel.locator("p.lpc-search-sr")).toHaveText("1 recent page available.");
    await expect(input).toBeFocused();
  });
}

test("attorney asynchronous recents preserve the selected quick-link destination", async ({ page }) => {
  const { state, input, panel, open } = await fixture(page, "attorney");
  await visit(page, "attorney", "/home", "home");
  let release;
  state.authRespond = route => new Promise(resolve => { release = () => json(route, { user: state.user }).catch(() => {}).finally(resolve); });
  await open(); await expect.poll(() => Boolean(release)).toBe(true);
  await input.press("ArrowDown");
  await expect(panel.locator('[aria-selected="true"]')).toHaveAttribute("href", "/attorney-v2.html#/home");
  state.authRespond = null; release();
  await expect(panel.getByRole("group", { name: "Recent pages", exact: true })).toBeVisible();
  await expect(panel.locator('[aria-selected="true"]')).toHaveAttribute("href", "/attorney-v2.html#/home");
  await input.press("Enter");
  await expect(panel).toBeHidden();
});
