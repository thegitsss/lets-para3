const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("weekly session and router source contracts stay wired into backend CI", () => {
  const guard = `import net from 'node:net';
    net.Socket.prototype.connect = function () { throw new Error('Source contract attempted native connect'); };
    net.Server.prototype.listen = function () { throw new Error('Source contract attempted native listen'); };`;
  const output = execFileSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(guard)}`,
    "--test", "--test-concurrency=1", "--test-reporter=tap",
    path.join(__dirname, "attorneyV2WeeklySessionRefresh.test.mjs"),
    path.join(__dirname, "attorneyV2RouterSessionRefresh.test.mjs"),
  ], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: path.dirname(process.execPath),
      NODE_ENV: "test",
      EMAIL_DISABLE: "true",
      TZ: "UTC",
      NODE_OPTIONS: "",
    },
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.match(output, /^# tests 19$/m);
  assert.match(output, /^# pass 19$/m);
  assert.match(output, /^# fail 0$/m);
  assert.match(output, /^# cancelled 0$/m);
  assert.match(output, /^# skipped 0$/m);
}, 30000);
