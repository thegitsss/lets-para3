const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fs = require("fs/promises");
const fields = { title: "Synthetic file Matter", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic file download verification", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-downloads], [data-workspace-files]");
const feedback = page => panel(page).locator("[data-download-feedback], [data-file-feedback]");
const refresh = async page => {
  const retry = panel(page).getByRole("button", { name: "Retry files", exact: true });
  if (await retry.isVisible()) await retry.click();
  else await page.reload({ waitUntil: "domcontentloaded" });
};
const listPattern = id => new RegExp(`/api/cases/${id}/(?:downloads|files/review)\\?`);
const filePattern = id => `**/api/cases/${id}/downloads/*?**`;
const json = (route, body, status = 200) => {
  if (route.request().url().includes("/files/review?") && Array.isArray(body.files)) {
    const detail = file => ({ ...file, mimeType: "text/plain", reviewRevision: "b".repeat(64), uploadedByRole: "attorney", status: "pending_review", notes: "", requestedAt: null, approvedAt: null, replacedAt: null, revisionOf: null, canReview: false });
    const target = new URL(route.request().url()).searchParams.get("fileId"), selected = body.files.find(file => file.id === target);
    body = { ...body, canUpload: false, files: body.files.map(detail), selection: target ? selected ? "found" : "unavailable" : "none", selectedFile: selected ? detail(selected) : null };
  }
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
};
const idFor = n => n.toString(16).padStart(24, "0");
const file = (n, changes = {}) => ({ id: idFor(n), name: `File ${n}.txt`, revision: "a".repeat(64), size: 42, version: 1, uploadedAt: null, securityStatus: "clean", ...changes });
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function matter(page) {
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  return (await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" })).publication.caseId;
}
async function fixture(page, id, files = [file(500), file(499, { name: "Agreement — second.txt" })]) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  return { caseId: id, ownerId: user.id || user._id, caseTitle: fields.title, access: "available", legacyAttachments: false, files, nextCursor: null };
}
async function open(page, id, current = false, ready = true) {
  await page.goto(current ? "/dashboard-attorney.html#cases:active" : `/attorney-v2.html#/matters/${id}/files`, { waitUntil: "domcontentloaded" });
  if (current) { const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first(); await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "Download Files", exact: true }).click(); }
  if (ready) await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
const download = async (page, n = 499) => {
  await panel(page).locator(`[data-download-file="${idFor(n)}"]`).getByRole("button").click();
  if (await page.locator("[data-workspace-files]").count()) await panel(page).getByRole("button", { name: "Download file", exact: true }).click();
};
const close = page => page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click();

test("both menus load the real empty file authority without relying on cached attachments", async ({ page }) => {
  const id = await matter(page);
  await open(page, id, true); await expect(panel(page)).toContainText(/No downloadable file records|No documents have been shared/); await close(page);
  await page.goto(`/attorney-v2.html#/matters?highlightCase=${id}`, { waitUntil: "domcontentloaded" }); const row = page.locator(`[data-av2-matter="${id}"]`); await row.locator(".av2-matter-menu > summary").click(); await row.getByRole("link", { name: "Files for download", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText(/No downloadable file records|No documents have been shared/); await expect(page.locator('[data-av2-route="matters"][aria-current="page"]')).toBeVisible();
});

test("each dashboard downloads the selected second file with exact bytes and its own filename", async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id), requests = [], content = "Synthetic second file bytes\n";
  await page.route(listPattern(id), route => json(route, value)); await page.route(filePattern(id), route => { requests.push(route.request().url()); return route.fulfill({ status: 200, contentType: "application/octet-stream", body: content }); });
  for (const current of [false, true]) {
    await open(page, id, current); await expect(panel(page).locator("[data-download-file]")).toHaveCount(2); await expect(panel(page)).toContainText("Upload date unavailable");
    const arriving = page.waitForEvent("download"); await download(page); const saved = await arriving; expect(saved.suggestedFilename()).toBe("Agreement — second.txt"); expect(await fs.readFile(await saved.path(), "utf8")).toBe(content);
    await expect(feedback(page)).toContainText("handed to your browser"); expect(requests.at(-1)).toContain(`/downloads/${idFor(499)}?`); expect(new URL(requests.at(-1)).searchParams.get("revision")).toBe(value.files[1].revision);
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain(value.files[1].name);
  }
  expect(requests).toHaveLength(2);
});

