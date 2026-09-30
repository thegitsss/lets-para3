const { expect } = require('playwright/test');
const { test } = require('../workspace-search/shell-fixture');

test('a background file refresh during a selection press cannot leave the earlier document selected', async ({ page }) => {
  await page.route('**/attorney-v2.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/assets/styles/attorney-v2.css"></head><body><main></main></body></html>' }));
  await page.goto('/attorney-v2.html');
  await page.evaluate(async () => {
    const { createWorkspaceFiles } = await import('/assets/scripts/attorney-v2/workspace-files.mjs');
    const id = value => value.toString(16).padStart(24, '0'), caseId = id(1), ownerId = id(2);
    const files = [100, 99].map(value => ({ id: id(value), name: value === 100 ? 'Corrected filing.txt' : 'Original filing.txt', revision: 'd'.repeat(64), reviewRevision: 'e'.repeat(64), size: 40, version: 1, uploadedAt: null, securityStatus: 'clean', status: 'pending_review', uploadedByRole: 'paralegal', notes: '', requestedAt: null, approvedAt: null, replacedAt: null, revisionOf: null, mimeType: 'text/plain', canReview: true }));
    window.fileRefreshEvidence = { reads: 0, writes: [] };
    const api = {
      async readWorkspaceFiles(_caseId, { fileId }) {
        window.fileRefreshEvidence.reads++;
        return { caseId, ownerId, caseTitle: 'Filing review', access: 'available', legacyAttachments: false, canUpload: false, files: structuredClone(files), nextCursor: null, selection: fileId ? 'found' : 'none', selectedFile: structuredClone(files.find(file => file.id === fileId) || null) };
      },
      async updateWorkspaceFile(_caseId, fileId, input) {
        window.fileRefreshEvidence.writes.push({ fileId, status: input.status });
        const file = files.find(file => file.id === fileId);
        Object.assign(file, { status: input.status, reviewRevision: 'f'.repeat(64), approvedAt: new Date().toISOString() });
        return { file: structuredClone(file) };
      },
      async readWorkspaceUpload() { throw new Error('Sharing is outside this isolated file-selection fixture'); },
      async readWorkspaceFileHistory() { throw new Error('History is outside this isolated file-selection fixture'); },
    };
    const controller = new AbortController();
    const panel = createWorkspaceFiles(caseId, { api, signal: controller.signal, ownerId, route: { query: new URLSearchParams() }, privateState: { fileReviews: new Map() } });
    document.querySelector('main').append(panel);
    await panel.readiness;
  });
  const panel = page.locator('[data-workspace-files]'), detail = panel.getByRole('region', { name: 'Document review' });
  await expect(panel).toHaveAttribute('data-state', 'ready');
  await panel.getByRole('button', { name: 'Original filing.txt', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Original filing.txt', exact: true })).toBeVisible();
  const next = panel.getByRole('button', { name: 'Corrected filing.txt', exact: true });
  await next.hover(); await page.mouse.down();
  try {
    // The authorized background read completes while the native press is held.
    // Do not synthesize a click or retry a lost selection.
    await panel.evaluate(element => element.sync());
  } finally { await page.mouse.up(); }
  await expect(detail.getByRole('heading', { name: 'Corrected filing.txt', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Approve document', exact: true }).click();
  await expect(detail.locator('[data-file-confirm]')).toContainText('Approve “Corrected filing.txt”, version 1?');
  expect(await page.evaluate(() => window.fileRefreshEvidence.writes)).toEqual([]);
  await detail.getByRole('button', { name: 'Confirm approval', exact: true }).click();
  await expect(panel).toContainText('Document approved.');
  expect(await page.evaluate(() => window.fileRefreshEvidence.writes)).toEqual([{ fileId: (100).toString(16).padStart(24, '0'), status: 'approved' }]);
});

for (const interaction of ["native press", "idle refresh"]) test(`an in-flight background file read preserves document selection: ${interaction}`, async ({ page }) => {
  await page.route('**/attorney-v2.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/assets/styles/attorney-v2.css"></head><body><button id="outside">Outside files</button><main></main></body></html>' }));
  await page.goto('/attorney-v2.html');
  await page.evaluate(async () => {
    const { createWorkspaceFiles } = await import('/assets/scripts/attorney-v2/workspace-files.mjs');
    const id = value => value.toString(16).padStart(24, '0'), caseId = id(1), ownerId = id(2);
    const files = [100, 99].map(value => ({ id: id(value), name: value === 100 ? 'Corrected filing.txt' : 'Original filing.txt', revision: 'd'.repeat(64), reviewRevision: 'e'.repeat(64), size: 40, version: 1, uploadedAt: null, securityStatus: 'clean', status: 'pending_review', uploadedByRole: 'paralegal', notes: '', requestedAt: null, approvedAt: null, replacedAt: null, revisionOf: null, mimeType: 'text/plain', canReview: true }));
    window.fileRefreshEvidence = { reads: 0, writes: [] };
    window.renameOriginalFile = () => { files[1].name = "Saved original filing.txt"; };
    const api = {
      async readWorkspaceFiles(_caseId, { fileId }) {
        window.fileRefreshEvidence.reads++;
        if (window.holdFileRead) { window.holdFileRead = false; await new Promise(resolve => { window.releaseFileRead = resolve; }); }
        return { caseId, ownerId, caseTitle: 'Filing review', access: 'available', legacyAttachments: false, canUpload: false, files: structuredClone(files), nextCursor: null, selection: fileId ? 'found' : 'none', selectedFile: structuredClone(files.find(file => file.id === fileId) || null) };
      },
      async updateWorkspaceFile(_caseId, fileId, input) {
        window.fileRefreshEvidence.writes.push({ fileId, status: input.status });
        const file = files.find(file => file.id === fileId);
        Object.assign(file, { status: input.status, reviewRevision: 'f'.repeat(64), approvedAt: new Date().toISOString() });
        return { file: structuredClone(file) };
      },
      async readWorkspaceUpload() { throw new Error('Sharing is outside this isolated file-selection fixture'); },
      async readWorkspaceFileHistory() { throw new Error('History is outside this isolated file-selection fixture'); },
    };
    const controller = new AbortController();
    const panel = createWorkspaceFiles(caseId, { api, signal: controller.signal, ownerId, route: { query: new URLSearchParams() }, privateState: { fileReviews: new Map() } });
    document.querySelector('main').append(panel);
    await panel.readiness;
  });
  const panel = page.locator('[data-workspace-files]'), detail = panel.getByRole('region', { name: 'Document review' });
  await expect(panel).toHaveAttribute('data-state', 'ready');
  await panel.getByRole('button', { name: 'Original filing.txt', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Original filing.txt', exact: true })).toBeVisible();
  await page.locator('#outside').focus();
  await page.evaluate(() => {
    window.holdFileRead = true;
    window.pendingFileRefresh = document.querySelector('[data-workspace-files]').sync();
  });
  await expect.poll(() => page.evaluate(() => window.fileRefreshEvidence.reads)).toBe(2);
  try {
    if (interaction === "native press") {
      await panel.getByRole('button', { name: 'Corrected filing.txt', exact: true }).hover();
      await page.mouse.down(); await page.mouse.up();
    } else await page.evaluate(() => window.renameOriginalFile());
  } finally { await page.evaluate(() => window.releaseFileRead()); }
  // The old read deliberately resolves after the native selection, even when canceled.
  await page.evaluate(() => window.pendingFileRefresh);
  if (interaction === "idle refresh") {
    await expect(panel.getByRole('button', { name: 'Saved original filing.txt', exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Saved original filing.txt', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.fileRefreshEvidence.writes)).toEqual([]);
    return;
  }
  await expect(detail.getByRole('heading', { name: 'Corrected filing.txt', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Approve document', exact: true }).click();
  await expect(detail.locator('[data-file-confirm]')).toContainText('Approve “Corrected filing.txt”, version 1?');
  expect(await page.evaluate(() => window.fileRefreshEvidence.writes)).toEqual([]);
  await detail.getByRole('button', { name: 'Confirm approval', exact: true }).click();
  await expect(panel).toContainText('Document approved.');
  expect(await page.evaluate(() => window.fileRefreshEvidence.writes)).toEqual([{ fileId: (100).toString(16).padStart(24, '0'), status: 'approved' }]);
});
