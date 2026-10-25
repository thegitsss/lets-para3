const crypto = require('crypto');
process.env.DATA_ENCRYPTION_KEY = crypto.createHash('sha256').update('profile-draft-isolated-test').digest('hex');
const protection = require('../services/profileDraftProtection');
const draft = { savedAt: 1000, profile: { firstName: 'Private profile draft', bio: 'Private biography' }, fields: ['firstName'], baselines: { firstName: { firstName: 'Saved' } } };
test('ciphertext conceals details and preserves the exact recovery and concurrency baselines', () => {
  const capsule = protection.seal('owner-a', draft, 1000);
  expect(capsule).toMatch(/^enc:v1:/); expect(capsule).not.toContain('Private');
  expect(protection.open('owner-a', capsule, 1001)).toEqual(draft);
  expect(protection.seal('owner-a', draft, 1000)).not.toBe(capsule);
});
test('rejects another owner, tampering, plaintext, expiration, future dates and oversized input', () => {
  const capsule = protection.seal('owner-a', draft, 1000);
  for (const run of [
    () => protection.open('owner-b', capsule, 1001),
    () => protection.open('owner-a', capsule.slice(0, -5) + 'AAAA=', 1001),
    () => protection.open('owner-a', JSON.stringify(draft), 1001),
    () => protection.open('owner-a', capsule, 1001 + protection.MAX_AGE_MS),
    () => protection.open('owner-a', capsule, 999),
    () => protection.seal('owner-a', { ...draft, profile: { bio: 'x'.repeat(protection.MAX_BYTES) } }),
  ]) expect(run).toThrow();
});

test('missing encryption configuration fails closed instead of storing plaintext', () => {
  const saved = process.env.DATA_ENCRYPTION_KEY;
  delete process.env.DATA_ENCRYPTION_KEY;
  try {
    jest.isolateModules(() => {
      const isolated = require('../services/profileDraftProtection');
      expect(() => isolated.seal('owner-a', draft)).toThrow('temporarily unavailable');
    });
  } finally { process.env.DATA_ENCRYPTION_KEY = saved; }
});
