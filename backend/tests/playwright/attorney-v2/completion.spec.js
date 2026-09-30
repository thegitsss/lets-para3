const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const root = page => page.locator("[data-workspace-completion]"), id = n => n.toString(16).padStart(24, "0");
const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
async function fixture(page) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id, csrf = (await (await page.request.get("/api/csrf")).json()).csrfToken;
  const send = async (path, data) => { const response = await page.request.post(path, { headers: { "X-CSRF-Token": csrf }, data: { ...data, expectedOwnerId: ownerId } }); expect(response.ok(), await response.text()).toBeTruthy(); return response.json(); };
  const draft = (await send("/api/case-drafts", { title: "River Street lease review", practiceArea: "Contract Law", state: "New York", compAmount: "1000.00", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and organize its exhibits.", tasks: [{ title: "Review the lease" }] })).draft;
  const published = await send("/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" }), caseId = published.publication.caseId;
  const state = { reads: [], writes: [], status: 200, writeStatus: 200, outcome: null, view: { ownerId, caseId, caseTitle: "River Street lease review", paralegalId: id(100), paralegalName: "Priya Ng", revision: "d".repeat(64), canComplete: true, blockers: [], mode: "complete_and_release", payoutState: "none", grossCents: 100001, feeCents: 18000, payoutCents: 82001, currency: "USD", work: { total: 2, complete: 2 }, documents: { total: 3, approved: 1, awaitingReview: 1, revisions: 1, securityPending: 0 }, completedAt: null, purgeAt: null, archiveReady: false, operation: null, retentionMonths: 6 } };
  await page.route(`**/api/cases/${caseId}/completion-review?**`, route => { const query = new URL(route.request().url()).searchParams; state.reads.push(Object.fromEntries(query)); return fulfill(route, state.status === 200 ? { ...state.view, operation: query.get("requestId") ? { status: state.outcome || "not_found", at: state.outcome === "recorded" ? "2026-09-07T12:00:00.000Z" : null } : null } : {}, state.status); });
  state.record = () => { state.outcome = "recorded"; state.view = { ...state.view, canComplete: false, blockers: ["completed"], payoutState: "recorded", mode: "finish_completion", revision: "e".repeat(64), completedAt: "2026-09-07T12:00:00.000Z", purgeAt: "2027-03-07T12:00:00.000Z", archiveReady: true }; };
  await page.route(`**/api/cases/${caseId}/complete`, route => { const body = route.request().postDataJSON(); state.writes.push(body); if (state.writeStatus === 0) { state.record(); return route.abort("failed"); } if (state.writeStatus !== 200) return fulfill(route, {}, state.writeStatus); state.record(); return fulfill(route, { completionRecorded: true, requestId: body.requestId, ok: true }); });
  await page.goto(`/attorney-v2.html#/matters/${caseId}/financials`, { waitUntil: "domcontentloaded" }); await expect(root(page)).toHaveAttribute("data-state", "ready"); return { state, caseId, ownerId };
}
test("completion shows the work, document review and exact payment before an explicit decision", async ({ page }) => {
  const { state, caseId, ownerId } = await fixture(page); await expect(root(page)).toContainText("2 of 2 agreed work items complete"); await expect(root(page)).toContainText("1 with revisions requested"); await expect(root(page)).toContainText("$1,000.01"); await expect(root(page).getByRole("link", { name: "Review documents" })).toHaveAttribute("href", `#/matters/${caseId}/files`);
  await root(page).getByRole("button", { name: "Review completion", exact: true }).click(); await expect(root(page).locator("[data-completion-confirmation]")).toBeFocused(); await expect(root(page)).toContainText("6 months after completion"); expect(state.writes).toEqual([]); await root(page).getByRole("button", { name: "Keep Matter open" }).click(); expect(state.writes).toEqual([]); await expect(root(page).getByRole("button", { name: "Review completion", exact: true })).toBeFocused();
  await root(page).getByRole("button", { name: "Review completion", exact: true }).click(); await root(page).getByRole("button", { name: "Complete Matter and release payment", exact: true }).click(); await expect(root(page)).toContainText("Payout recorded."); expect(state.writes).toHaveLength(1); expect(state.writes[0]).toMatchObject({ expectedOwnerId: ownerId, confirmation: { caseId, paralegalId: id(100), reviewedRevision: "d".repeat(64), payoutCents: 82001, grossCents: 100001, mode: "complete_and_release", currency: "USD" } }); await expect(root(page).getByRole("link", { name: "Download Matter archive" })).toHaveAttribute("href", `#/matters/${caseId}/export`); await expect(root(page).getByRole("button", { name: "Review completion", exact: true })).toHaveCount(0);
});
for (const outcome of ["unchanged", "changed", "failed", "canceled"]) test(`a background read during the review click keeps the decision reachable and handles an ${outcome} result`, async ({ page }) => {
  const { state, caseId } = await fixture(page);
  let arrived, release;
  const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/cases/${caseId}/completion-review?**`, async route => {
    arrived(); await gate;
    await fulfill(route, outcome === "failed" ? {} : { ...state.view, operation: null }, outcome === "failed" ? 503 : 200).catch(() => {});
  }, { times: 1 });
  // A routine poll can start between pointer-down and click. Opening a review
  // must still work; its money-moving confirmation waits for the current read.
  await root(page).evaluate(section => section.querySelector("[data-review-completion]").addEventListener("pointerdown", () => { void section.sync(); }, { once: true }));
  try {
    await root(page).getByRole("button", { name: "Review completion", exact: true }).click();
    await waiting;
    await expect(root(page).locator("[data-completion-confirmation]")).toBeVisible();
    await expect(root(page).getByRole("button", { name: "Complete Matter and release payment", exact: true })).toBeDisabled();
    expect(state.writes).toEqual([]);
    if (outcome === "changed") state.view = { ...state.view, grossCents: 60000, payoutCents: 49200, feeCents: 10800, revision: "b".repeat(64) };
    if (outcome === "canceled") {
      await root(page).getByRole("button", { name: "Keep Matter open", exact: true }).click();
      await expect(root(page).getByRole("button", { name: "Review completion", exact: true })).toBeFocused();
    }
    release();
    if (outcome === "unchanged") {
      await root(page).getByRole("button", { name: "Complete Matter and release payment", exact: true }).click();
      await expect(root(page)).toContainText("Payout recorded.");
      expect(state.writes).toHaveLength(1);
      expect(state.writes[0].confirmation).toMatchObject({ reviewedRevision: "d".repeat(64), payoutCents: 82001 });
    } else if (outcome === "canceled") {
      await expect(root(page)).toHaveAttribute("data-state", "ready");
      await expect(root(page).locator("[data-completion-confirmation]")).toHaveCount(0);
      expect(state.writes).toEqual([]);
    } else {
      await expect(root(page).locator("[data-completion-confirmation]")).toHaveCount(0);
      await expect(root(page)).toContainText(outcome === "changed" ? "Completion details changed" : "Completion details couldn’t load");
      expect(state.writes).toEqual([]);
      if (outcome === "changed") {
        await root(page).getByRole("button", { name: "Review completion", exact: true }).click();
        await expect(root(page).getByRole("button", { name: "Complete Matter and release payment", exact: true })).toBeVisible();
      }
    }
  } finally { release(); }
});
test("reopened completed Matters retain one payout summary and one available archive action", async ({ page }) => {
  const { state, caseId, ownerId } = await fixture(page);
  state.record();
  const response = await page.request.get(`/api/cases/${caseId}?expectedOwnerId=${ownerId}`);
  expect(response.ok()).toBeTruthy();
  const matter = await response.json();
  await page.route(`**/api/cases/${caseId}?expectedOwnerId=*`, route => fulfill(route, { ...matter, status: "completed", archived: true }));
  // A retained Matter can be archived before a downloadable ZIP is available.
  // The parent export route remains available in that case.
  for (const archiveReady of [false, true]) {
    state.view.archiveReady = archiveReady;
    await page.reload();
    await expect(root(page)).toHaveAttribute("data-state", "ready");
    await expect(root(page).getByText(/^Completed .*\. Payout recorded\.$/)).toHaveCount(1);
    await expect(root(page).getByRole("button", { name: "Review completion", exact: true })).toHaveCount(0);
    if (!archiveReady) await page.locator(".av2-workspace-options > summary").click();
    const archive = page.locator("[data-matter-workspace]").getByRole("link", { name: "Download Matter archive", exact: true });
    await expect(archive).toHaveCount(1);
    await expect(archive).toHaveAttribute("href", `#/matters/${caseId}/export`);
    await expect(root(page).locator("[data-completion-archive]")).toHaveCount(archiveReady ? 1 : 0);
  }
  expect(state.reads.every(read => !read.requestId)).toBe(true);
  expect(state.writes).toEqual([]);
});
for (const payoutState of ["none", "recorded", "needs_review"]) test(`closed Matter presentation preserves ${payoutState} payout evidence without offering completion`, async ({ page }) => {
  const { state } = await fixture(page);
  state.view = { ...state.view, revision: "c".repeat(64), closed: true, canComplete: false, payoutState, blockers: ["active_matter_required", ...(payoutState === "needs_review" ? ["payout_reconciliation"] : [])], mode: payoutState === "recorded" ? "finish_completion" : "complete_and_release", completedAt: payoutState === "recorded" ? "2026-09-07T12:00:00.000Z" : null };
  await root(page).evaluate(section => section.sync());
  await expect(root(page)).toHaveAttribute("data-state", "ready");
  await expect(root(page).getByRole("button", { name: "Review completion", exact: true })).toHaveCount(0);
  await expect(root(page).getByRole("link", { name: "Review agreed work", exact: true })).toHaveCount(0);
  if (payoutState === "none") {
    await expect(root(page).getByText("No completion payout is recorded.", { exact: true })).toBeVisible();
    await expect(root(page).locator(".av2-completion-amounts")).toHaveCount(0);
  } else {
    await expect(root(page)).not.toContainText("No completion payout is recorded.");
    await expect(root(page).locator(".av2-completion-amounts")).toContainText("$1,000.01");
    await expect(root(page)).toContainText(payoutState === "recorded" ? "Payout recorded." : "Payment records need administrator review");
    if (payoutState === "recorded") await expect(root(page).getByText(/^Closed .*\. Payout recorded\.$/)).toHaveCount(1);
  }
  expect(state.writes).toEqual([]);
});
test("an already recorded payout offers only finishing the Matter", async ({ page }) => {
  const { state } = await fixture(page); state.view = { ...state.view, mode: "finish_completion", payoutState: "recorded", revision: "a".repeat(64) };
  await root(page).evaluate(section => section.sync());
  await expect(root(page)).toHaveAttribute("data-state", "ready");
  // This scenario reviews the newly recorded payout. A review opened before
  // that read finishes is correctly dismissed when its revision changes.
  await root(page).getByRole("button", { name: "Review completion", exact: true }).click(); await expect(root(page)).toContainText("without creating another transfer"); await root(page).getByRole("button", { name: "Finish Matter completion", exact: true }).click(); await expect(root(page)).toContainText("Payout recorded."); expect(state.writes).toHaveLength(1); expect(state.writes[0].confirmation).toMatchObject({ mode: "finish_completion", reviewedRevision: "a".repeat(64) });
});
test("withdrawal omits inactive completion controls but keeps read failures and a replacement review visible", async ({ page }) => {
  const { state } = await fixture(page), active = { ...state.view };
  state.view = { ...active, withdrawalActive: true, paralegalId: null, canComplete: false, blockers: ["hire_required"], revision: "f".repeat(64) };
  await root(page).evaluate(section => section.sync());
  await expect(root(page)).toBeHidden();
  state.status = 503;
  await root(page).evaluate(section => section.sync());
  await expect(root(page)).toBeVisible();
  await expect(root(page)).toHaveAttribute("data-state", "error");
  await expect(root(page)).toContainText("Completion details couldn’t load");
  state.status = 200;
  await root(page).getByRole("button", { name: "Retry completion details", exact: true }).click();
  await expect(root(page)).toBeHidden();
  state.view = { ...state.view, blockers: ["completion_processing"], revision: "b".repeat(64) };
  await root(page).evaluate(section => section.sync());
  await expect(root(page)).toBeVisible();
  await expect(root(page)).toContainText("A completion request is being processed");
  state.view = { ...state.view, closed: true, blockers: ["active_matter_required"], revision: "c".repeat(64) };
  await root(page).evaluate(section => section.sync());
  await expect(root(page)).toBeVisible();
  await expect(root(page)).toContainText("No completion payout is recorded.");
  state.view = { ...active, withdrawalActive: false, revision: "a".repeat(64) };
  await root(page).evaluate(section => section.sync());
  await expect(root(page)).toBeVisible();
  await expect(root(page).getByRole("button", { name: "Review completion", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});
test("blocked work, payment review and uncertain amounts never offer a release control", async ({ page }) => {
  const { state } = await fixture(page); state.view = { ...state.view, canComplete: false, blockers: ["incomplete_scope_tasks", "payment_review", "amount_unavailable"], payoutCents: null, feeCents: null, currency: null, work: { total: 2, complete: 1 } }; await root(page).evaluate(section => section.sync()); await expect(root(page)).toContainText("Review the remaining work items"); await expect(root(page)).toContainText("payment is under administrative review"); await expect(root(page)).toContainText("Amount unavailable"); await expect(root(page).getByRole("button", { name: "Review completion", exact: true })).toHaveCount(0); expect(state.writes).toEqual([]);
});
test("a lost response recovers its exact recorded outcome without a second write", async ({ page }) => {
  const { state } = await fixture(page); state.writeStatus = 0; await root(page).getByRole("button", { name: "Review completion", exact: true }).click(); await root(page).getByRole("button", { name: "Complete Matter and release payment", exact: true }).click(); await expect(root(page)).toContainText("Completion could not be confirmed"); expect(state.writes).toHaveLength(1); await root(page).getByRole("button", { name: "Check completion status" }).click(); await expect(root(page)).toContainText("Payout recorded."); expect(state.reads.at(-1).requestId).toBe(state.writes[0].requestId); expect(state.writes).toHaveLength(1);
});
test("stopping the wait preserves the request for checks across Matter tabs", async ({ page }) => {
  const { state, caseId } = await fixture(page); let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/cases/${caseId}/complete`, async route => { state.writes.push(route.request().postDataJSON()); state.outcome = "processing"; arrived(); await gate; await fulfill(route, {}).catch(() => {}); });
  await root(page).getByRole("button", { name: "Review completion", exact: true }).click(); await root(page).getByRole("button", { name: "Complete Matter and release payment", exact: true }).click();
  try { await waiting; await root(page).getByRole("button", { name: "Stop waiting", exact: true }).focus(); await root(page).getByRole("button", { name: "Stop waiting", exact: true }).click(); await expect(root(page)).toContainText("Stopping the wait does not cancel a payment"); await expect(root(page).getByRole("button", { name: "Check completion status", exact: true })).toBeFocused(); state.view = { ...state.view, withdrawalActive: true, paralegalId: null, canComplete: false, blockers: ["hire_required"], revision: "f".repeat(64) }; await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Overview", exact: true }).click(); await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Financials", exact: true }).click(); await expect(root(page)).toBeVisible(); await expect(root(page)).toContainText("completion request is being processed"); expect(state.reads.at(-1).requestId).toBe(state.writes[0].requestId); expect(state.writes).toHaveLength(1); } finally { release(); }
});
test("a changed review removes the earlier confirmation and requires the current amount", async ({ page }) => {
  const { state } = await fixture(page); await root(page).getByRole("button", { name: "Review completion", exact: true }).click(); state.view = { ...state.view, grossCents: 60000, payoutCents: 49200, feeCents: 10800, revision: "b".repeat(64) }; await root(page).evaluate(section => section.sync()); await expect(root(page).locator("[data-completion-confirmation]")).toHaveCount(0); await root(page).getByRole("button", { name: "Review completion", exact: true }).click(); await expect(root(page).getByRole("button", { name: "Complete Matter and release payment", exact: true })).toBeVisible(); await expect(root(page).locator(".av2-completion-amounts")).toContainText("$600.00"); expect(state.writes).toEqual([]);
});
test("completion read failure removes earlier permission and is not an empty work count", async ({ page }) => {
  const { state } = await fixture(page); state.status = 503; await root(page).evaluate(section => section.sync()); await expect(root(page)).toHaveAttribute("data-state", "error"); await expect(root(page)).toContainText("Completion details couldn’t load"); await expect(root(page)).not.toContainText("0 of 0"); await expect(root(page).getByRole("button", { name: "Review completion", exact: true })).toHaveCount(0);
});
test("an account change clears the confirmation before a private completion can be sent", async ({ page }) => {
  const { state } = await fixture(page); await root(page).getByRole("button", { name: "Review completion", exact: true }).click(); await page.route("**/api/auth/me", route => fulfill(route, { user: { id: id(777), role: "attorney", status: "approved" } })); await root(page).getByRole("button", { name: "Complete Matter and release payment", exact: true }).click(); await expect(root(page)).toHaveCount(0); expect(state.writes).toEqual([]);
});
test("long legal Matter names and completion choices remain accessible at phone and desktop widths", async ({ page }, testInfo) => {
  const { state } = await fixture(page); state.view.caseTitle = '<img src=x onerror="window.completionXss=true"> Lease exhibits for River Street '.repeat(3); state.view.paralegalName = "Priya Ng — document review"; await root(page).evaluate(section => section.sync()); await expect(root(page)).toHaveAttribute("data-state", "ready"); await root(page).getByRole("button", { name: "Review completion", exact: true }).click();
  for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => window.completionXss)).toBeUndefined(); expect((await new AxeBuilder({ page }).include("[data-workspace-completion]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await root(page).getByRole("button", { name: "Keep Matter open" }).focus(); await expect(root(page).getByRole("button", { name: "Keep Matter open" })).toBeFocused(); await page.screenshot({ path: testInfo.outputPath(`completion-${width}.png`), fullPage: true }); await root(page).locator(".av2-completion-amounts").screenshot({ path: testInfo.outputPath(`completion-amounts-${width}.png`) }); }
});
