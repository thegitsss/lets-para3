jest.mock("../models/Case", () => ({
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock("../models/Job", () => ({
  findByIdAndUpdate: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock("../models/User", () => ({ findById: jest.fn() }));
jest.mock("../services/caseLifecycle", () => ({
  buildReceiptPdfBuffer: jest.fn().mockResolvedValue(Buffer.from("pdf")),
  uploadPdfToS3: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../utils/notifyUser", () => ({ notifyUser: jest.fn() }));

const fs = require("fs");
const path = require("path");
const Case = require("../models/Case");
const Job = require("../models/Job");
const { notifyUser } = require("../utils/notifyUser");
const {
  finalizeExpiredDisputeWindow,
  processAdminOverdueDisputes,
  processExpiredWithdrawalWindows,
} = require("../services/withdrawalLifecycle");

function queryResult(values) {
  return {
    sort: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        select: jest.fn().mockResolvedValue(values),
      }),
    }),
  };
}

describe("withdrawal lifecycle jobs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Case.updateOne.mockResolvedValue({ modifiedCount: 1 });
    Job.findByIdAndUpdate.mockResolvedValue({ _id: "job-1", status: "open" });
  });

  test("atomically finalizes each eligible withdrawal before running side effects", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const candidate = {
      _id: "case-1",
      title: "Matter",
      status: "paused",
      pausedReason: "paralegal_withdrew",
      disputeDeadlineAt: new Date("2026-08-14T11:00:00.000Z"),
      payoutFinalizedAt: null,
      jobId: "job-1",
      totalAmount: 40_000,
      partialPayoutAmount: 10_000,
      disputes: [],
    };
    const claimed = { ...candidate, payoutFinalizedAt: now, remainingAmount: 30_000 };
    Case.find.mockReturnValue(queryResult([candidate]));
    Case.findOneAndUpdate.mockResolvedValue(claimed);

    await expect(processExpiredWithdrawalWindows({ now, limit: 500 })).resolves.toEqual({
      scanned: 1,
      finalized: 1,
      failed: 0,
    });
    expect(Case.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "case-1", payoutFinalizedAt: null }),
      { $set: expect.objectContaining({
        payoutFinalizedAt: now,
        payoutFinalizedType: "expired_zero",
        remainingAmount: 30_000,
        status: "paused",
      }) },
      { returnDocument: "after", runValidators: true }
    );
    expect(Job.findByIdAndUpdate).toHaveBeenCalledWith("job-1", { status: "open" });
    const limit = Case.find.mock.results[0].value.sort.mock.results[0].value.limit;
    expect(limit).toHaveBeenCalledWith(100);
  });

  test("does not repeat side effects when another runner already claimed the withdrawal", async () => {
    Case.find.mockReturnValue(queryResult([{ _id: "case-1", totalAmount: 40_000 }]));
    Case.findOneAndUpdate.mockResolvedValue(null);
    await expect(processExpiredWithdrawalWindows()).resolves.toEqual({
      scanned: 1,
      finalized: 0,
      failed: 0,
    });
    expect(Job.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test("claims an overdue dispute before notifying each participant", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const candidate = {
      _id: "case-2",
      title: "Disputed matter",
      attorneyId: "attorney-1",
      withdrawnParalegalId: "paralegal-1",
    };
    Case.find.mockReturnValue(queryResult([candidate]));
    Case.findOneAndUpdate.mockResolvedValue(candidate);
    notifyUser.mockResolvedValue(undefined);

    await expect(processAdminOverdueDisputes({ now })).resolves.toEqual({
      scanned: 1,
      notified: 1,
      failed: 0,
    });
    expect(Case.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "case-2", adminDisputeOverdueNotifiedAt: null }),
      { $set: { adminDisputeOverdueNotifiedAt: now } },
      { returnDocument: "after" }
    );
    expect(notifyUser).toHaveBeenCalledTimes(2);
  });

  test("restores an overdue dispute for retry if notification delivery fails", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const candidate = { _id: "case-3", attorneyId: "attorney-1" };
    Case.find.mockReturnValue(queryResult([candidate]));
    Case.findOneAndUpdate.mockResolvedValue(candidate);
    notifyUser.mockRejectedValue(new Error("notification failed"));

    await expect(processAdminOverdueDisputes({ now })).resolves.toEqual({
      scanned: 1,
      notified: 0,
      failed: 1,
    });
    expect(Case.updateOne).toHaveBeenCalledWith(
      { _id: "case-3", adminDisputeOverdueNotifiedAt: now },
      { $set: { adminDisputeOverdueNotifiedAt: null } }
    );
  });

  test("keeps request-time finalization behavior in the shared lifecycle service", async () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const caseDoc = {
      _id: "case-4",
      title: "Matter",
      status: "paused",
      disputeDeadlineAt: new Date("2026-08-14T11:00:00.000Z"),
      payoutFinalizedAt: null,
      totalAmount: 40_000,
      partialPayoutAmount: 10_000,
      jobId: "job-1",
      disputes: [],
      ensureLifecycleStatus: jest.fn(),
    };
    await expect(finalizeExpiredDisputeWindow(caseDoc, { now })).resolves.toBe(true);
    expect(caseDoc).toEqual(expect.objectContaining({
      payoutFinalizedAt: now,
      payoutFinalizedType: "expired_zero",
      remainingAmount: 30_000,
      status: "paused",
    }));
    expect(caseDoc.ensureLifecycleStatus).toHaveBeenCalledWith("paused");
  });

  test("keeps all recurring business work out of the HTTP entrypoint and route modules", () => {
    const backendRoot = path.resolve(__dirname, "..");
    const indexSource = fs.readFileSync(path.join(backendRoot, "index.js"), "utf8");
    const casesSource = fs.readFileSync(path.join(backendRoot, "routes", "cases.js"), "utf8");
    const incidentQueueSource = fs.readFileSync(
      path.join(backendRoot, "scheduler", "incidentScheduler.js"),
      "utf8"
    );
    const automationSource = fs.readFileSync(
      path.join(backendRoot, "scripts", "run-automation-cycle.js"),
      "utf8"
    );
    const packageJson = JSON.parse(fs.readFileSync(path.join(backendRoot, "package.json"), "utf8"));

    expect(indexSource).not.toMatch(/start(?:Purge|Agent|Director|Incident).*Scheduler|startPurgeWorker/);
    expect(casesSource).not.toMatch(/startWithdrawalWorker|WITHDRAWAL_WORKER|withdrawalWorkerStarted/);
    expect(incidentQueueSource).not.toMatch(/setInterval|startIncidentScheduler|INCIDENT_SCHEDULER_ENABLED/);
    expect(automationSource).toMatch(/processExpiredWithdrawalWindows/);
    expect(automationSource).toMatch(/processAdminOverdueDisputes/);
    expect(packageJson.dependencies).not.toHaveProperty("node-cron");
  });
});
