const { presentNotification } = require('../services/notificationPresentation');
const OWNER = '64b222222222222222222222', OTHER = '64b333333333333333333333';
const admitted = 'Your application has been approved. Complete your profile and Stripe payout setup, then browse and apply to open Matters.';
const pending = 'Your application is under review. We’ll notify you when a decision is recorded.';
const viewer = { id: OWNER, role: 'paralegal', status: 'approved' };
function note(values = {}) { return { _id: '64b111111111111111111111', userId: OWNER, userRole: 'paralegal', type: 'paralegal_welcome', message: `Welcome to Let’s-ParaConnect ${admitted}`, payload: { title: 'Welcome to Let’s-ParaConnect', body: admitted }, ...values }; }
const project = (item, current = viewer) => presentNotification(item, { viewer: current });
test('admitted own welcome is visible and uses only the registered own profile-settings destination', () => {
  const item = note({ link: 'https://untrusted.invalid/', payload: { body: admitted, href: '/profile-paralegal.html?paralegalId=' + OTHER } });
  expect(project(item)).toMatchObject({ available: true, message: item.message, action: { label: 'View profile settings', href: '/profile-settings.html' }, context: {}, actorFirstName: '', actorProfileImage: '' });
});
test('retained pending copy is preserved as the admitted recipient’s recorded history', () => {
  const item = note({ message: pending, payload: { body: pending } });
  expect(project(item).message).toBe(pending); expect(item.message).toBe(pending); expect(item.payload.body).toBe(pending);
});
test('older own records without a stored role remain available without changing their copy', () => {
  const item = note({ userRole: '', message: pending }); expect(project(item)).toMatchObject({ available: true, message: pending });
});
test('older title/body copy is preserved when no stored message exists', () => {
  const item = note({ message: '' }); expect(project(item).message).toBe(`Welcome to Let’s-ParaConnect ${admitted}`);
});
test.each([
  ['Attorney', { role: 'attorney' }], ['Admin', { role: 'admin' }], ['pending', { status: 'pending' }], ['denied', { status: 'denied' }],
  ['disabled', { disabled: true }], ['deleted', { deleted: true }], ['foreign recipient', { id: OTHER }], ['malformed recipient', { id: 'me' }],
])('%s viewer receives the standard unavailable projection', (_name, values) => {
  expect(project(note(), { ...viewer, ...values })).toMatchObject({ available: false, message: '', action: { label: '', href: '' }, context: {} });
});
test.each([
  ['foreign owner', { userId: OTHER }], ['malformed owner', { userId: 'me' }], ['malformed record', { _id: 'bad' }], ['missing record', { _id: null }],
  ['wrong recorded role', { userRole: 'attorney' }], ['malformed recorded role', { userRole: false }], ['missing copy', { message: '', payload: {} }], ['malformed copy', { message: {}, payload: { title: {}, body: {} } }],
])('%s welcome receives no message or action', (_name, values) => {
  expect(project(note(values))).toMatchObject({ available: false, message: '', action: { label: '', href: '' }, context: {} });
});
test.each([[false, false, false], [true, false, true], [false, true, true], [true, true, true]])('retained read flags %s/%s retain authoritative read state %s', (read, isRead, expected) => {
  expect(project(note({ read, isRead }))).toMatchObject({ available: true, read: expected, isRead: expected });
});
