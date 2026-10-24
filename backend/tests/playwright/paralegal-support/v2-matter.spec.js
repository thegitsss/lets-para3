const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const MATTER_ID = "64b000000000000000000711";
const FILE_ID = "64b000000000000000000712";
const MESSAGE_ID = "64b000000000000000000713";
let sessionOwner;

test.beforeEach(async ({ page }) => {
  const response = await page.request.get('/api/auth/me');
  expect(response.status()).toBe(200);
  const { user } = await response.json();
  expect(user.role).toBe('paralegal');
  sessionOwner = String(user.id || user._id);
});

async function json(route, payload, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function activeMatter(overrides = {}) {
  return {
    _id: MATTER_ID,
    id: MATTER_ID,
    title: "Discovery response support",
    status: "in progress",
    practiceArea: "Civil Litigation",
    state: "New York",
    locationState: "New York",
    details: "Prepare, organize, and quality-check the verified discovery response set.",
    deadlineDate: "2026-09-12",
    hiredAt: "2026-08-29T14:00:00.000Z",
    archived: false,
    readOnly: false,
    paymentReleased: false,
    files: [{
      id: FILE_ID,
      original: "Interrogatory responses.pdf",
      size: 82000,
      uploadedAt: "2026-09-01T14:00:00.000Z",
      uploadedByRole: "paralegal",
      status: "pending_review",
      version: 2,
    }],
    matterExperience: {
      version: 1,
      header: {
        title: "Discovery response support",
        status: { code: "in_progress", label: "In progress" },
        practiceArea: "Civil Litigation",
        deadline: "2026-09-12",
        relationship: "Assigned paralegal",
        attention: null,
        primaryAction: { code: "continue_work", label: "Continue work", tab: "work" },
      },
      sections: [
        { id: "overview", label: "Overview" },
        { id: "work", label: "Work" },
        { id: "files", label: "Files" },
        { id: "messages", label: "Messages" },
        { id: "deadlines", label: "Deadlines" },
        { id: "activity", label: "Activity" },
        { id: "financials", label: "Payments" },
      ],
      overview: {
        summary: "Prepare, organize, and quality-check the verified discovery response set.",
        practiceArea: "Civil Litigation",
        jurisdiction: "New York",
        deadline: "2026-09-12",
        hiredAt: "2026-08-29T14:00:00.000Z",
        attorney: "Jordan Lee",
        paralegal: "Dana Young",
        paralegalId: sessionOwner,
        taskProgress: { completed: 1, total: 2 },
      },
      applications: null,
      work: {
        tasks: [{ title: "Draft responses", completed: true }, { title: "Prepare exhibits", completed: false }],
        readOnly: false,
        completed: 1,
        total: 2,
        withdrawal: { allowed: true, blockers: [], completedTaskCount: 1, totalTaskCount: 2, outcomeRequiresReview: true },
        dispute: { allowed: true, blockers: [] },
      },
      activity: [
        { code: "file", label: "File shared", at: "2026-09-01T14:00:00.000Z" },
        { code: "started", label: "Work started", at: "2026-08-29T14:00:00.000Z" },
      ],
      financials: {
        version: 2, ownerId: sessionOwner, caseId: MATTER_ID, role: "paralegal", revision: "b".repeat(64),
        currency: "USD", state: "estimate", status: "Estimated payout", stripeMode: "test", receiptsAreEarlier: true, receipts: [], receiptHref: null,
        amounts: [{ code: "compensation", label: "Remaining funded budget", cents: 90000 }, { code: "paralegal_fee", label: "Estimated platform fee", cents: 10800 }, { code: "net", label: "Estimated payout", cents: 79200 }],
        note: "The estimate uses the remaining funded budget. It is not a recorded payout.",
      },
    },
    ...overrides,
  };
}

async function waitForMatter(page) {
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "matter");
  await expect.poll(() => page.evaluate(() => Boolean(window.__LPC_PARALEGAL_V2__?.shell))).toBe(true);
}

