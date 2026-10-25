// Help lives in the existing account menu for both workspace roles.
async function openHelpFromAccountMenu(page, role = 'attorney') {
  const paralegal = role === 'paralegal';
  const trigger = page.locator(paralegal ? '[data-v2-profile-trigger]' : '.av2-brand-menu > summary');
  if (!await trigger.isVisible()) {
    await page.locator(paralegal ? '[data-v2-mobile-menu]' : '[data-av2-nav-toggle]').click();
  }
  const menu = page.locator(paralegal ? '[data-v2-profile-menu]' : '.av2-sidebar-bottom');
  if (!await menu.isVisible()) await trigger.click();
  await menu.getByRole(paralegal ? 'menuitem' : 'link', { name: 'Help', exact: true }).click();
}
module.exports = { openHelpFromAccountMenu };
