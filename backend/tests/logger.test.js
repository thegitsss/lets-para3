const { createLogger, logPromiseFailure, redactValue, shouldWriteLog } = require("../utils/logger");

describe("structured logger redaction", () => {
  test.each([
    ["Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature", "eyJhbGciOiJIUzI1NiJ9"],
    [`stripe=${["sk", "live", "51SecretValue"].join("_")}`, "sk_live"],
    [`Invalid API Key provided: ${["sk", "test", "*******************ight"].join("_")}`, "sk_test_"],
    [`webhook=${["whsec", "SecretValue"].join("_")}`, "whsec"],
    [["mongodb+srv://lpc", "database-password@cluster.mongodb.net/lpc"].join(":"), "database-password"],
    ["/callback?token=reset-secret&next=%2F", "reset-secret"],
    ["Delivery failed for client@example.com", "client@example.com"],
  ])("removes secrets from strings", (value, secretFragment) => {
    const redacted = redactValue(value);
    expect(redacted).not.toContain(secretFragment);
    expect(redacted).toContain("[REDACTED]");
  });

  test("redacts nested structured credentials without mutating safe context", () => {
    const redacted = redactValue({
      requestId: "request-123",
      credentials: { password: "never-log-me", apiKey: "sk-live-secret" },
    });

    expect(redacted).toEqual({
      requestId: "request-123",
      credentials: { password: "[REDACTED]", apiKey: "[REDACTED]" },
    });
  });

  test("sanitizes error messages and stacks", () => {
    const error = new Error("request failed with token=private-token");
    const redacted = redactValue(error);
    expect(redacted.name).toBe("Error");
    expect(redacted.message).not.toContain("private-token");
    expect(redacted.stack).not.toContain("private-token");
  });

  test("emits redacted JSON records in production", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const output = jest.spyOn(console, "log").mockImplementation(() => {});
    process.env.NODE_ENV = "production";
    try {
      createLogger("payments").info("Delivery accepted.", {
        requestId: "request-123",
        recipient: "client@example.com",
      });
      expect(output).toHaveBeenCalledTimes(1);
      const record = JSON.parse(output.mock.calls[0][0]);
      expect(record).toEqual(expect.objectContaining({
        level: "info",
        scope: "payments",
        message: "Delivery accepted.",
      }));
      expect(record.context[0]).toEqual({
        requestId: "request-123",
        recipient: "[REDACTED]",
      });
      expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      output.mockRestore();
    }
  });

  test("suppresses routine test logs unless diagnostics are explicitly enabled", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTestLogs = process.env.LPC_TEST_LOGS;
    const output = jest.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NODE_ENV = "test";
    delete process.env.LPC_TEST_LOGS;
    try {
      expect(shouldWriteLog()).toBe(false);
      createLogger("payments").warn("Expected negative path.");
      expect(output).not.toHaveBeenCalled();

      process.env.LPC_TEST_LOGS = "true";
      expect(shouldWriteLog()).toBe(true);
      createLogger("payments").warn("Diagnostic token=private-value");
      expect(output).toHaveBeenCalledTimes(1);
      expect(output.mock.calls[0].join(" ")).not.toContain("private-value");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousTestLogs === undefined) delete process.env.LPC_TEST_LOGS;
      else process.env.LPC_TEST_LOGS = previousTestLogs;
      output.mockRestore();
    }
  });

  test("turns a caught secondary promise failure into structured logger context", () => {
    const logger = { error: jest.fn() };
    const error = new Error("cleanup failed");
    logPromiseFailure(logger, "Secondary cleanup failed.", { operation: "rollback" })(error);
    expect(logger.error).toHaveBeenCalledWith("Secondary cleanup failed.", {
      operation: "rollback",
      error,
    });
  });
});
