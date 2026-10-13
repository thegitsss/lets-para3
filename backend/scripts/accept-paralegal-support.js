const { spawnSync } = require("child_process");

const jestBin = require.resolve("jest/bin/jest");
const testFiles = [
  "tests/paralegalSupportDatabaseIntegration.test.js",
  "tests/paralegalSupportManagerAgent.test.js",
  "tests/paralegalResponseUiPolicy.test.js",
  "tests/paralegalRollout.test.js",
  "tests/supportAssistant.test.js",
];
const acceptanceScenarios = [
  "uses synthetic-only fixtures and covers all required lifecycle states",
  "reconciles applied, rejected, and invited records from real collections",
  "queries assigned workspace tasks, files, messages, and attorney state",
  "uses processor mocks and keeps gross, fee, net, release, and bank receipt distinct",
  "prevents inaccessible matters and amounts from crossing paralegal ownership boundaries",
  "runs planning, authorized tools, generation, validation correction, and UI filtering together",
  "runs planning, least-privilege tool execution, generation, validation, UI filtering, and telemetry",
  "never exposes the paralegal manager to attorney or admin roles",
  "honors the paralegal manager kill switch before making a model request",
  "blocks repeated tool execution in the same turn",
  "reuses fresh complete evidence for the same subject without another tool-selection call",
  "retries an invalid answer and shows only the corrected validated response",
  "shows one verified action and removes its duplicate inline link",
  "defaults the paralegal manager off and denies every other role",
  "honors global and paralegal-only kill switches independently",
  "routes an enrolled paralegal through the independent hardened manager pipeline",
  "fails closed for an enrolled paralegal when the hardened manager is unavailable",
];

const result = spawnSync(
  process.execPath,
  [
    jestBin,
    "--runInBand",
    ...testFiles,
    "--testNamePattern",
    acceptanceScenarios.join("|"),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
      OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "100",
      OPENAI_PARALEGAL_LEGACY_FALLBACK: "false",
    },
    stdio: "inherit",
  }
);

if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
