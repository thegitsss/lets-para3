const { expect } = require("playwright/test");
const { test } = require("./shell-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const OWNER = "111111111111111111111111", OTHER = "222222222222222222222222", REF = "INC-20260909-000001";
const at = "2026-09-09T12:00:00.000Z";
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function fixture(page, role, { viaNotification = false, count = 105 } = {}) {
  const state = {
    user: { id: OWNER, _id: OWNER, role, status: "approved", firstName: "Dana", lastName: "Young", preferences: { theme: "light", fontSize: "md" }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } },
    incident: { publicId: REF, summary: "The selected practice area does not update the list of available Matters", userVisibleStatus: "investigating", state: "INTERNAL-STATE-CANARY", createdAt: at, updatedAt: at, resolution: null },
    events: Array.from({ length: count }, (_, i) => ({ seq: i + 1, summary: `Reporter update ${i + 1}`, createdAt: new Date(Date.parse(at) + i * 60000).toISOString(), eventType: "INTERNAL-EVENT-CANARY", toState: "INTERNAL-STATE-CANARY" })),
    statusFault: null, timelineFault: null, requests: [], hold: false, holdTimeline: false, release: null, read: false,
  };
  await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} }; });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    state.requests.push({ path: pathname, query: Object.fromEntries(url.searchParams), method: request.method() });
    if (pathname === "/api/auth/me") return json(route, { user: state.user });
    if (pathname === "/api/users/me") return json(route, state.user);
    if (pathname === "/api/csrf") return json(route, { csrfToken: "report-status-csrf" });
    if (pathname === "/api/account/preferences") return json(route, state.user.preferences);
    if (pathname === "/api/users/me/onboarding") return json(route, { onboarding: state.user.onboarding });
    if (pathname.startsWith("/api/incidents/")) {
      expect(url.searchParams.get("expectedOwnerId")).toBe(OWNER);
      const payload = structuredClone(state.incident);
      if (state.hold && !pathname.endsWith("/timeline")) await new Promise(resolve => { state.release = resolve; });
      if (state.holdTimeline && pathname.endsWith("/timeline")) await new Promise(resolve => { state.release = resolve; });
      if (state.user.id !== OWNER) return json(route, { code: "ACCOUNT_CHANGED" }, 403);
      if (pathname.endsWith("/timeline")) {
        if (state.timelineFault) return json(route, state.timelineFault.body, state.timelineFault.status);
        expect(url.searchParams.get("paged")).toBe("1"); expect(url.searchParams.get("limit")).toBe("20");
        const after = Number(url.searchParams.get("cursor") || 0), selected = state.events.filter(event => event.seq > after), events = selected.slice(0, 20), hasMore = selected.length > 20;
        return json(route, { ok: true, incident: state.incident, events, hasMore, nextCursor: hasMore ? String(events.at(-1).seq) : null });
      }
      if (state.statusFault) return json(route, state.statusFault.body, state.statusFault.status);
      return json(route, { ok: true, incident: payload, reporterAccessToken: "TOKEN-CANARY" });
    }
    if (pathname.startsWith("/api/notifications")) {
      if (request.method() !== "GET") { state.read = true; return json(route, { success: true }); }
      const items = viaNotification ? [{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", type: "incident_update", message: `Report ${REF} is under review.`, read: state.read, isRead: state.read, createdAt: at, context: { incidentPublicId: REF }, action: { label: "View report", href: `/${role === "attorney" ? "help" : "paralegalhelp"}.html?incident=${REF}` } }] : [];
      if (pathname.endsWith("/unread-count")) return json(route, { count: viaNotification && !state.read ? 1 : 0 });
      if (pathname.endsWith("/page")) return json(route, { items, hasMore: false, nextCursor: null });
      return json(route, items);
    }
    const empty = { "/api/paralegal/dashboard": { activeCases: [], completedCases: [] }, "/api/payments/connect/status": { readiness: { ready: true, accountPresent: true, evidenceState: "verified" } }, "/api/messages/unread-count": { count: 0 }, "/api/support/conversation": { conversation: { id: "report-status-support", status: "open" }, messages: [] } };
    return json(route, empty[pathname] || { items: [], total: 0, page: 1, pages: 0 });
  });
  const entry = `/${role}-v2.html#/help${viaNotification ? "" : `?incident=${REF}`}`;
  await page.goto(entry);
  await expect(page.locator(role === "attorney" ? "html" : "body")).toHaveAttribute(role === "attorney" ? "data-attorney-state" : "data-v2-session", "ready");
  if (viaNotification) {
    await page.getByRole("button", { name: "View notifications, 1 unread", exact: true }).click();
    await page.getByRole("link", { name: `Report ${REF} is under review., unread`, exact: true }).click();
  }
  return state;
}

