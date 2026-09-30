const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { randomUUID } = require('node:crypto');
let para;
async function api(client, method, path, data) {
  const csrf = await (await client.get('/api/csrf')).json();
  const user = (await (await client.get('/api/auth/me')).json()).user;
  const response = await client[method](path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
test.beforeAll(async ({ playwright, baseURL }) => {
  expect(new URL(baseURL).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  para = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { 'x-ai-control-room-e2e-secret': process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const response = await para.post('/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal', { headers });
  expect(response.ok()).toBeTruthy();
  const bootstrap = await response.json(), csrf = await (await para.get('/api/csrf')).json();
  const login = await para.post('/api/auth/login', { headers: { 'X-CSRF-Token': csrf.csrfToken }, data: { email: bootstrap.paralegal.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || 'ControlRoomSupport123!' } });
  expect(login.ok()).toBeTruthy();
});
test.afterAll(async () => { await para?.dispose(); });
async function fixture(page) {
  const title = `Review the services agreement for a new commercial engagement — Synthetic Matter ${randomUUID()}`;
  const draft = (await api(page.request, 'post', '/api/case-drafts', { title, practiceArea: 'Contract Law', state: 'New York', compAmount: '400.01', experience: '3+ years', deadline: '2027-03-14', description: 'Private synthetic Matter interface verification.', tasks: [{ title: 'Prepare agreement' }] })).draft;
  const { publication } = await api(page.request, 'post', '/api/cases/posting/publications', { draftId: draft.id, revision: draft.revision, requestId: randomUUID(), practiceArea: 'contract law' });
  await api(para, 'post', `/api/cases/${publication.caseId}/apply`, { coverLetter: 'Private synthetic application for Matter interface inspection.' });
  await page.goto('/dashboard-attorney.html#cases:inquiries', { waitUntil: 'commit' });
  const row = page.locator(`.matter-queue-row[data-case-id="${publication.caseId}"]:visible`);
  await expect(row).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return row;
}
async function theme(page, value, width = 1366, text = '100%') {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(({ value, text }) => { window.applyThemePreference(value); document.documentElement.style.fontSize = text; }, { value, text });
  await expect(page.locator('body')).toHaveClass(new RegExp(`theme-${value}`));
  // Let the application's existing palette transition finish before measuring colors.
  await page.waitForTimeout(350);
}
test('actual theme selection reaches the current shell rows saved views and filters', async ({ page }, info) => {
  test.setTimeout(90000);
  await fixture(page);
  for (const value of ['light', 'dark']) {
    await theme(page, value);
    await page.locator('[data-matter-filter-menu] > summary').click();
    const colors = await page.locator('body, .main, #sidebarNav, .lpc-universal-header-shell, .view-cases .cases-shell, .view-cases .matter-queue-row, .view-cases .matter-filter-panel').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width).map(node => ({ name: node.tagName + '.' + node.className, background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color })));
    await info.attach(`colors-${value}`, { body: JSON.stringify(colors), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath(`shell-${value}-1366.png`), fullPage: true });
    for (const color of colors) {
      const rgb = color.background.match(/[\d.]+/g).map(Number);
      if (rgb.length === 4 && rgb[3] === 0) continue;
      expect.soft(Math.max(...rgb.slice(0, 3)), color.name + ' ' + color.background)[value === 'dark' ? 'toBeLessThan' : 'toBeGreaterThan'](value === 'dark' ? 100 : 200);
    }
    const scan = await new AxeBuilder({ page }).include('#sidebarNav').include('.lpc-universal-header-shell').include('.view-cases').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    await info.attach(`accessibility-${value}`, { body: JSON.stringify(scan.violations), contentType: 'application/json' });
    expect.soft(scan.violations).toEqual([]);
    await page.locator('[data-matter-filter-menu] > summary').click();
  }
});
test('full row text and actions fit at narrow widths and 200 percent text', async ({ page }, info) => {
  test.setTimeout(90000);
  const row = await fixture(page);
  for (const value of ['light', 'dark']) for (const [width, text] of [[1366, '100%'], [768, '100%'], [320, '100%'], [390, '200%']]) {
    await theme(page, value, width, text);
    await row.scrollIntoViewIfNeeded();
    const measurements = await row.evaluate(node => {
      const row = node.getBoundingClientRect();
      return Array.from(node.querySelectorAll('.matter-title-line, .matter-meta-item, .matter-next-copy, .matter-primary-action, .menu-trigger')).filter(item => item.getBoundingClientRect().width && getComputedStyle(item).visibility !== 'hidden').map(item => {
        const rect = item.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(item);
        const fragments = Array.from(range.getClientRects()).map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
        return { selector: item.className, text: item.textContent.trim(), left: rect.left, right: rect.right, rowLeft: row.left, rowRight: row.right, clientWidth: item.clientWidth, scrollWidth: item.scrollWidth, fragments };
      });
    });
    await info.attach(`bounds-${value}-${width}-${text}`, { body: JSON.stringify(measurements), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath(`rows-${value}-${width}-${text}.png`), fullPage: true });
    for (const item of measurements) {
      expect.soft(item.left, item.selector).toBeGreaterThanOrEqual(-1);
      expect.soft(item.right, item.selector).toBeLessThanOrEqual(width + 1);
      expect.soft(item.scrollWidth, item.selector).toBeLessThanOrEqual(item.clientWidth + 1);
      for (const rect of item.fragments) {
        expect.soft(rect.left, item.selector + ' text').toBeGreaterThanOrEqual(item.rowLeft - 1);
        expect.soft(rect.right, item.selector + ' text').toBeLessThanOrEqual(Math.min(item.rowRight, width) + 1);
      }
    }
  }
});
test('a pending Matter presents one count and one useful review action without repeated state copy', async ({ page }, info) => {
  const row = await fixture(page);
  await theme(page, 'light');
  await expect(row.getByRole('button', { name: 'Review 1 applicant', exact: true })).toBeVisible();
  await expect.soft(row).not.toContainText('1 applicant ready for review');
  await expect.soft(row).not.toContainText('Awaiting hire');
  await page.screenshot({ path: info.outputPath('pending-row-copy.png'), fullPage: true });
});
test('category tabs have one keyboard stop and leave search and refinement outside the tab group', async ({ page }) => {
  await fixture(page);
  const tabs = page.getByRole('tablist', { name: 'Matter filters' });
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  await expect(tabs.getByRole('searchbox')).toHaveCount(0);
  const applicants = tabs.getByRole('tab', { name: /^Applicants/ });
  await applicants.focus(); await applicants.press('Home');
  const active = tabs.getByRole('tab', { name: /^Active/ });
  await expect(active).toBeFocused(); await expect(active).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: /^Active/ })).toBeVisible();
  await active.press('ArrowRight');
  const draft = tabs.getByRole('tab', { name: /^Draft/ });
  await expect(draft).toBeFocused(); await expect(draft).toHaveAttribute('aria-selected', 'true');
  await draft.press('End'); await expect(applicants).toBeFocused();
  await applicants.press('Tab'); await expect(page.getByRole('searchbox', { name: 'Search matters', exact: true })).toBeFocused();
  await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
});

