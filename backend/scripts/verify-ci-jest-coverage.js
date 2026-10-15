'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repoRoot = path.resolve(__dirname, '../..');
const backendRoot = path.join(repoRoot, 'backend');
const evidenceRoot = path.join(backendRoot, 'test-results/jest');
const REQUIRED_SUBSETS = Object.freeze({
  'test:auth': Object.freeze(['auth.test.js', 'authSecurityIntegration.test.js', 'passkeyService.test.js', 'mfaService.test.js', 'accountDeactivation.test.js', 'productionOrigin.test.js', 'securityEdgeCases.test.js'].map(name => `tests/${name}`).sort()),
  'test:payments': Object.freeze(['paymentOperationService.test.js', 'paymentsPayouts.test.js', 'stripeSafety.test.js', 'webhookHandling.test.js', 'disputesRefunds.test.js', 'jobEscrow.test.js', 'errorHandling.test.js', 'productionOrigin.test.js'].map(name => `tests/${name}`).sort()),
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(message) { throw new Error(`[ci-jest-coverage] ${message}`); }
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }

function focusedFiles(manifest, name) {
  const command = manifest.scripts?.[name];
  const tokens = String(command || '').trim().split(/\s+/);
  if (tokens[0] !== 'jest' || tokens[1] !== '--runInBand' || tokens.length < 3 ||
      tokens.slice(2).some(file => !/^tests\/[A-Za-z0-9_-]+\.test\.js$/.test(file)) ||
      new Set(tokens.slice(2)).size !== tokens.length - 2) fail(`${name} must declare complete explicit original Jest files without narrowing or retries.`);
  const files = tokens.slice(2).sort();
  if (!REQUIRED_SUBSETS[name] || JSON.stringify(files) !== JSON.stringify(REQUIRED_SUBSETS[name])) fail(`${name} omits or replaces an approved substantive authentication/payment suite.`);
  return files;
}

function snapshot(root = repoRoot) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = git(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('A full clean candidate commit is required.');
  const files = {};
  for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean).sort()) {
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(path.resolve(root) + path.sep) || !fs.lstatSync(absolute).isFile()) fail(`Tracked source is not a regular candidate file: ${file}`);
    files[file] = hash(fs.readFileSync(absolute));
  }
  if (!Object.keys(files).length) fail('Candidate source inventory is empty.');
  return { commit, files };
}

function assertOriginalConfig(config) {
  if (JSON.stringify(config.testMatch) !== JSON.stringify(['**/tests/**/*.test.js']) ||
      JSON.stringify(config.setupFiles) !== JSON.stringify(['<rootDir>/tests/setup.js']) ||
      config.globalSetup !== '<rootDir>/tests/helpers/globalMongoSetup.js' ||
      config.globalTeardown !== '<rootDir>/tests/helpers/globalMongoTeardown.js' ||
      config.maxWorkers !== 1 || config.testTimeout !== 30000 || config.testRegex || config.testPathIgnorePatterns) fail('Complete original serial Jest collection, setup, teardown and deadlines must remain intact.');
}

function verifyReport(binding, report, current, now = Date.now()) {
  if (binding.schemaVersion !== 1 || binding.source.commit !== current.commit ||
      JSON.stringify(binding.source.files) !== JSON.stringify(current.files)) fail('Candidate/source changed after the full-suite binding was recorded.');
  const prepared = Date.parse(binding.preparedAt);
  if (!Number.isFinite(prepared) || !Number.isFinite(report.startTime) || report.startTime < prepared || report.startTime > now) fail('Jest result does not belong to this prepared candidate execution.');
  if (!report.success || report.numFailedTestSuites || report.numPendingTestSuites || report.numRuntimeErrorTestSuites ||
      report.numFailedTests || report.numPendingTests || report.numTodoTests) fail('Complete Jest acceptance contains missing, failed, skipped, pending or todo outcomes.');
  if (!Array.isArray(report.testResults) || !report.testResults.length || !Array.isArray(binding.suites) || !binding.suites.length) fail('Complete suite evidence is empty.');
  const names = report.testResults.map(suite => suite.name).sort();
  if (new Set(names).size !== names.length || JSON.stringify(names) !== JSON.stringify([...binding.suites].sort()) ||
      report.numTotalTestSuites !== names.length || report.numPassedTestSuites !== names.length) fail('Result does not execute the exact complete discovered suite set.');
  let assertions = 0;
  for (const suite of report.testResults) {
    if (suite.status !== 'passed' || suite.testExecError || !suite.assertionResults?.length) fail(`Missing or failed original callback evidence: ${suite.name}`);
    for (const outcome of suite.assertionResults) {
      if (outcome.status !== 'passed' || outcome.invocations !== 1 || outcome.failureMessages?.length || outcome.retryReasons?.length) fail(`Failed, skipped or retried callback: ${outcome.fullName}`);
      assertions++;
    }
  }
  if (!assertions || report.numTotalTests !== assertions || report.numPassedTests !== assertions) fail('Aggregate callback counts do not match complete raw identities.');
  const required = {};
  for (const name of ['test:auth', 'test:payments']) {
    const selected = binding.required[name];
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length) fail(`Missing required substantive subset: ${name}`);
    required[name] = selected.map(file => {
      const absolute = path.join(binding.backendRoot, file);
      const suite = report.testResults.find(item => item.name === absolute);
      if (!suite || !binding.source.files[`backend/${file}`]) fail(`Required ${name} suite absent from full execution/source: ${file}`);
      return { file, sourceSHA256: binding.source.files[`backend/${file}`], passedCallbacks: suite.assertionResults.length };
    });
  }
  return { commit: current.commit, fullSuites: names.length, fullCallbacks: assertions, required, completeOriginalCoverageVerified: true };
}

