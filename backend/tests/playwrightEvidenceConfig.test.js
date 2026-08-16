const path = require("path");
const {
  buildPlaywrightReporters,
  isCi,
  normalizePlaywrightColorEnvironment,
} = require("../playwright.reporters");
const {
  AUTH_STATE_DIRECTORY,
  assertStorageStatePath,
} = require("./playwright/auth-state");

describe("Playwright launch-evidence reporters", () => {
  test("keeps local output concise and emits durable JUnit evidence in CI", () => {
    const privateReporter = path.join(
      path.resolve(__dirname, ".."),
      "playwright.private-evidence-reporter.js"
    );
    expect(buildPlaywrightReporters("playwright-accessibility", {})).toEqual([
      ["list"],
      [privateReporter],
    ]);

    const reporters = buildPlaywrightReporters("playwright-accessibility", { CI: "true" });
    expect(reporters).toEqual([
      ["list"],
      [
        "junit",
        expect.objectContaining({
          outputFile: path.join(
            path.resolve(__dirname, ".."),
            "test-results",
            "junit",
            "playwright-accessibility.xml"
          ),
          includeProjectInTestName: true,
          stripANSIControlSequences: true,
        }),
      ],
      [privateReporter],
    ]);
  });

  test("recognizes only explicit CI mode and rejects unsafe suite names", () => {
    expect(isCi({ CI: "true" })).toBe(true);
    expect(isCi({ CI: "1" })).toBe(false);
    expect(isCi({})).toBe(false);
    expect(() => buildPlaywrightReporters("../outside", { CI: "true" })).toThrow(/kebab-case/);
  });

  test("removes the conflicting inherited color preference before spawning workers", () => {
    const env = { NO_COLOR: "1", KEEP_ME: "yes" };
    expect(normalizePlaywrightColorEnvironment(env)).toEqual({ KEEP_ME: "yes" });
  });

  test("uses owner-only, teardown-managed synthetic authentication state", () => {
    const configs = [
      require("../playwright.support.config"),
      require("../playwright.paralegal-support.config"),
      require("../playwright.director.config"),
      require("../playwright.control-room.config"),
    ];
    for (const config of configs) {
      expect(config.globalTeardown).toBe(
        path.join(path.resolve(__dirname, ".."), "tests/playwright/global.teardown.js")
      );
      const storageState = assertStorageStatePath(config.use.storageState);
      expect(path.dirname(storageState)).toBe(AUTH_STATE_DIRECTORY);
    }
    expect(() => assertStorageStatePath(path.join(AUTH_STATE_DIRECTORY, "../outside.json"))).toThrow(
      /approved synthetic-auth path/
    );
  });
});
