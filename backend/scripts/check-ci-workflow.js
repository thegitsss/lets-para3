const fs = require("fs");
const path = require("path");
const { parseDocument } = require("yaml");

const repositoryRoot = path.resolve(__dirname, "../..");
const defaultWorkflowPath = path.join(repositoryRoot, ".github/workflows/quality.yml");
const SOURCE_RETURN_GUARD = "github.event_name == 'workflow_dispatch' && inputs.execution_scope == 'source-return'";
const RECOVERY_RETURN_GUARD = "github.event_name == 'workflow_dispatch' && inputs.execution_scope == 'recovery-return'";
const NATIVE_RETURN_GUARD = "github.event_name == 'workflow_dispatch' && (inputs.execution_scope == 'source-return' || inputs.execution_scope == 'recovery-return')";
const BACKEND_EXEC_GUARD = "github.event_name != 'workflow_dispatch' || (inputs.execution_scope != 'source-return' && inputs.execution_scope != 'recovery-return')";
const BACKEND_UNION_GUARD = "always() && (" + BACKEND_EXEC_GUARD + ")";
const BROWSER_EXEC_GUARD = "github.event_name != 'workflow_dispatch' || (inputs.execution_scope != 'backend-source' && inputs.execution_scope != 'source-return' && inputs.execution_scope != 'recovery-return')";
const DEFAULT_SCOPE_GUARD = "github.event_name != 'workflow_dispatch' || inputs.execution_scope != 'source-return'";
const DEFAULT_GATE_GUARD = "always() && (" + DEFAULT_SCOPE_GUARD + ")";
const BROWSER_SCOPE_GUARD = "github.event_name != 'workflow_dispatch' || (inputs.execution_scope != 'backend-source' && inputs.execution_scope != 'source-return')";
const BROWSER_GATE_GUARD = "always() && (" + BROWSER_SCOPE_GUARD + ")";
const CONTINUATION_PLAN_BINDING = "${{ github.event_name == 'workflow_dispatch' && inputs.execution_scope == 'backend-source' && inputs.continuation_plan_sha256 || '' }}";
const RUNTIME_AGGREGATE_SCRIPT = "test \"$CHECKS_RESULT\" = success\nif [ \"$RECOVERY_SCOPE\" = true ]; then\n  test \"$RECOVERY_RESULT\" = success\n  test \"$SHARDS_RESULT\" = skipped\n  test \"$COVERAGE_RESULT\" = skipped\nelse\n  test \"$SHARDS_RESULT\" = success\n  test \"$COVERAGE_RESULT\" = success\n  test \"$RECOVERY_RESULT\" = skipped\nfi";
const BROWSER_AGGREGATE_SCRIPT = "if [ \"$RECOVERY_SCOPE\" = true ]; then\n  test \"$SELECTED_RESULT\" = success\n  test \"$COLLECTION_RESULT\" = skipped\n  test \"$CHECKS_RESULT\" = skipped\n  test \"$ROLES_RESULT\" = skipped\nelse\n  test \"$COLLECTION_RESULT\" = success\n  test \"$CHECKS_RESULT\" = success\n  test \"$ROLES_RESULT\" = success\n  test \"$SELECTED_RESULT\" = skipped\nfi";
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
// BEGIN EXACT REVIEWED CURRENT BROWSER FIXTURE AMENDMENTS
const REVIEWED_BROWSER_FIXTURE_AMENDMENTS = Object.freeze([
  {
    "path": "tests/playwright/admin-solo/attention.spec.js",
    "currentSha256": "85873536fe749e417848cae41883c58f118aa9545958552467739e205155e13c",
    "handoffSha256": "bf3dbe1cd8d3b07345dd849e0515c160d1899e76e53f45b724e679de4155fa97",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/attorney-v2/accounts-real.spec.js",
    "currentSha256": "5003c7cc660d576fbb12a401ae843df24e107be3c5fc9bef070249e80529e2d1",
    "handoffSha256": "52692ac1aeac030e6a6a9646f7da6436edad38807a59185e904c45b7fb67e9b7",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/attorney-v2/applications.spec.js",
    "currentSha256": "2b46a3c527f30b1de5fd3e7256a3e60df5959e38185fd2e84014c07d7039cda8",
    "handoffSha256": "fcf4b3dbd47a9d36475d799735809abd7d9009fb25b35fff9d23424e521418ed",
    "disposition": "Obsolete decorative transition premise replaced by approved protected ordinary document navigation; exact applicant return and no-mutation requirements retained."
  },
  {
    "path": "tests/playwright/attorney-v2/conversation.spec.js",
    "currentSha256": "459180ecf6cb5737aedcb0527bce87647a2a7969eea10e7ec77b5e31075970e9",
    "handoffSha256": "e53d222361b34f319273465de4537058104b4de972bfe187aa7c63df657fcc7f",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/attorney-v2/funding.spec.js",
    "currentSha256": "27d5f7e6d3f6ba1c1701bbe4f1f5398f466b3cbf6df16c7ceb9f3fa277cb7b50",
    "handoffSha256": "52692ac1aeac030e6a6a9646f7da6436edad38807a59185e904c45b7fb67e9b7",
    "disposition": "Retired healthy Refresh interaction replaced by current Check payment status/contextual reentry; all money, idempotency, error and current-owner requirements retained."
  },
  {
    "path": "tests/playwright/attorney-v2/invitation-inventory.spec.js",
    "currentSha256": "8b124c5b1b6c6fb23ff4844fbb79f24483ac7594af59c8032482a9703a507e34",
    "handoffSha256": "52692ac1aeac030e6a6a9646f7da6436edad38807a59185e904c45b7fb67e9b7",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/attorney-v2/invitations.spec.js",
    "currentSha256": "eb20411a416b960607249f6c6ca5020aef428a24caf2907eaf4190fd1c9c333b",
    "handoffSha256": "500a9523dfd5c56b8fc1046a5d70684ba85593081a22e1be942f57b3e09cc201",
    "disposition": "Existing protected-session redirect is awaited before leaving V2; current and legacy surfaces use separate contexts from the same valid pre-loss synthetic session. Original disclosure clearing, zero cross-owner reads, deadlines and assertions remain intact."
  },
  {
    "path": "tests/playwright/attorney-v2/matter-inventory.spec.js",
    "currentSha256": "0c1ea997cab037eed6fd3ae9619a92b8aaae89a12f4e05b21677c4351e4ba574",
    "handoffSha256": "3097c3fe52b5e21644729ac11af9a6535d608da112ff2a7a287cf53e875361a9",
    "disposition": "Obsolete absence-of-saved-views assertion replaced by actual approved saved-view management; original AA/layout/focus/no-write requirements retained. Genuine scroll event readiness added."
  },
  {
    "path": "tests/playwright/attorney-v2/payment-setup.spec.js",
    "currentSha256": "eccf08b46539e45ef939ff692061b4470feb486e42b74d34fb298eaa0ca1ad56",
    "handoffSha256": "fcf4b3dbd47a9d36475d799735809abd7d9009fb25b35fff9d23424e521418ed",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/attorney-v2/pre-engagement.spec.js",
    "currentSha256": "3ac6f2a9b5568a5ff49dccc32133ea588a1dfa60d3fc2670ebb7b61a2fdad6ce",
    "handoffSha256": "9ca4df1ca41adae5322ed3d7edf2fedcfd37c293d8014f9fe4bd5bbfa93ce420",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/attorney-v2/read-views.spec.js",
    "currentSha256": "7e33b3cdba5b01e1806819863344c3d15977dcf449df32377522c3ebd912a1c8",
    "handoffSha256": "14fc090ce30626b455c6b5ab92b984f316f1833ee8219cd3caa231ffb14f5659",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/attorney-v2/recovery-controls.spec.js",
    "currentSha256": "c661393db3032afd24277af250ba7aed26c80ee070a215f15062473a5e1e3b3b",
    "handoffSha256": "52692ac1aeac030e6a6a9646f7da6436edad38807a59185e904c45b7fb67e9b7",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/attorney-v2/security.spec.js",
    "currentSha256": "b03cf50f3deebeb2bc28acded6ddf611e31701243fc222331cb307de5dccd3f5",
    "handoffSha256": "e53d222361b34f319273465de4537058104b4de972bfe187aa7c63df657fcc7f",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/attorney-v2/workspace.spec.js",
    "currentSha256": "5c9bee0a162d08320f525a42464f6c7465c6ef7f2e57b230723b9d2ce7de18ce",
    "handoffSha256": "2e41dad9f260487e4c3da66165e516b30026458782c4ae0ce3d77c4a264f8de3",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/financial-lifecycle/admission-journey.spec.js",
    "currentSha256": "755af0fca70475d51805d2e3fc06ea25b9c9216663acce83825f3d55d23d30e6",
    "handoffSha256": "24b3eadb233f9d6dd34a516458fc1fdddb043b470dffa44ed372234ae513d375",
    "disposition": "Combined tour/manual-entry/document controls reconciled to native27case evidence; original registration, approval, privacy, upload ownership, cancellation, retry, persistence and other declared lifecycle requirements preserved. Review: docs/testing/ONBOARDING_FIXTURE_REVIEW_20261019.json."
  },
  {
    "path": "tests/playwright/financial-lifecycle/exception.spec.js",
    "currentSha256": "7edfa181d8be3c88e17a9c31fda0a802adfb6d4710c6f16ade55d86105623d7b",
    "handoffSha256": "b26986574042eced5b16d19a85a11466fcacfd4ef26da68b5d731b0d15736dec",
    "disposition": "Exact root-reviewed native current-control/readiness fixture; original lifecycle money, accounting, owner-loss, native gesture and exact downloaded-byte requirements retained. Source integrated; final native runtime outcome is separately pending."
  },
  {
    "path": "tests/playwright/financial-lifecycle/receipt-passive-journey.spec.js",
    "currentSha256": "143c9ad7da57100ca6ecc0ba92eb429ed950ff3227f1f41f78587af5cffcbf8e",
    "handoffSha256": "b26986574042eced5b16d19a85a11466fcacfd4ef26da68b5d731b0d15736dec",
    "disposition": "Exact root-reviewed native current-control/readiness fixture; original lifecycle money, accounting, owner-loss, native gesture and exact downloaded-byte requirements retained. Source integrated; final native runtime outcome is separately pending."
  },
  {
    "path": "tests/playwright/frontend-hygiene/flows.spec.js",
    "currentSha256": "ea818240e259658255754cf3b017843e2d50e1f86e789a2e9fabdf883138325e",
    "handoffSha256": "bf3dbe1cd8d3b07345dd849e0515c160d1899e76e53f45b724e679de4155fa97",
    "disposition": "Missing optional archived preview remains NOT_EXECUTED_MISSING_OPTIONAL_LOCAL_FIXTURE; released account-closure and excluded-preview accessible404 successor preserves keyboard/landmark/reflow/no-leak requirements."
  },
  {
    "path": "tests/playwright/paralegal-support/conversations-approved.spec.js",
    "currentSha256": "d22244af8bb899b497ff0ccbb9953b6fd377ee11ee5bb94fa77619b96a090aea",
    "handoffSha256": "9c341768bd1ff70fcd4e617fd83f4d102a678877d1f30c0f0acd15aecd921db7",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/paralegal-support/header.spec.js",
    "currentSha256": "337973f71da402cbcd31b3ca9cf57302049b0fd29d2aa60df93e1ec431419866",
    "handoffSha256": "cf23a724b791f4e0648517919d652ac6849b840db4556bc9b59bccbc3f081a5d",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/paralegal-support/home-redesign.spec.js",
    "currentSha256": "42d81121689067d03d1777633af58307c66dd1d06dc16ef19090f8324a902abd",
    "handoffSha256": "9c341768bd1ff70fcd4e617fd83f4d102a678877d1f30c0f0acd15aecd921db7",
    "disposition": "Obsolete healthy Refresh control assertion replaced by current automatic verified return; stored-theme, delayed-navigation and truthful freshness requirements retained."
  },
  {
    "path": "tests/playwright/paralegal-support/linear-rebuild.spec.js",
    "currentSha256": "e82228c0c9028fbf81aa9a0dff77228501346ca8d883fdfcf7c43cf7b60c8161",
    "handoffSha256": "9c341768bd1ff70fcd4e617fd83f4d102a678877d1f30c0f0acd15aecd921db7",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/paralegal-support/paralegal-documents-actual.spec.js",
    "currentSha256": "470ce9077faf1167ead447c1ee50ed982b7b094b0f7b07a628e636f7ac355d4f",
    "handoffSha256": "24b3eadb233f9d6dd34a516458fc1fdddb043b470dffa44ed372234ae513d375",
    "disposition": "Combined tour/manual-entry/document controls reconciled to native27case evidence; original registration, approval, privacy, upload ownership, cancellation, retry, persistence and other declared lifecycle requirements preserved. Review: docs/testing/ONBOARDING_FIXTURE_REVIEW_20261019.json."
  },
  {
    "path": "tests/playwright/paralegal-support/shell-stability.spec.js",
    "currentSha256": "191dbd95bb97ce9fc64915d45a6089cc84455e76d4852b439b6660885ddd3b5d",
    "handoffSha256": "9c341768bd1ff70fcd4e617fd83f4d102a678877d1f30c0f0acd15aecd921db7",
    "disposition": "Obsolete private transition premise replaced by approved protected ordinary navigation; shell, exact destination, native identity and error requirements retained."
  },
  {
    "path": "tests/playwright/paralegal-support/v2-files.spec.js",
    "currentSha256": "632ebb14bda49cc0145476ea84b312bf3dc0add74ffacfd6591849f6ee6dc49c",
    "handoffSha256": "cf23a724b791f4e0648517919d652ac6849b840db4556bc9b59bccbc3f081a5d",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/paralegal-support/v2-messaging.spec.js",
    "currentSha256": "7384bfca4cf3e3b474e90b7e6329758589fc6f4057bd4a17ced85227a143e77b",
    "handoffSha256": "cf23a724b791f4e0648517919d652ac6849b840db4556bc9b59bccbc3f081a5d",
    "disposition": "Current control/readiness/fixture sequencing corrected; original behavioral, security, privacy, focus, record and deadline requirements retained as documented in the exact reviewed handoff."
  },
  {
    "path": "tests/playwright/paralegal-support/v2-work.spec.js",
    "currentSha256": "d633e44ae781eac7a4ef00aeb00b817266a67734ab81b9c76949c8a818469c10",
    "handoffSha256": "4fdf4f9f2f99b0cef3cf31523c5dc39396c5b88c97a54defe7710d7fcd0a4c1e",
    "disposition": "Original closed-listing retained-scope, task, submitted-message, deep-link and no-withdrawal assertions preserved; obsolete Matter details click replaced by direct scope visibility and absent-toggle checks. Exact source-only review is V2_WORK_FIXTURE_REVIEW.txt; execution remains required."
  },
  {
    "path": "tests/playwright/shared-matter/email-message-links.spec.js",
    "currentSha256": "6e576ba362d36af7fa365619a7148aef8d25952ffb914484f6fe9b85cd6c0ac6",
    "handoffSha256": "699552702db968d5a8b374c2024b5ff52de4e956db96aa73d864c92f3e7c1fe5",
    "disposition": "Original protected email callback source prefix retained; three older-target/newer-unread regression identities added without weakening the original unread-zero assertion."
  }
]);
const ORIGINAL_BROWSER_CATALOG_CANONICAL_SHA256 = "0d61f32da09dce7308bbb2827e012c0708757e6ce074530b680b004a98dc3125";
// END EXACT REVIEWED CURRENT BROWSER FIXTURE AMENDMENTS

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
  if (!/^\$\{\{ always\(\) && steps\.evidence_limit_\d+\.outcome == 'success' \}\}$/.test(step.if || "")) fail(`${stepName} must retain successful/failed evidence only after its always() budget guard succeeds.`);
  if (!String(step.uses || "").startsWith("actions/upload-artifact@")) {
    fail(`${stepName} must use actions/upload-artifact.`);
  }
  if (!String(step.with?.path || "").includes(pathFragment)) {
    fail(`${stepName} must retain ${pathFragment}.`);
  }
  if (step.with?.["if-no-files-found"] !== "error") {
    fail(`${stepName} must fail when required launch evidence is missing.`);
  }
  if (Number(step.with?.["retention-days"]) !== 1) {
    fail(`${stepName} must retain complete launch evidence for the owner-approved one day before archive.`);
  }
  if (step.with?.["compression-level"] !== 9) fail(`${stepName} must losslessly compress complete evidence at level9.`);
}

