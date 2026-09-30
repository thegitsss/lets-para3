const {
  CASE_STATUS,
  CASE_TRANSITIONS,
  canTransitionCaseStatus,
  evaluateCaseLifecycleInvariants,
  normalizeCaseStatus,
} = require("../utils/caseState");
const Application = require("../models/Application");
const Case = require("../models/Case");

describe("authoritative case lifecycle", () => {
  const attorneyId = "64f000000000000000000001";
  const paralegalId = "64f000000000000000000002";

  function activeCase(overrides = {}) {
    return {
      status: "in progress",
      attorney: attorneyId,
      attorneyId,
      paralegal: paralegalId,
      paralegalId,
      hiredAt: new Date("2026-08-01T12:00:00.000Z"),
      escrowIntentId: "pi_verified",
      escrowStatus: "funded",
      fundingIntegrityStatus: "verified",
      archived: false,
      readOnly: false,
      disputes: [],
      ...overrides,
    };
  }

  test("normalizes legacy vocabulary into the six persisted states", () => {
    expect(CASE_STATUS).toEqual(["open", "in progress", "paused", "completed", "disputed", "closed"]);
    expect(normalizeCaseStatus("assigned")).toBe("open");
    expect(normalizeCaseStatus("in_progress")).toBe("in progress");
    expect(normalizeCaseStatus("active")).toBe("in progress");
    expect(normalizeCaseStatus("cancelled")).toBe("closed");
  });

  test("uses one explicit transition graph", () => {
    expect(CASE_TRANSITIONS.open).toEqual(["in progress", "closed"]);
    expect(CASE_TRANSITIONS.disputed).toEqual(["paused", "closed"]);
    expect(canTransitionCaseStatus("open", "completed")).toBe(false);
    expect(canTransitionCaseStatus("in_progress", "disputed")).toBe(true);
    expect(canTransitionCaseStatus("closed", "open")).toBe(false);
  });

  test("requires party, funding, and integrity evidence for active work", () => {
    const errors = evaluateCaseLifecycleInvariants(activeCase({
      paralegal: null,
      paralegalId: null,
      hiredAt: null,
      escrowIntentId: null,
      escrowStatus: null,
      fundingIntegrityStatus: "pending",
    }));
    expect(errors).toEqual(expect.arrayContaining([
      "active_paralegal_required",
      "hired_at_required",
      "verified_funding_required",
      "funding_integrity_verification_required",
    ]));
  });

  test("requires one open dispute for disputed state and none for closed state", () => {
    expect(evaluateCaseLifecycleInvariants(activeCase({ status: "disputed" })))
      .toContain("open_dispute_required");
    expect(evaluateCaseLifecycleInvariants(activeCase({
      status: "closed",
      disputes: [{ status: "open" }],
    }))).toContain("open_dispute_must_be_resolved");
  });

  test("requires payout and archive evidence for completed state", () => {
    const errors = evaluateCaseLifecycleInvariants(activeCase({ status: "completed" }));
    expect(errors).toEqual(expect.arrayContaining([
      "payment_release_required",
      "payout_reference_required",
      "paid_out_at_required",
      "completed_at_required",
      "archive_required",
      "read_only_required",
    ]));
  });

  test("detects compatibility alias drift", () => {
    const errors = evaluateCaseLifecycleInvariants(activeCase({
      attorneyId: "64f000000000000000000003",
      paralegalId: "64f000000000000000000004",
    }));
    expect(errors).toEqual(expect.arrayContaining([
      "attorney_alias_mismatch",
      "paralegal_alias_mismatch",
    ]));
  });

  test("case model rejects alias drift before persistence", async () => {
    const doc = new Case({
      title: "Alias consistency",
      details: "Compatibility aliases cannot diverge.",
      status: "open",
      attorney: attorneyId,
      attorneyId: "64f000000000000000000003",
    });
    await expect(doc.validate()).rejects.toThrow(/attorney and attorneyId/);
  });

  test("application model bounds copy and deduplicates stars", async () => {
    const star = "64f000000000000000000003";
    const doc = new Application({
      jobId: "64f000000000000000000004",
      paralegalId,
      coverLetter: "  Concise application  ",
      starredBy: [star, star],
    });
    await doc.validate();
    expect(doc.coverLetter).toBe("Concise application");
    expect(doc.starredBy).toHaveLength(1);

    const oversized = new Application({
      jobId: "64f000000000000000000004",
      paralegalId,
      coverLetter: "x".repeat(2001),
    });
    await expect(oversized.validate()).rejects.toThrow(/maximum allowed length/);
  });
});
