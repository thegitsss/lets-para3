"use strict";
const { test, expect } = require("playwright/test");
const fs = require("node:fs"), path = require("node:path");
const { installNativeFixture, gotoNative, MATTER, OWNER, PARA, FILE, filesReview } = require("./native-fixture.cjs");
const SESSION = "7123456789abcdef01234567", base = "/api/document-collaboration";
function editorSession(ownerId) { return { sessionId: SESSION, editorOrigin: "https://editor.synthetic.test", scriptUrl: "https://editor.synthetic.test/web-apps/apps/api/documents/api.js", expiresAt: new Date(Date.now() + 1800000).toISOString(), savedVersion: 1, config: { documentType: "word", token: "synthetic-signed-provider-token", document: { title: "Discovery instructions.docx", fileType: "docx", key: "synthetic-document-key", url: "https://editor.synthetic.test/synthetic-source.docx" }, editorConfig: { user: { id: ownerId, name: "Synthetic user" }, customization: { forcesave: false } } } }; }
async function fixture(page, { role = "attorney", sessionPatch = {} } = {}) {
  const ownerId = role === "attorney" ? OWNER : PARA;
  const ui = { configured: true, version: 1, receipt: null, receiptState: "requested", noChanges: false, sessionFailure: false };
  const state = await installNativeFixture(page, { role, editorScript: true, resolve(call) {
    if (call.path === base + "/status") return { configured: ui.configured, formats: ["docx"] };
    if (call.path === base + "/matters/" + MATTER + "/files/" + FILE + "/session") return ui.sessionFailure ? { statusCode: 503, body: { error: "Synthetic editor connection unavailable" } } : { ...editorSession(ownerId), ...sessionPatch };
    if (call.path === base + "/sessions/" + SESSION + "/save") { ui.receipt = call.body.clientRequestId; ui.receiptState = ui.noChanges ? "unknown" : "requested"; return { requestId: ui.receipt, pending: !ui.noChanges, ...(ui.noChanges ? { noChanges: true, savedVersion: ui.version } : {}) }; }
    if (call.path === base + "/sessions/" + SESSION) return { sessionId: SESSION, ownerId, caseId: MATTER, fileId: FILE, state: "open", savedVersion: ui.version, lastSavedAt: ui.version > 1 ? "2026-11-02T12:00:00.000Z" : null, ...(ui.receipt ? { saveRequest: { id: ui.receipt, state: ui.receiptState, version: ui.receiptState === "confirmed" ? ui.version : null } } : {}) };
    if (call.path === "/api/cases/" + MATTER + "/files/review") {
      const value = filesReview(ownerId); value.files[0].version = ui.version; value.filters = { q: call.query.q || "", status: call.query.status || "all", sort: call.query.sort || "newest" };
      if (call.query.fileId === FILE) { value.selection = "found"; value.selectedFile = value.files[0]; } return value;
    }
  } });
  return Object.assign(ui, { state, ownerId });
}
async function open(page, role = "attorney") {
  await gotoNative(page, role === "attorney" ? "/attorney-v2.html#/matters/" + MATTER + "/files?fileId=" + FILE : "/paralegal-v2.html#/matter/" + MATTER + "?tab=files&fileId=" + FILE);
  const launch = role === "attorney" ? page.getByRole("region", { name: "Document review", exact: true }).getByRole("button", { name: "Edit in LPC", exact: true }) : page.locator('[data-v2-file-edit="' + FILE + '"]');
  await launch.click(); return page.getByRole("dialog", { name: "Document editor", exact: true });
}
async function edited(page) { await page.evaluate(() => { const events = window.nativeEditorFixture.config.events; events.onDocumentStateChange({ data: true }); events.onDocumentStateChange({ data: false }); }); }
async function shot(page, name) { if (process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS) { fs.mkdirSync(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, name + ".png"), fullPage: true }); } }

