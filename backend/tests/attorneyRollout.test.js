const {
  ATTORNEY_ROLLOUT_CONTRACT_VERSION,
  ATTORNEY_ROLLOUT_STAGES,
  evaluateAttorneyRolloutStageGate,
  evaluateAttorneyManagerRollout,
  parseRolloutPercent,
  publicAttorneyRolloutTelemetry,
  stableAttorneyRolloutBucket,
} = require("../services/support/attorneyRolloutService");

const attorney = {
  _id: "507f1f77bcf86cd799439011",
  email: "rollout-attorney@package9.invalid",
  role: "attorney",
};

describe("attorney Package 9 staged-rollout contract", () => {
  test("defaults existing attorneys to the manager while denying every other role", () => {
    expect(evaluateAttorneyManagerRollout(attorney, {})).toEqual(expect.objectContaining({
      eligible: true,
      reason: "all_attorneys",
      rolloutPercent: 100,
      rolloutStage: "general",
    }));
    for (const role of ["paralegal", "admin", "unknown"]) {
      expect(evaluateAttorneyManagerRollout({ ...attorney, role }, {
        OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "100",
        OPENAI_ATTORNEY_MANAGER_ALLOWLIST: attorney.email,
      })).toEqual(expect.objectContaining({ eligible: false, reason: "role_not_eligible" }));
    }
  });

  test("honors the global and attorney-only kill switches independently", () => {
    expect(evaluateAttorneyManagerRollout(attorney, {
      OPENAI_SUPPORT_MANAGER_ENABLED: "false",
    })).toEqual(expect.objectContaining({ eligible: false, reason: "global_manager_disabled" }));
    expect(evaluateAttorneyManagerRollout(attorney, {
      OPENAI_ATTORNEY_MANAGER_ENABLED: "false",
    })).toEqual(expect.objectContaining({ eligible: false, reason: "attorney_manager_disabled" }));
  });

  test("uses stable percentage buckets and explicit allowlist enrollment", () => {
    const bucket = stableAttorneyRolloutBucket(attorney);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(stableAttorneyRolloutBucket(attorney)).toBe(bucket);
    expect(evaluateAttorneyManagerRollout(attorney, {
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: String(bucket),
    })).toEqual(expect.objectContaining({ eligible: false, reason: "percentage_not_enrolled" }));
    expect(evaluateAttorneyManagerRollout(attorney, {
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: String(Math.min(100, bucket + 1)),
    })).toEqual(expect.objectContaining({ eligible: true }));
    expect(evaluateAttorneyManagerRollout(attorney, {
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "0",
      OPENAI_ATTORNEY_MANAGER_ALLOWLIST: `unrelated,${attorney.email.toUpperCase()}`,
    })).toEqual(expect.objectContaining({ eligible: true, reason: "allowlisted", rolloutStage: "internal" }));
  });

  test("fails closed for invalid percentages and accounts without a stable key", () => {
    for (const value of ["not-a-number", "-1", "101"]) expect(parseRolloutPercent(value)).toBe(0);
    expect(evaluateAttorneyManagerRollout({ role: "attorney" }, {
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "10",
    })).toEqual(expect.objectContaining({ eligible: false, reason: "missing_stable_account_key" }));
  });

  test("publishes only non-identifying rollout telemetry", () => {
    const decision = evaluateAttorneyManagerRollout(attorney, {
      OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "25",
    });
    const telemetry = publicAttorneyRolloutTelemetry(decision);
    expect(telemetry).toEqual(expect.objectContaining({
      rolloutStage: "limited",
      rolloutPercent: 25,
      rolloutBucket: expect.any(Number),
    }));
    expect(JSON.stringify(telemetry)).not.toMatch(/rollout-attorney|507f1f77|email|_id/i);
  });

  test("defines progressive populations and minimum observation durations", () => {
    expect(ATTORNEY_ROLLOUT_STAGES.map((stage) => stage.percent)).toEqual([0, 10, 25, 50, 100]);
    expect(ATTORNEY_ROLLOUT_STAGES.map((stage) => stage.minimumHours)).toEqual([24, 48, 48, 72, 168]);
    expect(ATTORNEY_ROLLOUT_STAGES.map((stage) => stage.minimumManagerMessages)).toEqual([100, 100, 100, 100, 100]);
  });

  test("passes a stage only when duration, sample, telemetry, reliability, owners, and prerequisites agree", () => {
    const report = {
      role: "attorney",
      readOnly: true,
      managerMessageCount: 120,
      gate: { passed: true, status: "passed" },
      operationalMode: { rolloutPercent: 10 },
      rolloutTelemetryMissingCount: 0,
      rolloutStageCounts: { canary: 120 },
      rolloutPercentCounts: { 10: 120 },
      rolloutContractVersionCounts: { [ATTORNEY_ROLLOUT_CONTRACT_VERSION]: 120 },
    };
    expect(evaluateAttorneyRolloutStageGate({
      stageId: "canary",
      stageStartedAt: "2026-07-20T12:00:00.000Z",
      evaluatedAt: "2026-07-22T12:00:00.000Z",
      reliabilityReport: report,
      completedStageIds: ["internal"],
      openIncidentCount: 0,
      curatedAcceptancePassed: true,
      package7Passed: true,
      releaseOwner: "release-owner",
      technicalOwner: "backend-on-call",
    })).toEqual(expect.objectContaining({
      passed: true,
      status: "passed",
      stageId: "canary",
      elapsedHours: 48,
      managerMessageCount: 120,
      errors: [],
    }));
    expect(evaluateAttorneyRolloutStageGate({
      stageId: "canary",
      stageStartedAt: "2026-07-20T12:00:00.000Z",
      evaluatedAt: "2026-07-22T12:00:00.000Z",
      reliabilityReport: report,
      completedStageIds: ["internal"],
      curatedAcceptancePassed: true,
      package7Passed: true,
      releaseOwner: "release-owner",
      technicalOwner: "backend-on-call",
    }).errors).toContain("open_incident_status_not_recorded");
  });

  test("fails closed when any rollout-stage evidence is missing or inconsistent", () => {
    const result = evaluateAttorneyRolloutStageGate({
      stageId: "general",
      stageStartedAt: "2026-07-22T11:00:00.000Z",
      evaluatedAt: "2026-07-22T12:00:00.000Z",
      reliabilityReport: {
        role: "attorney",
        readOnly: true,
        managerMessageCount: 13,
        gate: { passed: false, status: "threshold_breach" },
        operationalMode: { rolloutPercent: 50 },
        rolloutTelemetryMissingCount: 2,
        rolloutStageCounts: { expanded: 11 },
        rolloutPercentCounts: { 50: 11 },
        rolloutContractVersionCounts: {},
      },
      completedStageIds: ["internal"],
      openIncidentCount: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "minimum_observation_duration_not_met",
      "minimum_manager_sample_not_met",
      "reliability_gate_not_passed:threshold_breach",
      "operational_rollout_percent_mismatch",
      "rollout_telemetry_incomplete",
      "rollout_stage_telemetry_mismatch",
      "rollout_percent_telemetry_mismatch",
      "rollout_contract_telemetry_mismatch",
      "prior_stage_not_completed:canary",
      "release_owner_not_recorded",
      "technical_owner_not_recorded",
      "curated_acceptance_not_passed",
      "package7_not_passed",
      "open_rollout_incident",
      "product_owner_confirmation_not_recorded",
    ]));
  });
});
