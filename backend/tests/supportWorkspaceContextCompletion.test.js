const { execFileSync } = require("node:child_process");
const path = require("node:path");

test("both-role Support context contracts run in the normal test suite", () => {
  execFileSync(process.execPath, ["--test", path.join(__dirname, "supportWorkspaceContextCompletion.test.mjs")], {
    stdio: "pipe",
    timeout: 10000,
  });
});
