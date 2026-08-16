const {
  assertValidHarnessSecret,
  isControlRoomE2eHarnessEnabled,
  readHarnessSecretFromRequest,
} = require("../utils/controlRoomE2eHarnessAccess");
const {
  randomHarnessPassword,
  resolveAdminCredentials,
  resolveSupportAttorneyCredentials,
  resolveSupportParalegalCredentials,
} = require("../services/ai/controlRoomE2eHarnessService");

function staging(overrides = {}) {
  return {
    NODE_ENV: "production",
    APP_ENV: "staging",
    ENABLE_AI_CONTROL_ROOM_E2E_HARNESS: "true",
    AI_CONTROL_ROOM_E2E_HARNESS_SECRET: "staging-harness-secret-at-least-32-characters",
    CONTROL_ROOM_E2E_ADMIN_PASSWORD: "unique staging admin harness passphrase 2026!",
    CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_PASSWORD: "unique staging attorney harness passphrase 2026!",
    CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD: "unique staging paralegal harness passphrase 2026!",
    ...overrides,
  };
}

describe("non-production harness access policy", () => {
  test("keeps the harness impossible to mount in production", () => {
    expect(isControlRoomE2eHarnessEnabled({
      NODE_ENV: "production",
      APP_ENV: "production",
      ENABLE_AI_CONTROL_ROOM_E2E_HARNESS: "true",
    })).toBe(false);
  });

  test("requires a strong staging secret and compares it without query/body fallbacks", () => {
    const env = staging();
    expect(assertValidHarnessSecret(env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET, env)).toBe(true);
    expect(() => assertValidHarnessSecret("wrong", env)).toThrow(/invalid/i);
    expect(() => assertValidHarnessSecret("short", staging({ AI_CONTROL_ROOM_E2E_HARNESS_SECRET: "short" })))
      .toThrow(/at least 32/i);

    expect(readHarnessSecretFromRequest({
      headers: { "x-ai-control-room-e2e-secret": "header-secret" },
      query: { secret: "query-secret" },
      body: { secret: "body-secret" },
    })).toBe("header-secret");
    expect(readHarnessSecretFromRequest({ query: { secret: "query-secret" }, body: { secret: "body-secret" } }))
      .toBe("");
  });

  test("requires explicit strong staging passwords and isolated harness identities", () => {
    const env = staging();
    expect(resolveAdminCredentials(env).password).toBe(env.CONTROL_ROOM_E2E_ADMIN_PASSWORD);
    expect(resolveSupportAttorneyCredentials(env).password).toBe(
      env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_PASSWORD
    );
    expect(resolveSupportParalegalCredentials(env).password).toBe(
      env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD
    );
    expect(() => resolveAdminCredentials(staging({ CONTROL_ROOM_E2E_ADMIN_PASSWORD: "" })))
      .toThrow(/required.*staging/i);
    expect(() => resolveAdminCredentials(staging({ CONTROL_ROOM_E2E_ADMIN_EMAIL: "real-admin@example.com" })))
      .toThrow(/isolated/i);
  });

  test("uses non-deterministic credentials for ephemeral harness users", () => {
    const first = randomHarnessPassword();
    const second = randomHarnessPassword();
    expect(first).toHaveLength(43);
    expect(second).toHaveLength(43);
    expect(first).not.toBe(second);
  });
});
