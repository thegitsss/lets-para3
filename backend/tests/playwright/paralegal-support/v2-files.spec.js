const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const MATTER_ID = "64b000000000000000000821";
const FIRST_FILE_ID = "64b000000000000000000822";
const UPLOADED_FILE_ID = "64b000000000000000000823";

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
    files: [],
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

function initialFiles() {
  return [{
    id: FIRST_FILE_ID,
    originalName: "Witness outline.pdf",
    mimeType: "application/pdf",
    size: 12400,
    securityStatus: "not_required",
    securityScanResult: "NOT_REQUIRED",
    uploadedAt: "2026-09-03T14:00:00.000Z",
    uploadedByRole: "attorney",
    status: "pending_review",
    version: 1,
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

async function stubFileWorkspace(page, state, { denyUpload = false } = {}) {
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "phase-8b-csrf" }));
  await page.route(`**/api/cases/${MATTER_ID}/stream`, (route) => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `event: ready\ndata: {"caseId":"${MATTER_ID}"}\n\n`,
  }));
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => {
    state.caseReads += 1;
    if (state.denied) return json(route, { error: "Matter access is no longer available" }, 403);
    return json(route, activeMatter());
  });
  await page.route(`**/api/uploads/case/${MATTER_ID}/*/security-status`, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const file = state.files.find((entry) => entry.id === id);
    state.securityChecks = (state.securityChecks || 0) + 1;
    if (!file) return json(route, { error: "File not found" }, 404);
    file.securityStatus = "clean";
    file.securityScanResult = "NO_THREATS_FOUND";
    return json(route, { fileId: id, securityStatus: "clean", securityScanResult: "NO_THREATS_FOUND", ready: true });
  });
  await page.route(`**/api/uploads/case/${MATTER_ID}/${FIRST_FILE_ID}/download`, (route) => route.fulfill({
    status: 200,
    contentType: "application/pdf",
    headers: { "Content-Disposition": "attachment; filename=\"Witness%20outline.pdf\"" },
    body: "%PDF-1.4\nphase 8b",
  }));
  await page.route(`**/api/uploads/case/${MATTER_ID}?presentation=matter`, async (route) => {
    if (route.request().method() === "GET") {
      state.fileReads += 1;
      return json(route, { files: state.files });
    }
    state.uploads += 1;
    if (denyUpload) {
      state.denied = true;
      return json(route, { error: "Access revoked" }, 403);
    }
    if (state.failNextUpload) {
      state.failNextUpload = false;
      return json(route, { error: "Uploads are temporarily unavailable." }, 503);
    }
    if (state.uploadGate) await state.uploadGate;
    const uploadNumber = state.uploads;
    const uploaded = {
      id: uploadNumber === 1 ? UPLOADED_FILE_ID : `64b00000000000000000082${uploadNumber + 2}`,
      originalName: uploadNumber === 1 ? "Exhibit index.pdf" : `Shared file ${uploadNumber}.pdf`,
      mimeType: "application/pdf",
      size: 28,
      securityStatus: "pending",
      securityScanResult: "PENDING",
      uploadedAt: "2026-09-03T14:05:00.000Z",
      uploadedByRole: "paralegal",
      status: "pending_review",
      version: 1,
    };
    state.files = [...state.files.filter((entry) => entry.id !== uploaded.id), uploaded];
    return json(route, { file: uploaded }, 201);
  });
}

async function openFiles(page, { fileId = "" } = {}) {
  const suffix = fileId ? `&fileId=${fileId}` : "";
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=files${suffix}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "matter");
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("heading", { name: "Files & submissions", exact: true })).toBeVisible();
  await expectFileActions(page);
}

async function expectFileActions(page, { cancel = false, retry = false, clear = false, progress = false } = {}) {
  for (const [key, visible] of Object.entries({ cancel, retry, clear, "progress-wrap": progress })) {
    const control = page.locator(`[data-v2-file-${key}]`);
    if (visible) await expect(control).toBeVisible(); else await expect(control).toBeHidden();
  }
  const submit = page.locator('[data-v2-file-form] button[type="submit"]');
  if (retry) await expect(submit).toBeHidden();
  else if (await submit.count()) await expect(submit).toBeVisible();
  const revealed = await page.evaluate(() => [...document.querySelectorAll('.lpc-v2 [hidden]:not([hidden="until-found" i])')]
    .filter(element => getComputedStyle(element).display !== 'none')
    .map(element => ({ tag: element.tagName, id: element.id, classes: element.className })));
  expect(revealed).toEqual([]);
}

