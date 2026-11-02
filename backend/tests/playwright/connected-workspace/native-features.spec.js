"use strict";
const { test, expect } = require("playwright/test");
const fs = require("node:fs"), path = require("node:path");
const { installNativeFixture, gotoNative, MATTER, OWNER, PARA, PLAN, DRAFT, revision } = require("./native-fixture.cjs");
const clioBase = "/api/integrations/clio";
const syntheticQuote = '<img src=x onerror="window.syntheticQuoteExecuted=true"> A source passage for review.';
const connection = { configured: true, connected: true, ownerId: OWNER, connectionRevision: "synthetic-current-connection", needsReconnect: false, region: "us" };
const clioMatter = { id: "123", label: "PRIVATE Synthetic matter 2026-42", description: "Synthetic private client instructions" };
const clioDocument = { id: "21", name: "Synthetic source instructions.pdf", size: 2500, versionId: "31", versionUuid: "synthetic-source-version", ready: true };
async function screenshot(page, name) {
  if (!process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS) return;
  fs.mkdirSync(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.LPC_CONNECTED_NATIVE_SCREENSHOTS, name + ".png"), fullPage: true });
}
function assertNoMoneyWrites(state) { expect(state.calls.filter(call => call.method !== "GET" && /^\/api\/(?:payments|cases\/[^/]+\/(?:scope|completion|work-review|posting))/.test(call.path))).toEqual([]); }
function clioBrowse(call) {
  if (call.path === clioBase + "/status") return connection;
  if (call.path === clioBase + "/matters") return { items: [clioMatter], nextCursor: null };
  if (call.path === clioBase + "/matters/123/documents") return { items: [clioDocument], nextCursor: null };
}
test("native fixture opens the actual attorney Work shell without tool-page navigation", async ({ page }) => {
  const state = await installNativeFixture(page);
  await gotoNative(page, "/attorney-v2.html#/matters/" + MATTER + "/work");
  await expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
  await expect(page.locator("[data-matter-workspace]")).toHaveAttribute("data-state", "ready");
  await expect(page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true })).toHaveAttribute("aria-current", "page");
  expect(new URL(page.url()).pathname).toBe("/attorney-v2.html");
  expect(state.pageErrors).toEqual([]);
});

