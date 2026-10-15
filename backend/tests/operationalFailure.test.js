const mockWarn = jest.fn();
jest.mock("../utils/logger", () => ({ createLogger: () => ({ warn: mockWarn }) }));
const { reportOperationalFailure } = require("../utils/operationalFailure");

beforeEach(() => mockWarn.mockReset());

test("reports the operation and bounded error classification without private error content", () => {
  const error = Object.assign(new Error("Private synthetic Matter text and provider credentials"), {
    name: "MongoServerError", code: 112, keyValue: { email: "private@example.test" },
  });
  expect(reportOperationalFailure("funding.transaction_abort")(error)).toEqual({ reported: true });
  expect(mockWarn).toHaveBeenCalledWith("Operational failure", {
    operation: "funding.transaction_abort", errorType: "MongoServerError", errorCode: 112,
  });
  expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/Private|credentials|keyValue|email|example\.test|stack/);
});

test("does not copy arbitrary names or string error codes into operational logs", () => {
  reportOperationalFailure("uploads.recovery_marker")({ name: "Private matter title", code: "sensitive-provider-reference" });
  expect(mockWarn).toHaveBeenCalledWith("Operational failure", { operation: "uploads.recovery_marker", errorType: "UnknownError" });
});

test("retains recognized network failure codes", () => {
  reportOperationalFailure("support.routing_lease")({ name: "Error", code: "ECONNRESET" });
  expect(mockWarn).toHaveBeenCalledWith("Operational failure", { operation: "support.routing_lease", errorType: "Error", errorCode: "ECONNRESET" });
});

test.each([false, true])("a failed rollback cannot replace the original operation error when logging fails=%s", async loggingFails => {
  const primary = new Error("Original synthetic operation failure");
  if (loggingFails) mockWarn.mockImplementation(() => { throw new Error("Synthetic log sink failure"); });
  const work = async () => {
    try { throw primary; }
    catch (error) {
      await Promise.reject(new Error("Synthetic rollback failure")).catch(reportOperationalFailure("funding.transaction_abort"));
      throw error;
    }
  };
  await expect(work()).rejects.toBe(primary);
  expect(mockWarn).toHaveBeenCalledTimes(1);
});

test("a log-sink failure is reported as unrecorded instead of as successful logging", () => {
  mockWarn.mockImplementation(() => { throw new Error("Synthetic log sink failure"); });
  expect(reportOperationalFailure("uploads.recovery_marker")(new Error("Synthetic write failure"))).toEqual({ reported: false });
});
