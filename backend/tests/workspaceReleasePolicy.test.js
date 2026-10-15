const { defaults, validateUpdate, bucketFor, decisionFor } = require('../services/workspaceRelease');
const id = 'a'.repeat(24), user = { id, role: 'attorney', status: 'approved' };
const update = () => ({ ...defaults(), expectedRevision: 0, reason: 'Synthetic cohort review.' });
const valid = () => { const value = update(); delete value.revision; return value; };

test('unconfigured policy preserves current entry behavior and does not activate either cohort', () => {
  expect(decisionFor(user)).toMatchObject({ schemaVersion: 1, ownerId: id, version: 'baseline', revision: 0, defaultDestination: '/dashboard-attorney.html' });
  expect(decisionFor({ ...user, role: 'paralegal' })).toMatchObject({ version: 'baseline', defaultDestination: '/dashboard-paralegal.html' });
  expect(defaults()).toEqual(defaults());
});
test('a cohort is stable across configuration revisions and increases monotonically', () => {
  const config = defaults(); config.enabled = true;
  const accounts = Array.from({ length: 1000 }, (_, index) => ({ ...user, id: index.toString(16).padStart(24, '0') }));
  const first = new Set();
  config.attorney.basisPoints = 1000;
  for (const account of accounts) if (decisionFor(account, config).version === 'v2') first.add(account.id);
  expect(first.size).toBeGreaterThan(0); expect(first.size).toBeLessThan(accounts.length);
  config.revision = 42;
  expect(new Set(accounts.filter(account => decisionFor(account, config).version === 'v2').map(account => account.id))).toEqual(first);
  config.attorney.basisPoints = 2500;
  for (const account of accounts.filter(account => first.has(account.id))) expect(decisionFor(account, config).version).toBe('v2');
  expect(bucketFor('attorney', id)).toBe(bucketFor('attorney', id));
  expect(bucketFor('attorney', id)).not.toBe(bucketFor('paralegal', id));
});
test('zero/full percentages and per-account overrides remain role-specific', () => {
  const config = defaults(); config.enabled = true; config.attorney.basisPoints = 10000;
  expect(decisionFor(user, config).version).toBe('v2');
  expect(decisionFor({ ...user, role: 'paralegal' }, config).version).toBe('legacy');
  config.attorney.overrides[id] = 'legacy'; config.paralegal.overrides[id] = 'v2';
  expect(decisionFor(user, config)).toMatchObject({ version: 'legacy', reason: 'account_override' });
  expect(decisionFor({ ...user, role: 'paralegal' }, config)).toMatchObject({ version: 'v2', reason: 'account_override' });
});
test('global rollback overrides all selections, including an otherwise unactivated policy', () => {
  for (const enabled of [true, false]) {
    const config = defaults(); config.enabled = enabled; config.killSwitch = true;
    for (const role of ['attorney', 'paralegal']) {
      config[role].basisPoints = 10000; config[role].overrides[id] = 'v2';
      expect(decisionFor({ ...user, role }, config)).toMatchObject({ version: 'legacy', reason: 'global_rollback' });
    }
  }
});
test.each([{ status: 'pending' }, { status: 'denied' }, { disabled: true }, { deleted: true }, { role: 'admin' }, { role: 'director' }, { id: 'wrong' }])('no presentation policy authorizes an ineligible identity: %j', change => {
  const config = defaults(); config.enabled = true; config.attorney.basisPoints = 10000;
  expect(() => decisionFor({ ...user, ...change }, config)).toThrow('cannot open');
});
test('validated policy is copied, contains only supported fields, and trims its audit reason', () => {
  const input = valid(); input.reason = '  Reviewed cohort.  '; input.attorney.overrides[id] = 'v2';
  const checked = validateUpdate(input); input.attorney.overrides[id] = 'legacy';
  expect(checked.config.attorney.overrides[id]).toBe('v2'); expect(checked.reason).toBe('Reviewed cohort.'); expect(checked.expectedRevision).toBe(0);
});
test.each([
  value => { value.expectedRevision = -1; }, value => { value.expectedRevision = '0'; },
  value => { value.enabled = 'true'; }, value => { value.killSwitch = null; },
  value => { value.reason = ''; }, value => { value.reason = '<script>'; }, value => { value.reason = 'x'.repeat(501); },
  value => { value.attorney.basisPoints = 10001; }, value => { value.paralegal.basisPoints = -1; }, value => { value.attorney.basisPoints = 1.5; },
  value => { value.attorney.overrides.bad = 'v2'; }, value => { value.attorney.overrides[id] = 'admin'; },
  value => { value.paralegal.overrides = []; }, value => { value.attorney.extra = true; }, value => { value.extra = true; },
  value => { value.attorney.overrides = Object.fromEntries(Array.from({ length: 501 }, (_, n) => [n.toString(16).padStart(24, '0'), 'v2'])); },
])('invalid or unreviewed policy fields are rejected without coercion (%#)', mutate => {
  const input = valid(); mutate(input); expect(() => validateUpdate(input)).toThrow('Review the workspace');
});
