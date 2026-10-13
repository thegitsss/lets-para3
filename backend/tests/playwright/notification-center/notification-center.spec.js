const { test: base, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const { OWNER, OTHER, items, startServer } = require("./server");

const test = base.extend({
  mock: async ({}, use) => {
    const server = await startServer();
    try { await use(server); } finally { await server.close(); }
  },
});
const rows = page => page.locator("#content .v2-notification");
const filter = (page, label) => page.getByRole("group", { name: "Filter notifications" }).getByRole("button", { name: label, exact: true });
const button = (page, label) => page.locator("#panel").getByRole("button", { name: label, exact: true });

test.beforeEach(async ({ context, mock }) => {
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === mock.url ? route.continue() : route.abort("blockedbyclient");
  });
});

async function mount(page, mock, { total = 5, readEvery = 0 } = {}) {
  if (!mock.state.records.length) mock.state.records = items(total, { readEvery });
  await page.goto(`${mock.url}/fixture.html`);
  await expect.poll(() => page.evaluate(() => Boolean(window.harness))).toBe(true);
  if (!mock.state.stallReads && !mock.state.override) await expect(rows(page)).toHaveCount(Math.min(total, 100));
}

test("more than 100 records, All/Unread filters and exact badge remain reachable", async ({ page, mock }) => {
  await mount(page, mock, { total: 237, readEvery: 3 });
  await expect(page.locator("#badge")).toHaveText("99+");
  await expect(page.locator("#trigger")).toHaveAttribute("aria-label", "View notifications, 158 unread");
  const seen = await rows(page).locator("strong").allTextContents();
  await button(page, "Older").click();
  await expect(rows(page)).toHaveCount(100);
  seen.push(...await rows(page).locator("strong").allTextContents());
  await button(page, "Older").click();
  await expect(rows(page)).toHaveCount(37);
  seen.push(...await rows(page).locator("strong").allTextContents());
  expect(new Set(seen).size).toBe(237);
  await expect(button(page, "Older")).toHaveCount(0);
  await button(page, "Latest").click();
  await expect(rows(page)).toHaveCount(100);
  await filter(page, "Unread").click();
  await expect(rows(page)).toHaveCount(100);
  expect(await rows(page).evaluateAll(elements => elements.every(element => element.classList.contains("is-unread")))).toBe(true);
  await button(page, "Older").click();
  await expect(rows(page)).toHaveCount(58);
  await expect(page.locator("#trigger")).toHaveAttribute("aria-label", "View notifications, 158 unread");
  expect(mock.state.requests.filter(entry => entry.path.endsWith("/page")).every(entry => entry.query.expectedOwnerId === OWNER)).toBe(true);
});

test("baseline regression: malformed mutation is not confirmed and does not publish sync", async ({ page, mock }) => {
  await mount(page, mock);
  const id = mock.state.records[0].id;
  mock.state.faults.push({ method: "POST", pathname: `/api/notifications/${id}/read`, body: {} });
  const confirmed = await page.evaluate(() => window.harness.center.readInContext(window.harness.center.getItems()[0]));
  expect(confirmed).toBe(false);
  expect(await page.evaluate(() => window.harness.sync.length)).toBe(0);
  await expect(page.locator("#trigger")).toHaveAttribute("aria-label", "View notifications, 5 unread");
  await expect(page.locator("#toast")).toContainText("could not be confirmed");
});

test("baseline regression: a delayed read cannot navigate after route intent changes", async ({ page, mock }) => {
  await mount(page, mock);
  const id = mock.state.records[0].id;
  const release = mock.holdNext("POST", `/api/notifications/${id}/read`);
  try {
    await rows(page).first().locator(".v2-notification-body").click();
    await expect.poll(() => mock.state.requests.some(entry => entry.method === "POST" && entry.path.endsWith(`/${id}/read`))).toBe(true);
    await page.getByRole("button", { name: "Leave this Matter" }).click();
  } finally { release(); }
  await expect(page.locator("#trigger")).toHaveAttribute("aria-label", "View notifications, 4 unread");
  expect(await page.evaluate(() => window.harness.navigations)).toEqual([]);
  expect(new URL(page.url()).hash).toBe("#/another-matter");
});

