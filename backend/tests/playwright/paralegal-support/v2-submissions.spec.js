const { eventPage } = require("./event-page-fixture");
const { receivedInvitations } = require("./received-invitation-fixture");
const { installNotificationReads } = require("./notification-fixtures");
const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const MATTER_ID = "64b000000000000000000831";
const ATTORNEY_FILE_ID = "64b000000000000000000832";
const PENDING_FILE_ID = "64b000000000000000000833";
const REVISION_FILE_ID = "64b000000000000000000834";
const APPROVED_FILE_ID = "64b000000000000000000835";
const NEW_FILE_ID = "64b000000000000000000836";

async function json(route, payload, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function matter(overrides = {}) {
  return {
    id: MATTER_ID,
    _id: MATTER_ID,
    title: "Discovery response support",
    status: "in progress",
    archived: false,
    readOnly: false,
    paymentReleased: false,
    files: [],
    matterExperience: {
      version: 1,
      header: { title: "Discovery response support", status: { code: "in_progress", label: "In progress" }, relationship: "Assigned paralegal" },
      sections: [
        { id: "overview", label: "Overview" },
        { id: "work", label: "Work" },
        { id: "files", label: "Files" },
        { id: "messages", label: "Messages" },
        { id: "activity", label: "Activity" },
      ],
      overview: { attorney: "Jordan Lee", taskProgress: { completed: 0, total: 1 } },
      work: { tasks: [{ title: "Prepare responses", completed: false }], readOnly: false, completed: 0, total: 1 },
      activity: [],
      financials: { currency: "usd", amounts: [] },
    },
    ...overrides,
  };
}

function files() {
  return [
    {
      id: ATTORNEY_FILE_ID,
      originalName: "Attorney notes.pdf",
      size: 1100,
      securityStatus: "not_required",
      uploadedAt: "2026-09-03T13:00:00.000Z",
      uploadedByRole: "attorney",
      status: "pending_review",
      version: 1,
    },
    {
      id: PENDING_FILE_ID,
      originalName: "Draft responses.docx",
      size: 2400,
      securityStatus: "not_required",
      uploadedAt: "2026-09-03T14:00:00.000Z",
      uploadedByRole: "paralegal",
      status: "pending_review",
      version: 1,
    },
    {
      id: REVISION_FILE_ID,
      originalName: "Privilege log.xlsx",
      size: 3800,
      securityStatus: "not_required",
      uploadedAt: "2026-09-03T14:10:00.000Z",
      uploadedByRole: "paralegal",
      status: "attorney_revision",
      version: 1,
      revisionNotes: "Add the two attachments identified in the attorney notes.",
      revisionRequestedAt: "2026-09-03T14:30:00.000Z",
    },
    {
      id: APPROVED_FILE_ID,
      originalName: "Exhibit index.pdf",
      size: 4400,
      securityStatus: "not_required",
      uploadedAt: "2026-09-03T14:20:00.000Z",
      uploadedByRole: "paralegal",
      status: "approved",
      version: 2,
      approvedAt: "2026-09-03T14:45:00.000Z",
    },
  ];
}

async function stubWorkspace(page, state, { denySubmission = false } = {}) {
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "phase-8d-csrf" }));
  await page.route(`**/api/cases/${MATTER_ID}/stream`, (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `event: ready\ndata: {"caseId":"${MATTER_ID}"}\n\n`,
  }));
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => {
    state.caseReads += 1;
    if (state.denied) return json(route, { error: "Matter access is no longer available" }, 403);
    return json(route, matter());
  });
  await page.route(`**/api/uploads/case/${MATTER_ID}/*/download`, (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    body: "%PDF-1.4\nphase 8d",
  }));
  await page.route(`**/api/uploads/case/${MATTER_ID}?presentation=matter`, async (route) => {
    if (route.request().method() === "GET") {
      state.fileReads += 1;
      return json(route, { files: state.files });
    }
    state.submissions += 1;
    state.uploadBody = route.request().postDataBuffer().toString();
    if (denySubmission) {
      state.denied = true;
      return json(route, { error: "Access revoked" }, 403);
    }
    if (state.submissionGate) await state.submissionGate;
    const submitted = {
      id: NEW_FILE_ID,
      originalName: "Updated privilege log.xlsx",
      size: 3200,
      securityStatus: "not_required",
      uploadedAt: "2026-09-03T15:00:00.000Z",
      uploadedByRole: "paralegal",
      status: "pending_review",
      version: state.uploadBody.includes('name="revisionOfFileId"') ? 3 : 1,
      ...(state.uploadBody.includes('name="revisionOfFileId"') ? { revisionOfFileId: REVISION_FILE_ID, revisionOfVersion: 2, revisionRequestAt: "2026-09-03T14:30:00.000Z" } : {}),
    };
    state.files = [...state.files, submitted];
    return json(route, { file: submitted }, 201);
  });
}

