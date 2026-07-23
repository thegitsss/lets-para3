const { spawnSync } = require("child_process");

const jestBin = require.resolve("jest/bin/jest");
const testFiles = [
  "tests/attorneySupportDatabaseIntegration.test.js",
  "tests/supportManagerAgent.test.js",
  "tests/supportResponseUi.test.js",
  "tests/attorneyRollout.test.js",
];
const acceptanceScenarios = [
  "runs the real manager-to-tool-to-validator path",
  "queries real charges, fee snapshots, payout ledger, receipts, and billing aggregates",
  "uses contract-faithful isolated processor states",
  "enforces ownership so cross-user records cannot affect",
  "persists verified entity state and resolves a pronoun follow-up",
  "turns a tool dependency failure into a truthful concise limitation",
  "allows a concise no-tool boundary response that refuses legal drafting",
  "accepts a direct authoritative explanation of the post-hire workflow",
  "uses verified workflow evidence instead of a generic fallback after hiring",
  "accepts an authoritative, direct answer for general paralegal payout timing",
  "uses verified workflow evidence instead of a generic fallback for payout timing",
  "does not expose the manager to paralegal or admin roles",
  "does not render a manual-review card from a generic availability flag",
  "defaults existing attorneys to the manager while denying every other role",
  "honors the global and attorney-only kill switches independently",
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
      OPENAI_ATTORNEY_MANAGER_ENABLED: "true",
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "100",
      OPENAI_ATTORNEY_LEGACY_FALLBACK: "false",
    },
    stdio: "inherit",
  }
);

if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
