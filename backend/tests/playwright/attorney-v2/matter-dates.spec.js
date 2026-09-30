const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const calendar = page => page.locator("[data-workspace-dates]"), editor = page => calendar(page).locator("[data-calendar-editor]"), detail = page => calendar(page).locator("[data-calendar-detail]");
async function fixture(page, count = 1) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id, csrf = (await (await page.request.get("/api/csrf")).json()).csrfToken;
  const fields = { title: "River Street lease calendar", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and confirm the exhibits.", tasks: [{ title: "Review the lease" }] };
  const draftResponse = await page.request.post("/api/case-drafts", { headers: { "X-CSRF-Token": csrf }, data: { ...fields, expectedOwnerId: ownerId } }); expect(draftResponse.ok()).toBeTruthy(); const draft = (await draftResponse.json()).draft;
  const publication = await page.request.post("/api/cases/posting/publications", { headers: { "X-CSRF-Token": csrf }, data: { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law", expectedOwnerId: ownerId } }); expect(publication.ok()).toBeTruthy(); const caseId = (await publication.json()).publication.caseId;
  const entries = [];
  for (let base = 0; base < count; base += 25) await Promise.all(Array.from({ length: Math.min(25, count - base) }, async (_, offset) => {
    const result = await page.request.post("/api/events", { headers: { "X-CSRF-Token": csrf }, data: { caseId, title: `Exhibit meeting ${base + offset + 1}`, type: "meeting", start: "2027-03-14T16:00:15.123Z", end: "2027-03-14T17:00:20.456Z", timezone: "America/New_York", notes: "Bring the original exhibits.", where: "Conference room" } }); expect(result.status()).toBe(201); entries.push((await result.json()).id);
  }));
  entries.sort(); const writes = []; page.on("request", request => { if (request.url().includes(`/api/events/matters/${caseId}/reviewed-action`)) writes.push(request.postDataJSON()); });
  await page.goto(`/attorney-v2.html#/matters/${caseId}/deadlines${entries.length ? `?eventId=${entries[0]}` : ""}`, { waitUntil: "domcontentloaded" }); await expect(calendar(page)).toHaveAttribute("data-state", "ready");
  return { caseId, ownerId, entries, writes, csrf, read: async () => { const response = await page.request.get(`/api/events/matters/${caseId}/review?expectedOwnerId=${ownerId}`); expect(response.status()).toBe(200); return response.json(); } };
}
async function newEntry(page, title = "Prepare original exhibits") { await calendar(page).getByRole("button", { name: "Add calendar entry", exact: true }).click(); await editor(page).getByLabel("Entry title", { exact: true }).fill(title); await editor(page).getByLabel("Start date", { exact: true }).fill("2027-03-13"); }
test("calendar creation saves through the actual route and preserves the separate Matter deadline", async ({ page }) => {
  const { writes, read } = await fixture(page, 0); await expect(page.getByRole("region", { name: "Matter deadlines", exact: true })).toContainText("Matter deadline: Mar 14, 2027"); await newEntry(page); await editor(page).getByLabel("Calendar notes").fill("Keep the original signature pages."); await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click(); await expect(calendar(page)).toContainText("Calendar entry saved."); expect(writes).toHaveLength(1); expect(writes[0].values.start).toBe("2027-03-13T12:00:00.000Z"); const review = await read(); expect(review.items).toHaveLength(1); expect(review.items[0].notes).toBe("Keep the original signature pages."); await expect(page.getByRole("region", { name: "Matter deadlines", exact: true })).toContainText("Matter deadline: Mar 14, 2027");
});
test("the full calendar and an exact entry beyond the first page remain reachable", async ({ page }) => {
  const { entries, caseId } = await fixture(page, 125); await expect(calendar(page).locator("[data-event-id]")).toHaveCount(50); await expect(calendar(page)).toContainText("125 entries"); await calendar(page).getByRole("button", { name: "Show more dates" }).click(); await expect(calendar(page).locator("[data-event-id]")).toHaveCount(100); await calendar(page).getByRole("button", { name: "Show more dates" }).click(); await expect(calendar(page).locator("[data-event-id]")).toHaveCount(125); await expect(calendar(page).getByRole("button", { name: "Show more dates" })).toBeHidden();
  await page.goto(`/attorney-v2.html#/matters/${caseId}/deadlines?eventId=${entries.at(-1)}`, { waitUntil: "domcontentloaded" }); await expect(calendar(page)).toHaveAttribute("data-state", "ready"); await expect(detail(page).getByRole("link", { name: "Link to this date" })).toHaveAttribute("href", new RegExp(entries.at(-1))); await expect(calendar(page).locator("[data-event-id]")).toHaveCount(50);
});
test("partial edits preserve the original seconds, time zone and end instant", async ({ page }) => {
  const { writes, read } = await fixture(page); const before = (await read()).items[0]; await detail(page).getByRole("button", { name: "Edit calendar entry" }).click(); await editor(page).getByLabel("Calendar notes").fill("Updated exhibit instruction."); await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click(); await expect(calendar(page)).toContainText("Calendar entry saved."); expect(writes[0].values).toEqual({ notes: "Updated exhibit instruction." }); const after = (await read()).items[0]; for (const key of ["start", "end", "timezone", "isAllDay", "id"]) expect(after[key]).toEqual(before[key]);
});
test("a skipped time is rejected and a repeated time needs an explicit occurrence", async ({ page }) => {
  const { writes, read } = await fixture(page, 0); await newEntry(page, "Review call"); await editor(page).getByLabel("All-day entry").uncheck(); await editor(page).getByLabel("Time zone", { exact: true }).fill("America/New_York"); await editor(page).getByLabel("Start date", { exact: true }).fill("2027-03-14"); await editor(page).getByLabel("Start time", { exact: true }).fill("02:30"); await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click(); await expect(calendar(page)).toContainText("does not exist in the selected time zone"); expect(writes).toHaveLength(0);
  await editor(page).getByLabel("Start date", { exact: true }).fill("2027-11-07"); await editor(page).getByLabel("Start time", { exact: true }).fill("01:30"); await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click(); await expect(calendar(page)).toContainText("occurs twice"); await editor(page).getByLabel("Which start time?").selectOption("2027-11-07T06:30:00.000Z"); await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click(); await expect(calendar(page)).toContainText("Calendar entry saved."); expect((await read()).items[0].start).toBe("2027-11-07T06:30:00.000Z");
});
test("a lost response is checked against the recorded action without another save", async ({ page }) => {
  const { caseId, writes, read } = await fixture(page, 0); await page.route(`**/api/events/matters/${caseId}/reviewed-action`, async route => { const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort("failed"); });
  await newEntry(page); await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click(); await expect(calendar(page)).toContainText("could not be confirmed"); expect((await read()).items).toHaveLength(1); await calendar(page).getByRole("button", { name: "Check saved action" }).click(); await expect(calendar(page)).toContainText("Calendar entry saved."); expect(writes).toHaveLength(1); await expect(editor(page)).toBeEmpty();
});
test("a conflict preserves proposed notes and requires review before the same action is retried", async ({ page }) => {
  const { entries, csrf, writes, read } = await fixture(page); await detail(page).getByRole("button", { name: "Edit calendar entry" }).click(); await editor(page).getByLabel("Calendar notes").fill("My proposed calendar notes."); const legacy = await page.request.patch(`/api/events/${entries[0]}`, { headers: { "X-CSRF-Token": csrf }, data: { notes: "The other tab's saved notes." } }); expect(legacy.status()).toBe(200);
  await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click(); await expect(calendar(page)).toContainText("entry or Matter changed"); await calendar(page).getByRole("button", { name: "Check saved action" }).click(); await expect(calendar(page).locator("[data-calendar-recovery]")).toContainText("The other tab's saved notes."); await expect(calendar(page).getByRole("button", { name: "Retry the reviewed action" })).toBeDisabled(); await calendar(page).getByRole("button", { name: "Use the current record for this action" }).click(); await calendar(page).getByRole("button", { name: "Retry the reviewed action" }).click(); await expect(calendar(page)).toContainText("Calendar entry saved."); expect(writes).toHaveLength(2); expect(writes[1].requestId).toBe(writes[0].requestId); expect((await read()).items[0].notes).toBe("My proposed calendar notes.");
});
test("attendee and reminder actions record their actual settings", async ({ page }) => {
  const { read } = await fixture(page); await detail(page).getByRole("button", { name: "Add attendee record" }).click(); await expect(editor(page)).toContainText("No invitation is sent."); await editor(page).getByLabel("Attendee name", { exact: true }).fill("Morgan Lee"); await editor(page).getByLabel("Attendee email (optional)").fill("morgan@synthetic.test"); await editor(page).getByLabel("Recorded response").selectOption("accepted"); await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click(); await expect(calendar(page)).toContainText("Attendee recorded.");
  await detail(page).getByRole("button", { name: "Record reminder", exact: true }).click(); await expect(editor(page)).toContainText("Delivery is not confirmed"); await editor(page).getByLabel("Minutes before the entry").fill("60"); await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click(); await expect(calendar(page)).toContainText("Reminder settings recorded."); const saved = (await read()).items[0]; expect(saved.attendees[0]).toMatchObject({ name: "Morgan Lee", response: "accepted" }); expect(saved.reminders[0]).toEqual({ minutesBefore: 60, method: "email" });
});
test("calendar removal requires its named confirmation and preserves the Matter deadline", async ({ page }) => {
  const { read, writes } = await fixture(page); await detail(page).getByRole("button", { name: "Remove calendar entry" }).click(); await expect(editor(page)).toContainText("Exhibit meeting 1"); expect(writes).toHaveLength(0); await editor(page).getByRole("button", { name: "Keep calendar entry" }).click(); expect((await read()).items).toHaveLength(1); await detail(page).getByRole("button", { name: "Remove calendar entry" }).click(); await editor(page).getByRole("button", { name: "Confirm removal" }).click(); await expect(calendar(page)).toContainText("Calendar entry removed."); expect((await read()).items).toHaveLength(0); await expect(page.getByRole("region", { name: "Matter deadlines", exact: true })).toContainText("Matter deadline: Mar 14, 2027");
});
test("calendar drafts survive internal navigation and account protection clears them before a write", async ({ page }) => {
  const { writes } = await fixture(page, 0); await newEntry(page, "PRIVATE_CALENDAR_DRAFT");
  await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true }).click();
  await expect(page.locator("[data-workspace-work]")).toHaveAttribute("data-state", "ready");
  await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Deadlines", exact: true }).click();
  await expect(calendar(page)).toHaveAttribute("data-state", "ready");
  await expect(editor(page).getByLabel("Entry title", { exact: true })).toHaveValue("PRIVATE_CALENDAR_DRAFT");
  await expect(editor(page).getByRole("button", { name: "Save calendar entry", exact: true })).toBeEnabled();
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])); expect(stored).not.toContain("PRIVATE_CALENDAR_DRAFT");
  // Background reads retain the original identity until the real click lands.
  // Holding those reads can otherwise keep Save disabled until they time out.
  await page.evaluate(() => {
    window.__syntheticCalendarSaveStarted = false;
    document.addEventListener("click", function observeSave(event) {
      const button = event.target.closest?.("[data-calendar-editor] button");
      if (button?.textContent.trim() !== "Save calendar entry") return;
      window.__syntheticCalendarSaveStarted = true;
      document.removeEventListener("click", observeSave, true);
    }, true);
  });
  let changedIdentity = false;
  await page.route("**/api/auth/me", async route => {
    changedIdentity ||= await page.evaluate(() => window.__syntheticCalendarSaveStarted === true);
    if (!changedIdentity) return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { id: "e".repeat(24), role: "attorney", status: "approved" } }) });
  });
  await editor(page).getByRole("button", { name: "Save calendar entry", exact: true }).click();
  await expect(calendar(page)).toHaveCount(0); expect(writes).toHaveLength(0); await expect(page.locator("body")).not.toContainText("PRIVATE_CALENDAR_DRAFT");
});
test("calendar filters, form and long notes remain accessible across phone and desktop widths", async ({ page }, testInfo) => {
  await fixture(page); await calendar(page).getByLabel("From date (UTC)").fill("2028-01-01"); await calendar(page).getByRole("button", { name: "Filter dates" }).click(); await expect(calendar(page)).toContainText("No calendar entries are recorded in this date range."); await calendar(page).getByRole("button", { name: "Show all dates" }).click(); await expect(calendar(page)).toContainText("1 entry in this date range"); await detail(page).getByRole("button", { name: "Edit calendar entry" }).click(); await editor(page).getByLabel("Calendar notes").fill('<img src=x onerror="window.syntheticXss=true">');
  for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => window.syntheticXss)).toBeUndefined(); expect((await new AxeBuilder({ page }).include("[data-workspace-dates]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await editor(page).getByLabel("Entry title", { exact: true }).focus(); await expect(editor(page).getByLabel("Entry title", { exact: true })).toBeFocused(); await page.screenshot({ path: testInfo.outputPath(`matter-dates-${width}.png`), fullPage: true }); }
});

test("legacy event links open Deadlines and Activity keeps a calendar return", async ({ page }, info) => {
  const { caseId, entries } = await fixture(page);
  const navigation=page.getByRole('navigation',{name:'Matter sections',exact:true});
  await expect(navigation.getByRole('link')).toHaveText(['Overview','Applications','Work','Files','Messages','Deadlines','Activity','Financials']);
  await page.goto(`/attorney-v2.html#/matters/${caseId}/activity?eventId=${entries[0]}`);
  await expect(page.getByRole('region',{name:'Matter deadlines',exact:true})).toBeVisible();
  await expect(detail(page).getByRole('link',{name:'Link to this date'})).toHaveAttribute('href',new RegExp(`/deadlines\\?eventId=${entries[0]}`));
  for (const width of [1366,320]) {
    await page.setViewportSize({width,height:900});
    if (width === 320) {
      await expect.poll(async()=>navigation.evaluate(el=>el.getBoundingClientRect().height)).toBeLessThan(60);
      await expect.poll(async()=>navigation.evaluate(el=>{const a=el.querySelector('[aria-current]').getBoundingClientRect(),b=el.getBoundingClientRect();return a.left>=b.left-1&&a.right<=b.right+1;})).toBe(true);
    }
    await page.locator('[data-av2-outlet]').evaluate(el=>{el.scrollTop=0;});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`deadlines-header-${width}.png`),fullPage:true});
  }
  await navigation.getByRole('link',{name:'Activity',exact:true}).click();
  await expect(page.getByRole('region',{name:'Matter activity',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'View deadlines and your calendar'}).click();
  await expect(calendar(page)).toHaveAttribute('data-state','ready');
});
