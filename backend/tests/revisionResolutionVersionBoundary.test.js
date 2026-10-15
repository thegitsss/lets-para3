const { projectRevisionResolutions } = require('../utils/revisionResolution');
const source = changes => ({ _id: 'source', caseId: 'matter', userId: 'prior-paralegal', uploadedByRole: 'paralegal', status: 'attorney_revision', version: 1, revisionRequestedAt: null, history: [{ retained: 'Original private history' }], ...changes });
const response = changes => ({ _id: 'response', caseId: 'matter', userId: 'replacement-paralegal', uploadedByRole: 'paralegal', status: 'approved', version: 2, revisionOfFileId: 'source', revisionOfVersion: 1, revisionRequestAt: null, approvedAt: '2026-09-30T12:00:00.000Z', ...changes });
test('actual version projection preserves distinct-uploader valid numeric strings and complete input history', () => {
  const files = [source({ version: '1' }), response({ version: '2', revisionOfVersion: '1' })], before = structuredClone(files);
  expect(projectRevisionResolutions(files)[0].revisionResolution).toMatchObject({ approvedFileId: 'response' }); expect(files).toEqual(before); expect(files[0].userId).not.toBe(files[1].userId);
});
test('existing falsy-source fallback remains one and does not introduce a new legacy date requirement', () => {
  for (const version of [undefined, null, 0, false, '']) expect(projectRevisionResolutions([source({ version }), response()])[0].revisionResolution).toMatchObject({ approvedFileId: 'response' });
});
test('nonfinite fractional unsafe and nonpositive response versions cannot resolve a request', () => {
  for (const version of ['unverified', NaN, Infinity, -Infinity, 2.5, Number.MAX_SAFE_INTEGER + 1, 0, -1, null, undefined]) expect(projectRevisionResolutions([source(), response({ version })])[0].revisionResolution).toBeNull();
});
test('malformed source and referenced versions cannot fabricate a valid advance', () => {
  for (const version of ['unverified', Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, -1]) expect(projectRevisionResolutions([source({ version }), response({ revisionOfVersion: version, version: Number.MAX_SAFE_INTEGER })])[0].revisionResolution).toBeNull();
  for (const revisionOfVersion of [NaN, Infinity, 1.5, 0, -1]) expect(projectRevisionResolutions([source(), response({ revisionOfVersion })])[0].revisionResolution).toBeNull();
});
test('version validity never bypasses case role source-reference or request-date boundaries', () => {
  for (const changes of [{ caseId: 'other' }, { uploadedByRole: 'attorney' }, { revisionOfFileId: 'unrelated' }, { revisionOfVersion: 2 }, { revisionRequestAt: '2026-10-01T00:00:00.000Z' }]) expect(projectRevisionResolutions([source(), response(changes)])[0].revisionResolution).toBeNull();
});
test('a malformed response does not mask another valid approved response or alter older review statuses', () => {
  const files = [source(), response({ _id: 'corrupt', version: 'unverified' }), response({ _id: 'valid' })];
  expect(projectRevisionResolutions(files)[0]).toMatchObject({ status: 'attorney_revision', revisionResolution: { approvedFileId: 'valid' } }); expect(files[0].status).toBe('attorney_revision');
});
