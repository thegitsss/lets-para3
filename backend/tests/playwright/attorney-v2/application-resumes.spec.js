const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic résumé review", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic résumé review verification", tasks: [{ title: "Prepare agreement" }] };
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

const fs = require("fs/promises");
// Browser transport fixture; server tests separately verify real record authority
// against mocked S3 object metadata, tags and exact object bytes.
const pdf = Buffer.from("%PDF-1.7\nSynthetic recorded application résumé\n%%EOF\n");
const resume = page => page.locator("[data-application-resume]");
const checkResume = page => resume(page).getByRole("button", { name: /Check (recorded résumé|résumé again)/ }).click();
const saveResume = page => resume(page).getByRole("button", { name: "Download recorded résumé", exact: true }).click();
const reviewPattern = id => `**/api/cases/${id}/application-review/*/resume?**`;
const savePattern = id => `**/api/cases/${id}/application-review/*/resume/download?**`;
async function fixture(page, id) {
  const value = await dto(page, id); value.applications[0].resumeRecorded = true;
  const item = value.applications[0];
  await page.route(pattern(id), route => fulfill(route, value));
  return { value, review: { caseId: id, ownerId: value.ownerId, applicantId: item.applicantId, applicationId: item.applicationId, size: pdf.length, name: "Application resume.pdf", revision: "e".repeat(64) } };
}
const binary = route => route.fulfill({ contentType: "application/pdf", body: pdf });
const closeReview = page => page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click();

test("both dashboards read real application references, show absent-reference fixtures and download exact recorded bytes on request", async ({ page }) => {
  const { id } = await matter(page), recorded = await dto(page, id); await open(page, id);
  await expect(resume(page)).toHaveCount(recorded.applications[0].resumeRecorded ? 1 : 0);
  const { review, value } = await fixture(page, id); let reads = 0; const requests = [];
  await page.route(reviewPattern(id), route => { reads++; return fulfill(route, review); });
  await page.route(savePattern(id), route => { requests.push(route.request().url()); return binary(route); });
  for (const current of [false, true]) {
    const before = reads; value.applications[0].resumeRecorded = false; await open(page, id, current); await refresh(page);
    await expect(panel(page)).toContainText("No résumé recorded."); await expect(resume(page)).toHaveCount(0);
    value.applications[0].resumeRecorded = true; await refresh(page);
    await expect(resume(page)).toHaveAttribute("data-state", "idle"); expect(reads).toBe(before); await expect(resume(page).getByRole("button", { name: "Download recorded résumé" })).toBeHidden();
    await checkResume(page); await expect(resume(page)).toHaveAttribute("data-state", "ready"); expect(reads).toBe(before + 1);
    const arriving = page.waitForEvent("download"); await saveResume(page); const saved = await arriving;
    expect(saved.suggestedFilename()).toBe("Application resume.pdf"); expect(await fs.readFile(await saved.path())).toEqual(pdf);
    await expect(resume(page)).toContainText("handed to your browser"); expect(new URL(requests.at(-1)).searchParams.get("revision")).toBe(review.revision);
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain(review.revision);
  }
  expect(requests).toHaveLength(2);
});

test("both dashboards discard a delayed résumé check after cancellation or application refresh", async ({ page }) => {
  const { id } = await matter(page), { review } = await fixture(page, id);
  for (const current of [false, true]) {
    await open(page, id, current);
    for (const cancel of [true, false]) {
      let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
      await page.route(reviewPattern(id), async route => { arrived(); await gate; await fulfill(route, review).catch(() => {}); });
      try {
        await checkResume(page); await waiting;
        if (cancel) { await resume(page).getByRole("button", { name: "Cancel résumé request" }).click(); await expect(resume(page)).toContainText("Résumé request canceled."); }
        else { await refresh(page); await expect(resume(page)).toHaveAttribute("data-state", "idle"); }
      } finally { release(); await page.unroute(reviewPattern(id)); }
      await expect(resume(page).getByRole("button", { name: "Download recorded résumé" })).toBeHidden();
    }
    await page.route(reviewPattern(id), route => fulfill(route, review)); await checkResume(page); await expect(resume(page)).toHaveAttribute("data-state", "ready"); await page.unroute(reviewPattern(id));
  }
});

