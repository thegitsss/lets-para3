const mockClaimNextIncidentJob = jest.fn();
const mockRenewIncidentJobLock = jest.fn();
const mockProcessClaimedIncidentJob = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock("../scheduler/incidentScheduler", () => ({
  claimNextIncidentJob: (...args) => mockClaimNextIncidentJob(...args),
  renewIncidentJobLock: (...args) => mockRenewIncidentJobLock(...args),
  processClaimedIncidentJob: (...args) => mockProcessClaimedIncidentJob(...args),
}));

jest.mock("../utils/logger", () => ({
  createLogger: () => mockLogger,
}));

const {
  buildRunnerConfig,
  createRunnerLifecycle,
  createClaimLockHeartbeat,
  buildRunnerCapabilitySummary,
  bindRunnerSignals,
  waitForStopAwareDelay,
  runIncidentRunnerOnce,
  runIncidentRunnerLoop,
} = require("../scripts/incident-runner");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Incident runner", () => {
  test("buildRunnerConfig normalizes long-running runner settings", () => {
    const config = buildRunnerConfig({
      maxJobs: "4",
      pollMs: "3000",
      lockMs: "120000",
      lockRenewMs: "15000",
      heartbeatMs: "90000",
      mongoConnectTimeoutMs: "12000",
      shutdownGraceMs: "180000",
      workerId: "runner:test",
      jobTypes: ["investigation", "verification", "verification"],
    });

    expect(config).toEqual({
      maxJobs: 4,
      pollMs: 3000,
      lockMs: 120000,
      lockRenewMs: 15000,
      heartbeatMs: 90000,
      mongoConnectTimeoutMs: 12000,
      shutdownGraceMs: 180000,
      workerId: "runner:test",
      jobTypes: ["investigation", "verification"],
    });
  });

  test("buildRunnerCapabilitySummary reflects deployment runtime modes", () => {
    process.env.INCIDENT_PREVIEW_DEPLOY_MODE = "webhook";
    process.env.INCIDENT_PRODUCTION_DEPLOY_MODE = "webhook";
    process.env.INCIDENT_ROLLBACK_MODE = "webhook";
    process.env.INCIDENT_FOUNDER_APPROVER_EMAILS = "founder@example.com";

    const summary = buildRunnerCapabilitySummary({
      jobTypes: ["investigation", "deployment"],
    });

    expect(summary).toEqual({
      deploymentEnabled: true,
      previewMode: "webhook",
      productionMode: "webhook",
      rollbackMode: "webhook",
      founderApprovalConfigured: true,
    });
  });

  test("runIncidentRunnerOnce claims work with the runner-specific lock window", async () => {
    mockClaimNextIncidentJob
      .mockResolvedValueOnce({
        incidentId: "inc-1",
        publicId: "INC-1",
        jobType: "investigation",
        lockToken: "lock-1",
        workerId: "runner:test",
      })
      .mockResolvedValueOnce(null);
    mockRenewIncidentJobLock.mockResolvedValue({
      ok: true,
      incidentId: "inc-1",
      publicId: "INC-1",
      jobType: "investigation",
      lockExpiresAt: new Date(),
    });
    mockProcessClaimedIncidentJob.mockResolvedValue({
      ok: true,
      publicId: "INC-1",
      jobType: "investigation",
      state: "investigating",
      nextJobType: "patch_planning",
    });

    const result = await runIncidentRunnerOnce(
      {
        maxJobs: 3,
        workerId: "runner:test",
        jobTypes: ["investigation"],
        lockMs: 900000,
      },
      {
        isDbReady: () => true,
      }
    );

    expect(mockClaimNextIncidentJob).toHaveBeenCalledWith({
      jobTypes: ["investigation"],
      workerId: "runner:test",
      lockMs: 900000,
    });
    expect(mockProcessClaimedIncidentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentId: "inc-1",
        lockToken: "lock-1",
      })
    );
    expect(result.ok).toBe(true);
    expect(result.processed).toBe(1);
  });

  test("createClaimLockHeartbeat renews long-running runner job locks", async () => {
    let scheduledCallback = null;
    mockRenewIncidentJobLock.mockResolvedValue({
      ok: true,
      incidentId: "inc-1",
      publicId: "INC-1",
      jobType: "investigation",
      lockExpiresAt: new Date(),
    });

    const heartbeat = createClaimLockHeartbeat(
      {
        incidentId: "inc-1",
        publicId: "INC-1",
        jobType: "investigation",
        lockToken: "lock-1",
        workerId: "runner:test",
      },
      {
        workerId: "runner:test",
        lockMs: 900000,
        lockRenewMs: 1000,
      },
      {
        renewLock: mockRenewIncidentJobLock,
        logger: mockLogger,
        timerFns: {
          setTimeoutFn: (callback) => {
            scheduledCallback = callback;
            return 42;
          },
          clearTimeoutFn: jest.fn(),
        },
      }
    );

    await scheduledCallback();
    const result = await heartbeat.stop();

    expect(mockRenewIncidentJobLock).toHaveBeenCalledWith({
      incidentId: "inc-1",
      lockToken: "lock-1",
      workerId: "runner:test",
      lockMs: 900000,
    });
    expect(result.lostLock).toBe(false);
    expect(result.renewals).toBe(1);
  });

  test("runIncidentRunnerOnce stops fatally when the runner loses exclusive job ownership", async () => {
    mockClaimNextIncidentJob.mockResolvedValue({
      incidentId: "inc-1",
      publicId: "INC-1",
      jobType: "deployment",
      lockToken: "lock-1",
      workerId: "runner:test",
    });
    mockProcessClaimedIncidentJob.mockResolvedValue({
      ok: true,
      publicId: "INC-1",
      jobType: "deployment",
      state: "post_deploy_verifying",
    });

    const result = await runIncidentRunnerOnce(
      {
        maxJobs: 1,
        workerId: "runner:test",
        jobTypes: ["deployment"],
      },
      {
        isDbReady: () => true,
        startLockHeartbeat: () => ({
          stop: async () => ({
            renewals: 0,
            lostLock: true,
            reason: "lock_lost",
          }),
        }),
      }
    );

    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.reason).toBe("lock_lost");
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: false,
          publicId: "INC-1",
          jobType: "deployment",
        }),
      ])
    );
  });

  test("runIncidentRunnerLoop continues immediately when a full batch is processed and stops cleanly", async () => {
    const lifecycle = createRunnerLifecycle();
    const runBatch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        processed: 2,
        results: [
          { ok: true, jobType: "investigation" },
          { ok: true, jobType: "verification" },
        ],
      })
      .mockImplementationOnce(async () => {
        lifecycle.requestStop("test_complete");
        return {
          ok: true,
          processed: 0,
          results: [],
        };
      });
    const sleep = jest.fn(() => Promise.resolve());

    const result = await runIncidentRunnerLoop(
      {
        maxJobs: 2,
        pollMs: 5000,
        workerId: "runner:test",
      },
      {
        lifecycle,
        runBatch,
        sleep,
        logger: mockLogger,
      }
    );

    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.processedTotal).toBe(2);
    expect(result.stopReason).toBe("test_complete");
  });

  test("runIncidentRunnerLoop emits a low-noise idle heartbeat while healthy", async () => {
    const lifecycle = createRunnerLifecycle();
    const now = jest
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(6000)
      .mockReturnValueOnce(12000)
      .mockReturnValueOnce(12000);
    const runBatch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, processed: 0, results: [] })
      .mockImplementationOnce(async () => {
        lifecycle.requestStop("idle_done");
        return { ok: true, processed: 0, results: [] };
      });
    const sleep = jest.fn(() => Promise.resolve());

    const result = await runIncidentRunnerLoop(
      {
        pollMs: 1000,
        heartbeatMs: 5000,
        workerId: "runner:test",
      },
      {
        lifecycle,
        runBatch,
        sleep,
        logger: mockLogger,
        now,
      }
    );

    expect(result.ok).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "runner:test",
        message: "Incident runner heartbeat: idle and healthy.",
      })
    );
  });

  test("waitForStopAwareDelay resolves early when shutdown is requested", async () => {
    const lifecycle = createRunnerLifecycle();
    const clearTimeoutFn = jest.fn();
    let timeoutCallback = null;

    const promise = waitForStopAwareDelay(5000, lifecycle, {
      setTimeoutFn: (callback) => {
        timeoutCallback = callback;
        return 42;
      },
      clearTimeoutFn,
    });

    lifecycle.requestStop("sigterm");
    await promise;

    expect(timeoutCallback).toBeInstanceOf(Function);
    expect(clearTimeoutFn).toHaveBeenCalledWith(42);
  });

  test("bindRunnerSignals uses the configured worker id and exits after a second signal", () => {
    const lifecycle = createRunnerLifecycle();
    const exitFn = jest.fn();
    const clearTimeoutFn = jest.fn();
    const timers = [];
    const unbind = bindRunnerSignals(lifecycle, {
      logger: mockLogger,
      workerId: "runner:test",
      shutdownGraceMs: 45000,
      setTimeoutFn: (callback, delay) => {
        timers.push({ callback, delay });
        return 77;
      },
      clearTimeoutFn,
      exitFn,
    });

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    unbind();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "runner:test",
        signal: "SIGTERM",
        shutdownGraceMs: 45000,
      })
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "runner:test",
        signal: "SIGTERM",
      })
    );
    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(45000);
    expect(exitFn).toHaveBeenCalledWith(1);
    expect(clearTimeoutFn).toHaveBeenCalledWith(77);
  });
});
