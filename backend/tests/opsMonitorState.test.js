const mongoose = require("mongoose");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const OpsMonitorState = require("../models/OpsMonitorState");
const StorageDeletionTask = require("../models/StorageDeletionTask");
const AppSettings = require("../models/AppSettings");
const Case = require("../models/Case");
const {
  buildFingerprint,
  checkBackupFreshness,
  checkFinancialExceptionQueue,
  checkMaintenanceMode,
  checkPersonalStorageDeletionQueue,
  loadPreviousState,
  persistState,
  summarizeMonitorForOutput,
} = require("../scripts/ops-monitor");

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
});

describe("operations monitor state", () => {
  test("persists only the deduplication state in MongoDB", async () => {
    const checkedAt = "2026-08-13T12:00:00.000Z";
    await persistState({ ok: false, fingerprint: "payment:stale", checkedAt, checks: [{ secret: "not stored" }] });

    const stored = await OpsMonitorState.findOne({ key: "platform" }).lean();
    expect(stored).toEqual(expect.objectContaining({ ok: false, fingerprint: "payment:stale" }));
    expect(stored).not.toHaveProperty("checks");

    const loaded = await loadPreviousState();
    expect(loaded).toEqual(expect.objectContaining({ ok: false, fingerprint: "payment:stale" }));
  });

  test("creates a stable fingerprint from unique failure types rather than changing counts", () => {
    expect(buildFingerprint([
      { code: "one", message: "First" },
      { code: "two", message: "Second count: 1" },
      { code: "two", message: "Second count: 2" },
    ])).toBe("one|two");
  });

  test("reads maintenance mode without creating settings and reports an active pause", async () => {
    await expect(checkMaintenanceMode()).resolves.toEqual({
      ok: true,
      code: "maintenance_mode_inactive",
      message: "Application maintenance mode is inactive.",
    });
    await expect(AppSettings.countDocuments()).resolves.toBe(0);

    await AppSettings.create({ maintenanceMode: true });
    await expect(checkMaintenanceMode()).resolves.toEqual({
      ok: false,
      code: "maintenance_mode_active",
      message: "Application maintenance mode is active and scheduled mutations are paused.",
    });
  });

  test("keeps record identifiers and local paths out of cron output", () => {
    const output = summarizeMonitorForOutput({
      checkedAt: "2026-08-14T12:00:00.000Z",
      ok: false,
      fingerprint: "financial_exception_attention_required",
      checks: [
        {
          ok: false,
          code: "financial_exception_attention_required",
          message: "One financial exception requires attention.",
          details: [{ caseId: "64b000000000000000000001", transferId: "tr_private" }],
        },
        {
          ok: false,
          code: "backup_last_run_failed",
          message: "Last backup failed.",
          details: { errorCode: "TOOL_FAILED", outPath: "/private/backups/client.archive.gz" },
        },
      ],
      alert: { required: true, delivered: true },
      environment: { isRender: true },
    });

    expect(output.checks[0].details).toEqual({ itemCount: 1 });
    expect(output.checks[1].details).toEqual({ errorCode: "TOOL_FAILED" });
    expect(JSON.stringify(output)).not.toMatch(/64b000|tr_private|client\.archive|outPath/);
  });

  test("alerts on repeatedly failing personal-object deletion without exposing object keys", async () => {
    await StorageDeletionTask.create({
      bucket: "private-bucket",
      key: "paralegal-resumes/64b000000000000000000001/resume-1760000000000.pdf",
      ownerId: "64b000000000000000000001",
      reason: "resume_replaced",
      status: "retrying",
      attempts: 3,
      eligibleAt: new Date("2026-08-14T13:00:00.000Z"),
      lastErrorCode: "ServiceUnavailable",
    });

    const result = await checkPersonalStorageDeletionQueue({
      now: new Date("2026-08-14T12:00:00.000Z"),
    });
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: "personal_storage_deletion_attention_required",
      details: [expect.objectContaining({ attempts: 3, errorCode: "ServiceUnavailable" })],
    }));
    expect(JSON.stringify(result)).not.toContain("paralegal-resumes/");
  });

  test("keeps handled payment, refund, and payout failures visible until resolved", async () => {
    const attorneyId = new mongoose.Types.ObjectId();
    const caseDoc = await Case.create({
      title: "Confidential matter title",
      details: "Confidential matter details",
      status: "in_progress",
      attorney: attorneyId,
      attorneyId,
      totalAmount: 10000,
      paymentStatus: "refund_failed",
      payoutStatus: "failed",
      fundingIntegrityStatus: "failed",
    });

    const result = await checkFinancialExceptionQueue();

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: "financial_exception_attention_required",
      details: [expect.objectContaining({ caseId: String(caseDoc._id), paymentStatus: "refund_failed" })],
    }));
    expect(JSON.stringify(result)).not.toContain("Confidential matter");
  });

  test("accepts a fresh completed Atlas snapshot", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { id: "snapshot-old", status: "completed", createdAt: "2026-08-12T00:00:00.000Z" },
            { id: "snapshot-new", status: "completed", createdAt: "2026-08-13T11:00:00.000Z" },
          ],
        }),
      });
    const result = await checkBackupFreshness({
      env: {
        ATLAS_PROJECT_ID: "0123456789abcdef01234567",
        ATLAS_CLUSTER_NAME: "lpc-production",
        ATLAS_CLIENT_ID: "client-id",
        ATLAS_CLIENT_SECRET: "client-secret",
        ATLAS_CLUSTER_TYPE: "replica_set",
        BACKUP_MAX_AGE_HOURS: "36",
      },
      fetchFn,
      now: Date.parse("2026-08-13T12:00:00.000Z"),
      requireBackup: true,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      code: "atlas_backup_ok",
      details: expect.objectContaining({ snapshotId: "snapshot-new" }),
    }));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("fails closed for stale or incomplete Atlas backup evidence", async () => {
    const incomplete = await checkBackupFreshness({
      env: { ATLAS_PROJECT_ID: "0123456789abcdef01234567" },
      requireBackup: true,
    });
    expect(incomplete).toEqual(expect.objectContaining({ ok: false, code: "atlas_backup_config_incomplete" }));

    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "test-token" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ id: "stale", status: "completed", createdAt: "2026-08-01T00:00:00.000Z" }] }),
      });
    const stale = await checkBackupFreshness({
      env: {
        ATLAS_PROJECT_ID: "0123456789abcdef01234567",
        ATLAS_CLUSTER_NAME: "lpc-production",
        ATLAS_CLIENT_ID: "client-id",
        ATLAS_CLIENT_SECRET: "client-secret",
      },
      fetchFn,
      now: Date.parse("2026-08-13T12:00:00.000Z"),
      requireBackup: true,
    });
    expect(stale).toEqual(expect.objectContaining({ ok: false, code: "atlas_backup_stale" }));
  });
});
