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
    sourceOnly.jobs["browser-contracts"].env.LPC_USE_BUILT_FRONTEND = "false";
    expect(() => validateWorkflowContract(sourceOnly)).toThrow(/production build through LPC_USE_BUILT_FRONTEND/);

    const legacyFixture = currentWorkflow();
    delete legacyFixture.jobs["browser-contracts"].env.LPC_SECURITY_FRONTEND_ROOT;
    expect(() => validateWorkflowContract(legacyFixture)).toThrow(/production build through LPC_SECURITY_FRONTEND_ROOT/);

    const lateBuild = currentWorkflow();
    const steps = lateBuild.jobs["browser-contracts"].steps;
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
    const artifact = shortLived.jobs["browser-contracts"].steps.find(
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