function verifyRecoveryArtifactAllocation(prefix, recordPath, options = {}) {
  const assert = require("node:assert/strict"), crypto = require("node:crypto");
  const env = options.env || process.env, read = options.read || require("node:fs").readFileSync;
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") return { profile: "ordinary-allocation" };
  const event = JSON.parse(read(env.GITHUB_EVENT_PATH));
  if (event.inputs?.execution_scope !== "recovery-return") return { profile: "ordinary-allocation" };
  const fixed = { "candidate-identity": ["runtime-checks", 4 * 1024 ** 2], "secret-scan-evidence": ["secrets", 8 * 1024 ** 2] };
  assert(Object.hasOwn(fixed, prefix));
  const approved = event.inputs.continuation_plan_sha256;
  assert(/^[a-f0-9]{64}$/.test(approved || ""));
  const bytes = read("tests/playwright/acceptance/native-continuation-plan.json");
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), approved);
  const plan = JSON.parse(bytes), rows = plan.cloudEvidence?.recoveryArtifacts;
  assert.equal(plan.candidateCommit, "@checked-out-head");
  assert.equal(plan.sourcePins?.["backend/tests/playwright/acceptance/native-continuation-plan.json"], "@approved-plan");
  assert(Array.isArray(rows) && rows.length === 5);
  const matches = rows.filter(row => row.prefix === prefix);
  assert.equal(matches.length, 1);
  const [job, maximum] = fixed[prefix], row = matches[0];
  assert.equal(row.job, job); assert.equal(row.key, ""); assert.equal(row.maxBytes, maximum);
  const record = JSON.parse(read(recordPath));
  assert.equal(record.schemaVersion, 1); assert.equal(record.repository, "thegitsss/lets-para3");
  assert.equal(record.repository, env.GITHUB_REPOSITORY); assert.equal(record.headSha, env.GITHUB_SHA);
  assert.equal(record.runId, env.GITHUB_RUN_ID); assert.equal(record.attempt, env.GITHUB_RUN_ATTEMPT);
  assert.equal(record.artifact?.job, job); assert.equal(record.artifact?.key, "");
  assert.equal(record.artifact?.name, prefix + "-" + env.GITHUB_RUN_ID + "-" + env.GITHUB_RUN_ATTEMPT);
  assert.equal(record.completeEvidence, true); assert.equal(record.retentionDays, 1); assert.equal(record.compressionLevel, 9);
  assert(Number.isSafeInteger(record.upperBoundBytes) && record.upperBoundBytes > 0 && record.upperBoundBytes <= maximum);
  return { profile: "recovery-return", maximum, upperBoundBytes: record.upperBoundBytes };
}

