const { browsePageFixture } = require("./browse-page-fixture");
const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const MATTER_ID = "64b000000000000000000991";

async function json(route, payload, status = 200, headers = {}) {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/jobs/open" && url.searchParams.get("view") === "browse" && status === 200) payload = browsePageFixture(payload.items || payload, url.searchParams);
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(payload),
  });
}

async function installRealtimeHarness(page) {
  await page.addInitScript(() => {
    window.__v2RealtimeStreams = [];
    class RealtimeEventSource extends EventTarget {
      constructor(url) {
        super();
        this.url = String(url);
        this.readyState = 1;
        window.__v2RealtimeStreams.push(this);
      }

      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = RealtimeEventSource;
    window.__emitV2Realtime = (urlPart, type, data) => {
      const stream = [...window.__v2RealtimeStreams].reverse().find((entry) => (
        entry.readyState === 1 && entry.url.includes(urlPart)
      ));
      stream?.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data || {}) }));
    };
  });
}

async function openV2Document(page, path) {
  const destination = new URL(path, test.info().project.use.baseURL);
  await page.evaluate(url => { setTimeout(() => location.assign(url), 0); }, destination.href);
  await expect(page).toHaveURL(destination.href);
}

async function waitForV2(page, routeName) {
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", routeName);
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
}

async function installAssistantAccountReads(page, identity) {
  // These two Assistant cases replace the session with explicit fixture users.
  // Keep unrelated notification and financial reads in that fixture account.
  // Actual cookie/owner mismatch behavior has separate route/UI tests.
  const financial = require('./financial-fixtures');
  const { eventPage } = require('./event-page-fixture');
  let nextWorkspaceRead = null;
  await page.route('**/api/auth/workspace-release', async route => {
    const ownerId = identity().id, held = nextWorkspaceRead;
    if (held) {
      nextWorkspaceRead = null;
      held.started = true;
      await held.released;
    }
    return json(route, { workspace: { schemaVersion: 1, ownerId, role: 'paralegal', revision: 1, version: 'v2', defaultDestination: '/paralegal-v2.html#/home' } });
  });
  await page.route(url => url.pathname === '/api/events', route => {
    const params = new URL(route.request().url()).searchParams, ownerId = identity().id;
    expect(params.get('expectedOwnerId')).toMatch(/^[a-f\d]{24}$/i);
    if (params.get('expectedOwnerId') !== ownerId) return json(route, { code: 'EVENT_ACCOUNT_CHANGED', error: 'Your signed-in account changed. Reload before continuing.' }, 403);
    return json(route, eventPage(ownerId, { items: [] }, params));
  });
  await page.route('**/api/paralegal/dashboard?*', route => {
    const ownerId = identity().id;
    const expectedOwnerId = new URL(route.request().url()).searchParams.get('expectedOwnerId');
    expect(expectedOwnerId).toMatch(/^[a-f\d]{24}$/i);
    // An A-owned request may reach this fixture after its session becomes B.
    // Match the real financial boundary instead of throwing from a route hook.
    if (expectedOwnerId !== ownerId) return json(route, {
      error: 'This financial view is no longer available to the signed-in account.',
      code: 'FINANCIAL_ACCOUNT_CHANGED',
    }, 403);
    expect(expectedOwnerId).toBe(ownerId);
    return json(route, { activeCases: [], metrics: { activeCases: 0, earningsReport: financial.earnings(ownerId), expectedCompensation: financial.expected(ownerId) } });
  });
  await page.route("**/api/notifications**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/stream")) return route.fulfill({ status: 204, body: "" });
    // Home's retained legacy notification read does not send this optional guard.
    if (url.searchParams.has("expectedOwnerId")) {
      const expectedOwnerId = url.searchParams.get("expectedOwnerId"), ownerId = identity().id;
      expect(expectedOwnerId).toMatch(/^[a-f\d]{24}$/i);
      if (expectedOwnerId !== ownerId) return json(route, {
        code: 'ACCOUNT_CHANGED', message: 'Your account changed. Refresh before continuing.',
      }, 403);
      expect(expectedOwnerId).toBe(ownerId);
    }
    if (url.pathname.endsWith("/unread-count")) return json(route, { count: 0 });
    if (url.pathname.endsWith("/page")) return json(route, { items: [], hasMore: false, nextCursor: null });
    return json(route, []);
  });
  return {
    holdNextWorkspaceRead() {
      let release;
      const held = { started: false, released: new Promise(resolve => { release = resolve; }) };
      nextWorkspaceRead = held;
      return { started: () => held.started, release };
    },
  };
}

