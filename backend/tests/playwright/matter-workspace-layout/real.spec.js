const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs/promises');
const start = require('../../helpers/paralegalFinancialBrowserServer');
let server, record;
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ workspace: true }); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ context }) => {
  record = await server.seed({ workspaceDetails: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
});

for (const role of ['paralegal', 'attorney']) test(`${role} actual Matter overview and navigation remain clear, readable and unobscured`, async ({ page, context }, info) => {
  test.setTimeout(180000);
  await context.addCookies([record[role === 'paralegal' ? 'para' : 'attorney'].cookie]);
  const before = await server.inspect(record.activeId), pageErrors = [], failures = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const route = role === 'paralegal' ? `/paralegal-v2.html#/matter/${record.activeId}?tab=overview` : `/attorney-v2.html#/matters/${record.activeId}/overview`;
  await page.goto(route);
  const root = page.locator(role === 'paralegal' ? '[data-v2-matter]' : '[data-matter-workspace]');
  await expect(root.getByRole('heading', { level: 1 })).toHaveText(before.case.title);
  if (role === 'attorney') await expect(root.locator('[data-matter-notes]')).toHaveAttribute('data-state', 'ready');
  const observations = [];
  for (const variant of [
    { name: 'desktop-light', width: 1366, theme: 'light', size: '17px' },
    { name: 'desktop-short-light', width: 1366, height: 600, theme: 'light', size: '17px' },
    { name: 'phone-dark', width: 390, theme: 'dark', size: '17px' },
    { name: 'narrow-dark-enlarged', width: 320, theme: 'dark', size: '34px' },
  ]) {
    await page.setViewportSize({ width: variant.width, height: variant.height || 1000 });
    await page.evaluate(value => {
      for (const element of [document.documentElement, document.body]) { element.classList.remove('theme-light', 'theme-dark'); element.classList.add(`theme-${value.theme}`); }
      document.documentElement.style.fontSize = value.size;
    }, variant);
    await root.evaluate(element => { for (let parent = element; parent; parent = parent.parentElement) if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) parent.scrollTop = 0; });
    const metrics = await root.evaluate(element => {
      const visible = node => node.getClientRects().length && !node.closest('[hidden]');
      const rect = element.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        headings: [...element.querySelectorAll('h1,h2,h3')].filter(visible).map(node => node.textContent.trim()),
        description: (() => { const node = element.querySelector('.v2-matter-summary,.av2-preserve-lines'); return { text: node?.textContent, whiteSpace: node && getComputedStyle(node).whiteSpace }; })(),
        text: [...element.querySelectorAll('p,dt,dd,label')].filter(node => visible(node) && node.textContent.trim()).map(node => ({ text: node.textContent.trim().slice(0, 160), font: parseFloat(getComputedStyle(node).fontSize) })),
        controls: [...element.querySelectorAll('a,button,input,textarea,summary')].filter(visible).map(node => {
          const box = node.getBoundingClientRect();
          return { name: node.textContent.trim().slice(0, 80) || node.getAttribute('aria-label') || node.tagName, width: box.width, height: box.height, font: parseFloat(getComputedStyle(node).fontSize), contained: box.left >= Math.max(0, rect.left) - 1 && box.right <= Math.min(innerWidth, rect.right) + 1, horizontalTab: Boolean(node.closest('.v2-matter-tabs,.av2-matter-tabs')), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
        }),
      };
    });
    const violations = (await new AxeBuilder({ page }).include(role === 'paralegal' ? '[data-v2-matter]' : '[data-matter-workspace]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations;
    await page.screenshot({ path: info.outputPath(`${role}-${variant.name}-overview.png`) });
    const tabFocus = [];
    for (const tab of await root.locator('.v2-matter-tabs a,.av2-matter-tabs a').all()) {
      await tab.focus();
      tabFocus.push(await tab.evaluate(element => {
        const b = element.getBoundingClientRect(), hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { name: element.textContent, focused: document.activeElement === element, unobscured: hit === element || element.contains(hit), bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, hit: hit?.tagName + '.' + hit?.className };
      }));
      if (!tabFocus.at(-1).unobscured) await page.screenshot({ path: info.outputPath(`${role}-${variant.name}-obscured-${tabFocus.at(-1).name}.png`) });
    }
    const back = root.getByRole('link', { name: role === 'paralegal' ? '← My Matters' : 'Back to Matters', exact: true });
    await back.evaluate(element => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) { parent.scrollTop += element.getBoundingClientRect().top - 30; break; }
      }
    });
    const chrome = role === 'paralegal' ? await page.locator('.v2-app-frame').evaluate(async element => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const view = element.querySelector('[data-v2-route-outlet]'), toolbar = element.querySelector('.v2-header'), bounds = toolbar.getBoundingClientRect();
      return { scrollTop: view.scrollTop, markedScrolled: view.hasAttribute('data-v2-scrolled'), toolbarWidth: bounds.width, frameWidth: element.getBoundingClientRect().width };
    }) : null;
    if (chrome && variant.name === 'desktop-short-light') {
      if (chrome.scrollTop <= 0) failures.push(`${variant.name}: scrolled header scenario was not exercised`);
      await page.screenshot({ path: info.outputPath(`${role}-${variant.name}-scrolled-header.png`) });
    }
    await back.focus();
    const focus = await back.evaluate(element => {
      const b = element.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, hit = document.elementFromPoint(x, y);
      return { focused: document.activeElement === element, unobscured: hit === element || element.contains(hit), bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, hit: hit?.tagName + '.' + hit?.className };
    });
    await page.screenshot({ path: info.outputPath(`${role}-${variant.name}-navigation-focus.png`) });
    observations.push({ ...variant, ...metrics, violations, focus, tabFocus, chrome });
    const minimum = variant.size === '34px' ? 28 : 14;
    if (metrics.overflow) failures.push(`${variant.name}: document overflow`);
    if (metrics.description.text !== before.case.details || !['pre-wrap', 'pre-line', 'break-spaces'].includes(metrics.description.whiteSpace)) failures.push(`${variant.name}: original Matter paragraphs are not preserved`);
    if (!focus.focused || !focus.unobscured) failures.push(`${variant.name}: focused return link is obscured`);
    if (chrome && variant.width > 900 && chrome.scrollTop > 0 && (!chrome.markedScrolled || Math.abs(chrome.toolbarWidth - chrome.frameWidth) > 1)) failures.push(`${variant.name}: scrolled toolbar does not cover its full header row`);
    for (const item of tabFocus) if (!item.focused || !item.unobscured) failures.push(`${variant.name}: focused ${item.name} tab is obscured`);
    if (metrics.headings.filter(title => title === before.case.title).length !== 1) failures.push(`${variant.name}: repeated Matter title`);
    if (metrics.headings.includes('Overview')) failures.push(`${variant.name}: repeated selected Overview label`);
    for (const item of metrics.text) if (item.font < minimum) failures.push(`${variant.name}: small text ${item.text}`);
    for (const item of metrics.controls) if (item.width < 44 || item.height < 44 || item.font < minimum || !item.contained && !item.horizontalTab || item.scrollWidth > item.clientWidth + 2) failures.push(`${variant.name}: control bounds/readability ${item.name}`);
    if (violations.length) failures.push(`${variant.name}: ${violations.map(item => item.id).join(', ')}`);
    await fs.writeFile(info.outputPath('workspace-layout.json'), JSON.stringify({ role, observations, failures }, null, 2));
  }
  expect(await server.inspect(record.activeId)).toEqual(before);
  const evidence = { ...server.evidence(), financialRecordsUnchanged: true, pageErrors, observations, failures };
  await fs.writeFile(info.outputPath('workspace-evidence.json'), JSON.stringify(evidence, null, 2));
  expect(pageErrors).toEqual([]); expect(evidence.provider).toEqual([]); expect(evidence.mail).toEqual([]);
  expect(failures).toEqual([]);
});