function recoveryArtifactGuardCommand(prefix, recordName) {
  const source = fs.readFileSync(__filename, "utf8");
  const begin = source.indexOf("\nfunction verifyRecoveryArtifactAllocation("), end = source.indexOf("\nfunction recoveryArtifactGuardCommand(", begin + 1);
  if (begin < 0 || end <= begin) fail("Exact recovery allocation guard source is missing.");
  const body = source.slice(begin + 1, end).trimEnd();
  return "node - <<'JS'\n" + body + "\nverifyRecoveryArtifactAllocation(" + JSON.stringify(prefix) + ", require(\"node:path\").join(process.env.RUNNER_TEMP, " + JSON.stringify(recordName) + "));\nJS\n";
}

function validateArtifactBudgets(workflow) {
  const { catalog } = require("./guard-ci-artifact-budget");
  const expected=catalog("1","1"),actual=[];
  for(const [jobName,job] of Object.entries(workflow.jobs||{})) {
    const matrix=job.strategy?.matrix;
    const contexts=matrix?.include || (matrix?.shard ? matrix.shard.map(shard=>({shard})) : matrix?.group ? matrix.group.map(group=>({group})) : [{}]);
    for(const context of contexts) {
      const expand=value=>String(value).replace(/\$\{\{ github.run_id \}\}/g,"1").replace(/\$\{\{ github.run_attempt \}\}/g,"1").replace(/\$\{\{ matrix\.(scope|group|shard) \}\}/g,(_,key)=>context[key]);
      for(const [index,step] of (job.steps||[]).entries()) {
        if(!String(step.uses||"").startsWith("actions/upload-artifact@")) continue;
        const key=String(context.scope||context.group||context.shard||""), name=expand(step.with?.name),input=expand(step.with?.path);
        const row=expected.find(r=>r.job===jobName&&r.key===key&&r.name===name&&r.path===input);
        if(!row) fail("Unbudgeted artifact or narrowed complete evidence path.");
        const guard=job.steps[index-1];
        const ordinal=/^evidence_limit_(\d+)$/.exec(guard?.id||"")?.[1];
        let guardCommand=`node scripts/guard-ci-artifact-budget.js --job "${jobName}" --key "${key}" --artifact "${name}" --path "${input}" --record "\${{ runner.temp }}/lpc-artifact-${jobName}-${key}-${ordinal}.json"`;
        const recoveryPrefix = jobName === "secrets" ? "secret-scan-evidence" : jobName === "runtime-checks" && ordinal === "2" ? "candidate-identity" : null;
        if (recoveryPrefix) guardCommand += "\n" + recoveryArtifactGuardCommand(recoveryPrefix, `lpc-artifact-${jobName}-${key}-${ordinal}.json`);
        if(!ordinal || guard.if!=="always()" || expand(guard.run||"")!==guardCommand || step.if!==`\${{ always() && steps.${guard.id}.outcome == 'success' }}`) fail("Artifact upload requires its immediately preceding exact always() finite budget guard.");
        if(step.with?.["retention-days"]!==1||step.with?.["compression-level"]!==9||step.with?.["if-no-files-found"]!=="error"||step.with?.["include-hidden-files"]!==true||step.with?.archive===false||step.with?.overwrite===true) fail("Complete artifact evidence requires one day, compression9, mandatory files, unchanged ZIP and no overwrite.");
        actual.push(row.name);
      }
    }
  }
  if(JSON.stringify(actual.sort())!==JSON.stringify(expected.map(r=>r.name).sort())) fail("Finite84 artifact inventory must be complete and unique.");
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

function validateReviewedBrowserFixtureAmendments(catalog) {
  if (catalog.reviewedCatalogSourceReady !== true) fail("Reviewed current browser catalog source is pending integration; no acceptance claim is allowed.");
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const additions = { baselineCritical: 5939, baselineOverall: 6245, additionalIdentities: 6, entries: [
    { source: "tests/playwright/shared-matter/email-message-links.spec.js", identities: 3 },
    { source: "tests/playwright/financial-lifecycle/receipt-passive-journey.spec.js", identities: 3 },
  ] };
  if (!same(catalog.completionRegressionAdditions, additions) || !same(catalog.reviewedFixtureAmendments, REVIEWED_BROWSER_FIXTURE_AMENDMENTS) ||
      catalog.additionalAffectedIdentities !== 111 || catalog.currentDeclaredCriticalIdentities !== 5954 || catalog.expectedUniqueCriticalIdentities !== 5945 || catalog.expectedOverallUniqueIdentities !== 6251 || catalog.selectionAuthority !== 'Original package-declared critical catalog preserved with exact reviewed current fixture applicability and six targeted regression identities; behavioral requirements remain required.') fail("Complete versioned browser groups require the exact reviewed six-identity addition.");
  for (const required of ["tests/playwright/financial-lifecycle/admission-journey.spec.js", "tests/playwright/financial-lifecycle/receipt-passive-journey.spec.js"])
    if (!REVIEWED_BROWSER_FIXTURE_AMENDMENTS.some(row => row.path === required)) fail(`Exact reviewed current receipt/admission source is missing: ${required}`);
  for (const row of REVIEWED_BROWSER_FIXTURE_AMENDMENTS) {
    if (!/^tests\/playwright\/[A-Za-z0-9_./-]+\.spec\.js$/.test(row.path) || !/^[a-f0-9]{64}$/.test(row.currentSha256) ||
        !/^[a-f0-9]{64}$/.test(row.handoffSha256) || typeof row.disposition !== "string" || row.disposition.length < 40 ||
        require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(repositoryRoot, "backend", row.path))).digest("hex") !== row.currentSha256)
      fail(`Exact reviewed current fixture source/pin/handoff/applicability is required: ${row.path}`);
  }
  const changedGroupNames = new Set();
  for (const group of catalog.groups || []) {
    const expected = REVIEWED_BROWSER_FIXTURE_AMENDMENTS.filter(row => group.files?.includes(row.path));
    if (expected.length) {
      if (group.originalAssertionBodiesUnchanged !== false || group.behavioralRequirementsPreserved !== true || !same(group.reviewedChangedSpecs, expected))
        fail(`Exact reviewed fixture-body change and preserved behavioral requirements are required: ${group.name}`);
      changedGroupNames.add(group.name);
    } else if (group.originalAssertionBodiesUnchanged !== true || group.reviewedChangedSpecs || group.behavioralRequirementsPreserved)
      fail(`Unchanged fixture groups retain the original strict contract: ${group.name}`);
  }
  const baseline = JSON.parse(JSON.stringify(catalog));
  delete baseline.reviewedCatalogSourceReady; delete baseline.completionRegressionAdditions; delete baseline.reviewedFixtureAmendments;
  baseline.selectionAuthority = "Package-declared15critical scopes plus accepted permanent affected regression files; no test/assertion changes.";
  baseline.expectedUniqueCriticalIdentities = 5939; baseline.expectedOverallUniqueIdentities = 6245;
  baseline.additionalAffectedIdentities = 105; baseline.currentDeclaredCriticalIdentities = 5948;
  for (const group of baseline.groups || []) {
    if (group.name === "financial-lifecycle") { group.expectedIdentities -= 3; const file = "tests/playwright/financial-lifecycle/receipt-passive-journey.spec.js"; if (group.files.filter(name => name === file).length !== 1) fail("Exactly one reviewed passive-receipt source addition is required."); group.files = group.files.filter(name => name !== file); }
    if (group.name === "shared-matter") group.expectedIdentities -= 3;
    group.originalAssertionBodiesUnchanged = true; delete group.behavioralRequirementsPreserved; delete group.reviewedChangedSpecs;
  }
  if (require("node:crypto").createHash("sha256").update(JSON.stringify(baseline)).digest("hex") !== ORIGINAL_BROWSER_CATALOG_CANONICAL_SHA256)
    fail("Complete versioned browser groups and exact historical catalog must be preserved outside the finite reviewed amendment.");
  return changedGroupNames;
}