test("baseline regression: keyboard filter focus survives the loading render", async ({ page, mock }) => {
  await mount(page, mock, { total: 9, readEvery: 3 });
  await filter(page, "Unread").focus();
  await page.keyboard.press("Enter");
  await expect(rows(page)).toHaveCount(6);
  await expect(filter(page, "Unread")).toBeFocused();
});

test("baseline regression: polling cannot indefinitely reset a stalled read timeout", async ({ page, mock }) => {
  await page.clock.install({ time: new Date("2026-09-09T12:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-09-09T12:00:01.000Z"));
  mock.state.stallReads = true;
  await mount(page, mock);
  await expect.poll(() => mock.state.requests.filter(entry => entry.method === "GET").length).toBeGreaterThanOrEqual(2);
  await page.clock.runFor(31_000);
  await expect(page.getByText("Notifications are temporarily unavailable.", { exact: true })).toBeVisible();
  await expect(page.locator("#trigger")).toHaveAttribute("aria-label", "View notifications, unread count unavailable");
});

test("dismiss, mark-all and clear preserve truthful failure and explicit retry", async ({ page, mock }) => {
  await mount(page, mock);
  const id = mock.state.records[0].id;
  mock.state.faults.push({ method: "DELETE", pathname: `/api/notifications/${id}`, status: 503 });
  await rows(page).first().getByRole("button", { name: /^Dismiss:/ }).click();
  await expect(page.locator("#toast")).toContainText("could not be confirmed");
  await expect(rows(page)).toHaveCount(5);
  await rows(page).first().getByRole("button", { name: /^Dismiss:/ }).click();
  await expect(rows(page)).toHaveCount(4);
  mock.state.faults.push({ method: "POST", pathname: "/api/notifications/read-all", status: 503 });
  await button(page, "Mark all as read").click();
  await expect(page.locator("#trigger")).toHaveAttribute("aria-label", "View notifications, 4 unread");
  await button(page, "Mark all as read").click();
  await expect(page.locator("#badge")).toBeHidden();
  await button(page, "Clear all").click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  expect(mock.state.records).toHaveLength(4);
  mock.state.faults.push({ method: "DELETE", pathname: "/api/notifications", status: 503 });
  await button(page, "Clear all").click();
  await page.getByRole("dialog").getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  await button(page, "Clear all").click();
  await page.getByRole("dialog").getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page.getByText("No notifications.", { exact: true })).toBeVisible();
  expect(mock.state.records).toHaveLength(0);
  expect(mock.state.requests.filter(entry => entry.method !== "GET").every(entry => entry.body.expectedOwnerId === OWNER)).toBe(true);
});

test("malformed page/count and unavailable responses show recovery instead of empty success", async ({ page, mock }) => {
  // Keep this explicit retry case independent of passive refresh timing.
  // Native event delivery and reconnect remain covered in separate tests.
  await page.clock.install({ time: new Date("2026-09-09T12:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-09-09T12:00:01.000Z"));
  await mount(page, mock);
  for (const mode of ["page", "count", "server"]) {
    mock.state.override = pathname => mode === "server" ? { status: 503, body: { message: "Synthetic unavailable" } }
      : mode === "count" && pathname.endsWith("unread-count") ? { body: { count: -1 } }
        : mode === "page" && pathname.endsWith("page") ? { body: { items: [], nextCursor: "invalid", hasMore: true } } : null;
    await page.evaluate(() => window.harness.center.load());
    await expect(page.getByText("Notifications are temporarily unavailable.", { exact: true })).toBeVisible();
    await expect(page.locator("#badge")).toHaveText("!");
    await expect(page.getByText("No notifications.", { exact: true })).toHaveCount(0);
    mock.state.override = null;
    await button(page, "Try again").click();
    await expect(rows(page)).toHaveCount(5);
  }
});

test("unchanged refresh preserves the actual focused node", async ({ page, mock }) => {
  await mount(page, mock);
  await rows(page).first().getByRole("button", { name: /^Dismiss:/ }).focus();
  await page.evaluate(() => { window.originalNotificationFocus = document.activeElement; });
  await page.evaluate(() => window.harness.center.load());
  expect(await page.evaluate(() => window.originalNotificationFocus === document.activeElement && document.activeElement.isConnected)).toBe(true);
});

test("unchanged notifications keep their displayed age current without replacing focus", async ({ page, mock }) => {
  const now = new Date("2026-09-09T12:00:00.000Z");
  await page.clock.setFixedTime(now);
  mock.state.records = items(1).map(item => ({ ...item, createdAt: now.toISOString(), actorFirstName: "Amélie" }));
  await mount(page, mock, { total: 1 });
  const timestamp = rows(page).first().locator("time");
  await expect(timestamp).toHaveText("now");
  await filter(page, "All").focus();
  await page.evaluate(() => { window.retainedNotificationFocus = document.activeElement; });
  // Advance calendar time without jumping across outstanding network deadlines.
  await page.clock.setFixedTime(new Date(now.getTime() + 65000));
  await page.evaluate(() => window.harness.center.load());
  await expect(timestamp).toHaveText("1 minute ago");
  expect(await page.evaluate(() => document.activeElement === window.retainedNotificationFocus)).toBe(true);
});

test("keyboard pagination keeps the next focused control visible through the final page", async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, mock, { total: 237 });
  for (const count of [100, 37]) {
    await button(page, "Older").scrollIntoViewIfNeeded();
    await button(page, "Older").focus();
    await page.keyboard.press("Enter");
    await expect(rows(page)).toHaveCount(count);
    await expect(page.locator("#panel :focus")).toHaveCount(1);
    await expect(page.locator("#panel :focus")).toBeInViewport({ ratio: 1 });
  }
});

