const fs = require("fs");
const path = require("path");
const { parseDocument } = require("yaml");

const repositoryRoot = path.resolve(__dirname, "../..");
const defaultWorkflowPath = path.join(repositoryRoot, ".github/workflows/quality.yml");
const REQUIRED_JOBS = Object.freeze([
  "deployment-blueprint",
  "validate",
  "browser-contracts",
  "dependency-review",
  "codeql",
  "secrets",
]);
const REQUIRED_VALIDATE_COMMANDS = Object.freeze([
  "npm run check:candidate",
  "npm run check:ci-workflow",
  "npm run check:repository",
  "npm run check:runtime",
  "npm run check:syntax",
  "npm run check:focus",
  "npm run check:routes",
  "npm run check:backend-reachability",
  "npm run check:runtime-bindings",
  "npm run check:route-security",
  "npm run check:logging",
  "npm run check:secrets",
  "npm run check:frontend",
  "npm run check:frontend-bindings",
  "npm run check:vendor",
  "npm run check:no-theater",
  "npm run check:api-contract",
  "npm run check:performance",
  "npm run check:legal",
  "npm run check:install-scripts",
  "npm run generate:sbom",
  "npm run check:licenses",
  "npm audit --omit=dev --audit-level=high",
  "npm test -- --ci",
  "node scripts/verify-ci-jest-coverage.js --prepare",
  "node scripts/verify-ci-jest-coverage.js --verify",
]);
const REQUIRED_BROWSER_COMMANDS = Object.freeze([
  "npx playwright install --with-deps chromium firefox webkit",
  "npm run build:frontend",
  "npm run test:browser:contracts",
  "npm run test:e2e",
  "npm run test:playwright:a11y",
  "npm run test:playwright:performance",
  "npm run test:playwright:critical",
]);
const REQUIRED_CRITICAL_CONFIGS = Object.freeze({
  "test:playwright:support": "playwright.support.config.js",
  "test:playwright:paralegal-support": "playwright.paralegal-support.config.js",
  "test:playwright:paralegal-financial-records": "tests/playwright/paralegal-financial-records/real.config.js",
  "test:playwright:director": "playwright.director.config.js",
  "test:playwright:director-commission": "tests/playwright/director-commission/playwright.config.js",
  "test:playwright:control-room": "playwright.control-room.config.js",
  "test:playwright:admin-financials": "playwright.admin-financials.config.js",
  "test:playwright:financial-lifecycle": "tests/playwright/financial-lifecycle/playwright.config.js",
  "test:playwright:frontend-hygiene": "tests/playwright/frontend-hygiene/playwright.config.js",
  "test:playwright:workspace-navigation": "tests/playwright/workspace-navigation/playwright.config.js",
  "test:playwright:workspace-session": "tests/playwright/workspace-session/playwright.config.js",
  "test:playwright:attorney-v2": "tests/playwright/attorney-v2/playwright.config.js",
  "test:playwright:shared-matter": "tests/playwright/shared-matter/playwright.config.js",
  "test:playwright:admin-solo": "tests/playwright/admin-solo/playwright.config.js",
  "test:playwright:admin-evidence": "tests/playwright/admin-evidence/completion.config.js",
});

function fail(message) {
  const error = new Error(`[ci-workflow] ${message}`);
  error.code = "CI_WORKFLOW_CONTRACT_FAILED";
  throw error;
}

