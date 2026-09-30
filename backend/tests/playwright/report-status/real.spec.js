const { test: base, expect } = require("playwright/test");
const fs = require("node:fs/promises");
const startServer = require("./real-server");
const test = base.extend({
  real: [async ({}, use) => { const server = await startServer(); try { await use(server); } finally { await server.close(); } }, { scope: "worker", timeout: 150000 }],
});
test.beforeEach(async ({ context, real }) => {
  await context.route("**/*", route => new URL(route.request().url()).origin === real.origin ? route.continue() : route.abort("blockedbyclient"));
});
async function enter(page, context, real, account, role, suffix = "") {
  await context.addCookies([account.cookie]);
  await page.goto(`${real.origin}/${role}-v2.html#/help${suffix}`);
  await expect(page.locator(role === "attorney" ? "html" : "body")).toHaveAttribute(role === "attorney" ? "data-attorney-state" : "data-v2-session", "ready");
}
for (const role of ["attorney", "paralegal"]) {
  test(`${role}: real persisted receipt → notification read → exact current report → all 105 updates`, async ({ page, context, real }, info) => {
    const seed = await real.reset(role);
    await enter(page, context, real, seed.owner, role);
    await page.getByRole("button", { name: "View notifications, 1 unread", exact: true }).click();
    const link = page.getByRole("link", { name: `Report ${seed.report.publicId} received., unread`, exact: true });
    await expect(link).toBeVisible();
    await expect(page.getByText(/PRIVATE_OTHER|PRIVATE_MISADDRESSED/)).toHaveCount(0);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`#/help\\?incident=${seed.report.publicId}$`));
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText(seed.report.summary, { exact: true })).toBeVisible();
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    await expect.poll(async () => (await real.notification(seed.notificationId))?.read).toBe(true);
    await report.locator("summary").click();
    await expect(report.locator("li")).toHaveCount(20);
    for (const total of [40, 60, 80, 100, 105]) {
      await report.getByRole("button", { name: "More updates", exact: true }).click();
      await expect(report.locator("li")).toHaveCount(total);
    }
    await expect(report.getByRole("button", { name: "More updates", exact: true })).toBeHidden();
    await expect(report).not.toContainText(/PRIVATE_|undefined|accessToken/);
    expect(real.state.requests.filter(req => req.path.endsWith("/timeline")).map(req => req.query.cursor || null)).toEqual([null, "20", "40", "60", "80", "100"]);
    const evidence = await real.evidence(); expect(evidence.unknownAncillaryApi).toEqual([]);
    await fs.writeFile(info.outputPath(`${role}-real-path.json`), JSON.stringify({ report: seed.report.publicId, notificationRead: (await real.notification(seed.notificationId)).read, visibleUpdates: 105, ...evidence }, null, 2));
    await page.screenshot({ path: info.outputPath(`${role}-real-report.png`), fullPage: true });
  });

  test(`${role}: real unrelated status and cookie replacement deny old report access`, async ({ page, context, real }, info) => {
    const seed = await real.reset(role);
    await enter(page, context, real, seed.owner, role, `?incident=${seed.unrelated.publicId}`);
    const report = page.locator(".lpc-report-status");
    await expect(report.getByText("This report is unavailable to your account.", { exact: true })).toBeVisible();
    await expect(page.getByText("PRIVATE_OTHER_REPORT", { exact: true })).toHaveCount(0);
    await page.goto(`${real.origin}/${role}-v2.html#/help?incident=${seed.report.publicId}`);
    await expect(report.getByText("Under review", { exact: true })).toBeVisible();
    const gate = real.holdNext(`/api/incidents/${seed.report.publicId}`);
    try {
      await report.getByRole("button", { name: "Refresh report", exact: true }).click();
      await expect.poll(() => gate.arrived).toBe(true);
      await context.addCookies([seed.other.cookie]);
    } finally { gate.release(); }
    await expect(page).toHaveURL(/\/login\.html/);
    await expect(page.getByText(seed.report.summary, { exact: true })).toHaveCount(0);
    const guarded = await context.request.get(`${real.origin}/api/incidents/${seed.report.publicId}?expectedOwnerId=${seed.owner.id}`);
    expect(guarded.status()).toBe(403); expect((await guarded.json()).code).toBe("ACCOUNT_CHANGED");
    await fs.writeFile(info.outputPath(`${role}-real-account-guard.json`), JSON.stringify({ unrelatedDenied: true, guardedStatus: guarded.status(), expectedAccountChanged: true, oldReportRemoved: true }, null, 2));
  });
}

test("paralegal: real Help form receipt opens its authenticated report status", async ({ page, context, real }, info) => {
  const seed = await real.reset("paralegal", { seed: false });
  await enter(page, context, real, seed.owner, "paralegal");
  await page.getByLabel("Short summary").fill("A synthetic Help receipt test");
  await page.getByLabel("What happened?").fill("The selected practice area did not update the available Matters.");
  const response = page.waitForResponse(res => new URL(res.url()).pathname === "/api/incidents" && res.request().method() === "POST");
  await page.locator(".v2-help-submit").click();
  const created = await response; expect(created.status()).toBe(201); const payload = await created.json();
  const receipt = page.locator(".v2-help-report-status");
  await expect(receipt).toContainText(`Reference: ${payload.incident.publicId}`);
  await receipt.getByRole("link", { name: "View report", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/help\\?incident=${payload.incident.publicId}$`));
  await expect(page.locator(".lpc-report-status").getByText("A synthetic Help receipt test", { exact: true })).toBeVisible();
  await expect(page.locator(".lpc-report-status").getByText("Received", { exact: true })).toBeVisible();
  const evidence = await real.evidence(); expect(evidence).toMatchObject({ incidents: 1, notifications: 1, events: 1 });
  await fs.writeFile(info.outputPath("paralegal-real-intake-link.json"), JSON.stringify({ publicId: payload.incident.publicId, ...evidence }, null, 2));
});
