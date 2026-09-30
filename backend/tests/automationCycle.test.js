const { isFullCycle, runAutomationCycle } = require("../scripts/run-automation-cycle");

function dependencies(overrides = {}) {
  return {
    readMaintenanceMode: jest.fn().mockResolvedValue(false),
    processAutoModeActions: jest.fn().mockResolvedValue({ executedCount: 0, attemptedCount: 0, failedCount: 0 }),
    autoImportDirectorMail: jest.fn().mockResolvedValue({ failed: 0, scannedDirectors: 0 }),
    purgeExpiredCases: jest.fn().mockResolvedValue(undefined),
    processMatterStorageRetirements: jest.fn(async () => ({ deleted: 0 })),
    processPersonalStorageDeletionTasks: jest.fn().mockResolvedValue({ deleted: 0, retried: 0 }),
    processExpiredWithdrawalWindows: jest.fn().mockResolvedValue({ scanned: 0, finalized: 0, failed: 0 }),
    processAdminOverdueDisputes: jest.fn().mockResolvedValue({ scanned: 0, notified: 0, failed: 0 }),
    generateMonitoringReport: jest.fn().mockResolvedValue({ ok: true }),
    runTimedTriggers: jest.fn().mockResolvedValue({ processed: 0 }),
    refreshJrCmoLibrary: jest.fn().mockResolvedValue({ refreshed: true }),
    cleanupJrCmoLibrary: jest.fn().mockResolvedValue({ deleted: 0 }),
    runScheduledCycleCreation: jest.fn().mockResolvedValue({ created: false, reason: "not_due" }),
    processAutomaticDirectorFollowUps: jest.fn().mockResolvedValue({ sent: 0 }),
    prepareFounderDailyLogIfDue: jest.fn().mockResolvedValue({ prepared: false }),
    ...overrides,
  };
}

