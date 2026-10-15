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
      validateCommands: 23,
      browserCommands: 7,
      criticalBrowserCommands: 15,
      browserGroups: 32,
      backendShards: 8,
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
    const steps = lateIdentity.jobs["runtime-checks"].steps;
    const candidateIndex = steps.findIndex((entry) => entry.name === "Record exact release candidate");
    const [candidateStep] = steps.splice(candidateIndex, 1);
    const installIndex = steps.findIndex((entry) => entry.name === "Install exact dependency graph");
    steps.splice(installIndex + 1, 0, candidateStep);
    expect(() => validateWorkflowContract(lateIdentity)).toThrow(/before dependency installation/);

    const missingEvidence = currentWorkflow();
    missingEvidence.jobs["runtime-checks"].steps = missingEvidence.jobs["runtime-checks"].steps.filter(
      (entry) => entry.name !== "Upload candidate identity evidence"
    );
    expect(() => validateWorkflowContract(missingEvidence)).toThrow(/candidate identity evidence is missing/);
  });

  test("rejects removal of the production no-theater gate", () => {
    const workflow = currentWorkflow();
    const step = workflow.jobs["runtime-checks"].steps.find((entry) => entry.run?.includes("npm run check:no-theater"));
    expect(step).toBeDefined();
    step.run = step.run.replace("npm run check:no-theater", "npm run check:frontend");
    expect(() => validateWorkflowContract(workflow)).toThrow(/check:no-theater/);
  });

  test("rejects mutable action tags and credential-persisting checkout", () => {
    const mutable = currentWorkflow();
    mutable.jobs["runtime-checks"].steps[0].uses = "actions/checkout@v7";
    expect(() => validateWorkflowContract(mutable)).toThrow(/full commit SHA/);

    const credentialed = currentWorkflow();
    credentialed.jobs["runtime-checks"].steps[0].with["persist-credentials"] = true;
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
    const jestStep = missingJunit.jobs["backend-tests"].steps.find((entry) => entry.name === "Run every assigned original Jest suite once");
    jestStep.run = "npm test -- --ci";
    expect(() => validateWorkflowContract(missingJunit)).toThrow(/serialized shard launcher/);

    const shortLived = currentWorkflow();
    const artifact = shortLived.jobs["browser-checks"].steps.find(
      (entry) => entry.name === "Upload browser launch evidence"
    );
    artifact.with["retention-days"] = 7;
    expect(() => validateWorkflowContract(shortLived)).toThrow(/owner-approved one day/);

    const missingAllowed = currentWorkflow();
    const candidateArtifact = missingAllowed.jobs["runtime-checks"].steps.find(
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
    const late = currentWorkflow(), steps = late.jobs["runtime-checks"].steps;
    const index = steps.findIndex(step => step.name === "Bind and balance complete original Jest file shards");
    const [binding] = steps.splice(index, 1);steps.push(binding);
    expect(() => validateWorkflowContract(late)).toThrow(/Bind source before/);
    const omitted = currentWorkflow();omitted.jobs["backend-coverage"].steps = omitted.jobs["backend-coverage"].steps.filter(step => step.name !== "Verify complete raw union and substantive authentication/payment coverage");
    expect(() => validateWorkflowContract(omitted)).toThrow(/verify the complete source-bound raw union/);
  });
});


describe("complete disjoint backend gate graph", () => {
 test("rejects a missing shard, narrowed launcher, fail-fast omissions and skipped fixed Runtime gate", () => {
  const missing=currentWorkflow();missing.jobs["backend-tests"].strategy.matrix.shard.pop();expect(()=>validateWorkflowContract(missing)).toThrow(/Every disjoint complete Jest/);
  const narrowed=currentWorkflow();narrowed.jobs["backend-tests"].steps.find(s=>s.name==="Run every assigned original Jest suite once").run+=" --grep chosen";expect(()=>validateWorkflowContract(narrowed)).toThrow(/serialized shard launcher/);
  const fast=currentWorkflow();fast.jobs["backend-tests"].strategy["fail-fast"]=true;expect(()=>validateWorkflowContract(fast)).toThrow(/no fail-fast omissions/);
  const skipped=currentWorkflow();skipped.jobs.validate.if="success()";expect(()=>validateWorkflowContract(skipped)).toThrow(/Fixed Runtime gate must always/);
 });
 test("rejects raw artifact overwrites, suppressed result, weaker fixed gate and inflated backend budget", () => {
  const overwritten=currentWorkflow();overwritten.jobs["backend-coverage"].steps.find(s=>s.name==="Download all original Jest shard evidence").with["merge-multiple"]=true;expect(()=>validateWorkflowContract(overwritten)).toThrow(/without overwrites/);
  const suppressed=currentWorkflow();suppressed.jobs["backend-tests"].steps.at(-2)["continue-on-error"]=true;expect(()=>validateWorkflowContract(suppressed)).toThrow(/cannot suppress/);
  const fake=currentWorkflow();fake.jobs.validate.steps[0].run="true";expect(()=>validateWorkflowContract(fake)).toThrow(/Runtime aggregate must fail closed/);
  const inflated=currentWorkflow();inflated.jobs["backend-tests"]["timeout-minutes"]=60;expect(()=>validateWorkflowContract(inflated)).toThrow(/Original 45-minute/);
 });
});


