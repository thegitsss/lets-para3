const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const { assertApplicationFiltersReadable } = require("./application-filter-layout");
const fields = { title: "Synthetic application decision", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic application decision verification", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-applications]");
const refresh = page => panel(page).getByRole("button", { name: "Refresh applications", exact: true }).click();
const pattern = id => `**/api/cases/${id}/application-inventory?**`;
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
let para, paraId;
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function matter(page) {
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  const { publication } = await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  const id = publication.caseId;
  const application = await api(para, "post", `/api/cases/${id}/apply`, { coverLetter: "I can prepare the agreement and organize the supporting exhibits.\nMy application includes contract review experience." });
  return { id, applicationId: application.applicationId || application._id || application.id };
}
async function dto(page, id) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  return api(page.request, "get", `/api/cases/${id}/application-inventory?expectedOwnerId=${user.id || user._id}`);
}
async function currentOpen(page, id) {
  const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first();
  await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "Review applications", exact: true }).click();
}
async function open(page, id, current = false, ready = true) {
  await page.goto(current ? "/dashboard-attorney.html#cases:inquiries" : `/attorney-v2.html#/matters/${id}/applications`, { waitUntil: "domcontentloaded" });
  if (current) await currentOpen(page, id);
  if (ready) await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
test.beforeAll(async ({ playwright, baseURL }) => {
  para = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { "x-ai-control-room-e2e-secret": process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const bootstrap = await para.post("/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal", { headers }); expect(bootstrap.ok()).toBeTruthy(); const payload = await bootstrap.json();
  const csrf = await (await para.get("/api/csrf")).json();
  const login = await para.post("/api/auth/login", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { email: payload.paralegal.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || "ControlRoomSupport123!" } }); expect(login.ok(), await login.text()).toBeTruthy();
  const user = (await (await para.get("/api/auth/me")).json()).user; paraId = user.id || user._id;
});
test.afterAll(async () => para?.dispose());

const decisions = page => page.locator("[data-application-decisions]");
for (const current of [false, true]) test(`${current ? "current" : "V2"} recorded LinkedIn references have explicit external destinations and unsafe addresses stay text`, async ({ page }) => {
  const { id } = await matter(page), value = await dto(page, id), address = "https://www.linkedin.com/in/synthetic-submitted-reference";
  value.applications[0].linkedInRecorded = true; value.applications[0].linkedInReference = address;
  await page.route(pattern(id), route => fulfill(route, value)); await open(page, id, current);
  const reference = panel(page).getByRole("link", { name: "Open LinkedIn reference from application (new tab)" });
  await expect(reference).toHaveAttribute("href", address); await expect(reference).toHaveAttribute("target", "_blank"); await expect(reference).toHaveAttribute("rel", "noopener noreferrer"); await expect(reference).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(panel(page)).toContainText("LinkedIn profile content may have changed");
  value.applications[0].linkedInReference = "https://linkedin.com.attacker.test/in/person"; await refresh(page); await expect(reference).toHaveCount(0); await expect(panel(page)).toContainText("its address could not be verified");
});
const reviewDecision = async page => { await decisions(page).getByRole("button", { name: /Review application decisions|Refresh decision review/ }).click(); await expect(decisions(page)).toHaveAttribute("data-state", "ready"); };
const writePattern = id => `**/api/cases/${id}/application-review/*/decision`;
const decisionPath = id => `/api/cases/${id}/application-review/${paraId}/decision`;
async function serverReview(page, id) { const user = (await (await page.request.get("/api/auth/me")).json()).user; return api(page.request, "get", `${decisionPath(id)}?expectedOwnerId=${user.id || user._id}`); }
async function decide(page, label, saved) {
  await reviewDecision(page); await decisions(page).getByRole("button", { name: label, exact: true }).click();
  await decisions(page).getByRole("button", { name: label === "Reject application" ? "Confirm rejection" : "Save application decision", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page).getByRole("status").first()).toContainText(saved);
}

for (const current of [false, true]) test(`${current ? "current" : "V2"} records real star, shortlist, return and rejection decisions with preserved history`, async ({ page }, testInfo) => {
  // Five persisted decisions each require a fresh review and inventory read,
  // followed by cross-role history verification. Budget the entire sequence
  // separately from the unchanged per-assertion and application deadlines.
  test.setTimeout(90_000);
  const { id, applicationId } = await matter(page); await open(page, id, current);
  let contextReads = 0;
  page.on("response", response => { if (new URL(response.url()).pathname === `/api/cases/${id}`) contextReads++; });
  await expect(decisions(page)).toHaveAttribute("data-state", "idle");
  await panel(page).getByRole("searchbox").fill("Unsubmitted filter");
  for (const [label, saved] of [["Star application", "Application starred."], ["Shortlist application", "Application shortlisted."], ["Return to submitted", "Application returned to submitted status."], ["Remove star", "Application star removed."], ["Reject application", "Application rejected."]]) {
    const before = contextReads; await decide(page, label, saved);
    if (!current) {
      await expect.poll(() => contextReads).toBeGreaterThan(before);
      await expect(page.getByRole("button", { name: "Refresh Matter", exact: true })).toBeEnabled();
      await expect(page.locator('[data-matter-workspace] > [role="status"]')).toHaveText("Posted");
    }
    await expect(panel(page).getByRole("searchbox")).toHaveValue("Unsubmitted filter");
    const status = panel(page).getByRole("status").first();
    expect(await status.evaluate(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(""))).toBe("1–1 of 1 application");
  }
  await panel(page).locator("summary").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-recorded-rejection.png`) });
  const value = await dto(page, id); expect(value.applications[0]).toMatchObject({ status: "rejected", starred: false }); expect(value.applications[0].history.map(entry => entry.to)).toEqual(["submitted", "shortlisted", "submitted", "rejected"]);
  await reviewDecision(page); await expect(decisions(page)).toContainText("does not allow further decisions"); await expect(decisions(page).getByRole("button", { name: "Reject application", exact: true })).toHaveCount(0);
  const mine = await api(para, "get", "/api/applications/my"); expect(mine.find(item => String(item._id || item.id) === applicationId)?.status).toBe("rejected");
});

test("a confirmed decision queues a fresh context check behind an older in-flight check without rebuilding review controls", async ({ page }) => {
  const { id } = await matter(page); await page.clock.install(); await open(page, id);
  const path = `**/api/cases/${id}?expectedOwnerId=*`;
  let release, arrived, reads = 0;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(path, async route => { reads++; const response = await route.fetch(); if (reads === 1) { arrived(); await gate; } await route.fulfill({ response }).catch(() => {}); });
  await page.clock.fastForward(16000); await waiting;
  try {
    await decide(page, "Star application", "Application starred.");
    await reviewDecision(page); await decisions(page).getByRole("button", { name: "Reject application", exact: true }).click();
    await panel(page).getByRole("searchbox").fill("Keep this draft");
  } finally { release(); }
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Refresh Matter", exact: true })).toBeEnabled();
  await expect(page.locator('[data-matter-workspace] > [role="status"]')).toHaveText("Posted");
  await expect(decisions(page).getByRole("button", { name: "Confirm rejection" })).toBeVisible();
  await expect(panel(page).getByRole("searchbox")).toHaveValue("Keep this draft");
});

test("a later application refresh retains the confirmed decision while an older inventory response is still in flight", async ({ page }) => {
  const { id } = await matter(page); await open(page, id);
  let release, arrived, reads = 0, contextReads = 0;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  page.on("response", response => { if (new URL(response.url()).pathname === `/api/cases/${id}`) contextReads++; });
  await page.route(pattern(id), async route => { reads++; const response = await route.fetch(); if (reads === 1) { arrived(); await gate; } await route.fulfill({ response }).catch(() => {}); });
  await reviewDecision(page); await decisions(page).getByRole("button", { name: "Star application", exact: true }).click();
  await decisions(page).getByRole("button", { name: "Save application decision", exact: true }).click(); await waiting;
  try {
    // Apply the unchanged filters while the automatic post-decision read is held.
    await panel(page).getByRole("searchbox").fill("");
    await panel(page).getByRole("button", { name: "Apply filters" }).click();
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await expect.poll(() => contextReads).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Refresh Matter", exact: true })).toBeEnabled();
    await expect(page.locator('[data-matter-workspace] > [role="status"]')).toHaveText("Posted");
    await expect(panel(page).locator("summary")).toContainText("Starred");
  } finally { release(); }
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
});

test("a failed post-decision inventory read stays unavailable until a successful refresh acknowledges the saved result", async ({ page }) => {
  const { id } = await matter(page); await open(page, id);
  await page.route(pattern(id), route => fulfill(route, {}, 503));
  await reviewDecision(page); await decisions(page).getByRole("button", { name: "Reject application", exact: true }).click();
  await decisions(page).getByRole("button", { name: "Confirm rejection" }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page).locator("summary")).toHaveCount(0);
  await expect(panel(page)).not.toContainText("No applications have been recorded");
  await page.unroute(pattern(id));
  let contextReads = 0; page.on("response", response => { if (new URL(response.url()).pathname === `/api/cases/${id}`) contextReads++; });
  await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await expect.poll(() => contextReads).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Refresh Matter", exact: true })).toBeEnabled();
  await expect(page.locator('[data-matter-workspace] > [role="status"]')).toHaveText("Posted");
  await expect(panel(page).locator("summary")).toContainText("Rejected");
});

test("a confirmed decision cannot acknowledge independent Matter changes or preserve details after access loss", async ({ page }) => {
  const { id } = await matter(page); await open(page, id);
  const path = `**/api/cases/${id}?expectedOwnerId=*`;
  await page.route(path, async route => { const response = await route.fetch(), value = await response.json(); value.details = "Changed elsewhere"; await fulfill(route, value); });
  await decide(page, "Star application", "Application starred.");
  await expect(page.locator('[data-matter-workspace] > [role="status"]')).toContainText("This Matter has changed");
  await reviewDecision(page); await decisions(page).getByRole("button", { name: "Remove star", exact: true }).click();
  await page.route(writePattern(id), async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); expect(response.ok()).toBe(true);
    await page.route(path, request => fulfill(request, {}, 403));
    await route.fulfill({ response });
  });
  await decisions(page).getByRole("button", { name: "Save application decision", exact: true }).click();
  await expect(page.locator("[data-matter-workspace]")).toHaveAttribute("data-state", "error");
  await expect(panel(page)).toHaveCount(0); await expect(page.locator("[data-matter-workspace]")).not.toContainText(fields.title);
});

// Each existing visual variant owns its normal test deadline. Eight independent
// axe scans must not consume one cumulative deadline in the complete collection.
for (const theme of ["light", "dark"]) for (const [width, scale] of [[320, 100], [390, 100], [1366, 100], [390, 200]]) {
test(`current application filters retain readable native values: ${theme}, ${width}px, ${scale} percent text`, async ({ page }, testInfo) => {
  const { id } = await matter(page); await open(page, id, true);
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(({ theme, scale }) => { document.documentElement.classList.toggle("theme-dark", theme === "dark"); document.documentElement.style.fontSize = `${scale}%`; }, { theme, scale });
  await panel(page).getByRole("button", { name: "Apply filters" }).scrollIntoViewIfNeeded();
  await assertApplicationFiltersReadable(panel(page));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const background = await page.locator("#caseNoteModal .note-modal-card").evaluate(element => getComputedStyle(element).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number));
  expect(background.every(channel => theme === "dark" ? channel < 128 : channel > 200)).toBe(true);
  expect((await new AxeBuilder({ page }).include("#caseNoteModal").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`current-filters-${theme}-${width}-${scale}.png`) });
});
}

test("decision confirmation can be canceled without changing the application", async ({ page }) => {
  const { id } = await matter(page), before = await dto(page, id); await open(page, id); await reviewDecision(page); await decisions(page).getByRole("button", { name: "Reject application", exact: true }).click();
  await expect(decisions(page)).toContainText("removes it from consideration"); await expect(decisions(page)).toContainText("Synthetic application decision");
  await decisions(page).getByRole("button", { name: "Keep application unchanged" }).click(); expect(await dto(page, id)).toEqual(before);
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} lost decision responses recover the saved result after refreshing without resubmission`, async ({ page }) => {
  const { id } = await matter(page); let writes = 0;
  await page.route(writePattern(id), async route => { if (route.request().method() !== "POST") return route.continue(); writes++; const result = await route.fetch(); expect(result.status()).toBe(200); await route.abort("failed"); });
  await open(page, id, current); await reviewDecision(page); await decisions(page).getByRole("button", { name: "Shortlist application", exact: true }).click(); await decisions(page).getByRole("button", { name: "Save application decision", exact: true }).click();
  await expect(decisions(page)).toHaveAttribute("data-state", "uncertain"); expect(writes).toBe(1); await refresh(page); await expect(decisions(page)).toHaveAttribute("data-state", "uncertain");
  await decisions(page).getByRole("button", { name: "Check decision result", exact: true }).click(); await expect(panel(page).getByRole("status").first()).toContainText("Application shortlisted."); expect(writes).toBe(1); expect((await dto(page, id)).applications[0].history.filter(entry => entry.to === "shortlisted")).toHaveLength(1);
});

test("a stale reviewed application cannot overwrite a newer decision", async ({ page }) => {
  const { id } = await matter(page); await open(page, id); await reviewDecision(page); await decisions(page).getByRole("button", { name: "Reject application", exact: true }).click();
  const value = await serverReview(page, id); await api(page.request, "post", decisionPath(id), { revision: value.revision, requestId: require("crypto").randomUUID(), action: "shortlist" });
  await decisions(page).getByRole("button", { name: "Confirm rejection" }).click(); await expect(decisions(page)).toHaveAttribute("data-state", "uncertain");
  await decisions(page).getByRole("button", { name: "Check decision result" }).click(); await expect(decisions(page)).toContainText("No saved decision was found"); expect((await dto(page, id)).applications[0].status).toBe("shortlisted");
  await refresh(page); await reviewDecision(page); await expect(decisions(page).getByRole("button", { name: "Return to submitted", exact: true })).toBeVisible();
});

test("a withdrawn application remains readable while its decision controls are closed", async ({ page }) => {
  const { id, applicationId } = await matter(page); await open(page, id); await api(para, "post", `/api/applications/${applicationId}/revoke`, {}); await refresh(page); await reviewDecision(page);
  await expect(panel(page)).toContainText("Withdrawn by paralegal"); await expect(decisions(page)).toContainText("does not allow further decisions"); await expect(decisions(page).getByRole("button", { name: "Reject application", exact: true })).toHaveCount(0);
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} delayed decision responses cannot restore private controls after an account change`, async ({ page }) => {
  const { id } = await matter(page); let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(writePattern(id), async route => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await open(page, id, current); await reviewDecision(page); await decisions(page).getByRole("button", { name: "Star application", exact: true }).click(); await decisions(page).getByRole("button", { name: "Save application decision", exact: true }).click();
  try {
    await waiting;
    if (current) await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } })));
    else { await page.route("**/api/auth/me", route => fulfill(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); }
    await expect(panel(page)).toHaveCount(0);
  } finally { release(); }
  await expect(decisions(page)).toHaveCount(0);
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} decision confirmation stays accessible on mobile and desktop`, async ({ page }, testInfo) => {
  const { id } = await matter(page); await open(page, id, current); await reviewDecision(page);
  await decisions(page).getByRole("button", { name: "Reject application", exact: true }).focus(); await page.keyboard.press("Enter");
  for (const width of [320, 1366]) {
    await page.setViewportSize({ width, height: 900 }); const confirm = decisions(page).getByRole("button", { name: "Confirm rejection" }); await confirm.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); const box = await confirm.boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect((await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-matter-applications]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-decision-${width}.png`), fullPage: true });
  }
});