test('a cold History entry retains its Assistant control while the account check is pending', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await installRealtimeHarness(page);
  await page.addInitScript(() => localStorage.removeItem('lpc_user'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/auth/me', async route => { await gate; await route.continue(); });
  const conversations = [];
  await page.route('**/api/support/conversation**', route => {
    conversations.push(route.request().method());
    return json(route, { conversation: { id: 'cold-history-assistant', status: 'open' }, messages: [] });
  });
  try {
    await openV2Document(page, '/paralegal-v2.html#/work?section=history');
    await expect.poll(() => page.evaluate(() => Boolean(window.__LPC_PARALEGAL_V2__))).toBe(true);
    // The global scan can run before a delayed initial session response.
    await page.evaluate(() => window.scanSupportLaunchers());
    await expect(page.locator('[data-v2-assistant-trigger]')).toHaveCount(1);
    await expect(page.locator('[data-v2-persistent="header"]')).toHaveJSProperty('inert', true);
    expect(conversations).toEqual([]);
    release();
    await waitForV2(page, 'work');
    const assistant = page.getByRole('button', { name: 'Open LPC Assistant', exact: true });
    await expect(assistant).toBeVisible();
    await assistant.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('body')).toHaveClass(/support-drawer-open/);
    await expect.poll(() => conversations.length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(assistant).toBeFocused();
    await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { release(); }
});

test("clearing search prevents keyboard navigation to hidden results", async ({ page }) => {
  await page.route("**/api/cases/search?*", route => {
    const url = new URL(route.request().url());
    return json(route, { ownerId: url.searchParams.get("expectedOwnerId"), query: url.searchParams.get("q"), types: ["matter"], results: { profiles: [], matters: [{ type: "matter", id: MATTER_ID, title: "Hidden result", practiceArea: "Litigation", status: { code: "open", label: "Posted" }, relationship: { code: "discoverable", label: "Open to apply" }, attention: null, nextAction: { label: "View opportunity", href: `/browse-jobs.html?caseId=${MATTER_ID}` } }] } });
  });
  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  const input = page.locator("[data-v2-search-input]");
  await input.fill("hidden");
  await expect(page.getByRole("option", { name: /Hidden result/ })).toBeVisible();
  await input.fill("");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page).toHaveURL(/#\/home$/);
  await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/);
});

test("Assistant account replacement clears transcript and unsent draft", async ({ page }) => {
  let account = "A";
  const identity = () => ({ id: account === "A" ? "64b000000000000000000001" : "64b000000000000000000002", firstName: `Account${account}`, lastName: "User", role: "paralegal", status: "approved", onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } });
  const accountReads = await installAssistantAccountReads(page, identity);
  await page.route("**/api/auth/me", route => json(route, { user: identity() }));
  await page.route("**/api/users/me", route => json(route, identity()));
  await page.route("**/api/users/me/onboarding", route => json(route, { onboarding: identity().onboarding }));
  await page.route("**/api/support/conversation**", route => {
    const conversation = { id: `conversation-${account}`, status: "open" };
    return json(route, { conversation, messages: [{ id: `message-${account}`, sender: "assistant", text: `Private transcript ${account}`, createdAt: "2026-09-05T13:00:00Z" }] });
  });
  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("#supportThread")).toContainText("Private transcript A");
  await page.locator("#supportDrawer textarea").fill("Unsent private A draft");
  // Keep the previous account check in flight when the account changes. The
  // replacement must receive a fresh check instead of reusing that promise.
  const pendingAccountCheck = accountReads.holdNextWorkspaceRead();
  await page.evaluate(() => {
    const previous = localStorage.getItem("lpc_user");
    const user = JSON.parse(previous);
    window.dispatchEvent(new StorageEvent("storage", {
      key: "lpc_user", oldValue: previous,
      newValue: JSON.stringify({ ...user, preferences: { ...user.preferences, theme: "dark" } }),
    }));
  });
  await expect.poll(pendingAccountCheck.started).toBe(true);
  await expect(page.locator("#supportDrawer textarea")).toHaveValue("Unsent private A draft");
  await expect(page.locator("#supportDrawer")).toHaveAttribute("aria-hidden", "false");
  account = "B";
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user", oldValue: "account-a", newValue: "account-b" })));
  pendingAccountCheck.release();
  await expect(page.locator("[data-v2-profile-name]")).toContainText("AccountB");
  await expect(page.locator("#supportThread")).not.toContainText("Private transcript A");
  await expect(page.locator("#supportDrawer textarea")).toHaveValue("");
  if (await page.locator("#supportDrawer").getAttribute("aria-hidden") === "true") await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("#supportThread")).toContainText("Private transcript B");
});

