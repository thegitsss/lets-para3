const { test } = require('../assistant-completion/shell-fixture');
const { expect } = require('playwright/test');
const { installSettingsProjection } = require('./settings-fixtures');
const AxeBuilder = require('@axe-core/playwright').default;

function expectSameGeometry(actual, expected) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((box, index) => {
    for (const dimension of ['x', 'y', 'width', 'height']) {
      // Firefox's viewport-relative subtraction varies by up to 0.000062
      // CSS pixels after scrolling. Preserve subpixel layout assertions
      // without treating floating-point rounding as movement.
      expect(box[dimension]).toBeCloseTo(expected[index][dimension], 3);
    }
  });
}

for (const width of [1440, 390]) {
  test(`profile rows stay fixed during inline editing at ${width}`, async ({ page }, info) => {
    const state = await installSettingsProjection(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/paralegal-v2.html#/settings?tab=profile');
    const list = page.locator('.v2-profile-editor-list');
    await expect(page.getByRole('button', { name: 'Edit name', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const geometry = () => list.locator(':scope > *').evaluateAll(nodes => nodes.map(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y - el.parentElement.getBoundingClientRect().y, width: r.width, height: r.height };
    }));
    const initial = await geometry();
    for (let i = 1; i < initial.length; i++) {
      expect(initial[i].x).toBeCloseTo(initial[0].x, 0);
      expect(initial[i].y).toBeGreaterThanOrEqual(initial[i-1].y + initial[i-1].height - 1);
    }
    for (const edit of await list.locator('.v2-profile-row-edit').all()) {
      await edit.hover();
      await edit.click();
      const editor = page.locator('#v2-settings-profile .is-row-editing');
      await expect(editor).toHaveCount(1);
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      expectSameGeometry(await geometry(), initial);
      const control = editor.locator('input:not([type="file"]), textarea, select').filter({ visible: true }).first();
      if (await control.count()) {
        await control.focus();
        expectSameGeometry(await geometry(), initial);
      }
      await page.keyboard.press('Escape');
      await expect(editor).toHaveCount(0);
      await expect(edit).toBeFocused();
      expectSameGeometry(await geometry(), initial);
    }
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    const first = page.getByRole('textbox', { name: 'First name', exact: false });
    const patches = state.profilePatches.length;
    await first.fill('Danielle');
    await first.blur();
    expect(state.profilePatches).toHaveLength(patches);
    await page.locator('.is-row-editing').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => state.user.firstName).toBe('Danielle');
    await expect(page.getByRole('button', { name: 'Edit name', exact: true })).toContainText('Danielle');
    expectSameGeometry(await geometry(), initial);
    await page.getByRole('button', { name: 'Edit skills', exact: true }).click();
    await page.getByRole('textbox', { name: 'Add skill' }).fill('Trial preparation');
    await page.getByRole('textbox', { name: 'Add skill' }).press('Enter');
    const editor = page.locator('.is-row-editing');
    await page.screenshot({ path: info.outputPath(`profile-editor-${width}.png`) });
    expect((await new AxeBuilder({page}).include('#v2-settings-profile').withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => state.user.skills).toContain('Trial preparation');
    await expect(page.getByRole('button', { name: 'Edit skills', exact: true })).toContainText('Trial preparation');
    const saved = await geometry();
    const skillsIndex = await list.locator(':scope > *').evaluateAll(nodes => nodes.findIndex(node => node.querySelector('h2')?.textContent === 'Skills'));
    const contentGrowth = saved[skillsIndex].height - initial[skillsIndex].height;
    // A longer saved summary may wrap. Only that row's content height may
    // change; opening and closing an editor must still preserve the new layout.
    expectSameGeometry(saved, initial.map((box, index) => ({ ...box,
      height: box.height + (index === skillsIndex ? contentGrowth : 0),
      y: box.y + (index > skillsIndex ? contentGrowth : 0),
    })));
    await page.getByRole('button', { name: 'Edit skills', exact: true }).click();
    expectSameGeometry(await geometry(), saved);
    await page.keyboard.press('Escape');
    expectSameGeometry(await geometry(), saved);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await list.locator(':scope > *').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`profile-${width}.png`), fullPage: true });
    expect((await new AxeBuilder({page}).include('[data-v2-settings]').withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
    await page.evaluate(() => document.documentElement.classList.add('theme-dark'));
    await page.screenshot({ path: info.outputPath(`profile-dark-${width}.png`), fullPage: true });
  });
}

test('profile editors preserve validation, drafts, state changes and photo actions', async ({ page }) => {
  const state = await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  await page.getByRole('button', { name: 'Edit name', exact: true }).click();
  const first = page.getByRole('textbox', { name: 'First name', exact: false });
  await first.fill('');
  await first.blur();
  await page.locator('.is-row-editing').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(first).toHaveAttribute('aria-invalid', 'true');
  expect(state.profilePatches).toEqual([]);
  await page.locator('.is-row-editing').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.is-row-editing')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit name', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Edit name', exact: true }).click();
  await expect(first).toHaveValue('Dana');
  await first.fill('Dani');
  await first.blur();
  expect(state.profilePatches).toEqual([]);
  await page.locator('.is-row-editing').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.user.firstName).toBe('Dani');
  await expect(page.locator('.is-row-editing')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit residence', exact: true }).click();
  await page.getByLabel('Residence', { exact: true }).selectOption({ label: 'California' });
  await page.locator('.is-row-editing').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => state.user.state).toBe('CA');
  await expect(page.getByRole('button', { name: 'Edit residence', exact: true })).toContainText('California');
  await page.getByRole('button', { name: 'Open profile photo actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Edit crop' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open profile photo actions', exact: true })).toBeFocused();
});