const FIXTURE_GROUP_SUITES = new Set(["attorney-v2", "paralegal-support", "director", "financial-lifecycle", "shared-matter", "admin-solo"]);
const EXPECTED_GROUP_NAMES = Object.freeze(["attorney-v2-actual-shared-1", "attorney-v2-actual-shared-2", "attorney-v2-actual-shared-3", "attorney-v2-actual-shared-4", "attorney-v2-declared-1", "attorney-v2-declared-2", "attorney-v2-declared-3", "attorney-v2-declared-4", "attorney-v2-declared-5", "attorney-v2-actual-notes-1", "attorney-v2-actual-work-1", "paralegal-support-declared-1", "paralegal-support-declared-2", "paralegal-support-declared-3", "paralegal-support-declared-4", "paralegal-support-declared-5", "paralegal-support-actual-shared-1", "support", "paralegal-financial-records", "director-commission", "control-room", "admin-financials", "frontend-hygiene", "workspace-session", "workspace-navigation", "admin-evidence", "financial-lifecycle", "shared-matter", "admin-solo", "director", "director-managed", "financial-model-claims"]);
const EXPECTED_BROWSER_SCOPES = Object.freeze([
  { scope: "deterministic-and-lifecycle", command: "npm run test:browser:contracts && npm run test:e2e" },
  { scope: "public-accessibility", command: "npm run test:playwright:a11y" },
  { scope: "public-performance", command: "npm run test:playwright:performance" },
]);
const REQUIRED_GATE_NAMES = Object.freeze({
  "deployment-blueprint": "Deployment Blueprint", validate: "Runtime, dependency, and test gates",
  "browser-contracts": "Browser contracts", "dependency-review": "Dependency review", codeql: "CodeQL", secrets: "Secret scan",
});
function browserCatalog() { return JSON.parse(fs.readFileSync(path.join(repositoryRoot, "backend/tests/playwright/acceptance/groups.json"), "utf8")); }

function validateCriticalBrowserScripts(manifest) {
  const scripts = manifest?.scripts || {};
  const commands = String(scripts["test:playwright:critical"] || "")
    .split("&&").map(command => command.trim());
  for (const [name, config] of Object.entries(REQUIRED_CRITICAL_CONFIGS)) {
    if (!commands.includes(`npm run ${name}`)) fail(`Launch-critical browser chain omits ${name}.`);
    const suite = name.replace("test:playwright:", "");
    const required = FIXTURE_GROUP_SUITES.has(suite) ? `node scripts/run-critical-browser-group.js --suite ${suite}` : `playwright test -c ${config} --fail-on-flaky-tests`;
    if (scripts[name] !== required) fail(`${name} must run its complete original configuration through the exact approved fixture adapter or --fail-on-flaky-tests command.`);
  }
  if (commands.length !== Object.keys(REQUIRED_CRITICAL_CONFIGS).length || new Set(commands).size !== commands.length) fail("Critical acceptance must contain every original scope exactly once.");
  if (scripts["test:playwright:critical:group"] !== "node scripts/run-critical-browser-group.js" || scripts["test:playwright:critical:groups"] !== "node scripts/run-critical-browser-group.js --list-groups") fail("Exact runnable permanent group commands are required.");
  return Object.keys(REQUIRED_CRITICAL_CONFIGS).length;
}

function validateCompiledBrowserFixtures(job) {
  const builtRoot = "${{ github.workspace }}/.lpc-build";
  const expected = {
    LPC_USE_BUILT_FRONTEND: "true",
    LPC_SEARCH_SOURCE_ROOT: builtRoot,
    LPC_HELP_SOURCE_ROOT: builtRoot,
    LPC_HELP_FRONTEND_ROOT: `${builtRoot}/frontend`,
    LPC_SECURITY_FRONTEND_ROOT: `${builtRoot}/frontend`,
    LPC_PARA_CLOSURE_FRONTEND_ROOT: `${builtRoot}/frontend`,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (job.env?.[key] !== value) fail(`Browser fixtures must use the production build through ${key}.`);
  }
  const steps = job.steps || [];
  const install = steps.findIndex(step => step.run === "npm ci");
  const build = steps.findIndex(step => step.run === "npm run build:frontend");
  const tests = steps.findIndex(step => String(step.run || "").startsWith("npm run test:") || ["Run complete browser scope", "Verify complete unique browser identity coverage"].includes(step.name));
  if (install < 0 || build <= install || tests < 0 || build >= tests) {
    fail("Browser frontend must be built after dependency installation and before browser tests.");
  }
}

