const { test, expect } = require('../posting-refresh-actual-fixture.cjs');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs/promises');
const fields = { title: 'Discovery responses for the River Street commercial lease and retained exhibits', practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Review the discovery responses.\n\nKeep the original exhibit names.', tasks: [{ title: 'Prepare agreement' }] };
let admin;
async function api(client, method, path, data) {
  const csrf = await (await client.get('/api/csrf')).json(), user = (await (await client.get('/api/auth/me')).json()).user;
  const response = await client[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
test.beforeAll(async ({ playwright, foundationServer }) => {
  const actor=await foundationServer.createActor('admin');
  admin=await playwright.request.newContext({baseURL:foundationServer.origin,storageState:{cookies:[(({url,...cookie})=>({...cookie,expires:typeof cookie.expires==='number'?cookie.expires:-1,httpOnly:cookie.httpOnly??false,secure:cookie.secure??false,sameSite:cookie.sameSite||'Lax',domain:new URL(url).hostname,path:'/'}))(actor.cookie)],origins:[]}});
});
test.afterAll(async () => admin?.dispose());

for (const surface of ['management-idle', 'management-review', 'current-notes', 'current-review']) test(`${surface} has one Matter identity and readable relevant controls`, async ({ page }, info) => {
  test.setTimeout(180000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  const draft = (await api(page.request, 'post', '/api/case-drafts', fields)).draft;
  const { publication } = await api(page.request, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: require('crypto').randomUUID(), practiceArea: 'contract law' });
  const id = publication.caseId, current = surface.startsWith('current'), flagged = surface.endsWith('review');
  const note = await api(page.request, 'get', `/api/cases/${id}/notes`);
  await api(page.request, 'put', `/api/cases/${id}/notes`, { note: 'Retain the original exhibit labels.\n\nReview the missing references before delivery.', revision: note.revision });
  if (flagged) await api(admin, 'post', `/api/cases/${id}/flags/request-edits`, { message: 'Clarify the public scope.\n\nIdentify the missing exhibit references before requesting review.' });
  const before = await api(page.request, 'get', `/api/cases/${id}`), mutations = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith(`/api/cases/${id}`) && request.method() !== 'GET') mutations.push({ method: request.method(), path: new URL(request.url()).pathname }); });
  await page.goto(current ? '/dashboard-attorney.html#cases:active' : `/attorney-v2.html#/matters/${id}/manage`, { waitUntil: 'domcontentloaded' });
  if (current) {
    const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first(); await actions.locator('[data-case-menu-trigger]').click();
    await actions.getByRole('button', { name: flagged ? 'Review admin edit request' : 'Edit Matter note', exact: true }).click();
  }
  const root = page.locator(current ? '#caseNoteModal' : '.av2-view[aria-labelledby="av2-page-title"]');
  await expect(root.locator(flagged ? '[data-matter-moderation]' : '[data-matter-notes]')).toHaveAttribute('data-state', 'ready');
  if(!current){await root.evaluate(element=>element.readiness);await expect(root.locator('[data-matter-moderation]')).toHaveAttribute('data-state','ready');await root.locator('[data-matter-notes]').getByRole('button',{name:'Edit note',exact:true}).click();}
  const failures = [], observations = [];
  for (const relevantSurface of current ? ['current'] : ['management','activity']) {
   if(!current&&relevantSurface==='activity'){await page.getByRole('navigation',{name:'Matter sections',exact:true}).getByRole('link',{name:'Activity',exact:true}).click();await expect(page.locator('[data-workspace-activity]')).toHaveAttribute('data-state','ready');await expect(page.locator('[data-workspace-activity]')).toContainText('Posted');}
   const relevantSelector=current?'#caseNoteModal':relevantSurface==='management'?'.av2-matter-header, [data-matter-moderation], [data-matter-notes]':'.av2-matter-header, [data-workspace-activity]';
  for (const variant of [
    { name: 'desktop-light', width: 1366, theme: 'light', size: '16px' },
    { name: 'desktop-dark', width: 1366, theme: 'dark', size: '16px' },
    { name: 'phone-light', width: 390, theme: 'light', size: '16px' },
    { name: 'phone-dark', width: 390, theme: 'dark', size: '16px' },
    { name: 'narrow-dark-enlarged', width: 320, theme: 'dark', size: '32px' },
  ]) {
    await page.setViewportSize({ width: variant.width, height: 900 });
    await page.evaluate(value => {
      for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${value.theme}`); }
      document.documentElement.style.fontSize = value.size;
    }, variant);
    await root.evaluate(element => { for (let parent = element; parent; parent = parent.parentElement) if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) parent.scrollTop = 0; });
    const metricsParts = await page.locator(relevantSelector).evaluateAll(elements => elements.map(element=>{
      const visible = node => { if(!node.getClientRects().length || node.closest('[hidden]'))return false; if(typeof node.checkVisibility==='function'&&!node.checkVisibility({checkVisibilityCSS:true}))return false; for(let details=node.closest('details:not([open])');details;details=details.parentElement?.closest('details:not([open])'))if(!details.querySelector(':scope > summary')?.contains(node))return false; return true; };
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        visibilityChecks:[...element.querySelectorAll('a,button,input,textarea,summary')].map(node=>({name:node.textContent.trim().slice(0,90)||node.getAttribute('aria-label')||node.tagName,visible:visible(node),nativeCheckVisibility:typeof node.checkVisibility==='function'?node.checkVisibility({checkVisibilityCSS:true}):null,cssVisibility:getComputedStyle(node).visibility,insideClosedDetails:Boolean(node.closest('details:not([open])'))})),
        headings: [...element.querySelectorAll('h1,h2,h3')].filter(visible).map(node => node.textContent.trim()),
        text: [...element.querySelectorAll('p,dt,dd,label')].filter(node => visible(node) && node.textContent.trim()).map(node => ({ text: node.textContent.trim().slice(0, 180), font: parseFloat(getComputedStyle(node).fontSize) })),
        controls: [...element.querySelectorAll('a,button,input,textarea,summary')].filter(visible).map(node => {
          const b = node.getBoundingClientRect(); return { name: node.textContent.trim().slice(0, 90) || node.getAttribute('aria-label') || node.tagName, width: b.width, height: b.height, font: parseFloat(getComputedStyle(node).fontSize), contained: b.left >= -1 && b.right <= innerWidth + 1, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
        }),
      };
    }));
    const metrics={visibilityChecks:metricsParts.flatMap(value=>value.visibilityChecks),overflow:metricsParts.some(value=>value.overflow),headings:metricsParts.flatMap(value=>value.headings),text:metricsParts.flatMap(value=>value.text),controls:metricsParts.flatMap(value=>value.controls)};
    let axe=new AxeBuilder({page});for(const selected of relevantSelector.split(', '))axe=axe.include(selected);
    const violations = (await axe.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    await page.screenshot({ path: info.outputPath(`${surface}-${relevantSurface}-${variant.name}-overview.png`) });
    if (!current&&relevantSurface==='management') { await root.locator('[data-matter-notes]').scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`${surface}-${variant.name}-notes.png`) }); }
    const minimum = variant.size === '32px' ? 28 : 14;
    if (metrics.overflow) failures.push(`${variant.name}: document overflow`);
    if (metrics.headings.filter(text => text === fields.title).length !== 1) failures.push(`${variant.name}: repeated or missing Matter identity`);
    if (metrics.text.some(item => item.text === 'Note for this Matter')) failures.push(`${variant.name}: repeated note field label`);
    if (metrics.text.some(item => item.text === 'Review status is up to date.')) failures.push(`${variant.name}: unsolicited review-status confirmation`);
    if (surface === 'management-idle' && metrics.controls.some(item => ['Review my changes', 'Read Matter notes', 'Review or edit posting'].includes(item.name))) failures.push(`${variant.name}: irrelevant review actions without an admin request`);
    for (const item of metrics.text) if (item.font < minimum) failures.push(`${variant.name}: small text ${item.text}`);
    for (const item of metrics.controls) if (item.width < 44 || item.height < 44 || item.font < minimum || !item.contained || item.scrollWidth > item.clientWidth + 2) failures.push(`${variant.name}: control bounds/readability ${item.name}`);
    if (violations.length) failures.push(`${variant.name}: ${violations.map(item => item.id).join(', ')}`);
    observations.push({ relevantSurface,...variant, ...metrics, violations });
    await fs.writeFile(info.outputPath('management-layout.json'), JSON.stringify({ surface, observations, failures }, null, 2));
  }
  }
  expect(await api(page.request, 'get', `/api/cases/${id}`)).toEqual(before);
  expect(mutations).toEqual([]); expect(pageErrors).toEqual([]);
  await fs.writeFile(info.outputPath('management-evidence.json'), JSON.stringify({ surface, actualMatterUnchanged: true, mutations, pageErrors, failures }, null, 2));
  expect(failures).toEqual([]);
});
