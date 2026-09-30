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
const { ensureSavedSupportSession, sessionNeedsSignIn } = require("./playwright/saved-support-session");

describe("Playwright launch-evidence reporters", () => {
  test("signs in again before a saved synthetic session expires within the next test", () => {
    const now = 1_800_000_000_000;
    const state = { cookies: [{ name: "token", expires: (now + 120_000) / 1000 }] };
    expect(sessionNeedsSignIn(state, 150_000, now)).toBe(true);
    expect(sessionNeedsSignIn(state, 90_000, now)).toBe(false);
    expect(sessionNeedsSignIn(state, 90_000, now + 180_000)).toBe(true);
    expect(() => sessionNeedsSignIn({ cookies: [] }, 90_000, now)).toThrow(/expiring token/);
    expect(() => sessionNeedsSignIn({ cookies: [{ name: "token", expires: -1 }] }, 90_000, now)).toThrow(/expiring token/);
  });

  test("preserves explicit account-loss fixtures and refuses remote session renewal", async () => {
    await expect(ensureSavedSupportSession({ storageState: { cookies: [], origins: [] } })).resolves.toBe(false);
    await expect(ensureSavedSupportSession({
      storageState: path.join(AUTH_STATE_DIRECTORY, "support-paralegal.json"),
      baseURL: "https://example.test", minimumRemainingMs: 150_000,
    })).rejects.toThrow(/only on the local synthetic server/);
  });

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

  test("the attorney browser fixture actually encrypts private fields with its configured synthetic key", () => {
    const previousKey = process.env.DATA_ENCRYPTION_KEY;
    const previousBase = process.env.PLAYWRIGHT_BASE_URL;
    try {
      const config = require("./playwright/attorney-v2/playwright.config.js");
      process.env.DATA_ENCRYPTION_KEY = config.webServer.env.DATA_ENCRYPTION_KEY;
      jest.isolateModules(() => {
        const { encryptString, decryptString } = require("../utils/dataEncryption");
        const original = "Synthetic private browser fixture field";
        const encrypted = encryptString(original);
        expect(encrypted).not.toBe(original);
        expect(decryptString(encrypted)).toBe(original);
      });
    } finally {
      if (previousKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
      else process.env.DATA_ENCRYPTION_KEY = previousKey;
      if (previousBase === undefined) delete process.env.PLAYWRIGHT_BASE_URL;
      else process.env.PLAYWRIGHT_BASE_URL = previousBase;
    }
  });
});
