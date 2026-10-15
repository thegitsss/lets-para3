const { test, expect } = require(process.env.LPC_WORKSPACE_ACTUAL_FIXTURE === 'true' ? '../workspace-paired-observation.cjs' : 'playwright/test');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
const inspectBrowserDiagnostics = require('./browser-diagnostics');

// Passive diagnostic hook: does not replace product/browser APIs or perform actions.
function observeNativeWork(seed) {
  const documentId = `${seed}:${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`;
  const keys = new WeakMap(); let nextKey = 0, sequence = 0;
  const key = node => { if (!node || typeof node !== 'object') return null; if (!keys.has(node)) keys.set(node, ++nextKey); return keys.get(node); };
  const element = node => node?.nodeType === 1 ? node : node?.parentElement;
  const rect = node => { const value = node?.getBoundingClientRect?.(); return value ? { x: value.x, y: value.y, width: value.width, height: value.height, top: value.top, right: value.right, bottom: value.bottom, left: value.left } : null; };
  const describe = node => {
    const target = element(node); if (!target) return null;
    const control = target.matches('input,button,select,textarea,a') ? target : target.closest('input,button,select,textarea,a');
    const row = target.closest('[data-work-index]');
    return { nodeKey: key(target), tag: target.tagName, id: target.id || null, workIndex: row?.getAttribute('data-work-index') ?? null, taskId: row?.getAttribute('data-task-id') ?? null, controlKey: control ? key(control) : null, controlTag: control?.tagName ?? null, disabled: control?.disabled ?? null, checked: control?.checked ?? null, connected: target.isConnected, rect: rect(target), controlRect: rect(control), label: target.matches('input[type=checkbox]') ? target.closest('label')?.textContent.trim().slice(0,200) : target.matches('button,a,label') ? target.textContent.trim().slice(0,100) : null };
  };
  const snapshot = () => {
    const panel = document.querySelector('[data-workspace-work]');
    const summary = panel?.querySelector('[aria-label="Matter review summary"]');
    return { panelState: panel?.dataset.state ?? null, panelRect: rect(panel), summaryState: summary?.dataset.state ?? null, summaryRect: rect(summary), status: [...(document.querySelectorAll('[data-matter-workspace] [role=status]'))].map(node => node.textContent.trim().slice(0,250)), active: describe(document.activeElement), controls: [...(panel?.querySelectorAll('input[type=checkbox]') || [])].map(describe) };
  };
  const report = (type, detail = {}) => console.debug('LPC_NATIVE_WORK ' + JSON.stringify({ documentId, sequence: ++sequence, type, at: Date.now(), monotonicAt: performance.now(), page: location.href, visibility: document.visibilityState, ...detail }));
  for (const type of ['pointerdown','pointerup','mousedown','mouseup','click','input','change','keydown','keyup','focusin','focusout']) {
    document.addEventListener(type, event => {
      report(type, { trusted: event.isTrusted, defaultPrevented: event.defaultPrevented, button: event.button ?? null, buttons: event.buttons ?? null, point: typeof event.clientX === 'number' ? { x: event.clientX, y: event.clientY } : null, key: event.key ?? null, target: describe(event.target), path: event.composedPath().filter(node => node?.nodeType === 1).slice(0,6).map(describe), snapshot: snapshot() });
      queueMicrotask(() => report(type + ':after-dispatch', { trusted: event.isTrusted, defaultPrevented: event.defaultPrevented, target: describe(event.target), snapshot: snapshot() }));
    }, { capture: true, passive: true });
  }
  new MutationObserver(records => {
    const relevant = records.filter(record => {
      const target = element(record.target);
      return target?.closest('[data-matter-workspace]') || [...record.addedNodes, ...record.removedNodes].some(node => element(node)?.matches('[data-matter-workspace]') || element(node)?.querySelector('[data-matter-workspace]'));
    });
    if (!relevant.length) return;
    report('mutation', { changes: relevant.map(record => ({ type: record.type, target: describe(record.target), attribute: record.attributeName, oldValue: record.oldValue, currentValue: record.attributeName ? element(record.target)?.getAttribute(record.attributeName) : null, added: [...record.addedNodes].map(describe), removed: [...record.removedNodes].map(describe) })), snapshot: snapshot() });
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
  for (const type of ['pageshow','pagehide','beforeunload','visibilitychange']) addEventListener(type, event => report(type, { persisted: event.persisted ?? null, snapshot: snapshot() }));
}

let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start(); });
test.afterAll(async () => server?.close());

async function api(context, method, path, data) {
  const csrf = await (await context.request.get(`${server.origin}/api/csrf`)).json();
  const response = await context.request[method](`${server.origin}${path}`, {
    headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}),
  });
  expect(response.headers()['x-lpc-test-server']).toBe('financial-lifecycle-browser');
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json();
}

