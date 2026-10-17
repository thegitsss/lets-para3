const { REQUIRED_SUBSETS } = require('../scripts/verify-ci-jest-coverage');
const { SHARD_COUNT, balanceSuites, validatePlan, validateOwnedCleanup, expectedJestArgs, verifyUnion, hash } = require('../scripts/verify-ci-jest-shards');
function fixture() {
  const suites = [...new Set(Object.values(REQUIRED_SUBSETS).flat()), 'tests/fillerOne.test.js', 'tests/fillerTwo.test.js'].sort();
  const source = { commit: 'a'.repeat(40), files: Object.fromEntries(suites.map((file, index) => ['backend/' + file, String(index % 10).repeat(64)])) };
  source.files['backend/jest.config.js'] = 'b'.repeat(64); source.files['backend/scripts/ci-jest-owned-observer.cjs'] = 'c'.repeat(64);
  const grouped = balanceSuites(suites, source, { observations: [] });
  const payload = { schemaVersion: 2, preparedAt: new Date(1000).toISOString(), executionId: '123:1', source, originalConfigSHA256: source.files['backend/jest.config.js'], required: JSON.parse(JSON.stringify(REQUIRED_SUBSETS)), suites: [...suites], ...grouped };
  const plan = { ...payload, planId: hash(JSON.stringify(payload)) }, planSHA256 = 'f'.repeat(64);
  const inputs = plan.shards.map(selected => {
    const backendRoot = '/candidate/backend', outputRoot = '/candidate/backend/test-results/jest/shards/shard-' + selected.id;
    const record = { schemaVersion: 2, shardId: selected.id, executionId: plan.executionId, planId: plan.planId, planSHA256, backendRoot, outputRoot, suites: selected.suites, command: expectedJestArgs(backendRoot, outputRoot, selected.suites), sourceBefore: source, sourceAfter: source, observerSHA256: source.files['backend/scripts/ci-jest-owned-observer.cjs'], harnessStateReleased: true, startedAt: new Date(2000).toISOString(), finishedAt: new Date(3000).toISOString(), terminal: { code: 0, signal: null } };
    const testResults = selected.suites.map(file => ({ name: backendRoot + '/' + file, status: 'passed', assertionResults: [0, 1].map(() => ({ fullName: 'same title deliberately retains occurrence ordinal', status: 'passed', invocations: 1, failureMessages: [], retryReasons: [] })) }));
    const report = { startTime: 2500, success: true, numTotalTestSuites: selected.suites.length, numPassedTestSuites: selected.suites.length, numTotalTests: selected.suites.length * 2, numPassedTests: selected.suites.length * 2, testResults };
    const pid = 1000 + selected.id, mongo = [{ phase: 'started', pid }, { phase: 'exit', pid, code: 0, signal: null }, { phase: 'closed', pid, code: 0, signal: null }], http = [{ phase: 'listening', pid: 500, id: 1 }, { phase: 'closed', pid: 500, id: 1 }];
    return { record, report, mongo, http };
  });
  return { plan, inputs, current: source, discovered: suites, planSHA256 };
}
const verify = x => verifyUnion(x.plan, x.inputs, x.current, x.discovered, x.planSHA256, 4000);
function resign(plan) { const { planId, ...payload } = plan; plan.planId = hash(JSON.stringify(payload)); }
test('the raw disjoint union preserves every full original suite, duplicate-title occurrence, auth and payment subset', () => {
  const x = fixture(), result = verify(x);
  expect(SHARD_COUNT).toBe(8); expect(result).toMatchObject({ shards: 8, fullSuites: x.discovered.length, fullCallbacks: x.discovered.length * 2, completeOriginalCoverageVerified: true });
  expect(result.required['test:auth'].map(r => r.file)).toEqual(REQUIRED_SUBSETS['test:auth']); expect(result.required['test:payments'].map(r => r.file)).toEqual(REQUIRED_SUBSETS['test:payments']);
  expect(result.actualIdentities.filter(r => r.file === 'tests/auth.test.js').map(r => r.ordinal)).toEqual([0, 1]);
});
test.each(['missing', 'duplicated'])('rejects %s whole shard artifact', kind => { const x = fixture(); if (kind === 'missing') x.inputs.pop(); else x.inputs[7] = x.inputs[0]; expect(() => verify(x)).toThrow(/Missing or duplicated shard/); });
test.each(['pending', 'todo', 'failed', 'retry'])('rejects a %s original callback even with false aggregate success', status => { const x = fixture(), callback = x.inputs[0].report.testResults[0].assertionResults[0]; if (status === 'retry') callback.invocations = 2; else callback.status = status; expect(() => verify(x)).toThrow(/skipped or retried/); });
test('rejects missing or duplicated raw suite names and falsified callback totals', () => { let x = fixture(); x.inputs[0].report.testResults.pop(); expect(() => verify(x)).toThrow(/omits\/duplicates/); x = fixture(); x.inputs[0].report.numPassedTests--; expect(() => verify(x)).toThrow(/aggregate is inconsistent/); });
test('rejects a different source, execution, raw plan digest, earlier report or changed exact command', () => {
  for (const mutation of [x => { x.inputs[0].record.sourceAfter = { ...x.current, commit: 'd'.repeat(40) }; }, x => { x.inputs[0].record.executionId = '123:2'; }, x => { x.inputs[0].record.planSHA256 = 'e'.repeat(64); }, x => { x.inputs[0].report.startTime = 1999; }, x => { x.inputs[0].record.command.push('--testNamePattern=chosen'); }]) { const x = fixture(); mutation(x); expect(() => verify(x)).toThrow(/different candidate|prepared execution|narrows\/retries/); }
});
test('rejects narrowed discovery, duplicate assignment, omitted required auth/payment suite and edited plan bytes', () => {
  let x = fixture(); x.plan.suites.pop(); resign(x.plan); expect(() => verify(x)).toThrow(/exact complete current/);
  x = fixture(); x.plan.shards[0].suites.push(x.plan.shards[1].suites[0]); resign(x.plan); expect(() => verify(x)).toThrow(/Missing or duplicated complete/);
  x = fixture(); x.plan.required['test:payments'].pop(); resign(x.plan); expect(() => verify(x)).toThrow(/approved substantive/);
  x = fixture(); x.plan.preparedAt = new Date(1100).toISOString(); expect(() => verify(x)).toThrow(/content digest/);
});
test.each(['missing-close', 'signal', 'missing-second-child', 'no-children', 'unmatched-event'])('rejects %s actual Mongo cleanup', kind => {
  const x = fixture(), m = x.inputs[0].mongo;
  if (kind === 'missing-close') m.pop(); if (kind === 'signal') { m[1].code = null; m[1].signal = 'SIGKILL'; } if (kind === 'missing-second-child') m.push({ phase: 'started', pid: 2000 }); if (kind === 'no-children') m.splice(0); if (kind === 'unmatched-event') m.push({ phase: 'closed', pid: 9999, code: 0 });
  expect(() => verify(x)).toThrow(/owned Mongo|Unmatched Mongo/);
});
test('rejects leaked HTTP listeners, active state lease, failed process and runtime aggregate failure', () => {
  let x = fixture(); x.inputs[0].http.pop(); expect(() => verify(x)).toThrow(/HTTP listener/);
  x = fixture(); x.inputs[0].record.harnessStateReleased = false; expect(() => verify(x)).toThrow(/harness cleanup/);
  x = fixture(); x.inputs[0].record.terminal.code = 1; expect(() => verify(x)).toThrow(/process failed/);
  x = fixture(); x.inputs[0].report.numRuntimeErrorTestSuites = 1; expect(() => verify(x)).toThrow(/failed, missing or skipped/);
});
test('source-matched actual durations balance heavy suites without omitting unknown or changed suites', () => {
  const x = fixture(), file = x.discovered[0], hints = { observations: [{ file, sourceSHA256: x.current.files['backend/' + file], durationMs: 200000 }] };
  const balanced = balanceSuites(x.discovered, x.current, hints);
  expect(balanced.shards).toHaveLength(8); expect(balanced.weights.find(w => w.file === file).weightKind).toBe('observed-local-duration-source-matched');
  expect(balanced.shards.flatMap(s => s.suites).sort()).toEqual(x.discovered);
  hints.observations[0].sourceSHA256 = '0'.repeat(64); if (x.current.files['backend/' + file] === '0'.repeat(64)) hints.observations[0].sourceSHA256 = '1'.repeat(64);
  expect(balanceSuites(x.discovered, x.current, hints).weights.find(w => w.file === file).weightKind).toBe('estimated-source-size-weight');
});
test('shard commands preserve original config, runInBand, full file bodies and actual JUnit/JSON', () => { const args = expectedJestArgs('/candidate/backend', '/evidence', ['tests/a.test.js', 'tests/b.test.js']); expect(args).toContain('--runInBand'); expect(args).toContain('--runTestsByPath'); expect(args).toContain('/candidate/backend/jest.config.js'); expect(args).toContain('--reporters=jest-junit'); expect(args.some(a => /grep|testNamePattern|retry/.test(a))).toBe(false); });
test('the launcher rejects extra grep/project/retry options and out-of-range shard IDs before any setup', async () => { const { main } = require('../scripts/run-ci-jest-shard'); for (const args of [['--shard', '0'], ['--shard', '9'], ['--shard', '1', '--grep', 'chosen'], ['--shard', '1', '--retries', '2']]) await expect(main(args)).rejects.toThrow(/no selection or retry overrides/); });

