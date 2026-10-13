describe("operations health probe", () => {
  const originalUrl = process.env.OPS_HEALTHCHECK_URL;

  afterAll(() => {
    if (typeof originalUrl === "undefined") delete process.env.OPS_HEALTHCHECK_URL;
    else process.env.OPS_HEALTHCHECK_URL = originalUrl;
  });

  test("uses an abort deadline and never copies the health response body into monitor output", async () => {
    process.env.OPS_HEALTHCHECK_URL = "https://www.lets-paraconnect.com/api/health";
    jest.resetModules();
    const { checkHealth } = require("../scripts/ops-monitor");
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, db: "connected", internal: "do-not-log" }),
    });

    const result = await checkHealth({ fetchFn, timeoutMs: 2500 });

    expect(result).toEqual({
      ok: true,
      code: "health_ok",
      message: "Health check passed.",
      details: { status: 200 },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://www.lets-paraconnect.com/api/health",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      })
    );
    expect(JSON.stringify(result)).not.toContain("do-not-log");
  });

  test("fails when the web service and monitor do not report the same release commit", async () => {
    process.env.OPS_HEALTHCHECK_URL = "https://www.lets-paraconnect.com/api/health";
    jest.resetModules();
    const { checkHealth } = require("../scripts/ops-monitor");
    const expectedReleaseCommit = "a".repeat(40);
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "X-LPC-Release-Commit": "b".repeat(40) }),
      json: async () => ({ ok: true, db: "connected" }),
    });

    await expect(checkHealth({ fetchFn, expectedReleaseCommit })).resolves.toEqual({
      ok: false,
      code: "health_release_mismatch",
      message: "Web health is serving a different or unidentified release commit.",
      details: { status: 200 },
    });
  });

  test("does not treat an ambiguous database health body as healthy", async () => {
    process.env.OPS_HEALTHCHECK_URL = "https://www.lets-paraconnect.com/api/health";
    jest.resetModules();
    const { checkHealth } = require("../scripts/ops-monitor");
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, db: "unknown" }),
    });

    await expect(checkHealth({ fetchFn })).resolves.toEqual({
      ok: false,
      code: "health_failed",
      message: "Health check failed with HTTP 200.",
      details: { status: 200 },
    });
  });

  test("reports maintenance mode as an explicit alertable operating state", async () => {
    const { checkMaintenanceMode } = require("../scripts/ops-monitor");

    await expect(checkMaintenanceMode({
      readMaintenanceModeFn: jest.fn().mockResolvedValue(false),
    })).resolves.toEqual({
      ok: true,
      code: "maintenance_mode_inactive",
      message: "Application maintenance mode is inactive.",
    });

    await expect(checkMaintenanceMode({
      readMaintenanceModeFn: jest.fn().mockResolvedValue(true),
    })).resolves.toEqual({
      ok: false,
      code: "maintenance_mode_active",
      message: "Application maintenance mode is active and scheduled mutations are paused.",
    });
  });

  test("fails the maintenance-mode check without exposing provider error text", async () => {
    const { checkMaintenanceMode } = require("../scripts/ops-monitor");
    const result = await checkMaintenanceMode({
      readMaintenanceModeFn: jest.fn().mockRejectedValue(
        Object.assign(new Error("mongodb://private-host.example/secret"), { code: "ETIMEDOUT" })
      ),
    });

    expect(result).toEqual({
      ok: false,
      code: "maintenance_mode_check_failed",
      message: "Application maintenance-mode state could not be read; scheduled mutations remain fail-closed.",
      details: { errorCode: "ETIMEDOUT" },
    });
    expect(JSON.stringify(result)).not.toContain("private-host");
  });

  test("exits cleanly only for an intentional pause and its expected public 503", () => {
    const {
      isIntentionalMaintenancePause,
      monitorExecutionSucceeded,
    } = require("../scripts/ops-monitor");
    const pause = { ok: false, code: "maintenance_mode_active" };
    const maintenancePage = {
      ok: false,
      code: "health_release_mismatch",
      details: { status: 503 },
    };

    expect(isIntentionalMaintenancePause([pause])).toBe(true);
    expect(isIntentionalMaintenancePause([pause, maintenancePage])).toBe(true);
    expect(monitorExecutionSucceeded({ failures: [pause, maintenancePage] })).toBe(true);
    expect(monitorExecutionSucceeded({ failures: [pause], alertDeliveryFailed: true })).toBe(false);
    expect(monitorExecutionSucceeded({
      failures: [pause, { ok: false, code: "atlas_backup_stale" }],
    })).toBe(false);
    expect(monitorExecutionSucceeded({
      failures: [{ ok: false, code: "health_failed", details: { status: 503 } }],
    })).toBe(false);
  });
});
