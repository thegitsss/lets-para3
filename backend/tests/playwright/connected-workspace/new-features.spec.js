"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("playwright/test");
const OWNER = "0123456789abcdef01234567", MATTER = "1123456789abcdef01234567", FILE = "2123456789abcdef01234567", PLAN = "3123456789abcdef01234567", DRAFT = "4123456789abcdef01234567";
const INERT = '<img src=x onerror="document.body.dataset.injected=1">';
const preparationPath = "/api/matter-preparation/matters/" + MATTER;
const clioPath = "/api/integrations/clio";
const screenshotDirectory = process.env.LPC_CONNECTED_SCREENSHOTS || path.resolve(__dirname, "../../../test-results/connected-workspace/screenshots");
fs.mkdirSync(screenshotDirectory, { recursive: true, mode: 0o700 });
function plan(patch = {}) {
  return { id: PLAN, kind: "preparation", status: "proposed", revision: 0, stale: false, items: [{ title: "Prepare the chronology", citations: [{ sourceId: "scope", name: "Agreed Matter instructions", quote: INERT, fileId: null, version: null, page: null, section: null }] }], questions: [], observations: [], files: [{ id: FILE, name: "Transaction.docx", version: 1, unreadablePages: [] }], coverageNotice: "Only selected readable text was reviewed.", ...patch };
}
function snapshot(role = "attorney", patch = {}) {
  return { caseId: MATTER, title: "River Street chronology", role, aiConfigured: true, files: [{ id: FILE, name: "Transaction.docx", version: 1, size: 2000, securityStatus: "clean", status: "pending_review" }], preparation: plan(), submission: null, ...patch };
}
async function fixtures(page, resolver, { role = "attorney", editorScript = false } = {}) {
  const calls = [], unexpected = [], pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === "https://editor.synthetic.test" && url.pathname === "/web-apps/apps/api/documents/api.js" && editorScript) {
      await route.fulfill({ contentType: "text/javascript", body: "window.DocsAPI={DocEditor:class{constructor(id,config){document.getElementById(id).textContent='Synthetic editor test fixture';this.config=config;config.events.onDocumentReady();}destroyEditor(){document.getElementById('cw-document-editor')?.replaceChildren();}}};" }); return;
    }
    if (url.origin !== "http://127.0.0.1:19076") { await route.abort("blockedbyclient"); return; }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    let body = null;
    try { body = request.postDataJSON(); } catch { /* GET requests have no body. */ }
    const call = { method: request.method(), path: url.pathname, query: url.searchParams, body };
    calls.push(call);
    if (url.pathname === "/api/auth/me") { await route.fulfill({ json: { user: { id: OWNER, role, status: "approved" } } }); return; }
    if (url.pathname === "/api/csrf") { await route.fulfill({ json: { csrfToken: "synthetic-csrf-token" } }); return; }
    const response = await resolver(call);
    if (!response) {
      unexpected.push(request.method() + " " + url.pathname);
      await route.fulfill({ status: 500, json: { error: "Unexpected synthetic API request" } }); return;
    }
    await route.fulfill({ status: response.status || 200, json: response.body || response });
  });
  return { calls, unexpected, pageErrors };
}
const pageUrl = "/matter-tools.html?caseId=" + MATTER;
test("attorney preparation renders source text inertly and accepts an explicitly reviewed checklist", async ({ page }) => {
  let value = snapshot();
  const state = await fixtures(page, call => {
    if (call.path === preparationPath) return value;
    if (call.path === preparationPath + "/accept") { value = snapshot("attorney", { preparation: plan({ status: "accepted", items: [{ ...plan().items[0], title: call.body.items[0], editedByAttorney: true }] }) }); return { preparation: value.preparation }; }
  });
  await page.goto(pageUrl);
  await expect(page.getByRole("heading", { name: "River Street chronology" })).toBeVisible();
  await page.getByText("Agreed Matter instructions", { exact: true }).click();
  await expect(page.locator("blockquote").first()).toHaveText(INERT);
  await expect(page.locator("blockquote img")).toHaveCount(0);
  expect(await page.locator("body").getAttribute("data-injected")).toBeNull();
  await page.getByLabel("Working checklist item 1").fill("Chronology for counsel review");
  await page.getByRole("button", { name: "Accept working checklist" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Accepted by attorney", { exact: true })).toBeVisible();
  expect(state.calls.find(call => call.path.endsWith("/accept")).body).toEqual({ preparationId: PLAN, revision: 0, items: ["Chronology for counsel review"], confirmed: true });
  expect(state.unexpected).toEqual([]); expect(state.pageErrors).toEqual([]);
  await page.screenshot({ path: path.join(screenshotDirectory, "matter-preparation-desktop.png"), fullPage: true });
});
test("a paralegal can inspect suggestions without an attorney acceptance control", async ({ page }) => {
  const state = await fixtures(page, call => call.path === preparationPath ? snapshot("paralegal") : null, { role: "paralegal" });
  await page.goto(pageUrl);
  await expect(page.getByText("Prepare the chronology", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept working checklist" })).toHaveCount(0);
  await expect(page.getByLabel("Working checklist item 1")).toHaveCount(0);
  await expect(page.locator("[data-return]")).toHaveAttribute("href", "/paralegal-v2.html#/matter/" + MATTER + "?tab=work");
  expect(state.unexpected).toEqual([]);
});
test("missing preparation connection is honest and a failed generation retains selected documents", async ({ page }) => {
  let configured = false;
  const state = await fixtures(page, call => {
    if (call.path === preparationPath) return snapshot("attorney", { aiConfigured: configured, preparation: null });
    if (call.path.endsWith("/generate")) return { status: 503, body: { error: "The synthetic preparation service is unavailable." } };
  });
  await page.goto(pageUrl);
  await expect(page.getByRole("button", { name: "Prepare workspace" })).toBeDisabled();
  await expect(page.getByText(/Document preparation is awaiting connection/)).toBeVisible();
  configured = true; await page.reload();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Prepare workspace" }).click();
  await expect(page.getByRole("status").first()).toContainText("synthetic preparation service is unavailable");
  await expect(page.getByRole("checkbox")).toBeChecked();
  await expect(page.getByRole("button", { name: "Prepare workspace" })).toBeEnabled();
  expect(state.calls.find(call => call.path.endsWith("/generate")).body.fileIds).toEqual([FILE]);
  expect(state.unexpected).toEqual([]);
});
test("matching preserves the request and filters after failure, then displays literal profile evidence", async ({ page }) => {
  let fail = true;
  const state = await fixtures(page, call => {
    if (call.path !== "/api/paralegal-matching/search") return null;
    if (fail) return { status: 503, body: { error: "Synthetic search unavailable" } };
    return { totalShown: 1, mode: "profile_evidence", requirementsNotice: "Recommendations do not hire anyone.", note: "", items: [{ id: FILE, name: "Morgan Ellis", availability: "Available now", yearsExperience: 6, location: "Virginia", matchBasis: "Relevant statements in the saved profile", evidence: [{ field: "About", text: INERT, evidenceType: "self_reported" }], requirements: [], availabilityNote: "Self-reported; confirm before engaging.", profileHref: "/attorney-v2.html#/paralegals/" + FILE }] };
  });
  await page.goto("/paralegal-match.html?caseId=" + MATTER);
  const query = page.getByLabel("Describe the work");
  await query.fill("Prepare discovery responses with Clio.");
  await query.focus(); await page.keyboard.press("Tab");
  await expect(page.getByLabel("Minimum years of experience")).toBeFocused();
  await page.getByLabel("Minimum years of experience").fill("5");
  await page.getByLabel("Required profile skills (optional)").fill("Clio, Discovery");
  await page.getByLabel("Show currently available profiles").check();
  await page.getByRole("button", { name: "Find relevant paralegals" }).click();
  await expect(page.getByRole("alert")).toContainText("Search was not completed");
  await expect(query).toHaveValue("Prepare discovery responses with Clio.");
  await expect(page.getByLabel("Minimum years of experience")).toHaveValue("5");
  await expect(page.getByLabel("Required profile skills (optional)")).toHaveValue("Clio, Discovery");
  await expect(page.getByLabel("Show currently available profiles")).toBeChecked();
  fail = false; await page.getByRole("button", { name: "Find relevant paralegals" }).click();
  await expect(page.getByRole("heading", { name: "Morgan Ellis" })).toBeVisible();
  await expect(page.locator("blockquote")).toHaveText(INERT);
  await expect(page.locator("blockquote img")).toHaveCount(0);
  const search = state.calls.filter(call => call.path === "/api/paralegal-matching/search").at(-1);
  expect(search.body).toMatchObject({ minimumYears: 5, availableOnly: true, requiredSkills: ["Clio", "Discovery"], caseId: MATTER });
  expect(state.unexpected).toEqual([]); expect(state.pageErrors).toEqual([]);
});
test("Clio handoff requires selected source IDs and exposes only a verified private draft destination", async ({ page }) => {
  const state = await fixtures(page, call => {
    if (call.path === clioPath + "/status") return { configured: true, connected: true, connectionRevision: "synthetic-connection-revision", region: "US" };
    if (call.path === clioPath + "/matters") return { items: [{ id: "123", label: "SYN-123 · River Street" }], nextCursor: null };
    if (call.path === clioPath + "/matters/123/documents") return { items: [{ id: "21", name: "Source.txt", ready: true }], nextCursor: null };
    if (call.path === clioPath + "/handoffs") return { draftId: DRAFT, handoffId: PLAN, href: "/attorney-v2.html#/matters/new?draftId=" + DRAFT };
  });
  await page.goto("/clio-connect.html");
  await page.getByRole("button", { name: "SYN-123 · River Street", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Prepare private LPC handoff" }).click();
  await expect(page.getByRole("link", { name: "Open LPC posting draft" })).toHaveAttribute("href", "/attorney-v2.html#/matters/new?draftId=" + DRAFT);
  await expect(page.getByText(/confidential Clio details stay private/i)).toBeVisible();
  const handoff = state.calls.find(call => call.path === clioPath + "/handoffs");
  expect(handoff.body).toMatchObject({ clioMatterId: "123", documentIds: ["21"], confirmed: true, expectedOwnerId: OWNER, expectedConnectionRevision: "synthetic-connection-revision" });
  expect(handoff.body).not.toHaveProperty("description");
  expect(state.unexpected).toEqual([]); expect(state.pageErrors).toEqual([]);
});
test("unconfigured Clio and document editing never display a fake successful connection", async ({ page }) => {
  const state = await fixtures(page, call => {
    if (call.path === clioPath + "/status") return { configured: false, connected: false, region: "US" };
    if (call.path === "/api/document-collaboration/status") return { configured: false };
  });
  await page.goto("/clio-connect.html");
  await expect(page.getByText(/Clio connection is awaiting setup/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Clio", exact: true })).toHaveCount(0);
  await page.goto("/document-editor.html?caseId=" + MATTER + "&fileId=" + FILE);
  await expect(page.getByRole("status").first()).toContainText("awaiting connection");
  await expect(page.locator("#cw-document-editor, iframe")).toHaveCount(0);
  expect(state.calls.some(call => call.path.endsWith("/session"))).toBe(false);
  expect(state.unexpected).toEqual([]);
});
test("an editor session failure leaves an explicit recovery without loading third-party code", async ({ page }) => {
  const state = await fixtures(page, call => {
    if (call.path === "/api/document-collaboration/status") return { configured: true };
    if (call.path.endsWith("/session")) return { status: 503, body: { error: "Synthetic document connection unavailable" } };
  });
  await page.goto("/document-editor.html?caseId=" + MATTER + "&fileId=" + FILE);
  await expect(page.getByRole("heading", { name: "This workspace could not open" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Synthetic document connection unavailable");
  await expect(page.locator('script[src^="https://editor."]')).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
});
test("the configured editor initializes only from the session response with a tests-only provider fixture", async ({ page }) => {
  const state = await fixtures(page, call => {
    if (call.path === "/api/document-collaboration/status") return { configured: true };
    if (call.path.endsWith("/session")) return { sessionId: PLAN, scriptUrl: "https://editor.synthetic.test/web-apps/apps/api/documents/api.js", config: { document: { key: "synthetic-key", title: "Synthetic.docx" }, editorConfig: {} } };
    if (call.path.startsWith("/api/document-collaboration/sessions/")) return { state: "open", message: "Synthetic session open" };
  }, { editorScript: true });
  await page.goto("/document-editor.html?caseId=" + MATTER + "&fileId=" + FILE);
  await expect(page.locator("#cw-document-editor")).toHaveText("Synthetic editor test fixture");
  await expect(page.getByRole("status").first()).toContainText("Document ready");
  expect(state.calls.find(call => call.path.endsWith("/session")).body).toEqual({ expectedOwnerId: OWNER });
  expect(state.unexpected).toEqual([]); expect(state.pageErrors).toEqual([]);
});
test("all four workspaces fit a narrow viewport and retain keyboard navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtures(page, call => {
    if (call.path === preparationPath) return snapshot();
    if (call.path === clioPath + "/status") return { configured: false, connected: false, region: "US" };
    if (call.path === "/api/document-collaboration/status") return { configured: false };
  });
  for (const url of [pageUrl, "/paralegal-match.html", "/clio-connect.html", "/document-editor.html?caseId=" + MATTER + "&fileId=" + FILE]) {
    await page.goto(url);
    await expect(page.locator("main h1")).toBeVisible();
    await expect.poll(() => page.locator("body").innerText()).not.toContain("Checking your workspace");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  }
  await page.goto("/paralegal-match.html");
  await expect(page.getByLabel("Describe the work")).toBeVisible();
  await page.getByLabel("Describe the work").fill("Discovery responses and Clio experience");
  await page.screenshot({ path: path.join(screenshotDirectory, "paralegal-matching-mobile.png"), fullPage: true });
});
