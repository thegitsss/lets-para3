const { applyPrivateArtifactUmask } = require("./scripts/private-evidence");

applyPrivateArtifactUmask();

module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  setupFiles: ["<rootDir>/tests/setup.js"],
  globalSetup: "<rootDir>/tests/helpers/globalMongoSetup.js",
  globalTeardown: "<rootDir>/tests/helpers/globalMongoTeardown.js",
  // Database suites share one isolated in-memory Mongo process for the run.
  // Serial execution prevents cross-suite database cleanup races.
  maxWorkers: 1,
  testTimeout: 30000,
};