describe("scheduled automation cycle", () => {
  test("runs mailbox import every five minutes and the full set every ten minutes", async () => {
    const lightDeps = dependencies();
    const light = await runAutomationCycle({
      now: new Date("2026-08-13T12:05:00.000Z"),
      dependencies: lightDeps,
    });
    expect(light.ok).toBe(true);
    expect(light.fullCycle).toBe(false);
    expect(lightDeps.autoImportDirectorMail).toHaveBeenCalledTimes(1);
    expect(lightDeps.purgeExpiredCases).toHaveBeenCalledTimes(1);
    expect(lightDeps.processPersonalStorageDeletionTasks).toHaveBeenCalledTimes(1);
    expect(lightDeps.processMatterStorageRetirements).toHaveBeenCalledTimes(1);
    expect(lightDeps.processExpiredWithdrawalWindows).toHaveBeenCalledWith({
      now: new Date("2026-08-13T12:05:00.000Z"),
    });
    expect(lightDeps.processAdminOverdueDisputes).toHaveBeenCalledWith({
      now: new Date("2026-08-13T12:05:00.000Z"),
    });
    expect(lightDeps.generateMonitoringReport).not.toHaveBeenCalled();
    expect(lightDeps.processAutoModeActions).not.toHaveBeenCalled();

    const fullDeps = dependencies();
    const full = await runAutomationCycle({
      now: new Date("2026-08-13T12:10:00.000Z"),
      dependencies: fullDeps,
    });
    expect(full.ok).toBe(true);
    expect(full.fullCycle).toBe(true);
    expect(fullDeps.autoImportDirectorMail).toHaveBeenCalledTimes(1);
    expect(fullDeps.generateMonitoringReport).toHaveBeenCalledTimes(1);
    expect(fullDeps.processAutoModeActions).toHaveBeenCalledTimes(1);
    expect(fullDeps.processMatterStorageRetirements).toHaveBeenCalledTimes(1);
    expect(fullDeps.prepareFounderDailyLogIfDue).toHaveBeenCalledWith(expect.objectContaining({
      schedulerState: expect.objectContaining({ generatedFromScheduler: true }),
    }));
  });

  test("continues independent tasks and reports a failed cycle", async () => {
    const deps = dependencies({
      runTimedTriggers: jest.fn().mockRejectedValue(new Error("timed trigger failure")),
    });
    const result = await runAutomationCycle({
      now: new Date("2026-08-13T12:20:00.000Z"),
      dependencies: deps,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.objectContaining({ name: "timedTriggers", error: expect.objectContaining({ message: "timed trigger failure" }) }),
    ]);
    expect(deps.prepareFounderDailyLogIfDue).toHaveBeenCalledTimes(1);
  });

  test("performs no scheduled mutations while application maintenance mode is active", async () => {
    const deps = dependencies({
      readMaintenanceMode: jest.fn().mockResolvedValue(true),
    });
    const result = await runAutomationCycle({
      now: new Date("2026-08-13T12:20:00.000Z"),
      dependencies: deps,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      paused: true,
      pauseReason: "maintenance_mode",
      failures: [],
    }));
    for (const [name, dependency] of Object.entries(deps)) {
      expect(dependency).toHaveBeenCalledTimes(name === "readMaintenanceMode" ? 1 : 0);
    }
  });

  test("fails closed without running scheduled mutations when control state is unavailable", async () => {
    const deps = dependencies({
      readMaintenanceMode: jest.fn().mockRejectedValue(
        new Error("mongodb://private-host.example/secret")
      ),
    });
    const result = await runAutomationCycle({
      now: new Date("2026-08-13T12:20:00.000Z"),
      dependencies: deps,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      paused: true,
      pauseReason: "settings_unavailable",
      failures: [expect.objectContaining({
        name: "automationControl",
        error: expect.objectContaining({
          name: "AutomationControlUnavailableError",
          message: "Automation control settings could not be read.",
        }),
      })],
    }));
    expect(JSON.stringify(result)).not.toContain("private-host");
    for (const [name, dependency] of Object.entries(deps)) {
      expect(dependency).toHaveBeenCalledTimes(name === "readMaintenanceMode" ? 1 : 0);
    }
  });

  test("fails the cycle when a withdrawal lifecycle batch reports an item failure", async () => {
    const deps = dependencies({
      processExpiredWithdrawalWindows: jest.fn().mockResolvedValue({ scanned: 1, finalized: 0, failed: 1 }),
    });
    const result = await runAutomationCycle({
      now: new Date("2026-08-13T12:05:00.000Z"),
      dependencies: deps,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      expect.objectContaining({
        name: "expiredWithdrawals",
        error: expect.objectContaining({ message: "1 expired withdrawal finalization(s) failed." }),
      }),
    ]);
    expect(deps.processAdminOverdueDisputes).toHaveBeenCalledTimes(1);
    expect(deps.autoImportDirectorMail).toHaveBeenCalledTimes(1);
  });

  test("uses UTC five-minute slots", () => {
    expect(isFullCycle(new Date("2026-08-13T12:00:00.000Z"))).toBe(true);
    expect(isFullCycle(new Date("2026-08-13T12:05:00.000Z"))).toBe(false);
  });
  test('failed routine approvals remain visible while independent scheduled work continues', async () => {
    const deps = dependencies({ processAutoModeActions: jest.fn(async () => ({ executedCount: 1, attemptedCount: 3, failedCount: 2 })) });
    const result = await runAutomationCycle({ now: new Date('2026-09-29T12:00:00Z'), dependencies: deps });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'governedApprovals' })]));
    expect(deps.prepareFounderDailyLogIfDue).toHaveBeenCalledTimes(1);
  });
});

test("unconfirmed Matter storage work fails the cycle without stopping independent tasks", async () => { const deps = dependencies({ processMatterStorageRetirements: jest.fn(async () => ({ failed: 1 })) }); const result = await runAutomationCycle({ now: new Date("2026-09-08T12:05:00Z"), dependencies: deps }); expect(result.ok).toBe(false); expect(result.failures[0].name).toBe("matterStorageRetirement"); expect(deps.autoImportDirectorMail).toHaveBeenCalledTimes(1); });
