"use strict";
const { test, expect } = require("playwright/test");
const fs = require("node:fs"), path = require("node:path");
const { installNativeFixture, gotoNative, MATTER, PARA, FILE, PLAN, JOB, preparation, prepSnapshot } = require("./native-fixture.cjs");
const base = "/api/matter-preparation/matters/" + MATTER;
const quote = '<img src=x onerror="window.syntheticSourceExecuted=true"> Follow the selected source instructions.';
const proposed = () => preparation({ items: [{ title: "Prepare discovery responses", citations: [{ sourceId: FILE + ":p2", quote, name: "Discovery instructions.docx", fileId: FILE, version: 1, page: 2, section: null }] }, { title: "Prepare chronology", citations: [{ sourceId: "scope", quote: "Prepare discovery responses", name: "Agreed Matter instructions", fileId: null, page: null, section: null }] }], files: [{ id: FILE, name: "Discovery instructions.docx", version: 1, sectionsRead: 2, totalSections: 3, unreadablePages: [3], readingMethod: "text_and_ocr", partial: true }] });
async function shot(page, name) { if (process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS) { fs.mkdirSync(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, name + ".png"), fullPage: true }); } }
async function chooseDocument(panel) { await panel.getByText(/Select documents ·/).click(); await panel.getByRole("checkbox", { name: /Discovery instructions\.docx/ }).check(); }
const start = panel => panel.getByRole("button", { name: "Prepare work", exact: true }).last();
test("native attorney Work prepares scanned sources, retains edits through Files, and safely recovers acceptance", async ({ page }) => {
  let createAttempts = 0, acceptAttempts = 0, completed = false, accepted = false, acceptedItems;
  const state = await installNativeFixture(page, { resolve(call) {
    if (call.path === base && call.method === "GET") return prepSnapshot("attorney", { preparation: completed ? accepted ? preparation({ status: "accepted", revision: 1, items: acceptedItems, files: proposed().files }) : proposed() : null, activeJob: completed ? null : createAttempts > 1 ? { id: JOB, kind: "preparation", status: "running", stage: "ocr", totalFiles: 1, processedFiles: 0 } : null });
    if (call.path === base + "/jobs") { createAttempts++; if (createAttempts === 1) return { statusCode: 503, body: { error: "Synthetic start acknowledgement lost; check this preparation" } }; return { statusCode: 202, body: { job: { id: JOB, kind: "preparation", status: "running", stage: "ocr", processedFiles: 0, totalFiles: 1 } } }; }
    if (call.path === base + "/jobs/" + JOB) { completed = true; return { job: { id: JOB, kind: "preparation", status: "complete", stage: "complete", processedFiles: 1, totalFiles: 1, preparationId: PLAN } }; }
    if (call.path === base + "/accept") {
      acceptAttempts++; if (acceptAttempts === 1) return { statusCode: 503, body: { error: "Synthetic checklist acknowledgement lost; check saved checklist" } };
      if (acceptAttempts === 2) return { preparation: null };
      accepted = true; acceptedItems = call.body.items.map(item => ({ title: item.title, citations: item.sourceIndex === null ? [] : proposed().items[item.sourceIndex].citations, ...(item.sourceIndex === null ? { authoredByAttorney: true } : { editedByAttorney: true }) }));
      return { preparation: preparation({ status: "accepted", revision: 1, items: acceptedItems, files: proposed().files }) };
    }
  } });
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/work");
  await expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
  let panel = page.locator('[data-native-preparation][data-mode="preparation"]');
  await chooseDocument(panel); await start(panel).click();
  await expect(panel.getByRole("alert")).toContainText("start acknowledgement lost");
  await expect(panel.getByRole("checkbox", { name: /Discovery instructions/ })).toBeChecked();
  await panel.getByRole("button", { name: "Check preparation", exact: true }).click();
  await expect(panel).toContainText("Reading scanned pages");
  await expect(panel.getByLabel("Working checklist item 1", { exact: true })).toHaveValue("Prepare discovery responses");
  await panel.getByLabel("Working checklist item 1", { exact: true }).fill("Draft discovery responses for counsel review");
  await panel.getByRole("button", { name: "Remove checklist item 2" }).click();
  await panel.getByRole("button", { name: "Add working item" }).click();
  await panel.getByLabel("Working checklist item 2", { exact: true }).fill("Attorney-authored review reminder");
  await panel.getByText("View source", { exact: true }).first().click();
  await expect(panel.locator("blockquote").first()).toHaveText(quote);
  expect(await panel.locator("blockquote img").count()).toBe(0); expect(await page.evaluate(() => window.syntheticSourceExecuted)).toBeUndefined();
  await panel.getByText(/Reading coverage ·/).click();
  await expect(panel).toContainText("unreadable pages: 3"); await expect(panel).toContainText("scan returned partial results");
  await shot(page, "native-preparation-desktop");
  await panel.getByRole("link", { name: "Discovery instructions.docx · page 2" }).click();
  await expect(page.getByRole("region", { name: "Document review", exact: true }).getByRole("heading", { name: "Discovery instructions.docx", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true }).click();
  panel = page.locator('[data-native-preparation][data-mode="preparation"]');
  await expect(panel.getByLabel("Working checklist item 1", { exact: true })).toHaveValue("Draft discovery responses for counsel review");
  await expect(panel.getByLabel("Working checklist item 2", { exact: true })).toHaveValue("Attorney-authored review reminder");
  await expect(panel.getByText("Select documents · 1 selected", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Accept working checklist", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("checklist acknowledgement lost");
  await expect(panel.locator("ol.lpc-connected-checklist")).toHaveJSProperty("inert", true);
  expect(await panel.getByLabel("Working checklist item 1", { exact: true }).evaluate(element => { element.focus(); return document.activeElement === element; })).toBe(false);
  await expect(panel.getByRole("button", { name: "Add working item" })).toBeDisabled();
  await panel.getByRole("button", { name: "Check saved checklist" }).click();
  await expect(panel.getByRole("alert")).toContainText(/not be|not been|cannot be|not confirm/);
  await expect(panel).not.toContainText("Working checklist accepted and saved.");
  await panel.getByRole("button", { name: "Check saved checklist" }).click();
  await expect(panel).toContainText("Accepted by attorney"); await expect(panel).toContainText("Attorney-authored review reminder");
  const created = state.calls.filter(call => call.path === base + "/jobs"); expect(created).toHaveLength(2); expect(created[0].body).toEqual(created[1].body); expect(created[0].body.fileIds).toEqual([FILE]);
  const accepts = state.calls.filter(call => call.path === base + "/accept"); expect(accepts).toHaveLength(3); expect(accepts.map(call => call.body)).toEqual(new Array(3).fill(accepts[0].body)); expect(accepts[0].body.items).toEqual([{ title: "Draft discovery responses for counsel review", sourceIndex: 0 }, { title: "Attorney-authored review reminder", sourceIndex: null }]);
  expect(state.calls.filter(call => call.method !== "GET" && /^\/api\/(?:payments|cases)\//.test(call.path))).toEqual([]); expect(state.pageErrors).toEqual([]);
});
test("native assigned paralegal Work shows source-linked suggestions without attorney acceptance on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await installNativeFixture(page, { role: "paralegal", resolve(call) { if (call.path === base) return prepSnapshot("paralegal", { preparation: proposed() }); } });
  await gotoNative(page, "/paralegal-v2.html#/matter/" + MATTER + "?tab=work");
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  const panel = page.locator('[data-native-preparation][data-mode="preparation"]');
  const entry = page.locator("[data-native-preparation-entry]");
  await expect(entry).toBeVisible(); await entry.focus(); await page.keyboard.press("Enter");
  await expect(panel).toBeFocused();
  await expect(panel.getByRole("heading", { name: "Working checklist", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Accept working checklist|Add working item|Remove checklist/ })).toHaveCount(0);
  await expect(panel.getByLabel("Working checklist item 1")).toHaveCount(0);
  await expect(panel).toContainText("The attorney can edit and accept");
  await panel.getByText("View source", { exact: true }).first().focus(); await page.keyboard.press("Enter");
  await expect(panel.locator("blockquote").first()).toHaveText(quote); expect(await panel.locator("blockquote img").count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await shot(page, "native-preparation-paralegal-mobile");
  expect(state.calls.filter(call => call.path.endsWith("/accept"))).toEqual([]); expect(state.pageErrors).toEqual([]);
});
test("native Work keeps agreed tasks usable when preparation is not configured", async ({ page }) => {
  const state = await installNativeFixture(page);
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/work");
  const panel = page.locator("[data-native-preparation]");
  await expect(panel).toContainText("Document intelligence is being connected");
  await expect(panel.getByRole("button", { name: "Prepare work", exact: true })).toHaveCount(0);
  await expect(page.getByText("Prepare discovery responses", { exact: true }).first()).toBeVisible();
  expect(state.calls.filter(call => call.path.endsWith("/jobs"))).toEqual([]); expect(state.pageErrors).toEqual([]);
});
test("native Files submission retries a durable OCR job and makes no completion or approval claim", async ({ page }) => {
  let phase = "failed";
  const state = await installNativeFixture(page, { resolve(call) {
    if (call.path === base) return prepSnapshot("attorney", { preparation: null, submission: phase === "complete" ? preparation({ kind: "submission", items: [], observations: [{ title: "Confirm the date against the selected source", citations: [{ sourceId: "scope", quote: "Prepare discovery responses", name: "Agreed Matter instructions" }] }] }) : null, activeJob: phase === "complete" ? null : { id: JOB, kind: "submission", status: "failed", stage: "failed", processedFiles: 0, totalFiles: 1, retryable: true, error: "Synthetic OCR reading paused" } });
    if (call.path === base + "/jobs/" + JOB + "/retry") { phase = "running"; return { statusCode: 202, body: { job: { id: JOB, kind: "submission", status: "running", stage: "ocr", totalFiles: 1, processedFiles: 0 } } }; }
    if (call.path === base + "/jobs/" + JOB) { phase = "complete"; return { job: { id: JOB, kind: "submission", status: "complete", stage: "complete", totalFiles: 1, processedFiles: 1, preparationId: PLAN } }; }
  } });
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/files");
  const panel = page.locator('[data-native-preparation][data-mode="submission"]');
  await expect(panel).toContainText("Synthetic OCR reading paused");
  await panel.getByRole("button", { name: "Continue preparation" }).click();
  await expect(panel).toContainText("Reading scanned pages");
  await expect(panel.getByRole("heading", { name: "Submission notes", exact: true })).toBeVisible();
  await expect(panel).toContainText("Confirm the date against the selected source");
  await expect(panel.getByRole("button", { name: /Accept working checklist|Approve document|Complete/ })).toHaveCount(0);
  expect(state.calls.filter(call => call.path === base + "/jobs")).toHaveLength(0);
  expect(state.calls.filter(call => call.path.endsWith("/retry"))).toHaveLength(1); expect(state.pageErrors).toEqual([]);
});
test("native preparation cannot start after an account switch and removes the prior owner's work", async ({ page }) => {
  const state = await installNativeFixture(page, { resolve(call) { if (call.path === base) return prepSnapshot("attorney", { preparation: null }); } });
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/work");
  await expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
  const panel = page.locator("[data-native-preparation]"); await expect(start(panel)).toBeEnabled();
  state.user = { ...state.user, id: PARA, _id: PARA };
  await start(panel).click();
  await expect(page).toHaveURL(/\/login\.html/);
  await expect(page.locator("[data-native-preparation]")).toHaveCount(0);
  expect(state.calls.filter(call => call.path.endsWith("/jobs"))).toHaveLength(0);
});
test("a newer preparation retains earlier local checklist text until the attorney explicitly chooses to review it", async ({ page }) => {
  let newer = false;
  const old = preparation({ files: [{ id: FILE, name: "Discovery instructions.docx", version: 1, sectionsRead: 3, totalSections: 3, unreadablePages: [], readingMethod: "text" }] });
  const latest = preparation({ id: "b123456789abcdef01234567", items: [{ title: "Review the newly selected chronology", citations: old.items[0].citations }], files: old.files });
  const state = await installNativeFixture(page, { resolve(call) { if (call.path === base) return prepSnapshot("attorney", { preparation: newer ? latest : old }); } });
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/work");
  const panel = page.locator('[data-native-preparation][data-mode="preparation"]');
  await expect(panel.getByLabel("Working checklist item 1", { exact: true })).toHaveValue("Prepare discovery responses");
  await shot(page, "native-work-entry-desktop");
  const entry = page.locator("[data-native-preparation-entry]");
  await expect(entry).toBeVisible(); await entry.focus(); await page.keyboard.press("Enter");
  await expect(panel).toBeFocused();
  const position = await panel.boundingBox(); expect(position.y).toBeGreaterThanOrEqual(48);
  expect(new URL(page.url()).hash).toBe("#/matters/" + MATTER + "/work");
  await chooseDocument(panel); await panel.getByText("Select documents · 1 selected", { exact: true }).click();
  await panel.getByText("View source", { exact: true }).click();
  await panel.getByRole("heading", { name: "Turn the brief into a clear next step", exact: true }).click();
  await shot(page, "native-preparation-clean-desktop");
  await page.setViewportSize({ width: 390, height: 844 }); await entry.focus(); await page.keyboard.press("Enter"); await panel.getByRole("heading", { name: "Turn the brief into a clear next step", exact: true }).click(); await shot(page, "native-preparation-clean-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByLabel("Working checklist item 1", { exact: true }).fill("Retained attorney checklist draft");
  await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Files", exact: true }).click();
  newer = true; await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true }).click();
  await expect(panel).toContainText("Your earlier checklist edits"); await expect(panel).toContainText("Retained attorney checklist draft");
  await expect(panel.getByLabel("Working checklist item 1")).toHaveCount(0);
  await panel.getByRole("button", { name: "Review latest preparation", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Review latest preparation", exact: true });
  await guard.getByRole("button", { name: "Keep my edits", exact: true }).click(); await expect(panel).toContainText("Retained attorney checklist draft");
  await panel.getByRole("button", { name: "Review latest preparation", exact: true }).click(); await guard.getByRole("button", { name: "Review latest", exact: true }).click();
  await expect(panel.getByLabel("Working checklist item 1", { exact: true })).toHaveValue("Review the newly selected chronology");
  expect(state.calls.filter(call => call.path.endsWith("/accept"))).toEqual([]); expect(state.pageErrors).toEqual([]);
});
test("a running replacement preparation prevents editing an older checklist until the new result is ready", async ({ page }) => {
  let complete = false, running = false;
  const state = await installNativeFixture(page, { resolve(call) {
    if (call.path === base) return prepSnapshot("attorney", { preparation: complete ? preparation({ id: "b123456789abcdef01234567", items: [{ title: "Latest prepared chronology", citations: preparation().items[0].citations }] }) : preparation(), activeJob: running && !complete ? { id: JOB, kind: "preparation", status: "running", stage: "analyzing", processedFiles: 1, totalFiles: 1 } : null });
    if (call.path === base + "/jobs") { running = true; return { statusCode: 202, body: { job: { id: JOB, kind: "preparation", status: "running", stage: "analyzing", processedFiles: 1, totalFiles: 1 } } }; }
    if (call.path === base + "/jobs/" + JOB) { complete = true; return { job: { id: JOB, kind: "preparation", status: "complete", stage: "complete", preparationId: "b123456789abcdef01234567", processedFiles: 1, totalFiles: 1 } }; }
  } });
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/work");
  const panel = page.locator("[data-native-preparation]"); await start(panel).click();
  await expect(panel).toContainText("Preparing source-linked suggestions");
  await expect(panel.getByLabel("Working checklist item 1")).toHaveCount(0); await expect(panel.getByRole("button", { name: "Add working item" })).toHaveCount(0);
  await expect(panel.getByLabel("Working checklist item 1", { exact: true })).toHaveValue("Latest prepared chronology");
  expect(state.calls.filter(call => call.path.endsWith("/accept"))).toEqual([]); expect(state.pageErrors).toEqual([]);
});
