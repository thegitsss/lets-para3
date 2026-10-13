const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const root = page => page.locator("[data-workspace-disputes]"), id = n => n.toString(16).padStart(24, "0");
const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const discussion = (n, count = 0) => ({ id: `earlier-dispute:${n}`, status: "resolved", message: `Exhibit disagreement ${n}`, raisedBy: { id: id(100), name: "Priya Ng" }, createdAt: null, updatedAt: null, requestedAmount: null, commentCount: count, revision: "c".repeat(64), canComment: true, comments: Array.from({ length: count }, (_, i) => ({ id: id(n * 100 + i + 1), by: { id: id(100), name: "Priya Ng" }, text: `Exhibit ${n} comment ${i + 1}`, createdAt: null })), decision: null });
async function fixture(page, { records = [], query = "" } = {}) {
  await page.addInitScript(() => { const Native = window.EventSource; window.syntheticDisputeStreams = []; window.EventSource = class extends Native { constructor(url, options) { super(url, options); if (/\/api\/cases\//.test(String(url))) window.syntheticDisputeStreams.push(this); } }; });
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id, csrf = (await (await page.request.get("/api/csrf")).json()).csrfToken;
  const send = async (path, data) => { const response = await page.request.post(path, { headers: { "X-CSRF-Token": csrf }, data: { ...data, expectedOwnerId: ownerId } }); expect(response.ok(), await response.text()).toBeTruthy(); return response.json(); };
  const draft = (await send("/api/case-drafts", { title: "River Street lease review", practiceArea: "Contract Law", state: "New York", compAmount: "1000.00", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and organize its exhibits.", tasks: [{ title: "Review the lease" }] })).draft;
  const published = await send("/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" }), caseId = published.publication.caseId;
  const state = { reads: [], writes: [], status: 200, writeStatus: 200, outcomes: {}, records, revision: "d".repeat(64), reason: "ready", title: "River Street lease review" };
  state.record = body => {
    let target;
    if (body.action === "open") { target = { ...discussion(999), message: body.text, raisedBy: { id: ownerId, name: "Morgan Lee" }, status: "open" }; state.records.unshift(target); state.reason = "review_open"; }
    else { target = state.records.find(value => value.id === body.disputeId); target.comments.unshift({ id: id(99999), by: { id: ownerId, name: "Morgan Lee" }, text: body.text, createdAt: "2026-09-08T12:00:00.000Z" }); target.commentCount++; target.revision = "e".repeat(64); }
    state.revision = "e".repeat(64); const operation = { status: "recorded", action: body.action, disputeId: target.id, commentId: body.action === "comment" ? id(99999) : null, changedSinceSave: false }; state.outcomes[body.requestId] = operation; return operation;
  };
  await page.route(`**/api/disputes/${caseId}/attorney-review?**`, route => {
    const query = new URL(route.request().url()).searchParams; state.reads.push(Object.fromEntries(query)); const start = Number((query.get("cursor") || "page_0").split("_")[1]), commentStart = Number((query.get("commentCursor") || "comments_0").split("_")[1]);
    const target = query.has("disputeId") ? state.records.find(value => value.id === query.get("disputeId")) : state.records[0], linked = target?.comments.find(value => value.id === query.get("commentId"));
    const selected = target ? { ...target, comments: target.comments.slice(commentStart, commentStart + 25), nextCommentCursor: target.commentCount > commentStart + 25 ? `comments_${commentStart + 25}` : null, selectedComment: linked || null, commentSelection: query.has("commentId") ? linked ? "found" : "unavailable" : "none" } : null;
    return fulfill(route, state.status === 200 ? { ownerId, caseId, caseTitle: state.title, revision: state.revision, reason: state.reason, canOpen: state.reason === "ready", total: state.records.length, items: state.records.slice(start, start + 25), nextCursor: state.records.length > start + 25 ? `page_${start + 25}` : null, selection: query.has("disputeId") ? target ? "found" : "unavailable" : "automatic", selected, currency: "USD", operation: query.has("requestId") ? state.outcomes[query.get("requestId")] || { status: "not_found", disputeId: null, commentId: null, changedSinceSave: false } : null, adminNotes: "PRIVATE ADMIN NOTE" } : {}, state.status);
  });
  await page.route(`**/api/disputes/${caseId}/attorney-action`, route => { const body = route.request().postDataJSON(); state.writes.push(body); if (state.writeStatus === 0) { state.record(body); return route.abort("failed"); } if (state.writeStatus !== 200) return fulfill(route, {}, state.writeStatus); return fulfill(route, { ownerId, caseId, operation: state.record(body) }); });
  await page.goto(`/attorney-v2.html#/matters/${caseId}/financials${query}`, { waitUntil: "domcontentloaded" }); await expect(root(page)).toHaveAttribute("data-state", "ready"); return { state, caseId, ownerId };
}
const reveal = async page => { const entry = root(page).locator("[data-dispute-entry]"); if (await entry.getAttribute("open") === null) await entry.locator("summary").click(); };
const open = async page => { await reveal(page); await root(page).getByRole("textbox", { name: "Dispute details", exact: true }).fill("Exhibit B is missing from the delivered lease review."); await root(page).getByRole("button", { name: "Review dispute request", exact: true }).click(); };
for (const outcome of ["unchanged", "changed", "failed", "canceled"]) test(`dispute review survives a background read during its click: ${outcome}`, async ({ page }) => {
  const { state, caseId } = await fixture(page); await reveal(page);
  const draft = "Exhibit B is missing from the delivered lease review.";
  await root(page).getByRole("textbox", { name: "Dispute details", exact: true }).fill(draft);
  let arrived, release;
  const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/disputes/${caseId}/attorney-review?**`, async route => { arrived(); await gate; await route.fallback(); }, { times: 1 });
  await root(page).evaluate(section => section.querySelector("[data-dispute-entry] button").addEventListener("pointerdown", () => { void section.sync(); }, { once: true }));
  try {
    await root(page).getByRole("button", { name: "Review dispute request", exact: true }).click(); await waiting;
    await expect(root(page).locator("[data-dispute-confirmation]")).toBeVisible();
    await expect(root(page).getByRole("button", { name: "Open dispute review", exact: true })).toBeDisabled();
    expect(state.writes).toEqual([]);
    if (outcome === "changed") { state.revision = "e".repeat(64); state.reason = "paralegal_review_window"; }
    if (outcome === "failed") state.status = 503;
    if (outcome === "canceled") {
      await root(page).getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(root(page).getByRole("textbox", { name: "Dispute details", exact: true })).toBeFocused();
    }
    release();
    if (outcome === "unchanged") {
      await root(page).getByRole("button", { name: "Open dispute review", exact: true }).click();
      await expect(root(page)).toContainText("Dispute review opened.");
      expect(state.writes).toHaveLength(1); expect(state.writes[0]).toMatchObject({ action: "open", text: draft, reviewedRevision: "d".repeat(64) });
    } else {
      await expect(root(page).getByRole("button", { name: "Refresh dispute review", exact: true })).toBeEnabled();
      await expect(root(page).locator("[data-dispute-confirmation]")).toHaveCount(0);
      if (outcome === "changed") await expect(root(page)).toContainText("discussion or decision changed");
      if (outcome === "failed") await expect(root(page)).toHaveAttribute("data-state", "error");
      if (outcome === "canceled") await expect(root(page).getByRole("textbox", { name: "Dispute details", exact: true })).toHaveValue(draft);
      expect(state.writes).toEqual([]);
    }
  } finally { release(); }
});
test("opening a dispute requires actual details and review of its shared consequences", async ({ page }) => {
  const { state, ownerId } = await fixture(page); await expect(root(page).locator("[data-dispute-entry] summary")).toHaveText("Report a disagreement"); await expect(root(page)).not.toContainText("No dispute has been opened"); await expect(root(page).getByRole("textbox", { name: "Dispute details", exact: true })).toHaveCount(0); await reveal(page); await root(page).getByRole("button", { name: "Review dispute request", exact: true }).click(); await expect(root(page)).toContainText("Describe the disagreement before requesting review"); expect(state.writes).toEqual([]); await open(page); await expect(root(page).locator("[data-dispute-confirmation]")).toBeFocused(); await expect(root(page)).toContainText("does not automatically release or refund a payment"); await root(page).getByRole("button", { name: "Keep editing", exact: true }).click(); await expect(root(page).getByRole("textbox", { name: "Dispute details", exact: true })).toBeFocused(); expect(state.writes).toEqual([]);
  await open(page); await root(page).getByRole("button", { name: "Open dispute review", exact: true }).click(); await expect(root(page)).toContainText("Dispute review opened."); expect(state.writes).toHaveLength(1); expect(state.writes[0]).toMatchObject({ expectedOwnerId: ownerId, action: "open", text: "Exhibit B is missing from the delivered lease review.", reviewedRevision: "d".repeat(64) }); expect(state.writes[0].amountRequestedCents).toBeUndefined(); await expect(root(page)).not.toContainText("PRIVATE ADMIN NOTE");
});
test("history and discussion page separately and exact older comment links remain usable", async ({ page }) => {
  const records = Array.from({ length: 52 }, (_, i) => discussion(i + 1, 52)); const { state, caseId } = await fixture(page, { records, query: `?disputeId=earlier-dispute%3A1&commentId=${id(152)}` }); await expect(root(page)).toContainText("52 disputes recorded"); await expect(root(page)).toContainText("Discussion · 52 comments"); await expect(root(page)).toContainText("Linked earlier comment"); await expect(root(page).locator(`[data-dispute-comment="${id(152)}"]`)).toBeFocused(); await root(page).getByRole("button", { name: "Show earlier disputes" }).click(); await expect(root(page)).toContainText("Exhibit disagreement 50"); await root(page).getByRole("button", { name: "Show earlier comments" }).click(); await expect(root(page)).toContainText("Exhibit 1 comment 50"); expect(state.reads.at(-1).commentCursor).toBe("comments_25");
  await page.evaluate(() => window.syntheticDisputeStreams.at(-1).dispatchEvent(new MessageEvent("projection", { data: "{}" }))); await expect.poll(() => state.reads.length).toBeGreaterThan(3);
  await root(page).getByRole("button", { name: "Show earlier comments" }).click(); await expect(root(page).getByRole("button", { name: "Show earlier comments" })).toHaveCount(0); expect(state.reads.at(-1).commentCursor).toBe("comments_50"); await expect(root(page).locator(`[data-dispute-comment="${id(152)}"]`)).toHaveCount(1); await root(page).getByRole("button", { name: "Show earlier disputes" }).click(); await expect(root(page).getByRole("button", { name: "Show earlier disputes" })).toHaveCount(0); await expect(root(page).getByRole("link", { name: "Link to this dispute" })).toHaveAttribute("href", `#/matters/${caseId}/financials?disputeId=earlier-dispute%3A1`);
});
test("a lost opening response recovers the same saved request without another write", async ({ page }, testInfo) => {
  const { state } = await fixture(page); state.writeStatus = 0; await open(page); await root(page).getByRole("button", { name: "Open dispute review", exact: true }).click(); await expect(root(page)).toContainText("request could not be confirmed"); expect(state.writes).toHaveLength(1); await root(page).getByText("Your dispute details", { exact: true }).click(); await expect(root(page).locator(".av2-dispute-draft p")).toHaveText(state.writes[0].text); await expect(root(page)).not.toContainText("No dispute has been opened"); await root(page).screenshot({ path: testInfo.outputPath("pending-opening.png") }); await root(page).getByRole("button", { name: "Check saved dispute", exact: true }).click(); await expect(root(page)).toContainText("Dispute review opened."); expect(state.reads.at(-1).requestId).toBe(state.writes[0].requestId); expect(state.writes).toHaveLength(1);
});
test("an unrecorded outcome allows only an explicit retry of the same request", async ({ page }) => {
  const { state } = await fixture(page); state.writeStatus = 503; await open(page); await root(page).getByRole("button", { name: "Open dispute review", exact: true }).click(); await expect(root(page)).toContainText("request could not be confirmed"); await expect(root(page).getByRole("button", { name: "Check saved dispute", exact: true })).toBeFocused(); await root(page).getByRole("button", { name: "Check saved dispute", exact: true }).click(); await expect(root(page)).toContainText("no recorded outcome yet"); expect(state.writes).toHaveLength(1); state.writeStatus = 200; await root(page).getByRole("button", { name: "Try recording this request again" }).click(); await expect(root(page)).toContainText("Dispute review opened."); expect(state.writes).toHaveLength(2); expect(state.writes[0]).toEqual(state.writes[1]);
});
test("comments retain their exact earlier dispute and draft after a conflict and tab change", async ({ page }, testInfo) => {
  const { state } = await fixture(page, { records: [discussion(1)] });
  await expect(root(page).getByText("Exhibit disagreement 1", { exact: true })).toHaveCount(1); await expect(root(page).getByText("Resolved", { exact: true })).toHaveCount(1); await expect(root(page)).not.toContainText("1 dispute recorded"); await expect(root(page)).not.toContainText("0 comments"); await expect(root(page).getByText("No comments have been recorded.", { exact: true })).toHaveCount(1);
  state.writeStatus = 409; await root(page).getByRole("textbox", { name: "Add a comment", exact: true }).fill("Please review exhibit C alongside B."); await root(page).getByRole("button", { name: "Record comment", exact: true }).click(); await expect(root(page)).toContainText("Your text is retained"); await expect(root(page).getByRole("textbox", { name: "Add a comment", exact: true })).toHaveCount(0); await root(page).getByText("Your comment text", { exact: true }).click(); await expect(root(page).locator(".av2-dispute-draft p")).toHaveText("Please review exhibit C alongside B."); await root(page).screenshot({ path: testInfo.outputPath("retained-comment.png") }); await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Overview", exact: true }).click(); await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Financials", exact: true }).click(); await expect(root(page).getByRole("textbox", { name: "Add a comment", exact: true })).toHaveValue("Please review exhibit C alongside B."); state.writeStatus = 200; await root(page).getByRole("button", { name: "Record comment", exact: true }).click(); await expect(root(page)).toContainText("Comment recorded."); expect(state.writes.at(-1)).toMatchObject({ action: "comment", disputeId: "earlier-dispute:1", reviewedDisputeRevision: "c".repeat(64), text: "Please review exhibit C alongside B." }); await expect(root(page).getByRole("textbox", { name: "Add a comment", exact: true })).toHaveValue("");
});
test("a changed discussion disables an earlier confirmation until the attorney refreshes", async ({ page }, testInfo) => {
  const { state } = await fixture(page); await open(page); state.revision = "e".repeat(64); state.reason = "paralegal_review_window"; await page.evaluate(() => window.syntheticDisputeStreams.at(-1).dispatchEvent(new MessageEvent("projection", { data: "{}" }))); await expect(root(page)).toContainText("discussion or decision changed"); await expect(root(page)).not.toContainText("No dispute has been opened"); await expect(root(page).getByRole("button", { name: "Refresh dispute review", exact: true })).toBeFocused(); await expect(root(page).getByRole("textbox", { name: "Dispute details", exact: true })).toHaveCount(0); await root(page).getByText("Your dispute details", { exact: true }).click(); await expect(root(page).locator(".av2-dispute-draft p")).toHaveText("Exhibit B is missing from the delivered lease review."); const rechecked = page.waitForResponse(response => response.url().includes('/attorney-review?')); await page.evaluate(() => window.syntheticDisputeStreams.at(-1).dispatchEvent(new MessageEvent('projection', { data: '{}' }))); await rechecked; await expect(root(page).getByRole('button', { name: 'Refresh dispute review', exact: true })).toBeEnabled(); await expect(root(page).locator('.av2-dispute-draft')).toHaveAttribute('open', '');
  for (const theme of ['light', 'dark']) for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => { document.documentElement.style.fontSize = '20px'; for (const el of [document.documentElement, document.body]) { el.classList.remove('theme-light', 'theme-dark'); el.classList.add(`theme-${theme}`); } }, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('[data-workspace-disputes]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await root(page).screenshot({ path: testInfo.outputPath(`retained-opening-${theme}-${width}.png`) });
  }
  await expect(root(page).getByRole("button", { name: "Open dispute review", exact: true })).toHaveCount(0); await root(page).getByRole("button", { name: "Refresh dispute review", exact: true }).click(); await expect(root(page)).toContainText("withdrawn paralegal’s review window is open"); await expect(root(page).getByRole("textbox", { name: "Dispute details", exact: true })).toHaveCount(0); expect(state.writes).toEqual([]);
});
test("stopping a delayed comment keeps its request for a later read without another submission", async ({ page }) => {
  const { state, caseId } = await fixture(page, { records: [discussion(1)] }); let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/disputes/${caseId}/attorney-action`, async route => { const body = route.request().postDataJSON(); state.writes.push(body); state.record(body); arrived(); await gate; await fulfill(route, {}).catch(() => {}); });
  await root(page).getByRole("textbox", { name: "Add a comment", exact: true }).fill("Delayed exhibit reply"); await root(page).getByRole("button", { name: "Record comment", exact: true }).click(); try { await waiting; await root(page).getByRole("button", { name: "Stop waiting", exact: true }).focus(); await root(page).getByRole("button", { name: "Stop waiting", exact: true }).click(); await expect(root(page)).toContainText("request could not be confirmed"); await expect(root(page).getByRole("button", { name: "Check saved dispute", exact: true })).toBeFocused(); await root(page).getByRole("button", { name: "Check saved dispute", exact: true }).click(); await expect(root(page)).toContainText("Comment recorded."); expect(state.writes).toHaveLength(1); } finally { release(); }
});
test("an untouched discussion follows the recorded decision without retaining an obsolete open status", async ({ page }) => {
  const { state } = await fixture(page, { records: [{ ...discussion(1), status: "open" }] });
  state.reason = "review_open";
  await root(page).getByRole("button", { name: "Refresh dispute review", exact: true }).click();
  state.records[0] = { ...state.records[0], status: "resolved", revision: "e".repeat(64), decision: { action: "refund", grossCents: 40000, payoutCents: 0, refundCents: 48800, at: null } };
  state.reason = "funded_work_required"; state.revision = "f".repeat(64);
  await root(page).evaluate(element => element.sync());
  await expect(root(page).getByText("Resolved", { exact: true })).toHaveCount(1);
  await expect(root(page)).toContainText("Recorded administrator decision");
  await expect(root(page)).toContainText("Refund in the decision: $488.00");
  await expect(root(page)).not.toContainText("Administrator review open");
  await expect(root(page)).not.toContainText("Refresh it to read the current record");
  expect(state.writes).toEqual([]);
});
test("background discussion reads preserve a focused draft and fence a changed review", async ({ page }) => {
  const { state } = await fixture(page, { records: [discussion(1)] });
  const comment = root(page).getByRole("textbox", { name: "Add a comment", exact: true });
  const text = "Please include the missing exhibit in the review.";
  await comment.fill(text);
  await root(page).evaluate(element => element.sync());
  await expect(comment).toBeFocused(); await expect(comment).toHaveValue(text);
  state.revision = "e".repeat(64);
  await root(page).evaluate(element => element.sync());
  await expect(root(page)).toContainText("discussion or decision changed");
  await expect(root(page).getByRole("button", { name: "Refresh dispute review", exact: true })).toBeFocused();
  await expect(comment).toHaveCount(0);
  await root(page).getByText("Your comment text", { exact: true }).click();
  await expect(root(page).locator(".av2-dispute-draft p")).toHaveText(text);
  expect(state.writes).toEqual([]);
});
test("missing links, unavailable reads and administrator decisions show their actual limits", async ({ page }) => {
  const record = discussion(1); record.requestedAmount = 10000; record.decision = { action: "release_partial", grossCents: 100000, payoutCents: 50000, refundCents: 39000, at: null }; const { state, caseId } = await fixture(page, { records: [record] }); await expect(root(page)).toContainText("This is a request, not a recorded payment"); await expect(root(page)).toContainText("does not by itself confirm a completed transfer or refund"); await expect(root(page).getByRole("link", { name: "Review Matter receipt" })).toHaveAttribute("href", `#/matters/${caseId}/receipt`); await page.evaluate(value => { location.hash = `#/matters/${value}/financials?disputeId=missing-legacy`; }, caseId); await expect(root(page)).toContainText("linked dispute is no longer available"); state.status = 503; await root(page).getByRole("button", { name: "Refresh dispute review", exact: true }).click(); await expect(root(page)).toHaveAttribute("data-state", "error"); await expect(root(page)).not.toContainText("No dispute has been opened"); await expect(root(page).getByRole("textbox")).toHaveCount(0);
});
test("account changes clear private dispute details before a request can be sent", async ({ page }) => {
  const { state } = await fixture(page); await open(page); await page.route("**/api/auth/me", route => fulfill(route, { user: { id: id(777), role: "attorney", status: "approved" } })); await root(page).getByRole("button", { name: "Open dispute review", exact: true }).click(); await expect(root(page)).toHaveCount(0); expect(state.writes).toEqual([]);
});
test("long dispute text and review controls remain accessible at phone and desktop widths", async ({ page }, testInfo) => {
  const record = discussion(1, 2); record.message = '<img src=x onerror="window.disputeXss=true"> Lease exhibits for River Street '.repeat(3); const { state } = await fixture(page, { records: [record] }); state.title = "River Street lease review and supporting exhibits ".repeat(3); await root(page).getByRole("button", { name: "Refresh dispute review", exact: true }).click(); await expect(root(page).getByRole("button", { name: "Refresh dispute review", exact: true })).toBeEnabled(); await open(page);
  for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => window.disputeXss)).toBeUndefined(); expect((await new AxeBuilder({ page }).include("[data-workspace-disputes]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await root(page).getByRole("button", { name: "Keep editing", exact: true }).focus(); await expect(root(page).getByRole("button", { name: "Keep editing", exact: true })).toBeFocused(); await page.screenshot({ path: testInfo.outputPath(`disputes-${width}.png`), fullPage: true }); }
});
