const { EventEmitter } = require("events");
const {
  MUTATION_PIPELINE,
  startRealtimeProjectionBridge,
} = require("../services/realtimeProjectionBridge");

function fakeModels() {
  const streams = {};
  const models = {};
  for (const name of ["Application", "Block", "Case", "CaseFile", "Event", "Job", "Message", "Notification", "User"]) {
    const stream = new EventEmitter();
    stream.close = jest.fn(async () => stream.emit("close"));
    streams[name] = stream;
    models[name] = { watch: jest.fn(() => stream) };
  }
  models.Case.findById = jest.fn((caseId) => ({
    select: jest.fn(() => ({
      lean: jest.fn(async () => ({
        _id: caseId,
        attorneyId: "attorney-1",
        paralegalId: "paralegal-1",
        pendingParalegalId: "paralegal-pending",
        invites: [{ paralegalId: "paralegal-invited" }],
        applicants: [{ paralegalId: "paralegal-applicant" }],
      })),
    })),
  }));
  models.Case.findOne = jest.fn(({ jobId }) => ({
    select: jest.fn(() => ({
      lean: jest.fn(async () => ({
        _id: `case-for-${jobId}`,
        attorneyId: "attorney-1",
        applicants: [{ paralegalId: "paralegal-1" }],
      })),
    })),
  }));
  models.Job.findById = jest.fn((jobId) => ({
    select: jest.fn(() => ({
      lean: jest.fn(async () => ({ _id: jobId, attorneyId: "attorney-1", caseId: "matter-1" })),
    })),
  }));
  return { models, streams };
}

function publisherHarness() {
  const calls = [];
  return {
    calls,
    publishers: {
      publishAllCaseEvents: (...args) => calls.push(["all-cases", ...args]),
      publishAllNotificationEvents: (...args) => calls.push(["all-notifications", ...args]),
      publishCaseEvent: (...args) => calls.push(["case", ...args]),
      publishCaseProjectionRefresh: (...args) => calls.push(["projection", ...args]),
      publishMatterDiscoveryEvent: (...args) => calls.push(["discovery", ...args]),
      publishNotificationEvent: (...args) => calls.push(["notification", ...args]),
    },
  };
}

