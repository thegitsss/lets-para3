const {
  PARALEGAL_RELIABILITY_THRESHOLDS,
  PARALEGAL_SUPPORT_TELEMETRY_RETENTION_DAYS,
  buildParalegalQuestionFamilySignal,
  buildSyntheticParalegalReliabilityMessages,
  classifyParalegalToolOutcome,
  getParalegalSupportOperationalMode,
  normalizeParalegalEvidenceState,
  normalizeParalegalQuestionForFingerprint,
  summarizeParalegalReliability,
  summarizeParalegalToolCall,
} = require("../services/support/paralegalReliabilityService");
const {
  PARALEGAL_RELIABILITY_PROJECTION,
  parseParalegalReliabilityOptions,
} = require("../scripts/report-paralegal-support-reliability");

function cloneMessages() {
  return structuredClone(buildSyntheticParalegalReliabilityMessages());
}

describe("paralegal Package 8–9 reliability and safe-operation contract", () => {
  test("classifies tool outcomes without retaining arguments, raw output, money, or secrets", () => {
    expect(normalizeParalegalEvidenceState({ ok: true, available: false })).toBe("absent");
    expect(classifyParalegalToolOutcome({
      ok: false,
      evidenceState: "unauthorized",
    })).toBe("authorization_denied");
    expect(classifyParalegalToolOutcome({
      ok: false,
      retryable: true,
      error: "timeout",
    })).toBe("dependency_unavailable");
    expect(summarizeParalegalToolCall({
      name: "get_paralegal_case_financials",
      capabilityId: "P17_matter_financials",
      durationMs: 18.7,
      result: {
        ok: true,
        evidenceState: "verified",
        secret: "must-not-persist",
        amount: 10000,
      },
    })).toEqual({
      name: "get_paralegal_case_financials",
      capabilityId: "P17_matter_financials",
      ok: true,
      evidenceState: "verified",
      failureClass: "success",
      durationMs: 19,
    });
  });

  test("clusters equivalent questions with an opaque paralegal-only family key", () => {
    const first = buildParalegalQuestionFamilySignal(
      "What is the status of matter 507f1f77bcf86cd799439011 for client@example.com?"
    );
    const second = buildParalegalQuestionFamilySignal(
      "matter status for other@example.com, id 0123456789abcdef01234567"
    );
    expect(first.familyKey).toMatch(/^paralegal-question:[a-f0-9]{16}$/);
    expect(second.familyKey).toBe(first.familyKey);
    expect(first.familyKey).not.toContain("client");
    expect(
      normalizeParalegalQuestionForFingerprint(
        "Email client@example.com at https://example.com"
      )
    ).not.toContain("client@example.com");
  });

  test("produces a reproducible read-only passing dashboard with independent capability metrics", () => {
    const messages = cloneMessages();
    const before = structuredClone(messages);
    const first = summarizeParalegalReliability(messages, { windowDays: 30 });
    const second = summarizeParalegalReliability(messages, { windowDays: 30 });
    expect(first).toEqual(second);
    expect(messages).toEqual(before);
    expect(first).toEqual(expect.objectContaining({
      role: "paralegal",
      readOnly: true,
      retentionDays: PARALEGAL_SUPPORT_TELEMETRY_RETENTION_DAYS,
      assistantMessageCount: 120,
      managerMessageCount: 120,
      missingTelemetryCount: 0,
      gate: expect.objectContaining({ passed: true, status: "passed" }),
      privacy: {
        rawMessageTextRead: false,
        rawToolOutputRead: false,
        customerIdentityProjected: false,
        unknownQuestionContentStored: false,
        attorneyMetricsIncluded: false,
      },
    }));
    expect(first.managerAvailabilityCounts).toEqual({ available: 120 });
    expect(first.rolloutStageCounts).toEqual({ full: 120 });
    expect(first.rolloutPercentCounts).toEqual({ 100: 120 });
    expect(first.rolloutTelemetryMissingCount).toBe(0);
    expect(first.capabilityReliability.P01_assigned_overview).toEqual(
      expect.objectContaining({ messageCount: 120, toolFailureRate: 0 })
    );
    expect(first.capabilityCounts).not.toHaveProperty("A01_matter_overview");
  });

  test("excludes explicitly attorney-tagged events instead of conflating role metrics", () => {
    const messages = cloneMessages();
    messages.push({
      _id: "attorney-event",
      metadata: {
        provider: "openai_manager",
        reliability: { role: "attorney", capabilityIds: ["A01_matter_overview"] },
        telemetry: { role: "attorney", managerAvailable: false, toolCalls: [] },
      },
    });
    const report = summarizeParalegalReliability(messages);
    expect(report.roleExcludedCount).toBe(1);
    expect(report.assistantMessageCount).toBe(120);
    expect(report.managerUnavailableCount).toBe(0);
    expect(report.capabilityCounts).not.toHaveProperty("A01_matter_overview");
  });

  test("fires zero-tolerance and rate alerts with reproducible paralegal regressions", () => {
    const messages = cloneMessages();
    messages[0].metadata.reliability.validationFailures = ["unsupported_monetary_claim"];
    messages[1].metadata.provider = "paralegal_manager_unavailable";
    messages[1].metadata.telemetry.managerAvailable = false;
    for (const index of [2, 3, 4]) {
      messages[index].metadata.telemetry.toolCalls[0] = {
        name: "get_paralegal_case_financials",
        capabilityId: "P17_matter_financials",
        ok: false,
        evidenceState: "temporarily_unavailable",
        failureClass: "dependency_unavailable",
        durationMs: 50,
      };
    }
    messages[5].metadata.provider = "openai_manager_paralegal_safe_fallback";
    messages[6].metadata.provider = "openai_manager_paralegal_safe_fallback";
    const report = summarizeParalegalReliability(messages);
    expect(report.gate).toEqual(expect.objectContaining({
      passed: false,
      status: "threshold_breach",
    }));
    expect(report.alerts.map((alert) => alert.failureClass)).toEqual(
      expect.arrayContaining([
        "critical_validation_failure",
        "tool_failure",
        "safe_fallback",
      ])
    );
    expect(report.alerts.every((alert) =>
      alert.regressionCommand.includes("paralegal") ||
      alert.regressionCommand.includes("supportAssistant")
    )).toBe(true);
  });

  test("verifies every documented rate alert with synthetic events", () => {
    const messages = cloneMessages();
    for (const index of [0, 1]) {
      messages[index].metadata.provider = "paralegal_manager_unavailable";
      messages[index].metadata.telemetry.managerAvailable = false;
    }
    for (const index of [2, 3, 4]) {
      messages[index].metadata.telemetry.toolCalls[0].ok = false;
      messages[index].metadata.telemetry.toolCalls[0].evidenceState =
        "temporarily_unavailable";
      messages[index].metadata.telemetry.toolCalls[0].failureClass =
        "dependency_unavailable";
    }
    for (const index of [5, 6]) {
      messages[index].metadata.provider = "openai_manager_paralegal_safe_fallback";
    }
    for (let index = 7; index < 14; index += 1) {
      messages[index].metadata.feedback = { rating: "unhelpful" };
      messages[index].metadata.telemetry.latencyMs = 16001;
    }
    for (let index = 14; index < 27; index += 1) {
      messages[index].metadata.reliability.repeatedQuestion = true;
      messages[index].metadata.reliability.unknownQuestionCluster =
        `paralegal-question:cluster${index}`;
    }
    for (let index = 27; index < 30; index += 1) {
      delete messages[index].metadata.telemetry;
    }
    const report = summarizeParalegalReliability(messages);
    expect(report.gate).toEqual(expect.objectContaining({
      passed: false,
      status: "threshold_breach",
    }));
    expect(report.alerts.map((alert) => alert.failureClass)).toEqual(
      expect.arrayContaining([
        "manager_unavailable",
        "tool_failure",
        "safe_fallback",
        "unhelpful_feedback",
        "unhelpful_feedback_ratio",
        "repeated_question",
        "unknown_question",
        "missing_telemetry",
        "latency",
      ])
    );
  });

  test("distinguishes missing telemetry from successful tool execution", () => {
    const messages = cloneMessages();
    for (let index = 0; index < 3; index += 1) delete messages[index].metadata.telemetry;
    const report = summarizeParalegalReliability(messages);
    expect(report.missingTelemetryCount).toBe(3);
    expect(report.metrics.missingTelemetryRate).toBe(0.025);
    expect(report.gate.breaches).toContain("missing_telemetry");
    expect(report.toolFailureCount).toBe(0);
  });

  test("measures feedback, repeats, unknown families, retries, and evidence state", () => {
    const messages = cloneMessages();
    messages[0].metadata.feedback = { rating: "unhelpful" };
    messages[1].metadata.reliability.repeatedQuestion = true;
    messages[2].metadata.reliability.unknownQuestionCluster =
      "paralegal-question:opaquecluster";
    messages[3].metadata.reliability.validationRetries = 1;
    messages[3].metadata.reliability.retryOutcome = "corrected";
    messages[4].metadata.reliability.evidenceStatus = "absent";
    const report = summarizeParalegalReliability(messages);
    expect(report.unhelpfulCount).toBe(1);
    expect(report.repeatedQuestionCount).toBe(1);
    expect(report.unknownQuestionClusters).toEqual([
      expect.objectContaining({
        clusterKey: "paralegal-question:opaquecluster",
        count: 1,
        evaluationBacklog: "backend/ai/paralegalSupportEvalCorpus.js",
      }),
    ]);
    expect(report.validationRetryMessageCount).toBe(1);
    expect(report.retryOutcomeCounts.corrected).toBe(1);
    expect(report.evidenceStatusCounts.absent).toBe(1);
  });

  test("attributes compound tool failures only to the owning paralegal capability", () => {
    const messages = cloneMessages();
    messages[0].metadata.reliability.capabilityIds = [
      "P01_assigned_overview",
      "P17_matter_financials",
    ];
    messages[0].metadata.telemetry.toolCalls = [
      {
        name: "get_paralegal_case_overview",
        capabilityId: "P01_assigned_overview",
        ok: true,
        evidenceState: "verified",
        failureClass: "success",
        durationMs: 10,
      },
      {
        name: "get_paralegal_case_financials",
        capabilityId: "P17_matter_financials",
        ok: false,
        evidenceState: "temporarily_unavailable",
        failureClass: "dependency_unavailable",
        durationMs: 20,
      },
    ];
    const report = summarizeParalegalReliability(messages);
    expect(report.capabilityReliability.P01_assigned_overview.toolFailureCount).toBe(0);
    expect(report.capabilityReliability.P17_matter_financials.toolFailureCount).toBe(1);
  });

  test("verifies safe disable and identifies an unsafe guessed legacy fallback", () => {
    expect(getParalegalSupportOperationalMode({
      OPENAI_SUPPORT_MANAGER_ENABLED: "false",
      OPENAI_PARALEGAL_MANAGER_ENABLED: "false",
      OPENAI_PARALEGAL_LEGACY_FALLBACK: "false",
    })).toEqual(expect.objectContaining({
      mode: "safe_disabled",
      safeDisableConfigured: true,
    }));
    const unsafeMode = getParalegalSupportOperationalMode({
      OPENAI_SUPPORT_MANAGER_ENABLED: "false",
      OPENAI_PARALEGAL_LEGACY_FALLBACK: "true",
    });
    const report = summarizeParalegalReliability(cloneMessages(), {
      operationalMode: unsafeMode,
    });
    expect(report.gate).toEqual(expect.objectContaining({ passed: false }));
    expect(report.alerts).toContainEqual(expect.objectContaining({
      severity: "critical",
      failureClass: "unsafe_legacy_fallback",
      action: "disable_paralegal_manager_and_investigate",
    }));
  });

  test("enforces critical validation zero tolerance before minimum sample", () => {
    const messages = cloneMessages().slice(0, 1);
    messages[0].metadata.reliability.validationFailures = [
      "unsupported_bank_receipt_claim",
    ];
    const report = summarizeParalegalReliability(messages);
    expect(report.managerMessageCount).toBeLessThan(
      PARALEGAL_RELIABILITY_THRESHOLDS.minimumLaunchSample
    );
    expect(report.gate).toEqual(expect.objectContaining({
      passed: false,
      status: "threshold_breach",
      breaches: expect.arrayContaining(["critical_validation_failure"]),
    }));
  });

  test("caps retention and projects no raw text, identity, page context, or tool results", () => {
    expect(parseParalegalReliabilityOptions(["--days=999"])).toEqual(expect.objectContaining({
      days: PARALEGAL_SUPPORT_TELEMETRY_RETENTION_DAYS,
      synthetic: false,
    }));
    expect(parseParalegalReliabilityOptions(["--days=7", "--synthetic"])).toEqual(expect.objectContaining({
      days: 7,
      synthetic: true,
    }));
    expect(PARALEGAL_RELIABILITY_PROJECTION).toContain(
      "metadata.telemetry.toolCalls.failureClass"
    );
    expect(PARALEGAL_RELIABILITY_PROJECTION).toContain(
      "metadata.telemetry.rollout.contractVersion"
    );
    expect(PARALEGAL_RELIABILITY_PROJECTION).not.toMatch(
      /\btext\b|supportFacts|email|user|pageContext|toolResults?/i
    );
    expect(PARALEGAL_RELIABILITY_THRESHOLDS.criticalValidationFailureCount).toBe(0);
  });
});
