const { test, expect } = require("../support-session-fixture");

test("original creation uses one shared notification handler for read and dismiss", async ({ page }, info) => {
  const errors = [], writes = [];
  page.on("pageerror", error => errors.push(error.message));
  const rows = [1, 2].map(index => ({
    _id: index.toString(16).padStart(24, "0"), id: index.toString(16).padStart(24, "0"),
    type: "case_update", message: `Creation notification ${index}`, read: false, isRead: false,
    createdAt: "2026-09-11T12:00:00.000Z", action: { href: "", label: "" },
  }));
  await page.route("**/api/notifications**", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const json = value => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname.endsWith("/stream")) return route.fulfill({ status: 204, body: "" });
    if (method === "GET") return json(url.pathname.endsWith("/unread-count") ? { count: rows.filter(row => !row.read).length } : rows);
    expect(request.headers()["x-csrf-token"]).toBeTruthy();
    writes.push({ method, path: url.pathname });
    if (url.pathname.endsWith("/read-all")) rows.forEach(row => { row.read = true; row.isRead = true; });
    else if (method === "DELETE") rows.splice(rows.findIndex(row => url.pathname.endsWith(row.id)), 1);
    else throw new Error(`Unexpected notification write ${method} ${url.pathname}`);
    return json({ success: true });
  });
  await page.goto("/create-case.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#caseTitleInput")).toBeEnabled();
  const toggle = page.locator("[data-notification-toggle]:visible"), panel = page.locator("[data-notification-panel]");
  await expect(toggle).toHaveCount(1); await toggle.click();
  await expect(panel).toBeVisible(); await expect(panel).toContainText("Creation notification 1");
  await panel.getByRole("button", { name: "Mark all as read", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ method: "POST", path: "/api/notifications/read-all" });
  await panel.getByRole("button", { name: "Dismiss notification", exact: true }).first().click();
  await expect.poll(() => writes.length).toBe(2);
  await expect(panel.locator(".notif-item[data-id]")).toHaveCount(1);
  expect(writes.filter(row => row.method === "DELETE")).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 900 });
  const visibleNotification = panel.getByText("Creation notification 2", { exact: true });
  const geometry = () => visibleNotification.evaluate(element => ({
    viewport: {width: innerWidth, height: innerHeight},
    chain: [element, ...Array.from((function* () { let parent = element.parentElement; while(parent) { yield parent; parent = parent.parentElement; } })())].map(node => {
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      return {tag:node.tagName, className:node.className, box:box.toJSON(), opacity:style.opacity, visibility:style.visibility, display:style.display, overflow:style.overflow, color:style.color, background:style.backgroundColor};
    }),
  }));
  await expect.poll(async () => (await geometry()).chain.every(item => Number(item.opacity) > 0.9)).toBe(true);
  await info.attach("notification-layout", {body:JSON.stringify(await geometry(), null, 2),contentType:"application/json"});
  await page.screenshot({ path: info.outputPath("creation-notifications.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});
