const path = require("node:path");
const base = require("./playwright.config");
const artifacts = process.env.LPC_NOTIFICATION_BROWSER_ARTIFACTS || path.resolve(__dirname, "../../../test-results/legacy-notifications");
module.exports = { ...base, testMatch: "legacy-notifications.spec.js", reporter: [["list"], ["json", { outputFile: path.join(artifacts, "results.json") }]], outputDir: path.join(artifacts, "test-output") };
