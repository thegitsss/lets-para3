const { test, expect } = require('../posting-refresh-actual-fixture.cjs');
const AxeBuilder = require('@axe-core/playwright').default;
const fields = { title: 'Synthetic Matter actions', practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic action navigation.', tasks: [{ title: 'Prepare agreement' }] };
async function api(page, method, path, data) {
  const csrf = await (await page.request.get('/api/csrf')).json(), user = (await (await page.request.get('/api/auth/me')).json()).user;
  const response = await page.request[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function create(page, title, draftOnly = false) {
  const draft = (await api(page, 'post', '/api/case-drafts', { ...fields, title })).draft;
  return draftOnly ? draft.id : (await api(page, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: require('crypto').randomUUID(), practiceArea: 'contract law' })).publication.caseId;
}
const listReady = page => expect(page.locator('[data-av2-region="matter-list"]')).toHaveAttribute('data-state', 'ready');
const row = (page, id) => page.locator(`[data-av2-matter="${id}"]`);
const workspaceReady = page => expect(page.locator('[data-matter-workspace]')).toHaveAttribute('data-state', 'ready');
async function returnToList(page, href, id, label = 'Back to Matters') {
  await page.getByRole('link', { name: label, exact: true }).first().click(); await listReady(page);
  expect(new URL(page.url()).hash).toBe(href); await expect(row(page, id)).toBeVisible();
}

test('a Matter on a filtered second page opens every workspace section and returns to the same list', async ({ page, foundationServer }, testInfo) => {
  test.setTimeout(90000);
  const prefix = `Action navigation ${Date.now()}`; let id;
  for (let index = 1; index <= 16; index++) id = await create(page, `${prefix} ${String(index).padStart(2, '0')}`);
  await require('../home-private-actual-preparation.cjs').ensureEligibleMatter(page,id,foundationServer);
  const href = '#/matters?' + new URLSearchParams({ view: 'active', q: prefix, matterSort: 'alphabetical', page: '2' });
  await page.goto(`/attorney-v2.html${href}`, { waitUntil: 'domcontentloaded' }); await listReady(page); await expect(row(page, id)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open current matter tools', exact: true })).toHaveCount(0);
  await row(page, id).getByRole('heading').getByRole('link').click(); await workspaceReady(page);
  expect(new URL(page.url()).pathname).toBe('/attorney-v2.html');
  for (const tab of ['Overview', 'Applications', 'Work', 'Files', 'Messages', 'Activity', 'Financials']) {
    if(await page.getByRole('link',{name:'View Matter',exact:true}).count()){const back=page.getByRole('link',{name:'View Matter',exact:true});await expect(back).toHaveAttribute('href',`#/matters/${id}/overview?${new URLSearchParams({returnTo:href})}`);await back.click();await workspaceReady(page);}
    await page.getByRole('navigation', { name: 'Matter sections', exact: true }).getByRole('link', { name: tab, exact: true }).click(); await workspaceReady(page);
    await expect(page.locator('[data-matter-workspace]')).toHaveAttribute('data-matter-workspace',id);
    await expect(page.locator('[data-matter-workspace]').getByRole('heading',{name:`${prefix} 16`,level:tab==='Messages'?2:1,exact:true})).toBeVisible();
    if(tab==='Messages') await expect(page.getByRole('link',{name:'View Matter',exact:true})).toHaveAttribute('href',`#/matters/${id}/overview?${new URLSearchParams({returnTo:href})}`);
    else await expect(page.getByRole('navigation', { name: 'Matter sections', exact: true }).getByRole('link', { name: tab, exact: true })).toHaveAttribute('aria-current', 'page');
    const query = new URLSearchParams(new URL(page.url()).hash.split('?')[1]); expect(query.get('returnTo')).toBe(href);
  }
  await returnToList(page, href, id);
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('.av2-main').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.locator('.av2-main').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`matter-actions-top-${width}.png`) });
    await row(page, id).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`matter-actions-list-${width}.png`) });
  }
});

