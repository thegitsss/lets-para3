const fs = require("fs");
const path = require("path");
const jestConfig = require("../jest.config");
const {
  STATE_PATH,
  isProcessAlive,
  readReadyState,
} = require("./helpers/mongoHarnessState");
const { testDatabaseName } = require("./helpers/db");

describe("shared Jest Mongo harness", () => {
  test("enforces global lifecycle and serial database isolation", () => {
    expect(jestConfig.globalSetup).toBe("<rootDir>/tests/helpers/globalMongoSetup.js");
    expect(jestConfig.globalTeardown).toBe("<rootDir>/tests/helpers/globalMongoTeardown.js");
    expect(jestConfig.maxWorkers).toBe(1);
    expect(testDatabaseName).toBe("jest");
    const teardownSource = fs.readFileSync(
      path.resolve(__dirname, "helpers/globalMongoTeardown.js"),
      "utf8"
    );
    expect(teardownSource).toMatch(/client\.db\("jest"\)\.dropDatabase/);
    expect(teardownSource).toMatch(/\.command\(\{ shutdown: 1, force: true, timeoutSecs: 1 \}\)/);
    expect(teardownSource).toMatch(/observeProcessExit/);
    expect(teardownSource).toMatch(/mongoInstance\.mongodProcess = undefined/);
    expect(teardownSource).toMatch(/mongoServer\.stop\(\{ doCleanup: true, force: true \}\)/);
    expect(teardownSource).toMatch(/new AggregateError/);
  });

  test("publishes owner-only, live, loopback state", () => {
    const state = readReadyState();
    const stat = fs.lstatSync(STATE_PATH);

    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o077).toBe(0);
    expect(state.status).toBe("ready");
    expect(state.uri).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/);
    expect(isProcessAlive(state.ownerPid)).toBe(true);
  });
});