test("file paging retains earlier pages, names partial failures, and clears prior names on a failed refresh", async ({ page }) => {
  const id = await matter(page), first = await fixture(page, id, Array.from({ length: 50 }, (_, i) => file(500 - i))), second = await fixture(page, id, [file(450), file(449)]); first.nextCursor = first.files.at(-1).id; let moreFail = true, refreshFail = false;
  await page.route(listPattern(id), route => { const cursor = new URL(route.request().url()).searchParams.get("cursor"); return refreshFail || cursor && moreFail ? json(route, {}, 503) : json(route, cursor ? second : first); });
  await open(page, id); await panel(page).getByRole("button", { name: "Load more files" }).click(); await expect(feedback(page)).toContainText(/More files could not be loaded|More documents couldn’t load/); await expect(panel(page).locator("[data-download-file]")).toHaveCount(50);
  moreFail = false; await panel(page).getByRole("button", { name: "Load more files" }).click(); await expect(panel(page).locator("[data-download-file]")).toHaveCount(52); await expect(panel(page).getByRole("button", { name: "Load more files" })).toBeHidden();
  refreshFail = true; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText("File 500.txt"); await expect(panel(page)).not.toContainText(/No downloadable file records|No documents have been shared/); refreshFail = false; await refresh(page); await expect(panel(page).locator("[data-download-file]")).toHaveCount(50);
});

test("malformed and restricted projections cannot expose file controls or fabricated metadata", async ({ page }) => {
  const id = await matter(page), original = await fixture(page, id); let value = original;
  await page.route(listPattern(id), route => json(route, value)); await open(page, id);
  for (const invalid of [{ ...original, caseId: idFor(1) }, { ...original, files: [original.files[0], original.files[0]] }, { ...original, nextCursor: idFor(100) }, { ...original, files: [{ ...original.files[0], uploadedAt: "bad" }] }]) { value = invalid; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page).locator("[data-download-file]")).toHaveCount(0); }
  for (const access of ["archive_only", "purged", "unavailable"]) { value = { ...original, access, files: [] }; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page).locator("[data-download-file]")).toHaveCount(0); await expect(panel(page)).not.toContainText(/No downloadable file records|No documents have been shared/); }
  value = { ...original, ownerId: idFor(2) }; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "restricted"); await expect(panel(page)).not.toContainText(original.caseTitle);
});

test("security, changed-file, missing-object and malformed-response errors never save a file or automatically retry", async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id); let failure = { status: 423, code: "DOWNLOAD_SCAN_PENDING" }, requests = 0, saves = 0;
  page.on("download", () => saves++); await page.route(listPattern(id), route => json(route, value));
  await page.route(filePattern(id), route => { requests++; return failure.html ? route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Error page</h1>" }) : json(route, { code: failure.code }, failure.status); });
  await open(page, id);
  for (const next of [{ status: 423, code: "DOWNLOAD_SCAN_PENDING" }, { status: 422, code: "DOWNLOAD_BLOCKED" }, { status: 503, code: "DOWNLOAD_SCAN_ERROR" }, { status: 404, code: "DOWNLOAD_FILE_NOT_FOUND" }, { status: 409, code: "DOWNLOAD_CHANGED" }, { status: 503, code: "DOWNLOAD_UNAVAILABLE" }, { html: true }]) {
    failure = next; await refresh(page); const before = requests; await download(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); expect(requests).toBe(before + 1); expect(saves).toBe(0); await expect(feedback(page)).not.toContainText("The file was handed to your browser.");
    if ([404, 409].includes(next.status)) await expect(panel(page).locator(`[data-download-file="${idFor(499)}"]`).getByRole("button")).toBeDisabled();
  }
});