describe("explicit source/backend evidence dispatch", () => {
  const scopes = ["browser-collection", "browser-checks", "browser-role-journeys", "browser-contracts"];
  test.each([
    ["pull_request", undefined, true], ["push", undefined, true],
    ["workflow_dispatch", "full", true], ["workflow_dispatch", undefined, true],
    ["workflow_dispatch", "unknown", true], ["workflow_dispatch", "backend-source", false],
  ])("browser execution is preserved for %s/%s", (eventName, scope, expected) => {
    const workflow = currentWorkflow();
    validateWorkflowContract(workflow);
    for (const name of scopes) {
      const expression = workflow.jobs[name].if.replace("always()", "true");
      const enabled = Function("github", "inputs", `return (${expression})`)({event_name:eventName}, {execution_scope:scope});
      expect(enabled).toBe(expected);
    }
  });
  test("rejects omission, broader skip expressions, default narrowing and extra inputs", () => {
    for (const name of scopes) {
      const missing = currentWorkflow(); delete missing.jobs[name].if;
      expect(() => validateWorkflowContract(missing)).toThrow();
      const broad = currentWorkflow(); broad.jobs[name].if = "github.event_name != 'workflow_dispatch'";
      expect(() => validateWorkflowContract(broad)).toThrow();
    }
    for (const mutate of [
      w => { w.on.workflow_dispatch.inputs.execution_scope.default = "backend-source"; },
      w => { w.on.workflow_dispatch.inputs.execution_scope.required = false; },
      w => { w.on.workflow_dispatch.inputs.execution_scope.options.push("skip"); },
      w => { w.on.workflow_dispatch.inputs.skip = {type:"boolean", default:true}; },
      w => { delete w.on.workflow_dispatch; },
    ]) {
      const workflow = currentWorkflow(); mutate(workflow);
      expect(() => validateWorkflowContract(workflow)).toThrow(/Only explicit manual/);
    }
  });
});

describe("reviewed backend continuation workflow binding", () => {
  const jobs = ["runtime-checks", "backend-tests", "backend-coverage"];
  const digest = "a".repeat(64);
  test.each([
    ["pull_request", "backend-source", digest, ""],
    ["push", "backend-source", digest, ""],
    ["workflow_dispatch", "full", digest, ""],
    ["workflow_dispatch", "unknown", digest, ""],
    ["workflow_dispatch", "backend-source", "", ""],
    ["workflow_dispatch", "backend-source", digest, digest],
  ])("binds the reviewed plan only for %s/%s/%s", (event, scope, supplied, expected) => {
    const workflow = currentWorkflow();
    validateWorkflowContract(workflow);
    for (const name of jobs) {
      const expression = workflow.jobs[name].env.LPC_JEST_CONTINUATION_PLAN_SHA256.slice(3, -3);
      const actual = Function("github", "inputs", `return (${expression})`)(
        { event_name: event }, { execution_scope: scope, continuation_plan_sha256: supplied });
      expect(actual).toBe(expected);
    }
  });
  test("requires a truly optional empty string default without accepting extra inputs", () => {
    for (const mutate of [
      w => { delete w.on.workflow_dispatch.inputs.continuation_plan_sha256; },
      w => { w.on.workflow_dispatch.inputs.continuation_plan_sha256.required = true; },
      w => { w.on.workflow_dispatch.inputs.continuation_plan_sha256.default = digest; },
      w => { w.on.workflow_dispatch.inputs.continuation_plan_sha256.type = "boolean"; },
      w => { w.on.workflow_dispatch.inputs.continuation_plan_sha256.options = [digest]; },
    ]) {
      const workflow = currentWorkflow(); mutate(workflow);
      expect(() => validateWorkflowContract(workflow)).toThrow(/Only explicit manual/);
    }
  });
  test("rejects unbound hashes and SHA forwarding outside the explicit dispatch", () => {
    for (const name of jobs) for (const expression of [undefined, digest, "${{ inputs.continuation_plan_sha256 }}"]) {
      const workflow = currentWorkflow(); workflow.jobs[name].env.LPC_JEST_CONTINUATION_PLAN_SHA256 = expression;
      expect(() => validateWorkflowContract(workflow)).toThrow(/continuation plan binding/);
    }
  });
  test("limits prior artifact access to preparation and union with exact read-only permissions", () => {
    for (const name of ["runtime-checks", "backend-coverage"]) for (const mutate of [
      job => { delete job.env.GH_TOKEN; },
      job => { job.env.GH_TOKEN = "${{ secrets.PERSONAL_TOKEN }}"; },
      job => { job.permissions.actions = "write"; },
      job => { job.permissions.contents = "write"; },
      job => { job.permissions.issues = "read"; },
    ]) {
      const workflow = currentWorkflow(); mutate(workflow.jobs[name]);
      expect(() => validateWorkflowContract(workflow)).toThrow(/exact read-only/);
    }
    for (const mutate of [job => { job.env.GH_TOKEN = "${{ github.token }}"; }, job => { job.permissions = { contents: "read" }; }]) {
      const workflow = currentWorkflow(); mutate(workflow.jobs["backend-tests"]);
      expect(() => validateWorkflowContract(workflow)).toThrow(/shards cannot receive/);
    }
    const leaked = currentWorkflow(); leaked.jobs["browser-checks"].env.LPC_JEST_CONTINUATION_PLAN_SHA256 = digest;
    expect(() => validateWorkflowContract(leaked)).toThrow(/Only preparation, shards and union/);
  });
});

