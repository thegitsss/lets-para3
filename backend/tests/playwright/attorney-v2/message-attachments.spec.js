const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const id = n => n.toString(16).padStart(24, "0"), panel = page => page.locator("[data-workspace-messages]");
async function fixture(page, { count = 3, lost = false, unrecorded = false } = {}) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id;
  const csrf = await (await page.request.get("/api/csrf")).json(), fields = { title: "River Street lease correspondence", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and confirm the exhibits.", tasks: [{ title: "Review the lease" }] };
  const draftResponse = await page.request.post("/api/case-drafts", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { ...fields, expectedOwnerId: ownerId } }); expect(draftResponse.ok()).toBeTruthy(); const draft = (await draftResponse.json()).draft;
  const publication = await page.request.post("/api/cases/posting/publications", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law", expectedOwnerId: ownerId } }); expect(publication.ok()).toBeTruthy(); const caseId = (await publication.json()).publication.caseId;
  const state = { writes: [], reads: [], mutations: [], rejected: false, lost, unrecorded, next: 10000, rows: [] };
  const row = (n, text, own = false) => ({ _id: id(n), caseId, senderId: { _id: own ? ownerId : id(888), firstName: own ? "Avery" : "Priya", lastName: own ? "Harness" : "Ng" }, senderRole: own ? "attorney" : "paralegal", type: "text", text, createdAt: new Date(Date.UTC(2026, 8, 1, 10, n)).toISOString(), revision: "d".repeat(64), reactions: {}, readBy: [], pinned: false });
  state.rows = Array.from({ length: count }, (_, i) => row(i + 1, `Exhibit instruction ${i + 1}`, i === count - 1));
  await page.route(`**/api/messages/${caseId}?**`, route => {
    const query = new URL(route.request().url()).searchParams; if (state.rejected) return fulfill(route, { code: "WORKSPACE_CONVERSATION_CLOSED" }, 403);
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

function wave() {
  const samples = 8000 * 30, bytes = samples * 2, buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF"); buffer.writeUInt32LE(36 + bytes, 4); buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(bytes, 40); return buffer;
}
async function attachments(page) {
  const setup = await fixture(page), { caseId, state, row } = setup;
  state.attachmentRequests = []; state.attachmentStatus = 200; state.badAudio = false;
  state.rows = [
    { ...row(1, "The exhibit as originally supplied."), type: "file", fileName: "Original exhibit.txt", hasAttachment: true, audioMimeType: null },
    { ...row(2, ""), type: "audio", fileName: "Exhibit instructions.wav", transcript: "Please compare the signature on exhibit four.", hasAttachment: true, audioMimeType: "audio/wav" },
    { ...row(3, ""), type: "audio", transcript: "Only the transcript remains.", hasAttachment: false, audioMimeType: null },
  ];
  await page.route(`**/api/cases/${caseId}/message-attachments/**`, route => {
    const query = new URL(route.request().url()).searchParams; state.attachmentRequests.push({ url: route.request().url(), query: Object.fromEntries(query) });
    if (state.attachmentStatus !== 200) return fulfill(route, { code: "DOWNLOAD_SCAN_PENDING" }, state.attachmentStatus);
    if (query.get("play")) return route.fulfill({ status: 200, contentType: "audio/wav", headers: { "Cache-Control": "private, no-store" }, body: state.badAudio ? Buffer.from("INVALID_AUDIO") : wave() });
    return route.fulfill({ status: 200, contentType: "application/octet-stream", body: "ORIGINAL_EXHIBIT_BYTES" });
  });
  await page.locator("[data-matter-workspace]").evaluate(e=>e.readiness); await panel(page).evaluate(e=>e.sync()); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  return setup;
}
const attachment = (page, n) => panel(page).locator(`[data-message-attachment="${id(n)}"]`);
test("attachment download delivers the selected message bytes and preserves its filename and revision", async ({ page }) => {
  const { state, ownerId } = await attachments(page); const event = page.waitForEvent("download"); await attachment(page, 1).getByRole("button", { name: "Download attachment" }).click(); const downloaded = await event;
  expect(downloaded.suggestedFilename()).toBe("Original exhibit.txt"); expect(require("fs").readFileSync(await downloaded.path(), "utf8")).toBe("ORIGINAL_EXHIBIT_BYTES"); expect(state.attachmentRequests).toHaveLength(1); expect(state.attachmentRequests[0].query).toEqual({ expectedOwnerId: ownerId, revision: state.rows[0].revision }); expect(state.attachmentRequests[0].url).toContain(id(1)); await expect(attachment(page, 1)).toContainText("Attachment download started.");
});
test("native audio plays without automatic playback and unchanged polling preserves the player", async ({ page }) => {
  await page.clock.install(); const { state } = await attachments(page); expect(state.attachmentRequests).toHaveLength(0);
  await attachment(page, 2).getByRole("button", { name: "Load audio" }).click(); const audio = attachment(page, 2).locator("audio"); await expect(attachment(page, 2)).toContainText("Audio ready."); expect(await audio.evaluate(element => element.paused)).toBe(true);
  await audio.evaluate(async element => { window.syntheticMessageAudio = element; await element.play(); }); await expect.poll(() => audio.evaluate(element => element.currentTime)).toBeGreaterThan(0);
  await page.clock.fastForward(16000); await expect(panel(page)).toHaveAttribute("data-state", "ready"); expect(await audio.evaluate(element => element === window.syntheticMessageAudio)).toBe(true); expect(await audio.evaluate(element => element.paused)).toBe(false); expect(state.attachmentRequests.every(entry => entry.query.play === "true")).toBe(true);
});
test("unsupported audio decoding offers the actual attachment download", async ({ page }) => {
  const { state } = await attachments(page); state.badAudio = true; await attachment(page, 2).getByRole("button", { name: "Load audio" }).click(); await expect(attachment(page, 2)).toContainText("Audio couldn’t play here."); await expect(attachment(page, 2).locator("audio")).toHaveCount(0);
  const event = page.waitForEvent("download"); await attachment(page, 2).getByRole("button", { name: "Download attachment" }).click(); expect((await event).suggestedFilename()).toBe("Exhibit instructions.wav");
});
test("security and stale selection states remain explicit and a fresh download requires an action", async ({ page }) => {
  const { state } = await attachments(page); state.attachmentStatus = 423; await attachment(page, 1).getByRole("button", { name: "Download attachment" }).click(); await expect(attachment(page, 1)).toContainText("awaiting its security check"); expect(state.attachmentRequests).toHaveLength(1);
  state.attachmentStatus = 409; await attachment(page, 1).getByRole("button", { name: "Download attachment" }).click(); await expect(attachment(page, 1)).toContainText("Refresh messages before opening"); expect(state.attachmentRequests).toHaveLength(2);
  state.attachmentStatus = 200; await page.locator("[data-matter-workspace]").evaluate(e=>e.readiness); await panel(page).evaluate(e=>e.sync()); expect(state.attachmentRequests).toHaveLength(2); const event = page.waitForEvent("download"); await attachment(page, 1).getByRole("button", { name: "Download attachment" }).click(); await event;
});
test("denied attachment access clears the loaded conversation and stops its player", async ({ page }) => {
  const { state } = await attachments(page); await attachment(page, 2).getByRole("button", { name: "Load audio" }).click(); await expect(attachment(page, 2)).toContainText("Audio ready."); await attachment(page, 2).locator("audio").evaluate(element => { window.syntheticMessageAudio = element; });
  state.attachmentStatus = 403; await attachment(page, 1).getByRole("button", { name: "Download attachment" }).click(); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page).locator("[data-message-id]")).toHaveCount(0); expect(await page.evaluate(() => window.syntheticMessageAudio.paused && !window.syntheticMessageAudio.hasAttribute("src"))).toBe(true);
});
test("changed audio messages dispose their prior player and retain the updated transcript", async ({ page }) => {
  await page.clock.install(); const { state } = await attachments(page); await attachment(page, 2).getByRole("button", { name: "Load audio" }).click(); await expect(attachment(page, 2)).toContainText("Audio ready."); await attachment(page, 2).locator("audio").evaluate(element => { window.syntheticMessageAudio = element; });
  state.rows[1].revision = "f".repeat(64); state.rows[1].transcript = "The corrected exhibit instruction."; await page.clock.fastForward(16000); await expect(panel(page)).toContainText("The corrected exhibit instruction."); await expect(attachment(page, 2).locator("audio")).toHaveCount(0); expect(await page.evaluate(() => window.syntheticMessageAudio.paused && !window.syntheticMessageAudio.hasAttribute("src"))).toBe(true);
});
test("route disposal stops native audio and a late download cannot escape the former conversation", async ({ page }) => {
  const { caseId } = await attachments(page); await attachment(page, 2).getByRole("button", { name: "Load audio" }).click(); await expect(attachment(page, 2)).toContainText("Audio ready."); await attachment(page, 2).locator("audio").evaluate(element => { window.syntheticMessageAudio = element; });
  let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }); let downloaded = false; page.on("download", () => { downloaded = true; });
  await page.route(`**/api/cases/${caseId}/message-attachments/${id(1)}?**`, async route => { arrived(); await gate; await route.fulfill({ status: 200, contentType: "application/octet-stream", body: "LATE_PRIVATE_BYTES" }).catch(() => {}); });
  await attachment(page, 1).getByRole("button", { name: "Download attachment" }).click(); await waiting;
  try { await page.getByRole("link", {name:"View Matter",exact:true}).click(); await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true }).click(); await expect(panel(page)).toHaveCount(0); expect(await page.evaluate(() => window.syntheticMessageAudio.paused && !window.syntheticMessageAudio.hasAttribute("src"))).toBe(true); }
  finally { release(); }
  await expect(page.locator("[data-matter-workspace]")).toHaveAttribute("data-state", "ready"); expect(downloaded).toBe(false);
});
test("missing attachments, transcript text and controls remain accessible at narrow widths", async ({ page }, testInfo) => {
  const { state } = await attachments(page); await expect(attachment(page, 3)).toContainText("No attachment is available"); await expect(attachment(page, 3).getByRole("button")).toHaveCount(0); state.rows[1].transcript = '<img src=x onerror="window.syntheticXss=true">'; await page.locator("[data-matter-workspace]").evaluate(e=>e.readiness); await panel(page).evaluate(e=>e.sync());
  for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => window.syntheticXss)).toBeUndefined(); expect((await new AxeBuilder({ page }).include("[data-workspace-messages]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await attachment(page, 2).getByRole("button", { name: "Load audio" }).focus(); await expect(attachment(page, 2).getByRole("button", { name: "Load audio" })).toBeFocused(); await page.screenshot({ path: testInfo.outputPath(`message-attachments-${width}.png`), fullPage: true }); }
});
