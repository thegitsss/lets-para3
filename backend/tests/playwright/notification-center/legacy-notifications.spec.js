const { test: base, expect } = require("playwright/test");
const { items, startServer } = require("./server");
const AxeBuilder = require("@axe-core/playwright").default;
const test = base.extend({ mock: async ({}, use) => { const server = await startServer(); try { await use(server); } finally { await server.close(); } } });
const badge = page => page.locator("[data-notification-badge]");
const rows = page => page.locator(".notif-item");
async function mount(page, mock, query = "") {
  mock.state.records = mock.state.records.map(item => ({ ...item, action: { label: "View Matter", href: `/case-detail.html?caseId=${item.id}` } }));
  await page.goto(`${mock.url}/legacy-fixture.html${query}`);
  await page.waitForFunction(() => Boolean(window.legacyNotifications));
}
async function open(page) {
  if (!(await page.locator("[data-notification-panel]").isVisible())) await page.locator("[data-notification-toggle]").click();
}
test.beforeEach(async ({ page }) => {
  page.notificationErrors = [];
  page.on("pageerror", error => page.notificationErrors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(page.notificationErrors).toEqual([]); });

for (const listOnly of [false, true]) test(`exact unread count survives 100 newer read notices (${listOnly ? "list" : "center"})`, async ({ page, mock }) => {
  mock.state.records = items(102).map((item, index) => ({ ...item, read: index < 100, isRead: index < 100 }));
  await mount(page, mock, listOnly ? "?listOnly" : "");
  await expect(badge(page)).toHaveText("2");
  await expect(rows(page)).toHaveCount(100);
  await expect(page.locator("[data-notification-toggle]")).toHaveAttribute("aria-label", "View notifications, 2 unread");
  if (!listOnly) {
    await open(page);
    await page.getByRole("button", { name: "Mark all as read" }).click();
    await expect(badge(page)).toHaveText("0");
    expect(mock.state.records.every(item => item.read)).toBe(true);
  }
});

test("failed or malformed counts show unavailable and recover to the exact count", async ({ page, mock }) => {
  mock.state.records = items(3);
  mock.state.override = path => path.endsWith("/unread-count") ? { status: 503, body: { message: "Unavailable" } } : null;
  await mount(page, mock);
  await expect(badge(page)).toHaveText("!");
  await expect(page.locator("[data-notification-toggle]")).toHaveAttribute("aria-label", /unavailable/);
  mock.state.override = path => path.endsWith("/unread-count") ? { body: { count: "3" } } : null;
  await page.evaluate(() => window.refreshNotificationCenters());
  await expect(badge(page)).toHaveText("!");
  mock.state.override = null;
  await page.evaluate(() => window.refreshNotificationCenters());
  await expect(badge(page)).toHaveText("3");
});

test("failed dismiss and malformed mark-all receipts do not change records or claim success", async ({ page, mock }) => {
  mock.state.records = items(3);
  await mount(page, mock);
  await expect(badge(page)).toHaveText("3");
  await open(page);
  const firstId = mock.state.records[0].id;
  mock.state.faults.push({ method: "DELETE", pathname: `/api/notifications/${firstId}`, status: 503 });
  await rows(page).first().getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.locator("[data-notification-feedback]")).toContainText("could not be confirmed");
  await expect(rows(page)).toHaveCount(3);
  await expect(badge(page)).toHaveText("3");
  mock.state.faults.push({ method: "POST", pathname: "/api/notifications/read-all", body: {} });
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(page.locator("[data-notification-feedback]")).toContainText("could not be confirmed");
  await expect(badge(page)).toHaveText("3");
  expect(mock.state.records.every(item => !item.read)).toBe(true);
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(badge(page)).toHaveText("0");
});

test("an older in-flight count cannot overwrite a confirmed mark-all", async ({ page, mock }) => {
  mock.state.records = items(2);
  await mount(page, mock);
  await expect(badge(page)).toHaveText("2");
  await open(page);
  const release = mock.holdNext("GET", "/api/notifications/unread-count");
  mock.state.faults.at(-1).body = { count: 2 };
  const before = mock.state.requests.length;
  try {
    await page.evaluate(() => window.refreshNotificationCenters());
    await expect.poll(() => mock.state.requests.slice(before).some(row => row.path.endsWith("/unread-count"))).toBe(true);
    await page.getByRole("button", { name: "Mark all as read" }).click();
    await expect(badge(page)).toHaveText("0");
  } finally { release(); }
  await expect.poll(() => mock.state.records.filter(item => !item.read).length).toBe(0);
  await expect(badge(page)).toHaveText("0");
});

