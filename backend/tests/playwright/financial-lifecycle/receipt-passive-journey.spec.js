const { test, expect: baseExpect, publishOwnedProjection } = require('./financial-projection-actual-fixture.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const expect = baseExpect.configure({ timeout: 10000 });
test.use({ actionTimeout: 10000 });
const pdf = require('node:fs').readFileSync(path.join(__dirname, '../paralegal-support/fixtures/paralegal-valid.pdf'));
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

test('passive receipt refresh preserves a native download press and retains current-owner revision and retry boundaries', async ({ page, projectionSession, projectionServer }, info) => {
  test.setTimeout(45000);
  const ownerId = projectionSession.actor.id, counters = { reviews: 0, pdf: 0, downloads: 0 }, pdfRequests = [], releases = [], fulfillmentErrors = [], geometryStages = [];
  const gate = () => { let release, arrived; const pending = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { arrived = resolve; }); releases.push(release); const result={ pending, entered, release, arrived:()=>{result.arrivedFlag=true;arrived();},arrivedFlag:false,allowCanceled:false };return result; };
  const post = async (url, data) => {
    const csrf = await (await page.request.get('/api/csrf')).json();
    const result = await page.request.post(url, { headers: { 'X-CSRF-Token': csrf.csrfToken }, data: { ...data, expectedOwnerId: ownerId } });
    expect(result.ok(), await result.text()).toBe(true); return result.json();
  };
  const fields = { title: 'Passive receipt native control', practiceArea: 'Contract Law', state: 'New York', compAmount: '400', experience: '3+ years', deadline: '2027-03-14', description: 'Synthetic native receipt refresh boundary.', tasks: [{ title: 'Prepare agreement' }] };
  const draft = (await post('/api/case-drafts', fields)).draft;
  const id = (await post('/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' })).publication.caseId;
  const User = require('../../../models/User'), mongoose = require('mongoose');
  const finance = async () => Object.fromEntries(await Promise.all(['Payout','PaymentOperation','PlatformIncome'].map(async name => [name, await mongoose.models[name].collection.find({}).sort({_id:1}).toArray()])));
  const beforeFinance = await finance();
  let value = { caseId: id, ownerId, caseTitle: fields.title, selectionId: 'payment', reason: 'available', revision: 'a'.repeat(64), receipt: { type: 'payment', id: 'pi_private_passive_receipt', currency: 'USD', issuedAt: null, dateLabel: 'Payment date', status: 'received', method: 'Visa ending 4242', lines: [{ label: 'Matter amount', amount: 40000 }, { label: 'Platform fee (22%)', amount: 8800 }], total: { label: 'Total paid', amount: 48800 }, partyName: 'PRIVATE_PASSIVE_PARTY', filename: 'passive-owned-receipt.pdf' } };
  let reviewGate = null, pdfGate = null, reviewStatus = 200, stale = false;
  const surface = page.locator('[data-matter-receipt]'), button = surface.getByRole('button', { name: 'Download receipt', exact: true }), feedback = surface.locator('[data-receipt-feedback]');
  page.on('download', () => { counters.downloads++; });
  await page.route(url => url.pathname === `/api/payments/receipt/attorney/${id}/review`, async route => {
    counters.reviews++;
    const currentGate = reviewGate, body = structuredClone(value), status = reviewStatus;
    if (currentGate) { currentGate.arrived(); await currentGate.pending; }
    await json(route, body, status).catch(error => { const failure=route.request().failure();fulfillmentErrors.push({message:error.message,requestFailure:failure,expectedCanceled:Boolean(currentGate?.allowCanceled)});if(!currentGate?.allowCanceled||!failure)throw error; });
  });
  await page.route(url => url.pathname === `/api/payments/receipt/attorney/${id}`, async route => {
    counters.pdf++; pdfRequests.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    if (stale) return json(route, { code: 'RECEIPT_CHANGED' }, 409);
    const currentGate = pdfGate; if (currentGate) { currentGate.arrived(); await currentGate.pending; }
    return route.fulfill({ contentType: 'application/pdf', body: pdf });
  });
  const retry = async () => { await surface.getByRole('button', { name: 'Retry receipt', exact: true }).click(); await expect(surface).toHaveAttribute('data-state','ready'); await expect(button).toBeEnabled(); };
  const geometry=async label=>geometryStages.push({label,at:Date.now(),panels:await page.locator('.av2-matter-financials > section').evaluateAll(elements=>elements.map(e=>({label:e.getAttribute('aria-label'),state:e.dataset.state,busy:e.getAttribute('aria-busy'),text:e.innerText,rect:e.getBoundingClientRect().toJSON()})))});
  try {
    const initialStream = page.waitForResponse(response=>new URL(response.url()).pathname===`/api/cases/${id}/stream` && response.status()===200,{timeout:10000});
    await page.goto(`/attorney-v2.html#/matters/${id}/financials`);
    await initialStream;
    await expect(surface).toHaveAttribute('data-state','ready'); await expect(surface).toContainText('$488.00');
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox(); expect(box).not.toBeNull();await geometry('initial-all-child-readiness-and-stream-open-before-press');
    await page.mouse.move(box.x + box.width/2, box.y + box.height/2); await page.mouse.down();
    reviewGate = gate(); pdfGate = gate();
    await publishOwnedProjection(page); await expect.poll(()=>reviewGate.arrivedFlag).toBe(true);
    await expect(button).toBeEnabled();
    const heldBox = await button.boundingBox();await geometry('passive-review-held-during-native-press');expect(heldBox).toEqual(box);
    const firstDownload = page.waitForEvent('download', { timeout: 10000 });
    reviewGate.allowCanceled=true;await page.mouse.up();await expect.poll(()=>pdfGate.arrivedFlag).toBe(true);
    await expect(button).toBeDisabled(); expect(counters.pdf).toBe(1);
    const disabledBox = await button.boundingBox(); await page.mouse.click(disabledBox.x + disabledBox.width/2, disabledBox.y + disabledBox.height/2);
    expect(counters.pdf).toBe(1);
    reviewGate.release(); reviewGate = null; pdfGate.release(); pdfGate = null;
    const first = await firstDownload; expect(await fs.readFile(await first.path())).toEqual(pdf); expect(first.suggestedFilename()).toBe(value.receipt.filename);
    await expect(feedback).toContainText('Download requested.'); expect(counters.downloads).toBe(1);
    expect(pdfRequests[0]).toMatchObject({ expectedOwnerId: ownerId, revision: value.revision });

    reviewStatus = 503; await publishOwnedProjection(page);
    await expect(surface).toHaveAttribute('data-state','error'); await expect(button).toBeHidden(); await expect(surface).not.toContainText('PRIVATE_PASSIVE_PARTY'); expect(counters.pdf).toBe(1);
    reviewStatus = 200; await retry();
    stale = true; await button.click(); await expect(surface).toHaveAttribute('data-state','error'); await expect(feedback).toContainText('Refresh the receipt before downloading'); await expect(button).toBeHidden(); expect(counters.pdf).toBe(2); expect(counters.downloads).toBe(1);
    stale = false; value = { ...value, revision: 'b'.repeat(64) }; await retry();
    const secondDownload = page.waitForEvent('download', { timeout: 10000 }); await button.click(); const second = await secondDownload; expect(await fs.readFile(await second.path())).toEqual(pdf); expect(pdfRequests.at(-1)).toMatchObject({ expectedOwnerId: ownerId, revision: value.revision }); expect(counters.pdf).toBe(3); expect(counters.downloads).toBe(2);

    const correct = value; value = { ...correct, ownerId: '0'.repeat(24) }; await publishOwnedProjection(page);
    await expect(surface).toHaveAttribute('data-state','restricted'); await expect(button).toBeHidden(); await expect(surface).not.toContainText('PRIVATE_PASSIVE_PARTY'); expect(counters.pdf).toBe(3);
    const restoredStream = page.waitForResponse(response=>new URL(response.url()).pathname===`/api/cases/${id}/stream` && response.status()===200,{timeout:10000});
    value = correct; await page.reload({waitUntil:'domcontentloaded'});await restoredStream;await expect(surface).toHaveAttribute('data-state','ready');await expect(button).toBeEnabled();
    reviewGate = gate(); await publishOwnedProjection(page); await expect.poll(()=>reviewGate.arrivedFlag).toBe(true); await expect(button).toBeEnabled();
    // Begin the actual native action while the owner is still active. Hold all
    // fresh auth reads so an independent sibling cannot remove the button before
    // the native press; deliver only unchanged real responses after DB disable.
    const deniedGuard = gate();
    await page.route(url => url.origin === projectionServer.origin && url.pathname === '/api/auth/me', async route => {
      deniedGuard.arrived(); await deniedGuard.pending;
      await route.continue();
    });
    const deniedNativePress = button.click();
    await expect(surface).toHaveAttribute('data-state','downloading');
    await expect(button).toBeDisabled(); await expect.poll(()=>deniedGuard.arrivedFlag).toBe(true);
    reviewGate.allowCanceled=true;await User.updateOne({ _id: ownerId }, { $set: { disabled: true } });
    const realDeniedOwner = page.waitForResponse(async response => new URL(response.url()).origin === projectionServer.origin && new URL(response.url()).pathname === '/api/auth/me' && response.status() === 200 && (await response.json()).user === null, {timeout:10000});
    deniedGuard.release(); await deniedNativePress;
    const deniedOwnerResponse = await realDeniedOwner;
    expect(deniedOwnerResponse.status()).toBe(200);expect(await deniedOwnerResponse.json()).toEqual({ user: null });
    await expect(page).toHaveURL(/\/login\.html(?:[?#].*)?$/);
    await expect(surface).toHaveCount(0); await expect(page.locator('body')).not.toContainText('PRIVATE_PASSIVE_PARTY');
    reviewGate.release(); reviewGate = null;
    expect(counters.pdf).toBe(3); expect(counters.downloads).toBe(2);
    expect(await finance()).toEqual(beforeFinance); expect(projectionServer.provider.calls).toEqual([]);
  } finally {
    releases.forEach(release => release());
    await page.mouse.up().catch(() => {});
    await fs.writeFile(info.outputPath('receipt-passive-evidence.json'), JSON.stringify({ counters, pdfRequests, fulfillmentErrors, geometryStages, ownerId, beforeFinance, afterFinance: await finance(), providers: projectionServer.provider.calls, controlledReceiptBytes: true, actualManagedOwnerAndPublication: true }, null, 2));
  }
});
