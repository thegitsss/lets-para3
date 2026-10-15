const fs = require("fs");
const path = require("path");
const {
  parseWorkflow,
  validateWorkflowContract,
  validateCriticalBrowserScripts,
} = require("../scripts/check-ci-workflow");

const workflowPath = path.resolve(__dirname, "../../.github/workflows/quality.yml");

function currentWorkflow() {
  return parseWorkflow(fs.readFileSync(workflowPath, "utf8"), workflowPath);
}

describe("quality workflow contract", () => {
  test("the current workflow enforces every launch-critical repository and browser gate", () => {
    expect(validateWorkflowContract(currentWorkflow())).toEqual({
      jobs: 6,
      validateCommands: 26,
      browserCommands: 7,
      criticalBrowserCommands: 15,
      browserGroups: 32,
    });
  });

  test.each(["shared-matter", "admin-solo", "admin-evidence"])("rejects omission of complete %s browser acceptance", (scope) => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    const name = `test:playwright:${scope}`;
    manifest.scripts["test:playwright:critical"] = manifest.scripts["test:playwright:critical"]
      .split("&&").filter(command => command.trim() !== `npm run ${name}`).join(" && ");
    expect(() => validateCriticalBrowserScripts(manifest)).toThrow(name);
  });

  test.each(["--grep selected", "--project chromium", "--retries 2"])("rejects narrowing or replacing critical acceptance with %s", (option) => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    manifest.scripts["test:playwright:shared-matter"] += ` ${option}`;
    expect(() => validateCriticalBrowserScripts(manifest)).toThrow(/complete original configuration/);
  });

  test("rejects source-only browser fixtures or building after verification", () => {
    const sourceOnly = currentWorkflow();
    sourceOnly.jobs["browser-role-journeys"].env.LPC_USE_BUILT_FRONTEND = "false";
    expect(() => validateWorkflowContract(sourceOnly)).toThrow(/production build through LPC_USE_BUILT_FRONTEND/);

    const legacyFixture = currentWorkflow();
    delete legacyFixture.jobs["browser-role-journeys"].env.LPC_SECURITY_FRONTEND_ROOT;
    expect(() => validateWorkflowContract(legacyFixture)).toThrow(/production build through LPC_SECURITY_FRONTEND_ROOT/);

    const lateBuild = currentWorkflow();
    const steps = lateBuild.jobs["browser-role-journeys"].steps;
    const index = steps.findIndex(step => step.run === "npm run build:frontend");
    const [build] = steps.splice(index, 1);
    steps.push(build);
    expect(() => validateWorkflowContract(lateBuild)).toThrow(/before browser tests/);
  });

  test("rejects candidate identity checks after installation or without retained evidence", () => {
    const lateIdentity = currentWorkflow();
    const steps = lateIdentity.jobs.validate.steps;
    const candidateIndex = steps.findIndex((entry) => entry.name === "Record exact release candidate");
    const [candidateStep] = steps.splice(candidateIndex, 1);
    const installIndex = steps.findIndex((entry) => entry.name === "Install exact dependency graph");
    steps.splice(installIndex + 1, 0, candidateStep);
    expect(() => validateWorkflowContract(lateIdentity)).toThrow(/before dependency installation/);

    const missingEvidence = currentWorkflow();
    missingEvidence.jobs.validate.steps = missingEvidence.jobs.validate.steps.filter(
      (entry) => entry.name !== "Upload candidate identity evidence"
    );
    expect(() => validateWorkflowContract(missingEvidence)).toThrow(/candidate identity evidence is missing/);
  });

  test("rejects removal of the production no-theater gate", () => {
    const workflow = currentWorkflow();
    const step = workflow.jobs.validate.steps.find((entry) => entry.run?.includes("npm run check:no-theater"));
    expect(step).toBeDefined();
    step.run = step.run.replace("npm run check:no-theater", "npm run check:frontend");
    expect(() => validateWorkflowContract(workflow)).toThrow(/check:no-theater/);
  });

  test("rejects mutable action tags and credential-persisting checkout", () => {
    const mutable = currentWorkflow();
    mutable.jobs.validate.steps[0].uses = "actions/checkout@v7";
    expect(() => validateWorkflowContract(mutable)).toThrow(/full commit SHA/);

    const credentialed = currentWorkflow();
    credentialed.jobs.validate.steps[0].with["persist-credentials"] = true;
    expect(() => validateWorkflowContract(credentialed)).toThrow(/persist-credentials/);
  });

  test("rejects elevated dependency-review permissions and pull_request_target", () => {
    const elevated = currentWorkflow();
    elevated.jobs["dependency-review"].permissions["pull-requests"] = "write";
    expect(() => validateWorkflowContract(elevated)).toThrow(/read-only/);

    const unsafeTrigger = currentWorkflow();
    unsafeTrigger.on.pull_request_target = {};
    expect(() => validateWorkflowContract(unsafeTrigger)).toThrow(/pull_request_target/);
  });

  test("rejects missing or short-lived successful test evidence", () => {
    const missingJunit = currentWorkflow();
    const jestStep = missingJunit.jobs.validate.steps.find((entry) => entry.name === "Run complete Jest suite");
    jestStep.run = "npm test -- --ci";
    expect(() => validateWorkflowContract(missingJunit)).toThrow(/JUnit launch evidence/);

    const shortLived = currentWorkflow();
    const artifact = shortLived.jobs["browser-checks"].steps.find(
      (entry) => entry.name === "Upload browser launch evidence"
    );
    artifact.with["retention-days"] = 7;
    expect(() => validateWorkflowContract(shortLived)).toThrow(/30 days/);

    const missingAllowed = currentWorkflow();
    const candidateArtifact = missingAllowed.jobs.validate.steps.find(
      (entry) => entry.name === "Upload candidate identity evidence"
    );
    candidateArtifact.with["if-no-files-found"] = "warn";
    expect(() => validateWorkflowContract(missingAllowed)).toThrow(
      /fail when required launch evidence is missing/
    );
  });
});


