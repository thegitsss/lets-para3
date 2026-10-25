'use strict';
const assert = require('node:assert/strict');
const sdk = require('@aws-sdk/client-s3');
const { ACCOUNT, BUCKET } = require('../../infra/stagingDocumentStorage');

async function cleanupOwnedVersions(client, report, { prefix, pattern, limit, exactKey }) {
  assert.equal(report?.bucket, BUCKET, 'Exact staging canary bucket is required');
  assert.equal(report.syntheticOnly, true, 'Synthetic canary ownership is required');
  assert.match(prefix || '', pattern,
    'Exact uniquely owned canary prefix is required');
  const owner = { Bucket: BUCKET, ExpectedBucketOwner: ACCOUNT };
  const listed = await client.send(new sdk.ListObjectVersionsCommand({
    ...owner, Prefix: prefix, MaxKeys: 10,
  }), { abortSignal: AbortSignal.timeout(20000) });
  assert.notEqual(listed.IsTruncated, true, 'Unexpected canary inventory must be reviewed');
  const versions = [...(listed.Versions || []), ...(listed.DeleteMarkers || [])];
  assert(versions.length <= limit, 'Canary inventory exceeds its write limit');
  // Validate the complete returned inventory before deleting even its first item.
  for (const version of versions) {
    assert.equal(typeof version.Key, 'string');
    assert(version.Key.startsWith(prefix), 'Returned version is outside this canary run');
    if (exactKey) assert.equal(version.Key, prefix, 'Returned version belongs to another control key');
    assert.equal(typeof version.VersionId, 'string');
    assert(version.VersionId && version.VersionId !== 'null', 'Exact object version is required');
  }
  for (const version of versions) {
    await client.send(new sdk.DeleteObjectCommand({
      ...owner, Key: version.Key, VersionId: version.VersionId,
    }), { abortSignal: AbortSignal.timeout(20000) });
  }
  return { syntheticVersionsRemoved: versions.length, objectPrefix: prefix,
    cleanupVerified: true, productionMutations: 0 };
}

function cleanupCanaryVersions(client, report) {
  return cleanupOwnedVersions(client, report, { prefix: report?.objectPrefix,
    pattern: /^cases\/[a-f0-9]{24}\/documents\/scan-required-canary-$/, limit: 5 });
}

function cleanupPrincipalControlVersions(client, report) {
  return cleanupOwnedVersions(client, report, { prefix: report?.objectKey,
    pattern: /^cases\/[a-f0-9]{24}\/documents\/principal-control\.txt$/, limit: 2, exactKey: true });
}

module.exports = { cleanupCanaryVersions, cleanupPrincipalControlVersions };
