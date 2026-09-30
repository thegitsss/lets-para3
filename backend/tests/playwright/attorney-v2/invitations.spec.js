const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic invitation Matter", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic invitation verification", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-invitations]");
const refresh = page => panel(page).getByRole("button", { name: "Refresh invited paralegals", exact: true }).click();
let para, paraId;
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function matter(page) {
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  const { publication } = await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  await api(page.request, "post", `/api/cases/${publication.caseId}/invite/${paraId}`, {});
  return publication.caseId;
}
async function currentOpen(page, id) {
  const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first();
  await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "View Invited Paralegals", exact: true }).click();
}
async function open(page, id, current = false, ready = true, currentView = "active") {
  await page.goto(current ? `/dashboard-attorney.html#cases:${currentView}` : `/attorney-v2.html#/matters/${id}/invitations`, { waitUntil: "domcontentloaded" });
  if (current) await currentOpen(page, id);
  if (ready) await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
const close = page => page.locator("#caseInvitesModal").getByRole("button", { name: "Close", exact: true }).click();
const pattern = id => `**/api/cases/${id}/invites?**`;
const dto = (page, id) => api(page.request, "get", `/api/cases/${id}/invites`);
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
test.beforeAll(async ({ playwright, baseURL }) => {
  para = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { "x-ai-control-room-e2e-secret": process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const bootstrap = await para.post("/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal", { headers }); expect(bootstrap.ok()).toBeTruthy(); const payload = await bootstrap.json();
  const csrf = await (await para.get("/api/csrf")).json();
  const login = await para.post("/api/auth/login", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { email: payload.paralegal.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || "ControlRoomSupport123!" } }); expect(login.ok(), await login.text()).toBeTruthy();
  const user = (await (await para.get("/api/auth/me")).json()).user; paraId = user.id || user._id;
});
test.afterAll(async () => para?.dispose());

test("both menus show real recorded responses, and V2 profile navigation returns to invitations", async ({ page }) => {
  const id = await matter(page); const before = await dto(page, id);
  await page.goto("/attorney-v2.html#/matters", { waitUntil: "domcontentloaded" }); const row = page.locator(`[data-av2-matter="${id}"]`);
  await row.getByText("Matter actions", { exact: true }).click(); await row.getByRole("link", { name: "View invited paralegals", exact: true }).click();
  await expect(panel(page)).toContainText("Awaiting response"); expect(await dto(page, id)).toEqual(before);
  const profile = panel(page).getByRole("link").first(); const href = await profile.getAttribute("href");
  const back = new URLSearchParams(href.split("?")[1]).get("returnTo"); expect(back.split("?")[0]).toBe(`#/matters/${id}/invitations`); expect(new URLSearchParams(back.split("?")[1]).get("returnTo")).toBe("#/matters");
  await profile.click(); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await page.getByRole("link", { name: "Back to invitations", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await api(para, "post", `/api/cases/${id}/respond-invite`, { decision: "accept" });
  await refresh(page); await expect(panel(page)).toContainText("Accepted invitation"); await expect(panel(page)).toContainText("does not confirm a hire");
  await open(page, id, true, true, "inquiries"); await expect(panel(page)).toContainText("Accepted invitation"); await expect(panel(page)).toContainText("Responded");
});

test("both dashboards distinguish initial errors, empty lists and unreadable records", async ({ page }) => {
  const id = await matter(page), value = await dto(page, id); let body = {}, status = 503;
  await page.route(pattern(id), route => fulfill(route, body, status));
  for (const current of [false, true]) {
    body = {}; status = 503; await open(page, id, current, false); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText("No invited paralegals yet");
    body = { ...value, invites: [] }; status = 200; await refresh(page); await expect(panel(page)).toContainText("No invited paralegals yet.");
    body = { ...body, complete: false }; await refresh(page); await expect(panel(page)).toContainText("may be incomplete"); await expect(panel(page)).toContainText("No readable invitations");
  }
});

test("failed refresh removes previous names, retries safely and rejects foreign or malformed responses", async ({ page }) => {
  const id = await matter(page), value = await dto(page, id); let response = value, status = 200;
  await page.route(pattern(id), route => fulfill(route, response, status));
  for (const current of [false, true]) {
    response = value; status = 200; await open(page, id, current); const name = value.invites[0].paralegal.name; await expect(panel(page)).toContainText(name);
    status = 503; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText(name);
    status = 200;
    for (const invalid of [{ ...value, caseId: "0".repeat(24) }, { ...value, ownerId: "0".repeat(24) }, { ...value, invites: [{ ...value.invites[0], invitedAt: "broken" }] }]) {
      response = invalid; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText(name);
    }
    response = value; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  }
});

test("closing a current dialog discards delayed data and reopening fetches the current response", async ({ page }) => {
  const id = await matter(page), value = await dto(page, id); let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(pattern(id), async route => { arrived(); await gate; await fulfill(route, value).catch(() => {}); });
  await open(page, id, true, false); await waiting; await close(page); release(); await expect(panel(page)).toHaveCount(0);
  await page.unroute(pattern(id)); await api(para, "post", `/api/cases/${id}/respond-invite`, { decision: "decline" }); await currentOpen(page, id); await expect(panel(page)).toContainText("Declined invitation");
});

test("navigation away from V2 invitations discards delayed names", async ({ page }) => {
  const id = await matter(page), value = await dto(page, id); value.invites[0].paralegal.name = "PRIVATE_DELAYED_INVITEE";
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(pattern(id), async route => { arrived(); await gate; await fulfill(route, value).catch(() => {}); });
  await open(page, id, false, false); await waiting; await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); release();
  await expect(page.getByRole("heading", { level: 1, name: "Matters", exact: true })).toBeVisible(); await expect(panel(page)).toHaveCount(0); await expect(page.locator("body")).not.toContainText("PRIVATE_DELAYED_INVITEE");
});

test("an account-change event clears a current dialog while its read is delayed", async ({ page }) => {
  const id = await matter(page), value = await dto(page, id); value.invites[0].paralegal.name = "PRIVATE_ACCOUNT_INVITEE";
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(pattern(id), async route => { arrived(); await gate; await fulfill(route, value).catch(() => {}); });
  await open(page, id, true, false); await waiting; await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } }))); release();
  await expect(page.locator("#caseInvitesModal")).toBeHidden(); await expect(panel(page)).toHaveCount(0);
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain("PRIVATE_ACCOUNT_INVITEE");
});