test("native matching keeps filters through a provider failure and a full profile round trip", async ({ page }) => {
  let searches = 0;
  const state = await installNativeFixture(page, { resolve(call) {
    if (call.path === "/api/paralegal-matching/search") {
      searches++;
      if (searches === 1) return { statusCode: 503, body: { error: "Synthetic search provider is temporarily unavailable" } };
      return { mode: "lexical", items: [{ id: PARA, name: "Morgan Ellis", location: "Virginia", yearsExperience: 6, availability: "available", evidence: [{ field: "bio", text: syntheticQuote, evidenceType: "self_reported" }], requirements: [{ state: "confirmation_required", text: "Confirm court filing experience" }] }], note: "Based on approved public profile information." };
    }
  } });
  await gotoNative(page, "/attorney-v2.html#/paralegals?match=work&caseId=" + MATTER);
  await expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
  const panel = page.locator("[data-native-matching]");
  await panel.getByLabel("Work description", { exact: true }).fill("Prepare a chronology and organize discovery records");
  await panel.getByText("Refine requirements", { exact: true }).click();
  await panel.getByLabel("Minimum years of experience").fill("4");
  await panel.getByLabel("Required skills", { exact: true }).fill("Clio, Discovery");
  await panel.getByLabel("Available paralegals only").check();
  await panel.getByRole("button", { name: "Find relevant experience", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(panel.getByLabel("Work description", { exact: true })).toHaveValue("Prepare a chronology and organize discovery records");
  await expect(panel.getByLabel("Required skills", { exact: true })).toHaveValue("Clio, Discovery");
  await panel.getByRole("button", { name: "Try this search again" }).click();
  await expect(panel.getByRole("heading", { name: "Experience to consider" })).toBeVisible();
  await panel.getByText("Why this profile appeared", { exact: true }).click();
  await expect(panel).toContainText(syntheticQuote); expect(await panel.locator(".lpc-connected-match-evidence img").count()).toBe(0);
  expect(await page.evaluate(() => window.syntheticQuoteExecuted)).toBeUndefined();
  await expect(panel).toContainText("Confirm court filing experience");
  await screenshot(page, "native-matching-desktop");
  await panel.getByRole("link", { name: "View profile →" }).click();
  await expect(page.getByRole("heading", { name: "Morgan Ellis", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "← Back to results", exact: true }).click();
  await expect(page.locator("[data-native-matching]").getByLabel("Work description", { exact: true })).toHaveValue("Prepare a chronology and organize discovery records");
  await expect(page.locator("[data-native-matching]").getByRole("heading", { name: "Experience to consider" })).toBeVisible();
  const submitted = state.calls.filter(call => call.path === "/api/paralegal-matching/search");
  expect(submitted).toHaveLength(3); expect(submitted.map(call => call.body)).toEqual(new Array(3).fill({ query: "Prepare a chronology and organize discovery records", minimumYears: 4, requiredSkills: ["Clio", "Discovery"], availableOnly: true, caseId: MATTER }));
  expect(new URL(page.url()).pathname).toBe("/attorney-v2.html"); expect(state.pageErrors).toEqual([]); assertNoMoneyWrites(state);
});

test("native matching is usable by keyboard on a narrow screen with an honest empty state", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await installNativeFixture(page, { resolve(call) { if (call.path === "/api/paralegal-matching/search") return { items: [] }; } });
  await gotoNative(page, "/attorney-v2.html#/paralegals?match=work");
  await expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
  const panel = page.locator("[data-native-matching]");
  await panel.getByLabel("Work description", { exact: true }).fill("Prepare a discovery chronology");
  await panel.getByRole("button", { name: "Find relevant experience" }).focus(); await page.keyboard.press("Enter");
  await expect(panel.getByRole("heading", { name: "No profiles match these requirements" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "View profile →" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await screenshot(page, "native-matching-mobile");
  expect(state.pageErrors).toEqual([]);
});

test("native Clio connection recovers from missing provider configuration inside Settings", async ({ page }) => {
  let connected = false;
  const state = await installNativeFixture(page, { resolve(call) { if (call.path === clioBase + "/status") return connected ? connection : { configured: false, connected: false, ownerId: OWNER }; } });
  await gotoNative(page, "/attorney-v2.html#/settings?tab=connections");
  const card = page.locator("[data-native-clio-connection]");
  await expect(card).toContainText("Clio connections are not available yet");
  await expect(card.getByRole("button", { name: "Start from Clio", exact: true })).toHaveCount(0);
  connected = true; await card.getByRole("button", { name: "Refresh connection" }).click();
  await expect(card.getByRole("button", { name: "Start from Clio", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/attorney-v2.html"); expect(state.pageErrors).toEqual([]);
});

test("native Clio handoff requires an authored public brief and preserves reviewed selection through a failed acknowledgement", async ({ page }) => {
  let handoffAttempts = 0, savedBrief;
  const state = await installNativeFixture(page, { resolve(call) {
    const browsed = clioBrowse(call); if (browsed) return browsed;
    if (call.path === clioBase + "/handoffs" && call.method === "POST") {
      handoffAttempts++; savedBrief = call.body.publicWorkBrief;
      if (handoffAttempts === 1) return { statusCode: 503, body: { error: "Synthetic acknowledgement unavailable; review is retained" } };
      return { handoffId: PLAN, draftId: DRAFT, href: "/attorney-v2.html#/matters/new?draftId=" + DRAFT };
    }
    if (call.path === "/api/case-drafts/" + DRAFT) return { draft: { id: DRAFT, revision, rawTitle: savedBrief.title, title: savedBrief.title, description: savedBrief.description, tasks: savedBrief.tasks.map(title => ({ title })), practiceArea: "", state: "", experience: "", deadline: "", compAmount: "", publishedCaseId: null } };
    if (call.path === "/api/cases/posting/drafts/" + DRAFT) return { statusCode: 404, body: { error: "Synthetic draft has not been published" } };
    if (call.path === "/api/cases/posting/options") return { practiceAreas: ["litigation"] };
  } });
  await gotoNative(page, "/attorney-v2.html#/settings?tab=connections");
  await page.locator("[data-native-clio-connection]").getByRole("button", { name: "Start from Clio", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start from Clio", exact: true });
  await dialog.locator('[data-clio-matter-choice="123"]').click();
  await expect(dialog.getByLabel("Work title", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Work description", { exact: true })).toHaveValue("");
  await dialog.locator('[data-clio-document-choice="21"]').check();
  await dialog.getByLabel("Work title", { exact: true }).fill("Discovery chronology support");
  await dialog.getByLabel("Work description", { exact: true }).fill("Prepare a chronology from selected discovery records for attorney review.");
  await dialog.getByLabel("Deliverables · one per line").fill("Chronology for attorney review");
  await dialog.getByRole("button", { name: "Close start from clio", exact: true }).click();
  await page.locator("[data-native-clio-connection]").getByRole("button", { name: "Start from Clio", exact: true }).click();
  await expect(dialog.getByLabel("Work title", { exact: true })).toHaveValue("Discovery chronology support");
  await expect(dialog.locator('[data-clio-document-choice="21"]')).toBeChecked();
  await dialog.getByRole("button", { name: "Review selection" }).click();
  await expect(dialog).toContainText("Public work title"); await expect(dialog).toContainText("1 document selected");
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog.getByLabel("Work title", { exact: true })).toHaveValue("Discovery chronology support");
  await expect(dialog.locator('[data-clio-document-choice="21"]')).toBeChecked();
  await dialog.getByRole("button", { name: "Review selection" }).click();
  await screenshot(page, "native-clio-review-desktop");
  await dialog.getByRole("button", { name: "Continue to posting" }).click();
  await expect(dialog).toContainText("acknowledgement unavailable");
  await expect(dialog.getByRole("button", { name: "Continue to posting" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Continue to posting" }).click();
  const posting = page.getByRole("dialog", { name: "New Matter", exact: true });
  await expect(posting.getByLabel("Title", { exact: true })).toHaveValue("Discovery chronology support");
  await expect(posting.getByLabel("Title", { exact: true })).toBeEnabled();
  await expect(posting.getByLabel("Scope", { exact: true })).toHaveValue("Prepare a chronology from selected discovery records for attorney review.");
  expect(new URL(page.url()).pathname).toBe("/attorney-v2.html");
  const writes = state.calls.filter(call => call.path === clioBase + "/handoffs" && call.method === "POST");
  expect(writes).toHaveLength(2); expect(writes[0].body).toEqual(writes[1].body);
  expect(writes[0].body).toMatchObject({ clioMatterId: "123", documentIds: ["21"], expectedOwnerId: OWNER, expectedConnectionRevision: connection.connectionRevision, publicBriefConfirmed: true, confirmed: true, expectedDocuments: [{ id: "21", versionId: "31", versionUuid: clioDocument.versionUuid }], publicWorkBrief: { title: "Discovery chronology support", description: "Prepare a chronology from selected discovery records for attorney review.", tasks: ["Chronology for attorney review"] } });
  expect(JSON.stringify(writes[0].body.publicWorkBrief)).not.toContain("PRIVATE");
  expect(state.calls.filter(call => call.path.endsWith("/publish") || /\/payments\//.test(call.path) && call.method !== "GET")).toEqual([]); expect(state.pageErrors).toEqual([]);
});
test("native fixture opens the assigned paralegal Work shell without tool-page navigation", async ({ page }) => {
  const state = await installNativeFixture(page, { role: "paralegal" });
  await gotoNative(page, "/paralegal-v2.html#/matter/" + MATTER + "?tab=work");
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.getByRole("heading", { name: "River Street discovery review", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/paralegal-v2.html");
  expect(state.pageErrors).toEqual([]);
});