function validateGroupedBrowserJobs(jobs, catalog) {
  const reviewedChangedGroups = validateReviewedBrowserFixtureAmendments(catalog);
  if (catalog.schemaVersion !== 1 || catalog.groups?.length !== EXPECTED_GROUP_NAMES.length ||
      JSON.stringify(catalog.groups.map(group => group.name).sort()) !== JSON.stringify([...EXPECTED_GROUP_NAMES].sort()) ||
      catalog.expectedUniqueCriticalIdentities !== 5945 || catalog.expectedOverallUniqueIdentities !== 6251 ||
      catalog.groups.reduce((sum, group) => sum + group.expectedIdentities, 0) !== 5945) fail("Complete versioned browser groups and exact unique identity totals are required.");
  for (const group of catalog.groups) {
    if (group.workers !== 1 || group.retries !== 0 || (group.originalAssertionBodiesUnchanged !== true && !reviewedChangedGroups.has(group.name)) ||
        (group.name === "director-managed" ? group.baseConfig !== REQUIRED_CRITICAL_CONFIGS["test:playwright:financial-lifecycle"] : REQUIRED_CRITICAL_CONFIGS[group.suite] !== group.baseConfig) || !group.files?.length ||
        group.files.some(file => !/^tests\/playwright\/[A-Za-z0-9_./-]+\.spec\.js$/.test(file)) || !Number.isSafeInteger(group.expectedIdentities) || group.expectedIdentities <= 0) fail(`Invalid full fixture group contract: ${group.name}`);
  }
  const collection = jobs["browser-collection"], checks = jobs["browser-checks"], roles = jobs["browser-role-journeys"], gate = jobs["browser-contracts"];
  if (!collection || !checks || !roles) fail("Browser collection, public/contracts and role matrix jobs are required.");
  requireCommands(collection, ["node scripts/run-critical-browser-group.js --verify-groups"], "browser-collection");
  validateLaunchEvidenceArtifact(collection, { stepName: "Upload browser collection evidence", pathFragment: "backend/test-results/critical-group-verification/verified-union.json" });
  for (const [name, job] of [["browser-collection", collection], ["browser-checks", checks], ["browser-role-journeys", roles]]) {
    validateCompiledBrowserFixtures(job); validateRuntimeBeforeInstall(job, name);
    if (job.if !== BROWSER_EXEC_GUARD || job["continue-on-error"]) fail(`${name} cannot conditionally bypass complete acceptance except the exact explicit backend-only dispatch.`);
    for (const step of job.steps || []) if (step["continue-on-error"]) fail(`${name} cannot suppress a failed step.`);
  }
  for (const job of [checks, roles]) {
    if (job.strategy?.["fail-fast"] !== false || job.strategy?.["max-parallel"] !== 8) fail("Browser matrices must finish every group with bounded parallelism and no fail-fast omissions.");
    requireCommands(job, ["npx playwright install --with-deps chromium firefox webkit"], "browser matrix");
    validateLaunchEvidenceArtifact(job, { stepName: "Upload browser launch evidence", pathFragment: "backend/test-results/junit" });
  }
  if (Object.keys(checks.strategy.matrix || {}).join() !== "include" || JSON.stringify(checks.strategy.matrix.include) !== JSON.stringify(EXPECTED_BROWSER_SCOPES) ||
      findStep(checks, "Run complete browser scope")?.run !== "${{ matrix.command }}") fail("Complete deterministic, lifecycle, public accessibility and performance scopes must each execute without narrowing.");
  if (roles.needs !== "browser-collection" || Object.keys(roles.strategy.matrix || {}).join() !== "group" ||
      JSON.stringify([...(roles.strategy.matrix.group || [])].sort()) !== JSON.stringify([...EXPECTED_GROUP_NAMES].sort()) ||
      findStep(roles, "Run complete fixture-compatible role group")?.run !== 'npm run test:playwright:critical:group -- --group "${{ matrix.group }}"') fail("Every approved role fixture group must execute exactly once after collection verification.");
  const dependencies = ["browser-collection", "browser-checks", "browser-role-journeys", "selected-native-return"];
  if (gate.if !== BROWSER_GATE_GUARD || JSON.stringify([...(gate.needs || [])].sort()) !== JSON.stringify([...dependencies].sort()) || gate["continue-on-error"]) fail("Fixed Browser contracts gate must always require all browser jobs and reject failures, cancellations and skips outside the exact backend-only dispatch.");
  const final = findStep(gate, "Require every original browser scope and role group");
  if (gate.steps?.length !== 1 || final?.["continue-on-error"] ||
      JSON.stringify(final?.env) !== JSON.stringify({ COLLECTION_RESULT: "${{ needs.browser-collection.result }}", CHECKS_RESULT: "${{ needs.browser-checks.result }}", ROLES_RESULT: "${{ needs.browser-role-journeys.result }}", SELECTED_RESULT: "${{ needs.selected-native-return.result }}", RECOVERY_SCOPE: "${{ github.event_name == 'workflow_dispatch' && inputs.execution_scope == 'recovery-return' }}" }) ||
      final?.run?.trim() !== BROWSER_AGGREGATE_SCRIPT) fail("Browser aggregate must fail closed unless every complete dependency succeeds.");
  if (final["working-directory"] !== "${{ runner.temp }}") fail("Checkout-free Browser aggregate requires the existing runner temporary directory.");
  return catalog.groups.length;
}

