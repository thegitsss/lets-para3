const { test, expect } = require('../support-session-fixture');
const { installCurrentHome, home } = require('./current-home-fixtures');

test('a retained shortlisted record with confirmed nonpending context is absent from Home applications', async ({ page }, info) => {
  const state = await installCurrentHome(page);
  state.applications[0].pending = false;
  await home(page, '?view=applications');
  await expect(page.locator('[data-home-application-id]')).toHaveCount(0);
  await expect(page.locator('.lc-list')).not.toContainText('Contract chronology review');
  expect(state.applications[0].status).toBe('shortlisted');
  await page.screenshot({ path: info.outputPath('confirmed-nonpending-home.png'), fullPage: true });
});
