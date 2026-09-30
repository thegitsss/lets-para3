const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const AxeBuilder = require('@axe-core/playwright').default;
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start(); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

async function api(context, method, path, data) {
  const csrf = await (await context.request.get(server.origin + '/api/csrf')).json();
  const response = await context.request[method](server.origin + path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
  expect(response.headers()['x-lpc-test-server']).toBe('financial-lifecycle-browser');
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

// Read the final words' painted rectangle, including every clipping ancestor.
// The test scrolls through normal wheel/keyboard input; it never changes scrollTop.
async function paintedText(locator, words) {
  return locator.evaluate((element, words) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      const index = text.textContent.indexOf(words);
      if (index < 0) continue;
      const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + words.length);
      const rectangles = [...range.getClientRects()].map(rect => rect.toJSON());
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let parent = text.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { clip.top = Math.max(clip.top, box.top); clip.bottom = Math.min(clip.bottom, box.bottom); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { clip.left = Math.max(clip.left, box.left); clip.right = Math.min(clip.right, box.right); }
      }
      return { rectangles, clip, visible: rectangles.length > 0 && rectangles.every(box => box.left >= clip.left - 1 && box.right <= clip.right + 1 && box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1) };
    }
    return { visible: false, missing: true };
  }, words);
}

async function wheelToText(page, scroll, locator, words) {
  const box = await scroll.boundingBox();
  await page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height / 2, 750));
  let steps = 0;
  await expect.poll(async () => {
    const view = await paintedText(locator, words);
    if (view.visible) return true;
    const direction = view.rectangles?.at(-1)?.bottom > view.clip?.bottom ? 1 : -1;
    await page.mouse.wheel(0, direction * 1200); steps++;
    return false;
  }, { intervals: [100, 200, 300] }).toBe(true);
  return steps;
}

