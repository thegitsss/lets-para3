const { test, expect } = require('../posting-refresh-actual-fixture.cjs');
const fs = require('node:fs/promises');
const Case = require('../../../models/Case');
const fields = { title: 'Synthetic busy-save review', practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'First synthetic paragraph.\n\nSecond synthetic paragraph.', tasks: [{ title: 'Prepare agreement' }] };
const status = page => page.getByRole('region', { name: 'Posting save status', exact: true });
const title = page => page.locator('#av2-posting-title');
const review = page => page.getByRole('button', { name: 'Review posting changes', exact: true });
function latch() { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; }
async function api(page, method, endpoint, data) {
  const csrf = await (await page.request.get('/api/csrf')).json();
  const user = (await (await page.request.get('/api/auth/me')).json()).user;
  const response = await page.request[method](endpoint, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${endpoint}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function published(page) {
  const draft = (await api(page, 'post', '/api/case-drafts', fields)).draft;
  const result = await api(page, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: require('node:crypto').randomUUID(), practiceArea: 'contract law' });
  return result.publication;
}
async function edit(page, id) {
  await page.goto(`/attorney-v2.html#/matters/new?caseId=${id}`, { waitUntil: 'domcontentloaded' });
  await expect(status(page)).toHaveAttribute('data-state', 'ready');
  await expect(title(page)).toHaveValue(fields.title);
}
async function save(page) {
  await review(page).click();
  await page.getByRole('button', { name: 'Save reviewed changes', exact: true }).click();
}
async function persisted(page, id, owner, label) {
  const stored = await Case.findById(id).select('_id attorney title details totalAmount __v').lean();
  expect(stored).toBeTruthy();
  expect(String(stored.attorney)).toBe(owner);
  const response = await page.request.get(`/api/cases/posting/${id}`);
  expect(response.status()).toBe(200);
  const posting = (await response.json()).posting;
  expect(posting.id).toBe(id);
  expect(posting.values.title).toBe(stored.title);
  expect(posting.values.description).toBe(stored.details);
  expect(posting.values.compAmount).toBe((stored.totalAmount / 100).toFixed(2));
  return { label, independentHandlerStatus: response.status(), model: { id: String(stored._id), owner: String(stored.attorney), title: stored.title, description: stored.details, totalAmountCents: stored.totalAmount, version: stored.__v }, revision: posting.revision, values: posting.values };
}
async function settleResponse(page, response) {
  expect(response.status()).toBe(200);
  expect(await response.finished()).toBeNull();
  // Wait for actual rendered delivery after the held response, without a sleep
  // or changing the original test/expect deadlines.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('a precommit save refresh remains uncertain and a late acknowledgement preserves newer local text until an explicit check', async ({ page, foundationServer }, info) => {
  const receipt = await published(page);
  const endpoint = `/api/cases/posting/${receipt.caseId}`;
  const beforeCommit = latch(), held = latch(), committed = latch(), allowAck = latch(), handlerDone = latch();
  const evidence = { boundary: 'Actual PATCH is held before reaching backend, then committed; independent model/handler readbacks bypass the controlled browser route.', readbacks: [], browserPatchCount: 0, clientSubmitted: null, laterLocalTitle: 'Local text written after the unconfirmed read' };
  let patchStarted = false;
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patchStarted = true; evidence.browserPatchCount++;
    evidence.clientSubmitted = route.request().postDataJSON().changes;
    held.release();
    try {
      await beforeCommit.wait;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.release();
      await allowAck.wait;
      await route.fulfill({ response });
    } finally { handlerDone.release(); }
  });
  try {
    await edit(page, receipt.caseId);
    evidence.readbacks.push(await persisted(page, receipt.caseId, foundationServer.actorId, 'before-client-save'));
    await title(page).fill('Submitted title held before commit');
    const ack = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'PATCH');
    await save(page); await held.wait;
    evidence.readbacks.push(await persisted(page, receipt.caseId, foundationServer.actorId, 'request-held-before-commit'));
    expect(evidence.readbacks.at(-1).model.title).toBe(fields.title);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(status(page)).toHaveAttribute('data-state', 'uncertain');
    await expect(status(page)).toContainText('The save result is still unconfirmed.');
    await expect(review(page)).toBeDisabled();
    await expect(title(page)).toBeEnabled();
    await title(page).fill(evidence.laterLocalTitle);
    evidence.readbacks.push(await persisted(page, receipt.caseId, foundationServer.actorId, 'newer-local-text-before-old-commit'));
    expect(evidence.readbacks.at(-1).model.title).toBe(fields.title);
    expect(evidence.browserPatchCount).toBe(1);
    beforeCommit.release(); await committed.wait;
    evidence.readbacks.push(await persisted(page, receipt.caseId, foundationServer.actorId, 'committed-while-acknowledgement-held'));
    expect(evidence.readbacks.at(-1).model.title).toBe('Submitted title held before commit');
    await expect(title(page)).toHaveValue(evidence.laterLocalTitle);
    allowAck.release(); await handlerDone.wait;
    await settleResponse(page, await ack);
    await expect(status(page)).toHaveAttribute('data-state', 'uncertain');
    await expect(title(page)).toHaveValue(evidence.laterLocalTitle);
    await expect(review(page)).toBeDisabled();
    expect(evidence.browserPatchCount).toBe(1);
    await status(page).getByRole('button', { name: 'Check saved posting', exact: true }).click();
    await expect(status(page)).toHaveAttribute('data-state', 'ready');
    await expect(status(page)).toContainText('Your previous save is confirmed.');
    await expect(title(page)).toHaveValue(evidence.laterLocalTitle);
    await expect(review(page)).toBeEnabled();
    evidence.readbacks.push(await persisted(page, receipt.caseId, foundationServer.actorId, 'explicit-check-confirms-submitted-record-keeps-newer-local-text'));
    expect(evidence.readbacks.at(-1).model.title).toBe('Submitted title held before commit');
    expect(evidence.browserPatchCount).toBe(1);
    evidence.finalRenderedTitle = await title(page).inputValue();
    evidence.finalState = await status(page).getAttribute('data-state');
  } finally {
    beforeCommit.release(); allowAck.release();
    if (patchStarted) await handlerDone.wait;
    await fs.writeFile(info.outputPath('busy-save-boundary-evidence.json'), JSON.stringify(evidence, null, 2));
  }
});

