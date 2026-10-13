const { test, expect } = require("../support-session-fixture");
const json = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const caseId = "a".repeat(24), fileId = "b".repeat(24), paraId = "c".repeat(24);
async function fixture(page) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id;
  const matter = { _id: caseId, id: caseId, title: "River Street lease review", details: "Review the lease exhibits.", attorney: { _id: ownerId, firstName: "Avery", lastName: "Lane" }, attorneyId: ownerId, paralegal: { _id: paraId, firstName: "Priya", lastName: "Ng" }, paralegalId: paraId, status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_display", totalAmount: 100000, tasks: [], matterExperience: { sections: ["overview", "files", "messages"].map(id => ({ id })), overview: { attorney: "Avery Lane", paralegal: "Priya Ng" } } };
  const state = { writes: [], downloads: [], mode: "ok", streamRefresh: false, file: { id: fileId, caseId, originalName: "Lease exhibits.txt", mimeType: "text/plain", size: 9, createdAt: "2026-09-08T12:00:00.000Z", uploadedByRole: "paralegal", status: "pending_review", version: 1, securityStatus: "not_required", reviewRevision: "d".repeat(64), reviewOwnerId: ownerId, canReview: true } };
  await page.route("**/api/cases/my?**", route => json(route, { cases: [matter] }));
  await page.route(`**/api/cases/${caseId}?**`, route => {
    expect(new URL(route.request().url()).searchParams.get("expectedOwnerId")).toBe(ownerId);
    return json(route, matter);
  });
  await page.route(`**/api/messages/${caseId}`, route => json(route, { messages: [] }));
  await page.route(`**/api/cases/${caseId}/stream`, route => route.fulfill({ contentType: "text/event-stream", body: state.streamRefresh ? "event: documents\ndata: {}\n\n" : ": synthetic stream\n\n" }));
  await page.route(`**/api/uploads/case/${caseId}?**`, route => json(route, { files: [state.file] }));
  await page.route(`**/api/cases/${caseId}/files/${fileId}/review`, route => {
    const body = route.request().postDataJSON(); state.writes.push(body);
    if (state.mode === "conflict") return json(route, { error: "The document changed. Refresh Files before continuing." }, 409);
    state.file.status = body.status; state.file.reviewRevision = "e".repeat(64);
    if (state.mode === "lost") return route.abort("failed");
    return json(route, { file: { id: fileId, status: body.status, reviewRevision: state.file.reviewRevision, revision: "f".repeat(64), canReview: true, notes: body.notes, requestedAt: null, approvedAt: null } });
  });
  await page.route(`**/api/cases/${caseId}/downloads/${fileId}?**`, route => { state.downloads.push(Object.fromEntries(new URL(route.request().url()).searchParams)); return route.fulfill({ contentType: "application/octet-stream", body: "new lease" }); });
  await page.goto(`/case-detail.html?caseId=${caseId}&tab=files`, { waitUntil: "domcontentloaded" });
  const row = page.locator(`#caseSharedDocuments [data-file-id="${fileId}"]`); await expect(row).toBeVisible(); await expect(row.getByRole("button", { name: "Approve", exact: true })).toBeEnabled(); await expect(row.getByRole("button", { name: "Refresh Files", exact: true })).toHaveCount(0);
  return { state, row, ownerId };
}
test("the current attorney screen sends the displayed revision and uses the confirmed revision for a later decision", async ({ page }) => {
  const { state, row, ownerId } = await fixture(page); await row.getByRole("button", { name: "Approve", exact: true }).click(); await expect(row.getByRole("status")).toHaveText("Document approved.");
  expect(state.writes).toEqual([{ expectedOwnerId: ownerId, reviewedRevision: "d".repeat(64), status: "approved", notes: "" }]);
  await row.getByRole("button", { name: "Approved", exact: true }).click(); await expect(row.getByRole("status")).toHaveText("Document returned to awaiting review."); expect(state.writes[1].reviewedRevision).toBe("e".repeat(64));
});
test("a stale displayed decision shows its conflict beside the file and requires refresh before another write", async ({ page }, testInfo) => {
  const { state, row } = await fixture(page); state.mode = "conflict"; await row.getByRole("button", { name: "Approve", exact: true }).click(); await expect(row.getByRole("status")).toContainText("document changed"); await expect(row.getByRole("button", { name: "Approve", exact: true })).toBeDisabled(); expect(state.writes).toHaveLength(1);
  await expect(page.getByText("Files shared for this Matter.", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("current-document-conflict-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  // The responsive rail animates offscreen after a desktop-to-mobile resize.
  // Capture its settled geometry rather than a partially occluded frame.
  await expect.poll(() => page.locator(".sidebar").evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  await expect(row.getByRole("button", { name: "Refresh Files", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("current-document-conflict.png"), fullPage: true });
  state.mode = "ok"; state.file.reviewRevision = "f".repeat(64); await row.getByRole("button", { name: "Refresh Files", exact: true }).click(); await expect(row.getByRole("button", { name: "Approve", exact: true })).toBeEnabled(); await row.getByRole("button", { name: "Approve", exact: true }).click(); await expect(row.getByRole("status")).toHaveText("Document approved."); expect(state.writes[1].reviewedRevision).toBe("f".repeat(64));
});
test("a lost approval acknowledgement requires a read and never resends the decision automatically", async ({ page }) => {
  const { state, row } = await fixture(page); state.mode = "lost"; await row.getByRole("button", { name: "Approve", exact: true }).click(); await expect(row.getByRole("button", { name: "Refresh Files", exact: true })).toBeVisible(); expect(state.writes).toHaveLength(1);
  await row.getByRole("button", { name: "Refresh Files", exact: true }).click(); await expect(row.getByRole("button", { name: "Approved", exact: true })).toBeVisible(); expect(state.writes).toHaveLength(1);
});
test("revision resends fetch the exact reviewed document without an unbound download fallback", async ({ page }) => {
  const { state, row, ownerId } = await fixture(page); await row.getByRole("button", { name: "Request revisions", exact: true }).click(); await expect.poll(() => state.downloads.length).toBe(1); expect(state.downloads).toEqual([{ expectedOwnerId: ownerId, revision: "f".repeat(64) }]); expect(state.writes[0].status).toBe("attorney_revision");
});
test("a changed local account cannot submit the earlier displayed review", async ({ page }) => {
  const { state, row } = await fixture(page); await page.evaluate(() => localStorage.setItem("lpc_user", JSON.stringify({ id: "9".repeat(24), role: "attorney", status: "approved" }))); await row.getByRole("button", { name: "Approve", exact: true }).click(); await expect(row.getByRole("button", { name: "Refresh Files", exact: true })).toBeVisible(); expect(state.writes).toEqual([]);
});

test("document stream refreshes detect changed contents and authority even when the count and creation time stay the same", async ({ page }) => {
  const { state, row } = await fixture(page); state.file.originalName = "Renamed exhibits.txt"; state.file.reviewRevision = "1".repeat(64); state.file.canReview = false; state.streamRefresh = true;
  await expect(row).toContainText("Renamed exhibits.txt", { timeout: 20000 }); await expect(row.getByRole("button", { name: "Approve", exact: true })).toBeDisabled(); expect(state.writes).toEqual([]);
});
