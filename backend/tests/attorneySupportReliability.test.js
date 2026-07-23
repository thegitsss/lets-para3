const {
  ATTORNEY_RELIABILITY_THRESHOLDS,
  SUPPORT_TELEMETRY_RETENTION_DAYS,
  buildQuestionFamilySignal,
  buildSyntheticAttorneyReliabilityMessages,
  classifyAttorneyToolOutcome,
  getAttorneySupportOperationalMode,
  normalizeEvidenceState,
  normalizeQuestionForFingerprint,
  summarizeAttorneyReliability,
  summarizeAttorneyToolCall,
} = require("../services/support/attorneyReliabilityService");
const {
  RELIABILITY_PROJECTION,
  parseOptions,
} = require("../scripts/report-attorney-support-reliability");

function cloneMessages() {
  return structuredClone(buildSyntheticAttorneyReliabilityMessages());
}

describe("attorney Package 8 reliability and safe-operation contract", () => {
  test("classifies evidence, tool outcomes, and latency without retaining raw output", () => {
    expect(normalizeEvidenceState({ ok: true, available: false })).toBe("absent");
    expect(classifyAttorneyToolOutcome({ ok: false, evidenceState: "unauthorized" })).toBe("authorization_denied");
    expect(classifyAttorneyToolOutcome({ ok: false, retryable: true, error: "timeout" })).toBe("dependency_unavailable");
    expect(summarizeAttorneyToolCall({
      name: "get_attorney_case_financials",
      durationMs: 18.7,
      result: { ok: true, evidenceState: "verified", secret: "must-not-persist", amount: 10000 },
    })).toEqual({
      name: "get_attorney_case_financials",
      ok: true,
      evidenceState: "verified",
      failureClass: "success",
      durationMs: 19,
    });
  });

  test("clusters equivalent questions with an opaque key and removes direct identifiers", () => {
    const first = buildQuestionFamilySignal("What is the status of case 507f1f77bcf86cd799439011 for client@example.com?");
    const second = buildQuestionFamilySignal("case status for other@example.com, id 0123456789abcdef01234567");
    expect(first.familyKey).toMatch(/^question:[a-f0-9]{16}$/);
    expect(second.familyKey).toBe(first.familyKey);
    expect(first.familyKey).not.toContain("client");
    expect(normalizeQuestionForFingerprint("Email client@example.com at https://example.com")).not.toContain("client@example.com");
  });

  test("produces a reproducible, read-only passing report with per-capability metrics", () => {
    const messages = cloneMessages();
    const before = structuredClone(messages);
    const one = summarizeAttorneyReliability(messages, { windowDays: 30 });
    const two = summarizeAttorneyReliability(messages, { windowDays: 30 });
    expect(one).toEqual(two);
    expect(messages).toEqual(before);
    expect(one).toEqual(expect.objectContaining({
      readOnly: true,
      retentionDays: SUPPORT_TELEMETRY_RETENTION_DAYS,
      assistantMessageCount: 120,
      managerMessageCount: 120,
      missingTelemetryCount: 0,
      gate: expect.objectContaining({ passed: true, status: "passed" }),
      privacy: {
        rawMessageTextRead: false,
        rawToolOutputRead: false,
        customerIdentityProjected: false,
        unknownQuestionContentStored: false,
      },
    }));
    expect(one.managerAvailabilityCounts).toEqual({ available: 120 });
    expect(one.rolloutTelemetryMissingCount).toBe(0);
    expect(one.rolloutStageCounts).toEqual({ general: 120 });
    expect(one.rolloutPercentCounts).toEqual({ 100: 120 });
    expect(one.capabilityReliability.A01_matter_overview).toEqual(expect.objectContaining({
      messageCount: 120,
      toolFailureRate: 0,
    }));
  });

  test("fires synthetic critical alerts and links each failure to a regression command", () => {
    const messages = cloneMessages();
    messages[0].metadata.provider = "attorney_manager_unavailable";
    messages[4].metadata.provider = "attorney_manager_unavailable";
    messages[1].metadata.reliability.validationFailures = ["unsupported_financial_claim"];
    for (const index of [2, 5, 6]) {
      messages[index].metadata.telemetry.toolCalls[0] = {
        name: "get_attorney_case_financials",
        ok: false,
        evidenceState: "temporarily_unavailable",
        failureClass: "dependency_unavailable",
        durationMs: 50,
      };
    }
    messages[3].metadata.provider = "openai_manager_safe_fallback";
    messages[7].metadata.provider = "openai_manager_safe_fallback";
    const report = summarizeAttorneyReliability(messages, { windowDays: 30 });
    expect(report.gate).toEqual(expect.objectContaining({ passed: false, status: "threshold_breach" }));
    expect(report.alerts.map((alert) => alert.failureClass)).toEqual(expect.arrayContaining([
      "critical_validation_failure",
      "tool_failure",
      "safe_fallback",
    ]));
    expect(report.alerts.every((alert) => alert.regressionCommand.startsWith("npm "))).toBe(true);
  });

  test("distinguishes missing telemetry from successful behavior", () => {
    const messages = cloneMessages();
    for (let index = 0; index < 3; index += 1) delete messages[index].metadata.telemetry;
    const report = summarizeAttorneyReliability(messages, { windowDays: 30 });
    expect(report.missingTelemetryCount).toBe(3);
    expect(report.metrics.missingTelemetryRate).toBe(0.025);
    expect(report.gate.breaches).toContain("missing_telemetry");
    expect(report.toolFailureCount).toBe(0);
  });

  test("measures feedback, repeat, unknown-question, validation retry, and evidence states", () => {
    const messages = cloneMessages();
    messages[0].metadata.feedback = { rating: "unhelpful" };
    messages[1].metadata.reliability.repeatedQuestion = true;
    messages[2].metadata.reliability.unknownQuestionCluster = "question:opaquecluster1";
    messages[3].metadata.reliability.validationRetries = 1;
    messages[3].metadata.reliability.retryOutcome = "corrected";
    messages[4].metadata.reliability.evidenceStatus = "absent";
    const report = summarizeAttorneyReliability(messages, { windowDays: 30 });
    expect(report.unhelpfulCount).toBe(1);
    expect(report.repeatedQuestionCount).toBe(1);
    expect(report.unknownQuestionClusters).toEqual([
      expect.objectContaining({ clusterKey: "question:opaquecluster1", count: 1 }),
    ]);
    expect(report.validationRetryMessageCount).toBe(1);
    expect(report.retryOutcomeCounts.corrected).toBe(1);
    expect(report.evidenceStatusCounts.absent).toBe(1);
  });

  test("attributes compound-answer tool reliability only to the owning capability", () => {
    const messages = cloneMessages();
    messages[0].metadata.reliability.capabilityIds = ["A01_matter_overview", "A14_billing_summary"];
    messages[0].metadata.telemetry.toolCalls = [
      {
        name: "get_my_case_overview",
        capabilityId: "A01_matter_overview",
        ok: true,
        evidenceState: "verified",
        failureClass: "success",
        durationMs: 10,
      },
      {
        name: "get_attorney_billing_summary",
        capabilityId: "A14_billing_summary",
        ok: false,
        evidenceState: "temporarily_unavailable",
        failureClass: "dependency_unavailable",
        durationMs: 20,
      },
    ];
    const report = summarizeAttorneyReliability(messages);
    expect(report.capabilityReliability.A01_matter_overview.toolFailureCount).toBe(0);
    expect(report.capabilityReliability.A14_billing_summary.toolFailureCount).toBe(1);
    expect(report.toolSelectionCounts).toEqual(expect.objectContaining({
      get_my_case_overview: 120,
      get_attorney_billing_summary: 1,
    }));
  });

  test("verifies safe disable controls and identifies unsafe legacy fallback configuration", () => {
    expect(getAttorneySupportOperationalMode({
      OPENAI_SUPPORT_MANAGER_ENABLED: "false",
      OPENAI_ATTORNEY_LEGACY_FALLBACK: "false",
    })).toEqual(expect.objectContaining({ mode: "safe_disabled", safeDisableConfigured: true }));
    const unsafeMode = getAttorneySupportOperationalMode({
      OPENAI_SUPPORT_MANAGER_ENABLED: "false",
      OPENAI_ATTORNEY_LEGACY_FALLBACK: "true",
    });
    expect(unsafeMode).toEqual(expect.objectContaining({ mode: "unsafe_legacy_fallback", safeDisableConfigured: false }));
    const unsafeReport = summarizeAttorneyReliability(cloneMessages(), { operationalMode: unsafeMode });
    expect(unsafeReport.gate).toEqual(expect.objectContaining({ passed: false }));
    expect(unsafeReport.alerts).toContainEqual(expect.objectContaining({
      severity: "critical",
      failureClass: "unsafe_legacy_fallback",
      action: "disable_attorney_manager_and_investigate",
    }));
  });

  test("reports staged enrollment separately from manager outages", () => {
    const messages = cloneMessages();
    messages[0].metadata.provider = "attorney_manager_not_enrolled";
    messages[0].metadata.telemetry = {
      reliabilityGap: "attorney_rollout_not_enrolled",
      rollout: { rolloutStage: "canary", rolloutPercent: 10, rolloutBucket: 70 },
    };
    const report = summarizeAttorneyReliability(messages, {
      operationalMode: getAttorneySupportOperationalMode({
        OPENAI_ATTORNEY_MANAGER_ENABLED: "true",
        OPENAI_ATTORNEY_MANAGER_ROLLOUT_PERCENT: "10",
      }),
    });
    expect(report.rolloutExcludedCount).toBe(1);
    expect(report.managerUnavailableCount).toBe(0);
    expect(report.managerMessageCount).toBe(119);
    expect(report.operationalMode).toEqual(expect.objectContaining({
      mode: "staged_manager",
      rolloutPercent: 10,
    }));
  });

  test("enforces critical validator zero tolerance before the minimum sample is reached", () => {
    const messages = cloneMessages().slice(0, 1);
    messages[0].metadata.reliability.validationFailures = ["unsupported_financial_claim"];
    const report = summarizeAttorneyReliability(messages);
    expect(report.managerMessageCount).toBeLessThan(ATTORNEY_RELIABILITY_THRESHOLDS.minimumLaunchSample);
    expect(report.gate).toEqual(expect.objectContaining({
      passed: false,
      status: "threshold_breach",
      breaches: expect.arrayContaining(["critical_validation_failure"]),
    }));
  });

  test("caps reporting to retention and projects only privacy-safe telemetry fields", () => {
    expect(parseOptions(["--days=999"])).toEqual({
      days: SUPPORT_TELEMETRY_RETENTION_DAYS,
      synthetic: false,
      stage: "",
      since: "",
      completedStageIds: [],
      openIncidentCount: null,
      curatedAcceptancePassed: false,
      package7Passed: false,
      productOwnerConfirmed: false,
      releaseOwner: "",
      technicalOwner: "",
      enforceStageGate: false,
    });
    expect(parseOptions([
      "--synthetic",
      "--days=7",
      "--stage=canary",
      "--since=2026-07-20T12:00:00.000Z",
      "--completed-stages=internal",
      "--open-incidents=2",
      "--curated-acceptance-passed",
      "--package7-passed",
      "--release-owner=operations",
      "--technical-owner=on-call",
      "--enforce-stage-gate",
    ])).toEqual({
      days: 7,
      synthetic: true,
      stage: "canary",
      since: "2026-07-20T12:00:00.000Z",
      completedStageIds: ["internal"],
      openIncidentCount: 2,
      curatedAcceptancePassed: true,
      package7Passed: true,
      productOwnerConfirmed: false,
      releaseOwner: "operations",
      technicalOwner: "on-call",
      enforceStageGate: true,
    });
    expect(RELIABILITY_PROJECTION).toContain("metadata.telemetry.toolCalls.failureClass");
    expect(RELIABILITY_PROJECTION).not.toMatch(/\btext\b|supportFacts|email|user/i);
    expect(ATTORNEY_RELIABILITY_THRESHOLDS.criticalValidationFailureCount).toBe(0);
  });
});
