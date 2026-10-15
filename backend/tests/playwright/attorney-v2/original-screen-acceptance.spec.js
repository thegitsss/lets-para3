const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;

async function appearance(page, theme, width, enlarged = false) {
  await page.setViewportSize({ width, height: 960 });
  await page.evaluate(({ theme, enlarged }) => {
    window.applyThemePreference?.(theme);
    for (const element of [document.documentElement, document.body]) {
      element.classList.toggle('theme-dark', theme === 'dark');
      element.classList.toggle('theme-light', theme === 'light');
    }
    document.documentElement.style.fontSize = enlarged ? '200%' : '100%';
  }, { theme, enlarged });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

test('recorded original onboarding and New task contrast remain readable in both themes', async ({ page }, info) => {
  await page.addInitScript(() => sessionStorage.removeItem('lpc_attorney_onboarding_dismissed'));
  await page.goto('/dashboard-attorney.html#home', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#overviewMattersBody')).toHaveAttribute('data-state', 'ready');
  const card = page.locator('#attorneyOnboardingAttentionCard');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-onboarding-attention-text]')).not.toHaveText('');
  for (const theme of ['light', 'dark']) {
    await appearance(page, theme, 1366);
    await card.scrollIntoViewIfNeeded();
    expect((await new AxeBuilder({ page }).include('#attorneyOnboardingAttentionCard').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`original-onboarding-${theme}.png`) });
  }
  await page.goto('/dashboard-attorney.html#tasks', { waitUntil: 'domcontentloaded' });
  const create = page.getByRole('button', { name: 'New task', exact: true });
  await expect(create).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await appearance(page, theme, 390, true);
    await create.scrollIntoViewIfNeeded();
    expect((await new AxeBuilder({ page }).include('[data-create-task]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`original-new-task-${theme}-390-enlarged.png`) });
  }
});

test('visible original Notes and task dialog retain text spacing, reflow and keyboard recovery', async ({ page }, info) => {
  await page.goto('/dashboard-attorney.html#tasks', { waitUntil: 'domcontentloaded' });
  const create = page.getByRole('button', { name: 'New task', exact: true });
  await expect(create).toBeVisible();
  const notes = page.locator('#weeklyNotesGrid');
  await expect(notes).toBeVisible();
  await page.addStyleTag({ content: 'body * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [640, 320]) {
    await appearance(page, 'light', width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const box = await notes.boundingBox(); expect(box.width).toBeGreaterThan(0);
    await create.focus(); await create.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'New task', exact: true });
    await expect(dialog).toBeVisible();
    const title = dialog.getByLabel('Task', { exact: true });
    await title.fill('Prepare the chronology and review the original exhibits');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`original-task-text-spacing-${width}.png`), fullPage: true });
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(create).toBeFocused();
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await create.focus(); await expect(create).toBeFocused();
  await create.press('Enter'); await expect(page.getByRole('dialog', { name: 'New task', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(create).toBeFocused();
});