test("deleting the last item of an older page preserves a route back to newer records", async ({ page, mock }) => {
  await mount(page, mock, { total: 101 });
  await button(page, "Older").click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().getByRole("button", { name: /^Dismiss:/ }).click();
  await expect(page.getByText("No older notifications.", { exact: true })).toBeVisible();
  await button(page, "Newer").click();
  await expect(rows(page)).toHaveCount(100);
  expect(mock.state.records).toHaveLength(100);
});

test("late account-A read is discarded after account B starts", async ({ page, mock }) => {
  mock.state.records = [...items(5), ...items(2, { owner: OTHER, prefix: "Other account" })];
  const release = mock.holdNext("GET", "/api/notifications/page");
  try {
    await page.goto(`${mock.url}/fixture.html`);
    await expect.poll(() => mock.state.requests.some(entry => entry.path.endsWith("page"))).toBe(true);
    await page.evaluate(id => window.harness.changeAccount(id), OTHER);
    await expect(rows(page)).toHaveCount(2);
  } finally { release(); }
  await expect(rows(page).first()).toContainText("Other account");
  expect(await rows(page).locator("strong").allTextContents()).toEqual(items(2, { owner: OTHER, prefix: "Other account" }).map(item => item.message));
  await expect(page.locator("#trigger")).toHaveAttribute("aria-label", "View notifications, 2 unread");
});

test("a clear confirmation opened for A cannot clear B after an account switch", async ({ page, mock }) => {
  await mount(page, mock);
  mock.state.records.push(...items(2, { owner: OTHER, prefix: "Other account" }));
  await button(page, "Clear all").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(id => window.harness.changeAccount(id), OTHER);
  await page.getByRole("dialog").getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  expect(mock.state.requests.filter(entry => entry.method === "DELETE" && entry.path === "/api/notifications")).toHaveLength(0);
  expect(mock.state.records.filter(item => item.owner === OTHER)).toHaveLength(2);
});