for (const entry of ['current', 'v2']) test(`actual ${entry} retained application exposes its lower letter and scope through scrolling and keyboard return`, async ({ browser }, info) => {
  const contexts = [], errors = [], views = [];
  let caseId;
  try {
    const people = {};
    for (const role of ['attorney', 'paralegal']) {
      const user = await server.createUser(role, {}, true), context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
      contexts.push(context); await context.addCookies([user.cookie]);
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
      const page = await context.newPage(); page.on('pageerror', error => errors.push({ role, message: error.message }));
      people[role] = { ...user, context, page };
    }
    const lastWords = 'I will return the final index for attorney review.';
    const coverLetter = Array.from({ length: 12 }, (_, index) => `Section ${index + 1}: I can organize the supporting exhibits, preserve the source page numbers, and record the references that need the attorney’s review.`).join('\n\n') + '\n\n' + lastWords;
    expect(coverLetter.length).toBeLessThanOrEqual(2000);
    const lastTask = 'Deliver the final exhibit index with source references';
    const tasks = [...Array.from({ length: 9 }, (_, index) => ({ title: `Review exhibit group ${index + 1} and preserve its page references` })), { title: lastTask }];
    const description = 'Organize the River Street filing records.\n\nRetain the source documents and prepare an exhibit index for the attorney.';
    const title = 'River Street retained application';
    const posted = await api(people.attorney.context, 'post', '/api/cases', { title, practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description, tasks });
    caseId = String(posted.case?._id || posted.case?.id || posted._id || posted.id);
    await api(people.paralegal.context, 'post', `/api/jobs/${posted.jobId}/apply`, { coverLetter });
    const findOwn = async () => (await api(people.paralegal.context, 'get', '/api/applications/my')).find(row => String(row.caseId) === caseId);
    const submitted = await findOwn(), applicationId = String(submitted._id || submitted.id);
    expect(applicationId).toMatch(/^[a-f0-9]{24}$/);
    await api(people.paralegal.context, 'post', `/api/applications/${applicationId}/revoke`, {});
    const saved = await findOwn(); expect(saved).toMatchObject({ status: 'withdrawn', pending: false, coverLetter });
    const page = people.paralegal.page;
    await page.goto(server.origin + (entry === 'current' ? '/dashboard-paralegal.html#cases' : '/paralegal-v2.html#/work?section=applications'));
    // The freshly created retained record is already in the original Recent
    // applications view; its date control is intentionally hidden there.
    if (entry === 'v2') await page.getByLabel('Application saved view').selectOption('built:all');
    const launcher = entry === 'current' ? page.locator(`[data-application-view][data-job-id="${posted.jobId}"]`) : page.locator(`[data-work-application-id="${applicationId}"]`).getByRole('button', { name: 'Details', exact: true });
    const dialog = entry === 'current' ? page.locator('#applicationDetailModal') : page.getByRole('dialog', { name: title, exact: true });
    for (const [width, theme, fontSize] of [[1366, 'light', '100%'], [320, 'dark', '100%'], [390, 'dark', '200%']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(({ theme, fontSize }) => {
        if (window.applyThemePreference) window.applyThemePreference(theme);
        else for (const node of [document.documentElement, document.body]) { node.classList.remove('theme-light', 'theme-dark'); node.classList.add(`theme-${theme}`); }
        document.documentElement.style.fontSize = fontSize;
      }, { theme, fontSize });
      await launcher.click(); await expect(dialog).toBeVisible(); await expect(dialog).toContainText('Withdrawn');
      await expect(dialog.getByRole('button', { name: 'Withdraw application', exact: true })).toBeHidden();
      const letter = entry === 'current' ? dialog.locator('.application-cover p') : dialog.locator('.v2-work-dialog-copy').filter({ has: page.getByRole('heading', { name: 'Cover letter', exact: true }) }).locator('p');
      await expect(letter).toHaveText(coverLetter, { useInnerText: true });
      const scroll = entry === 'current' ? dialog.locator('.application-detail') : dialog;
      const before = await paintedText(letter, lastWords); expect(before.visible).toBe(false);
      const letterScrollSteps = await wheelToText(page, scroll, letter, lastWords);
      const letterEnd = await paintedText(letter, lastWords);
      console.log(`Retained application: ${entry} ${width} ${fontSize} letter reached`);
      await page.screenshot({ path: info.outputPath(`${entry}-${theme}-${width}-${fontSize}-letter-end.png`), animations: 'disabled' });
      const scopeControl = entry === 'current' ? dialog.locator('.application-detail-actions > summary') : dialog.getByRole('button', { name: 'Matter details', exact: true });
      // From the close control, ordinary native keyboard navigation must reach
      // the only lower action without requiring a pointer or forced click.
      await dialog.getByRole('button', { name: 'Close application details', exact: true }).focus();
      await page.keyboard.press(info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
      if (entry === 'current' && info.project.name === 'firefox') {
        // Firefox includes this native overflow region in its tab sequence.
        await expect(scroll).toBeFocused(); await page.keyboard.press('Tab');
      }
      await expect(scopeControl).toBeFocused(); await page.keyboard.press('Enter');
      const task = dialog.getByText(lastTask, { exact: true }); await expect(task).toBeVisible();
      const scopeScrollSteps = await wheelToText(page, scroll, task, lastTask);
      const scopeEnd = await paintedText(task, lastTask); expect(scopeEnd.visible).toBe(true);
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      const violations = (await new AxeBuilder({ page }).include(entry === 'current' ? '#applicationDetailModal' : '.v2-work-application-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations;
      expect(violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${entry}-${theme}-${width}-${fontSize}-scope-end.png`), animations: 'disabled' });
      views.push({ width, theme, fontSize, letterEnd, scopeEnd, letterScrollSteps, scopeScrollSteps, violations });
      await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(launcher).toBeFocused();
      console.log(`Retained application: ${entry} ${width} ${fontSize} scope and keyboard return verified`);
    }
    const after = await findOwn(); expect(after).toEqual(saved);
    expect((await server.inspect(caseId)).operations).toEqual([]);
    expect(errors).toEqual([]); expect(server.evidence().assets.filter(row => row.status >= 400)).toEqual([]);
    expect(server.evidence().external.mail).toEqual([]);
  } finally {
    await fs.writeFile(info.outputPath('scroll-evidence.json'), JSON.stringify({ entry, caseId, views, errors, requests: server.evidence().requests, assets: server.evidence().assets }, null, 2));
    for (const context of contexts) await context.close();
  }
});