test("authorized matter reads remain inside the shell and the overview exposes no mutation controls", async ({ page }, testInfo) => {
  const nonGetRequests = [];
  page.on("request", (request) => {
    if (request.url().includes(`/api/cases/${MATTER_ID}`) || request.url().includes(`/api/messages/${MATTER_ID}`)) {
      if (request.method() !== "GET") nonGetRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, activeMatter()));
  await page.route(`**/api/uploads/case/${MATTER_ID}?presentation=matter`, (route) => json(route, { files: activeMatter().files }));
  await page.route(`**/api/messages/${MATTER_ID}`, (route) => json(route, {
    messages: [{
      _id: MESSAGE_ID,
      type: "text",
      text: "The draft responses are ready for review.",
      createdAt: "2026-09-02T13:30:00.000Z",
      senderId: { firstName: "Dana", lastName: "Young", role: "paralegal" },
    }],
  }));
  await page.route(`**/api/messages/${MATTER_ID}/read`, (route) => json(route, {
    updatedLegacy: 1,
    updatedReceipts: 1,
  }));
  await page.route(url => url.pathname === '/api/messages/threads', route => json(route, { total: 1, threads: [{ id: MATTER_ID, title: 'Discovery response support', participant: { id: '64b000000000000000000714', name: 'Jordan Lee', role: 'attorney' }, unread: 1, lastMessageSnippet: 'The draft responses are ready for review.', updatedAt: '2026-09-02T13:30:00.000Z' }] }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=overview`, { waitUntil: "domcontentloaded" });
  await waitForMatter(page);

  await expect(page.locator('.v2-matter-header-facts')).toHaveText('Attorney: Jordan Lee · Due Sep 12, 2026');
  await expect(page.locator('.v2-matter-next-action').getByRole('link', { name: 'Continue work' })).toHaveAttribute('href', new RegExp(`matter/${MATTER_ID}\\?tab=work`));
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.locator('.v2-app-frame').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return Math.abs(rect.right - innerWidth) < 2 && (innerWidth > 900 || (rect.left < 1 && rect.width >= innerWidth - 1));
    })).toBe(true);
    if (width <= 900) {
      await expect.poll(() => page.locator('.v2-matter-header-facts').evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(width - 80);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`matter-header-${width}.png`), fullPage: true });
  }

  await page.evaluate(() => {
    window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.phase7Identity = "same-sidebar";
    window.__LPC_PARALEGAL_V2__.shell.header.dataset.phase7Identity = "same-header";
  });
  await expect(page.getByRole("heading", { level: 1, name: "Discovery response support" })).toBeVisible();
  await expect(page.getByText("Jordan Lee", { exact: true })).toBeVisible();
  await expect(page.getByText("1 of 2 work items complete")).toBeVisible();
  await expect(page.getByRole("button", { name: /send|upload|complete|approve|revise/i })).toHaveCount(0);

  await page.getByRole("link", { name: "Work", exact: true }).click();
  await waitForMatter(page);
  await expect(page.getByText("Draft responses")).toBeVisible();
  await expect(page.getByText("Prepare exhibits")).toBeVisible();

  await page.getByRole("link", { name: "Files", exact: true }).click();
  await waitForMatter(page);
  await expect(page.getByText("Interrogatory responses.pdf")).toBeVisible();
  await expect(page.getByText("Submitted for review")).toBeVisible();

  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=messages&messageId=${MESSAGE_ID}`);
  await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', 'conversations');
  await expect(page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.av2-inbox-workspace').getByText("The draft responses are ready for review.", { exact: true })).toBeVisible();
  await expect(page.locator(`[data-message-id="${MESSAGE_ID}"]`)).toHaveClass(/is-highlighted/);

  const shell = await page.evaluate(() => ({
    sidebar: window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.phase7Identity,
    header: window.__LPC_PARALEGAL_V2__.shell.header.dataset.phase7Identity,
    navigations: performance.getEntriesByType("navigation").length,
  }));
  expect(shell).toEqual({ sidebar: "same-sidebar", header: "same-header", navigations: 1 });
  expect(nonGetRequests).toHaveLength(1);
  expect(nonGetRequests[0]).toContain(`/api/messages/${MATTER_ID}/read`);

  const violations = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.violations).toEqual([]);
});

test("the Work section shows the attorney-owned review handoff and refreshes from task events", async ({ page }, testInfo) => {
  let matter = activeMatter();
  const mutations = [];
  await page.addInitScript(() => {
    window.__v2MatterStreams = [];
    class MatterEventSource extends EventTarget {
      constructor(url) {
        super();
        this.url = String(url);
        this.readyState = 1;
        window.__v2MatterStreams.push(this);
      }

      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = MatterEventSource;
    window.__emitV2MatterEvent = (type, matterId) => {
      const stream = [...window.__v2MatterStreams].reverse().find((entry) => (
        entry.readyState === 1 && entry.url.includes(`/api/cases/${matterId}/stream`)
      ));
      stream?.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ matterId }) }));
    };
  });
  page.on("request", (request) => {
    if (request.url().includes(`/api/cases/${MATTER_ID}`) && request.method() !== "GET") {
      mutations.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, matter));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=work`, { waitUntil: "domcontentloaded" });
  await waitForMatter(page);

  const handoff = page.locator("[data-completion-state]");
  await expect(handoff).toHaveAttribute("data-completion-state", "attorney_task_review");
  await expect(handoff).toContainText("The attorney marks each item complete after review.");
  await expect(page.getByRole("button", { name: /complete|approve|release/i })).toHaveCount(0);

  matter = activeMatter();
  matter.matterExperience.work = {
    tasks: [{ title: "Draft responses", completed: true }, { title: "Prepare exhibits", completed: true }],
    readOnly: false,
    completed: 2,
    total: 2,
  };
  matter.matterExperience.overview.taskProgress = { completed: 2, total: 2 };
  await page.evaluate((matterId) => window.__emitV2MatterEvent("tasks", matterId), MATTER_ID);

  await expect(handoff).toHaveAttribute("data-completion-state", "attorney_completion");
  await expect(handoff).toHaveText("Awaiting final attorney review.");
  await expect(page.getByRole("button", { name: /complete|approve|release/i })).toHaveCount(0);
  // Closing work must not repeat completion or imply that a payment is settled.
  for (const paymentReleased of [false, true]) {
    matter.status = "completed";
    matter.completedAt = "2026-09-11T12:00:00.000Z";
    matter.readOnly = true;
    matter.paymentReleased = paymentReleased;
    matter.matterExperience.header.status = { code: "completed", label: "Completed" };
    matter.matterExperience.work.readOnly = true;
    // Reopen the document to verify direct entry into each retained state;
    // navigating to the identical hash would retain the existing workspace.
    await page.reload();
    await waitForMatter(page);
    await expect(page.locator('.v2-matter-status')).toHaveText('Completed');
    await expect(page.getByText(/Matter completed|The work is completed|Payment has been released/)).toHaveCount(0);
    await expect(page.getByText('Read-only record', { exact: true })).toBeVisible();
    await expect(page.locator('[data-matter-tab="financials"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /complete|approve|release|withdraw|dispute/i })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`completed-work-${paymentReleased ? 'released' : 'unreleased'}.png`) });
  }
  expect(mutations).toEqual([]);
});

test("eligible withdrawal explains the consequence, posts once, and returns to refreshed history", async ({ page }) => {
  let withdrawals = 0;
  await page.route(`**/api/cases/${MATTER_ID}/withdraw`, (route) => {
    withdrawals += 1;
    return json(route, {
      ok: true,
      status: "paused",
      pausedReason: "paralegal_withdrew",
      withdrawalOutcome: "awaiting_attorney_decision",
      message: "You withdrew from this matter. The attorney will now decide whether to issue a partial payout based on completed work.",
    });
  });
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, activeMatter()));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=work`, { waitUntil: "domcontentloaded" });
  await waitForMatter(page);

  await page.locator(".v2-matter-options > summary").click();
  await page.getByRole("button", { name: "Withdraw from matter", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Withdraw from this matter?" });
  await expect(dialog).toContainText("The attorney will review the completed work and decide whether a partial payout is appropriate.");
  await dialog.getByRole("button", { name: "Withdraw from matter", exact: true }).dblclick();

  await expect.poll(() => withdrawals).toBe(1);
  await expect(page).toHaveURL(new RegExp(`#\\/work\\?section=history(?:&matterId=${MATTER_ID})?$`));
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "work");
  await expect(page.locator("[data-v2-persistent='sidebar']")).toBeVisible();
  await expect(page.locator("[data-v2-persistent='header']")).toBeVisible();
});