function parseWorkflow(source, filePath = defaultWorkflowPath) {
  const document = parseDocument(source, {
    maxAliasCount: 20,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) {
    fail(`${filePath} is not valid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const workflow = document.toJS({ maxAliasCount: 20 });
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    fail("The quality workflow must contain a YAML object.");
  }
  return workflow;
}

function runText(job) {
  return (job?.steps || [])
    .map((step) => (typeof step?.run === "string" ? step.run : ""))
    .filter(Boolean)
    .join("\n");
}

function findStep(job, name) {
  return (job?.steps || []).find((step) => step?.name === name) || null;
}

function validateLaunchEvidenceArtifact(job, { stepName, pathFragment }) {
  const step = findStep(job, stepName);
  if (!step) fail(`${stepName} is missing.`);
  if (step.if !== "always()") fail(`${stepName} must run with always() so failed and successful executions retain evidence.`);
  if (!String(step.uses || "").startsWith("actions/upload-artifact@")) {
    fail(`${stepName} must use actions/upload-artifact.`);
  }
  if (!String(step.with?.path || "").includes(pathFragment)) {
    fail(`${stepName} must retain ${pathFragment}.`);
  }
  if (step.with?.["if-no-files-found"] !== "error") {
    fail(`${stepName} must fail when required launch evidence is missing.`);
  }
  if (Number(step.with?.["retention-days"]) !== 30) {
    fail(`${stepName} must retain launch evidence for 30 days.`);
  }
}

function requireCommands(job, commands, label) {
  const source = runText(job);
  for (const command of commands) {
    if (!source.includes(command)) fail(`${label} is missing required command: ${command}`);
  }
}

function validateRuntimeBeforeInstall(job, label) {
  const steps = job?.steps || [];
  const runtimeIndex = steps.findIndex((step) => String(step?.run || "").includes("node scripts/verify-runtime.js"));
  const installIndex = steps.findIndex((step) => String(step?.run || "").includes("npm ci"));
  if (runtimeIndex < 0) fail(`${label} must verify the pinned Node and npm runtimes.`);
  if (installIndex < 0) fail(`${label} must install with npm ci.`);
  if (runtimeIndex > installIndex) fail(`${label} must verify runtimes before installing dependencies.`);
}

function validateCandidateBeforeInstall(job) {
  const steps = job?.steps || [];
  const candidateIndex = steps.findIndex((step) =>
    String(step?.run || "").includes("npm run check:candidate")
  );
  const installIndex = steps.findIndex((step) => String(step?.run || "").includes("npm ci"));
  if (candidateIndex < 0) fail("validate must record the exact clean candidate identity.");
  if (installIndex < 0) fail("validate must install with npm ci.");
  if (candidateIndex > installIndex) {
    fail("Candidate identity must be verified before dependency installation can change local state.");
  }
}

function validatePinnedActions(workflow) {
  for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
    for (const step of job?.steps || []) {
      if (!step?.uses) continue;
      if (!/@[a-f0-9]{40}$/i.test(String(step.uses))) {
        fail(`${jobName} action ${step.uses} must be pinned to a full commit SHA.`);
      }
      if (String(step.uses).startsWith("actions/checkout@") && step.with?.["persist-credentials"] !== false) {
        fail(`${jobName} checkout must set persist-credentials: false.`);
      }
    }
  }
}

function validateGroupedBrowserJobs(jobs, catalog) {
  if (catalog.schemaVersion !== 1 || catalog.groups?.length !== EXPECTED_GROUP_NAMES.length ||
      JSON.stringify(catalog.groups.map(group => group.name).sort()) !== JSON.stringify([...EXPECTED_GROUP_NAMES].sort()) ||
      catalog.expectedUniqueCriticalIdentities !== 5933 || catalog.expectedOverallUniqueIdentities !== 6239 ||
      catalog.groups.reduce((sum, group) => sum + group.expectedIdentities, 0) !== 5933) fail("Complete versioned browser groups and exact unique identity totals are required.");
  for (const group of catalog.groups) {
    if (group.workers !== 1 || group.retries !== 0 || group.originalAssertionBodiesUnchanged !== true ||
        (group.name === "director-managed" ? group.baseConfig !== REQUIRED_CRITICAL_CONFIGS["test:playwright:financial-lifecycle"] : REQUIRED_CRITICAL_CONFIGS[group.suite] !== group.baseConfig) || !group.files?.length ||
        group.files.some(file => !/^tests\/playwright\/[A-Za-z0-9_./-]+\.spec\.js$/.test(file)) || !Number.isSafeInteger(group.expectedIdentities) || group.expectedIdentities <= 0) fail(`Invalid full fixture group contract: ${group.name}`);
  }
  const collection = jobs["browser-collection"], checks = jobs["browser-checks"], roles = jobs["browser-role-journeys"], gate = jobs["browser-contracts"];
  if (!collection || !checks || !roles) fail("Browser collection, public/contracts and role matrix jobs are required.");
  requireCommands(collection, ["node scripts/run-critical-browser-group.js --verify-groups"], "browser-collection");
  validateLaunchEvidenceArtifact(collection, { stepName: "Upload browser collection evidence", pathFragment: "backend/test-results/critical-group-verification/verified-union.json" });
  for (const [name, job] of [["browser-collection", collection], ["browser-checks", checks], ["browser-role-journeys", roles]]) {
    validateCompiledBrowserFixtures(job); validateRuntimeBeforeInstall(job, name);
    if (job.if || job["continue-on-error"]) fail(`${name} cannot conditionally bypass complete acceptance.`);
    for (const step of job.steps || []) if (step["continue-on-error"]) fail(`${name} cannot suppress a failed step.`);
  }
  for (const job of [checks, roles]) {
    if (job.strategy?.["fail-fast"] !== false || job.strategy?.["max-parallel"] !== 3) fail("Browser matrices must finish every group with bounded parallelism and no fail-fast omissions.");
    requireCommands(job, ["npx playwright install --with-deps chromium firefox webkit"], "browser matrix");
    validateLaunchEvidenceArtifact(job, { stepName: "Upload browser launch evidence", pathFragment: "backend/test-results/junit" });
  }
  if (Object.keys(checks.strategy.matrix || {}).join() !== "include" || JSON.stringify(checks.strategy.matrix.include) !== JSON.stringify(EXPECTED_BROWSER_SCOPES) ||
      findStep(checks, "Run complete browser scope")?.run !== "${{ matrix.command }}") fail("Complete deterministic, lifecycle, public accessibility and performance scopes must each execute without narrowing.");
  if (roles.needs !== "browser-collection" || Object.keys(roles.strategy.matrix || {}).join() !== "group" ||
      JSON.stringify([...(roles.strategy.matrix.group || [])].sort()) !== JSON.stringify([...EXPECTED_GROUP_NAMES].sort()) ||
      findStep(roles, "Run complete fixture-compatible role group")?.run !== 'npm run test:playwright:critical:group -- --group "${{ matrix.group }}"') fail("Every approved role fixture group must execute exactly once after collection verification.");
  const dependencies = ["browser-collection", "browser-checks", "browser-role-journeys"];
  if (gate.if !== "always()" || JSON.stringify([...(gate.needs || [])].sort()) !== JSON.stringify([...dependencies].sort()) || gate["continue-on-error"]) fail("Fixed Browser contracts gate must always require all browser jobs and reject failures, cancellations and skips.");
  const final = findStep(gate, "Require every original browser scope and role group");
  if (gate.steps?.length !== 1 || final?.["continue-on-error"] ||
      JSON.stringify(final?.env) !== JSON.stringify({ COLLECTION_RESULT: "${{ needs.browser-collection.result }}", CHECKS_RESULT: "${{ needs.browser-checks.result }}", ROLES_RESULT: "${{ needs.browser-role-journeys.result }}" }) ||
      final?.run?.trim() !== 'test "$COLLECTION_RESULT" = success\ntest "$CHECKS_RESULT" = success\ntest "$ROLES_RESULT" = success') fail("Browser aggregate must fail closed unless every complete dependency succeeds.");
  return catalog.groups.length;
}

function validateWorkflowContract(workflow, manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "backend/package.json"), "utf8")), catalog = browserCatalog()) {
  const triggers = workflow.on || {};
  if (!Object.prototype.hasOwnProperty.call(triggers, "pull_request")) fail("pull_request validation is required.");
  if (!Object.prototype.hasOwnProperty.call(triggers, "push")) fail("main push validation is required.");
  if (Object.prototype.hasOwnProperty.call(triggers, "pull_request_target")) {
    fail("pull_request_target is forbidden for the quality workflow.");
  }
  if (workflow.permissions?.contents !== "read" || Object.keys(workflow.permissions || {}).length !== 1) {
    fail("Top-level permissions must grant only contents: read.");
  }
  if (workflow.concurrency?.["cancel-in-progress"] !== true) {
    fail("Superseded workflow runs must be cancelled.");
  }

  const jobs = workflow.jobs || {};
  for (const jobName of REQUIRED_JOBS) {
    if (!jobs[jobName]) fail(`Required job ${jobName} is missing.`);
    if (jobs[jobName].name !== REQUIRED_GATE_NAMES[jobName]) fail(`Required named gate context changed: ${jobName}.`);
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    if (job["runs-on"] !== "ubuntu-24.04") fail(`${jobName} must use the pinned ubuntu-24.04 runner.`);
    const timeout = Number(job["timeout-minutes"]);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) {
      fail(`${jobName} must have a bounded timeout no greater than 60 minutes.`);
    }
  }

  validatePinnedActions(workflow);
  requireCommands(jobs["deployment-blueprint"], ["npm ci", "npm run check:deploy"], "deployment-blueprint");
  requireCommands(jobs.validate, ["npm ci", ...REQUIRED_VALIDATE_COMMANDS], "validate");
  const browserGroups = validateGroupedBrowserJobs(jobs, catalog);
  const { focusedFiles } = require("./verify-ci-jest-coverage");
  focusedFiles(manifest, "test:auth");focusedFiles(manifest, "test:payments");
  const criticalBrowserCommands = validateCriticalBrowserScripts(manifest);
  validateRuntimeBeforeInstall(jobs["deployment-blueprint"], "deployment-blueprint");
  validateRuntimeBeforeInstall(jobs.validate, "validate");
  validateCandidateBeforeInstall(jobs.validate);

  const jestStep = findStep(jobs.validate, "Run complete Jest suite");
  const prepare = findStep(jobs.validate, "Bind complete Jest source and required subsets"), verify = findStep(jobs.validate, "Verify substantive authentication and payment coverage");
  const steps = jobs.validate.steps || [];
  if (prepare?.run !== "node scripts/verify-ci-jest-coverage.js --prepare" || verify?.run !== "node scripts/verify-ci-jest-coverage.js --verify" ||
      steps.indexOf(prepare) >= steps.indexOf(jestStep) || steps.indexOf(verify) <= steps.indexOf(jestStep) ||
      prepare?.if || verify?.if || jobs.validate["continue-on-error"] || steps.some(step => step["continue-on-error"])) fail("Substantive auth/payment reuse must bind source before and verify complete evidence after the original Jest execution.");
  if (!String(jestStep?.run || "").includes("--reporters=jest-junit")) {
    fail("The complete Jest suite must emit JUnit launch evidence.");
  }
  if (
    jestStep?.env?.JEST_JUNIT_OUTPUT_DIR !== "test-results/jest" ||
    jestStep?.env?.JEST_JUNIT_OUTPUT_NAME !== "results.xml"
  ) {
    fail("The Jest JUnit evidence path must remain deterministic.");
  }
  validateLaunchEvidenceArtifact(jobs.validate, {
    stepName: "Upload supply-chain launch evidence",
    pathFragment: "backend/test-results/supply-chain",
  });
  validateLaunchEvidenceArtifact(jobs.validate, {
    stepName: "Upload candidate identity evidence",
    pathFragment: "backend/test-results/release/candidate.json",
  });
  validateLaunchEvidenceArtifact(jobs.validate, {
    stepName: "Upload Jest launch evidence",
    pathFragment: "backend/test-results/jest/results.xml",
  });
  if (jestStep.run !== "npm test -- --ci --reporters=default --reporters=jest-junit --json --outputFile=test-results/jest/results.json") fail("One complete original Jest run must retain JSON and JUnit without selection or retries.");
  const jestArtifact = findStep(jobs.validate, "Upload Jest launch evidence");
  for (const file of ["results.json", "full-suite-binding.json", "required-coverage.json"]) if (!String(jestArtifact?.with?.path || "").includes(`backend/test-results/jest/${file}`)) fail(`Complete Jest source/coverage evidence missing: ${file}.`);

  const dependencyReview = jobs["dependency-review"];
  if (dependencyReview.if !== "github.event_name == 'pull_request'") {
    fail("Dependency review must run only for pull requests.");
  }
  if (dependencyReview.permissions?.contents !== "read" || dependencyReview.permissions?.["pull-requests"] !== "read") {
    fail("Dependency review permissions must remain read-only.");
  }
  const dependencyStep = findStep(dependencyReview, "Reject vulnerable dependency changes");
  if (dependencyStep?.with?.["fail-on-severity"] !== "moderate") {
    fail("Dependency review must reject moderate-or-higher vulnerable changes.");
  }
  if (!String(dependencyStep?.with?.["deny-licenses"] || "").includes("AGPL-3.0")) {
    fail("Dependency review must retain the AGPL deny policy.");
  }

  const codeql = jobs.codeql;
  if (codeql.permissions?.contents !== "read" || codeql.permissions?.["security-events"] !== "write") {
    fail("CodeQL must have only contents: read and security-events: write permissions.");
  }
  const initStep = findStep(codeql, "Initialize CodeQL");
  if (initStep?.with?.languages !== "javascript-typescript" || initStep?.with?.queries !== "security-extended") {
    fail("CodeQL must analyze JavaScript/TypeScript with security-extended queries.");
  }

  const secretJob = jobs.secrets;
  const secretCheckout = findStep(secretJob, "Check out full history");
  if (secretCheckout?.with?.["fetch-depth"] !== 0) fail("Secret scanning must check out full repository history.");
  const secretStep = findStep(secretJob, "Scan repository history");
  if (!String(secretStep?.uses || "").startsWith("gitleaks/gitleaks-action@")) {
    fail("The Secret scan job must run gitleaks.");
  }

  return {
    jobs: REQUIRED_JOBS.length,
    validateCommands: REQUIRED_VALIDATE_COMMANDS.length,
    browserCommands: REQUIRED_BROWSER_COMMANDS.length,
    criticalBrowserCommands,
    browserGroups,
  };
}

function main() {
  const workflowPath = path.resolve(process.cwd(), process.argv[2] || defaultWorkflowPath);
  const workflow = parseWorkflow(fs.readFileSync(workflowPath, "utf8"), workflowPath);
  const result = validateWorkflowContract(workflow);
  console.log(
    `[ci-workflow] ${workflowPath} passed (${result.jobs} required jobs, ${result.validateCommands} validation commands, ${result.browserCommands} browser commands, ${result.criticalBrowserCommands} complete critical configurations).`
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  parseWorkflow,
  validateWorkflowContract,
  validateCriticalBrowserScripts,
  validateGroupedBrowserJobs,
};