describe("cross-process realtime projection bridge", () => {
  test("watches persisted projection authorities without changing their records", async () => {
    const { models, streams } = fakeModels();
    const { calls, publishers } = publisherHarness();
    const bridge = startRealtimeProjectionBridge({ models, publishers });

    Object.values(models).forEach((model) => {
      expect(model.watch).toHaveBeenCalledWith(MUTATION_PIPELINE, {
        fullDocument: "updateLookup",
        fullDocumentBeforeChange: "whenAvailable",
      });
    });

    streams.Notification.emit("change", { fullDocument: { _id: "notification-1", userId: "paralegal-1", message: "private" } });
    streams.Message.emit("change", { fullDocument: { _id: "message-1", caseId: "matter-1", text: "confidential" } });
    streams.CaseFile.emit("change", { fullDocument: { _id: "file-1", caseId: "matter-1", storageKey: "private/key" } });
    streams.Event.emit("change", { fullDocument: { _id: "event-1", owner: "paralegal-1", caseId: "matter-1", notes: "private" } });
    streams.Job.emit("change", { fullDocument: { _id: "job-1", attorneyId: "attorney-1", title: "private" } });
    streams.Application.emit("change", {
      fullDocument: { _id: "application-1", jobId: "job-1", paralegalId: "paralegal-1" },
    });
    streams.Block.emit("change", { fullDocument: { blockerId: "attorney-1", blockedId: "paralegal-1", sourceCaseId: "matter-1" } });
    streams.User.emit("change", { fullDocument: { _id: "paralegal-1", email: "private@example.test" } });
    streams.Case.emit("change", { fullDocument: { _id: "matter-1", attorneyId: "attorney-1", paralegalId: "paralegal-1", details: "private" } });

    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toEqual(expect.arrayContaining([
      ["notification", "paralegal-1", "notifications", expect.objectContaining({ type: "notification_record_refresh" })],
      ["case", "matter-1", "messages", expect.objectContaining({ type: "message_record_refresh" })],
      ["case", "matter-1", "documents", expect.objectContaining({ type: "case_file_record_refresh" })],
      ["projection", expect.objectContaining({ _id: "matter-1" }), "message_record_refresh", { caseEvent: "" }],
      ["projection", expect.objectContaining({ _id: "matter-1" }), "case_file_record_refresh", { caseEvent: "" }],
      ["case", "matter-1", "deadlines", expect.objectContaining({ type: "calendar_event_record_refresh" })],
      ["discovery", "matter_discovery_record_refresh"],
      ["notification", "attorney-1", "notifications", expect.objectContaining({ type: "matter_discovery_record_refresh" })],
      ["projection", expect.objectContaining({ _id: "matter-1" }), "application_record_refresh", {
        additionalUserIds: ["paralegal-1", "attorney-1"],
      }],
      ["notification", "attorney-1", "notifications", expect.objectContaining({ type: "authorization_refresh" })],
      ["notification", "paralegal-1", "notifications", expect.objectContaining({ type: "profile_record_refresh" })],
      ["projection", expect.objectContaining({ _id: "matter-1" }), "matter_record_refresh", { discovery: true }],
    ]));
    expect(JSON.stringify(calls)).not.toContain("confidential");
    expect(JSON.stringify(calls)).not.toContain("private/key");
    expect(JSON.stringify(calls)).not.toContain("private@example.test");

    await bridge.stop();
    Object.values(streams).forEach((stream) => expect(stream.close).toHaveBeenCalledTimes(1));
  });

  test("hard deletes invalidate authorized projections even when Mongo pre-images are unavailable", async () => {
    const { models, streams } = fakeModels();
    const { calls, publishers } = publisherHarness();
    const bridge = startRealtimeProjectionBridge({ models, publishers });

    streams.Notification.emit("change", { operationType: "delete", documentKey: { _id: "notification-1" } });
    streams.Message.emit("change", { operationType: "delete", documentKey: { _id: "message-1" } });
    streams.CaseFile.emit("change", { operationType: "delete", documentKey: { _id: "file-1" } });
    streams.Event.emit("change", { operationType: "delete", documentKey: { _id: "event-1" } });
    streams.Job.emit("change", { operationType: "delete", documentKey: { _id: "job-1" } });
    streams.Application.emit("change", { operationType: "delete", documentKey: { _id: "application-1" } });
    streams.Block.emit("change", { operationType: "delete", documentKey: { _id: "block-1" } });
    streams.User.emit("change", { operationType: "delete", documentKey: { _id: "paralegal-1" } });
    streams.Case.emit("change", { operationType: "delete", documentKey: { _id: "matter-1" } });

    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toEqual(expect.arrayContaining([
      ["all-notifications", "notifications", expect.objectContaining({ type: "notification_record_deleted_refresh" })],
      ["all-cases", "messages", expect.objectContaining({ type: "message_record_deleted_refresh" })],
      ["all-cases", "documents", expect.objectContaining({ type: "case_file_record_deleted_refresh" })],
      ["all-cases", "deadlines", expect.objectContaining({ type: "calendar_event_record_deleted_refresh" })],
      ["discovery", "matter_discovery_record_deleted_refresh"],
      ["discovery", "application_record_deleted_refresh"],
      ["discovery", "matter_visibility_refresh"],
      ["notification", "paralegal-1", "notifications", expect.objectContaining({ type: "authorization_refresh" })],
      ["case", "matter-1", "case", expect.objectContaining({ type: "matter_record_deleted_refresh" })],
      ["discovery", "matter_record_deleted_refresh"],
    ]));

    await bridge.stop();
  });

  test("hard deletes use a Mongo pre-image to target the same participants as an update", async () => {
    const { models, streams } = fakeModels();
    const { calls, publishers } = publisherHarness();
    const bridge = startRealtimeProjectionBridge({ models, publishers });

    streams.CaseFile.emit("change", {
      operationType: "delete",
      documentKey: { _id: "file-1" },
      fullDocumentBeforeChange: { _id: "file-1", caseId: "matter-1", storageKey: "private/key" },
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toEqual(expect.arrayContaining([
      ["case", "matter-1", "documents", expect.objectContaining({ type: "case_file_record_refresh" })],
      ["projection", expect.objectContaining({ _id: "matter-1" }), "case_file_record_refresh", { caseEvent: "" }],
    ]));
    expect(calls.some(([kind]) => kind === "all-cases")).toBe(false);
    expect(JSON.stringify(calls)).not.toContain("private/key");

    await bridge.stop();
  });

  test("a failed stream is retried and stopping cancels pending recovery", async () => {
    jest.useFakeTimers();
    try {
      const first = new EventEmitter();
      first.close = jest.fn(async () => {});
      const second = new EventEmitter();
      second.close = jest.fn(async () => {});
      const model = { watch: jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) };
      const logger = { warn: jest.fn() };
      const { publishers } = publisherHarness();
      const bridge = startRealtimeProjectionBridge({
        models: { Message: model },
        publishers,
        logger,
        restartDelayMs: 50,
      });

      first.emit("error", new Error("change streams unavailable"));
      expect(logger.warn).toHaveBeenCalled();
      jest.advanceTimersByTime(50);
      expect(model.watch).toHaveBeenCalledTimes(2);
      await bridge.stop();
      expect(second.close).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a stream close failure is observable without preventing bridge shutdown", async () => {
    const stream = new EventEmitter();
    stream.close = jest.fn(async () => {
      throw new Error("close failed");
    });
    const model = { watch: jest.fn(() => stream) };
    const logger = { warn: jest.fn() };
    const { publishers } = publisherHarness();
    const bridge = startRealtimeProjectionBridge({
      models: { Message: model },
      publishers,
      logger,
    });

    await expect(bridge.stop()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("change stream could not close cleanly"),
      expect.objectContaining({ message: "close failed" })
    );
  });
});