test("a withdrawal conflict keeps the workspace and requires a deliberate retry", async ({ page }) => {
  let withdrawals = 0;
  await page.route(`**/api/cases/${MATTER_ID}/withdraw`, (route) => {
    withdrawals += 1;
    return json(route, { error: "The matter changed before withdrawal could be recorded. Refresh before trying again." }, 409);
  });
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, activeMatter()));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=work`, { waitUntil: "domcontentloaded" });
  await waitForMatter(page);

  await page.locator(".v2-matter-options > summary").click();
  await page.getByRole("button", { name: "Withdraw from matter", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Withdraw from this matter?" });
  await dialog.getByRole("button", { name: "Withdraw from matter", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("The matter changed before withdrawal could be recorded.");
  await expect(dialog.getByRole("button", { name: "Withdraw from matter", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`#\\/matter\\/${MATTER_ID}\\?tab=work$`));
  expect(withdrawals).toBe(1);
});

test("an eligible paralegal can open a work-quality dispute once and the workspace closes for review", async ({ page }) => {
  let disputes = 0;
  let submittedMessage = "";
  await page.route(`**/api/disputes/${MATTER_ID}`, async (route) => {
    disputes += 1;
    submittedMessage = (await route.request().postDataJSON()).message;
    return json(route, {
      dispute: { _id: "64b000000000000000000799", status: "open", caseId: MATTER_ID },
      case: { _id: MATTER_ID, status: "disputed" },
    });
  });
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, activeMatter()));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=work`, { waitUntil: "domcontentloaded" });
  await waitForMatter(page);

  await page.locator(".v2-matter-options > summary").click();
  await page.getByRole("button", { name: "Open dispute", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open a dispute?" });
  await expect(dialog).toContainText("pauses the workspace for both parties while LPC reviews it");
  await dialog.getByLabel("What should LPC know?").fill("The delivered scope needs LPC review.");
  await dialog.getByRole("button", { name: "Open dispute", exact: true }).dblclick();

  await expect.poll(() => disputes).toBe(1);
  expect(submittedMessage).toBe("The delivered scope needs LPC review.");
  await expect(page).toHaveURL(new RegExp(`#\\/work\\?section=history(?:&matterId=${MATTER_ID})?$`));
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "work");
  await expect(page.locator("[data-v2-persistent='sidebar']")).toBeVisible();
  await expect(page.locator("[data-v2-persistent='header']")).toBeVisible();
});

