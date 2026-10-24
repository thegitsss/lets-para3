// Resting summaries expose scoped editor entry points; field saves stay local.
async function openProfileScope(page, field) {
  const scope = ['name','residence','years of experience','identity'].includes(field) ? 'identity' : ['email','linkedin','account'].includes(field) ? 'account' : field === 'experience' ? 'experience' : field === 'education' ? 'education' : 'professional';
  // Personal details now opens directly through the identity action.
  if (scope === 'identity') return;
  const bank = page.locator(`[data-profile-scope="${scope}"]`);
  if (await bank.isVisible()) return;
  await page.locator(`[data-profile-group="${scope}"] > .v2-profile-section-top .v2-profile-scope-toggle, [data-profile-group="${scope}"] .v2-profile-identity-text > .v2-profile-scope-toggle`).click();
  await require('playwright/test').expect(bank).toBeVisible();
}
async function openDocumentEditor(row, label) {
  if (!await row.locator('.v2-profile-document-edit').isVisible()) await row.locator('.v2-profile-document-menu > summary').click();
  await row.getByRole('button', {name:`Edit ${label.toLowerCase()}`,exact:true}).click();
}
module.exports={openProfileScope,openDocumentEditor};
