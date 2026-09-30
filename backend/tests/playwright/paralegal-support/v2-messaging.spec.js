const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const MATTER_ID = "64b000000000000000000811";
const FIRST_MESSAGE_ID = "64b000000000000000000812";
const SENT_MESSAGE_ID = "64b000000000000000000813";

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
    archived: false,
    readOnly: false,
    paymentReleased: false,
    matterExperience: {
      version: 1,
      header: {
        title: "Deposition preparation",
        status: { code: "in_progress", label: "In progress" },
        practiceArea: "Civil Litigation",
        relationship: "Assigned paralegal",
      },
      sections: [
        { id: "overview", label: "Overview" },
        { id: "work", label: "Work" },
        { id: "files", label: "Files" },
        { id: "messages", label: "Messages" },
        { id: "activity", label: "Activity" },
      ],
      overview: { attorney: "Jordan Lee", taskProgress: { completed: 0, total: 1 } },
      work: { tasks: [{ title: "Prepare exhibit index", completed: false }], readOnly: false, completed: 0, total: 1 },
      activity: [],
      financials: { currency: "usd", amounts: [] },
    },
    ...overrides,
  };
}

function initialMessages() {
  return [{
    _id: FIRST_MESSAGE_ID,
    type: "text",
    text: "Please begin with the exhibit index.",
    createdAt: "2026-09-03T14:00:00.000Z",
    senderId: { _id: "64b000000000000000000899", firstName: "Jordan", lastName: "Lee", role: "attorney" },
  }];
}

async function installRealtimeHarness(page) {
  await page.addInitScript(() => {
    window.__v2RealtimeStreams = [];
    class RealtimeEventSource extends EventTarget {
      constructor(url) {
        super();
        this.url = String(url);
        this.readyState = 1;
        window.__v2RealtimeStreams.push(this);
      }

      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = RealtimeEventSource;
    window.__emitV2Realtime = (urlPart, type, data) => {
      const stream = [...window.__v2RealtimeStreams].reverse().find((entry) => (
        entry.readyState === 1 && entry.url.includes(urlPart)
      ));
      stream?.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data || {}) }));
    };
  });
}

async function stubMessageWorkspace(page, state, { denyAfterSend = false } = {}) {
  state.files = state.files || [];
  state.fileUploads = state.fileUploads || [];
  state.presence = state.presence || [];
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "phase-8a-csrf" }));
  await page.route("**/api/users/me/onboarding", (route) => json(route, { onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } }));
  await page.route("**/api/cases/my?*", (route) => json(route, [activeMatter()]));
  await page.route("**/api/messages/summary", (route) => json(route, { items: [] }));
  await page.route("**/api/notifications/workspace-presence", async (route) => {
    state.presence.push({ method: route.request().method(), body: route.request().postDataJSON() });
    return json(route, { success: true, caseId: MATTER_ID });
  });
  await page.route(`**/api/uploads/case/${MATTER_ID}?presentation=matter`, async (route) => {
    if (route.request().method() === "GET") return json(route, { files: state.files });
    state.fileUploads.push(route.request().postDataBuffer());
    if (state.failNextUpload) {
      state.failNextUpload = false;
      return json(route, { error: "The file could not be shared." }, 503);
    }
    const next = {
      id: `64b0000000000000000008${20 + state.fileUploads.length}`,
      originalName: `shared-${state.fileUploads.length}.pdf`,
      size: 128,
      securityStatus: "not_required",
      uploadedByRole: "paralegal",
      uploadedAt: `2026-09-03T14:0${5 + state.fileUploads.length}:00.000Z`,
    };
    state.files = [...state.files, next];
    return json(route, { file: next }, 201);
  });
  await page.route(`**/api/cases/${MATTER_ID}/stream`, (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `event: ready\ndata: {"caseId":"${MATTER_ID}"}\n\n`,
  }));
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => {
    state.caseReads += 1;
    if (denyAfterSend && state.denied) return json(route, { error: "Matter access is no longer available" }, 403);
    return json(route, activeMatter());
  });
  await page.route(`**/api/messages/${MATTER_ID}/read`, async (route) => {
    state.readBodies.push(route.request().postDataJSON());
    return json(route, { updatedLegacy: 1, updatedReceipts: 1 });
  });
  await page.route(`**/api/messages/${MATTER_ID}`, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      state.messageReads += 1;
      return json(route, { messages: state.messages });
    }
    if (method !== "POST") return json(route, { error: "Unexpected request" }, 405);
    state.sendBodies.push(route.request().postDataJSON());
    if (denyAfterSend) {
      state.denied = true;
      return json(route, { error: "Messaging is closed for this matter." }, 403);
    }
    if (state.failNextSend) {
      state.failNextSend = false;
      return json(route, { error: "Messages are temporarily unavailable." }, 503);
    }
    if (state.sendGate) await state.sendGate;
    const text = state.sendBodies.at(-1).text;
    const message = {
      _id: SENT_MESSAGE_ID,
      type: "text",
      text,
      createdAt: "2026-09-03T14:05:00.000Z",
      senderId: { _id: "64b000000000000000000001", firstName: "Dana", lastName: "Young", role: "paralegal" },
    };
    state.messages = [...state.messages.filter((item) => item._id !== SENT_MESSAGE_ID), message];
    return json(route, { message }, 201);
  });
}