test("a live completion event removes the stale workspace instead of exposing completed work", async ({ page }) => {
  let accessible = true;
  await page.addInitScript(() => {
    window.__v2MatterStreams = [];
    class MatterEventSource extends EventTarget {
      constructor(url) {
        super();
        this.url = String(url);
        this.readyState = 1;
        window.__v2MatterStreams.push(this);
      }

      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = MatterEventSource;
    window.__emitV2MatterEvent = (type, matterId) => {
      const stream = [...window.__v2MatterStreams].reverse().find((entry) => (
        entry.readyState === 1 && entry.url.includes(`/api/cases/${matterId}/stream`)
      ));
      stream?.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ matterId }) }));
    };
  });
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => (
    accessible ? json(route, activeMatter()) : json(route, { error: "Completed matters are no longer accessible." }, 403)
  ));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=work`, { waitUntil: "domcontentloaded" });
  await waitForMatter(page);
  await expect(page.getByRole("heading", { name: "Discovery response support", level: 1 })).toBeVisible();

  accessible = false;
  await page.evaluate((matterId) => window.__emitV2MatterEvent("case", matterId), MATTER_ID);

  await expect(page).toHaveURL(/#\/work$/);
  await expect(page.getByRole("heading", { name: "Matters", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Discovery response support")).toHaveCount(0);
  await expect(page.locator("[data-v2-persistent='sidebar']")).toBeVisible();
  await expect(page.locator("[data-v2-persistent='header']")).toBeVisible();
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
});

test("forbidden and missing matter responses disclose no previous workspace data", async ({ page }) => {
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, { error: "Matter not found" }, 404));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=overview`, { waitUntil: "domcontentloaded" });
  await waitForMatter(page);
  await expect(page.getByRole("heading", { name: "Matter not found" })).toBeVisible();
  await expect(page.getByText("Discovery response support")).toHaveCount(0);
  await expect(page.locator("[data-v2-persistent='sidebar']")).toBeVisible();
  await expect(page.locator("[data-v2-persistent='header']")).toBeVisible();
});