test('actual submission, linked revision, approval and task handoff agree without releasing payment', async ({ browser }, info) => {
  const contexts = [], pages = {}, actors = {}, errors = [], checkpoints = [], browserEvents = [];
  const nativeWorkEvents = [], nativeWorkRequests = [], authoritativeReadback = {};
  const diagnostics = () => inspectBrowserDiagnostics({ engine: info.project.name, origin: server.origin, attorneyOwnerId: actors.attorney?.id, paralegalOwnerId: actors.paralegal?.id, errors, events: browserEvents });
  let caseId;
  try {
    for (const role of ['attorney', 'paralegal']) {
      actors[role] = await server.createUser(role, {}, true);
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      contexts.push(context);
      context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
      await context.addCookies([actors[role].cookie]);
      await context.addInitScript(seed => {
        // Diagnostic identity only: this init script also runs on about:blank,
        // where randomUUID is not available. Product crypto remains untouched.
        const documentId = `${seed}:${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`;
        const report = (type, detail = {}) => console.debug('LPC_SUBMISSION_DEPARTURE ' + JSON.stringify({ documentId, type, page: location.href, at: Date.now(), visibility: document.visibilityState, ...detail }));
        for (const type of ['beforeunload', 'pagehide', 'pageshow']) addEventListener(type, event => report(type, { persisted: event.persisted }));
        addEventListener('error', event => report('windowerror', { message: event.message, filename: event.filename, stack: event.error?.stack }));
        addEventListener('unhandledrejection', event => report('unhandledrejection', { message: String(event.reason), stack: event.reason?.stack }));
      }, require('node:crypto').randomUUID());
      if (info.project.name === 'webkit') await context.addInitScript(observeNativeWork, require('node:crypto').randomUUID());
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
      pages[role] = await context.newPage();
      const page = pages[role];
      page.on('pageerror', error => errors.push({ role, name: error.name, message: error.message, stack: error.stack, page: page.url(), at: Date.now() }));
      page.on('console', message => {
        const nativePrefix = 'LPC_NATIVE_WORK ';
        if (message.text().startsWith(nativePrefix)) nativeWorkEvents.push({ role, ...JSON.parse(message.text().slice(nativePrefix.length)) });
        const prefix = 'LPC_SUBMISSION_DEPARTURE ';
        if (message.text().startsWith(prefix)) browserEvents.push({ role, ...JSON.parse(message.text().slice(prefix.length)) });
      });
      const diagnosticRequest = request => request.url().startsWith(server.origin + '/api/cases/') && /\/(?:work-review|completion-review|stream)(?:\?|$)/.test(request.url());
      page.on('request', request => { if (diagnosticRequest(request)) nativeWorkRequests.push({ role, phase: 'request', method: request.method(), url: request.url(), at: Date.now() }); });
      page.on('response', response => { const request = response.request(); if (diagnosticRequest(request)) nativeWorkRequests.push({ role, phase: 'response', method: request.method(), url: request.url(), status: response.status(), at: Date.now() }); });
      page.on('requestfailed', request => { if (diagnosticRequest(request)) nativeWorkRequests.push({ role, phase: 'failed', method: request.method(), url: request.url(), error: request.failure()?.errorText, at: Date.now() }); });
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) browserEvents.push({ role, type: 'navigation', page: frame.url(), at: Date.now() }); });
      page.on('requestfailed', request => {
        if (request.url().startsWith(server.origin + '/api/')) browserEvents.push({ role, type: 'requestfailed', method: request.method(), url: request.url(), error: request.failure()?.errorText, page: page.url(), at: Date.now() });
      });
    }
    const { attorney, paralegal } = pages;
    const published = await api(attorney.context(), 'post', '/api/cases', {
      title: 'River Street filing review', practiceArea: 'immigration', state: 'CA', totalAmount: 400,
      experience: '5+ years', deadline: '2027-03-14', description: 'Prepare the filing package and check the supporting exhibit dates.',
      tasks: [{ title: 'Prepare filing package' }, { title: 'Review supporting evidence' }],
    });
    caseId = String(published.case?._id || published.case?.id || published._id || published.id);
    await api(paralegal.context(), 'post', `/api/jobs/${published.jobId}/apply`, { coverLetter: 'I can prepare the filing package and check the exhibit dates.' });
    await api(attorney.context(), 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
    const hiring = await api(attorney.context(), 'get', `/api/cases/${caseId}/hiring-review/${actors.paralegal.id}?expectedOwnerId=${actors.attorney.id}`);
    await api(attorney.context(), 'post', `/api/cases/${caseId}/hire/${actors.paralegal.id}`, { expectedOwnerId: actors.attorney.id, reviewedRevision: hiring.revision });
    const funded = await server.inspect(caseId);
    const moneyWrites = () => server.evidence().provider.filter(call => /\.(create|capture|cancel|update)$/.test(call.method));
    const providerWritesBefore = JSON.stringify(moneyWrites());
    const filePath = `/api/uploads/case/${caseId}?presentation=matter`;
    const files = async () => (await api(paralegal.context(), 'get', filePath)).files;
    const matter = () => api(paralegal.context(), 'get', `/api/cases/${caseId}`);
    const submit = async () => {
      await paralegal.getByRole('button', { name: 'Submit file', exact: true }).click();
      const confirmation = paralegal.getByRole('dialog', { name: 'Submit this file?' });
      await expect(confirmation).toBeVisible();
      const saved = paralegal.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/uploads/case/${caseId}`);
      await confirmation.getByRole('button', { name: 'Submit file', exact: true }).click();
      expect((await saved).status()).toBe(201);
      await expect(confirmation).toHaveCount(0);
    };
    const panel = attorney.locator('[data-workspace-files]');
    const detail = panel.getByRole('region', { name: 'Document review' });
    const choose = async id => {
      await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/files`);
      // Re-enter the current document list after the other role's file write.
      await attorney.reload();
      await expect(panel).toHaveAttribute('data-state', 'ready');
      await panel.locator(`[data-download-file="${id}"]`).getByRole('button').click();
    };

    await paralegal.goto(`${server.origin}/paralegal-v2.html#/matter/${caseId}?tab=files`);
    await paralegal.locator('[data-v2-file-input]').setInputFiles({ name: 'Filing draft.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nDraft filing with exhibits\n%%EOF') });
    await submit();
    const original = (await files()).find(file => file.originalName === 'Filing draft.pdf');
    expect(original).toMatchObject({ status: 'pending_review', uploadedByRole: 'paralegal' });
    expect((await matter()).submissionSummary).toMatchObject({ awaitingReview: 1, revisions: 0, approved: 0 });
    checkpoints.push('Original file submitted and awaiting attorney review');

    await choose(original.id);
    const instructions = 'Correct the exhibit dates.\n\nKeep the filing references unchanged.';
    await detail.getByLabel('Revision instructions (optional)').fill(instructions);
    await detail.getByRole('button', { name: 'Request revisions', exact: true }).click();
    await detail.getByRole('button', { name: 'Confirm revision request', exact: true }).click();
    await expect(panel).toContainText('Revisions requested.');
    await paralegal.reload();
    const request = paralegal.locator(`[data-v2-revision-request="${original.id}"]`);
    await expect(request).toContainText('Correct the exhibit dates.');
    expect((await files()).find(file => file.id === original.id).revisionNotes).toBe(instructions);
    const chooser = paralegal.waitForEvent('filechooser');
    await request.getByRole('button', { name: 'Choose revised file', exact: true }).click();
    await (await chooser).setFiles({ name: 'Corrected filing.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nCorrected exhibit dates\n%%EOF') });
    await expect(paralegal.locator('[data-v2-file-selection-list]')).toContainText('Revision of Filing draft.pdf');
    await submit();
    const revised = (await files()).find(file => file.originalName === 'Corrected filing.pdf');
    expect(revised).toMatchObject({ status: 'pending_review', revisionOfFileId: original.id });
    await expect(request).toContainText('Response submitted: Corrected filing.pdf');
    checkpoints.push('Renamed revision retains the original request and awaits review');

    await choose(revised.id);
    await detail.getByRole('button', { name: 'Approve document', exact: true }).click();
    await expect(detail).toContainText('does not complete the Matter or release payment');
    await detail.getByRole('button', { name: 'Confirm approval', exact: true }).click();
    await expect(panel).toContainText('Document approved.');
    const reviewed = await files();
    expect(reviewed.find(file => file.id === original.id)).toMatchObject({ status: 'attorney_revision', revisionResolution: { approvedFileId: revised.id } });
    expect(reviewed.find(file => file.id === revised.id).status).toBe('approved');
    expect((await matter()).submissionSummary).toMatchObject({ revisions: 0, awaitingReview: 0, approved: 1 });
    await paralegal.reload();
    await expect(request).toContainText('Revision resolved');
    await expect(request).toContainText('Approved revision: Corrected filing.pdf');
    await expect(request.getByRole('button', { name: 'Choose revised file' })).toHaveCount(0);
    await paralegal.screenshot({ path: info.outputPath('resolved-revision.png') });
    const beforeTasks = await server.inspect(caseId);
    expect(beforeTasks.case.tasks.every(task => !task.completed)).toBe(true);
    checkpoints.push('Approved response resolves its request without approving the original or completing tasks');

    await attorney.goto(`${server.origin}/attorney-v2.html#/matters/${caseId}/work`);
    for (const title of ['Prepare filing package', 'Review supporting evidence']) {
      const task = attorney.locator('[data-workspace-work]').getByRole('checkbox', { name: title, exact: true });
      await task.click(); await expect(task).toBeChecked();
    }
    await paralegal.goto(`${server.origin}/paralegal-v2.html#/matter/${caseId}?tab=work`);
    await expect(paralegal.locator('[data-completion-state]')).toHaveText('Awaiting final attorney review.');
    await expect(paralegal.getByRole('button', { name: /complete|approve|release/i })).toHaveCount(0);
    const saved = await server.inspect(caseId);
    expect(saved.case.tasks.every(task => task.completed)).toBe(true);
    expect(saved.case.status).toBe('in progress'); expect(saved.case.paymentReleased).toBe(false);
    for (const field of ['payouts', 'operations', 'income']) expect(saved[field]).toEqual(funded[field]);
    expect(JSON.stringify(moneyWrites())).toBe(providerWritesBefore);
    checkpoints.push('Attorney task review reaches final handoff with financial records unchanged');
    const completionResponse = await attorney.context().request.get(`${server.origin}/api/cases/${caseId}/completion-review?expectedOwnerId=${actors.attorney.id}`);
    expect(completionResponse.status()).toBe(200);
    const completion = await completionResponse.json();
    expect(completion.documents).toMatchObject({ total: 2, awaitingReview: 0, revisions: 0, resolvedRevisions: 1, approved: 1 });
    const summary = attorney.getByRole('region', { name: 'Matter review summary', exact: true });
    await expect(summary).toHaveAttribute('data-state', 'ready');
    await expect(summary.getByRole('link').filter({ hasText: 'Documents to review' })).toContainText('1 approved');
    await expect(summary).not.toContainText('need revisions');
    await expect(summary).not.toContainText('Unavailable');
    await attorney.screenshot({ path: info.outputPath('attorney-truthful-revision-summary.png') });
    checkpoints.push('Actual Attorney summary agrees with approved linked response and retained original history');

    await paralegal.screenshot({ path: info.outputPath('attorney-review-handoff.png') });
    expect(diagnostics().documentFailures).toEqual([]);
    expect(diagnostics().unexplainedPageErrors).toEqual([]);
  } finally {
    if (caseId) {
      const actual = await server.inspect(caseId);
      authoritativeReadback.case = { id: String(actual.case._id), status: actual.case.status, tasks: actual.case.tasks, taskRevision: actual.case.taskRevision, paymentReleased: actual.case.paymentReleased };
      const CaseFile = require('../../../models/CaseFile');
      const records = await CaseFile.find({ caseId }).lean();
      authoritativeReadback.files = records.map(file => ({ id: String(file._id), caseId: String(file.caseId), status: file.status, version: file.version, uploadedByRole: file.uploadedByRole, revisionOfFileId: file.revisionOfFileId ? String(file.revisionOfFileId) : null, revisionOfVersion: file.revisionOfVersion ?? null, revisionRequestAt: file.revisionRequestAt ?? null, revisionRequestedAt: file.revisionRequestedAt ?? null, approvedAt: file.approvedAt ?? null }));
      const resolved = require('../../../utils/revisionResolution').projectRevisionResolutions(records);
      authoritativeReadback.actualRevisionResolutions = resolved.map(file => ({ id: String(file._id), revisionResolution: file.revisionResolution }));
      const response = await pages.attorney.context().request.get(`${server.origin}/api/cases/${caseId}/completion-review?expectedOwnerId=${actors.attorney.id}`);
      authoritativeReadback.completionReview = { status: response.status(), observedAt: Date.now(), body: await response.json() };
    }
    const evidence = server.evidence();
    await fs.writeFile(info.outputPath('submission-agreement.json'), JSON.stringify({ caseId, checkpoints, errors, browserEvents, browserDiagnostics: diagnostics(), requests: evidence.requests, assets: evidence.assets, providerMethods: evidence.provider.map(call => call.method) }, null, 2));
    for (const context of contexts) await context.close();
    await fs.writeFile(info.outputPath('native-work-diagnostic.json'), JSON.stringify({ engine: info.project.name, caseId, events: nativeWorkEvents, requests: nativeWorkRequests, authoritativeReadback, captureBoundary: 'Passive WebKit document listeners/mutations plus Node request events; final export follows all original awaited context.close calls. Actual SSE event payloads are not replaced or intercepted; only stream request and source schedule are mapped.' }, null, 2));
  }
});