test("missing, changed and unsafe résumés have distinct messages and never trigger a download or automatic retry", async ({ page }) => {
  const { id } = await matter(page), { review } = await fixture(page, id); let failure = null, reads = 0, saves = 0;
  page.on("download", () => saves++);
  await page.route(reviewPattern(id), route => { reads++; return failure ? fulfill(route, { code: `APPLICATION_REVIEW_RESUME_${failure.code}` }, failure.status) : fulfill(route, review); });
  await page.route(savePattern(id), route => fulfill(route, { code: "APPLICATION_REVIEW_RESUME_CHANGED" }, 409));
  for (const current of [false, true]) {
    await open(page, id, current);
    for (const next of [{ code: "MISSING", status: 404, text: "no longer in document storage" }, { code: "SCAN_PENDING", status: 423, text: "has not finished" }, { code: "BLOCKED", status: 422, text: "blocked by its security check" }, { code: "SCAN_ERROR", status: 503, text: "could not be verified" }]) {
      failure = next; const before = reads; await checkResume(page); await expect(resume(page)).toHaveAttribute("data-state", "error"); await expect(resume(page)).toContainText(next.text); expect(reads).toBe(before + 1); await expect(resume(page).getByRole("button", { name: "Download recorded résumé" })).toBeHidden();
    }
    failure = null; await checkResume(page); await expect(resume(page)).toHaveAttribute("data-state", "ready"); await saveResume(page); await expect(resume(page)).toContainText("changed during review"); expect(saves).toBe(0);
  }
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} cancellation, application refresh and leaving the review discard delayed résumé bytes`, async ({ page }) => {
  const { id } = await matter(page), { review } = await fixture(page, id); let saves = 0; page.on("download", () => saves++);
  await page.route(reviewPattern(id), route => fulfill(route, review)); await open(page, id, current);
  for (const action of ["cancel", "refresh", "leave"]) {
    await checkResume(page); await expect(resume(page)).toHaveAttribute("data-state", "ready");
    let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
    await page.route(savePattern(id), async route => { arrived(); await gate; await binary(route).catch(() => {}); });
    try {
      await saveResume(page); await waiting;
      if (action === "cancel") { await resume(page).getByRole("button", { name: "Cancel résumé request" }).click(); await expect(resume(page)).toContainText("Résumé request canceled."); }
      if (action === "refresh") { await refresh(page); await expect(resume(page)).toHaveAttribute("data-state", "idle"); }
      if (action === "leave") { if (current) await closeReview(page); else await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); await expect(resume(page)).toHaveCount(0); }
    } finally { release(); await page.unroute(savePattern(id)); }
    await expect.poll(() => saves).toBe(0);
  }
  await open(page, id, current); await checkResume(page); await expect(resume(page)).toHaveAttribute("data-state", "ready"); await page.route(savePattern(id), binary);
  const arriving = page.waitForEvent("download"); await saveResume(page); expect(await fs.readFile(await (await arriving).path())).toEqual(pdf);
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} an account change while a résumé downloads removes the review and discards bytes`, async ({ page }) => {
  const { id } = await matter(page), { review } = await fixture(page, id); let saves = 0, release, arrived; page.on("download", () => saves++);
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(reviewPattern(id), route => fulfill(route, review)); await page.route(savePattern(id), async route => { arrived(); await gate; await binary(route).catch(() => {}); });
  await open(page, id, current); await checkResume(page); await expect(resume(page)).toHaveAttribute("data-state", "ready");
  try {
    await saveResume(page); await waiting;
    if (current) await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } })));
    else { await page.route("**/api/auth/me", route => fulfill(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); }
    await expect(resume(page)).toHaveCount(0);
  } finally { release(); }
  expect(saves).toBe(0);
});

test("wrong application reviews, HTML responses and incomplete PDFs cannot offer or save a recorded résumé", async ({ page }) => {
  const { id } = await matter(page), { review } = await fixture(page, id); let value = { ...review, applicationId: "0".repeat(24) }, saves = 0, html = true; page.on("download", () => saves++);
  await page.route(reviewPattern(id), route => fulfill(route, value)); await page.route(savePattern(id), route => route.fulfill({ contentType: html ? "text/html" : "application/pdf", body: html ? "<h1>Error</h1>" : "%PDF-short" }));
  await open(page, id); await checkResume(page); await expect(resume(page)).toHaveAttribute("data-state", "error"); await expect(resume(page).getByRole("button", { name: "Download recorded résumé" })).toBeHidden();
  value = review;
  for (const invalidHtml of [true, false]) { html = invalidHtml; await checkResume(page); await expect(resume(page)).toHaveAttribute("data-state", "ready"); await saveResume(page); await expect(resume(page)).toHaveAttribute("data-state", "error"); expect(saves).toBe(0); }
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} résumé review fits mobile and desktop with accessible keyboard controls`, async ({ page }, testInfo) => {
  const { id } = await matter(page), { review } = await fixture(page, id); let reads = 0;
  await page.route(reviewPattern(id), route => { reads++; return fulfill(route, review); }); await open(page, id, current);
  for (const width of [320, 1366]) {
    await page.setViewportSize({ width, height: 900 }); await resume(page).getByRole("button", { name: /Check (recorded résumé|résumé again)/ }).focus(); await page.keyboard.press("Enter"); await expect(resume(page)).toHaveAttribute("data-state", "ready");
    const download = resume(page).getByRole("button", { name: "Download recorded résumé" }); await download.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const box = await download.boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    const results = await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-matter-applications]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(results.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-resume-${width}.png`), fullPage: true });
  }
  expect(reads).toBe(2);
});