test('continuation requires an exact reviewed plan on a clean, source-bound manual backend-only event', () => {
  const { validateExecutionContext } = require('../scripts/verify-ci-jest-continuation');
  const current = { commit: 'a'.repeat(40) }, spec = { schemaVersion: 1, mode: 'whole-file-source-bound-backend-continuation', currentCommit: '@checked-out-head' }, bytes = Buffer.from(JSON.stringify(spec)), approved = hash(bytes);
  const env = { LPC_JEST_CONTINUATION_PLAN_SHA256: approved, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: current.commit }, event = { inputs: { execution_scope: 'backend-source', continuation_plan_sha256: approved } };
  expect(validateExecutionContext(current, env, event, '', bytes)).toEqual({ spec, approved });
  for (const [changedEnv, changedEvent, dirty, changedBytes] of [
    [{ ...env, LPC_JEST_CONTINUATION_PLAN_SHA256: '' }, event, '', bytes],
    [{ ...env, GITHUB_EVENT_NAME: 'pull_request' }, event, '', bytes],
    [{ ...env, GITHUB_SHA: 'b'.repeat(40) }, event, '', bytes],
    [env, { inputs: { ...event.inputs, execution_scope: 'full' } }, '', bytes],
    [env, { inputs: { ...event.inputs, continuation_plan_sha256: '0'.repeat(64) } }, '', bytes],
    [env, event, ' M backend/routes/cases.js', bytes],
    [env, event, '', Buffer.from(JSON.stringify({ ...spec, currentCommit: current.commit }))],
  ]) expect(() => validateExecutionContext(current, changedEnv, changedEvent, dirty, changedBytes)).toThrow();
});
test('browser-only source disposition cannot conceal backend code or certify its unexecuted browser behavior', () => {
  const { validateBridge } = require('../scripts/verify-ci-jest-continuation');
  const files = { 'backend/jest.config.js': '1'.repeat(64), 'backend/package-lock.json': '2'.repeat(64), 'backend/package.json': '3'.repeat(64), '.node-version': '4'.repeat(64), 'backend/tests/filler.test.js': '5'.repeat(64) };
  const prior = { commit: 'a'.repeat(40), files }, current = { commit: 'b'.repeat(40), files: { ...files, 'frontend/assets/scripts/changed.js': '6'.repeat(64) } };
  const entry = { path: 'frontend/assets/scripts/changed.js', beforeSha256: null, afterSha256: '6'.repeat(64), kind: 'browser-only-product', backendRuntimeImpact: 'none-reviewed', browserAcceptanceRequired: true, affectedSuites: [], reviewedEvidenceSha256: '7'.repeat(64) };
  const bridge = { schemaVersion: 1, mode: 'explicit-source-bound-jest-continuation', priorCommit: prior.commit, currentCommit: current.commit, priorSourceSha256: hash(JSON.stringify(prior)), currentSourceSha256: hash(JSON.stringify(current)), changes: [entry] };
  expect([...validateBridge(prior, current, ['tests/filler.test.js'], bridge, hash(JSON.stringify(bridge)))]).toEqual([]);
  for (const field of ['backendRuntimeImpact', 'browserAcceptanceRequired']) { const changed = { ...bridge, changes: [{ ...entry, [field]: false }] }; expect(() => validateBridge(prior, current, ['tests/filler.test.js'], changed, hash(JSON.stringify(changed)))).toThrow(); }
  const backendCurrent = { ...current, files: { ...files, 'backend/services/changed.js': '6'.repeat(64) } }, hidden = { ...bridge, currentSourceSha256: hash(JSON.stringify(backendCurrent)), changes: [{ ...entry, path: 'backend/services/changed.js' }] };
  expect(() => validateBridge(prior, backendCurrent, ['tests/filler.test.js'], hidden, hash(JSON.stringify(hidden)))).toThrow();
});

 test('prior artifact import rejects unknown runs, attempts and mismatched exact source before network access', () => {
  const { validatePriorIdentity } = require('../scripts/import-ci-jest-prior');
  const accepted = [
    { priorRunId: 38677811432, priorAttempt: 1, priorHead: 'c0d2fddd9f0a1a7024833a4b308fe9533d5e1657' },
    { priorRunId: 39076828223, priorAttempt: 1, priorHead: 'c3ee5566fbaf562d22ee7536807c4da2bf248006' },
  ];
  for (const spec of accepted) {
    expect(() => validatePriorIdentity(spec)).not.toThrow();
    for (const changed of [{ ...spec, priorRunId: 39076828224 }, { ...spec, priorRunId: String(spec.priorRunId) }, { ...spec, priorAttempt: 2 }, { ...spec, priorHead: '0'.repeat(40) }]) expect(() => validatePriorIdentity(changed)).toThrow();
  }
});
