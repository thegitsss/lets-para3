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
  "npm run test:payments",
  "npm run test:auth",
]);
const REQUIRED_BROWSER_COMMANDS = Object.freeze([
  "npx playwright install --with-deps chromium firefox webkit",
  "npm run test:browser:contracts",
  "npm run test:e2e",
  "npm run test:playwright:a11y",
  "npm run test:playwright:performance",
  "npm run test:playwright:critical",
]);

function fail(message) {
  const error = new Error(`[ci-workflow] ${message}`);
  error.code = "CI_WORKFLOW_CONTRACT_FAILED";
  throw error;
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

function validateWorkflowContract(workflow) {
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
  requireCommands(jobs["browser-contracts"], ["npm ci", ...REQUIRED_BROWSER_COMMANDS], "browser-contracts");
  validateRuntimeBeforeInstall(jobs["deployment-blueprint"], "deployment-blueprint");
  validateRuntimeBeforeInstall(jobs.validate, "validate");
  validateRuntimeBeforeInstall(jobs["browser-contracts"], "browser-contracts");
  validateCandidateBeforeInstall(jobs.validate);

  const jestStep = findStep(jobs.validate, "Run complete Jest suite");
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
  validateLaunchEvidenceArtifact(jobs["browser-contracts"], {
    stepName: "Upload browser launch evidence",
    pathFragment: "backend/test-results/junit",
  });

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
  };
}

function main() {
  const workflowPath = path.resolve(process.cwd(), process.argv[2] || defaultWorkflowPath);
  const workflow = parseWorkflow(fs.readFileSync(workflowPath, "utf8"), workflowPath);
  const result = validateWorkflowContract(workflow);
  console.log(
    `[ci-workflow] ${workflowPath} passed (${result.jobs} required jobs, ${result.validateCommands} validation commands, ${result.browserCommands} browser commands).`
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
};