test("a changed session during refresh clears both invitation surfaces without reading another account", async ({ page }) => {
  const id = await matter(page);
  for (const current of [false, true]) {
    await open(page, id, current); let reads = 0, ownerReads = 0, releaseOwner;
    const ownerGate = new Promise(resolve => { releaseOwner = resolve; });
    await page.route(pattern(id), route => { reads++; return route.continue(); });
    // Hold background ownership responses until the deliberate refresh is sent.
    // Otherwise a correct account boundary can remove the button before its click.
    await page.route("**/api/auth/me", async route => {
      ownerReads++; await ownerGate;
      return fulfill(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } });
    });
    try {
      await refresh(page); await expect.poll(() => ownerReads).toBeGreaterThan(0); releaseOwner();
      await expect(panel(page)).toHaveCount(0); expect(reads).toBe(0);
    } finally {
      releaseOwner(); await page.unroute("**/api/auth/me"); await page.unroute(pattern(id));
    }
  }
});

test("long invitation lists remain accessible at mobile and desktop widths, with safe photos and missing-profile states", async ({ page }, testInfo) => {
  const id = await matter(page), value = await dto(page, id);
  value.invites = Array.from({ length: 12 }, (_, index) => ({ ...value.invites[0], status: index ? "accepted" : "unknown", invitedAt: null, respondedAt: null, paralegal: { ...value.invites[0].paralegal, name: index ? `Synthetic invited paralegal ${index}` : '<img src=x onerror="alert(1)">', available: index > 0, profileImage: "https://invalid.example/private-photo" } }));
  await page.route(pattern(id), route => fulfill(route, value));
  for (const current of [false, true]) {
    await open(page, id, current); await expect(panel(page)).toContainText("Invitation date unavailable"); await expect(panel(page)).toContainText("Profile unavailable");
    expect(await panel(page).locator("img").evaluateAll(images => images.every(image => new URL(image.src).origin === location.origin))).toBe(true);
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (current) { const box = await page.locator("#caseInvitesModal").getByRole("button", { name: "Close", exact: true }).boundingBox(); expect(box.y + box.height).toBeLessThanOrEqual(880); }
      const result = await new AxeBuilder({ page }).include(current ? "#caseInvitesModal" : "[data-matter-invitations]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(result.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-invitations-${width}.png`), fullPage: true });
    }
    if (current) { await page.keyboard.press("Escape"); await expect(page.locator("#caseInvitesModal")).toBeHidden(); }
  }
});