test("native editor occupies the portal viewport and distinguishes an earlier confirmed save from later edits", async ({ page }) => {
  const ui = await fixture(page), dialog = await open(page);
  await expect(dialog.locator("[data-native-editor-stage]")).toContainText("Synthetic editor provider fixture");
  const rect = await dialog.boundingBox(); expect(rect.width).toBeGreaterThanOrEqual(1440 * 0.9); expect(rect.height).toBeGreaterThanOrEqual(1000 * 0.9);
  await expect(dialog.getByRole("button", { name: "Save to LPC", exact: true })).toBeDisabled();
  await edited(page); await dialog.getByRole("button", { name: "Save to LPC", exact: true }).click();
  await expect(dialog).toContainText("Waiting for LPC to confirm this save");
  await expect(dialog).not.toContainText("Version 2 saved in LPC");
  await edited(page); ui.version = 2; ui.receiptState = "confirmed";
  await dialog.getByRole("button", { name: "Check saved version" }).click();
  await expect(dialog).toContainText("New changes to save");
  await dialog.getByRole("button", { name: "Return to Files", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Leave this document?", exact: true });
  await expect(guard).toBeVisible(); await guard.getByRole("button", { name: "Keep writing" }).click();
  await expect(dialog.getByRole("button", { name: "Save to LPC", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Save to LPC", exact: true }).click();
  await expect(dialog).toContainText("Waiting for LPC to confirm this save");
  ui.version = 3; ui.receiptState = "confirmed";
  await dialog.getByRole("button", { name: "Check saved version" }).click();
  await expect(dialog).toContainText("Version 3 saved in LPC");
  await shot(page, "native-editor-desktop");
  await dialog.getByRole("button", { name: "Return to Files", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(guard).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Document review", exact: true }).getByRole("heading", { name: "Discovery instructions.docx", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Document review", exact: true })).toContainText("Version 3");
  const saves = ui.state.calls.filter(call => call.path.endsWith("/save") && call.path.startsWith(base)); expect(saves).toHaveLength(2); expect(saves[0].body.clientRequestId).toMatch(/^[a-f0-9-]{36}$/); expect(saves[1].body.clientRequestId).not.toBe(saves[0].body.clientRequestId);
  expect(ui.state.calls.filter(call => call.method !== "GET" && /\/api\/(?:payments|cases)\//.test(call.path))).toEqual([]); expect(ui.state.pageErrors).toEqual([]);
});

test("native paralegal editor preserves unconfirmed work when the provider returns no new version on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ui = await fixture(page, { role: "paralegal" }); ui.noChanges = true;
  const dialog = await open(page, "paralegal");
  await expect(dialog.locator("[data-native-editor-stage]")).toContainText("Synthetic editor provider fixture");
  await edited(page); await dialog.getByRole("button", { name: "Save to LPC", exact: true }).click();
  await expect(dialog).toContainText("This save has not been confirmed");
  await expect(dialog).not.toContainText("saved in LPC");
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await shot(page, "native-editor-paralegal-mobile");
  await dialog.getByRole("button", { name: "Return to Files", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Leave this document?", exact: true });
  await expect(guard).toBeVisible(); await guard.getByRole("button", { name: "Keep writing" }).click();
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole("button", { name: /Approve|Accept|Complete/ })).toHaveCount(0);
  const status = ui.state.calls.filter(call => call.path === base + "/sessions/" + SESSION); expect(status.at(-1).query.saveRequestId).toBe(ui.receipt);
  await dialog.getByRole("button", { name: "Return to Files", exact: true }).click(); await guard.getByRole("button", { name: "Return to Files", exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.locator('[data-v2-file-edit="' + FILE + '"]')).toBeVisible(); expect(ui.state.pageErrors).toEqual([]);
});

test("native editor keeps file selection through provider setup loss and a failed session, then recovers explicitly", async ({ page }) => {
  const ui = await fixture(page);
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/files?fileId=" + FILE);
  const launch = page.getByRole("region", { name: "Document review", exact: true }).getByRole("button", { name: "Edit in LPC", exact: true });
  await expect(launch).toBeVisible(); ui.configured = false; await launch.click();
  const dialog = page.getByRole("dialog", { name: "Document editor", exact: true });
  await expect(dialog).toContainText("Document editing is not connected yet"); await expect(dialog.locator("iframe")).toHaveCount(0);
  expect(ui.state.calls.filter(call => call.path.endsWith("/session"))).toHaveLength(0);
  ui.configured = true; ui.sessionFailure = true; await dialog.getByRole("button", { name: "Check connection again" }).click();
  await expect(dialog).toContainText("Synthetic editor connection unavailable"); await expect(page.locator('script[src^="https://editor.synthetic.test"]')).toHaveCount(0);
  ui.sessionFailure = false; await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog.locator("[data-native-editor-stage]")).toContainText("Synthetic editor provider fixture");
  await dialog.getByRole("button", { name: "Return to Files", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0); await expect(launch).toBeFocused();
  expect(new URL(page.url()).hash).toContain("fileId=" + FILE); expect(ui.state.pageErrors).toEqual([]);
});