test("Assistant reset uses the authenticated account email when the session cache omits it", async ({ page }) => {
  let resetBody, resetOwner;
  await page.route(/\/api\/users\/me(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    const payload = await response.json(), account = payload.user || payload;
    resetOwner = String(account.id || account._id);
    const query = new URL(route.request().url()).searchParams;
    if (query.has('expectedOwnerId')) expect(query.get('expectedOwnerId')).toBe(resetOwner);
    return json(route, payload.user ? { ...payload, user: { ...account, email: "reset-owner@example.com" } } : { ...payload, email: "reset-owner@example.com" });
  });
  await page.route("**/api/support/conversation**", route => json(route, {
    conversation: { id: "reset-conversation", status: "open" },
    messages: [{ id: "reset-action", sender: "assistant", text: "Request a password reset for your account.", metadata: { actions: [{ type: "invoke", action: "request_password_reset", label: "Email me a reset link" }] } }],
  }));
  await page.route("**/api/auth/request-password-reset", route => {
    resetBody = route.request().postDataJSON();
    return json(route, { message: "If the account exists, a link will be sent." });
  });
  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("lpc_user") || "{}").email)).toBeFalsy();
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await page.getByRole("button", { name: "Email me a reset link" }).click();
  await expect(page.locator("#supportThread")).toContainText("Reset requested. Check your email for a link.");
  expect(resetBody).toEqual({ email: "reset-owner@example.com", expectedOwnerId: resetOwner, expectedRole: 'paralegal' });
});

test("an Assistant response delayed past account replacement cannot restore the previous conversation", async ({ page }) => {
  let account = "A";
  const identity = () => ({ id: account === "A" ? "64b000000000000000000001" : "64b000000000000000000002", firstName: `Account${account}`, lastName: "User", role: "paralegal", status: "approved", onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } });
  await installAssistantAccountReads(page, identity);
  await page.route("**/api/auth/me", route => json(route, { user: identity() }));
  await page.route("**/api/users/me", route => json(route, identity()));
  await page.route("**/api/users/me/onboarding", route => json(route, { onboarding: identity().onboarding }));
  await page.route("**/api/support/conversation**", route => json(route, { conversation: { id: `conversation-${account}`, status: "open" }, messages: [{ id: `message-${account}`, sender: "assistant", text: `Private transcript ${account}` }] }));
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).includes("/api/support/conversation") && !window.__heldAssistantResponse) {
        window.__heldAssistantResponse = true;
        // Model a response that completes after abort, including body parsing.
        const body = await response.clone().text();
        await new Promise(resolve => { window.__releaseAssistantResponse = resolve; });
        window.__oldAssistantResponseReleased = true;
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    };
  });
  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect.poll(() => page.evaluate(() => typeof window.__releaseAssistantResponse)).toBe("function");
  account = "B";
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user", oldValue: "account-a", newValue: "account-b" })));
  await expect(page.locator("[data-v2-profile-name]")).toContainText("AccountB");
  if (await page.locator("#supportDrawer").getAttribute("aria-hidden") === "true") await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("#supportThread")).toContainText("Private transcript B");
  await page.evaluate(() => window.__releaseAssistantResponse());
  await expect.poll(() => page.evaluate(() => window.__oldAssistantResponseReleased)).toBe(true);
  await expect(page.locator("#supportThread")).not.toContainText("Private transcript A");
  await expect(page.locator("#supportThread")).toContainText("Private transcript B");
});