async function openMessages(page) {
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=messages`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "matter");
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("heading", { name: "Messages", exact: true })).toBeVisible();
}

test("text sending appears immediately, reconciles server confirmation, guards duplicates, and marks the conversation read", async ({ page }) => {
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const state = { messages: initialMessages(), caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [], sendGate };
  await stubMessageWorkspace(page, state);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMessages(page);

  await expect.poll(() => state.readBodies.length).toBeGreaterThan(0);
  expect(state.readBodies[0]).toEqual({ upTo: "2026-09-03T14:00:00.000Z" });
  await page.evaluate(() => {
    window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.phase8Identity = "same-sidebar";
    window.__LPC_PARALEGAL_V2__.shell.header.dataset.phase8Identity = "same-header";
    window.__phase8Navigations = performance.getEntriesByType("navigation").length;
  });

  const input = page.getByLabel("Write a message");
  await input.fill("The exhibit index is underway.");
  const send = page.locator("[data-v2-message-form] button[type='submit']");
  await page.locator("[data-v2-message-form]").evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => state.sendBodies.length).toBe(1);
  await expect(send).toBeDisabled();
  await expect(page.getByText("The exhibit index is underway.", { exact: true })).toBeVisible();
  await expect(page.locator(".v2-matter-message-delivery")).toHaveText("Sending…");
  releaseSend();
  await expect(page.getByText("The exhibit index is underway.", { exact: true })).toBeVisible();
  await expect(page.getByText("The exhibit index is underway.", { exact: true })).toHaveCount(1);
  await expect(page.locator(".v2-matter-message-delivery")).toHaveCount(0);
  await expect(page.getByText("Message sent.", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");

  expect(state.sendBodies).toEqual([expect.objectContaining({
    text: "The exhibit index is underway.",
    clientMessageId: expect.any(String),
  })]);
  await expect.poll(() => state.readBodies).toEqual([
    { upTo: "2026-09-03T14:00:00.000Z" },
    { upTo: "2026-09-03T14:05:00.000Z" },
  ]);

  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("link", { name: "Messages", exact: true }).click();
  await expect(page.getByText("The exhibit index is underway.", { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  expect(state.readBodies).toHaveLength(2);
  expect(state.messageReads).toBeGreaterThanOrEqual(3);
  const continuity = await page.evaluate(() => ({
    sidebar: window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.phase8Identity,
    header: window.__LPC_PARALEGAL_V2__.shell.header.dataset.phase8Identity,
    navigations: performance.getEntriesByType("navigation").length,
    initialNavigations: window.__phase8Navigations,
  }));
  expect(continuity).toEqual({
    sidebar: "same-sidebar",
    header: "same-header",
    navigations: continuity.initialNavigations,
    initialNavigations: continuity.initialNavigations,
  });

  const violations = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.violations).toEqual([]);
});

test("a failed send preserves the draft and succeeds on an explicit retry", async ({ page }) => {
  const state = { messages: initialMessages(), caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [], failNextSend: true };
  await stubMessageWorkspace(page, state);
  await openMessages(page);

  const input = page.getByLabel("Write a message");
  await input.fill("Draft that must not disappear");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Messages are temporarily unavailable.", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("Draft that must not disappear");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Draft that must not disappear", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
  expect(state.sendBodies).toHaveLength(2);
  expect(state.sendBodies[0]).toEqual(expect.objectContaining({ text: "Draft that must not disappear", clientMessageId: expect.any(String) }));
  expect(state.sendBodies[1]).toEqual(state.sendBodies[0]);
});

test("a stale authorization failure removes the composer and purges confidential workspace content", async ({ page }) => {
  const state = { messages: initialMessages(), caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [], denied: false };
  await stubMessageWorkspace(page, state, { denyAfterSend: true });
  await openMessages(page);

  await page.getByLabel("Write a message").fill("This action is now stale");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You no longer have access to this matter" })).toBeVisible();
  await expect(page.getByText("Please begin with the exhibit index.")).toHaveCount(0);
  await expect(page.getByLabel("Write a message")).toHaveCount(0);
  expect(state.caseReads).toBeGreaterThanOrEqual(2);
});

test("another open V2 tab receives the server-confirmed conversation without a page reload", async ({ context }) => {
  const state = { messages: initialMessages(), caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [] };
  const first = await context.newPage();
  const second = await context.newPage();
  await stubMessageWorkspace(first, state);
  await stubMessageWorkspace(second, state);
  await openMessages(first);
  await openMessages(second);
  const secondNavigations = await second.evaluate(() => performance.getEntriesByType("navigation").length);

  await first.getByLabel("Write a message").fill("Visible in both open tabs");
  await first.getByRole("button", { name: "Send", exact: true }).click();
  await expect(first.getByText("Visible in both open tabs", { exact: true })).toBeVisible();
  await expect(second.getByText("Visible in both open tabs", { exact: true })).toBeVisible();
  expect(await second.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(secondNavigations);
  await first.close();
  await second.close();
});

test("an attorney message event appears immediately without navigation or manual refresh", async ({ page }) => {
  const state = { messages: initialMessages(), caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [] };
  await installRealtimeHarness(page);
  await stubMessageWorkspace(page, state);
  await openMessages(page);
  const navigationCount = await page.evaluate(() => performance.getEntriesByType("navigation").length);

  state.messages = [...state.messages, {
    _id: "64b000000000000000000814",
    type: "text",
    text: "The attorney added a new instruction.",
    createdAt: "2026-09-03T14:06:00.000Z",
    senderId: { _id: "64b000000000000000000899", firstName: "Jordan", lastName: "Lee", role: "attorney" },
  }];
  await page.evaluate((matterId) => {
    window.__emitV2Realtime(`/api/cases/${matterId}/stream`, "messages", { matterId });
  }, MATTER_ID);

  await expect(page.getByText("The attorney added a new instruction.", { exact: true })).toBeVisible({ timeout: 2_000 });
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(navigationCount);
});

test("the composer remains bounded across required widths and with the Assistant open", async ({ page }) => {
  const state = { messages: initialMessages(), caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [] };
  await stubMessageWorkspace(page, state);
  await openMessages(page);
  const input = page.getByLabel("Write a message");
  await input.fill("Draft remains in place while the workspace recomposes");

  for (const width of [320, 360, 375, 390, 430, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: width <= 430 ? 844 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const geometry = await page.locator("[data-v2-message-form]").evaluate((form) => {
      const box = form.getBoundingClientRect();
      return { left: box.left, right: box.right, viewport: document.documentElement.clientWidth };
    });
    expect(geometry.left, `${width}px composer left edge`).toBeGreaterThanOrEqual(0);
    expect(geometry.right, `${width}px composer right edge`).toBeLessThanOrEqual(geometry.viewport + 1);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("body")).toHaveClass(/support-drawer-open/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(input).toHaveValue("Draft remains in place while the workspace recomposes");
});

test("completed matter deep links fail closed without exposing conversation history", async ({ page }) => {
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, { error: "Completed matters are no longer accessible." }, 403));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=messages`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "You no longer have access to this matter" })).toBeVisible();
  await expect(page.getByLabel("Write a message")).toHaveCount(0);
  await expect(page.getByText("Please begin with the exhibit index.", { exact: true })).toHaveCount(0);
});

