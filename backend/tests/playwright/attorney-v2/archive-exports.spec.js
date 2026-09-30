const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fs = require("fs/promises"), { execFileSync } = require("child_process");
const fields = { title: "Synthetic archive export Matter", practiceArea: "Contract Law", state: "New York", compAmount: "400", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic archive verification\nPreserve <draft> wording.", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-export]");
const feedback = page => panel(page).locator("[data-export-feedback]");
async function refresh(page, id, current) {
  if (await panel(page).getAttribute("data-state") === "error") {
    await panel(page).getByRole("button", { name: "Retry archive details", exact: true }).click();
  } else {
    await leave(page, current);
    await open(page, id, current, false);
  }
}
const download = page => panel(page).getByRole("button", { name: "Download matter records", exact: true }).click();
const reviewPattern = id => `**/api/cases/${id}/archive/export?**`;
const zipPattern = id => `**/api/cases/${id}/archive/download?**`;
const json = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const zip = execFileSync("python3", ["-c", "import io,sys,zipfile;b=io.BytesIO();z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED);z.writestr('Synthetic_document.txt','Synthetic archive bytes');z.close();sys.stdout.buffer.write(b.getvalue())"]);
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function matter(page, archived = true) {
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  const id = (await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" })).publication.caseId;
  if (archived) { const value = await api(page.request, "get", `/api/cases/${id}/archive`); await api(page.request, "patch", `/api/cases/${id}/archive`, { revision: value.revision, archived: true, requestId: require("crypto").randomUUID() }); }
  return id;
}
async function fixture(page, id) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  return { caseId: id, ownerId: user.id || user._id, caseTitle: fields.title, access: "available", revision: "a".repeat(64), retentionEndsAt: "2099-01-15T10:00:00.000Z", counts: { messages: 18, documents: 7, priorVersions: 2, confidentialityDocuments: 1 }, filename: "Agreement — archive.zip" };
}
async function open(page, id, current, ready = true) {
  await page.goto(current ? "/dashboard-attorney.html#cases:archived" : `/attorney-v2.html#/matters/${id}/export`, { waitUntil: "domcontentloaded" });
  if (current) { const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first(); await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "Review archive download", exact: true }).click(); }
  if (ready) await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
async function leave(page, current) { if (current) await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click(); else await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); }