test('all Matter management tools retain the list and use their reviewed V2 destinations', async ({ page }) => {
  test.setTimeout(90000);
  const title = `Management return ${Date.now()}`, id = await create(page, title);
  const href = '#/matters?' + new URLSearchParams({ view: 'active', q: title, matterSort: 'alphabetical' });
  await page.goto(`/attorney-v2.html${href}`, { waitUntil: 'domcontentloaded' }); await listReady(page);
  const entries = [
    ['Review or edit posting', '[aria-label="Posting save status"]', 'Return to Matters'],
    ['Archive and restore', '[data-matter-archive]'], ['Files for download', '[data-matter-workspace]'],
    ['View receipt', '[data-matter-receipt]'], ['Review applications', '[data-matter-workspace]'],
    ['View invited paralegals', '[data-matter-invitations]'], ['Private notes', '[data-matter-notes]'],
    ['Activity and status history','[data-workspace-activity]'],
  ];
  for (const [name, selector, back] of entries) {
    await row(page,id).locator('.av2-matter-menu > summary').click();
    await expect(row(page,id).getByRole('link',{name:'Download Matter archive',exact:true})).toHaveCount(0);
    await row(page, id).getByRole('link', { name, exact: true }).click();
    await expect(page.locator(selector)).toHaveAttribute('data-state', 'ready'); expect(new URL(page.url()).pathname).toBe('/attorney-v2.html');
    if (name === 'Archive and restore') {
      await page.getByRole('link', { name: 'Back to Matter review', exact: true }).click(); await workspaceReady(page);
    }
    if (name === 'View invited paralegals') {
      await page.getByRole('link', { name: 'Find a paralegal to invite', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Find a Paralegal', exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Back to Matter', exact: true }).click(); await expect(page.locator(selector)).toHaveAttribute('data-state', 'ready');
    }
    await returnToList(page, href, id, back);
  }
  // A posted, open Matter has no archive download. Establish actual reviewed
  // archive eligibility for this same Case, verify its native archived-list tool,
  // then restore it and the original active-list context.
  const owner=(await(await page.request.get('/api/auth/me')).json()).user.id;
  let review=await api(page,'get',`/api/cases/${id}/archive?expectedOwnerId=${owner}`);
  expect(review.canChange).toBe(true);await api(page,'patch',`/api/cases/${id}/archive`,{revision:review.revision,requestId:require('crypto').randomUUID(),archived:true});
  const archivedHref='#/matters?'+new URLSearchParams({view:'archived',q:title,matterSort:'alphabetical'});
  await page.goto(`/attorney-v2.html${archivedHref}`,{waitUntil:'domcontentloaded'});await listReady(page);await expect(row(page,id)).toBeVisible();
  await row(page,id).locator('.av2-matter-menu > summary').click();await row(page,id).getByRole('link',{name:'Download Matter archive',exact:true}).click();
  await expect(page.locator('[data-matter-export]')).toHaveAttribute('data-state','ready');expect(new URL(page.url()).pathname).toBe('/attorney-v2.html');
  await returnToList(page,archivedHref,id);
  review=await api(page,'get',`/api/cases/${id}/archive?expectedOwnerId=${owner}`);expect(review.archived).toBe(true);await api(page,'patch',`/api/cases/${id}/archive`,{revision:review.revision,requestId:require('crypto').randomUUID(),archived:false});
  await page.goto(`/attorney-v2.html${href}`,{waitUntil:'domcontentloaded'});await listReady(page);expect(new URL(page.url()).hash).toBe(href);await expect(row(page,id)).toBeVisible();
});

test('saved drafts and publication result links retain their original list without leaving V2', async ({ page }) => {
  const title = `Draft return ${Date.now()}`, id = await create(page, title, true);
  const href = '#/matters?' + new URLSearchParams({ view: 'draft', q: title, matterSort: 'alphabetical' });
  await page.goto(`/attorney-v2.html${href}`, { waitUntil: 'domcontentloaded' }); await listReady(page);
  const dialog=page.getByRole('dialog',{name:'New Matter',exact:true});
  async function opened(){await expect(dialog).toBeVisible();await expect(dialog.locator('.av2-compose-save-status')).toHaveText('Saved');await expect(page.getByRole('region',{name:'Draft save status',exact:true,includeHidden:true})).toHaveAttribute('data-state','ready');}
  await row(page,id).getByRole('heading').getByRole('link').click();await opened();
  await page.locator('.av2-creation-header-actions summary[aria-label="Draft actions"]').click();await page.getByRole('button',{name:'Save and exit',exact:true}).click();
  await listReady(page);expect(new URL(page.url()).hash).toBe(href);expect((await api(page,'get',`/api/case-drafts/${id}`)).draft.title).toBe(title);
  await row(page,id).getByRole('heading').getByRole('link').click();await opened();
  await dialog.getByRole('button',{name:'Review Matter →',exact:true}).click();await dialog.getByRole('button',{name:'Confirm and publish Matter',exact:true}).click();
  await workspaceReady(page);await expect(dialog).toBeHidden();expect(new URL(page.url()).pathname).toBe('/attorney-v2.html');
  const receipt=(await api(page,'get',`/api/cases/posting/drafts/${id}`)).publication;expect(receipt.draftId).toBe(id);expect(receipt.status).toBe('posted');await expect(page.locator('[data-matter-workspace]')).toHaveAttribute('data-matter-workspace',receipt.caseId);await expect(page.getByRole('heading',{name:title,level:1,exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Back to Matters',exact:true})).toHaveAttribute('href',href);await page.getByRole('link',{name:'Back to Matters',exact:true}).click();await listReady(page);expect(new URL(page.url()).hash).toBe(href);
});