describe("complete parallel browser gate graph", () => {
  test("rejects omission or duplication of any complete role group", () => {
    const omitted = currentWorkflow();omitted.jobs["browser-role-journeys"].strategy.matrix.group.pop();
    expect(() => validateWorkflowContract(omitted)).toThrow(/Every approved role fixture group/);
    const duplicated = currentWorkflow();duplicated.jobs["browser-role-journeys"].strategy.matrix.group.push(duplicated.jobs["browser-role-journeys"].strategy.matrix.group[0]);
    expect(() => validateWorkflowContract(duplicated)).toThrow(/Every approved role fixture group/);
  });
  test("rejects omitted public scope, narrowed group, or fail-fast cancellation", () => {
    const missing = currentWorkflow();missing.jobs["browser-checks"].strategy.matrix.include.pop();
    expect(() => validateWorkflowContract(missing)).toThrow(/Complete deterministic/);
    const narrowed = currentWorkflow();narrowed.jobs["browser-role-journeys"].steps.find(step => step.name === "Run complete fixture-compatible role group").run += " --grep chosen";
    expect(() => validateWorkflowContract(narrowed)).toThrow(/Every approved role fixture group/);
    const failFast = currentWorkflow();failFast.jobs["browser-role-journeys"].strategy["fail-fast"] = true;
    expect(() => validateWorkflowContract(failFast)).toThrow(/no fail-fast omissions/);
  });
  test("requires fixed named gate and fail-closed success from collection and every matrix", () => {
    const skipped = currentWorkflow();skipped.jobs["browser-contracts"].if = "success()";
    expect(() => validateWorkflowContract(skipped)).toThrow(/always require all browser jobs/);
    const missing = currentWorkflow();missing.jobs["browser-contracts"].needs.pop();
    expect(() => validateWorkflowContract(missing)).toThrow(/always require all browser jobs/);
    const bypass = currentWorkflow();bypass.jobs["browser-contracts"].steps[0].run = "true";
    expect(() => validateWorkflowContract(bypass)).toThrow(/fail closed/);
    const renamed = currentWorkflow();renamed.jobs["browser-contracts"].name = "Partial journeys";
    expect(() => validateWorkflowContract(renamed)).toThrow(/Required named gate context/);
  });
  test("rejects suppressed failures and inflated job deadlines", () => {
    const suppressed = currentWorkflow();suppressed.jobs["browser-checks"].steps.at(-3)["continue-on-error"] = true;
    expect(() => validateWorkflowContract(suppressed)).toThrow(/suppress a failed step/);
    const inflated = currentWorkflow();inflated.jobs["browser-role-journeys"]["timeout-minutes"] = 180;
    expect(() => validateWorkflowContract(inflated)).toThrow(/no greater than 60/);
  });
  test("requires full-suite source binding before and coverage verification after Jest", () => {
    const late = currentWorkflow(), steps = late.jobs.validate.steps;
    const index = steps.findIndex(step => step.name === "Bind complete Jest source and required subsets");
    const [binding] = steps.splice(index, 1);steps.push(binding);
    expect(() => validateWorkflowContract(late)).toThrow(/bind source before/);
    const omitted = currentWorkflow();omitted.jobs.validate.steps = omitted.jobs.validate.steps.filter(step => step.name !== "Verify substantive authentication and payment coverage");
    expect(() => validateWorkflowContract(omitted)).toThrow(/verify-ci-jest-coverage/);
  });
});