test("replacement-account cookies cannot supply an initial page or count to old identity", async ({ page, mock }) => {
  await mount(page, mock);
  mock.state.records.push(...items(2, { owner: OTHER, prefix: "Other account" }));
  await page.evaluate(id => { document.cookie = `mock_owner=${id}; path=/`; }, OTHER);
  await page.evaluate(() => window.harness.center.load());
  await expect(page.getByText("Notifications are temporarily unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Other account/)).toHaveCount(0);
  expect(mock.state.records.filter(item => item.owner === OTHER)).toHaveLength(2);
});

test("native SSE refresh and same-account BroadcastChannel reconcile the badge", async ({ page, context, mock }) => {
  await mount(page, mock);
  const second = await context.newPage();
  await second.goto(`${mock.url}/fixture.html`);
  await expect(rows(second)).toHaveCount(5);
  mock.state.records.unshift({ ...items(6)[0], message: "A streamed update" });
  mock.emit();
  await expect(page.getByText("A streamed update", { exact: true })).toBeVisible();
  await expect(second.locator("#trigger")).toHaveAttribute("aria-label", "View notifications, 6 unread");
  // Fixture mutations deliberately emit no server event; this second refresh
  // must arrive through the controller's real cross-tab channel/storage signal.
  await button(page, "Mark all as read").click();
  await expect(second.locator("#badge")).toBeHidden();
  await expect(second.locator("#trigger")).toHaveAttribute("aria-label", "View notifications");
  await second.close();
});

test("native SSE reconnect resumes updates after a stream closes", async ({ page, mock }) => {
  await page.clock.install({ time: new Date("2026-09-09T12:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-09-09T12:00:01.000Z"));
  await mount(page, mock);
  await expect.poll(() => mock.state.streams.size).toBe(1);
  mock.disconnect();
  await expect.poll(() => mock.state.streams.size).toBe(0);
  await page.clock.runFor(5100);
  await expect.poll(() => mock.state.streams.size).toBe(1);
  mock.state.records.unshift({ ...items(6)[0], message: "After reconnect" });
  mock.emit();
  await page.clock.runFor(200);
  await expect(page.getByText("After reconnect", { exact: true })).toBeVisible();
});

async function settledDialog(page) {
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.endsWith("/dialogs.css")));
  await page.evaluate(() => document.fonts.ready);
}

for (const exit of ["cancel", "confirm", "escape"]) {
  test(`common dialog keyboard ${exit} restores its connected launcher`, async ({ page, mock }) => {
    await mount(page, mock);
    await page.evaluate(async () => {
      const { confirmAction } = await import("/assets/scripts/utils/dialogs.js");
      const launcher = document.createElement("button");
      launcher.textContent = "Open common dialog";
      launcher.onclick = () => { window.commonResult = undefined; void confirmAction("Synthetic confirmation", { title: "Common dialog", tone: "danger" }).then(result => { window.commonResult = result; }); };
      document.querySelector("main").append(launcher);
    });
    const launcher = page.getByRole("button", { name: "Open common dialog", exact: true });
    await launcher.focus();
    await page.keyboard.press("Enter");
    await settledDialog(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Confirm", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    if (exit === "escape") await page.keyboard.press("Escape");
    else { if (exit === "confirm") await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Enter"); }
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.commonResult)).toBe(exit === "confirm");
    await expect(launcher).toBeFocused();
  });
}

for (const exit of ["cancel", "escape", "confirm"]) {
  test(`clear dialog ${exit} restores a current control after live refresh replaces its launcher`, async ({ page, mock }) => {
    await mount(page, mock);
    await button(page, "Clear all").focus();
    await page.evaluate(() => { window.oldClearLauncher = document.activeElement; });
    await page.keyboard.press("Enter");
    await settledDialog(page);
    mock.state.records.unshift({ ...items(6)[0], message: "Arrived during confirmation" });
    await page.evaluate(() => window.harness.center.load());
    expect(await page.evaluate(() => window.oldClearLauncher.isConnected)).toBe(false);
    const dialog = page.getByRole("dialog");
    if (exit === "escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: exit === "confirm" ? "Clear all" : "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(exit === "confirm" ? filter(page, "All") : button(page, "Clear all")).toBeFocused();
    expect(mock.state.records).toHaveLength(exit === "confirm" ? 0 : 6);
  });
}

test("common prompt keeps required validation and sequential alert behavior", async ({ page, mock }) => {
  await mount(page, mock);
  await page.evaluate(async () => {
    const { promptForText, showAlert } = await import("/assets/scripts/utils/dialogs.js");
    const launcher = document.createElement("button");
    launcher.textContent = "Open common prompt";
    launcher.onclick = () => {
      void promptForText("Synthetic prompt", { title: "Required details", required: true, multiline: false }).then(result => { window.promptResult = result; });
      void showAlert("Queued synthetic alert", { title: "Next dialog" }).then(() => { window.alertComplete = true; });
    };
    document.querySelector("main").append(launcher);
  });
  const launcher = page.getByRole("button", { name: "Open common prompt", exact: true });
  await launcher.focus(); await page.keyboard.press("Enter"); await settledDialog(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("Enter the requested information to continue.");
  await expect(dialog.getByLabel("Details")).toBeFocused();
  await dialog.getByLabel("Details").fill("  Preserved details  ");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveAccessibleName("Next dialog");
  expect(await page.evaluate(() => window.promptResult)).toBe("Preserved details");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();
  expect(await page.evaluate(() => window.alertComplete)).toBe(true);
});

for (const scenario of [
  { name: "desktop-light", width: 1366, height: 768, dark: false },
  { name: "mobile-light", width: 390, height: 844, dark: false },
  { name: "mobile-dark", width: 390, height: 844, dark: true },
  { name: "small-mobile-light", width: 320, height: 640, dark: false },
  { name: "small-mobile-dark", width: 320, height: 640, dark: true },
  { name: "text-200-mobile", width: 390, height: 844, dark: false, text: 2 },
  { name: "text-200-small-mobile", width: 320, height: 640, dark: false, text: 2 },
  // Reduced layout viewport models the reflow of a 1366x768 window at 200%.
  // Body CSS zoom was diagnosed separately; it is not native browser zoom.
  { name: "zoom-200-layout-reflow", width: 683, height: 384, dark: false },
]) {
  test(`shared center ${scenario.name} keeps controls accessible`, async ({ page, mock }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: scenario.dark ? "dark" : "light" });
    mock.state.records = items(105);
    mock.state.records[0].actorFirstName = "Amélie";
    mock.state.records[0].message = "Amélie added a file to the Matter with an unusually long title that wraps naturally within the available space.";
    await mount(page, mock, { total: 105 });
    await expect(rows(page).first().locator(".lpc-notification-avatar")).toHaveText("A");
    await page.evaluate(({ dark, zoom, text }) => {
      document.documentElement.classList.toggle("theme-dark", dark);
      document.body.style.zoom = String(zoom || 1);
      if (text) document.documentElement.style.fontSize = `${16 * text}px`;
    }, scenario);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    const textColumns = await rows(page).locator(".v2-notification-copy").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
    expect(textColumns.every(left => Math.abs(left - textColumns[0]) <= 1)).toBe(true);
    const controls = page.locator("#panel button, #panel a");
    expect(await controls.evaluateAll(elements => elements.every(element => element.getBoundingClientRect().width > 0))).toBe(true);
    const centerAudit = await new AxeBuilder({ page }).analyze();
    expect(centerAudit.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-center.png`), fullPage: true });
    // Safari pointer activation need not focus a button. Keyboard return is the
    // actual focus contract, so explicitly establish keyboard launch intent.
    await button(page, "Clear all").focus(); await page.keyboard.press("Enter");
    await settledDialog(page);
    const dialog = page.getByRole("dialog");
    const geometry = await dialog.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, viewport: innerWidth, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    // Tall text may scroll within the dialog; both actions must be reachable
    // without horizontal clipping and remain inside the viewport when focused.
    for (const label of ["Clear all", "Cancel"]) {
      const action = dialog.getByRole("button", { name: label, exact: true });
      await action.focus();
      await action.scrollIntoViewIfNeeded();
      const box = await action.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(scenario.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.y + box.height).toBeLessThanOrEqual(scenario.height + 1);
    }
    const audit = await new AxeBuilder({ page }).analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}.png`), fullPage: true });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(button(page, "Clear all")).toBeFocused();
  });
}