test('a denied foreground posting read clears private fields and a held old save acknowledgement cannot restore them', async ({ page, foundationServer }, info) => {
  const receipt = await published(page);
  const endpoint = `/api/cases/posting/${receipt.caseId}`;
  const committed = latch(), allowAck = latch(), handlerDone = latch();
  let denyClientRead = false, patchStarted = false;
  const submittedTitle = 'Private committed title before denied foreground read';
  const submittedDescription = 'Synthetic confidential first paragraph.\n\nSynthetic confidential second paragraph.';
  const evidence = { boundary: 'PATCH commit and stored records are real. Browser GET403 is a controlled client response, not a revoked database owner; independent permitted handler/model reads remain authoritative.', readbacks: [], browserPatchCount: 0, controlledClientReadStatuses: [] };
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() === 'GET' && denyClientRead) {
      evidence.controlledClientReadStatuses.push(403);
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic foreground access denial' }) });
    }
    if (route.request().method() !== 'PATCH') return route.continue();
    patchStarted = true; evidence.browserPatchCount++;
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.release();
      await allowAck.wait;
      await route.fulfill({ response });
    } finally { handlerDone.release(); }
  });
  try {
    await edit(page, receipt.caseId);
    await title(page).fill(submittedTitle);
    await page.locator('#av2-posting-description').fill(submittedDescription);
    const ack = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'PATCH');
    await save(page); await committed.wait;
    evidence.readbacks.push(await persisted(page, receipt.caseId, foundationServer.actorId, 'committed-record-before-held-acknowledgement'));
    expect(evidence.readbacks.at(-1).model.title).toBe(submittedTitle);
    expect(evidence.readbacks.at(-1).model.description).toBe(submittedDescription);
    denyClientRead = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(status(page)).toHaveAttribute('data-state', 'uncertain');
    await expect(status(page)).toContainText('This posting is no longer available to your account.');
    await expect(page.locator('[data-av2-posting-editor] .av2-draft-fields')).toBeHidden();
    await expect(title(page)).toHaveValue('');
    await expect(page.locator('#av2-posting-description')).toHaveValue('');
    await expect(review(page)).toBeDisabled();
    expect(evidence.controlledClientReadStatuses).toEqual([403]);
    evidence.readbacks.push(await persisted(page, receipt.caseId, foundationServer.actorId, 'independent-actual-record-remains-after-controlled-client-403'));
    expect(evidence.readbacks.at(-1).model.title).toBe(submittedTitle);
    allowAck.release(); await handlerDone.wait;
    await settleResponse(page, await ack);
    await expect(status(page)).toHaveAttribute('data-state', 'uncertain');
    await expect(page.locator('[data-av2-posting-editor] .av2-draft-fields')).toBeHidden();
    await expect(title(page)).toHaveValue('');
    await expect(page.locator('#av2-posting-description')).toHaveValue('');
    await expect(review(page)).toBeDisabled();
    expect(evidence.browserPatchCount).toBe(1);
    denyClientRead = false;
    await status(page).getByRole('button', { name: 'Check saved posting', exact: true }).click();
    await expect(status(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('[data-av2-posting-editor] .av2-draft-fields')).toBeVisible();
    await expect(title(page)).toHaveValue(submittedTitle);
    await expect(page.locator('#av2-posting-description')).toHaveValue(submittedDescription);
    await expect(review(page)).toBeDisabled();
    evidence.readbacks.push(await persisted(page, receipt.caseId, foundationServer.actorId, 'explicit-fresh-permitted-read-restores-committed-record'));
    expect(evidence.browserPatchCount).toBe(1);
    evidence.finalRenderedTitle = await title(page).inputValue();
    evidence.finalState = await status(page).getAttribute('data-state');
  } finally {
    allowAck.release();
    if (patchStarted) await handlerDone.wait;
    await fs.writeFile(info.outputPath('busy-save-boundary-evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