for (const width of [390, 1440]) for (const dark of [false, true]) test(`notification count and feedback remain readable (${width}, ${dark ? "dark" : "light"})`, async ({ page, mock }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  mock.state.records = items(3);
  await mount(page, mock, dark ? "?dark" : "");
  await expect(badge(page)).toHaveText("3");
  await open(page);
  mock.state.faults.push({ method: "DELETE", pathname: `/api/notifications/${mock.state.records[0].id}`, status: 503 });
  await rows(page).first().getByRole("button", { name: "Dismiss notification" }).click();
  await expect(page.locator("[data-notification-feedback]")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const scan = await new AxeBuilder({ page }).include("[data-notification-panel]").analyze();
  expect(scan.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`feedback-${dark ? "dark" : "light"}.png`), fullPage: true });
});

for (const width of [390, 1440]) for (const dark of [false, true]) test(`read notices remain legible in a generic header (${width}, ${dark ? "dark" : "light"})`, async ({ page, mock }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  mock.state.records = items(4).map((item, index) => ({ ...item, read: index < 3, isRead: index < 3 }));
  await mount(page, mock, `?genericHeader${dark ? "&dark" : ""}`);
  await expect(badge(page)).toHaveText("1");
  await expect(rows(page)).toHaveCount(4);
  await open(page);
  const opacity = await rows(page).first().evaluate(element => {
    let value = 1;
    for (let node = element; node; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
    return value;
  });
  expect(opacity).toBe(1);
  const scan = await new AxeBuilder({ page }).include("[data-notification-panel]").analyze();
  expect(scan.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`read-${dark ? "dark" : "light"}.png`), fullPage: true });
});

test("a list-only consumer preserves a notice and shows feedback after a failed dismissal", async ({ page, mock }) => {
  mock.state.records = items(2);
  await mount(page, mock, "?listOnly");
  await expect(badge(page)).toHaveText("2");
  await open(page);
  mock.state.faults.push({ method: "DELETE", pathname: `/api/notifications/${mock.state.records[0].id}`, status: 503 });
  await rows(page).first().getByRole("button", { name: "Dismiss notification" }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator("[data-notification-feedback]")).toContainText("could not be confirmed");
});

test("keyboard dismissal does not activate the Matter link", async ({ page, mock }) => {
  mock.state.records = items(2);
  await mount(page, mock);
  await expect(badge(page)).toHaveText("2");
  await open(page);
  await rows(page).first().getByRole("button", { name: "Dismiss notification" }).focus();
  await page.keyboard.press("Enter");
  await expect(rows(page)).toHaveCount(1);
  await expect(badge(page)).toHaveText("1");
  expect(new URL(page.url()).pathname).toBe("/legacy-fixture.html");
  expect(mock.state.requests.some(row => row.method === "POST" && row.path.endsWith("/read"))).toBe(false);
});

test("clear-all preserves records after an unconfirmed receipt and succeeds on retry", async ({ page, mock }) => {
  mock.state.records = items(3);
  await mount(page, mock);
  await expect(badge(page)).toHaveText("3");
  await open(page);
  await page.locator("[data-notification-clear]").click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("[data-notification-panel]")).toBeVisible();
  await expect(page.locator("[data-notification-clear]")).toBeFocused();
  mock.state.faults.push({ method: "DELETE", pathname: "/api/notifications", body: { success: false } });
  await page.locator("[data-notification-clear]").click();
  await page.getByRole("dialog").getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page.locator("[data-notification-feedback]")).toContainText("could not be confirmed");
  await expect(page.locator("[data-notification-feedback]")).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(badge(page)).toHaveText("3");
  expect(mock.state.records).toHaveLength(3);
  await page.locator("[data-notification-clear]").click();
  await page.getByRole("dialog").getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(badge(page)).toHaveText("0");
  await expect(page.locator("[data-notification-toggle]")).toBeFocused();
  expect(mock.state.records).toHaveLength(0);
});

test("a confirmed dismissal survives a failed count refresh without inventing a total", async ({ page, mock }) => {
  mock.state.records = items(3);
  await mount(page, mock);
  await expect(badge(page)).toHaveText("3");
  await open(page);
  mock.state.override = path => path.endsWith("/unread-count") ? { status: 503, body: {} } : null;
  await rows(page).first().getByRole("button", { name: "Dismiss notification" }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(badge(page)).toHaveText("!");
  await expect(page.locator("[data-notification-feedback]")).toBeHidden();
  expect(mock.state.records).toHaveLength(2);
  mock.state.override = null;
  await page.evaluate(() => window.refreshNotificationCenters());
  await expect(badge(page)).toHaveText("2");
});