test("an expired session during a matter read leaves the protected shell", async ({ page }) => {
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, { error: "Please sign in" }, 401));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=overview`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/login\.html\?next=/);
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=overview`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a visible-tab access loss replaces confidential matter content after revalidation", async ({ page }) => {
  let reads = 0;
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => {
    reads += 1;
    return reads === 1 ? json(route, activeMatter()) : json(route, { error: "Matter not found" }, 403);
  });
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=overview`, { waitUntil: "domcontentloaded" });
  await waitForMatter(page);
  await expect(page.getByRole("heading", { name: "Discovery response support", level: 1 })).toBeVisible();

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "You no longer have access to this matter" })).toBeVisible();
  await expect(page.getByText("Discovery response support")).toHaveCount(0);
  expect(reads).toBeGreaterThanOrEqual(2);
});

test("the read-only workspace remains bounded with the Assistant closed and open", async ({ page }) => {
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, activeMatter()));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=overview`, { waitUntil: "domcontentloaded" });
  await waitForMatter(page);
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("body")).toHaveClass(/support-drawer-open/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator("[data-v2-matter]")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator(".support-drawer")).toBeVisible();

  for (const width of [320, 360, 375, 390, 430, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: width <= 430 ? 844 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const geometry = await page.locator("[data-v2-matter]").evaluate((matter) => {
      const matterBox = matter.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth;
      return { left: matterBox.left, right: matterBox.right, viewport };
    });
    expect(geometry.left, `${width}px matter left edge`).toBeGreaterThanOrEqual(0);
    expect(geometry.right, `${width}px matter right edge`).toBeLessThanOrEqual(geometry.viewport + 1);
  }
});