describe("bounded source-bound acceptance return", () => {
  const defaultJobs = ["deployment-blueprint", "runtime-checks", "backend-tests", "backend-coverage", "validate", "codeql", "secrets"];
  const returnJobs = ["source-bound-backend-return", "selected-native-return"];
  const evaluate = (expression, event, scope) => Function("github", "inputs", `return (${expression.replace("always()", "true")})`)(
    { event_name: event }, { execution_scope: scope });

  test.each([
    ["pull_request", "source-return", true], ["push", "source-return", true],
    ["workflow_dispatch", "full", true], ["workflow_dispatch", "backend-source", true],
    ["workflow_dispatch", undefined, true], ["workflow_dispatch", "unknown", true],
    ["workflow_dispatch", "source-return", false],
  ])("preserves every default source gate for %s/%s", (event, scope, expected) => {
    const workflow = currentWorkflow();
    validateWorkflowContract(workflow);
    for (const name of defaultJobs) expect(evaluate(workflow.jobs[name].if, event, scope)).toBe(expected);
    for (const name of returnJobs) expect(evaluate(workflow.jobs[name].if, event, scope)).toBe(event === "workflow_dispatch" && scope === "source-return");
  });

  test("omits original browser execution only for the exact reviewed return dispatch", () => {
    const workflow = currentWorkflow();
    validateWorkflowContract(workflow);
    for (const name of ["browser-collection", "browser-checks", "browser-role-journeys", "browser-contracts"]) {
      expect(evaluate(workflow.jobs[name].if, "workflow_dispatch", "source-return")).toBe(false);
      expect(evaluate(workflow.jobs[name].if, "pull_request", "source-return")).toBe(true);
    }
  });

  test("rejects mutable/external calls, inherited secrets, elevated permissions and unbound proof hashes", () => {
    for (const name of returnJobs) for (const mutate of [
      job => { job.uses = "other/repo/.github/workflows/return.yml@main"; },
      job => { job.secrets = "inherit"; },
      job => { job.permissions.actions = "write"; },
      job => { job.with.bridge_sha256 = "a".repeat(64); },
      job => { job.if = "github.event_name == 'workflow_dispatch'"; },
      job => { job["continue-on-error"] = true; },
      job => { job.needs = "validate"; },
    ]) {
      const workflow = currentWorkflow(); mutate(workflow.jobs[name]);
      expect(() => validateWorkflowContract(workflow)).toThrow(/Source-bound return calls/);
    }
  });

  test("rejects broad source skips and the missing-directory failure in both fixed aggregates", () => {
    for (const name of ["deployment-blueprint", "codeql", "secrets"]) {
      const workflow = currentWorkflow(); workflow.jobs[name].if = "github.event_name != 'workflow_dispatch'";
      expect(() => validateWorkflowContract(workflow)).toThrow(/preserve default acceptance/);
    }
    for (const name of ["validate", "browser-contracts"]) {
      const workflow = currentWorkflow(); delete workflow.jobs[name].steps[0]["working-directory"];
      expect(() => validateWorkflowContract(workflow)).toThrow(/Checkout-free.*aggregate/);
    }
  });
});