function validateContinuationBinding(jobs) {
  const selected = ["runtime-checks", "backend-tests", "backend-coverage"];
  for (const name of selected) {
    const job = jobs[name];
    if (job?.env?.LPC_JEST_CONTINUATION_PLAN_SHA256 !== CONTINUATION_PLAN_BINDING) fail(`${name} must retain the exact manual backend-source continuation plan binding.`);
    if (name === "backend-tests") {
      if (job.permissions !== undefined || job.env.GH_TOKEN !== undefined) fail("Backend test shards cannot receive artifact tokens or extra permissions.");
    } else if (job.env.GH_TOKEN !== "${{ github.token }}" ||
        JSON.stringify(Object.keys(job.permissions || {}).sort()) !== JSON.stringify(["actions", "contents"]) ||
        job.permissions.actions !== "read" || job.permissions.contents !== "read") {
      fail("Only preparation and union may read prior artifacts, with exact read-only contents/actions permissions.");
    }
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (!selected.includes(name) && (job.env?.LPC_JEST_CONTINUATION_PLAN_SHA256 !== undefined || job.env?.GH_TOKEN !== undefined)) fail("Only preparation, shards and union may receive the backend continuation binding.");
  }
}

function validateGroupedBackendJobs(jobs) {
  const checks = jobs["runtime-checks"], shards = jobs["backend-tests"], union = jobs["backend-coverage"], gate = jobs.validate;
  if (!checks || !shards || !union) fail("Runtime checks, disjoint complete backend shards and raw coverage union are required.");
  for (const [name, job] of [["runtime-checks", checks], ["backend-tests", shards], ["backend-coverage", union]]) {
    if (job["continue-on-error"] || job.if !== (name === "runtime-checks" ? DEFAULT_SCOPE_GUARD : name === "backend-coverage" ? BACKEND_UNION_GUARD : BACKEND_EXEC_GUARD) || job.steps?.some(step => step["continue-on-error"])) fail(`${name} cannot suppress or skip complete backend acceptance outside the exact source-bound return.`);
    validateRuntimeBeforeInstall(job, name);validateCandidateBeforeInstall(job);
  }
  requireCommands(checks, ["npm ci", ...REQUIRED_VALIDATE_COMMANDS, "node scripts/verify-ci-jest-shards.js --prepare"], "runtime-checks");
  validateLaunchEvidenceArtifact(checks, { stepName: "Upload supply-chain launch evidence", pathFragment: "backend/test-results/supply-chain" });
  validateLaunchEvidenceArtifact(checks, { stepName: "Upload candidate identity evidence", pathFragment: "backend/test-results/release/candidate.json" });
  validateLaunchEvidenceArtifact(checks, { stepName: "Upload complete Jest shard plan", pathFragment: "backend/test-results/jest/plan.json" });
  const prepare = findStep(checks, "Bind and balance complete original Jest file shards"), publish = findStep(checks, "Upload complete Jest shard plan");
  if (prepare?.run !== "node scripts/verify-ci-jest-shards.js --prepare" || prepare.if || checks.steps.indexOf(prepare) >= checks.steps.indexOf(publish)) fail("Bind source before publishing the exact complete original shard plan.");
  if (shards.needs !== "runtime-checks" || shards.strategy?.["fail-fast"] !== false || shards.strategy?.["max-parallel"] !== 8 || Object.keys(shards.strategy?.matrix || {}).join() !== "shard" || JSON.stringify(shards.strategy.matrix.shard) !== JSON.stringify([1,2,3,4,5,6,7,8])) fail("Every disjoint complete Jest file shard must run once with bounded independent parallelism and no fail-fast omissions.");
  if (shards["timeout-minutes"] !== 45 || checks["timeout-minutes"] !== 45) fail("Original 45-minute backend/source job budgets must remain bounded after splitting.");
  const launch = findStep(shards, "Run every assigned original Jest suite once");
  if (launch?.run !== 'node scripts/run-ci-jest-shard.js --shard "${{ matrix.shard }}"' || launch.if) fail("An exact original serialized shard launcher must emit raw JSON, JUnit and owned lifecycle evidence without narrowing or retries.");
  validateLaunchEvidenceArtifact(shards, { stepName: "Upload complete raw Jest shard evidence", pathFragment: "backend/test-results/jest/shards/shard-${{ matrix.shard }}" });
  if (JSON.stringify([...(union.needs || [])].sort()) !== JSON.stringify(["backend-tests", "runtime-checks"]) || findStep(union, "Verify complete raw union and substantive authentication/payment coverage")?.run !== "node scripts/verify-ci-jest-shards.js --verify") fail("Substantive authentication/payment coverage must verify the complete source-bound raw union after every shard.");
  const download = findStep(union, "Download all original Jest shard evidence");
  if (download?.with?.pattern !== "jest-shard-${{ github.run_id }}-${{ github.run_attempt }}-*" || download.with.path !== "backend/test-results/jest/shard-artifacts" || download.with["merge-multiple"] !== false || download.with["digest-mismatch"] !== "error") fail("Every separate raw shard artifact must be downloaded without overwrites or digest waivers.");
  validateLaunchEvidenceArtifact(union, { stepName: "Upload complete backend union evidence", pathFragment: "backend/test-results/jest/required-coverage.json" });
  const dependencies = ["backend-coverage", "backend-tests", "runtime-checks", "source-bound-recovery-return"];
  if (gate.if !== DEFAULT_GATE_GUARD || JSON.stringify([...(gate.needs || [])].sort()) !== JSON.stringify(dependencies) || gate["continue-on-error"]) fail("Fixed Runtime gate must always require every source, shard and raw coverage dependency outside the exact source-bound return.");
  const final = findStep(gate, "Require source checks and the exact complete backend union");
  if (gate.steps?.length !== 1 || final?.["continue-on-error"] || JSON.stringify(final?.env) !== JSON.stringify({CHECKS_RESULT:"${{ needs.runtime-checks.result }}",SHARDS_RESULT:"${{ needs.backend-tests.result }}",COVERAGE_RESULT:"${{ needs.backend-coverage.result }}",RECOVERY_RESULT:"${{ needs.source-bound-recovery-return.result }}",RECOVERY_SCOPE:"${{ github.event_name == 'workflow_dispatch' && inputs.execution_scope == 'recovery-return' }}"}) || final.run?.trim() !== RUNTIME_AGGREGATE_SCRIPT) fail("Runtime aggregate must fail closed for failed, cancelled or skipped backend evidence.");
  if (final["working-directory"] !== "${{ runner.temp }}") fail("Checkout-free Runtime aggregate requires the existing runner temporary directory.");
  return 8;
}