async function inspect(page, locator, label, info) {
  await locator.scrollIntoViewIfNeeded();
  const bounds = await locator.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }));
  expect.soft(bounds.left, label).toBeGreaterThanOrEqual(-1);
  expect.soft(bounds.right, label).toBeLessThanOrEqual(page.viewportSize().width + 1);
  expect.soft(bounds.scrollWidth, label).toBeLessThanOrEqual(bounds.width + 1);
  await page.screenshot({ path: info.outputPath(label + '.png'), fullPage: true });
}
test('row actions stay grouped and closed drawers occupy no space', async ({ page }, info) => {
  const row = await fixture(page);
  const caseId = await row.getAttribute('data-case-id');
  await theme(page, 'light');
  const primary = await row.locator('.matter-primary-action').boundingBox(), menu = await row.locator('[data-case-menu-trigger]').boundingBox();
  expect.soft(Math.abs((primary.y + primary.height / 2) - (menu.y + menu.height / 2))).toBeLessThanOrEqual(2);
  await expect.soft(page.locator(`[data-applicants-row][data-case-id="${caseId}"]`)).not.toBeVisible();
  await page.screenshot({ path: info.outputPath('row-actions-and-closed-drawer.png'), fullPage: true });
});
test('refinement and the action menu stay readable at narrow widths and enlarged text', async ({ page }, info) => {
  test.setTimeout(90000);
  const row = await fixture(page);
  for (const value of ['light', 'dark']) for (const [width, text] of [[1366, '100%'], [320, '100%'], [390, '200%']]) {
    await theme(page, value, width, text);
    const refine = page.locator('[data-matter-filter-menu]');
    await refine.locator('summary').click();
    await inspect(page, refine.locator('.matter-filter-panel'), `refine-${value}-${width}-${text}`, info);
    const violations = (await new AxeBuilder({ page }).include('.matter-filter-panel').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations;
    expect.soft(violations).toEqual([]);
    await refine.locator('summary').click();
    const trigger = row.locator('[data-case-menu-trigger]'); await trigger.click();
    const menu = row.locator('.case-menu');
    await inspect(page, menu, `menu-${value}-${width}-${text}`, info);
    const menuBox = await menu.boundingBox();
    expect(menuBox.y).toBeGreaterThanOrEqual(7);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(page.viewportSize().height - 7);
    // Safari on macOS uses Option-Tab for all controls with its default preference.
    const tabKey = info.project.name === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
    await trigger.focus(); await trigger.press(tabKey);
    await expect(menu.getByRole('button').first()).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await expect(menu.getByRole('button').first()).toBeFocused();
    expect.soft((await new AxeBuilder({ page }).include('.case-menu[style*="fixed"]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  }
});
test('the existing applicant drawer remains readable with keyboard selection and close return', async ({ page }, info) => {
  test.setTimeout(90000);
  const row = await fixture(page), caseId = await row.getAttribute('data-case-id');
  const toggle = row.locator('[data-applicants-toggle]'); await toggle.click();
  const drawer = page.locator(`[data-applicants-drawer][data-case-id="${caseId}"]`);
  await expect(drawer.locator('[data-applicant-detail]')).toContainText('Private synthetic application for Matter interface inspection.');
  for (const value of ['light', 'dark']) for (const [width, text] of [[1366, '100%'], [320, '100%'], [390, '200%']]) {
    await theme(page, value, width, text);
    await inspect(page, drawer, `drawer-${value}-${width}-${text}`, info);
    const name = drawer.locator('.applicant-card-name');
    expect(await name.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await expect(name).toHaveCSS('white-space', 'normal');
    const violations = (await new AxeBuilder({ page }).include(`[data-applicants-drawer][data-case-id="${caseId}"]`).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations;
    await info.attach(`drawer-accessibility-${value}-${width}-${text}`, { body: JSON.stringify(violations), contentType: 'application/json' });
    expect.soft(violations).toEqual([]);
  }
  const candidate = drawer.locator('[data-applicant-row]');
  await expect(candidate).toHaveAttribute('type', 'button');
  await candidate.focus(); await candidate.press('Enter');
  await expect(candidate).toHaveAttribute('aria-pressed', 'true');
  await expect(drawer.locator('.applicant-drawer-title')).toHaveText('Applicants');
  expect(await drawer.locator('.applicant-avatar img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
  await drawer.getByRole('button', { name: 'Close applicants', exact: true }).click();
  await expect(toggle).toBeFocused(); await expect(drawer).not.toBeVisible();
});

test('Matter dropdowns retain full size readable values and keyboard access in both themes', async ({ page }, info) => {
  test.setTimeout(90000);
  await fixture(page);
  const tabKey = info.project.name === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
  for (const value of ['light', 'dark']) for (const [width, text] of [[1366, '100%'], [320, '100%'], [390, '200%']]) {
    await theme(page, value, width, text);
    const refine = page.locator('[data-matter-filter-menu]');
    await refine.locator('summary').click();
    const selects = page.locator('.view-cases select:visible');
    await expect(selects).toHaveCount(5);
    const metrics = await selects.evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      context.font = style.font;
      return { id: node.id, height: rect.height, left: rect.left, right: rect.right, fontSize: parseFloat(style.fontSize), textWidth: context.measureText(node.selectedOptions[0].textContent).width, availableWidth: node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    }));
    await info.attach(`dropdown-bounds-${value}-${width}-${text}`, { body: JSON.stringify(metrics), contentType: 'application/json' });
    for (const metric of metrics) {
      expect.soft(metric.height, metric.id).toBeGreaterThanOrEqual(44);
      expect.soft(metric.height, metric.id).toBeGreaterThanOrEqual(metric.fontSize * 1.25);
      expect.soft(metric.left, metric.id).toBeGreaterThanOrEqual(-1);
      expect.soft(metric.right, metric.id).toBeLessThanOrEqual(width + 1);
      expect.soft(metric.textWidth, metric.id).toBeLessThanOrEqual(metric.availableWidth + 1);
    }
    const sort = page.getByLabel('Sort', { exact: true });
    await sort.focus(); await sort.press('Shift+' + tabKey); await page.keyboard.press(tabKey);
    await expect(sort).toBeFocused();
    expect(await sort.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
    await inspect(page, refine.locator('.matter-filter-panel'), `dropdowns-${value}-${width}-${text}`, info);
    await refine.locator('summary').click();
  }
});