test("several attachments and a message share through the existing matter authorities", async ({ page }) => {
  const state = { messages: initialMessages(), caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [] };
  await stubMessageWorkspace(page, state);
  await openMessages(page);

  await page.getByLabel("Attach files").setInputFiles([
    { name: "draft-one.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 first") },
    { name: "draft-two.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 second") },
  ]);
  await page.getByLabel("Write a message").fill("Both drafts are ready for review.");
  await expect(page.getByText("draft-one.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("draft-two.pdf", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect.poll(() => state.fileUploads.length).toBe(2);
  await expect.poll(() => state.sendBodies.length).toBe(1);
  await expect(page.getByText("Both drafts are ready for review.", { exact: true })).toBeVisible();
  await expect(page.getByText("shared-1.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("shared-2.pdf", { exact: true })).toBeVisible();
  await expect.poll(() => state.presence.some((entry) => entry.method === "POST" && entry.body.caseId === MATTER_ID)).toBe(true);
});

test("message and attachment drafts survive same-document matter tab changes", async ({ page }) => {
  const state = { messages: initialMessages(), caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [] };
  await stubMessageWorkspace(page, state);
  await openMessages(page);
  await page.getByLabel("Write a message").fill("Keep this draft in this matter");
  await page.getByLabel("Attach files").setInputFiles({ name: "remember-me.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 draft") });

  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("region", { name: "Matter overview", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Messages", exact: true }).click();
  await expect(page.getByLabel("Write a message")).toHaveValue("Keep this draft in this matter");
  await expect(page.getByText("remember-me.pdf", { exact: true })).toBeVisible();
  expect(state.fileUploads).toHaveLength(0);
});

test("a failed attachment is retained for an explicit retry without duplicating successful evidence", async ({ page }) => {
  const state = { messages: initialMessages(), caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [], failNextUpload: true };
  await stubMessageWorkspace(page, state);
  await openMessages(page);
  await page.getByLabel("Attach files").setInputFiles({ name: "retry.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 retry") });
  await page.getByLabel("Write a message").fill("Send after the file succeeds");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  expect(state.sendBodies).toHaveLength(0);

  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.fileUploads.length).toBe(2);
  await expect.poll(() => state.sendBodies.length).toBe(1);
  expect(state.files).toHaveLength(1);
});

for (const destination of ['linked', 'unread', 'latest']) {
  test(`usability: ${destination} message is focused and visible in a long conversation`, async ({ page }) => {
    await installRealtimeHarness(page);
    const viewer = await page.request.get('/api/users/me').then(r => r.json());
    const viewerId = String(viewer._id || viewer.id);
    const messages = Array.from({ length: 80 }, (_, index) => ({ ...initialMessages()[0], _id: `64b000000000000000007${String(index).padStart(3, "0")}`, text: `Message ${index}: ${'Context for the document review. '.repeat(4)}`, createdAt: new Date(Date.UTC(2026, 8, 3, 14, index)).toISOString(), readBy: (destination === 'unread' && index >= 45) || index % 2 ? [] : [viewerId], readReceipts: !(destination === 'unread' && index >= 45) && index % 2 ? [{ user: viewerId, at: '2026-09-03T16:00:00.000Z' }] : [] }));
    const state = { messages, caseReads: 0, messageReads: 0, readBodies: [], sendBodies: [] };
    await stubMessageWorkspace(page, state);
    const target = destination === 'linked' ? '64b000000000000000007035' : destination === 'unread' ? '64b000000000000000007045' : '64b000000000000000007079';
    await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=messages${destination === 'linked' ? `&messageId=${target}` : ''}`);
    const item = page.locator(`[data-message-id="${target}"]`);
    await expect(item).toBeFocused();
    await expect(item).toBeInViewport();
    if (destination === 'linked') {
      await page.evaluate(id => { location.hash = `/matter/${id}?tab=messages&messageId=64b000000000000000007055`; }, MATTER_ID);
      await expect(page.locator('[data-message-id="64b000000000000000007055"]')).toBeFocused();
      await expect(page.locator('[data-message-id="64b000000000000000007055"]')).toBeInViewport();
    }
    await page.locator('[data-v2-message-input]').focus();
    const reads = state.messageReads;
    await page.evaluate(id => window.__emitV2Realtime(`/api/cases/${id}/stream`, 'messages', {}), MATTER_ID);
    await expect.poll(() => state.messageReads).toBeGreaterThan(reads);
    await expect(page.locator('[data-v2-message-input]')).toBeFocused();
  });
}
