'use strict';
const { cleanupCanaryVersions, cleanupPrincipalControlVersions } = require('../scripts/lib/stagingCanaryCleanup');
const { ACCOUNT, BUCKET } = require('../infra/stagingDocumentStorage');
const objectPrefix = 'cases/0123456789abcdef01234567/documents/scan-required-canary-';
const report = { bucket: BUCKET, syntheticOnly: true, objectPrefix };

test('cleans only exact versions under the unique run prefix, including an unacknowledged upload', async () => {
  const versions = [{ Key: objectPrefix + 'clean.pdf', VersionId: 'clean-version' },
    { Key: objectPrefix + 'forged.pdf', VersionId: 'unacknowledged-version' }];
  const send = jest.fn().mockResolvedValueOnce({ Versions: versions }).mockResolvedValue({});
  const result = await cleanupCanaryVersions({ send }, report);
  expect(send.mock.calls[0][0].input).toEqual({ Bucket: BUCKET, ExpectedBucketOwner: ACCOUNT,
    Prefix: objectPrefix, MaxKeys: 10 });
  expect(send.mock.calls.slice(1).map(([command]) => command.input)).toEqual(versions.map(version =>
    ({ Bucket: BUCKET, ExpectedBucketOwner: ACCOUNT, ...version })));
  expect(result.syntheticVersionsRemoved).toBe(2);
  expect(result.cleanupVerified).toBe(true);
});

test.each([undefined, { ...report, objectPrefix: 'cases/' },
  { ...report, bucket: 'paraconnect-uploads' }, { ...report, syntheticOnly: false }])(
  'rejects absent or unowned cleanup scope before contacting storage: %j', async unsafe => {
    const send = jest.fn();
    await expect(cleanupCanaryVersions({ send }, unsafe)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

test.each([
  { Versions: [{ Key: objectPrefix + 'clean.pdf', VersionId: 'ok' },
    { Key: 'cases/another-run/documents/file.pdf', VersionId: 'foreign' }] },
  { Versions: [{ Key: objectPrefix + 'clean.pdf', VersionId: 'null' }] },
  { IsTruncated: true, Versions: [] },
  { Versions: Array.from({ length: 6 }, (_, i) => ({ Key: objectPrefix + i, VersionId: String(i) })) },
])('rejects an ambiguous returned inventory before any deletion: %j', async inventory => {
  const send = jest.fn().mockResolvedValue(inventory);
  await expect(cleanupCanaryVersions({ send }, report)).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});

test('a failed exact-version deletion fails cleanup acceptance', async () => {
  const send = jest.fn().mockResolvedValueOnce({ Versions: [{ Key: objectPrefix + 'clean.pdf', VersionId: 'owned' }] })
    .mockRejectedValueOnce(new Error('Synthetic deletion failure'));
  await expect(cleanupCanaryVersions({ send }, report)).rejects.toThrow('Synthetic deletion failure');
});

test('principal control cleanup owns only its exact random key and two versions', async () => {
  const objectKey = 'cases/0123456789abcdef01234567/documents/principal-control.txt';
  const send = jest.fn().mockResolvedValueOnce({ Versions: [{ Key: objectKey, VersionId: 'alias' },
    { Key: objectKey, VersionId: 'current' }] }).mockResolvedValue({});
  const result = await cleanupPrincipalControlVersions({ send }, { ...report, objectKey });
  expect(send.mock.calls[0][0].input.Prefix).toBe(objectKey);
  expect(send.mock.calls.slice(1).map(([command]) => command.input.Key)).toEqual([objectKey, objectKey]);
  expect(result.syntheticVersionsRemoved).toBe(2);
});

test('principal control cleanup rejects a similarly prefixed foreign key before any deletion', async () => {
  const objectKey = 'cases/0123456789abcdef01234567/documents/principal-control.txt';
  const send = jest.fn().mockResolvedValue({ Versions: [{ Key: objectKey, VersionId: 'owned' },
    { Key: objectKey + '.another-run', VersionId: 'foreign' }] });
  await expect(cleanupPrincipalControlVersions({ send }, { ...report, objectKey })).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});