test('office polish: existing matter sections stay bounded and readable in both themes', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, route => json(route, activeMatter()));
  await page.route(`**/api/uploads/case/${MATTER_ID}?presentation=matter`, route => json(route, { files: activeMatter().files }));
  await page.route(`**/api/messages/${MATTER_ID}`, route => json(route, { messages: [] }));
  await page.route(`**/api/messages/${MATTER_ID}/read`, route => json(route, { updatedLegacy: 0, updatedReceipts: 0 }));
  await page.route(url => url.pathname === '/api/messages/threads', route => json(route, { total: 1, threads: [{ id: MATTER_ID, title: 'Discovery response support', participant: { id: '64b000000000000000000714', name: 'Jordan Lee', role: 'attorney' }, unread: 0, lastMessageSnippet: '', updatedAt: '2026-09-02T13:30:00.000Z' }] }));
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=overview`);
  await waitForMatter(page);
  for (const tab of ['overview', 'work', 'files', 'activity', 'financials', 'messages']) {
    await page.locator(`[data-matter-tab="${tab}"]`).click();
    if (tab === 'messages') {
      await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', 'conversations');
      await expect(page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state', 'ready');
    } else await waitForMatter(page);
    if (tab === 'financials') {
      const payments = page.locator('[data-matter-payments]');
      await expect(payments).toHaveAttribute('data-state', 'estimate');
      await expect(payments.locator('[data-amount-code="compensation"] dd')).toHaveText('$900.00');
      await expect(payments.locator('[data-amount-code="net"] dd')).toHaveText('$792.00');
      await expect(payments.getByText('Estimated payout', { exact: true })).toHaveCount(1);
    }
    await require('./office-polish-review').reviewOffice(page, testInfo, `matter-${tab}`, { widths: [1440, 320] });
  }
});


test('hierarchy: matter options stay quiet until opened and preserve confirmation authority', async ({ page }, testInfo) => {
  let mutations = 0;
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, route => json(route, activeMatter()));
  await page.route(`**/api/cases/${MATTER_ID}/withdraw`, route => { mutations++; return json(route, {}); });
  await page.route(`**/api/disputes/${MATTER_ID}`, route => { mutations++; return json(route, {}); });
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=work`);
  await waitForMatter(page);
  const options = page.locator('.v2-matter-options');
  const summary = options.locator('summary');
  await expect(options.getByRole('button', { name: 'Withdraw from matter', exact: true })).toBeHidden();
  await expect(page.locator('.v2-matter-task-list')).toBeVisible();
  await summary.focus();
  await page.keyboard.press('Enter');
  const withdraw = options.getByRole('button', { name: 'Withdraw from matter', exact: true });
  await withdraw.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Keep working', exact: true }).click();
  await expect(withdraw).toBeFocused();
  expect(mutations).toBe(0);
  await require('./office-polish-review').reviewOffice(page, testInfo, 'matter-options', { widths: [1440, 320] });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(withdraw).toBeHidden();
  await expect(summary).toBeFocused();
});

test('Matter section names and positions match the shared role hierarchy', async ({page}) => {
 await page.route(url=>url.pathname===`/api/cases/${MATTER_ID}`,route=>json(route,activeMatter()));
 await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=overview`);
 await waitForMatter(page);
 await expect(page.getByRole('navigation',{name:'Matter workspace sections'}).getByRole('link')).toHaveText(['Overview','Work','Files','Messages','Deadlines','Activity','Financials']);
 await expect(page.getByRole('link',{name:'Back to Matters',exact:true})).toHaveAttribute('href','paralegal-v2.html#/work');
});

test('Matter tabs preserve safe Home and list return context', async ({page}) => {
 await page.route(url=>url.pathname===`/api/cases/${MATTER_ID}`,route=>json(route,activeMatter()));
 const list=`/work?section=active&appQuery=Alex+Lee&highlightCase=${MATTER_ID}`;
 for (const [source,target,label] of [[list,list,'Back to Matters'],['/home','/home','Back to Home'],['https://outside.test','/work','Back to Matters']]) {
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?`+new URLSearchParams({tab:'overview',returnTo:source}));
  await waitForMatter(page);
  await page.locator('[data-matter-tab="activity"]').click();
  await waitForMatter(page);
  expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('returnTo')).toBe(target);
  const back=page.getByRole('link',{name:label,exact:true});
  await expect(back).toHaveAttribute('href','paralegal-v2.html#'+target);
  await back.click();await expect.poll(()=>new URL(page.url()).hash).toBe('#'+target);
 }
});