function register(role) {
  test(`${role} Help notification opens its exact current report`, async ({ page }) => {
    const state = await fixture(page, role, { viaNotification: true });
    await expect(page).toHaveURL(new RegExp(`#/help\\?incident=${REF}$`));
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText(state.incident.summary, { exact: true })).toBeVisible();
    await expect(report.getByText("Under review", { exact: true })).toHaveCount(1);
    await expect(report.getByText(REF, { exact: true })).toBeVisible();
    expect(state.requests.some(item => item.path.endsWith("/timeline"))).toBe(false);
    await expect(report).not.toContainText(/INTERNAL-|TOKEN-CANARY|undefined|null/);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, href: location.href }))).not.toContain("CANARY");
    expect(state.read).toBe(true);
  });

  test(`${role} reaches every report update beyond one hundred and refreshes current resolution`, async ({ page }) => {
    const state = await fixture(page, role);
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    await report.locator("summary").click();
    await expect(report.locator("li")).toHaveCount(20);
    for (const total of [40, 60, 80, 100, 105]) {
      const more = report.getByRole("button", { name: "More updates", exact: true });
      await more.focus(); await expect(more).toBeFocused(); await more.press("Enter");
      await expect(report.locator("li")).toHaveCount(total);
      await expect(report.locator(":focus")).toBeInViewport({ ratio: 1 });
    }
    await expect(report.getByText("Reporter update 105", { exact: true })).toBeVisible();
    await expect(report.getByRole("button", { name: "More updates" })).toBeHidden();
    await expect(report.locator(":focus")).toBeInViewport({ ratio: 1 });
    state.incident.userVisibleStatus = "fixed_live";
    state.incident.resolution = { summary: "Practice area filters now update the available Matters.", code: "INTERNAL-CODE-CANARY" };
    state.events = [{ seq: 1, summary: "Report received.", createdAt: at }, { seq: 2, summary: "Report received.", createdAt: at }, { seq: 3, summary: "The issue has been resolved.", createdAt: at }];
    await report.getByRole("button", { name: "Refresh report" }).click();
    await expect(report.getByText("Fixed", { exact: true })).toBeVisible();
    await expect(report.getByText(state.incident.resolution.summary, { exact: true })).toHaveCount(1);
    await expect(report.locator("li")).toHaveCount(2);
    await expect(report).not.toContainText("CANARY");
  });

  test(`${role} late report reads cannot reopen a departed route`, async ({ page }) => {
    const state = await fixture(page, role);
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    state.hold = true;
    await report.getByRole("button", { name: "Refresh report" }).click();
    await expect.poll(() => Boolean(state.release)).toBe(true);
    await report.getByRole("link", { name: "Back to Help" }).click();
    await expect(page).toHaveURL(/#\/help$/);
    state.release();
    await expect(report).toHaveCount(0);
    await expect(page).toHaveURL(/#\/help$/);
  });

  test(`${role} replacement account is protected during a report read`, async ({ page }) => {
    const state = await fixture(page, role);
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    state.hold = true;
    await report.getByRole("button", { name: "Refresh report" }).click();
    await expect.poll(() => Boolean(state.release)).toBe(true);
    state.user = { ...state.user, id: OTHER, _id: OTHER };
    state.release();
    await expect(page).toHaveURL(/\/login\.html/);
    await expect(page.getByText(state.incident.summary, { exact: true })).toHaveCount(0);
  });

  test(`${role} status failure and invalid data have explicit recoverable feedback`, async ({ page }) => {
    const state = await fixture(page, role);
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    for (const fault of [{ status: 503, body: { message: "INTERNAL-ERROR-CANARY" } }, { status: 200, body: { ok: true, incident: { ...state.incident, userVisibleStatus: "INTERNAL-STATUS-CANARY" } } }, { status: 200, body: {} }]) {
      state.statusFault = fault;
      await report.getByRole("button", { name: "Refresh report" }).click();
      await expect(report.getByText("Your report couldn’t load. Try again.", { exact: true })).toBeVisible();
      await expect(report.getByText("Under review", { exact: true })).toHaveCount(0);
      await expect(report).not.toContainText("CANARY");
    }
    state.statusFault = null;
    await report.getByRole("button", { name: "Refresh report" }).click();
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
  });

  test(`${role} timeline retry keeps progress but lost report access clears old data`, async ({ page }) => {
    const state = await fixture(page, role);
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    await report.locator("summary").click();
    await expect(report.locator("li")).toHaveCount(20);
    state.timelineFault = { status: 503, body: {} };
    await report.getByRole("button", { name: "More updates" }).click();
    await expect(report.getByText("Updates couldn’t load. Try again.", { exact: true })).toBeVisible();
    await expect(report.locator("li")).toHaveCount(20);
    state.timelineFault = null;
    await report.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(report.locator("li")).toHaveCount(40);
    state.timelineFault = { status: 404, body: {} };
    await report.getByRole("button", { name: "More updates" }).focus();
    await report.getByRole("button", { name: "More updates" }).press("Enter");
    await expect(report.getByText("This report is unavailable to your account.", { exact: true })).toBeVisible();
    await expect(report.getByText(state.incident.summary, { exact: true })).toHaveCount(0);
    await expect(report.locator("li")).toHaveCount(0);
    await expect(report.getByRole("button", { name: "Refresh report" })).toBeFocused();
    await expect(report.getByRole("button", { name: "Refresh report" })).toBeInViewport({ ratio: 1 });
    await expect(report.locator("details")).toBeHidden();
  });

  test(`${role} malformed update pages cannot replace verified history`, async ({ page }) => {
    const state = await fixture(page, role);
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    await report.locator("summary").click(); await expect(report.locator("li")).toHaveCount(20);
    const pageOfUpdates = { ok: true, incident: state.incident, events: state.events.slice(20, 40), hasMore: true, nextCursor: "40" };
    for (const body of [{}, { ...pageOfUpdates, nextCursor: "20" }, { ...pageOfUpdates, events: state.events.slice(19, 39) }, { ...pageOfUpdates, events: state.events.slice(20, 41) }, { ...pageOfUpdates, incident: { ...state.incident, publicId: "INC-20260909-000002" } }]) {
      state.timelineFault = { status: 200, body };
      await report.locator(".lpc-report-history button").click();
      await expect(report.getByText("Updates couldn’t load. Try again.", { exact: true })).toBeVisible();
      await expect(report.locator("li")).toHaveCount(20);
      await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    }
    state.timelineFault = null;
    await report.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(report.locator("li")).toHaveCount(40);
  });

  for (const interruption of ["route", "account"]) test(`${role} held timeline cannot survive a changed ${interruption}`, async ({ page }) => {
    const state = await fixture(page, role);
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    await report.locator("summary").click(); await expect(report.locator("li")).toHaveCount(20);
    state.holdTimeline = true;
    await report.getByRole("button", { name: "More updates" }).click();
    await expect.poll(() => Boolean(state.release)).toBe(true);
    if (interruption === "route") {
      await report.getByRole("link", { name: "Back to Help" }).click();
      await expect(page).toHaveURL(/#\/help$/);
    } else state.user = { ...state.user, id: OTHER, _id: OTHER };
    state.release();
    if (interruption === "account") await expect(page).toHaveURL(/\/login\.html/);
    await expect(report).toHaveCount(0);
    await expect(page.getByText("Reporter update 21", { exact: true })).toHaveCount(0);
  });

  test(`${role} a stalled report times out and allows explicit retry`, async ({ page }) => {
    await page.clock.install();
    const state = await fixture(page, role);
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    state.hold = true;
    await report.getByRole("button", { name: "Refresh report" }).click();
    await expect.poll(() => Boolean(state.release)).toBe(true);
    await page.clock.fastForward(31000);
    await expect(report.getByText("Your report couldn’t load. Try again.", { exact: true })).toBeVisible();
    await expect(report.getByRole("button", { name: "Refresh report" })).toHaveAttribute("aria-disabled", "false");
    state.hold = false; state.release();
    await report.getByRole("button", { name: "Refresh report" }).click();
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
  });

  test(`${role} report layout supports long text, narrow screens, dark theme and enlarged type`, async ({ page }, testInfo) => {
    const state = await fixture(page, role, { count: 3 });
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    state.incident.resolution = { code: "resolved", summary: "A detailed update about the practice area filters and the full list of available Matters. ".repeat(5) };
    await report.getByRole("button", { name: "Refresh report" }).click();
    await report.locator("summary").click();
    await expect(report.locator("li")).toHaveCount(3);
    for (const [width, theme, size] of [[1440, "light", 16], [390, "light", 16], [390, "dark", 16], [320, "dark", 16], [390, "dark", 20]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(({ theme, size }) => { document.documentElement.classList.toggle("theme-dark", theme === "dark"); document.documentElement.dataset.theme = theme; document.documentElement.style.fontSize = `${size}px`; }, { theme, size });
      await page.evaluate(() => document.fonts.ready);
      const results = await new AxeBuilder({ page }).include(".lpc-report-status").analyze();
      expect(results.violations).toEqual([]);
      await expect(page.getByRole("banner")).toHaveCount(1);
      const bounds = await report.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1); expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width + 1);
      await report.screenshot({ path: testInfo.outputPath(`report-${width}-${theme}-${size}.png`) });
    }
  });
}
module.exports = { register, fixture, REF };
