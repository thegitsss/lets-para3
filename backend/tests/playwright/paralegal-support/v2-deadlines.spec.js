const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const { eventPage } = require("./event-page-fixture");

const MATTER_ID = "64b000000000000000000831";
const FIRST_EVENT_ID = "64b000000000000000000832";
const SECOND_EVENT_ID = "64b000000000000000000833";

async function json(route, payload, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function activeMatter(overrides = {}) {
  return {
    _id: MATTER_ID,
    id: MATTER_ID,
    title: "Deposition preparation",
    status: "in progress",
    practiceArea: "Civil Litigation",
    deadlineDate: "2026-09-24",
    archived: false,
    readOnly: false,
    paymentReleased: false,
    matterExperience: {
      version: 1,
      header: {
        title: "Deposition preparation",
        status: { code: "in_progress", label: "In progress" },
        practiceArea: "Civil Litigation",
        deadline: "2026-09-24",
        relationship: "Assigned paralegal",
      },
      sections: [
        { id: "overview", label: "Overview" },
        { id: "work", label: "Work" },
        { id: "files", label: "Files" },
        { id: "messages", label: "Messages" },
        { id: "deadlines", label: "Deadlines" },
        { id: "activity", label: "Activity" },
      ],
      overview: { attorney: "Jordan Lee", deadline: "2026-09-24", taskProgress: { completed: 0, total: 1 } },
      work: { tasks: [{ title: "Prepare exhibit index", completed: false }], readOnly: false, completed: 0, total: 1 },
      activity: [],
      financials: { currency: "usd", amounts: [] },
    },
    ...overrides,
  };
}

function firstReminder() {
  return {
    _id: FIRST_EVENT_ID,
    id: FIRST_EVENT_ID,
    title: "Review witness outline",
    start: "2026-09-20T12:00:00.000Z",
    end: "2026-09-20T12:00:00.000Z",
    type: "deadline",
    caseId: MATTER_ID,
    isAllDay: true,
    visibility: "private",
  };
}

function newYorkDate(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function stubHomeProjection(page, state, deadlineDate) {
  const session = await (await page.request.get("/api/auth/me")).json();
  const ownerId = String(session.user.id || session.user._id);
  // Home verifies assigned records through the authorized Files projection.
  await page.route(`**/api/uploads/case/${MATTER_ID}?presentation=matter`, route => json(route, { files: [] }));
  await page.route("**/api/users/me", (route) => json(route, {
    _id: ownerId,
    firstName: "Dana",
    lastName: "Young",
    role: "paralegal",
    status: "approved",
    stateExperience: ["New York"],
    practiceAreas: ["Civil Litigation"],
    yearsExperience: 6,
  }));
  await page.route(url => url.pathname === "/api/paralegal/dashboard", (route) => json(route, {
    metrics: {},
    activeCases: [{
      caseId: MATTER_ID,
      paralegalId: ownerId,
      escrowIntentId: "pi_phase8c_home",
      jobTitle: "Deposition preparation",
      practiceArea: "Civil Litigation",
      status: "in progress",
      deadlineDate,
      archived: false,
      paymentReleased: false,
      escrowStatus: "funded",
    }],
  }));
  await page.route("**/api/payments/connect/status", (route) => json(route, { readiness: { ready: true } }));
  await page.route("**/api/jobs/recommended", (route) => json(route, { hasMatchingProfile: true, items: [] }));
  await page.route("**/api/cases/invited-to", (route) => json(route, { items: [] }));
  await page.route("**/api/messages/threads?limit=50", (route) => json(route, { threads: [] }));
  await page.route("**/api/messages/unread-count", (route) => json(route, { count: 0 }));
  await page.route("**/api/applications/my", (route) => json(route, []));
}

function calendarEntry(event) {
  return { id: event.id || event._id, caseId: MATTER_ID, revision: require("node:crypto").createHash("sha256").update(JSON.stringify(event)).digest("hex"), title: event.title, start: event.start, end: event.end || null, type: event.type, isAllDay: event.isAllDay === true, where: event.where || "", notes: event.notes || "", timezone: event.timezone || "America/New_York", rrule: event.rrule || "", visibility: event.visibility || "private", source: "user", attendees: [], reminders: [] };
}

async function stubDeadlineWorkspace(page, state, { denyAction = false } = {}) {
  const session = await (await page.request.get("/api/auth/me")).json();
  state.ownerId = String(session.user.id || session.user._id);
  state.receipts ||= new Map();
  const revision = "a".repeat(64);
  function operation(receipt) {
    if (!receipt) return { status: "missing", event: null };
    const event = state.events.find(item => item.id === receipt.eventId);
    return { status: "recorded", action: receipt.action, eventId: receipt.eventId, event: event ? calendarEntry(event) : null, changedSinceSave: receipt.action === "delete" ? Boolean(event) : !event || calendarEntry(event).revision !== receipt.savedRevision };
  }
  await page.route("**/api/csrf", route => json(route, { csrfToken: "phase-8c-csrf" }));
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, route => {
    state.caseReads += 1;
    if (state.denied) return json(route, { error: "Matter access is no longer available" }, 403);
    return json(route, state.matter || activeMatter());
  });
  await page.route("**/api/events**", async route => {
    const request = route.request(), method = request.method(), url = new URL(request.url());
    if (method === "GET") {
      state.eventReads += 1;
      if (state.denied) return json(route, { error: "Access revoked" }, 403);
      if (state.failReads || state.failReadsAfterAction && state.actions) return json(route, { error: "Private reminders could not be updated right now." }, 503);
      expect(url.searchParams.get("expectedOwnerId")).toBe(state.ownerId);
      const entries = state.events.map(event => ({ ...event, owner: state.ownerId }));
      if (url.pathname === "/api/events") return json(route, eventPage(state.ownerId, entries, url.searchParams));
      expect(url.pathname).toBe(`/api/events/paralegal/matters/${MATTER_ID}/review`);
      const sorted = [...state.events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
      const cursor = url.searchParams.get("cursor");
      const index = cursor ? sorted.findIndex(item => item.id === JSON.parse(Buffer.from(cursor, "base64url").toString())[1]) + 1 : 0;
      const items = sorted.slice(index, index + 50), last = items.at(-1);
      const selected = sorted.find(item => item.id === url.searchParams.get("eventId"));
      return json(route, { caseId: MATTER_ID, ownerId: state.ownerId, revision, items: items.map(calendarEntry), total: sorted.length, nextCursor: index + items.length < sorted.length ? Buffer.from(JSON.stringify([last.start, last.id])).toString("base64url") : null, selection: !url.searchParams.has("eventId") ? "none" : selected ? "found" : "unavailable", selectedEvent: selected ? calendarEntry(selected) : null, operation: url.searchParams.has("requestId") ? operation(state.receipts.get(url.searchParams.get("requestId"))) : null });
    }
    expect(method).toBe("POST"); expect(url.pathname).toBe(`/api/events/paralegal/matters/${MATTER_ID}/reviewed-action`);
    const body = request.postDataJSON(); expect(body.expectedOwnerId).toBe(state.ownerId); expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    state.actions += 1;
    if (denyAction) { state.denied = true; return json(route, { error: "Access revoked" }, 403); }
    if (state.actionGate) await state.actionGate;
    const prior = state.receipts.get(body.requestId);
    if (prior) return json(route, { operation: operation(prior) });
    const current = state.events.find(item => item.id === body.eventId);
    if (body.reviewedMatterRevision !== revision || body.action !== "create" && (!current || calendarEntry(current).revision !== body.reviewedRevision)) return json(route, { code: "WORKSPACE_DATE_CHANGED", error: "The reminder changed." }, 409);
    let id = body.eventId;
    if (body.action === "create") {
      id = state.events.some(item => item.id === SECOND_EVENT_ID) ? require("node:crypto").randomBytes(12).toString("hex") : SECOND_EVENT_ID;
      state.events = [...state.events, { ...body.values, caseId: MATTER_ID, _id: id, id }];
    } else if (body.action === "update") state.events = state.events.map(event => event.id === id ? { ...event, ...body.values } : event);
    else if (body.action === "delete") state.events = state.events.filter(event => event.id !== id);
    else throw new Error("Unexpected calendar action");
    const saved = state.events.find(item => item.id === id), receipt = { action: body.action, eventId: id, savedRevision: saved ? calendarEntry(saved).revision : null };
    state.receipts.set(body.requestId, receipt);
    if (state.loseAcknowledgement) { state.loseAcknowledgement = false; return json(route, { error: "Synthetic acknowledgement unavailable" }, 503); }
    return json(route, { operation: operation(receipt) });
  });
}

test("Matter reminder continuation reaches a linked record after the first 200 dates", async ({ page }) => {
  const events = Array.from({ length: 203 }, (_, index) => ({ ...firstReminder(), id: (index + 1).toString(16).padStart(24, "0"), _id: (index + 1).toString(16).padStart(24, "0"), title: `Retained reminder ${index + 1}` }));
  const state = { matter: activeMatter(), events: [...events].reverse(), caseReads: 0, eventReads: 0, actions: 0 };
  await stubDeadlineWorkspace(page, state);
  await openDeadlines(page, { eventId: events.at(-1).id });
  await expect(page.getByText("Retained reminder 203", { exact: true })).toBeVisible();
  await expect(page.locator(`[data-event-id="${events.at(-1).id}"]`)).toBeFocused();
  expect(state.actions).toBe(0);
});

test("a confirmed reminder creation keeps a failed list refresh visible", async ({ page }) => {
  const state = { matter: activeMatter(), events: [firstReminder()], caseReads: 0, eventReads: 0, actions: 0, failReadsAfterAction: true };
  await stubDeadlineWorkspace(page, state);
  await openDeadlines(page);
  await page.getByLabel("Reminder", { exact: true }).fill("Check the saved reminder");
  await page.getByLabel("Date", { exact: true }).fill("2026-09-23");
  await page.getByRole("button", { name: "Add reminder", exact: true }).click();
  await expect.poll(() => state.events.length).toBe(2);
  await expect(page.locator("[data-v2-deadline-status]")).toContainText(/list.*(?:could not|couldn’t|unavailable)|(?:could not|couldn’t).*updat/i);
  expect(state.actions).toBe(1);
});

test("an uncertain reminder save retains entered text and is confirmed by a read without another write", async ({ page }) => {
  const state = { matter: activeMatter(), events: [], caseReads: 0, eventReads: 0, actions: 0, loseAcknowledgement: true };
  await stubDeadlineWorkspace(page, state); await openDeadlines(page);
  await page.getByLabel("Reminder", { exact: true }).fill("Keep this requested reminder");
  await page.getByLabel("Date", { exact: true }).fill("2026-09-23");
  await page.getByRole("button", { name: "Add reminder", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check saved action", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Reminder", { exact: true })).toHaveValue("Keep this requested reminder");
  await expect(page.getByRole("button", { name: "Add reminder", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Check saved action", exact: true }).click();
  await expect(page.getByText("Reminder added.", { exact: true })).toBeVisible();
  await expect(page.getByText("Keep this requested reminder", { exact: true })).toBeVisible();
  expect(state.actions).toBe(1); expect(state.events).toHaveLength(1);
});

test("a stale reminder edit retains its draft and requires review before retrying", async ({ page }) => {
  const state = { matter: activeMatter(), events: [firstReminder()], caseReads: 0, eventReads: 0, actions: 0 };
  await stubDeadlineWorkspace(page, state); await openDeadlines(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Reminder", { exact: true }).fill("My reviewed change");
  state.events[0] = { ...state.events[0], title: "Changed in another tab" };
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check saved action", exact: true })).toBeEnabled();
  expect(state.events[0].title).toBe("Changed in another tab");
  await page.getByRole("button", { name: "Check saved action", exact: true }).click();
  await expect(page.getByText(/Current reminder: Changed in another tab/)).toBeVisible();
  await expect(page.getByLabel("Reminder", { exact: true })).toHaveValue("My reviewed change");
  expect(state.actions).toBe(1);
  await page.getByRole("button", { name: "Retry these changes", exact: true }).click();
  await expect(page.getByText("Reminder updated.", { exact: true })).toBeVisible();
  expect(state.events[0].title).toBe("My reviewed change"); expect(state.actions).toBe(2);
});

test("an unavailable reminder list recovers locally before allowing edits", async ({ page }) => {
  const state = { matter: activeMatter(), events: [firstReminder()], caseReads: 0, eventReads: 0, actions: 0, failReads: true };
  await stubDeadlineWorkspace(page, state); await openDeadlines(page);
  await expect(page.getByRole("button", { name: "Add reminder", exact: true })).toBeDisabled();
  await expect(page.getByText("You have no private reminders for this matter.", { exact: true })).toHaveCount(0);
  state.failReads = false;
  await page.getByRole("button", { name: "Check reminders", exact: true }).click();
  await expect(page.getByText("Review witness outline", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add reminder", exact: true })).toBeEnabled();
  expect(state.actions).toBe(0);
});

async function openDeadlines(page, { eventId = "" } = {}) {
  const suffix = eventId ? `&eventId=${eventId}` : "";
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=deadlines${suffix}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "matter");
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("heading", { name: "Deadlines", exact: true })).toBeVisible();
}

test("shared deadline stays read-only while private reminder CRUD is server-confirmed and duplicate-guarded", async ({ page }) => {
  let releaseAction;
  const actionGate = new Promise((resolve) => { releaseAction = resolve; });
  const state = { matter: activeMatter(), events: [firstReminder()], caseReads: 0, eventReads: 0, actions: 0, actionGate };
  await stubDeadlineWorkspace(page, state);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDeadlines(page, { eventId: FIRST_EVENT_ID });

  await expect(page.getByText("September 24, 2026", { exact: true })).toBeVisible();
  await expect(page.getByText("Your private reminders", { exact: true })).toBeVisible();
  await expect(page.getByText("Reminders don’t change the Matter deadline.", { exact: true })).toBeVisible();
  await expect(page.locator(`[data-event-id="${FIRST_EVENT_ID}"]`)).toBeFocused();

  await page.getByLabel("Reminder", { exact: true }).fill("Prepare final chronology");
  await page.getByLabel("Date", { exact: true }).fill("2026-09-22");
  const form = page.locator("[data-v2-deadline-form]");
  await form.evaluate((element) => {
    element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => state.actions).toBe(1);
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  releaseAction();
  await expect(page.getByText("Prepare final chronology", { exact: true })).toBeVisible();
  await expect(page.getByText("Reminder added.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).last().click();
  await page.getByLabel("Reminder", { exact: true }).fill("Prepare verified chronology");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Prepare verified chronology", { exact: true })).toBeVisible();
  await expect(page.getByText("Reminder updated.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  await page.getByRole("button", { name: "Delete reminder", exact: true }).click();
  await expect(page.getByText("Prepare verified chronology", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Reminder deleted.", { exact: true })).toBeVisible();
  expect(state.actions).toBe(3);

  const violations = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.violations).toEqual([]);
});

test("a second V2 tab receives owner-reminder changes without a document reload", async ({ context }) => {
  const state = { matter: activeMatter(), events: [firstReminder()], caseReads: 0, eventReads: 0, actions: 0 };
  const first = await context.newPage();
  const second = await context.newPage();
  await stubDeadlineWorkspace(first, state);
  await stubDeadlineWorkspace(second, state);
  await openDeadlines(first);
  await openDeadlines(second);
  const secondNavigations = await second.evaluate(() => performance.getEntriesByType("navigation").length);

  await first.getByLabel("Reminder", { exact: true }).fill("Serve exhibit reminder");
  await first.getByLabel("Date", { exact: true }).fill("2026-09-23");
  await first.getByRole("button", { name: "Add reminder", exact: true }).click();
  await expect(second.getByText("Serve exhibit reminder", { exact: true })).toBeVisible();
  expect(await second.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(secondNavigations);
  await first.close();
  await second.close();
});

test("an already-open Home calendar refreshes after a reminder changes in another tab", async ({ context }) => {
  const reminderDate = newYorkDate(1);
  const matterDeadline = newYorkDate(2);
  const matter = activeMatter({ deadlineDate: matterDeadline });
  matter.matterExperience.header.deadline = matterDeadline;
  matter.matterExperience.overview.deadline = matterDeadline;
  const state = { matter, events: [], caseReads: 0, eventReads: 0, actions: 0 };
  const workspacePage = await context.newPage();
  const homePage = await context.newPage();
  await stubDeadlineWorkspace(workspacePage, state);
  await stubDeadlineWorkspace(homePage, state);
  await stubHomeProjection(homePage, state, matterDeadline);
  await openDeadlines(workspacePage);
  await homePage.goto("/paralegal-v2.html#/home?view=deadlines", { waitUntil: "domcontentloaded" });
  await expect(homePage.locator("[data-v2-home]")).toBeVisible();
  await expect(homePage.locator("[data-home-timeline]")).toContainText("Deposition preparation");
  const navigationCount = await homePage.evaluate(() => performance.getEntriesByType("navigation").length);

  await workspacePage.getByLabel("Reminder", { exact: true }).fill("Check service confirmation");
  await workspacePage.getByLabel("Date", { exact: true }).fill(reminderDate);
  await workspacePage.getByRole("button", { name: "Add reminder", exact: true }).click();

  await expect(homePage.locator("[data-home-timeline]")).toContainText("Check service confirmation");
  expect(await homePage.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(navigationCount);
  await workspacePage.close();
  await homePage.close();
});

test("a stale action closes confidential matter content after access loss", async ({ page }) => {
  const state = { matter: activeMatter(), events: [firstReminder()], caseReads: 0, eventReads: 0, actions: 0, denied: false };
  await stubDeadlineWorkspace(page, state, { denyAction: true });
  await openDeadlines(page);

  await page.getByLabel("Reminder", { exact: true }).fill("Stale reminder");
  await page.getByLabel("Date", { exact: true }).fill("2026-09-23");
  await page.getByRole("button", { name: "Add reminder", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You no longer have access to this matter" })).toBeVisible();
  await expect(page.getByText("Review witness outline", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-v2-deadline-form]")).toHaveCount(0);
  expect(state.caseReads).toBeGreaterThanOrEqual(2);
});

test("completed matter deep links fail closed without exposing private reminders", async ({ page }) => {
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, { error: "Completed matters are no longer accessible." }, 403));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=deadlines`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "You no longer have access to this matter" })).toBeVisible();
  await expect(page.getByText("Review witness outline", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-v2-deadline-form]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /edit|delete|add reminder/i })).toHaveCount(0);
});

test("deadline workspace stays bounded at required widths and with the Assistant open", async ({ page }) => {
  const longEvent = { ...firstReminder(), title: "A very long private reminder title that must remain within the matter workspace at every supported width" };
  const state = { matter: activeMatter(), events: [longEvent], caseReads: 0, eventReads: 0, actions: 0 };
  await stubDeadlineWorkspace(page, state);
  await openDeadlines(page);

  for (const width of [320, 360, 375, 390, 430, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: width <= 430 ? 844 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const geometry = await page.locator("[data-v2-deadline-panel]").evaluate((panel) => {
      const box = panel.getBoundingClientRect();
      return { left: box.left, right: box.right, viewport: document.documentElement.clientWidth };
    });
    expect(geometry.left, `${width}px deadline panel left edge`).toBeGreaterThanOrEqual(0);
    expect(geometry.right, `${width}px deadline panel right edge`).toBeLessThanOrEqual(geometry.viewport + 1);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("body")).toHaveClass(/support-drawer-open/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByText(longEvent.title, { exact: true })).toBeVisible();
});