function validateSourceReturnCalls(jobs) {
  const calls = {
    "source-bound-backend-return": ["./.github/workflows/backend-acceptance-return.yml", SOURCE_RETURN_GUARD],
    "selected-native-return": ["./.github/workflows/native-acceptance-return.yml", NATIVE_RETURN_GUARD],
    "source-bound-recovery-return": ["./.github/workflows/backend-single-file-return.yml", RECOVERY_RETURN_GUARD],
  };
  for (const [name, [file, guard]] of Object.entries(calls)) {
    const job = jobs[name];
    if (!job || job.uses !== file || job.if !== guard ||
        JSON.stringify(job.with) !== JSON.stringify({ bridge_sha256: "${{ inputs.continuation_plan_sha256 }}" }) ||
        JSON.stringify(Object.keys(job.permissions || {}).sort()) !== JSON.stringify(["actions", "contents"]) ||
        job.permissions.contents !== "read" || job.permissions.actions !== "read" ||
        Object.keys(job).some(key => !["name", "if", "uses", "with", "permissions"].includes(key))) {
      fail("Source-bound return calls require only exact local reusable workflows, manual scope, external plan SHA and read-only permissions; no inherited secrets or suppressed result.");
    }
  }
  for (const name of ["deployment-blueprint", "codeql", "secrets"]) {
    if (jobs[name]?.if !== DEFAULT_SCOPE_GUARD) fail(`${name} must preserve default acceptance outside the exact source-bound return.`);
  }
  return new Set(Object.keys(calls));
}