test('embedded attorney notes retain uncertain edits, reconcile conflicts and preserve financial records', async ({ page, context }, info) => {
  await context.addCookies([record.attorney.cookie]);
  const before = await server.inspect(record.activeId), notesPath = `/api/cases/${record.activeId}/notes`;
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`/attorney-v2.html#/matters/${record.activeId}/overview`);
  const panel = page.locator('[data-matter-notes]'), input = panel.getByRole('textbox', { name: 'Notes', exact: true }), feedback = panel.locator('[data-note-feedback]');
  await expect(panel).toHaveAttribute('data-state', 'ready'); await expect(input).toBeEnabled();
  await expect(feedback).toHaveText(''); await expect(panel).not.toContainText(before.case.title);
  await expect(panel).not.toContainText('0 / 10,000');
  let submitted = 0;
  await page.route(`**${notesPath}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    submitted += 1; const response = await route.fetch();
    if (submitted === 1) { expect(response.status()).toBe(200); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic acknowledgement loss after commit' }) }); }
    return route.fulfill({ response });
  });
  const save = () => panel.getByRole('button', { name: 'Save Matter note', exact: true }).click();
  const check = () => panel.getByRole('button', { name: 'Check saved note', exact: true }).click();
  await input.fill('Submitted private note\n\nRetain these paragraphs.'); await save(); await expect(panel).toHaveAttribute('data-state', 'uncertain');
  await input.fill('Later private edit retained'); await check(); await expect(feedback).toContainText('submitted note is saved'); await expect(input).toHaveValue('Later private edit retained'); expect(submitted).toBe(1);
  await input.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('embedded-note-recovered.png') });
  await save(); await expect(feedback).toHaveText('Matter note saved.');
  const saved = await (await page.request.get(notesPath)).json();
  expect((await page.request.put(notesPath, { data: { expectedOwnerId: record.attorney.id, note: 'Changed in another attorney tab', revision: saved.revision } })).status()).toBe(200);
  await input.fill('My final reviewed note'); await save(); await expect(panel).toHaveAttribute('data-state', 'uncertain');
  await check(); await expect(panel).toHaveAttribute('data-state', 'conflict'); await expect(panel.locator('pre')).toHaveText('Changed in another attorney tab');
  await panel.getByRole('button', { name: 'Keep my edits for review', exact: true }).click();
  expect((await (await page.request.get(notesPath)).json()).note).toBe('Changed in another attorney tab');
  await save(); await expect(feedback).toHaveText('Matter note saved.');
  expect((await (await page.request.get(notesPath)).json()).note).toBe('My final reviewed note');
  await input.fill(''); await save(); await expect(panel.getByRole('heading', { name: 'Save an empty note?', exact: true })).toBeVisible();
  expect((await (await page.request.get(notesPath)).json()).note).toBe('My final reviewed note');
  await panel.getByRole('button', { name: 'Confirm empty note', exact: true }).click(); await expect(feedback).toHaveText('Matter note saved.');
  await check(); await expect(feedback).toHaveText('Saved note is up to date.');
  const denied = await page.request.get(notesPath, { headers: { Cookie: `token=${record.para.cookie.value}` } }); expect(denied.status()).toBe(403);
  const final = await server.inspect(record.activeId); expect(final.case.internalNotes.text).toBe(''); delete final.case.internalNotes; delete before.case.internalNotes; expect(final).toEqual(before);
  expect(submitted).toBe(5); expect(pageErrors).toEqual([]);
  const evidence = { ...server.evidence(), pageErrors, submittedFromUi: submitted, financialRecordsUnchanged: true, paralegalReadStatus: denied.status() };
  expect(evidence.provider).toEqual([]); expect(evidence.mail).toEqual([]); expect(evidence.financialRequests.every(item => item.method === 'GET')).toBe(true);
  await fs.writeFile(info.outputPath('embedded-note-evidence.json'), JSON.stringify(evidence, null, 2));
});