describe("explicit single-file recovery return with complete named gates", () => {
  const evaluate = (expression, event, scope) => Function("github", "inputs", `return (${expression.replace("always()", "true")})`)({event_name:event}, {execution_scope:scope});
  test.each([
    ["pull_request", "recovery-return"], ["push", "recovery-return"],
    ["workflow_dispatch", "full"], ["workflow_dispatch", undefined],
    ["workflow_dispatch", "unknown"], ["workflow_dispatch", "backend-source"],
    ["workflow_dispatch", "source-return"], ["workflow_dispatch", "recovery-return"],
  ])("binds the exact source security and execution jobs for %s/%s", (event, scope) => {
    const w=currentWorkflow();validateWorkflowContract(w);
    const manual=event==="workflow_dispatch", recovery=manual&&scope==="recovery-return", source=manual&&scope==="source-return";
    for(const name of ["deployment-blueprint","runtime-checks","codeql","secrets"])expect(evaluate(w.jobs[name].if,event,scope)).toBe(!source);
    for(const name of ["backend-tests","backend-coverage"])expect(evaluate(w.jobs[name].if,event,scope)).toBe(!source&&!recovery);
    for(const name of ["browser-collection","browser-checks","browser-role-journeys"])expect(evaluate(w.jobs[name].if,event,scope)).toBe(!manual||!["backend-source","source-return","recovery-return"].includes(scope));
    expect(evaluate(w.jobs.validate.if,event,scope)).toBe(!source);
    expect(evaluate(w.jobs["browser-contracts"].if,event,scope)).toBe(!manual||!["backend-source","source-return"].includes(scope));
    expect(evaluate(w.jobs["source-bound-recovery-return"].if,event,scope)).toBe(recovery);
    expect(evaluate(w.jobs["source-bound-backend-return"].if,event,scope)).toBe(source);
    expect(evaluate(w.jobs["selected-native-return"].if,event,scope)).toBe(source||recovery);
  });
  const outcomes = [
    ["validate",false,{CHECKS_RESULT:"success",SHARDS_RESULT:"success",COVERAGE_RESULT:"success",RECOVERY_RESULT:"skipped"}],
    ["validate",true,{CHECKS_RESULT:"success",SHARDS_RESULT:"skipped",COVERAGE_RESULT:"skipped",RECOVERY_RESULT:"success"}],
    ["browser-contracts",false,{COLLECTION_RESULT:"success",CHECKS_RESULT:"success",ROLES_RESULT:"success",SELECTED_RESULT:"skipped"}],
    ["browser-contracts",true,{COLLECTION_RESULT:"skipped",CHECKS_RESULT:"skipped",ROLES_RESULT:"skipped",SELECTED_RESULT:"success"}],
  ];
  test.each(outcomes)("named %s gate accepts only its exact complete result class (recovery=%s)",(name,recovery,values)=>{
    const cp=require("child_process"),job=currentWorkflow().jobs[name],script=job.steps[0].run;
    const run=env=>cp.spawnSync("/bin/bash",["-e","-c",script],{env:{...process.env,...env,RECOVERY_SCOPE:String(recovery)},encoding:"utf8"}).status;
    expect(run(values)).toBe(0);
    for(const key of Object.keys(values))for(const value of ["failure","cancelled","unknown",""]){expect(run({...values,[key]:value})).not.toBe(0);}
    for(const key of Object.keys(values))expect(run({...values,[key]:values[key]==="success"?"skipped":"success"})).not.toBe(0);
  });
  test("recovery workflow cannot use ambient authority mutable code or an unbound plan",()=>{
    for(const mutate of [j=>j.secrets="inherit",j=>j.permissions.actions="write",j=>j.with.bridge_sha256="f".repeat(64),j=>j.if="github.event_name == 'workflow_dispatch'",j=>j.uses="owner/repo/workflow.yml@main",j=>j["continue-on-error"]=true]){
      const w=currentWorkflow();mutate(w.jobs["source-bound-recovery-return"]);expect(()=>validateWorkflowContract(w)).toThrow(/Source-bound return calls/);
    }
  });
  test("both original named aggregates reject proof dependency env script or result suppression drift",()=>{
    for(const name of ["validate","browser-contracts"])for(const mutate of [j=>j.needs=j.needs.slice(0,-1),j=>j.steps[0].env.RECOVERY_SCOPE="false",j=>j.steps[0].run+="\ntrue",j=>j.steps[0]["continue-on-error"]=true]){
      const w=currentWorkflow();mutate(w.jobs[name]);expect(()=>validateWorkflowContract(w)).toThrow();
    }
  });
});

