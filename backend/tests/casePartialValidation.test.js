const { Types } = require('mongoose');
const Case = require('../models/Case');
const owner = new Types.ObjectId('600000000000000000000001');
const base = () => ({ _id: new Types.ObjectId(), title: 'Synthetic validation work', details: 'Synthetic lease and exhibits.', attorney: owner, attorneyId: owner, status: 'open' });
const partial = (fields = {}, selection = {}) => Case.hydrate({ _id: new Types.ObjectId(), title: 'Synthetic validation work', ...fields }, { title: 1, ...selection });
const dates = doc => ({ canonical: doc.deadlineDate, legacy: doc.deadline });

test('a title-only loaded document does not invent status or deadlines', async () => {
  const doc = partial(); doc.title = 'Changed title';
  await expect(doc.validate()).resolves.toBeUndefined();
  expect(doc.status).toBeUndefined(); expect(dates(doc)).toEqual({ canonical: undefined, legacy: undefined });
  expect(doc.modifiedPaths()).toEqual(['title']);
});
test('a selected status still normalizes while unselected deadline aliases remain untouched', async () => {
  const doc = partial({ status: 'active' }, { status: 1 });
  await doc.validate(); expect(doc.status).toBe('in progress');
  expect(dates(doc)).toEqual({ canonical: undefined, legacy: undefined });
  expect(doc.isModified('deadlineDate')).toBe(false); expect(doc.isModified('deadline')).toBe(false);
});
test.each(['deadlineDate', 'deadline'])('selecting only %s does not rewrite its unselected alias', async field => {
  const value = field === 'deadlineDate' ? '2027-07-15' : new Date('2027-07-15T00:00:00Z');
  const doc = partial({ status: 'open', [field]: value }, { status: 1, [field]: 1 });
  const before = dates(doc); doc.title = 'Changed title'; await doc.validate();
  expect(dates(doc)).toEqual(before); expect(doc.isModified('deadlineDate')).toBe(false); expect(doc.isModified('deadline')).toBe(false);
});
test('new documents preserve status and legacy date normalization', async () => {
  const doc = new Case({ ...base(), status: 'active', deadline: new Date('2027-07-15T00:00:00Z') });
  await doc.validate(); expect(doc.status).toBe('in progress');
  expect(dates(doc)).toEqual({ canonical: '2027-07-15', legacy: new Date('2027-07-15T00:00:00Z') });
});
test('full loaded documents preserve canonical precedence and legacy status normalization', async () => {
  const doc = Case.hydrate({ ...base(), status: 'assigned', deadlineDate: '2027-07-15', deadline: new Date('2027-08-19T00:00:00Z') });
  await doc.validate(); expect(doc.status).toBe('open');
  expect(dates(doc)).toEqual({ canonical: '2027-07-15', legacy: new Date('2027-07-15T00:00:00Z') });
});
test('both selected aliases preserve fallback from the legacy date', async () => {
  const doc = partial({ status: 'open', deadlineDate: '', deadline: new Date('2027-07-15T00:00:00Z') }, { status: 1, deadlineDate: 1, deadline: 1 });
  await doc.validate(); expect(dates(doc)).toEqual({ canonical: '2027-07-15', legacy: new Date('2027-07-15T00:00:00Z') });
});
test('an explicitly changed previously unselected status is normalized', async () => {
  const doc = partial(); doc.status = 'active'; await doc.validate(); expect(doc.status).toBe('in progress');
});
test.each(['deadlineDate', 'deadline'])('an explicit previously unselected %s edit still synchronizes aliases', async field => {
  const doc = partial({ status: 'open' }, { status: 1 });
  doc[field] = field === 'deadlineDate' ? '2027-09-14' : new Date('2027-09-14T00:00:00Z');
  await doc.validate(); expect(dates(doc)).toEqual({ canonical: '2027-09-14', legacy: new Date('2027-09-14T00:00:00Z') });
});
test.each(['deadlineDate', 'deadline'])('explicitly clearing previously unselected %s retains empty-date semantics', async field => {
  const doc = partial({ status: 'open' }, { status: 1 }); doc[field] = field === 'deadlineDate' ? '' : null;
  await doc.validate(); expect(dates(doc)).toEqual({ canonical: '', legacy: null });
});
test('invalid explicit status remains rejected', async () => {
  const doc = partial(); doc.status = 'not-a-case-status';
  await expect(doc.validate()).rejects.toMatchObject({ errors: { status: { path: 'status', kind: 'enum' } } });
});