for (const current of [false, true]) {
  const surface = current ? "current dashboard" : "V2";
  test(`${surface}: real archived records produce a complete ZIP after explicit review`, async ({ page }) => {
    const id = await matter(page); await open(page, id, current); await expect(panel(page)).toContainText(fields.title); await expect(panel(page)).toContainText("No deletion date is scheduled");
    const arriving = page.waitForEvent("download"); await download(page); const saved = await arriving, file = await saved.path();
    const result = JSON.parse(execFileSync("python3", ["-c", "import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert z.read('Case_Summary.pdf').startswith(b'%PDF-');print(z.read('Archive_contents.json').decode())", file], { encoding: "utf8" }));
    expect(result.title).toBe(fields.title); expect(result.counts.documents).toBe(0); await expect(feedback(page)).toContainText("Download requested for"); expect(await saved.failure()).toBeNull();
  });
  test(`${surface}: reviewed counts, retention and exact ZIP bytes remain account-bound`, async ({ page }) => {
    const id = await matter(page), value = await fixture(page, id), requests = [];
    await page.route(reviewPattern(id), route => json(route, value)); await page.route(zipPattern(id), route => { requests.push(route.request().url()); return route.fulfill({ contentType: "application/zip", body: zip }); });
    await open(page, id, current); await expect(panel(page)).toContainText("2099"); await expect(panel(page)).toContainText("Retained messages"); await expect(panel(page)).toContainText("Deleted messages and files are not included."); expect(requests).toHaveLength(0);
    const arriving = page.waitForEvent("download"); await download(page); const saved = await arriving; expect(saved.suggestedFilename()).toBe(value.filename); expect(await fs.readFile(await saved.path())).toEqual(zip); expect(new URL(requests[0]).searchParams.get("revision")).toBe(value.revision); expect(new URL(requests[0]).searchParams.get("expectedOwnerId")).toBe(value.ownerId);
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain(value.revision);
    if (!current) await expect(page.locator('[data-av2-route="matters"][aria-current="page"]')).toBeVisible();
  });
  test(`${surface}: unavailable archives and failed refreshes never retain a download button`, async ({ page }) => {
    const id = await matter(page), original = await fixture(page, id); let value = original, status = 200;
    await page.route(reviewPattern(id), route => json(route, value, status)); await open(page, id, current);
    for (const access of ["expired", "purged", "retention_unconfirmed", "not_archived", "needs_review", "too_large"]) { value = { ...original, access, counts: null, revision: null }; await refresh(page, id, current); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page).getByRole("button", { name: "Download matter records", exact: true })).toBeHidden(); }
    status = 503; await refresh(page, id, current); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText(original.caseTitle);
    status = 200; value = { ...original, counts: { ...original.counts, documents: -1 } }; await refresh(page, id, current); await expect(panel(page)).toHaveAttribute("data-state", "error"); value = original; await refresh(page, id, current); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  });
  test(`${surface}: changed contents, security checks and invalid ZIPs give accurate failures without retries`, async ({ page }) => {
    const id = await matter(page), value = await fixture(page, id); let code = "EXPORT_CHANGED", attempts = 0, body = null, type = "application/zip", saves = 0;
    page.on("download", () => saves++); await page.route(reviewPattern(id), route => json(route, value)); await page.route(zipPattern(id), route => { attempts++; return body ? route.fulfill({ contentType: type, body }) : json(route, { code }, code === "EXPORT_SCAN_PENDING" ? 423 : 409); });
    await open(page, id, current);
    for (const error of ["EXPORT_CHANGED", "EXPORT_SOURCE_MISSING", "EXPORT_SCAN_PENDING", "EXPORT_BLOCKED", "EXPORT_SCAN_ERROR"]) { code = error; await download(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); if (["EXPORT_CHANGED", "EXPORT_SOURCE_MISSING"].includes(error)) await expect(panel(page).getByRole("button", { name: "Download matter records", exact: true })).toBeHidden(); await refresh(page, id, current); await expect(panel(page)).toHaveAttribute("data-state", "ready"); }
    for (const invalid of [["text/html", Buffer.from("<html>Error</html>")], ["application/zip", zip.subarray(0, -8)]]) { [type, body] = invalid; await download(page); await expect(feedback(page)).toContainText("No download was sent to your browser."); }
    expect(attempts).toBe(7); expect(saves).toBe(0);
  });
  test(`${surface}: cancellation and leaving discard delayed ZIP bytes`, async ({ page }) => {
    const id = await matter(page), value = await fixture(page, id); let saves = 0; page.on("download", () => saves++); await page.route(reviewPattern(id), route => json(route, value));
    for (const cancel of [true, false]) {
      let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
      await page.route(zipPattern(id), async route => { arrived(); await gate; await route.fulfill({ contentType: "application/zip", body: zip }).catch(() => {}); });
      await open(page, id, current); await download(page); await waiting;
      if (cancel) { await panel(page).getByRole("button", { name: "Cancel download", exact: true }).click(); await expect(feedback(page)).toContainText("Archive download canceled."); } else await leave(page, current);
      release(); await page.unroute(zipPattern(id)); if (cancel) await leave(page, current); await expect(panel(page)).toHaveCount(0);
    }
    expect(saves).toBe(0);
  });
  test(`${surface}: an account switch discards a pending archive`, async ({ page }) => {
    const id = await matter(page), value = await fixture(page, id); let saves = 0, release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }); page.on("download", () => saves++);
    await page.route(reviewPattern(id), route => json(route, value)); await page.route(zipPattern(id), async route => { arrived(); await gate; await route.fulfill({ contentType: "application/zip", body: zip }).catch(() => {}); }); await open(page, id, current); await download(page); await waiting;
    if (current) await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } })));
    else { await page.route("**/api/auth/me", route => json(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); await expect(page).toHaveURL(/dashboard-attorney\.html/); }
    release(); await expect(panel(page)).toHaveCount(0); expect(saves).toBe(0);
  });
  test(`${surface}: mobile and desktop archive review wraps long titles and supports keyboard use`, async ({ page }, testInfo) => {
    const id = await matter(page), value = await fixture(page, id); value.caseTitle = `Agreement & document review: ${"LongMatterName".repeat(18)}`;
    await page.route(reviewPattern(id), route => json(route, value)); await page.setViewportSize({ width: 390, height: 900 }); await open(page, id, current);
    for (const width of [390, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await panel(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true); const audit = await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-matter-export]").analyze(); expect(audit.violations).toEqual([]); if (testInfo.project.name === "chromium") await page.screenshot({ path: testInfo.outputPath(`archive-${current ? "current" : "v2"}-${width}.png`), fullPage: true }); }
    await page.route(zipPattern(id), route => route.fulfill({ contentType: "application/zip", body: zip }));
    const button = panel(page).getByRole("button", { name: "Download matter records", exact: true });
    await button.focus(); const arriving = page.waitForEvent("download"); await page.keyboard.press("Enter"); await arriving;
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    if (current) { await page.keyboard.press("Escape"); await expect(panel(page)).toHaveCount(0); }
  });
}
test("selected-Matter archive component requires an explicit download for each reviewed Matter", async ({ page }) => {
  const ids = [await matter(page), await matter(page)]; let requests = 0;
  for (const id of ids) { const value = await fixture(page, id); await page.route(reviewPattern(id), route => json(route, value)); await page.route(zipPattern(id), route => { requests++; return route.fulfill({ contentType: "application/zip", body: zip }); }); }
  await page.goto("/attorney-v2.html#/matters", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Matters", exact: true })).toBeVisible();
  await expect(page.locator("[data-av2-outlet]")).toHaveAttribute("aria-busy", "false");
  // Mount this isolated component after the surrounding real inventory settles.
  await expect(page.locator('[data-av2-region="matter-list"]')).toHaveAttribute("data-state", "ready");
  // Current bulk controls are dormant; exercise their shared component without adding a new product action.
  await page.evaluate(async caseIds => {
    const { createMatterExportBatch } = await import('/assets/scripts/attorney-v2/matter-exports.mjs');
    const { createApiClient } = await import('/assets/scripts/attorney-v2/api-client.mjs');
    const api = createApiClient(), user = (await api.get('/api/auth/me')).user;
    document.querySelector("[data-av2-outlet]").append(createMatterExportBatch(caseIds, { api, ownerId: user.id || user._id, signal: new AbortController().signal }));
  }, ids); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(page.locator("[data-export-batch]")).toContainText("Matter 1 of 2"); expect(requests).toBe(0);
  await page.getByRole("button", { name: "Next Matter", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(page.locator("[data-export-batch]")).toContainText("Matter 2 of 2"); expect(requests).toBe(0);
  const arriving = page.waitForEvent("download"); await download(page); await arriving; expect(requests).toBe(1);
});
