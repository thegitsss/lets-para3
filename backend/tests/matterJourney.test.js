const { buildMatterExperience } = require('../services/matterExperience');
const ids = { attorney: '64b000000000000000000001', paralegal: '64b000000000000000000002', other: '64b000000000000000000003' };
const base = patch => ({ _id: '64b000000000000000000004', title: 'Synthetic Matter', status: 'in progress', attorney: ids.attorney, paralegal: ids.paralegal, escrowStatus: 'funded', escrowIntentId: 'pi_synthetic', tasks: [{ title: 'Prepare exhibits', completed: false }], files: [], ...patch });
const read = (matter, role = 'paralegal', extra = {}) => buildMatterExperience(matter, { viewer: { id: ids[role] || ids.other, role: role === 'applicant' ? 'paralegal' : role }, acl: { [role === 'attorney' ? 'isAttorney' : role === 'applicant' ? 'isApplicant' : role === 'paralegal' ? 'isParalegal' : 'isAdmin']: true }, ...extra }).header.journey;
test('one submission gives each person the correct responsibility without recording a payment', () => {
  const matter = base({ files: [{ uploadedBy: ids.paralegal, uploadedByRole: 'paralegal', status: 'pending_review' }] });
  const original = JSON.stringify(matter);
  expect(read(matter, 'attorney')).toMatchObject({ code: 'submitted', responsible: 'you', kind: 'action' });
  expect(read(matter)).toMatchObject({ code: 'submitted', responsible: 'attorney', kind: 'waiting' });
  expect(read(matter).detail).toContain('separate steps');
  expect(JSON.stringify(matter)).toBe(original);
});
test('a revision takes precedence for its paralegal while other files wait for review', () => {
  const matter = base({ files: [{ uploadedByRole: 'paralegal', status: 'attorney_revision' }, { uploadedByRole: 'paralegal', status: 'pending_review' }] });
  expect(read(matter)).toMatchObject({ code: 'revisions', responsible: 'you' });
  expect(read(matter, 'attorney')).toMatchObject({ code: 'submitted', responsible: 'you' });
});
test('superseded assignments do not become current revision obligations', () => {
  expect(read(base({ files: [{ uploadedByRole: 'paralegal', uploadedBy: ids.other, status: 'attorney_revision' }] })).code).toBe('work');
});
test.each([{ escrowStatus: 'pending' }, { escrowIntentId: '' }, { status: 'open' }])('uncertain hiring/funding never says work can start: %j', patch => {
  for (const role of ['attorney', 'paralegal']) expect(read(base(patch), role)).toMatchObject({ code: 'funding', kind: 'unavailable', responsible: 'unknown' });
});
test.each(['completed', 'closed', 'paused', 'disputed'])('terminal/review state wins over submitted work: %s', status => {
  const result = read(base({ status, files: [{ uploadedByRole: 'paralegal', status: 'pending_review' }] }));
  expect(['retained', 'review']).toContain(result.code);
  expect(result.kind).toBe('information');
});
test('closed status does not assert a payment and release never asserts bank arrival', () => {
  expect(read(base({ status: 'closed' })).detail).toContain('does not by itself confirm payment');
  expect(read(base({ status: 'completed', paymentReleased: true })).detail).toContain('Bank arrival is a separate Stripe status');
});
test('marked-complete work still distinguishes completion prerequisites from confirmation', () => {
  const matter = base({ tasks: [{ title: 'Scope', completed: true }] });
  expect(read(matter)).toMatchObject({ code: 'completion', responsible: 'attorney', kind: 'waiting' });
  expect(read(matter, 'attorney').detail).toContain('payment has not been inferred');
  expect(read(matter, 'attorney', { policies: { completion: { ready: true } } }).detail).toContain('explicit confirmation');
});
test('pre-engagement submission and hiring are different handoffs', () => {
  const matter = base({ status: 'open', paralegal: null, preEngagement: { requestedParalegalId: ids.other, status: 'submitted' } });
  expect(read(matter, 'attorney')).toMatchObject({ code: 'preparation_review', responsible: 'you' });
  expect(read(matter, 'applicant')).toMatchObject({ code: 'preparation_review', responsible: 'attorney' });
});
test('applicants cannot receive another assignment file or financial summary', () => {
  const result = read(base({ files: [{ uploadedByRole: 'paralegal', status: 'pending_review' }] }), 'applicant');
  expect(result.code).toBe('application_waiting');
  expect(result.action.tab).toBe('applications');
  expect(JSON.stringify(result)).not.toContain('pi_synthetic');
});
test('administration and unrelated roles receive no participant journey', () => {
  expect(read(base(), 'admin')).toBeNull();
  expect(buildMatterExperience(base(), { viewer: { id: ids.other, role: 'paralegal' }, acl: {} }).header.journey).toBeNull();
});

test('a submitted revision response waits for review instead of asking for the same revision again', () => {
  const requestId = '64b000000000000000000009', requestedAt = '2026-10-20T12:00:00Z';
  const matter = base({ files: [{ _id: requestId, uploadedByRole: 'paralegal', status: 'attorney_revision', revisionRequestedAt: requestedAt }, { uploadedByRole: 'paralegal', status: 'pending_review', revisionOfFileId: requestId, revisionRequestAt: requestedAt, version: 2, revisionOfVersion: 1 }] });
  expect(read(matter)).toMatchObject({ code: 'submitted', responsible: 'attorney' });
});

test.each(['rejected', 'withdrawn'])('a %s application does not invent a waiting obligation', status => {
  const matter = base({ status: 'open', paralegal: null });
  expect(read(matter, 'applicant', { applicants: [{ paralegalId: ids.other, status }] })).toMatchObject({ code: 'application_ended', kind: 'information', responsible: 'none' });
});
test('an invitation asks its recipient to review rather than waiting for the attorney', () => {
  const matter = base({ status: 'open', paralegal: null, invites: [{ paralegalId: ids.other, status: 'pending' }] });
  expect(read(matter, 'applicant')).toMatchObject({ code: 'invitation', kind: 'action', responsible: 'you' });
});
