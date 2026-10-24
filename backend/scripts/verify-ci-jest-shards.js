'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { snapshot, focusedFiles, assertOriginalConfig, REQUIRED_SUBSETS } = require('./verify-ci-jest-coverage');
const root = path.resolve(__dirname, '../..'), backend = path.join(root, 'backend');
const evidence = path.join(backend, 'test-results/jest');
const SHARD_COUNT = 8;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); };
const fail = message => { throw Error('[ci-jest-shards] ' + message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonical = values => [...values].sort();
function balanceSuites(suites, source, hints, sizes = {}, count = SHARD_COUNT) {
  if (!Number.isSafeInteger(count) || count < 1 || suites.length < count || new Set(suites).size !== suites.length) fail('Nonempty disjoint suite groups required.');
  const observed = new Map((hints.observations || []).filter(r => r.sourceSHA256 === source.files['backend/' + r.file] && Number.isFinite(r.durationMs) && r.durationMs > 0).map(r => [r.file, r.durationMs]));
  const ratios = [...observed].filter(([file]) => sizes[file] > 0).map(([file, ms]) => ms / sizes[file]).sort((a, b) => a - b);
  const ratio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1;
  const weighted = suites.map(file => { if (!source.files['backend/' + file]) fail('Untracked original suite: ' + file); return { file, weight: observed.get(file) || Math.max(1000, Math.round((sizes[file] || 30000) * ratio)), weightKind: observed.has(file) ? 'observed-local-duration-source-matched' : 'estimated-source-size-weight' }; }).sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const shards = Array.from({ length: count }, (_, index) => ({ id: index + 1, suites: [], schedulingWeightMs: 0 }));
  for (const row of weighted) { const target = [...shards].sort((a, b) => a.schedulingWeightMs - b.schedulingWeightMs || a.id - b.id)[0]; target.suites.push(row.file); target.schedulingWeightMs += row.weight; }
  for (const shard of shards) shard.suites.sort();
  return { shards, weights: weighted, schedulingOnly: true };
}
function discover() {
  assertOriginalConfig(require(path.join(backend, 'jest.config.js')));
  const files = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', path.join(backend, 'node_modules/jest/bin/jest.js'), '--config', path.join(backend, 'jest.config.js'), '--runInBand', '--listTests', '--json'], { cwd: backend, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  return canonical(files.map(file => { const relative = path.relative(backend, file).split(path.sep).join('/'); if (!/^tests\/[A-Za-z0-9_./-]+\.test\.js$/.test(relative) || relative.includes('..')) fail('Invalid original discovery path.'); return relative; }));
}
function validatePlan(plan, current, discovered) {
  if (plan.continuation) return require('./verify-ci-jest-continuation').validateContinuationPlan(plan, current, discovered);
  if (plan.schemaVersion !== 2 || !equal(plan.source, current) || !Number.isFinite(Date.parse(plan.preparedAt)) || !plan.executionId) fail('Plan candidate/source or execution binding changed.');
  const { planId, ...payload } = plan;
  if (planId !== hash(JSON.stringify(payload))) fail('Plan content digest changed.');
  if (!equal(canonical(plan.suites || []), canonical(discovered)) || new Set(discovered).size !== discovered.length || discovered.length < SHARD_COUNT) fail('Plan must contain exact complete current Jest discovery.');
  if (!equal(plan.required, REQUIRED_SUBSETS) || plan.originalConfigSHA256 !== current.files['backend/jest.config.js']) fail('Original config or approved substantive subsets changed.');
  if (plan.shards?.length !== SHARD_COUNT || !equal(plan.shards.map(s => s.id), Array.from({ length: SHARD_COUNT }, (_, i) => i + 1))) fail('Every declared shard must appear exactly once.');
  const union = plan.shards.flatMap(shard => { if (!Array.isArray(shard.suites) || !shard.suites.length) fail('Empty shard.'); return shard.suites; });
  if (new Set(union).size !== union.length || !equal(canonical(union), canonical(discovered))) fail('Missing or duplicated complete original suite assignment.');
  for (const file of union) if (!current.files['backend/' + file]) fail('Untracked assigned suite.');
  return plan;
}
function validateOwnedCleanup(mongo, http) {
  const started = mongo.filter(e => e.phase === 'started');
  if (!started.length || new Set(started.map(e => e.pid)).size !== started.length || mongo.some(e => e.phase === 'spawn-error')) fail('Actual owned Mongo process observations missing/invalid.');
  for (const child of started) for (const phase of ['exit', 'closed']) {
    const outcomes = mongo.filter(e => e.pid === child.pid && e.phase === phase);
    if (outcomes.length !== 1 || outcomes[0].code !== 0 || outcomes[0].signal) fail('Actual owned Mongo did not close normally: ' + child.pid);
  }
  if (mongo.some(e => !['started', 'exit', 'closed'].includes(e.phase) || !started.some(s => s.pid === e.pid))) fail('Unmatched Mongo lifecycle event.');
  const opened = http.filter(e => e.phase === 'listening'), closed = http.filter(e => e.phase === 'closed');
  if (opened.length !== closed.length || new Set(opened.map(e => `${e.pid}:${e.id}`)).size !== opened.length || opened.some(o => closed.filter(c => c.pid === o.pid && c.id === o.id).length !== 1) || http.some(e => !['listening', 'closed'].includes(e.phase))) fail('Owned HTTP listener was not closed exactly once.');
  return { actualMongoChildren: started.length, actualHttpListeners: opened.length, normalOwnedCleanup: true };
}
function expectedJestArgs(backendRoot, outputRoot, suites) {
  return ['--experimental-vm-modules', path.join(backendRoot, 'node_modules/jest/bin/jest.js'), '--config', path.join(backendRoot, 'jest.config.js'), '--ci', '--runInBand', '--runTestsByPath', ...suites.map(file => path.join(backendRoot, file)), '--reporters=default', '--reporters=jest-junit', '--json', '--outputFile=' + path.join(outputRoot, 'results.json')];
}
function verifyShard(plan, record, report, mongo, http, current, planSHA256, now = Date.now()) {
  const selected = plan.shards.find(s => s.id === record.shardId);
  if (!selected || record.schemaVersion !== 2 || record.executionId !== plan.executionId || record.planId !== plan.planId || record.planSHA256 !== planSHA256 || !equal(record.sourceBefore, current) || !equal(record.sourceAfter, current)) fail('Shard belongs to a different candidate, plan or source.');
  if (!equal(record.suites, selected.suites) || !equal(record.command, expectedJestArgs(record.backendRoot, record.outputRoot, selected.suites))) fail('Shard command narrows/retries or replaces original suite files/config.');
  if (record.observerSHA256 !== current.files['backend/scripts/ci-jest-owned-observer.cjs'] || record.harnessStateReleased !== true) fail('Exact owned observer/original harness cleanup missing.');
  if (record.terminal?.code !== 0 || record.terminal.signal) fail('Original Jest shard process failed.');
  const started = Date.parse(record.startedAt), finished = Date.parse(record.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || started < Date.parse(plan.preparedAt) || finished < started || finished > now || !Number.isFinite(report.startTime) || report.startTime < started || report.startTime > finished) fail('Shard report does not belong to its actual prepared execution.');
  if (!report.success || report.numFailedTestSuites || report.numPendingTestSuites || report.numRuntimeErrorTestSuites || report.numFailedTests || report.numPendingTests || report.numTodoTests) fail('Shard contains failed, missing or skipped outcomes.');
  const suites = (report.testResults || []).map(s => path.relative(record.backendRoot, s.name).split(path.sep).join('/'));
  if (new Set(suites).size !== suites.length || !equal(canonical(suites), canonical(selected.suites)) || report.numTotalTestSuites !== suites.length || report.numPassedTestSuites !== suites.length) fail('Shard raw report omits/duplicates an assigned original suite.');
  const identities = [];
  for (const suite of report.testResults) {
    if (suite.status !== 'passed' || suite.testExecError || !suite.assertionResults?.length) fail('Original callback evidence missing.');
    suite.assertionResults.forEach((callback, ordinal) => { if (callback.status !== 'passed' || callback.invocations !== 1 || callback.failureMessages?.length || callback.retryReasons?.length) fail('Failed, skipped or retried original callback.'); identities.push({ file: path.relative(record.backendRoot, suite.name).split(path.sep).join('/'), ordinal, title: callback.fullName, status: callback.status, invocations: callback.invocations }); });
  }
  if (!identities.length || report.numTotalTests !== identities.length || report.numPassedTests !== identities.length) fail('Raw callback aggregate is inconsistent.');
  return { id: record.shardId, suites, identities, cleanup: validateOwnedCleanup(mongo, http) };
}
function verifyUnion(plan, inputs, current, discovered, planSHA256, now = Date.now()) {
  validatePlan(plan, current, discovered);
  if (inputs.length !== SHARD_COUNT || new Set(inputs.map(i => i.record.shardId)).size !== SHARD_COUNT) fail('Missing or duplicated shard artifact.');
  const shards = inputs.map(input => verifyShard(plan, input.record, input.report, input.mongo, input.http, current, planSHA256, now));
  const suites = shards.flatMap(s => s.suites);
  if (new Set(suites).size !== suites.length || !equal(canonical(suites), canonical(discovered))) fail('Combined raw evidence is not the exact complete suite union.');
  const identities = shards.flatMap(s => s.identities), required = {};
  for (const name of Object.keys(REQUIRED_SUBSETS)) required[name] = REQUIRED_SUBSETS[name].map(file => { const callbacks = identities.filter(i => i.file === file); if (!callbacks.length) fail('Required substantive subset absent: ' + file); return { file, sourceSHA256: current.files['backend/' + file], passedCallbacks: callbacks.length }; });
  return { schemaVersion: 2, commit: current.commit, executionId: plan.executionId, planId: plan.planId, completeOriginalCoverageVerified: true, evidenceClass: 'Disjoint original Jest suite executions; not a fabricated single Jest execution.', shards: shards.length, fullSuites: suites.length, fullCallbacks: identities.length, required, actualIdentities: identities, cleanup: shards.map(s => ({ shardId: s.id, ...s.cleanup })) };
}
function preparePlan() {
  const source = snapshot(), candidateFile = path.join(backend, 'test-results/release/candidate.json'), candidate = read(candidateFile), manifest = read(path.join(backend, 'package.json'));
  if (candidate.commit !== source.commit || process.env.GITHUB_SHA && process.env.GITHUB_SHA !== source.commit || manifest.scripts.test !== 'node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand') fail('Clean candidate or original full test script changed.');
  const suites = discover(), required = Object.fromEntries(Object.keys(REQUIRED_SUBSETS).map(name => [name, focusedFiles(manifest, name)]));
  const sizes = Object.fromEntries(suites.map(file => [file, fs.statSync(path.join(backend, file)).size]));
  const continuation = process.env.LPC_JEST_CONTINUATION_PLAN_SHA256 ? require('./verify-ci-jest-continuation').prepareContinuation(source, suites) : null;
  const selectedSuites = continuation ? continuation.execute : suites;
  const scheduling = balanceSuites(selectedSuites, source, read(path.join(backend, 'tests/ci-jest-duration-hints.json')), sizes);
  const payload = { schemaVersion: 2, preparedAt: new Date().toISOString(), executionId: `${process.env.GITHUB_RUN_ID || 'local-' + Date.now()}:${process.env.GITHUB_RUN_ATTEMPT || '1'}`, source, candidateIdentitySHA256: hash(fs.readFileSync(candidateFile)), originalConfigSHA256: source.files['backend/jest.config.js'], required, suites: selectedSuites, ...scheduling, ...(continuation ? {continuation} : {}) };
  const plan = { ...payload, planId: hash(JSON.stringify(payload)) }; validatePlan(plan, source, suites); write(path.join(evidence, 'plan.json'), plan);
  console.log(continuation ? `[ci-jest-shards] Selected ${selectedSuites.length} affected/unqualified original suites in ${SHARD_COUNT} disjoint serial groups; ${continuation.reuse.length} source-bound prior suite proofs require final union verification.` : `[ci-jest-shards] Planned all ${suites.length} original suites in ${SHARD_COUNT} disjoint serial groups; scheduling weights are estimates, not runtime acceptance.`);
}
function verifyArtifacts() {
  const planFile = path.join(evidence, 'plan.json'), plan = read(planFile), current = snapshot(), artifactRoot = path.join(evidence, 'shard-artifacts');
  const inputs = fs.readdirSync(artifactRoot).map(name => { const directory = path.join(artifactRoot, name); if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('Only separate regular shard artifact directories are allowed.'); const parseLines = name => fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); const record = read(path.join(directory, 'shard.json')); for (const name of ['results.json', 'results.xml', 'mongo.jsonl', 'http.jsonl']) if (hash(fs.readFileSync(path.join(directory, name))) !== record.rawSHA256?.[name]) fail('Raw shard evidence hash changed: ' + name); return { record, report: read(path.join(directory, 'results.json')), mongo: parseLines('mongo.jsonl'), http: parseLines('http.jsonl'), raw: Object.fromEntries(['results.json','results.xml','mongo.jsonl','http.jsonl'].map(name=>[name,fs.readFileSync(path.join(directory,name))])) }; });
  const result = plan.continuation ? require('./verify-ci-jest-continuation').verifyContinuationArtifacts(plan,current,discover(),inputs,hash(fs.readFileSync(planFile))) : verifyUnion(plan, inputs, current, discover(), hash(fs.readFileSync(planFile)));
  write(path.join(evidence, 'required-coverage.json'), { ...result, verifiedAt: new Date().toISOString(), planSHA256: hash(fs.readFileSync(planFile)) });
  console.log(`[ci-jest-shards] Exact raw union qualified: ${result.fullCallbacks} callbacks/${result.fullSuites} suites, auth/payment originals and every owned child cleanup verified.`);
}
module.exports = { SHARD_COUNT, balanceSuites, validatePlan, validateOwnedCleanup, expectedJestArgs, verifyShard, verifyUnion, hash, discover };
if (require.main === module) { try { if (process.argv.length !== 3) fail('Use exactly --prepare or --verify.'); if (process.argv[2] === '--prepare') preparePlan(); else if (process.argv[2] === '--verify') verifyArtifacts(); else fail('Use exactly --prepare or --verify.'); } catch (error) { console.error(error.message); process.exitCode = 1; } }
