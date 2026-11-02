"use strict";
const { test, expect } = require("playwright/test");
const fs = require("node:fs"), path = require("node:path");
const { installNativeFixture, gotoNative, MATTER, OWNER, FILE, PLAN, filesReview } = require("./native-fixture.cjs");
const BASE = "/api/integrations/clio", TRANSFER = "8123456789abcdef01234567", APPROVED = "9123456789abcdef01234567", IMPORTED = "a123456789abcdef01234567";
const destination = { id: "123", label: "Synthetic matter 2026-42", description: "Discovery chronology" };
const document = { id: "21", name: "Source chronology.pdf", ready: true, versionId: "31", versionUuid: "synthetic-source-version", size: 2500 };
const connection = { ownerId: OWNER, configured: true, connected: true, connectionRevision: "synthetic-live-clio-revision" };
const assignmentRevision = "c".repeat(64);
const pendingReceipt = (direction, body) => ({ id: TRANSFER, direction, status: "uncertain", assignmentRevision: direction === "import" ? assignmentRevision : null, label: destination.label, fileName: direction === "export" ? "Approved chronology.pdf" : "Source chronology.pdf", fileVersion: 2, documentCount: 1, handoffId: direction === "import" ? PLAN : null, retry: { path: BASE + "/matters/" + MATTER + "/" + direction, body } });
async function shot(page, name) { if (process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS) { fs.mkdirSync(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, name + ".png"), fullPage: true }); } }
function browse(call) {
  if (call.path === BASE + "/status") return connection;
  if (call.path === BASE + "/handoffs" && call.method === "GET") return { items: [] };
  if (call.path === BASE + "/matters") return { items: [destination], nextCursor: null };
  if (call.path === BASE + "/matters/123/documents") return { items: [document], nextCursor: null };
}
function filePage(call, { approved = false, imported = false } = {}) {
  const value = filesReview(OWNER), pending = value.files[0];
  const approvedFile = { ...pending, id: APPROVED, name: "Approved chronology.pdf", mimeType: "application/pdf", version: 2, status: "approved", approvedAt: "2026-11-01T12:00:00.000Z" };
  value.filters = { q: call.query.q || "", status: call.query.status || "all", sort: call.query.sort || "newest" };
  value.files = call.query.status === "approved" ? approved ? [approvedFile] : [] : [pending, ...(imported ? [{ ...pending, id: IMPORTED, name: "Source chronology.pdf", mimeType: "application/pdf", status: "pending_review", uploadedByRole: "attorney", canReview: false, securityStatus: "pending" }] : [])];
  value.total = value.files.length; value.counts = { total: value.total, awaitingReview: call.query.status === "approved" ? 0 : 1, revisions: 0, approved: call.query.status === "approved" && approved ? 1 : 0 };
  if (call.query.fileId) { value.selectedFile = value.files.find(file => file.id === call.query.fileId) || null; value.selection = value.selectedFile ? "found" : "unavailable"; }
  return value;
}
test("native Files import retains its reviewed selection and recovers an uncertain transfer from the durable receipt", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let imports = 0, receipt = null, imported = false;
  const state = await installNativeFixture(page, { resolve(call) {
    const common = browse(call); if (common) return common;
    if (call.path === BASE + "/transfers") return { assignmentRevision, items: receipt ? [receipt] : [] };
    if (call.path === "/api/cases/" + MATTER + "/files/review") return filePage(call, { imported });
    if (call.path === BASE + "/matters/" + MATTER + "/handoffs") return { handoffId: PLAN, caseId: MATTER };
    if (call.path === BASE + "/matters/" + MATTER + "/import") {
      imports++; const { expectedOwnerId, expectedConnectionRevision, confirmed, ...body } = call.body;
      if (imports === 1) { receipt = pendingReceipt("import", body); return { statusCode: 503, body: { error: "Synthetic import acknowledgement lost" } }; }
      imported = true; receipt = { ...receipt, status: "recorded", retry: null };
      return { status: "recorded", transferId: TRANSFER, files: [{ id: IMPORTED, name: document.name, version: 1, securityStatus: "pending" }] };
    }
  } });
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/files");
  const card = page.locator("[data-native-clio-transfers]");
  await card.getByRole("button", { name: "Import documents", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import from Clio", exact: true });
  await dialog.locator('[data-clio-matter-choice="123"]').click(); await dialog.locator('[data-clio-document-choice="21"]').check();
  await dialog.getByRole("button", { name: "Review selection" }).click();
  await expect(dialog).toContainText("1 selected document"); await expect(dialog).toContainText("normal security check");
  await dialog.getByRole("button", { name: "Import selected documents" }).click();
  await expect(dialog).toContainText("import acknowledgement lost"); await expect(card).not.toContainText("Documents imported.");
  await dialog.getByRole("button", { name: "Close import from clio", exact: true }).click();
  await expect(card).toContainText("Needs confirmation"); await card.getByRole("button", { name: "Check transfer", exact: true }).click();
  const recovery = page.getByRole("dialog", { name: "Check saved transfer", exact: true });
  await expect(recovery).toContainText(destination.label); await expect(recovery).toContainText("preserves its original document and destination");
  await recovery.getByRole("button", { name: "Check transfer", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(recovery).toHaveCount(0); await expect(card).toContainText("Imported from Clio");
  await expect(page.locator('[data-download-file="' + IMPORTED + '"]')).toContainText("Security check pending");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); await shot(page, "native-clio-import-mobile");
  const writes = state.calls.filter(call => call.path === BASE + "/matters/" + MATTER + "/import"); expect(writes).toHaveLength(2); expect(writes[0].body).toEqual(writes[1].body);
  expect(state.calls.filter(call => call.method !== "GET" && (call.path === BASE + "/handoffs" || /\/api\/payments\//.test(call.path)))).toEqual([]); expect(state.pageErrors).toEqual([]);
});

test("native Clio export finds approved documents outside the visible filter and requires a verified receipt before success", async ({ page }) => {
  let exports = 0, receipt = null;
  const state = await installNativeFixture(page, { resolve(call) {
    const common = browse(call); if (common) return common;
    if (call.path === BASE + "/transfers") return { assignmentRevision, items: receipt ? [receipt] : [] };
    if (call.path === "/api/cases/" + MATTER + "/files/review") return filePage(call, { approved: true });
    if (call.path === BASE + "/matters/" + MATTER + "/export") {
      exports++; if (exports === 1) return { transferId: TRANSFER, status: "uncertain" };
      receipt = { id: TRANSFER, direction: "export", status: "recorded", label: destination.label, fileName: "Approved chronology.pdf", fileVersion: 2, documentCount: 1, retry: null };
      return { transferId: TRANSFER, fileId: APPROVED, clioMatterId: "123", clioDocumentId: "201", status: "recorded" };
    }
  } });
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/files?fileSearch=Discovery&fileStatus=pending_review");
  await expect(page.getByLabel("Search files", { exact: true })).toHaveValue("Discovery");
  const card = page.locator("[data-native-clio-transfers]"); await card.getByRole("button", { name: "Send to Clio", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send to Clio", exact: true });
  await expect(dialog.locator('[data-clio-export-file="' + FILE + '"]')).toHaveCount(0);
  await dialog.locator('[data-clio-export-file="' + APPROVED + '"]').check(); await dialog.getByRole("button", { name: "Choose destination" }).click();
  await dialog.locator('[data-clio-matter-choice="123"]').click(); await expect(dialog).toContainText("Approved chronology.pdf"); await expect(dialog).toContainText("Version 2");
  await dialog.getByRole("button", { name: "Send approved document" }).click();
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText(/could not be|not been|not confirmed|cannot be/);
  await expect(card).not.toContainText("The approved document was sent to Clio.");
  await dialog.getByRole("button", { name: "Send approved document" }).click();
  await expect(dialog).toHaveCount(0); await expect(card).toContainText("Sent to Clio");
  await expect(page.getByLabel("Search files", { exact: true })).toHaveValue("Discovery");
  const writes = state.calls.filter(call => call.path.endsWith("/export") && call.path.startsWith(BASE)); expect(writes).toHaveLength(2); expect(writes[0].body).toEqual(writes[1].body); expect(writes[0].body).toMatchObject({ fileId: APPROVED, expectedFileVersion: 2, clioMatterId: "123", expectedOwnerId: OWNER, expectedConnectionRevision: connection.connectionRevision, confirmed: true });
  expect(state.calls.some(call => call.path === "/api/cases/" + MATTER + "/files/review" && call.query.status === "approved" && !call.query.q)).toBe(true); expect(state.pageErrors).toEqual([]);
});

test("disconnecting Clio retains truthful transfer history and removes mutation controls", async ({ page }) => {
  const state = await installNativeFixture(page, { resolve(call) {
    if (call.path === BASE + "/status") return { ownerId: OWNER, configured: true, connected: false, needsReconnect: true };
    if (call.path === BASE + "/transfers") return { assignmentRevision, items: [pendingReceipt("export", { fileId: APPROVED, clioMatterId: "123", requestId: "synthetic-original-request" }), { id: PLAN, direction: "import", status: "recorded", fileName: "Earlier source.pdf", label: destination.label, documentCount: 1 }] };
  } });
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/files");
  const card = page.locator("[data-native-clio-transfers]");
  await expect(card).toContainText("Needs confirmation"); await expect(card).toContainText("Imported from Clio");
  await expect(card.getByRole("button", { name: /Import documents|Send to Clio|Check transfer/ })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Reconnect Clio", exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.method !== "GET" && call.path.startsWith(BASE))).toEqual([]); expect(state.pageErrors).toEqual([]);
});