test('refined center groups nearby Matter updates without losing rows or destinations', async ({ page, mock }) => {
  mock.state.records = items(4);
  const [first, second, third] = mock.state.records;
  second.context = { ...first.context, matterTitle: 'Oakwood discovery' };
  first.context.matterTitle = 'Oakwood discovery';
  third.context = { ...first.context };
  third.createdAt = new Date(new Date(first.createdAt).getTime() - 360000).toISOString();
  await page.goto(`${mock.url}/fixture.html?refined=1`);
  await expect(rows(page)).toHaveCount(4);
  await expect(page.locator('.lpc-notification-related')).toHaveCount(1);
  await expect(page.locator('.lpc-notification-related .v2-notification')).toHaveCount(2);
  await expect(page.getByText('2 updates · Oakwood discovery')).toBeVisible();
  await page.getByLabel('Notification options', {exact:true}).click();
  await expect(button(page, 'Dismiss all')).toBeVisible();
  await page.keyboard.press('Escape');
  await rows(page).nth(1).locator('.v2-notification-body').click();
  await expect.poll(() => page.evaluate(() => window.harness.navigations)).toEqual([second.action.href]);
  await expect(page.locator('#trigger')).toHaveAttribute('aria-label', 'View notifications, 3 unread');
});

test('refined empty states and dismiss-all confirmation remain distinct from marking read', async ({ page, mock }) => {
  mock.state.records = items(1, { readEvery: 1 });
  await page.goto(`${mock.url}/fixture.html?refined=1`);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByText('Caught up', { exact: true })).toBeVisible();
  await expect(filter(page, 'Unread')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
  await page.getByLabel('Notification options', {exact:true}).evaluate(e=>e.parentElement.open=true);
  await button(page, 'Dismiss all').click();
  await page.getByRole('dialog').getByRole('button', {name:'Cancel',exact:true}).click();
  await expect(rows(page)).toHaveCount(1);
  await page.getByLabel('Notification options', {exact:true}).evaluate(e=>e.parentElement.open=true);
  await button(page, 'Dismiss all').click();
  await page.getByRole('dialog').getByRole('button', {name:'Dismiss all',exact:true}).click();
  await expect(page.getByText('No notifications yet', { exact:true })).toBeVisible();
});