describe("recovery artifacts share the approved native pool before upload", () => {
  const { verifyRecoveryArtifactAllocation } = require("../scripts/check-ci-workflow");
  function fixture(prefix, maximum) {
    const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: "/owned/event.json", GITHUB_REPOSITORY: "thegitsss/lets-para3", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
    const job = prefix === "candidate-identity" ? "runtime-checks" : "secrets";
    const plan = { candidateCommit: "@checked-out-head", sourcePins: { "backend/tests/playwright/acceptance/native-continuation-plan.json": "@approved-plan" }, cloudEvidence: { recoveryArtifacts: [{ prefix, job, key: "", maxBytes: maximum }, ...[1, 2, 3, 4].map(n => ({ prefix: "other-" + n }))] } };
    const record = { schemaVersion: 1, repository: env.GITHUB_REPOSITORY, headSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, artifact: { job, key: "", name: prefix + "-123-1" }, completeEvidence: true, retentionDays: 1, compressionLevel: 9, upperBoundBytes: maximum };
    const event = { inputs: { execution_scope: "recovery-return", continuation_plan_sha256: "" } };
    function run() {
      const bytes = Buffer.from(JSON.stringify(plan));
      event.inputs.continuation_plan_sha256 = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
      const values = { [env.GITHUB_EVENT_PATH]: Buffer.from(JSON.stringify(event)), "tests/playwright/acceptance/native-continuation-plan.json": bytes, "/owned/record.json": Buffer.from(JSON.stringify(record)) };
      return verifyRecoveryArtifactAllocation(prefix, "/owned/record.json", { env, read: p => { if (!Object.hasOwn(values, p)) throw Error("Unreviewed path"); return values[p]; } });
    }
    return { env, plan, record, event, run };
  }
  test("both exact recovery limits accept complete evidence and ordinary events retain their allocation", () => {
    for (const [prefix, maximum] of [["candidate-identity", 4 * 1024 ** 2], ["secret-scan-evidence", 8 * 1024 ** 2]]) {
      const f = fixture(prefix, maximum);
      expect(f.run()).toEqual({ profile: "recovery-return", maximum, upperBoundBytes: maximum });
      f.record.upperBoundBytes = 1; expect(f.run().upperBoundBytes).toBe(1);
      f.env.GITHUB_EVENT_NAME = "pull_request"; expect(f.run()).toEqual({ profile: "ordinary-allocation" });
      f.env.GITHUB_EVENT_NAME = "workflow_dispatch"; f.event.inputs.execution_scope = "full"; expect(f.run()).toEqual({ profile: "ordinary-allocation" });
    }
  });
  test("over-budget stale incomplete or unbound proof and a removed preupload guard fail closed", () => {
    for (const [prefix, maximum] of [["candidate-identity", 4 * 1024 ** 2], ["secret-scan-evidence", 8 * 1024 ** 2]]) {
      for (const mutate of [f => f.record.upperBoundBytes++, f => f.record.upperBoundBytes = 0, f => f.record.upperBoundBytes = 1.5, f => f.record.headSha = "b".repeat(40), f => f.record.runId = "124", f => f.record.attempt = "2", f => f.record.repository = "another/repo", f => f.record.completeEvidence = false, f => f.record.artifact.job = "wrong", f => f.record.artifact.name += "-extra", f => f.plan.cloudEvidence.recoveryArtifacts[0].maxBytes++, f => f.plan.cloudEvidence.recoveryArtifacts.pop(), f => f.plan.sourcePins["backend/tests/playwright/acceptance/native-continuation-plan.json"] = "f".repeat(64)]) {
        const f = fixture(prefix, maximum); mutate(f); expect(f.run).toThrow();
      }
    }
    for (const name of ["runtime-checks", "secrets"]) {
      const w = currentWorkflow(), guard = w.jobs[name].steps.find(s => String(s.run || "").includes("verifyRecoveryArtifactAllocation(prefix"));
      expect(guard).toBeTruthy(); guard.run = guard.run.split("\n")[0]; expect(() => validateWorkflowContract(w)).toThrow(/finite budget guard/);
    }
    const f = fixture("candidate-identity", 4 * 1024 ** 2);
    expect(() => verifyRecoveryArtifactAllocation("candidate-identity", "/owned/record.json", { env: f.env, read: p => p === f.env.GITHUB_EVENT_PATH ? Buffer.from(JSON.stringify({ inputs: { execution_scope: "recovery-return", continuation_plan_sha256: "f".repeat(64) } })) : Buffer.from("{}") })).toThrow();
  });
});
