const {
  PARALEGAL_ROLLOUT_CONTRACT_VERSION,
  PARALEGAL_ROLLOUT_STAGES,
  evaluateParalegalManagerRollout,
  evaluateParalegalRolloutStageGate,
  parseParalegalRolloutPercent,
  publicParalegalRolloutTelemetry,
  stableParalegalRolloutBucket,
} = require("../services/support/paralegalRolloutService");

const paralegal = {
  _id: "507f1f77bcf86cd799439021",
  email: "rollout-paralegal@package9.invalid",
  role: "paralegal",
};

describe("paralegal Package 9 staged-rollout contract", () => {
  test("defaults the paralegal manager off and denies every other role", () => {
    expect(evaluateParalegalManagerRollout(paralegal, {})).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: "paralegal_manager_disabled",
        rolloutPercent: 0,
        rolloutStage: "internal",
      })
    );
    for (const role of ["attorney", "admin", "unknown"]) {
      expect(
        evaluateParalegalManagerRollout(
          { ...paralegal, role },
          {
            OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
            OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "100",
            OPENAI_PARALEGAL_MANAGER_ALLOWLIST: paralegal.email,
          }
        )
      ).toEqual(
        expect.objectContaining({ eligible: false, reason: "role_not_eligible" })
      );
    }
  });

  test("honors global and paralegal-only kill switches independently", () => {
    expect(
      evaluateParalegalManagerRollout(paralegal, {
        OPENAI_SUPPORT_MANAGER_ENABLED: "false",
        OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
      })
    ).toEqual(
      expect.objectContaining({ eligible: false, reason: "global_manager_disabled" })
    );
    expect(
      evaluateParalegalManagerRollout(paralegal, {
        OPENAI_PARALEGAL_MANAGER_ENABLED: "false",
        OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "100",
      })
    ).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: "paralegal_manager_disabled",
      })
    );
  });

  test("uses stable paralegal cohorts and exact allowlist enrollment", () => {
    const bucket = stableParalegalRolloutBucket(paralegal);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(stableParalegalRolloutBucket(paralegal)).toBe(bucket);
    expect(
      evaluateParalegalManagerRollout(paralegal, {
        OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
        OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: String(bucket),
      })
    ).toEqual(
      expect.objectContaining({ eligible: false, reason: "percentage_not_enrolled" })
    );
    expect(
      evaluateParalegalManagerRollout(paralegal, {
        OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
        OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: String(Math.min(100, bucket + 1)),
      })
    ).toEqual(expect.objectContaining({ eligible: true }));
    expect(
      evaluateParalegalManagerRollout(paralegal, {
        OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
        OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "0",
        OPENAI_PARALEGAL_MANAGER_ALLOWLIST: `unrelated,${paralegal.email.toUpperCase()}`,
      })
    ).toEqual(
      expect.objectContaining({
        eligible: true,
        reason: "allowlisted",
        rolloutStage: "internal",
      })
    );
  });

  test("fails closed for invalid percentages and missing stable identity", () => {
    for (const value of ["not-a-number", "-1", "101"]) {
      expect(parseParalegalRolloutPercent(value)).toBe(0);
    }
    expect(
      evaluateParalegalManagerRollout(
        { role: "paralegal" },
        {
          OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
          OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "10",
        }
      )
    ).toEqual(
      expect.objectContaining({
        eligible: false,
        reason: "missing_stable_account_key",
      })
    );
  });

  test("publishes privacy-safe rollout telemetry only", () => {
    const decision = evaluateParalegalManagerRollout(paralegal, {
      OPENAI_PARALEGAL_MANAGER_ENABLED: "true",
      OPENAI_PARALEGAL_MANAGER_ROLLOUT_PERCENT: "50",
    });
    const telemetry = publicParalegalRolloutTelemetry(decision);
    expect(telemetry).toEqual(
      expect.objectContaining({
        contractVersion: PARALEGAL_ROLLOUT_CONTRACT_VERSION,
        rolloutStage: "general",
        rolloutPercent: 50,
        rolloutBucket: expect.any(Number),
      })
    );
    expect(JSON.stringify(telemetry)).not.toMatch(
      /rollout-paralegal|507f1f77|email|_id/i
    );
  });

  test("defines Internal, Limited, General, and Full observation stages", () => {
    expect(PARALEGAL_ROLLOUT_STAGES.map((stage) => stage.id)).toEqual([
      "internal",
      "limited",
      "general",
      "full",
    ]);
    expect(PARALEGAL_ROLLOUT_STAGES.map((stage) => stage.percent)).toEqual([
      0, 10, 50, 100,
    ]);
    expect(PARALEGAL_ROLLOUT_STAGES.map((stage) => stage.minimumHours)).toEqual([
      24, 48, 72, 168,
    ]);
    expect(
      PARALEGAL_ROLLOUT_STAGES.map((stage) => stage.minimumManagerMessages)
    ).toEqual([100, 100, 100, 100]);
  });

  test("passes only when stage duration, telemetry, reliability, ownership, and prerequisites agree", () => {
    const report = {
      role: "paralegal",
      readOnly: true,
      managerMessageCount: 120,
      gate: { passed: true, status: "passed" },
      operationalMode: { rolloutPercent: 10 },
      rolloutTelemetryMissingCount: 0,
      rolloutStageCounts: { limited: 120 },
      rolloutPercentCounts: { 10: 120 },
      rolloutContractVersionCounts: {
        [PARALEGAL_ROLLOUT_CONTRACT_VERSION]: 120,
      },
    };
    expect(
      evaluateParalegalRolloutStageGate({
        stageId: "limited",
        stageStartedAt: "2026-07-21T12:00:00.000Z",
        evaluatedAt: "2026-07-23T12:00:00.000Z",
        reliabilityReport: report,
        completedStageIds: ["internal"],
        openIncidentCount: 0,
        curatedAcceptancePassed: true,
        package7Passed: true,
        releaseOwner: "release-owner",
        technicalOwner: "backend-on-call",
      })
    ).toEqual(
      expect.objectContaining({
        passed: true,
        status: "passed",
        stageId: "limited",
        elapsedHours: 48,
        managerMessageCount: 120,
        errors: [],
      })
    );
  });

  test("fails closed when any Full-stage evidence is missing or inconsistent", () => {
    const result = evaluateParalegalRolloutStageGate({
      stageId: "full",
      stageStartedAt: "2026-07-23T11:00:00.000Z",
      evaluatedAt: "2026-07-23T12:00:00.000Z",
      reliabilityReport: {
        role: "paralegal",
        readOnly: true,
        managerMessageCount: 13,
        gate: { passed: false, status: "threshold_breach" },
        operationalMode: { rolloutPercent: 50 },
        rolloutTelemetryMissingCount: 2,
        rolloutStageCounts: { general: 11 },
        rolloutPercentCounts: { 50: 11 },
        rolloutContractVersionCounts: {},
      },
      completedStageIds: ["internal"],
      openIncidentCount: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "minimum_observation_duration_not_met",
        "minimum_manager_sample_not_met",
        "reliability_gate_not_passed:threshold_breach",
        "operational_rollout_percent_mismatch",
        "rollout_telemetry_incomplete",
        "rollout_stage_telemetry_mismatch",
        "rollout_percent_telemetry_mismatch",
        "rollout_contract_telemetry_mismatch",
        "prior_stage_not_completed:limited",
        "prior_stage_not_completed:general",
        "release_owner_not_recorded",
        "technical_owner_not_recorded",
        "curated_acceptance_not_passed",
        "package7_not_passed",
        "open_rollout_incident",
        "product_owner_confirmation_not_recorded",
      ])
    );
  });
});