async function openFiles(page) {
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=files`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
  await expect.poll(() => page.evaluate(() => window.__LPC_PARALEGAL_V2__?.router?.getCurrentRoute?.())).toMatchObject({
    name: "matter",
    params: { matterId: MATTER_ID },
  });
  await expect(page.getByRole("heading", { name: "Files & submissions", exact: true })).toBeVisible();
}

async function stubHome(page, state) {
  await installNotificationReads(page.context(), { ownerId: "64b000000000000000000001" });
  await page.context().route('**/api/auth/me', route => json(route, {user:{id:'64b000000000000000000001',role:'paralegal',status:'approved',firstName:'Dana',lastName:'Young',onboarding:{paralegalTourCompleted:true,paralegalProfileTourCompleted:true}}}));
  await page.route(`**/api/uploads/case/${MATTER_ID}?presentation=matter`, route => json(route, {files:state.files}));
  await page.route('**/api/notifications', route => json(route, []));
  await page.route(url => url.pathname === "/api/paralegal/dashboard", (route) => {
    state.homeReads += 1;
    return json(route, {
      metrics: { activeCases: 1, earnings: 0, earningsTotal: 0, expectedPayouts: 0 },
      activeCases: [{
        caseId: MATTER_ID,
        paralegalId: "64b000000000000000000001",
        archived: false,
        paymentReleased: false,
        jobTitle: "Discovery response support",
        practiceArea: "Civil Litigation",
        attorneyName: "Jordan Lee",
        status: "in progress",
        deadlineDate: "2026-09-10",
        tasksTotal: 1,
        tasksRemaining: 1,
        escrowStatus: "funded",
        escrowIntentId: "pi_phase8d",
      }],
    });
  });
  await page.context().route("**/api/users/me", (route) => json(route, {
    _id: "64b000000000000000000001",
    firstName: "Dana",
    lastName: "Young",
    role: "paralegal",
    status: "approved",
    stateExperience: ["New York"],
    practiceAreas: ["Civil Litigation"],
    yearsExperience: 6,
    availability: "Available now",
  }));
  await page.route("**/api/payments/connect/status", (route) => json(route, { readiness: { ready: true } }));
  await page.route("**/api/jobs/recommended", (route) => json(route, { hasMatchingProfile: true, items: [] }));
  await page.route(url => url.pathname === "/api/cases/invited-to", route => json(route, receivedInvitations("64b000000000000000000001", [], new URL(route.request().url()).searchParams)));
  await page.route(url => url.pathname === "/api/events", route => json(route, eventPage("64b000000000000000000001", [], new URL(route.request().url()).searchParams)));
  await page.route("**/api/messages/threads?limit=50", (route) => json(route, { threads: [] }));
  await page.route("**/api/messages/unread-count", (route) => json(route, { count: 0 }));
  await page.route("**/api/applications/my", (route) => json(route, []));
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, {
    ...matter(),
    files: state.files,
    ...(state.submissionSummary ? { submissionSummary: state.submissionSummary } : {}),
    matterExperience: {
      ...matter().matterExperience,
      header: {
        ...matter().matterExperience.header,
        primaryAction: { label: "Continue work", tab: "work", detail: "Open this matter to continue your work." },
      },
      overview: { attorney: "Jordan Lee", summary: "Prepare the verified discovery response set.", taskProgress: { completed: 0, total: 1 } },
    },
  }));
}

test("shows the existing submission lifecycle without granting attorney controls", async ({ page }) => {
  const state = { files: files(), caseReads: 0, fileReads: 0, submissions: 0 };
  await stubWorkspace(page, state);
  await openFiles(page);

  await expect(page.getByText("Shared file", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Waiting for attorney review", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Submitted for review", { exact: true })).toBeVisible();
  await expect(page.getByText("Revisions requested", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await expect(page.getByText("Add the two attachments identified in the attorney notes.", { exact: true })).toBeVisible();
  await expect(page.locator(`[data-v2-revision-request="${REVISION_FILE_ID}"]`)).toContainText('Version 1');
  await expect(page.getByRole("button", { name: /request revisions|approve submission/i })).toHaveCount(0);

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose revised file", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "Privilege log.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("phase 8d") });
  await expect(page.getByText("Privilege log.xlsx", { exact: true })).toHaveCount(2);
});

test("requires confirmation, prevents duplicate submission, and trusts the refetched server state", async ({ page }) => {
  let releaseSubmission;
  const submissionGate = new Promise((resolve) => { releaseSubmission = resolve; });
  const state = { files: files(), caseReads: 0, fileReads: 0, submissions: 0, submissionGate };
  await stubWorkspace(page, state);
  await openFiles(page);

  await page.locator("[data-v2-file-input]").setInputFiles({ name: "Updated privilege log.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("phase 8d updated") });
  await page.getByRole("button", { name: "Submit file", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Submit this file?" })).toBeVisible();
  expect(state.submissions).toBe(0);
  await page.getByRole("button", { name: "Submit file", exact: true }).last().dblclick();
  await expect.poll(() => state.submissions).toBe(1);
  await expect(page.getByRole("button", { name: "Submitting…" })).toBeDisabled();
  releaseSubmission();
  await expect(page.getByText("Updated privilege log.xlsx", { exact: true })).toBeVisible();
  await expect(page.getByText("Submission received. The file is ready to download.", { exact: true })).toBeVisible();
  await expect(page.getByText("Submitted for review", { exact: true })).toHaveCount(2);
});

test("server-confirmed review changes synchronize across open matter tabs", async ({ context }) => {
  const state = { files: files().map((file) => ({ ...file })), caseReads: 0, fileReads: 0, submissions: 0 };
  state.files = state.files.filter((file) => file.id !== REVISION_FILE_ID && file.id !== APPROVED_FILE_ID);
  const first = await context.newPage();
  const second = await context.newPage();
  await stubWorkspace(first, state);
  await stubWorkspace(second, state);
  await openFiles(first);
  await openFiles(second);
  const navigationCount = await second.evaluate(() => performance.getEntriesByType("navigation").length);

  const pending = state.files.find((file) => file.id === PENDING_FILE_ID);
  pending.status = "attorney_revision";
  pending.revisionNotes = "Please add the missing service date.";
  pending.revisionRequestedAt = "2026-09-03T16:00:00.000Z";
  await first.evaluate((matterId) => {
    for (const name of [`lpc-v2-matter-files:${matterId}`, 'lpc-v2-files']) {
      const channel = new BroadcastChannel(name); channel.postMessage({ matterId, at: Date.now() }); channel.close();
    }
  }, MATTER_ID);

  await expect(second.getByText("Please add the missing service date.", { exact: true })).toBeVisible();
  expect(await second.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(navigationCount);
  await first.close();
  await second.close();
});

test("a confirmed review change reconciles an already-open Home work surface", async ({ context }) => {
  const state = {
    files: files().filter((file) => file.id === PENDING_FILE_ID).map((file) => ({ ...file })),
    caseReads: 0,
    fileReads: 0,
    submissions: 0,
    homeReads: 0,
  };
  const matterPage = await context.newPage();
  const homePage = await context.newPage();
  await stubWorkspace(matterPage, state);
  await stubHome(homePage, state);
  await openFiles(matterPage);
  await homePage.goto("/paralegal-v2.html#/home?view=reviews", { waitUntil: "domcontentloaded" });
  await expect(homePage.getByRole("tab", {name:/^Awaiting attorney/})).toContainText("1");
  await homePage.mouse.move(0,0);
  await homePage.evaluate(() => document.activeElement.blur());
  const initialHomeReads = state.homeReads;

  const pending = state.files[0];
  pending.status = "attorney_revision";
  pending.revisionNotes = "Add the missing service date.";
  pending.revisionRequestedAt = "2026-09-03T16:00:00.000Z";
  await matterPage.evaluate((matterId) => {
    for (const name of [`lpc-v2-matter-files:${matterId}`, 'lpc-v2-files']) {
      const channel = new BroadcastChannel(name); channel.postMessage({ matterId, at: Date.now() }); channel.close();
    }
  }, MATTER_ID);

  await expect(homePage.getByRole("tab", {name:/^Needs your action/})).toContainText("1");
  expect(state.homeReads).toBeGreaterThan(initialHomeReads);
  await matterPage.close();
  await homePage.close();
});

test("a stale submission fails closed and removes the inaccessible workspace", async ({ page }) => {
  const state = { files: files(), caseReads: 0, fileReads: 0, submissions: 0, denied: false };
  await stubWorkspace(page, state, { denySubmission: true });
  await openFiles(page);
  await page.locator("[data-v2-file-input]").setInputFiles({ name: "Updated privilege log.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("phase 8d stale") });
  await page.getByRole("button", { name: "Submit file", exact: true }).click();
  await page.getByRole("dialog", { name: "Submit this file?" }).getByRole("button", { name: "Submit file" }).click();
  await expect(page.getByRole("heading", { name: "You no longer have access to this matter" })).toBeVisible();
  await expect(page.getByText("Draft responses.docx", { exact: true })).toHaveCount(0);
  expect(state.submissions).toBe(1);
});

test("historical submission evidence stays read-only", async ({ page }) => {
  const retained = files();
  const completed = matter({ status: "completed", archived: true, readOnly: true, paymentReleased: true, files: retained });
  completed.matterExperience.header.status = { code: "completed", label: "Completed" };
  completed.matterExperience.work.readOnly = true;
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, completed));
  await openFiles(page);
  await expect(page.getByText("Add the two attachments identified in the attorney notes.", { exact: true })).toBeVisible();
  await expect(page.locator("[data-v2-file-input]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /submit file|choose revised file|download|check status/i })).toHaveCount(0);
});

test("submission review remains contained, shadow-free, and accessible across required widths", async ({ page }) => {
  const state = { files: files(), caseReads: 0, fileReads: 0, submissions: 0 };
  await stubWorkspace(page, state);
  await openFiles(page);
  for (const width of [320, 360, 375, 390, 430, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: width <= 430 ? 844 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const box = await page.locator("[data-v2-file-panel]").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth };
    });
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.viewport + 1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("body")).toHaveClass(/support-drawer-open/);
  await expect(page.getByText("Add the two attachments identified in the attorney notes.", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const violations = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.violations).toEqual([]);
});

test("usability: renamed revision is labeled before submission and linked after refresh", async ({ page }) => {
  const state = { files: files(), caseReads: 0, fileReads: 0, submissions: 0 };
  state.files.find(file => file.id === REVISION_FILE_ID).version = 2;
  await stubWorkspace(page, state);
  await openFiles(page);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose revised file', exact: true }).click();
  await (await chooserPromise).setFiles({ name: 'Updated privilege log.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('revised contents') });
  await expect(page.locator('[data-v2-file-selection-list]')).toContainText('Revision of Privilege log.xlsx · version 2');
  await page.getByRole('button', { name: 'Submit file', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit file', exact: true }).click();
  await expect.poll(() => state.submissions).toBe(1);
  expect(state.uploadBody).toContain('name="revisionOfFileId"');
  expect(state.uploadBody).toContain(REVISION_FILE_ID);
  expect(state.uploadBody).toContain('2026-09-03T14:30:00.000Z');
  await expect(page.locator(`[data-file-id="${NEW_FILE_ID}"]`)).toContainText('Revision of Privilege log.xlsx, version 2');
  await expect(page.locator(`[data-v2-revision-request="${REVISION_FILE_ID}"]`)).toContainText('Response submitted: Updated privilege log.xlsx');
  await page.reload();
  await expect(page.locator(`[data-file-id="${NEW_FILE_ID}"]`)).toContainText('Revision of Privilege log.xlsx, version 2');
});

test('follow-up: an approved revision clears Home urgency and resolves the original request in open Files', async ({ context }) => {
  const { projectRevisionResolutions } = require('../../../utils/revisionResolution');
  const original = { ...files().find(file => file.id === REVISION_FILE_ID), caseId: MATTER_ID };
  const response = { id: NEW_FILE_ID, caseId: MATTER_ID, originalName: 'Approved revised log.pdf', version: 2, revisionOfFileId: original.id, revisionOfVersion: 1, revisionRequestAt: original.revisionRequestedAt, uploadedByRole: 'paralegal', status: 'pending_review', securityStatus: 'not_required', uploadedAt: '2026-09-04T12:00:00Z' };
  const state = { files: [original, response], caseReads: 0, fileReads: 0, homeReads: 0, submissions: 0, submissionSummary: { totalFiles: 2, revisions: 1, awaitingReview: 1, approved: 0 } };
  const filePage = await context.newPage();
  const homePage = await context.newPage();
  await stubWorkspace(filePage, state);
  await stubHome(homePage, state);
  await openFiles(filePage);
  await homePage.goto('/paralegal-v2.html#/home?view=reviews');
  await expect(homePage.getByRole('tab', {name:/^Needs your action/})).toContainText('0');
  await expect(homePage.getByRole('tab', {name:/^Awaiting attorney/})).toContainText('1');
  await homePage.mouse.move(0,0);
  await homePage.evaluate(() => document.activeElement.blur());
  response.status = 'approved'; response.approvedAt = '2026-09-04T13:00:00Z';
  state.files = projectRevisionResolutions([original, response]);
  state.submissionSummary = { totalFiles: 2, revisions: 0, awaitingReview: 0, approved: 1 };
  await filePage.evaluate(matterId => {
    for (const name of [`lpc-v2-matter-files:${matterId}`, 'lpc-v2-files']) {
      const channel = new BroadcastChannel(name); channel.postMessage({ matterId }); channel.close();
    }
  }, MATTER_ID);
  const request = filePage.locator(`[data-v2-revision-request="${REVISION_FILE_ID}"]`);
  await expect(request).toContainText('Revision resolved');
  await expect(request).toContainText('Approved revision: Approved revised log.pdf, version 2.');
  await expect(request.getByRole('button', { name: 'Choose revised file' })).toHaveCount(0);
  await expect(homePage.getByRole('tab', {name:/^Needs your action/})).toHaveText('Needs your action0');
  await expect(homePage.getByRole('tab', {name:/^History/})).toContainText('2');
  await expect(filePage.locator(`[data-file-id="${REVISION_FILE_ID}"] [data-v2-submission-status]`)).toHaveAttribute('data-v2-submission-status', 'revision_resolved');
  await filePage.reload();
  await expect(request).toContainText('Revision resolved');
  await filePage.close(); await homePage.close();
});


test('matter-first: an inline revision draft survives file refresh and returns to the shared composer when mixed', async ({ page }) => {
  const state = { files: files(), caseReads: 0, fileReads: 0, submissions: 0 };
  await stubWorkspace(page, state);
  await openFiles(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose revised file', exact: true }).click();
  await (await chooser).setFiles({ name: 'Revised log.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('revision') });
  const form = page.locator('[data-v2-file-form]');
  await expect(form).toHaveAttribute('data-v2-revision-composer', REVISION_FILE_ID);
  await form.evaluate(element => { window.__revisionForm = element; });
  const submit = form.getByRole('button', { name: 'Submit file', exact: true });
  await submit.focus();
  state.files.find(file => file.id === PENDING_FILE_ID).status = 'approved';
  await page.evaluate(matterId => { const channel = new BroadcastChannel(`lpc-v2-matter-files:${matterId}`); channel.postMessage({ matterId }); channel.close(); }, MATTER_ID);
  await expect(page.locator(`[data-file-id="${PENDING_FILE_ID}"] [data-v2-submission-status]`)).toHaveAttribute('data-v2-submission-status', 'approved');
  expect(await form.evaluate(element => element === window.__revisionForm)).toBe(true);
  await expect(submit).toBeFocused();
  await expect(form.locator('[data-v2-file-selection-list]')).toContainText('Revision of Privilege log.xlsx · version 1');
  const otherChooser = page.waitForEvent('filechooser');
  await page.locator('[data-v2-file-picker]').click();
  await (await otherChooser).setFiles({ name: 'Separate note.txt', mimeType: 'text/plain', buffer: Buffer.from('separate note') });
  await expect(page.locator('[data-v2-file-compose-slot] > [data-v2-file-form]')).toBeVisible();
  await expect(form).not.toHaveAttribute('data-v2-revision-composer');
  await expect(form.locator('[data-v2-file-selection-list] li')).toHaveCount(2);
  expect(state.submissions).toBe(0);
  await form.getByRole('button', { name: 'Clear selected files', exact: true }).click();
  await expect(form.locator('[data-v2-file-selection-list] li')).toHaveCount(0);
});
