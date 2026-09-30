const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const json = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const panel = page => page.locator("[data-workspace-files]"), detail = page => panel(page).getByRole("region", { name: "Document review" });
const id = n => n.toString(16).padStart(24, "0");
const file = (n, patch = {}) => ({ id: id(n), name: `Lease exhibit ${n}.txt`, revision: "d".repeat(64), reviewRevision: "e".repeat(64), size: 40, version: 1, uploadedAt: null, securityStatus: "clean", status: "pending_review", uploadedByRole: "paralegal", notes: "", requestedAt: null, approvedAt: null, replacedAt: null, revisionOf: null, mimeType: "text/plain", canReview: true, ...patch });
async function fixture(page) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id;
  const csrf = await (await page.request.get("/api/csrf")).json(), fields = { title: "River Street lease — files", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and its exhibits.", tasks: [{ title: "Review the lease" }] };
  const draftResponse = await page.request.post("/api/case-drafts", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { ...fields, expectedOwnerId: ownerId } }); expect(draftResponse.ok()).toBeTruthy(); const draft = (await draftResponse.json()).draft;
  const posted = await page.request.post("/api/cases/posting/publications", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law", expectedOwnerId: ownerId } }); expect(posted.ok()).toBeTruthy(); const caseId = (await posted.json()).publication.caseId;
  const state = { files: [file(100), file(99)], writes: [], error: false, lost: false, conflict: false, downloads: 0 };
  const pattern = `**/api/cases/${caseId}/files/review?**`;
  await page.route(pattern, route => {
    if (state.error) return json(route, {}, 503);
    const query = new URL(route.request().url()).searchParams, target = query.get("fileId"), cursor = query.get("cursor"), rows = state.files.filter(file => !cursor || file.id < cursor), files = rows.slice(0, 50), selectedFile = state.files.find(file => file.id === target) || null;
    return json(route, { caseId, ownerId, caseTitle: fields.title, access: "available", legacyAttachments: false, canUpload: true, files, nextCursor: rows.length > 50 ? files.at(-1).id : null, selection: target ? selectedFile ? "found" : "unavailable" : "none", selectedFile });
  });
  await page.route(`**/api/cases/${caseId}/files/*/review`, route => {
    const body = route.request().postDataJSON(); state.writes.push(body); const selected = state.files.find(file => route.request().url().includes(`/${file.id}/review`));
    if (state.conflict || body.reviewedRevision !== selected.reviewRevision) return json(route, { code: "DOCUMENT_CHANGED" }, 409);
    selected.status = body.status; selected.notes = body.notes; selected.reviewRevision = require("crypto").randomBytes(32).toString("hex"); selected.approvedAt = body.status === "approved" ? new Date().toISOString() : null; selected.requestedAt = body.status === "attorney_revision" ? new Date().toISOString() : null;
    return state.lost ? route.abort("failed") : json(route, { file: selected });
  });
  await page.route(`**/api/cases/${caseId}/downloads/*?**`, route => { state.downloads++; return route.fulfill({ contentType: "application/octet-stream", body: '<img src=x onerror="window.syntheticFileXss=true">\nExhibit B remains attached.' }); });
  await page.goto(`/attorney-v2.html#/matters/${caseId}/files`, { waitUntil: "domcontentloaded" }); await expect(panel(page)).toHaveAttribute("data-state", "ready"); return { caseId, ownerId, state, pattern };
}
const choose = page => panel(page).locator("[data-download-file]").first().getByRole("button").click();
test("approval names the document and version, requires confirmation and records only that decision", async ({ page }) => {
  const { state, ownerId } = await fixture(page); await choose(page); await detail(page).getByRole("button", { name: "Approve document", exact: true }).click(); await expect(detail(page)).toContainText('Approve “Lease exhibit 100.txt”, version 1?'); await expect(detail(page)).toContainText("does not complete the Matter or release payment"); expect(state.writes).toHaveLength(0);
  await detail(page).getByRole("button", { name: "Confirm approval", exact: true }).click(); await expect(panel(page)).toContainText("Document approved."); expect(state.writes).toEqual([{ expectedOwnerId: ownerId, reviewedRevision: "e".repeat(64), status: "approved", notes: "" }]); expect(state.files[1].status).toBe("pending_review");
});
test("revision instructions remain plain text, are confirmed explicitly and survive a route change before sending", async ({ page }) => {
  const { caseId, state } = await fixture(page), instructions = '<script>window.syntheticFileXss=true</script>\nExplain exhibit B.'; await choose(page); await detail(page).getByLabel("Revision instructions (optional)").fill(instructions);
  await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true }).click(); await page.goto(`/attorney-v2.html#/matters/${caseId}/files`); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await choose(page); await expect(detail(page).getByLabel("Revision instructions (optional)")).toHaveValue(instructions);
  await detail(page).getByRole("button", { name: "Request revisions", exact: true }).click(); await expect(detail(page).locator("[data-file-confirm]")).toContainText(instructions); await detail(page).getByRole("button", { name: "Confirm revision request" }).click(); await expect(panel(page)).toContainText("Revisions requested."); expect(state.writes[0].notes).toBe(instructions); expect(await page.evaluate(() => window.syntheticFileXss)).toBeUndefined();
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain(instructions);
});
test("a lost decision is checked without a second write and a conflict preserves revision instructions", async ({ page }) => {
  const { state } = await fixture(page); state.lost = true; await choose(page); await detail(page).getByRole("button", { name: "Approve document", exact: true }).click(); await detail(page).getByRole("button", { name: "Confirm approval" }).click(); await expect(panel(page)).toContainText("could not be confirmed"); expect(state.writes).toHaveLength(1); await expect(detail(page).getByRole("button", { name: "Approve document", exact: true })).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Check saved review" }).click(); await expect(panel(page)).toContainText("Current saved review: Approved"); expect(state.writes).toHaveLength(1);
  state.lost = false; state.conflict = true; await detail(page).getByLabel("Revision instructions (optional)").fill("Preserve these instructions."); await detail(page).getByRole("button", { name: "Request revisions", exact: true }).click(); await detail(page).getByRole("button", { name: "Confirm revision request" }).click(); await expect(panel(page)).toContainText("document or Matter changed"); state.conflict = false; await panel(page).getByRole("button", { name: "Check saved review" }).click(); await expect(detail(page).getByLabel("Revision instructions (optional)")).toHaveValue("Preserve these instructions.");
});
test("returning an approved document to review states that approval is cleared", async ({ page }) => {
  const { state } = await fixture(page); state.files[0].status = "approved"; await panel(page).getByRole("button", { name: "Refresh files", exact: true }).click(); await choose(page); await detail(page).getByRole("button", { name: "Return to awaiting review" }).click(); await expect(detail(page)).toContainText("approval or revision request will be cleared"); await detail(page).getByRole("button", { name: "Confirm awaiting review" }).click(); await expect(panel(page)).toContainText("Document returned to awaiting review."); expect(state.files[0].status).toBe("pending_review");
});
test("exact earlier document links work beyond the first page and missing links are explicit", async ({ page }) => {
  const { caseId, state } = await fixture(page); state.files = Array.from({ length: 65 }, (_, i) => file(100 - i)); await page.goto(`/attorney-v2.html#/matters/${caseId}/files?fileId=${id(36)}`); await expect(detail(page)).toContainText("Lease exhibit 36.txt"); await expect(detail(page)).toBeFocused(); await expect(panel(page).locator("[data-download-file]")).toHaveCount(50); await panel(page).getByRole("button", { name: "Load more files" }).click(); await expect(panel(page).locator("[data-download-file]")).toHaveCount(65);
  await page.goto(`/attorney-v2.html#/matters/${caseId}/files?fileId=${id(1)}`); await expect(panel(page)).toContainText("linked document is no longer available"); await expect(panel(page).locator(".av2-file-detail")).toBeEmpty();
});
test("security restrictions remove decision controls and failed reads do not become an empty file list", async ({ page }) => {
  const { state } = await fixture(page); state.files[0].canReview = false; state.files[0].securityStatus = "blocked"; await panel(page).getByRole("button", { name: "Refresh files", exact: true }).click(); await choose(page); await expect(detail(page).getByRole("button", { name: "Approve document" })).toHaveCount(0); await expect(detail(page)).toContainText("Review changes are unavailable"); state.error = true; await panel(page).getByRole("button", { name: "Refresh files", exact: true }).click(); await expect(panel(page)).toContainText("Files couldn’t load."); await expect(panel(page).locator("[data-download-file]")).toHaveCount(0); await expect(panel(page)).not.toContainText("No documents have been shared");
});
test("text preview renders file bytes as text and closes on navigation", async ({ page }) => {
  const { state } = await fixture(page); await choose(page); await detail(page).getByRole("button", { name: "Preview file" }).click(); await expect(detail(page).locator("pre")).toContainText('<img src=x onerror="window.syntheticFileXss=true">'); expect(await page.evaluate(() => window.syntheticFileXss)).toBeUndefined(); expect(state.downloads).toBe(1); await detail(page).getByRole("button", { name: "Close preview" }).click(); await expect(detail(page).locator("pre")).toHaveCount(0); await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); await expect(panel(page)).toHaveCount(0);
});
test("a changed file after selection is not downloaded again until Files is refreshed", async ({ page }) => {
  const { caseId } = await fixture(page); let calls = 0; await page.route(`**/api/cases/${caseId}/downloads/*?**`, route => { calls++; return json(route, { code: "DOWNLOAD_CHANGED" }, 409); }); await choose(page); await detail(page).getByRole("button", { name: "Download file", exact: true }).click(); await expect(panel(page)).toContainText("file changed after the list loaded"); await expect(panel(page).locator("[data-download-file]").first().getByRole("button")).toBeDisabled(); expect(calls).toBe(1);
});
test("document notes, long names and confirmation controls remain accessible at mobile and desktop widths", async ({ page }, testInfo) => {
  const { state } = await fixture(page); state.files[0].name = "Lease_exhibits_original_numbering_".repeat(6) + ".txt"; await panel(page).getByRole("button", { name: "Refresh files", exact: true }).click(); await choose(page);
  await expect(detail(page).getByRole("button", { name: "Approve document", exact: true })).toBeVisible();
  for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect((await new AxeBuilder({ page }).include("[data-workspace-files]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await page.screenshot({ path: testInfo.outputPath(`files-${width}.png`), fullPage: true }); }
});

test("PDF previews use only the protected file response and keep a download fallback", async ({ page }) => {
  const { caseId, state } = await fixture(page), blocked = [];
  await page.exposeFunction("syntheticFilePolicyBlocked", value => blocked.push(value));
  await page.evaluate(() => document.addEventListener("securitypolicyviolation", event => { window.syntheticFilePolicyBlocked({ directive: event.effectiveDirective, uri: event.blockedURI }); }));
  state.files[0].mimeType = "application/pdf"; state.files[0].name = "Lease.pdf";
  let pdf = "%PDF-1.4\n", offsets = [0];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await page.route(`**/api/cases/${caseId}/downloads/*?**`, route => route.fulfill({ contentType: new URL(route.request().url()).searchParams.get("preview") === "true" ? "application/pdf" : "application/octet-stream", body: pdf }));
  await panel(page).getByRole("button", { name: "Refresh files", exact: true }).click(); await choose(page);
  if (!await page.evaluate(() => navigator.pdfViewerEnabled !== false)) { await expect(detail(page)).toContainText("browser does not display PDF previews"); await expect(detail(page).getByRole("button", { name: "Download file", exact: true })).toBeVisible(); return; }
  await detail(page).getByRole("button", { name: "Preview file" }).click();
  await expect(detail(page).getByTitle("Preview of Lease.pdf")).toBeVisible(); await expect(detail(page).getByRole("button", { name: "Download file", exact: true })).toBeVisible();
  await expect(detail(page).locator("iframe")).toHaveAttribute("src", new RegExp(`/api/cases/${caseId}/downloads/${id(100)}.*preview=true`));
  await detail(page).getByRole("button", { name: "Close preview" }).click(); expect(blocked.filter(value => value.directive === "frame-src")).toEqual([]); await expect(detail(page).locator("iframe")).toHaveCount(0);
});

test("instructions for two documents remain separate when switching the selected file", async ({ page }) => {
  await fixture(page); await choose(page); await detail(page).getByLabel("Revision instructions (optional)").fill("Keep the lease instructions.");
  await panel(page).locator("[data-download-file]").nth(1).getByRole("button").click(); await detail(page).getByLabel("Revision instructions (optional)").fill("Keep the exhibit instructions.");
  await choose(page); await expect(detail(page).getByLabel("Revision instructions (optional)")).toHaveValue("Keep the lease instructions."); await panel(page).locator("[data-download-file]").nth(1).getByRole("button").click(); await expect(detail(page).getByLabel("Revision instructions (optional)")).toHaveValue("Keep the exhibit instructions.");
});
test("a refresh makes file selection visibly unavailable until the new list arrives", async ({ page }) => {
  const { pattern } = await fixture(page); let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(pattern, async route => { arrived(); await gate; await route.fallback(); });
  await panel(page).getByRole("button", { name: "Refresh files", exact: true }).click(); await waiting;
  try { await expect(panel(page).locator("[data-download-file]").first().getByRole("button")).toBeDisabled(); }
  finally { release(); }
  await expect(panel(page).locator("[data-download-file]").first().getByRole("button")).toBeEnabled(); await choose(page); await expect(detail(page)).toContainText("Lease exhibit 100.txt");
});

test("image previews wait for decoding, release their object URL and report unreadable image bytes", async ({ page }) => {
  const { caseId, state } = await fixture(page); state.files[0].mimeType = "image/gif"; state.files[0].name = "Exhibit.gif";
  const bytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"); let corrupt = false;
  await page.route(`**/api/cases/${caseId}/downloads/*?**`, route => route.fulfill({ contentType: "application/octet-stream", body: corrupt ? Buffer.from("Not an image") : bytes }));
  await page.evaluate(() => { window.syntheticRevokedFileUrls = []; const original = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.syntheticRevokedFileUrls.push(url); original(url); }; });
  await panel(page).getByRole("button", { name: "Refresh files", exact: true }).click(); await choose(page); await detail(page).getByRole("button", { name: "Preview file" }).click(); await expect(panel(page)).toContainText("Preview ready."); await expect(detail(page).getByAltText("Exhibit.gif")).toBeVisible(); expect(await detail(page).getByAltText("Exhibit.gif").evaluate(image => image.naturalWidth)).toBe(1);
  const source = await detail(page).getByAltText("Exhibit.gif").getAttribute("src"); await detail(page).getByRole("button", { name: "Close preview" }).click(); expect(await page.evaluate(() => window.syntheticRevokedFileUrls)).toContain(source);
  corrupt = true; await detail(page).getByRole("button", { name: "Preview file" }).click(); await expect(panel(page)).toContainText("image preview couldn’t load"); await expect(detail(page).locator("img")).toHaveCount(0);
});