// Exercise the actual selected-native inline guard against the actual tracked
// plan before dispatch. This is CI source validation, never a product callback.
function validateNativeEvidenceBudget(plan) {
  const nativePath = path.join(repositoryRoot, ".github/workflows/native-acceptance-return.yml");
  const native = parseWorkflow(fs.readFileSync(nativePath, "utf8"), nativePath);
  const command = findStep(native.jobs.selection, "Require reviewed source, selection and finite evidence allocation")?.run || "";
  const begin = command.indexOf("function verifyEvidenceBudget(plan,executionScope){");
  const end = command.indexOf("\nverifyEvidenceBudget(p,", begin);
  if (begin < 0 || end <= begin) fail("Actual native evidence budget verifier is missing.");
  const source = command.slice(begin, end);
  const check = new Function("assert", "plan", source + ";verifyEvidenceBudget(plan,'recovery-return');");
  check(require("node:assert/strict"), plan);
}

function validateWorkflowContract(workflow, manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "backend/package.json"), "utf8")), catalog = browserCatalog()) {
  const triggers = workflow.on || {};
  if (!Object.prototype.hasOwnProperty.call(triggers, "pull_request")) fail("pull_request validation is required.");
  if (!Object.prototype.hasOwnProperty.call(triggers, "push")) fail("main push validation is required.");
  const dispatch = triggers.workflow_dispatch;
  const input = dispatch?.inputs?.execution_scope;
  const continuationInput = dispatch?.inputs?.continuation_plan_sha256;
  if (!dispatch || Object.keys(dispatch).join() !== "inputs" ||
      JSON.stringify(Object.keys(dispatch.inputs || {}).sort()) !== JSON.stringify(["continuation_plan_sha256", "execution_scope"]) ||
      !continuationInput || continuationInput.type !== "string" || continuationInput.required !== false || continuationInput.default !== "" ||
      typeof continuationInput.description !== "string" || !continuationInput.description ||
      Object.keys(continuationInput).some(key => !["type", "required", "default", "description"].includes(key)) ||
      !input || input.type !== "choice" || input.required !== true || input.default !== "full" ||
      JSON.stringify(input.options) !== JSON.stringify(["full", "backend-source", "source-return", "recovery-return"]) ||
      typeof input.description !== "string" || !input.description ||
      Object.keys(input).some(key => !["type", "required", "default", "options", "description"].includes(key))) {
    fail("Only explicit manual backend-source, source-return or recovery-return dispatch may select source-bound evidence; full is required by default.");
  }

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
  const sourceReturnCalls = validateSourceReturnCalls(jobs);
  validateContinuationBinding(jobs);
  for (const jobName of REQUIRED_JOBS) {
    if (!jobs[jobName]) fail(`Required job ${jobName} is missing.`);
    if (jobs[jobName].name !== REQUIRED_GATE_NAMES[jobName]) fail(`Required named gate context changed: ${jobName}.`);
  }
  for (const [jobName, job] of Object.entries(jobs)) {
    if (sourceReturnCalls.has(jobName)) continue;
    if (job["runs-on"] !== "ubuntu-24.04") fail(`${jobName} must use the pinned ubuntu-24.04 runner.`);
    const timeout = Number(job["timeout-minutes"]);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) {
      fail(`${jobName} must have a bounded timeout no greater than 60 minutes.`);
    }
  }

  validatePinnedActions(workflow);
  requireCommands(jobs["deployment-blueprint"], ["npm ci", "npm run check:deploy"], "deployment-blueprint");
  const backendShards = validateGroupedBackendJobs(jobs);
  const browserGroups = validateGroupedBrowserJobs(jobs, catalog);
  const { focusedFiles } = require("./verify-ci-jest-coverage");
  focusedFiles(manifest, "test:auth");focusedFiles(manifest, "test:payments");
  const criticalBrowserCommands = validateCriticalBrowserScripts(manifest);
  validateRuntimeBeforeInstall(jobs["deployment-blueprint"], "deployment-blueprint");

  validateNativeEvidenceBudget(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "backend/tests/playwright/acceptance/native-continuation-plan.json"), "utf8")));

  const dependencyReview = jobs["dependency-review"];
  if (dependencyReview.if !== "github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.execution_scope == 'recovery-return')") {
    fail("Dependency review must run only for pull requests or the exact recovery-return acceptance.");
  }
  if (dependencyReview.permissions?.contents !== "read" || dependencyReview.permissions?.["pull-requests"] !== "read") {
    fail("Dependency review permissions must remain read-only.");
  }
  const dependencyStep = findStep(dependencyReview, "Reject vulnerable dependency changes");
  if (dependencyStep?.with?.["base-ref"] !== "${{ github.event_name == 'workflow_dispatch' && '501cee87480df00ce5a1afe1d0488a4fed34d5d5' || '' }}" || dependencyStep?.with?.["head-ref"] !== "${{ github.event_name == 'workflow_dispatch' && github.sha || '' }}") {
    fail("Manual dependency review requires the reviewed immutable main base and exact current head; PR defaults stay unchanged.");
  }
  if (["warn-only", "vulnerability-check", "license-check"].some(key => dependencyStep?.with?.[key] !== undefined)) {
    fail("Dependency review must preserve default blocking vulnerability and license checks.");
  }
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
  if(secretStep.env?.GITLEAKS_ENABLE_UPLOAD_ARTIFACT!=="false" || secretStep.env?.GITLEAKS_ENABLE_COMMENTS!=="false" || secretStep["continue-on-error"] || secretJob["continue-on-error"]) fail("Secret scan must preserve failures and replace only its implicit upload/comments with bounded SARIF evidence.");
  if(secretJob.steps.find(s=>s.name==="Use pinned Node runtime")?.with?.["node-version-file"]!==".node-version" || secretJob.steps.find(s=>s.name==="Verify pinned Node and npm runtimes")?.run!=="node scripts/verify-runtime.js") fail("Secret SARIF budget guard must use the pinned runtime.");

  validateArtifactBudgets(workflow);
  return {
    jobs: REQUIRED_JOBS.length,
    validateCommands: REQUIRED_VALIDATE_COMMANDS.length,
    browserCommands: REQUIRED_BROWSER_COMMANDS.length,
    criticalBrowserCommands,
    browserGroups,
    backendShards,
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
  validateNativeEvidenceBudget,
  validateCriticalBrowserScripts,
  validateGroupedBrowserJobs,
  validateReviewedBrowserFixtureAmendments,
  validateGroupedBackendJobs,
  validateArtifactBudgets,
  verifyRecoveryArtifactAllocation,
  recoveryArtifactGuardCommand,
};