function prepare() {
  const candidate = json(path.join(backendRoot, 'test-results/release/candidate.json'));
  const source = snapshot();
  if (candidate.commit !== source.commit || process.env.GITHUB_SHA && process.env.GITHUB_SHA !== source.commit) fail('Release identity and current commit disagree.');
  assertOriginalConfig(require(path.join(backendRoot, 'jest.config.js')));
  const manifest = json(path.join(backendRoot, 'package.json'));
  if (manifest.scripts.test !== 'node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand') fail('The original complete npm test command changed.');
  const suites = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', path.join(backendRoot, 'node_modules/jest/bin/jest.js'), '--config', path.join(backendRoot, 'jest.config.js'), '--runInBand', '--listTests', '--json'], { cwd: backendRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (!Array.isArray(suites) || !suites.length || new Set(suites).size !== suites.length || suites.some(file => !source.files[path.relative(repoRoot, file).split(path.sep).join('/')])) fail('Every original discovered suite must be bound to tracked candidate source.');
  const required = Object.fromEntries(['test:auth', 'test:payments'].map(name => [name, focusedFiles(manifest, name)]));
  for (const files of Object.values(required)) for (const file of files) if (!suites.includes(path.join(backendRoot, file))) fail(`Required original suite is not in complete Jest collection: ${file}`);
  write(path.join(evidenceRoot, 'full-suite-binding.json'), { schemaVersion: 1, preparedAt: new Date().toISOString(), backendRoot, source, candidateIdentitySHA256: hash(fs.readFileSync(path.join(backendRoot, 'test-results/release/candidate.json'))), suites: suites.sort(), required });
  console.log(`[ci-jest-coverage] Bound ${suites.length} complete original suites and substantive auth/payment subsets to ${source.commit}.`);
}

function verify() {
  const bindingFile = path.join(evidenceRoot, 'full-suite-binding.json'), reportFile = path.join(evidenceRoot, 'results.json');
  const binding = json(bindingFile), candidateFile = path.join(backendRoot, 'test-results/release/candidate.json');
  if (hash(fs.readFileSync(candidateFile)) !== binding.candidateIdentitySHA256) fail('Original candidate identity evidence changed.');
  const manifest = json(path.join(backendRoot, 'package.json'));
  for (const name of ['test:auth', 'test:payments']) if (JSON.stringify(focusedFiles(manifest, name)) !== JSON.stringify(binding.required[name])) fail(`Required subset changed: ${name}`);
  const result = verifyReport(binding, json(reportFile), snapshot());
  write(path.join(evidenceRoot, 'required-coverage.json'), { ...result, verifiedAt: new Date().toISOString(), bindingSHA256: hash(fs.readFileSync(bindingFile)), reportSHA256: hash(fs.readFileSync(reportFile)), candidateIdentitySHA256: binding.candidateIdentitySHA256 });
  console.log(`[ci-jest-coverage] ${result.fullCallbacks} callbacks/${result.fullSuites} complete suites passed once; all substantive authentication/payment originals verified in the same execution.`);
}

if (require.main === module) {
  try { if (process.argv[2] === '--prepare') prepare(); else if (process.argv[2] === '--verify') verify(); else fail('Use --prepare before the complete suite and --verify after it.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { REQUIRED_SUBSETS, focusedFiles, assertOriginalConfig, verifyReport };
