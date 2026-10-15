const { test, expect } = require('../support-session-fixture');

test('cancelled native document departure preserves an unsaved Matter note and restores updates after deliberate recovery', async ({ page }) => {
  const csrf = (await (await page.request.get('/api/csrf')).json()).csrfToken;
  const user = (await (await page.request.get('/api/auth/me')).json()).user;
  const result = await page.request.post('/api/cases', {
    headers: { 'X-CSRF-Token': csrf },
    data: { expectedOwnerId: user.id || user._id, title: 'Synthetic cancelled departure', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Review the local synthetic departure boundary.', tasks: [] }
  });
  expect(result.status()).toBe(201);
  const value = await result.json(), id = String(value.case?._id || value._id || value.id);
  const streams = [], noteWrites = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/cases/${id}/stream`) streams.push({ method: request.method(), at: Date.now() });
    if (path === `/api/cases/${id}/notes` && !['GET', 'HEAD'].includes(request.method())) noteWrites.push(request.method());
  });
  await page.goto(`/attorney-v2.html#/matters/${id}/overview`);
  const notes = page.locator(`[data-matter-notes="${id}"]`);
  await expect(notes).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => streams.length).toBeGreaterThan(0);
  await notes.getByRole('button', { name: 'Add note', exact: true }).click();
  const text = 'Unsaved confidential note retained after cancelling departure.';
  await notes.locator('textarea').fill(text);
  await expect(notes).toContainText('Unsaved note.');
  const initialStreams = streams.length, originalURL = page.url();
  const dialogPromise = page.waitForEvent('dialog');
  const navigation = page.evaluate(() => { window.location.assign('/login.html'); });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await navigation;
  await expect(page).toHaveURL(originalURL);
  await expect(notes.locator('textarea')).toHaveValue(text);
  await expect(notes.getByRole('button', { name: 'Save Matter note', exact: true })).toBeEnabled();
  expect(noteWrites).toEqual([]);
  await expect(page.getByRole('status').filter({ hasText: 'Updates are paused.' })).toBeVisible();
  await notes.getByRole('button', { name: 'Retry saved note', exact: true }).click();
  await expect(notes.locator('textarea')).toHaveValue(text);
  await expect.poll(() => streams.length, { message: 'The cancelled document departure must restore a native Matter stream.' }).toBeGreaterThan(initialStreams);
  await notes.getByRole('button', { name: 'Save Matter note', exact: true }).click();
  await expect(notes).toContainText('Matter note saved.');
  expect(noteWrites).toEqual(['PUT']);
  await page.reload();
  await expect(notes).toHaveAttribute('data-state', 'ready');
  await expect(notes).toContainText(text);
});

test('accepted native document departure does not reconnect or save the unsaved Matter note', async ({ page }) => {
  const csrf = (await (await page.request.get('/api/csrf')).json()).csrfToken;
  const user = (await (await page.request.get('/api/auth/me')).json()).user;
  const result = await page.request.post('/api/cases', {
    headers: { 'X-CSRF-Token': csrf },
    data: { expectedOwnerId: user.id || user._id, title: 'Synthetic accepted departure', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Review the accepted local synthetic departure boundary.', tasks: [] }
  });
  expect(result.status()).toBe(201);
  const value = await result.json(), id = String(value.case?._id || value._id || value.id);
  const streams = [], noteWrites = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/cases/${id}/stream`) streams.push(request.method());
    if (path === `/api/cases/${id}/notes` && !['GET', 'HEAD'].includes(request.method())) noteWrites.push(request.method());
  });
  await page.goto(`/attorney-v2.html#/matters/${id}/overview`);
  const notes = page.locator(`[data-matter-notes="${id}"]`);
  await expect(notes).toHaveAttribute('data-state', 'ready');
  await expect.poll(() => streams.length).toBeGreaterThan(0);
  await notes.getByRole('button', { name: 'Add note', exact: true }).click();
  await notes.locator('textarea').fill('Deliberately leave this local note unsaved.');
  await expect(notes).toContainText('Unsaved note.');
  const initialStreams = streams.length;
  const dialogPromise = page.waitForEvent('dialog');
  await page.evaluate(() => { setTimeout(() => { window.location.assign('/about.html'); }, 0); });
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.accept();
  await expect(page).toHaveURL(/\/about\.html$/);
  expect(streams.length).toBe(initialStreams);
  expect(noteWrites).toEqual([]);
});
