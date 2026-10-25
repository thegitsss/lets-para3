const path = require('node:path');
const { pathToFileURL } = require('node:url');
const moduleAt = file => import(pathToFileURL(path.resolve(__dirname, '../../frontend/assets/scripts', file)).href);
const owner = '64b000000000000000000001', id = '64b000000000000000000002';
test('a similar Matter copies scope but clears dates, assignment, approvals and payment authority', async () => {
  const { repeatMatterValues } = await moduleAt('attorney-v2/repeat-matter.mjs');
  const source = { id, attorney: owner, title: 'Prior scope', status: 'completed', currency: 'usd', lockedTotalAmount: 50000, details: 'Prepare exhibits.\nScreening questions:\nOld question', deadline: '2020-01-01', paralegal: id, paymentReleased: true, escrowIntentId: 'pi_original', files: [{ key: 'private' }], tasks: [{ title: 'Exhibits', completed: true }], matterExperience: { header: { relationship: 'Matter owner' } } };
  const before = JSON.stringify(source), draft = repeatMatterValues(source, owner, id);
  expect(draft).toMatchObject({ title: 'Prior scope', deadline: '', compAmount: '500', tasks: [{ title: 'Exhibits' }] });
  for (const key of ['paralegal', 'files', 'paymentReleased', 'escrowIntentId', 'id']) expect(draft).not.toHaveProperty(key);
  expect(draft.description).toBe('Prepare exhibits.');
  expect(JSON.stringify(source)).toBe(before);
});
test.each([{ attorney: id }, { status: 'in progress' }, { id: owner }, { matterExperience: { header: { relationship: 'Applicant' } } }])('reuse rejects a mismatched, active or unowned record: %j', async patch => {
  const { repeatMatterValues } = await moduleAt('attorney-v2/repeat-matter.mjs');
  expect(() => repeatMatterValues({ id, attorney: owner, status: 'closed', matterExperience: { header: { relationship: 'Matter owner' } }, ...patch }, owner, id)).toThrow();
});
test('unknown compensation/currency does not invent a new price', async () => {
  const { repeatMatterValues } = await moduleAt('attorney-v2/repeat-matter.mjs');
  expect(repeatMatterValues({ id, status: 'closed', currency: 'eur', totalAmount: 50000, matterExperience: { header: { relationship: 'Matter owner' } } }, owner, id).compAmount).toBe('');
});
test('Home origin survives Matter tabs while unrelated query instructions do not', async () => {
  const { matterLink } = await moduleAt('attorney-v2/workspace-model.mjs');
  const link = matterLink(id, 'files', new URLSearchParams({ returnHome: '1', redirect: 'https://evil.invalid' }));
  expect(link).toBe(`#/matters/${id}/files?returnHome=1`);
  expect(matterLink(id, 'files', new URLSearchParams('returnHome=1&returnHome=1'))).not.toContain('returnHome');
});

test('Home paging returns intact and external, repeated or invalid origins are rejected', async () => {
  const { safeHomeReturn } = await moduleAt('attorney-v2/matter-return.mjs');
  const { matterLink } = await moduleAt('attorney-v2/workspace-model.mjs');
  expect(safeHomeReturn('#/home?attentionPage=3&deadlinePage=2')).toBe('#/home?attentionPage=3&deadlinePage=2');
  expect(matterLink(id, 'files', new URLSearchParams({ returnHome: '#/home?attentionPage=3' }))).toContain('returnHome=%23%2Fhome%3FattentionPage%3D3');
  for (const bad of ['https://evil.invalid', '#/home?attentionPage=0', '#/home?attentionPage=1&attentionPage=2']) expect(safeHomeReturn(bad)).toBeNull();
});