test('refined unread count becomes a non-clickable caught-up status and returns to All', async ({ page, mock }) => {
  mock.state.records = items(2);
  await page.goto(`${mock.url}/fixture.html?refined=1`);
  await expect(filter(page, 'Unread (2)')).toBeVisible();
  await filter(page, 'Unread (2)').click();
  await page.getByLabel('Notification options', {exact:true}).click();
  await button(page, 'Mark all as read').click();
  await expect(page.getByText('Caught up', { exact:true })).toBeVisible();
  await expect(filter(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.lpc-notification-caught-up')).not.toHaveAttribute('tabindex');
  expect(mock.state.records.every(item=>item.isRead || item.read)).toBe(true);
});


test('refined event text separates context and gear closes with Escape', async ({page,mock})=>{
  mock.state.records=items(1);
  Object.assign(mock.state.records[0],{headline:'Jordan applied',contextLabel:'Oakwood discovery',actorFirstName:'Jordan'});
  await page.goto(`${mock.url}/fixture.html?refined=1`);
  await expect(rows(page).locator('strong')).toHaveText('Jordan applied');
  await expect(rows(page).locator('.lpc-notification-meta')).toContainText('Oakwood discovery');
  await expect(button(page,'Dismiss all')).toBeHidden();
  const gear=page.getByLabel('Notification options',{exact:true});await gear.click();
  await expect(button(page,'Dismiss all')).toBeVisible();await page.keyboard.press('Escape');
  await expect(button(page,'Dismiss all')).toBeHidden();await expect(gear).toBeFocused();
});


test('refined row options toggle read state, dismiss, and close without navigating', async ({page,mock}) => {
  mock.state.records = items(2);
  await page.goto(`${mock.url}/fixture.html?refined=1`);
  await expect(rows(page)).toHaveCount(2);
  const toggle = () => rows(page).first().locator('summary');
  await expect(rows(page).locator('.v2-notification-dismiss')).toHaveCount(0);
  await toggle().click();
  await expect(button(page, 'Mark as read')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button(page, 'Mark as read')).toBeHidden();
  await expect(toggle()).toBeFocused();
  await toggle().click();
  await button(page, 'Mark as read').click();
  await expect(rows(page).first()).not.toHaveClass(/is-unread/);
  await expect(toggle()).toBeFocused();
  await expect(page.locator('#trigger')).toHaveAttribute('aria-label', 'View notifications, 1 unread');
  await toggle().click();
  await button(page, 'Mark as unread').click();
  await expect(rows(page).first()).toHaveClass(/is-unread/);
  await expect(page.locator('#trigger')).toHaveAttribute('aria-label', 'View notifications, 2 unread');
  await toggle().click();
  await page.getByRole('heading').first().click();
  await expect(button(page, 'Dismiss notification')).toBeHidden();
  await toggle().click();
  await button(page, 'Dismiss notification').click();
  await expect(rows(page)).toHaveCount(1);
  expect(await page.evaluate(() => window.harness.navigations)).toEqual([]);
});