test("selected files can be corrected and cleared before upload", async ({ page }) => {
  const state = { files: initialFiles(), caseReads: 0, fileReads: 0, uploads: 0 };
  await stubFileWorkspace(page, state);
  await openFiles(page);
  const input = page.locator("[data-v2-file-input]");
  await input.setInputFiles([
    { name: "Too large.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(21 * 1024 * 1024) },
    { name: "Correct.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
  ]);
  await expect(page.locator("[data-v2-file-selection-list]")).toContainText("20 MB");
  await page.getByRole("button", { name: "Remove Too large.pdf", exact: true }).click();
  await expect(page.locator("[data-v2-file-selection-list]")).not.toContainText("Too large.pdf");
  await expect(page.getByRole("button", { name: "Submit file", exact: true })).toBeEnabled();
  await expectFileActions(page, { clear: true });
  await page.getByRole("button", { name: "Clear selected files", exact: true }).click();
  await expect(page.getByRole("button", { name: "Submit file", exact: true })).toBeDisabled();
  await expectFileActions(page);
  expect(state.uploads).toBe(0);
});

test("upload is server-confirmed, duplicate-guarded, and download uses the authorized file route", async ({ page }) => {
  let releaseUpload;
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  const state = { files: initialFiles(), caseReads: 0, fileReads: 0, uploads: 0, uploadGate };
  await stubFileWorkspace(page, state);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFiles(page, { fileId: FIRST_FILE_ID });

  await expect(page.locator(`[data-file-id="${FIRST_FILE_ID}"]`)).toBeFocused();

  await page.evaluate(() => {
    window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.phase8bIdentity = "same-sidebar";
    window.__LPC_PARALEGAL_V2__.shell.header.dataset.phase8bIdentity = "same-header";
    window.__phase8bNavigations = performance.getEntriesByType("navigation").length;
  });
  const input = page.locator("[data-v2-file-input]");
  await input.setInputFiles({ name: "Exhibit index.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nphase 8b upload") });
  await page.getByRole("button", { name: "Submit file", exact: true }).click();
  await page.getByRole("dialog", { name: "Submit this file?" }).getByRole("button", { name: "Submit file" }).dblclick();
  await expect.poll(() => state.uploads).toBe(1);
  await expect(page.getByRole("button", { name: "Submitting…" })).toBeDisabled();
  await expectFileActions(page, { cancel: true, clear: true, progress: true });
  releaseUpload();
  await expect(page.getByText("Exhibit index.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("Security check in progress", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
  await expect.poll(() => state.securityChecks).toBe(1);
  await expect(page.getByText("The file is ready to download.", { exact: true })).toBeVisible();
  expect(state.securityChecks).toBe(1);
  await expectFileActions(page);
  await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Open", exact: true }).first()).toHaveAttribute("href", new RegExp(`/api/uploads/case/${MATTER_ID}/${FIRST_FILE_ID}/download\\?preview=true$`));
  await expect(page.getByRole("button", { name: "Download", exact: true })).toHaveCount(2);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Witness outline.pdf");

  const continuity = await page.evaluate(() => ({
    sidebar: window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.phase8bIdentity,
    header: window.__LPC_PARALEGAL_V2__.shell.header.dataset.phase8bIdentity,
    navigations: performance.getEntriesByType("navigation").length,
    initialNavigations: window.__phase8bNavigations,
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

test("pending file security reconciles automatically and keeps the manual fallback bounded", async ({ page }) => {
  const pendingId = "64b000000000000000000824";
  const state = {
    files: [{
      id: pendingId,
      originalName: "Pending evidence.pdf",
      mimeType: "application/pdf",
      size: 240,
      securityStatus: "pending",
      securityScanResult: "PENDING",
      uploadedAt: "2026-09-03T14:00:00.000Z",
      uploadedByRole: "attorney",
      status: "pending_review",
      version: 1,
    }],
    caseReads: 0,
    fileReads: 0,
    uploads: 0,
  };
  await stubFileWorkspace(page, state);
  await openFiles(page);

  await expect(page.getByRole("button", { name: "Check status", exact: true })).toBeVisible();
  await expect.poll(() => state.securityChecks).toBe(1);
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await expect(page.getByText("Available", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check status", exact: true })).toHaveCount(0);
  expect(state.securityChecks).toBe(1);
});

test("an unavailable security check can be refreshed without exposing a blocked download", async ({ page }) => {
  const state = { files: [{ ...initialFiles()[0], securityStatus: 'error', securityScanResult: 'ERROR' }], caseReads: 0, fileReads: 0, uploads: 0 };
  await stubFileWorkspace(page, state); await openFiles(page);
  await expect(page.getByText('Security check unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
  expect(state.securityChecks || 0).toBe(0);
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
  await expect(page.getByText('Security check unavailable', { exact: true })).toHaveCount(0);
  expect(state.securityChecks).toBe(1); expect(state.uploads).toBe(0);
});

test("a failed upload preserves the selected file for an explicit retry", async ({ page }) => {
  const state = { files: initialFiles(), caseReads: 0, fileReads: 0, uploads: 0, failNextUpload: true };
  await stubFileWorkspace(page, state);
  await openFiles(page);

  const input = page.locator("[data-v2-file-input]");
  await input.setInputFiles({ name: "Exhibit index.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nretry") });
  await page.getByRole("button", { name: "Submit file", exact: true }).click();
  await page.getByRole("dialog", { name: "Submit this file?" }).getByRole("button", { name: "Submit file" }).click();
  await expect(page.getByText("Exhibit index.pdf could not be submitted. Retry the unfinished files.", { exact: true })).toBeVisible();
  await expect(page.getByText("Exhibit index.pdf", { exact: true })).toBeVisible();
  expect(await input.evaluate((element) => element.files.length)).toBe(0);
  await expectFileActions(page, { retry: true, clear: true });
  await expect(page.getByRole("button", { name: "Clear selected files", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Remove Exhibit index.pdf", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "Try upload again", exact: true }).click();
  await expect(page.getByText("Submission received. The file will be available after its security check.", { exact: true })).toBeVisible();
  expect(state.uploads).toBe(2);
  await expectFileActions(page);
});

test("stopping an upload exposes retry controls only after the in-flight request settles", async ({ page }) => {
  let releaseUpload;
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const state = { files: initialFiles(), caseReads: 0, fileReads: 0, uploads: 0, uploadGate };
  await stubFileWorkspace(page, state); await openFiles(page);
  await page.locator('[data-v2-file-input]').setInputFiles({ name: 'Selected exhibit.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic selected exhibit') });
  await page.getByRole('button', { name: 'Submit file', exact: true }).click();
  await page.getByRole('dialog', { name: 'Submit this file?' }).getByRole('button', { name: 'Submit file' }).click();
  await expect.poll(() => state.uploads).toBe(1);
  try {
    await expectFileActions(page, { cancel: true, clear: true, progress: true });
    await expect(page.getByRole('button', { name: 'Clear selected files', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Remove Selected exhibit.txt', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel upload', exact: true }).click();
    await expect(page.locator('[data-v2-file-status]')).toContainText('Stopped waiting for upload.');
    await expectFileActions(page, { retry: true, clear: true });
    await expect(page.getByRole('button', { name: 'Remove Selected exhibit.txt', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Clear selected files', exact: true }).click();
    await expectFileActions(page);
  } finally { releaseUpload(); }
});

test("several selected files upload concurrently and clear only after server confirmation", async ({ page }) => {
  let releaseUploads;
  const uploadGate = new Promise((resolve) => { releaseUploads = resolve; });
  const state = { files: initialFiles(), caseReads: 0, fileReads: 0, uploads: 0, uploadGate };
  await stubFileWorkspace(page, state);
  await openFiles(page);

  const input = page.locator("[data-v2-file-input]");
  await input.setInputFiles([
    { name: "Exhibit index.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\none") },
    { name: "Witness notes.txt", mimeType: "text/plain", buffer: Buffer.from("two") },
    { name: "Damages.csv", mimeType: "text/csv", buffer: Buffer.from("three") },
  ]);
  await expect(page.getByText("3 files selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Submit files", exact: true }).click();
  await page.getByRole("dialog", { name: "Submit 3 files?" }).getByRole("button", { name: "Submit files" }).click();
  await expect.poll(() => state.uploads).toBe(3);
  await expect(page.getByRole("button", { name: "Submitting…" })).toBeDisabled();
  releaseUploads();
  await expect(page.getByText(/3 files received/)).toBeVisible();
  await expect(page.locator('[data-v2-file-selected]')).toBeHidden();
});

test("stale authorization purges file content and revalidates the matter authority", async ({ page }) => {
  const state = { files: initialFiles(), caseReads: 0, fileReads: 0, uploads: 0, denied: false };
  await stubFileWorkspace(page, state, { denyUpload: true });
  await openFiles(page);

  await page.locator("[data-v2-file-input]").setInputFiles({ name: "Exhibit index.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nstale") });
  await page.getByRole("button", { name: "Submit file", exact: true }).click();
  await page.getByRole("dialog", { name: "Submit this file?" }).getByRole("button", { name: "Submit file" }).click();
  await expect(page.getByRole("heading", { name: "You no longer have access to this matter" })).toBeVisible();
  await expect(page.getByText("Witness outline.pdf", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-v2-file-input]")).toHaveCount(0);
  expect(state.caseReads).toBeGreaterThanOrEqual(2);
});

test("another open V2 tab receives the server-confirmed file list without reloading", async ({ context }) => {
  const state = { files: initialFiles(), caseReads: 0, fileReads: 0, uploads: 0 };
  const first = await context.newPage();
  const second = await context.newPage();
  await stubFileWorkspace(first, state);
  await stubFileWorkspace(second, state);
  await openFiles(first);
  await openFiles(second);
  const secondNavigations = await second.evaluate(() => performance.getEntriesByType("navigation").length);

  await first.locator("[data-v2-file-input]").setInputFiles({ name: "Exhibit index.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nsync") });
  await first.getByRole("button", { name: "Submit file", exact: true }).click();
  await first.getByRole("dialog", { name: "Submit this file?" }).getByRole("button", { name: "Submit file" }).click();
  await expect(first.getByText("Exhibit index.pdf", { exact: true })).toBeVisible();
  await expect(second.getByText("Exhibit index.pdf", { exact: true })).toBeVisible();
  expect(await second.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(secondNavigations);
  await first.close();
  await second.close();
});

test("an attorney file event appears immediately without navigation or manual refresh", async ({ page }) => {
  const state = { files: initialFiles(), caseReads: 0, fileReads: 0, uploads: 0 };
  await installRealtimeHarness(page);
  await stubFileWorkspace(page, state);
  await openFiles(page);
  const navigationCount = await page.evaluate(() => performance.getEntriesByType("navigation").length);

  state.files = [...state.files, {
    id: "64b000000000000000000825",
    originalName: "Attorney production request.pdf",
    mimeType: "application/pdf",
    size: 8900,
    securityStatus: "not_required",
    securityScanResult: "NOT_REQUIRED",
    uploadedAt: "2026-09-03T14:06:00.000Z",
    uploadedByRole: "attorney",
    status: "pending_review",
    version: 1,
  }];
  await page.evaluate((matterId) => {
    window.__emitV2Realtime(`/api/cases/${matterId}/stream`, "documents", { matterId });
  }, MATTER_ID);

  await expect(page.getByText("Attorney production request.pdf", { exact: true })).toBeVisible({ timeout: 2_000 });
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(navigationCount);
});

test("completed matter deep links fail closed without exposing retained file metadata", async ({ page }) => {
  let fileEndpointCalls = 0;
  await page.route(url => url.pathname === `/api/cases/${MATTER_ID}`, (route) => json(route, { error: "Completed matters are no longer accessible." }, 403));
  await page.route(`**/api/uploads/case/${MATTER_ID}**`, (route) => {
    fileEndpointCalls += 1;
    return json(route, { error: "Uploads are closed for this matter." }, 403);
  });
  await page.goto(`/paralegal-v2.html#/matter/${MATTER_ID}?tab=files`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "You no longer have access to this matter" })).toBeVisible();
  await expect(page.getByText("Witness outline.pdf", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-v2-file-input]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /download|check status|upload/i })).toHaveCount(0);
  expect(fileEndpointCalls).toBe(0);
});

test("the file panel stays bounded at required widths and with the Assistant open", async ({ page }) => {
  const state = { files: initialFiles(), caseReads: 0, fileReads: 0, uploads: 0 };
  await stubFileWorkspace(page, state);
  await openFiles(page);
  await page.locator("[data-v2-file-input]").setInputFiles({ name: "A very long exhibit index filename that must stay within the workspace.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nresponsive") });

  for (const width of [320, 360, 375, 390, 430, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: width <= 430 ? 844 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    const geometry = await page.locator("[data-v2-file-panel]").evaluate((panel) => {
      const box = panel.getBoundingClientRect();
      return { left: box.left, right: box.right, viewport: document.documentElement.clientWidth };
    });
    expect(geometry.left, `${width}px file panel left edge`).toBeGreaterThanOrEqual(0);
    expect(geometry.right, `${width}px file panel right edge`).toBeLessThanOrEqual(geometry.viewport + 1);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Open LPC Assistant" }).click();
  await expect(page.locator("body")).toHaveClass(/support-drawer-open/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByText("A very long exhibit index filename that must stay within the workspace.pdf", { exact: true })).toBeVisible();
});
