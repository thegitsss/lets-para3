const {
  classifyIncidentRisk,
  determineAutonomyMode,
  reclassifyRiskUpward,
  shouldRequireApproval,
  canAutoDeploy,
  shouldTriggerRollback,
} = require("../services/incidents/riskEngine");

describe("Incident risk engine", () => {
  test("classifies protected money/auth incidents as high risk", () => {
    const result = classifyIncidentRisk({
      domain: "payments",
      summary: "Stripe payout failed after withdrawal review.",
      riskFlags: { affectsMoney: true },
    });

    expect(result.riskLevel).toBe("high");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["high-risk domain:payments", "risk flag:affectsMoney"])
    );
  });

  test("classifies backend core workflow changes as medium risk when no high-risk signals exist", () => {
    const result = classifyIncidentRisk({
      domain: "messaging",
      summary: "Case messages are not appearing after refresh.",
      confidence: "high",
      touchedFiles: ["backend/routes/messages.js"],
      suspectedRoutes: ["/api/messages/thread/123"],
      clusterIncidentCount: 1,
    });

    expect(result.riskLevel).toBe("medium");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["backend route/service change", "core workflow change"])
    );
  });

  test("classifies isolated low-signal UI incidents as low risk", () => {
    const result = classifyIncidentRisk({
      domain: "ui",
      summary: "Typography spacing is off on the help screen.",
      confidence: "medium",
      touchedFiles: ["frontend/assets/styles/help.css"],
      clusterIncidentCount: 0,
    });

    expect(result.riskLevel).toBe("low");
    expect(result.reasons).toEqual([]);
  });

  test("reclassifies upward but never downward automatically", () => {
    const upgrade = reclassifyRiskUpward("low", {
      domain: "unknown",
      summary: "Profile visibility changed after approval.",
      riskFlags: { affectsProfileVisibility: true },
    });
    expect(upgrade.riskLevel).toBe("high");
    expect(upgrade.upgraded).toBe(true);
    expect(upgrade.autonomyMode).toBe("approval_required");

    const noDowngrade = reclassifyRiskUpward("high", {
      domain: "ui",
      summary: "Spacing issue only.",
      confidence: "high",
    });
    expect(noDowngrade.riskLevel).toBe("high");
    expect(noDowngrade.upgraded).toBe(false);
  });

  test("maps autonomy mode from risk level unless manual-only is forced", () => {
    expect(determineAutonomyMode({ riskLevel: "low" })).toBe("full_auto");
    expect(determineAutonomyMode({ riskLevel: "high" })).toBe("approval_required");
    expect(determineAutonomyMode({ riskLevel: "low", manualOnly: true })).toBe("manual_only");
  });

  test("requires approval for high risk, manual data repair, protected config, or incomplete verification", () => {
    expect(shouldRequireApproval({ riskLevel: "high" }).required).toBe(true);
    expect(shouldRequireApproval({ manualDataRepair: true }).required).toBe(true);
    expect(shouldRequireApproval({ configDomainsTouched: ["auth"] }).required).toBe(true);
    expect(shouldRequireApproval({ requiredVerificationPassed: false }).required).toBe(true);

    const userFacingHighRisk = shouldRequireApproval({
      riskLevel: "high",
      requiredVerificationPassed: true,
      userFacingResolution: true,
      founderApprovalGranted: false,
    });
    expect(userFacingHighRisk.required).toBe(true);

    const nonHighRisk = shouldRequireApproval({
      riskLevel: "medium",
      requiredVerificationPassed: true,
    });
    expect(nonHighRisk.required).toBe(false);
  });

  test("auto deploy only passes when every policy condition is satisfied", () => {
    const blocked = canAutoDeploy({
      autoDeployEnabled: true,
      riskLevel: "medium",
      approvalState: "not_needed",
      verificationStatus: "passed",
      requiredChecksPassed: true,
      filesTouched: ["backend/routes/payments.js"],
      previewStatus: "passed",
      rollbackTargetDeployId: "render-prev-123",
      freshClusterIncidentCount: 0,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain("protected paths touched");

    const allowed = canAutoDeploy({
      autoDeployEnabled: true,
      riskLevel: "low",
      approvalState: "not_needed",
      verificationStatus: "passed",
      requiredChecksPassed: true,
      filesTouched: ["frontend/assets/scripts/views/help.js"],
      previewStatus: "passed",
      rollbackTargetDeployId: "render-prev-123",
      freshClusterIncidentCount: 0,
    });
    expect(allowed.allowed).toBe(true);
  });

  test("rollback triggers on health, smoke, spike, auth, or protected-domain regressions", () => {
    expect(
      shouldTriggerRollback({
        healthFailuresWithinTwoMinutes: 2,
      }).shouldRollback
    ).toBe(true);

    expect(
      shouldTriggerRollback({
        prodSmokeFailures: 2,
      }).shouldRollback
    ).toBe(true);

    expect(
      shouldTriggerRollback({
        postDeployErrorFingerprintCount: 5,
      }).shouldRollback
    ).toBe(true);

    expect(
      shouldTriggerRollback({
        newClusterIncidentsWithin15Min: 2,
      }).shouldRollback
    ).toBe(true);

    expect(
      shouldTriggerRollback({
        unauthorizedFailure: true,
      }).shouldRollback
    ).toBe(true);

    expect(
      shouldTriggerRollback({
        protectedDomainSignal: true,
      }).shouldRollback
    ).toBe(true);

    expect(shouldTriggerRollback({}).shouldRollback).toBe(false);
  });
});