test("both dashboards cancel a delayed transfer and allow an explicit new download", async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id); let saves = 0; page.on("download", () => saves++); await page.route(listPattern(id), route => json(route, value));
  for (const current of [false, true]) {
    await open(page, id, current); let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
    await page.route(filePattern(id), async route => { arrived(); await gate; await route.fulfill({ contentType: "application/octet-stream", body: "late private file" }).catch(() => {}); });
    await download(page); await waiting; const before = saves; await panel(page).getByRole("button", { name: /Cancel download|Cancel file transfer/ }).click(); await expect(feedback(page)).toContainText(/Download canceled|File transfer canceled/); release(); await page.unroute(filePattern(id)); expect(saves).toBe(before);
    await page.route(filePattern(id), route => route.fulfill({ contentType: "application/octet-stream", body: "Explicit retry" })); const arriving = page.waitForEvent("download"); await download(page); const saved = await arriving; expect(await fs.readFile(await saved.path(), "utf8")).toBe("Explicit retry"); await page.unroute(filePattern(id));
  }
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} account changes discard a delayed file without handing it to the browser`, async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id, [file(499, { name: "PRIVATE_FILENAME.txt" })]); let saves = 0, release, arrived; page.on("download", () => saves++);
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(listPattern(id), route => json(route, value)); await page.route(filePattern(id), async route => { arrived(); await gate; await route.fulfill({ contentType: "application/octet-stream", body: "PRIVATE_BYTES" }).catch(() => {}); });
  await open(page, id, current); await download(page); await waiting;
  if (current) await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } })));
  else { await page.route("**/api/auth/me", route => json(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); await expect(page).toHaveURL(/dashboard-attorney\.html/); }
  release(); await expect(panel(page)).toHaveCount(0); await expect(page.locator("body")).not.toContainText("PRIVATE_FILENAME"); expect(saves).toBe(0);
});

test("navigation and closing a current dialog discard late file names and reopening loads again", async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id, [file(499, { name: "PRIVATE_DELAYED_FILENAME.txt" })]);
  for (const current of [false, true]) {
    let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
    await page.route(listPattern(id), async route => { arrived(); await gate; await json(route, value).catch(() => {}); }); await open(page, id, current, false); await waiting;
    if (current) await close(page); else await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); release(); await expect(panel(page)).toHaveCount(0); await expect(page.locator("body")).not.toContainText("PRIVATE_DELAYED_FILENAME"); await page.unroute(listPattern(id));
    await open(page, id, current); await expect(panel(page)).toContainText(/No downloadable file records|No documents have been shared/);
  }
});

test("mobile and desktop file lists keep controls reachable, accessible and keyboard operable", async ({ page }, testInfo) => {
  const id = await matter(page), value = await fixture(page, id, Array.from({ length: 8 }, (_, i) => file(500 - i, { name: `${"Long_recorded_filename_".repeat(7)}${i}.txt`, size: null, version: null, securityStatus: "unknown" }))); let reads = 0, unavailable = false;
  await page.route(listPattern(id), route => { reads++; return unavailable ? json(route, {}, 503) : json(route, value); });
  for (const current of [false, true]) {
    await page.setViewportSize({ width: 390, height: 900 }); await open(page, id, current);
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 900 }); const action = panel(page).locator("[data-download-file]").last().getByRole("button"); await action.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (current) { const actionBox = await action.boundingBox(), closeBox = await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).boundingBox(); expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(closeBox.y); expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(880); }
      const result = await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-workspace-files]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(result.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-files-${width}.png`), fullPage: true });
    }
    await expect(panel(page).getByRole("button", { name: "Retry files", exact: true })).toBeHidden();
    if (current) await close(page);
    unavailable = true;
    if (current) await open(page, id, true, false);
    else await page.reload({ waitUntil: "domcontentloaded" });
    await expect(panel(page)).toHaveAttribute("data-state", "error");
    const before = reads; unavailable = false;
    await panel(page).getByRole("button", { name: "Retry files", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(panel(page)).toHaveAttribute("data-state", "ready"); expect(reads).toBe(before + 1);
    await expect(panel(page).getByRole("button", { name: "Retry files", exact: true })).toBeHidden();
    if (current) { await page.keyboard.press("Escape"); await expect(page.locator("#caseNoteModal")).toBeHidden(); }
  }
});

test("a changed account before downloading prevents the file request entirely", async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id); let requests = 0; await page.route(listPattern(id), route => json(route, value)); await page.route(filePattern(id), route => { requests++; return json(route, {}, 403); });
  await open(page, id); await page.route("**/api/auth/me", route => json(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await download(page); await expect(panel(page)).toHaveCount(0); expect(requests).toBe(0);
});