test("authenticated Help stays inside V2 and preserves guidance, resources, validation, and issue reporting", async ({ page }) => {
  let submittedIssue = null;
  await page.route("**/api/incidents", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submittedIssue = route.request().postDataJSON();
    return json(route, {
      ok: true,
      incident: { publicId: "INC-20260909-000204", userVisibleStatus: "received" },
      reporterAccessToken: "browser-contract-token",
    }, 201);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  await page.evaluate(() => {
    window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.phase6Identity = "same-sidebar";
    window.__LPC_PARALEGAL_V2__.shell.header.dataset.phase6Identity = "same-header";
    window.__phase6NavigationEntries = performance.getEntriesByType("navigation").length;
  });

  await page.getByRole("link", { name: "Help" }).click();
  await waitForV2(page, "help");
  await expect(page.getByRole("heading", { level: 1, name: "Help for Paralegals" })).toBeVisible();
  for (const heading of ["Account & access", "Invitations & applying", "Working on a matter", "Getting paid", "Withdrawals & disputes"]) {
    await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Reset password" })).toHaveAttribute("href", "/forgot-password.html");
  await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy.html");
  await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms.html");
  await expect(page.getByRole("link", { name: "Accessibility" })).toHaveAttribute("href", "/accessibility.html");

  await page.getByRole("button", { name: "Submit issue" }).click();
  await expect(page.getByRole("status").filter({ hasText: "More detail needed" })).toBeVisible();
  await expect(page.getByLabel("Short summary")).toBeFocused();
  await page.getByLabel("Short summary").fill("Browse filter did not update");
  await page.getByLabel("What happened?").fill("I selected Litigation and the visible list did not change.");
  await page.getByRole("link", { name: "Home" }).click();
  await waitForV2(page, "home");
  await page.getByRole("link", { name: "Help" }).click();
  await waitForV2(page, "help");
  await expect(page.getByLabel("Short summary")).toHaveValue("Browse filter did not update");
  await expect(page.getByLabel("What happened?")).toHaveValue("I selected Litigation and the visible list did not change.");
  await page.getByRole("button", { name: "Submit issue" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Report received" })).toContainText("INC-20260909-000204");
  expect(submittedIssue).toMatchObject({
    summary: "Browse filter did not update",
    featureKey: "paralegal-v2-help",
  });
  expect(submittedIssue.description).toContain("visible list did not change");
  expect(submittedIssue.diagnostics.pageUrl).toContain("#/help");
  await page.getByRole("link", { name: "Home" }).click();
  await waitForV2(page, "home");
  await page.getByRole("link", { name: "Help" }).click();
  await waitForV2(page, "help");
  await expect(page.getByLabel("Short summary")).toHaveValue("");
  await expect(page.getByLabel("What happened?")).toHaveValue("");

  const shell = await page.evaluate(() => ({
    sidebar: window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.phase6Identity,
    header: window.__LPC_PARALEGAL_V2__.shell.header.dataset.phase6Identity,
    navigations: performance.getEntriesByType("navigation").length,
    initialNavigations: window.__phase6NavigationEntries,
  }));
  expect(shell).toEqual({
    sidebar: "same-sidebar",
    header: "same-header",
    navigations: shell.initialNavigations,
    initialNavigations: shell.initialNavigations,
  });
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("global Search expands inline, stays keyboard-operable and user-scoped, and routes without remounting", async ({ page }) => {
  const queries = [];
  await page.route("**/api/jobs/open?*", route => json(route, { items: [{
    _id: "64b000000000000000000992", caseId: MATTER_ID,
    title: "Litigation discovery support", description: "Prepare the verified discovery chronology.",
    practiceArea: "Litigation", state: "NY", status: "open", totalAmount: 100000,
    applicationEligibility: { ready: true, allowed: true, blockers: [] },
  }] }));
  await page.route("**/api/cases/search?*", async (route) => {
    const url = new URL(route.request().url());
    queries.push({ q: url.searchParams.get("q"), types: url.searchParams.get("types") });
    return json(route, {
      ownerId: url.searchParams.get("expectedOwnerId"), query: url.searchParams.get("q"), types: ["matter"],
      results: {
        profiles: [],
        matters: [{
          type: "matter",
          id: MATTER_ID,
          title: "Litigation discovery support",
          practiceArea: "Litigation",
          status: { code: "open", label: "Posted" },
          relationship: { code: "discoverable", label: "Open to apply" },
          nextAction: { label: "View opportunity", href: `/browse-jobs.html?caseId=${MATTER_ID}` },
        }],
      },
    });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  await page.evaluate(() => {
    window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.searchIdentity = "same-sidebar";
    window.__searchNavigationEntries = performance.getEntriesByType("navigation").length;
  });

  await page.keyboard.press("ControlOrMeta+KeyK");
  await expect(page.locator("[data-v2-search-input]")).toBeFocused();
  await expect(page.locator("[data-v2-search-panel]")).toBeHidden();
  await page.locator("[data-v2-search-input]").fill("litigation");
  await expect(page.getByRole("option", { name: /Litigation discovery support/ })).toBeVisible();
  const panelBox = await page.locator("[data-v2-search-panel]").boundingBox();
  expect(panelBox.width).toBeLessThanOrEqual(404);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Litigation discovery support/ })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => {
    const original = window.requestAnimationFrame;
    const pending = [];
    window.requestAnimationFrame = callback => pending.push(callback);
    window.__releaseRouteFrames = () => {
      window.requestAnimationFrame = original;
      pending.forEach(callback => original(callback));
    };
  });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#\\/browse\\?matterId=${MATTER_ID}$`));
  await waitForV2(page, "browse");
  await expect(page.getByRole("heading", { level: 1, name: "Litigation discovery support" })).toBeVisible();
  expect(queries).toContainEqual({ q: "litigation", types: "matter" });
  const continuity = await page.evaluate(() => ({
    sidebar: window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.searchIdentity,
    navigations: performance.getEntriesByType("navigation").length,
    initialNavigations: window.__searchNavigationEntries,
    recentKeys: Object.keys(sessionStorage).filter((key) => key.startsWith("lpc-v2-search-recent:")),
  }));
  expect(continuity.sidebar).toBe("same-sidebar");
  expect(continuity.navigations).toBe(continuity.initialNavigations);
  expect(continuity.recentKeys).toHaveLength(1);

  await page.keyboard.press("ControlOrMeta+KeyK");
  await expect(page.locator("[data-v2-search-panel]")).toBeVisible();
  await page.evaluate(() => window.__releaseRouteFrames());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("[data-v2-search-panel]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-v2-search-panel]")).toBeHidden();
  await expect(page.locator("[data-v2-search-input]")).toBeFocused();
});

test("Notifications wait for server authority and reconcile unread state across tabs", async ({ page, context }) => {
  const notificationId = "64b000000000000000000992";
  const serverState = { read: false, cleared: false, readRequests: 0, clearRequests: 0 };
  let confirmRead;
  const readGate = new Promise((resolve) => { confirmRead = resolve; });
  await context.route("**/api/notifications**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/notifications/stream") {
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname === `/api/notifications/${notificationId}/read` && request.method() === "POST") {
      serverState.readRequests += 1;
      await readGate;
      serverState.read = true;
      return json(route, { success: true });
    }
    if (url.pathname === "/api/notifications/unread-count" && request.method() === "GET") {
      return json(route, { count: serverState.read || serverState.cleared ? 0 : 1 });
    }
    if (url.pathname === "/api/notifications" && request.method() === "DELETE") {
      serverState.clearRequests += 1;
      serverState.cleared = true;
      return json(route, { success: true });
    }
    if (url.pathname === "/api/notifications/page" && request.method() === "GET") {
      return json(route, { items: serverState.cleared ? [] : [{
        id: notificationId,
        message: "Review your security settings",
        read: serverState.read,
        isRead: serverState.read,
        createdAt: "2026-09-03T13:00:00.000Z",
        action: { label: "Review", href: "/profile-settings.html#securitySection" },
      }], nextCursor: null, hasMore: false });
    }
    return route.continue();
  });

  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  await expect(page.locator("[data-v2-notification-badge]")).toHaveText("1");
  const secondPage = await context.newPage();
  await openV2Document(secondPage, "/paralegal-v2.html#/home");
  await waitForV2(secondPage, "home");
  await expect(secondPage.locator("[data-v2-notification-badge]")).toHaveText("1");

  await page.getByRole("button", { name: "View notifications, 1 unread" }).click();
  const notification = page.getByText("Review your security settings", { exact: true });
  await notification.click();
  await expect.poll(() => serverState.readRequests).toBe(1);
  await expect(page.locator("[data-v2-notification-badge]")).toHaveText("1");
  confirmRead();
  await expect(page).toHaveURL(/#\/settings\?tab=security$/);
  await waitForV2(page, "settings");
  await expect(page.locator("[data-v2-notification-badge]")).toBeHidden();
  await expect(secondPage.locator("[data-v2-notification-badge]")).toBeHidden();
  await expect(secondPage.getByRole("button", { name: "View notifications" })).toBeVisible();

  await page.getByRole("button", { name: "View notifications" }).click();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  const clearDialog = page.getByRole("dialog", { name: "Clear all notifications?" });
  await expect(clearDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-v2-notifications-panel]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear all", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await clearDialog.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page.getByText("Review your security settings", { exact: true })).toHaveCount(0);
  await expect.poll(() => serverState.clearRequests).toBe(1);
  await secondPage.getByRole("button", { name: "View notifications" }).click();
  await expect(secondPage.locator("[data-v2-notifications-panel]").getByText("No notifications.", { exact: true })).toBeVisible();
  await secondPage.close();
});

test("a recipient notification event updates the badge and panel immediately without navigation", async ({ page }) => {
  const state = { unread: 0, items: [] };
  await installRealtimeHarness(page);
  await page.route("**/api/notifications**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/notifications/unread-count") return json(route, { count: state.unread });
    if (pathname === "/api/notifications/page" && request.method() === "GET") return json(route, { items: state.items, nextCursor: null, hasMore: false });
    return route.continue();
  });
  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  await expect(page.locator("[data-v2-notification-badge]")).toBeHidden();
  const navigationCount = await page.evaluate(() => performance.getEntriesByType("navigation").length);

  state.unread = 1;
  state.items = [{
    id: "64b000000000000000000993",
    message: "Jordan sent a new matter message",
    read: false,
    isRead: false,
    createdAt: "2026-09-03T13:01:00.000Z",
    context: { caseId: MATTER_ID },
    action: { label: "Open messages", href: `/case-detail.html?caseId=${MATTER_ID}&tab=messages` },
  }];
  await page.evaluate(() => {
    window.__emitV2Realtime("/api/notifications/stream", "notifications", { type: "message_created" });
  });

  await expect(page.locator("[data-v2-notification-badge]")).toHaveText("1", { timeout: 2_000 });
  await page.getByRole("button", { name: "View notifications, 1 unread" }).click();
  await expect(page.getByText("Jordan sent a new matter message", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(navigationCount);
});

test("the persistent Assistant keeps its approved copy, submits feedback, and follows explicit V2 matter context", async ({ page }) => {
  await installRealtimeHarness(page);
  const conversation = { id: "64b000000000000000000a01", status: "open" };
  const messageId = (prefix, index) => prefix.repeat(21) + String(index).padStart(3, '0');
  const sentContexts = [];
  const feedback = [];
  const assistantMessages = new Map();
  let responseCount = 0, ownerId;

  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, route => {
    expect(new URL(route.request().url()).searchParams.get('expectedOwnerId')).toBe(ownerId);
    return json(route, {
      id: MATTER_ID, _id: MATTER_ID, title: 'Assistant context Matter', status: 'in progress',
      matterExperience: {
        version: 1,
        header: { title: 'Assistant context Matter', status: { code: 'in_progress', label: 'In progress' }, relationship: 'Assigned paralegal' },
        sections: [{ id: 'overview', label: 'Overview' }, { id: 'messages', label: 'Messages' }],
        overview: { summary: 'Authorized Matter context fixture.', paralegalId: ownerId },
        work: { tasks: [], completed: 0, total: 0, readOnly: false }, activity: [],
      },
    });
  });
  await page.route(url => url.pathname === `/api/messages/${MATTER_ID}`, route => json(route, { messages: [] }));
  await page.route(url => url.pathname === `/api/messages/${MATTER_ID}/read`, route => json(route, { updatedLegacy: 0, updatedReceipts: 0 }));

  await page.route("**/api/support/conversation**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "GET" && path === "/api/support/conversation") {
      return json(route, { conversation });
    }
    if (request.method() === "GET" && path === `/api/support/conversation/${conversation.id}/messages`) {
      return json(route, { conversation, messages: [] });
    }
    if (request.method() === "POST" && path.endsWith("/feedback")) {
      const messageId = path.split("/").at(-2);
      const rating = request.postDataJSON().rating;
      feedback.push({ messageId, rating });
      const existing = assistantMessages.get(messageId);
      return json(route, {
        ok: true,
        message: {
          ...existing,
          metadata: { ...existing.metadata, feedback: { rating, submittedAt: "2026-09-03T13:05:00.000Z" } },
        },
      });
    }
    if (request.method() === "POST" && path === `/api/support/conversation/${conversation.id}/messages`) {
      const body = request.postDataJSON();
      expect(body).toMatchObject({ expectedOwnerId: ownerId, expectedRole: 'paralegal' });
      expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      sentContexts.push(body.pageContext);
      responseCount += 1;
      const userMessage = {
        id: messageId('b', responseCount),
        conversationId: conversation.id,
        sender: "user",
        text: body.text,
        metadata: { kind: "user_message" },
        createdAt: "2026-09-03T13:00:00.000Z",
      };
      const assistantMessage = {
        id: messageId('a', responseCount),
        conversationId: conversation.id,
        sender: "assistant",
        text: responseCount === 1 ? "Open the matter workspace to review the latest messages." : "I’m using the current authorized matter context.",
        metadata: {
          kind: "assistant_reply",
          provider: "openai_manager_paralegal",
          grounded: true,
          primaryAsk: "v2_phase6_context",
          responseMode: "DIRECT_ANSWER",
          actions: responseCount === 1
            ? [{ label: "Open matter messages", href: `/case-detail.html?caseId=${MATTER_ID}&tab=messages` }]
            : [],
          suggestedReplies: [],
          needsEscalation: false,
          escalation: null,
        },
        createdAt: "2026-09-03T13:00:01.000Z",
      };
      assistantMessages.set(assistantMessage.id, assistantMessage);
      return json(route, { ok: true, request: { id: body.requestId, action: 'send', state: 'succeeded' }, conversation, userMessage, assistantMessage }, 201);
    }
    return route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  ownerId = await page.evaluate(() => { const user = JSON.parse(localStorage.getItem('lpc_user')); return String(user.id || user._id); });
  expect(ownerId).toMatch(/^[a-f0-9]{24}$/i);
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  const drawer = page.locator("[data-v2-persistent='assistant']");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("AI can make mistakes. Check important information.");
  await expect(drawer).not.toContainText(/Checking that now|Describe what(?:'|’)s blocking you/i);
  const geometry = await drawer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: element.getBoundingClientRect().width, shadow: style.boxShadow };
  });
  // The restored workspace shell's retained --v2-assistant-width is 420px.
  expect(geometry.width).toBe(420);
  expect(geometry.shadow).toBe("none");

  await drawer.locator("[data-support-textarea]").fill("Where are the matter messages?");
  await drawer.locator("[data-support-submit]").click();
  const firstAnswer = drawer.locator(".support-message--assistant").last();
  await expect(firstAnswer).toContainText("Open the matter workspace");
  await firstAnswer.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(firstAnswer.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(feedback).toEqual([{ messageId: messageId('a', 1), rating: "helpful" }]);
  expect(sentContexts[0]).toMatchObject({ viewName: "paralegal-home", hash: "#/home", caseId: "" });

  await drawer.evaluate((element) => { element.dataset.phase6Identity = "same-assistant"; });
  await firstAnswer.getByRole("button", { name: "Open matter messages" }).click();
  await expect(page).toHaveURL(new RegExp(`#\\/matter\\/${MATTER_ID}\\?tab=messages$`));
  await waitForV2(page, "matter");
  await expect(page.getByRole('heading', { level: 1, name: 'Assistant context Matter', exact: true })).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/support-drawer-open/);
  await expect(drawer).toHaveAttribute("data-phase6-identity", "same-assistant");

  await drawer.locator("[data-support-textarea]").fill("What matter are we discussing?");
  await drawer.locator("[data-support-submit]").click();
  await expect(drawer.locator(".support-message--assistant").last()).toContainText("current authorized matter context");
  expect(sentContexts[1]).toMatchObject({
    viewName: "case-detail",
    hash: `#/matter/${MATTER_ID}?tab=messages`,
    caseId: MATTER_ID,
  });

  await page.getByRole("link", { name: "LPC Home", exact: true }).click();
  await waitForV2(page, "home");
  await expect(drawer).toBeVisible();
  await drawer.locator("[data-support-textarea]").fill("What can I do from Home?");
  await drawer.locator("[data-support-submit]").click();
  await expect.poll(() => sentContexts.length).toBe(3);
  await expect(drawer.locator(`[data-support-message-id="${messageId('a', 3)}"]`)).toBeVisible();
  expect(sentContexts[2]).toMatchObject({ viewName: "paralegal-home", hash: "#/home", caseId: "" });
});

test("Help and every global overlay remain bounded at mobile, tablet, and desktop widths", async ({ page }) => {
  await openV2Document(page, "/paralegal-v2.html#/help");
  await waitForV2(page, "help");

  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 768, height: 900 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const base = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      outletScrollable: document.querySelector("[data-v2-route-outlet]").scrollHeight
        > document.querySelector("[data-v2-route-outlet]").clientHeight,
    }));
    expect(base.pageWidth, `${viewport.width}px page overflow`).toBeLessThanOrEqual(base.viewport + 1);
    expect(base.outletScrollable, `${viewport.width}px Help scrolling`).toBe(true);

    const openTools = async () => {
      if (viewport.width <= 900 && (await page.locator("body").getAttribute("class")).includes("v2-nav-open")) {
        await page.getByRole("button", { name: "Close navigation", exact: true }).click();
      }
    };
    await openTools();
    const searchInput = page.locator("[data-v2-search-input]");
    await searchInput.click();
    await searchInput.fill("ma");
    await expect(page.locator("[data-v2-search-panel]")).toBeVisible();
    const search = await page.locator("[data-v2-search-panel]").boundingBox();
    expect(search.x, `${viewport.width}px search left edge`).toBeGreaterThanOrEqual(0);
    expect(search.x + search.width, `${viewport.width}px search right edge`).toBeLessThanOrEqual(viewport.width + 1);
    await searchInput.fill("");
    await page.keyboard.press("Escape");
    await openTools();

    await page.getByRole("button", { name: /View notifications/ }).click();
    const notifications = await page.locator("[data-v2-notifications-panel]").boundingBox();
    expect(notifications.x, `${viewport.width}px notifications left edge`).toBeGreaterThanOrEqual(0);
    expect(notifications.x + notifications.width, `${viewport.width}px notifications right edge`).toBeLessThanOrEqual(viewport.width + 1);
    await page.keyboard.press("Escape");

    await openTools();
    await page.getByRole("button", { name: "Open LPC Assistant" }).click();
    const drawer = page.locator("[data-v2-persistent='assistant']");
    await expect.poll(async () => {
      const box = await drawer.boundingBox();
      return box ? Math.round(box.x + box.width) : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(viewport.width + 1);
    const assistant = await drawer.boundingBox();
    expect(assistant.x, `${viewport.width}px Assistant left edge`).toBeGreaterThanOrEqual(0);
    expect(assistant.x + assistant.width, `${viewport.width}px Assistant right edge`).toBeLessThanOrEqual(viewport.width + 1);
    expect(assistant.width, `${viewport.width}px Assistant width`).toBe(Math.min(viewport.width, 420));
    await expect(drawer).toHaveAttribute("aria-modal", viewport.width >= 1101 ? "false" : "true");
    await drawer.getByRole("button", { name: "Close assistant" }).click();
  }
});

