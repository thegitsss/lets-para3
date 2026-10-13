const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const id = n => n.toString(16).padStart(24, "0"), panel = page => page.locator("[data-workspace-messages]");
async function fixture(page, { count = 3, lost = false, unrecorded = false } = {}) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id;
  const csrf = await (await page.request.get("/api/csrf")).json(), fields = { title: "River Street lease correspondence", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and confirm the exhibits.", tasks: [{ title: "Review the lease" }] };
  const draftResponse = await page.request.post("/api/case-drafts", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { ...fields, expectedOwnerId: ownerId } }); expect(draftResponse.ok()).toBeTruthy(); const draft = (await draftResponse.json()).draft;
  const publication = await page.request.post("/api/cases/posting/publications", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law", expectedOwnerId: ownerId } }); expect(publication.ok()).toBeTruthy(); const caseId = (await publication.json()).publication.caseId;
  const state = { writes: [], reads: [], mutations: [], rejected: false, recoveryStatus: 0, lost, unrecorded, next: 10000, rows: [] };
  const row = (n, text, own = false) => ({ _id: id(n), caseId, senderId: { _id: own ? ownerId : id(888), firstName: own ? "Avery" : "Priya", lastName: own ? "Harness" : "Ng" }, senderRole: own ? "attorney" : "paralegal", type: "text", text, createdAt: new Date(Date.UTC(2026, 8, 1, 10, n)).toISOString(), revision: "d".repeat(64), reactions: {}, readBy: [], pinned: false });
  state.rows = Array.from({ length: count }, (_, i) => row(i + 1, `Exhibit instruction ${i + 1}`, i === count - 1));
  await page.route(`**/api/messages/${caseId}?**`, route => {
    const query = new URL(route.request().url()).searchParams; if (state.rejected) return fulfill(route, { code: "WORKSPACE_CONVERSATION_CLOSED" }, 403);
    if (query.get("clientMessageId") && state.recoveryStatus) return fulfill(route, { error: "Synthetic delivery check failure" }, state.recoveryStatus);
    let rows = state.rows.filter(value => !value.deleted), targetMissing = false;
    if (query.get("clientMessageId")) rows = rows.filter(value => value.clientMessageId === query.get("clientMessageId"));
    else if (query.get("messageId")) { const index = rows.findIndex(value => value._id === query.get("messageId")); targetMissing = index < 0; if (index >= 0) rows = rows.slice(0, index + 1); }
    else if (query.get("cursor")) rows = rows.slice(0, Number(query.get("cursor")));
    const end = rows.length; return fulfill(route, { caseId, messages: rows.slice(-50), nextCursor: end > 50 ? String(end - 50) : null, targetMissing, writable: true });
  });
  await page.route(`**/api/messages/${caseId}`, async route => {
    const body = route.request().postDataJSON(); state.writes.push(body); expect(body.expectedOwnerId).toBe(ownerId);
    let saved = state.rows.find(value => value.clientMessageId === body.clientMessageId);
    if (!saved && !state.unrecorded) { saved = { ...row(state.next++, body.text, true), clientMessageId: body.clientMessageId }; state.rows.push(saved); }
    if (state.lost || state.unrecorded) return route.abort("failed");
    return fulfill(route, { message: saved }, 201);
  });
  await page.route(`**/api/messages/${caseId}/read`, route => { state.reads.push(route.request().postDataJSON()); return fulfill(route, { updatedLegacy: 1, updatedReceipts: 1 }); });
  await page.route(`**/api/messages/${caseId}/**`, route => {
    const url = new URL(route.request().url()), parts = url.pathname.split("/"), messageId = parts[4], action = parts[5], body = route.request().postDataJSON();
    const selected = state.rows.find(value => value._id === messageId); state.mutations.push({ body, method: route.request().method(), action });
    if (!selected || body.reviewedRevision !== selected.revision) return fulfill(route, { code: "WORKSPACE_MESSAGE_CHANGED" }, 409);
    if (action === "react") selected.reactions = route.request().method() === "DELETE" ? {} : { [body.emoji]: [ownerId] };
    else if (route.request().method() === "DELETE") selected.deleted = true;
    else { if (body.content) selected.text = body.content; if (body.pin) selected.pinned = true; if (body.unpin) selected.pinned = false; }
    selected.revision = require("crypto").randomBytes(32).toString("hex"); return fulfill(route, { ok: true }, action === "react" ? 201 : 200);
  });
  // More specific read acknowledgement follows the mutation wildcard.
  await page.route(`**/api/messages/${caseId}/read`, route => { state.reads.push(route.request().postDataJSON()); return fulfill(route, { updatedLegacy: 1, updatedReceipts: 1 }); });
  await page.goto(`/attorney-v2.html#/matters/${caseId}/messages`, { waitUntil: "domcontentloaded" }); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  return { caseId, ownerId, state, row };
}
test("sending confirms the exact message once and acknowledges only the loaded conversation date", async ({ page }) => {
  const { state, ownerId } = await fixture(page); await expect.poll(() => state.reads.length).toBe(1); expect(state.reads[0].upTo).toBe(state.rows.at(-1).createdAt);
  await panel(page).getByRole("textbox", { name: "Message to the paralegal" }).fill("Please retain the signed lease."); await panel(page).getByRole("button", { name: "Send message", exact: true }).click();
  await expect(panel(page)).toContainText("Message sent."); expect(state.writes).toHaveLength(1); expect(state.writes[0].expectedOwnerId).toBe(ownerId); await expect(panel(page).getByRole("textbox", { name: "Message to the paralegal" })).toHaveValue(""); await expect(panel(page).locator("ol")).toContainText("Please retain the signed lease.");
});
test("failed presence retries on the next verified access check without blocking the conversation", async ({ page }) => {
  const presence = [];
  await page.route("**/api/notifications/workspace-presence", route => {
    presence.push({ method: route.request().method(), body: route.request().postDataJSON() });
    return fulfill(route, presence.length === 1 ? { error: "Synthetic presence outage" } : { success: true }, presence.length === 1 ? 503 : 200);
  });
  const failedPresence = page.waitForResponse(response => new URL(response.url()).pathname === "/api/notifications/workspace-presence" && response.status() === 503);
  const { caseId, ownerId } = await fixture(page);
  await (await failedPresence).finished();
  await expect.poll(() => presence.length).toBe(1);
  const input = panel(page).getByRole("textbox", { name: "Message to the paralegal" });
  await input.fill("Keep this draft while presence recovers.");
  const editor = await input.elementHandle();
  const recoveredPresence = page.waitForResponse(response => new URL(response.url()).pathname === "/api/notifications/workspace-presence" && response.request().method() === "POST" && response.status() === 200);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => presence.filter(entry => entry.method === "POST").length).toBe(2);
  await (await recoveredPresence).finished();
  // Same-account verification preserves a focused editor. The existing view
  // retries its lease after checking access, without disposing the draft.
  expect(presence.map(entry => entry.method)).toEqual(["POST", "POST"]);
  expect(presence[1]).toEqual({ method: "POST", body: { ...presence[0].body, revision: presence[0].body.revision + 1 } });
  expect(presence[1]).toMatchObject({ method: "POST", body: { caseId, expectedOwnerId: ownerId, surface: "messages" } });
  expect(await editor.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true);
  await editor.dispose();
  await expect(input).toBeEnabled();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Keep this draft while presence recovers.");
  await expect(page.locator("[data-matter-workspace]")).toHaveAttribute("data-state", "ready");
});
test("leaving the conversation clears an unconfirmed presence lease with its next revision", async ({ page }) => {
  const presence = [];
  await page.route("**/api/notifications/workspace-presence", route => {
    const method = route.request().method();
    presence.push({ method, body: route.request().postDataJSON() });
    return fulfill(route, method === "POST" ? { error: "Synthetic presence outage" } : { success: true }, method === "POST" ? 503 : 200);
  });
  const failedPresence = page.waitForResponse(response => new URL(response.url()).pathname === "/api/notifications/workspace-presence" && response.status() === 503);
  const { caseId, ownerId } = await fixture(page);
  await (await failedPresence).finished();
  await expect.poll(() => presence.length).toBe(1);
  await page.getByRole("link", {name:"View Matter",exact:true}).click(); await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => presence.map(entry => entry.method)).toEqual(["POST", "DELETE"]);
  expect(presence[1]).toEqual({ method: "DELETE", body: { ...presence[0].body, revision: presence[0].body.revision + 1 } });
  expect(presence[1]).toMatchObject({ method: "DELETE", body: { caseId, expectedOwnerId: ownerId, surface: "messages" } });
  await expect(page.locator("[data-matter-workspace]")).toHaveAttribute("data-state", "ready");
});
test("a lost send response is recovered by its exact request ID without another send", async ({ page }) => {
  const { state } = await fixture(page, { lost: true }); await panel(page).getByRole("textbox", { name: "Message to the paralegal" }).fill("Confirm exhibit four."); await panel(page).getByRole("button", { name: "Send message", exact: true }).click(); await expect(panel(page)).toContainText("Message sent."); expect(state.writes).toHaveLength(1); await expect(panel(page).getByRole("button", { name: "Retry same message" })).toBeHidden();
});
test("an unconfirmed send retains its text and an explicit retry uses the same request ID", async ({ page }) => {
  const { state } = await fixture(page, { unrecorded: true }); await panel(page).getByRole("textbox", { name: "Message to the paralegal" }).fill("Check the original signature."); await panel(page).getByRole("button", { name: "Send message", exact: true }).click(); await expect(panel(page).getByRole("button", { name: "Retry same message" })).toBeVisible(); expect(state.writes).toHaveLength(1); state.unrecorded = false;
  await panel(page).getByRole("button", { name: "Retry same message" }).click(); await expect(panel(page)).toContainText("Message sent."); expect(state.writes).toHaveLength(2); expect(state.writes[1]).toEqual(state.writes[0]);
});
test("an unavailable delivery check preserves one pending outcome without another send", async ({ page }) => {
  const { state } = await fixture(page, { unrecorded: true }); state.recoveryStatus = 503;
  const input = panel(page).getByRole("textbox", { name: "Message to the paralegal" });
  await input.fill("Retain this exact pending request.");
  await panel(page).getByRole("button", { name: "Send message", exact: true }).click();
  await expect(panel(page).getByRole("button", { name: "Retry same message" })).toBeVisible();
  await expect(input).toHaveValue("Retain this exact pending request.");
  await expect(panel(page).getByText(/Delivery not confirmed\./)).toHaveCount(1);
  expect(state.writes).toHaveLength(1);
  state.recoveryStatus = 0; state.unrecorded = false;
  await panel(page).getByRole("button", { name: "Retry same message" }).click();
  await expect(panel(page)).toContainText("Message sent.");
  expect(state.writes).toHaveLength(2); expect(state.writes[1]).toEqual(state.writes[0]);
});
test("access loss during a failed-send delivery check clears confidential text", async ({ page }) => {
  const { state } = await fixture(page, { unrecorded: true }); state.recoveryStatus = 403;
  const input = panel(page).getByRole("textbox", { name: "Message to the paralegal" });
  await input.fill("PRIVATE_FAILED_SEND_SENTINEL");
  await panel(page).getByRole("button", { name: "Send message", exact: true }).click();
  await expect(panel(page)).toContainText("Message access changed.");
  await expect(input).toHaveValue(""); await expect(input).toBeDisabled();
  await expect(panel(page)).not.toContainText("PRIVATE_FAILED_SEND_SENTINEL");
  await expect(panel(page).getByRole("button", { name: "Retry same message" })).toBeHidden();
  expect(state.writes).toHaveLength(1);
});
test("route changes preserve unsent text, while account protection clears it", async ({ page }) => {
  const { caseId } = await fixture(page); const input = () => panel(page).getByRole("textbox", { name: "Message to the paralegal" }); await input().fill("Private draft correspondence");
  await page.getByRole("link", {name:"View Matter",exact:true}).click(); await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true }).click(); await expect(panel(page)).toHaveCount(0); await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Messages", exact: true }).click(); await expect(input()).toHaveValue("Private draft correspondence");
  const sibling = await page.context().newPage();
  try {
    // Establish the neutral tab before changing account authority. Firefox can
    // retain goto's wait after this text document has already returned HTTP 200.
    const destination = new URL("/robots.txt", test.info().project.use.baseURL);
    const response = sibling.waitForResponse(value => value.url() === destination.href && value.request().isNavigationRequest());
    await sibling.evaluate(url => { setTimeout(() => location.assign(url), 0); }, destination.href);
    expect((await response).status()).toBe(200);
    await expect(sibling).toHaveURL(destination.href);
    await expect(input()).toHaveValue("Private draft correspondence");
    await page.route("**/api/auth/me", route => fulfill(route, { user: { id: id(777), role: "attorney", status: "approved" } }));
    await sibling.evaluate(() => localStorage.setItem("lpc_user", "{}"));
    await expect(panel(page)).toHaveCount(0); await expect(page).not.toHaveURL(new RegExp(caseId)); await expect(page.locator("body")).not.toContainText("Private draft correspondence");
  } finally {
    await sibling.close();
  }
});
test("older pages and a linked old message are reachable without losing conversation text", async ({ page }) => {
  const { caseId } = await fixture(page, { count: 125 }); await expect(panel(page).locator("[data-message-id]")).toHaveCount(50); await panel(page).getByRole("button", { name: "Show earlier messages" }).click(); await expect(panel(page).locator("[data-message-id]")).toHaveCount(100); await panel(page).getByRole("button", { name: "Show earlier messages" }).click(); await expect(panel(page).locator("[data-message-id]")).toHaveCount(125);
  await page.goto(`/attorney-v2.html#/matters/${caseId}/messages?messageId=${id(1)}`, { waitUntil: "domcontentloaded" }); await expect(panel(page).locator(`[data-message-id="${id(1)}"]`)).toBeFocused(); await expect(panel(page).getByRole("button", { name: "Show latest messages" })).toBeVisible();
});
test("editing, pinning, reactions and confirmed deletion act on the selected message", async ({ page }) => {
  const { state } = await fixture(page), own = panel(page).locator(`[data-message-id="${state.rows.at(-1)._id}"]`); await own.locator("summary").click(); await own.getByRole("button", { name: "Edit", exact: true }).click(); await panel(page).getByRole("textbox", { name: "Message text" }).fill("Reviewed exhibit instruction."); await panel(page).getByRole("button", { name: "Save message", exact: true }).click(); await expect(own).toContainText("Reviewed exhibit instruction.");
  await own.locator("summary").click(); await own.getByRole("button", { name: "Pin", exact: true }).click(); await expect(own).toContainText("Pinned message"); await own.locator("summary").click(); await own.getByRole("button", { name: "Add 👍 reaction" }).click(); await expect(panel(page)).toContainText("Reaction updated."); await own.locator("summary").click(); await expect(own.getByRole("button", { name: "Remove 👍 reaction" })).toBeVisible();
  await own.getByRole("button", { name: "Delete", exact: true }).click(); await expect(panel(page)).toContainText("LPC retains the record."); expect(state.mutations.filter(value => value.method === "DELETE")).toHaveLength(0); await panel(page).getByRole("button", { name: "Keep message" }).click(); await expect(own).toBeVisible(); await own.locator("summary").click(); await own.getByRole("button", { name: "Delete", exact: true }).click(); await panel(page).getByRole("button", { name: "Delete message", exact: true }).click(); await expect(own).toHaveCount(0);
});
test("a stale edit keeps the attorney's text and requires review of the current saved message", async ({ page }) => {
  const { state } = await fixture(page), own = panel(page).locator(`[data-message-id="${state.rows.at(-1)._id}"]`); await own.locator("summary").click(); await own.getByRole("button", { name: "Edit", exact: true }).click(); await panel(page).getByRole("textbox", { name: "Message text" }).fill("My proposed wording"); state.rows.at(-1).text = "Wording from the other tab"; state.rows.at(-1).revision = "e".repeat(64);
  await panel(page).getByRole("button", { name: "Save message", exact: true }).click(); await expect(panel(page)).toContainText("This message changed."); await expect(panel(page).getByRole("textbox", { name: "Message text" })).toHaveValue("My proposed wording"); await panel(page).getByRole("button", { name: "Retry messages", exact: true }).click(); await expect(panel(page)).toContainText("Current saved message: Wording from the other tab"); await panel(page).getByRole("button", { name: "Review my edit against this message" }).click(); await panel(page).getByRole("button", { name: "Save message", exact: true }).click(); await expect(own).toContainText("My proposed wording");
});
test("incoming updates preserve a draft and revoked conversation access clears confidential content", async ({ page }) => {
  await page.clock.install(); const { state, row } = await fixture(page); await panel(page).getByRole("textbox", { name: "Message to the paralegal" }).fill("Unsent lease instruction"); state.rows.push(row(99, "The paralegal's new reply")); await page.clock.fastForward(16000); await expect(panel(page)).toContainText("The paralegal's new reply"); await expect(panel(page).getByRole("textbox", { name: "Message to the paralegal" })).toHaveValue("Unsent lease instruction"); await expect(page.getByRole("button", { name: "Retry Matter", exact: true })).toBeHidden(); state.rejected = true; await expect.poll(async () => { await page.clock.fastForward(16000); return panel(page).getAttribute("data-state"); }).toBe("error"); await expect(panel(page).locator("ol")).not.toContainText("The paralegal's new reply"); await expect(panel(page).getByRole("textbox", { name: "Message to the paralegal" })).toHaveValue("");
});
test("message actions and composer remain readable, keyboard accessible and usable at narrow widths", async ({ page }, testInfo) => {
  await fixture(page); for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); const input = panel(page).getByRole("textbox", { name: "Message to the paralegal" }); await input.fill('<img src=x onerror="window.syntheticXss=true">'); await expect(input).toHaveValue('<img src=x onerror="window.syntheticXss=true">'); expect(await page.evaluate(() => window.syntheticXss)).toBeUndefined(); expect((await new AxeBuilder({ page }).include("[data-workspace-messages]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await input.focus(); await expect(input).toBeFocused(); await page.screenshot({ path: testInfo.outputPath(`conversation-${width}.png`), fullPage: true }); }
});

test("one Matter stream survives refreshes and closes after repeated route changes", async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.EventSource; window.syntheticMatterStreams = { opened: 0, active: 0 };
    window.EventSource = class extends Native {
      constructor(url, options) { super(url, options); this.tracked = /\/api\/cases\//.test(String(url)); if (this.tracked) { window.syntheticMatterStreams.opened++; window.syntheticMatterStreams.active++; } }
      close() { if (this.tracked) { window.syntheticMatterStreams.active--; this.tracked = false; } return super.close(); }
    };
  });
  await fixture(page);
  for (let i = 0; i < 10; i++) {
    if (!(i % 2)) await page.getByRole("link", {name:"View Matter",exact:true}).click();
    await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: i % 2 ? "Messages" : "Work", exact: true }).click();
    await expect(page.locator("[data-matter-workspace]")).toHaveAttribute("data-state", "ready"); await expect.poll(() => page.evaluate(() => window.syntheticMatterStreams.active)).toBe(1);
  }
  await page.locator("#av2-sidebar").getByRole("link", { name: "Home", exact: true }).click(); await expect(page.locator("[data-matter-workspace]")).toHaveCount(0); await expect.poll(() => page.evaluate(() => window.syntheticMatterStreams.active)).toBe(0);
});
test("a late send response cannot restore the previous account's message", async ({ page }) => {
  const { caseId, ownerId } = await fixture(page); let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(`**/api/messages/${caseId}`, async route => { arrived(); await gate; await fulfill(route, { message: { _id: id(555), caseId, senderId: ownerId, type: "text", text: "Private delayed message" } }, 201).catch(() => {}); });
  await panel(page).getByRole("textbox", { name: "Message to the paralegal" }).fill("Private delayed message"); await panel(page).getByRole("button", { name: "Send message", exact: true }).click();
  try { await waiting; await page.route("**/api/auth/me", route => fulfill(route, { user: { id: id(777), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); await expect(panel(page)).toHaveCount(0); }
  finally { release(); }
  await expect(page.locator("body")).not.toContainText("Private delayed message");
});

test("a temporary Matter read failure hides prior content and restores the unsent draft after verified access returns", async ({ page }) => {
  const { caseId } = await fixture(page); const input = () => panel(page).getByRole("textbox", { name: "Message to the paralegal" }); await input().fill("Retain this draft through a connection failure");
  const path = `**/api/cases/${caseId}?expectedOwnerId=*`; await page.route(path, route => fulfill(route, {}, 503));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await expect(page.locator("[data-matter-workspace]")).toHaveAttribute("data-state", "error"); await expect(panel(page)).toHaveCount(0);
  await page.unroute(path); await page.getByRole("button", { name: "Retry Matter", exact: true }).click(); await expect(input()).toHaveValue("Retain this draft through a connection failure");
});

test("a rejected message leaves editable text and does not remain trapped in delivery recovery", async ({ page }) => {
  const { caseId } = await fixture(page); await page.route(`**/api/messages/${caseId}`, route => fulfill(route, { error: "text required" }, 400));
  const input = panel(page).getByRole("textbox", { name: "Message to the paralegal" }); await input.fill("<b></b>"); await panel(page).getByRole("button", { name: "Send message", exact: true }).click(); await expect(panel(page)).toContainText("Message not sent."); await expect(input).toBeEnabled(); await expect(input).toHaveValue("<b></b>"); await expect(panel(page).getByRole("button", { name: "Retry same message" })).toBeHidden();
});