test("usability: Help describes the V2 journey and readable supporting text", async ({ page }) => {
  await page.route('**/api/users/me/onboarding', route => json(route, { onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await openV2Document(page, '/paralegal-v2.html#/help');
  await waitForV2(page, 'help');
  const guide = page.getByRole('article', { name: 'Paralegal Help guide' });
  await expect(guide).toContainText('After your account is approved.');
  await expect(guide).toContainText('Choose Review full invitation');
  await expect(guide).toContainText('Submitting a file does not approve work or release payment');
  await expect(guide).not.toContainText('applicable review period ends');
  const label = page.locator('.v2-help-heading p').first();
  await expect(label).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.classList.toggle('theme-dark', theme === 'dark'); document.documentElement.style.fontSize = '16px'; }, theme);
    expect(await label.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13);
    await page.evaluate(() => { document.documentElement.style.fontSize = '22px'; });
    expect(await label.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('office polish: Help discloses answers with keyboard control and retains the open answer', async ({ page }, testInfo) => {
  await openV2Document(page, '/paralegal-v2.html#/help');
  await waitForV2(page, 'help');
  const answer = page.locator('.v2-help-answer').filter({ hasText: 'How do I respond to a revision request?' });
  await expect(answer.locator('p')).toBeHidden();
  await expect(answer.locator('summary')).toHaveAccessibleName('How do I respond to a revision request?');
  await answer.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(answer.locator('p')).toBeVisible();
  await page.getByRole('link', { name: 'LPC Home', exact: true }).click();
  await waitForV2(page, 'home');
  await page.locator('.v2-nav').getByRole('link', { name: 'Help', exact: true }).click();
  await waitForV2(page, 'help');
  await expect(answer.locator('p')).toBeVisible();
  await page.getByRole('button', { name: 'Getting paid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Getting paid', exact: true })).toBeFocused();
  await require('./office-polish-review').reviewOffice(page, testInfo, 'help');
});

test("notification center fits the actual paralegal shell with long content and enlarged text", async ({ page }, testInfo) => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: (900 + i).toString(16).padStart(24, "0"), read: false, isRead: false,
    message: `Jordan updated the review instructions for the multi-jurisdiction commercial litigation Matter ${i + 1}`,
    actorFirstName: "Jordan",
    createdAt: "2026-09-09T14:00:00.000Z", action: { label: "Review instructions", href: `/case-detail.html?caseId=${MATTER_ID}&tab=work` },
  }));
  await page.route("**/api/notifications**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/notifications/stream") return route.fulfill({ status: 204, body: "" });
    if (path === "/api/notifications/unread-count") return json(route, { count: items.length });
    if (path === "/api/notifications/page") return json(route, { items, nextCursor: null, hasMore: false });
    return route.continue();
  });
  await openV2Document(page, "/paralegal-v2.html#/home");
  await waitForV2(page, "home");
  await expect(page.locator("[data-v2-notification-badge]")).toHaveText("8");
  for (const [width, theme, size] of [[1440, "light", 16], [390, "light", 16], [390, "dark", 16], [320, "dark", 16], [390, "dark", 20]]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(({ theme, size }) => { document.documentElement.classList.toggle("theme-dark", theme === "dark"); document.documentElement.style.fontSize = `${size}px`; }, { theme, size });
    if (width <= 900 && (await page.locator("body").getAttribute("class")).includes("v2-nav-open")) await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    await page.getByRole("button", { name: "View notifications, 8 unread" }).click();
    const panel = page.locator("[data-v2-notifications-panel]");
    await expect(panel).toBeVisible();
    const dimensions = await panel.evaluate(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, bottom: rect.bottom, scroll: element.scrollWidth, client: element.clientWidth }; });
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(width + 1);
    expect(dimensions.bottom).toBeLessThanOrEqual(845);
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
    expect((await new AxeBuilder({ page }).include("[data-v2-notifications-panel]").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
    await panel.screenshot({ path: testInfo.outputPath(`notifications-${width}-${theme}-${size}.png`) });
    await panel.getByRole("button", { name: "Close notifications", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole("button", { name: "View notifications, 8 unread" })).toBeFocused();
  }
});
