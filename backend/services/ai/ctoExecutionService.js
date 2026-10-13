const mongoose = require("mongoose");

const CtoAgentRun = require("../../models/CtoAgentRun");
const CtoExecutionRun = require("../../models/CtoExecutionRun");

const EXECUTION_STATUSES = Object.freeze([
  "planned",
  "awaiting_approval",
  "in_progress",
  "ready_for_test",
  "ready_for_review",
  "ready_for_deploy",
  "resolved",
  "blocked",
]);

const HIGH_RISK_CATEGORIES = new Set([
  "login",
  "payment",
  "payment_action",
  "stripe_onboarding",
  "messaging",
  "message_send",
  "account_approval",
  "admin_permissions",
]);

function compactText(value = "", max = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => compactText(value, 4000))
        .filter(Boolean)
    )
  );
}

function dbReady() {
  return mongoose.connection.readyState === 1;
}

function normalizeCategory(category = "") {
  return String(category || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeUrgency(urgency = "") {
  const safe = String(urgency || "").trim().toLowerCase();
  return ["critical", "high", "medium", "low"].includes(safe) ? safe : "medium";
}

function normalizeTechnicalSeverity(value = "") {
  const safe = String(value || "").trim().toLowerCase();
  return ["critical", "high", "medium", "low"].includes(safe) ? safe : "medium";
}

function normalizeExecutionStatus(value = "") {
  const safe = String(value || "").trim().toLowerCase();
  return EXECUTION_STATUSES.includes(safe) ? safe : "awaiting_approval";
}

async function loadCtoRunRecord(ctoRunId = "") {
  const id = String(ctoRunId || "").trim();
  if (!id) return null;
  if (!dbReady()) {
    return { error: "Mongo unavailable", statusCode: 503 };
  }
  if (!mongoose.isValidObjectId(id)) {
    return { error: "Invalid CtoAgentRun id.", statusCode: 400 };
  }
  const run = await CtoAgentRun.findById(id).lean();
  if (!run) {
    return { error: "CtoAgentRun not found.", statusCode: 404 };
  }
  return { run };
}

function normalizeDiagnosisPacket({ run = null, ctoRunId = "", payload = {} } = {}) {
  const source = run || payload || {};
  return {
    ctoRunId: run?._id ? String(run._id) : String(ctoRunId || source.ctoRunId || "").trim(),
    issueId: run?.issueId ? String(run.issueId) : String(source.issueId || "").trim(),
    category: normalizeCategory(source.category),
    urgency: normalizeUrgency(source.urgency),
    technicalSeverity: normalizeTechnicalSeverity(source.technicalSeverity),
    diagnosisSummary: compactText(source.diagnosisSummary || "", 4000),
    likelyRootCauses: uniqueStrings(source.likelyRootCauses || []),
    likelyAffectedAreas: uniqueStrings(source.likelyAffectedAreas || []),
    filesToInspect: uniqueStrings(source.filesToInspect || []),
    backendAreasToCheck: uniqueStrings(source.backendAreasToCheck || []),
    frontendAreasToCheck: uniqueStrings(source.frontendAreasToCheck || []),
    recommendedFixStrategy: compactText(source.recommendedFixStrategy || "", 8000),
    codexPatchPrompt: compactText(source.codexPatchPrompt || "", 20000),
    testPlan: uniqueStrings(source.testPlan || []),
    deploymentRisk: compactText(source.deploymentRisk || "", 500),
    approvalRequired: source.approvalRequired !== false,
    canAutoDeploy: false,
    notifyUserWhenResolved: source.notifyUserWhenResolved === true,
    notes: uniqueStrings(source.notes || []),
    executionStatus: normalizeExecutionStatus(source.executionStatus || ""),
    metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {},
  };
}

function detectLikelyChangeTypes(diagnosis = {}) {
  const category = normalizeCategory(diagnosis.category);
  const text = `${(diagnosis.likelyRootCauses || []).join(" ")} ${(diagnosis.recommendedFixStrategy || "")}`.toLowerCase();
  const changeTypes = [];

  if (category === "hire_flow" || /click handler|modal|disabled-state|disabled state/.test(text)) {
    changeTypes.push("event binding", "disabled state logic", "modal flow wiring");
  }
  if (category === "profile_save" || /validation|save request|payload/.test(text)) {
    changeTypes.push("validation handling", "API request payload");
  }
  if (category === "dashboard_load" || /render|bootstrap|blank/.test(text)) {
    changeTypes.push("UI render path", "route response handling");
  }
  if (category === "login" || /session|auth|unauthenticated|approval-state/.test(text)) {
    changeTypes.push("auth/session check", "route response handling");
  }
  if (category === "message_send" || category === "messaging") {
    changeTypes.push("event binding", "API request payload", "route response handling");
  }
  if (category === "payment" || category === "payment_action" || category === "stripe_onboarding") {
    changeTypes.push("route response handling", "auth/session check", "validation handling");
  }
  if (!changeTypes.length) {
    changeTypes.push("route response handling", "event binding");
  }

  return uniqueStrings(changeTypes);
}

function buildPatchArtifact(diagnosis = {}) {
  const likelyFiles = uniqueStrings(diagnosis.filesToInspect || []);
  const frontendTargets = likelyFiles.filter((file) => file.startsWith("frontend/"));
  const backendTargets = likelyFiles.filter((file) => file.startsWith("backend/"));
  const regressionAreas = uniqueStrings([
    ...(diagnosis.requiredTests || []),
    ...(diagnosis.testPlan || []),
    ...(diagnosis.likelyAffectedAreas || []),
  ]);
  const riskNotes = uniqueStrings([
    diagnosis.deploymentRisk || "",
    HIGH_RISK_CATEGORIES.has(normalizeCategory(diagnosis.category))
      ? "This issue sits in a higher-risk LPC flow and should remain manual-review only."
      : "Keep the patch narrow and verify the adjacent user flow before any deployment recommendation.",
  ]);

  return {
    likelyFiles,
    frontendTargets,
    backendTargets,
    likelyChangeTypes: detectLikelyChangeTypes(diagnosis),
    riskNotes,
    regressionAreas,
    prohibitedActions: [
      "unrelated refactors",
      "schema changes unless explicitly required by a verified fix",
      "destructive writes",
      "style/layout changes",
      "deployment API calls",
      "auto-running migrations",
    ],
  };
}

function buildImplementationSummary(diagnosis = {}) {
  const category = normalizeCategory(diagnosis.category).replace(/_/g, " ");
  const firstFile = (diagnosis.filesToInspect || [])[0] || "the mapped LPC files";
  return compactText(
    `Prepare a focused ${category || "technical"} fix using the diagnosis packet, beginning with ${firstFile}. The goal is to reproduce the reported issue, implement the narrowest safe correction, run targeted tests, and keep deployment manual and approval-first.`,
    2000
  );
}

function buildExecutionPlan(diagnosis = {}) {
  const pageHint = diagnosis.metadata?.page ? ` on ${diagnosis.metadata.page}` : "";
  const steps = [
    `Reproduce the reported issue${pageHint} and confirm the first failing interaction, request, or render path.`,
    `Inspect the likely files first: ${(diagnosis.filesToInspect || []).slice(0, 5).join(", ") || "use the mapped LPC files from the diagnosis packet"}.`,
    `Implement the narrowest safe fix guided by the diagnosis summary and recommended fix strategy.`,
    "Run the targeted tests from the diagnosis packet and confirm the original issue no longer reproduces.",
    "Run focused regression checks on adjacent flows that share the same page, route, or guard logic.",
    "Review deployment risk, blockers, and required approvals before advancing status beyond implementation.",
    "Prepare the user-facing resolution note, but do not send it until the issue is truly resolved.",
  ];
  return uniqueStrings(steps);
}

function buildRequiredTests(diagnosis = {}) {
  const tests = uniqueStrings([
    ...(diagnosis.testPlan || []),
    "Verify the original reported path succeeds without introducing a broader regression.",
    HIGH_RISK_CATEGORIES.has(normalizeCategory(diagnosis.category))
      ? "Run an extra manual regression pass on the surrounding high-risk flow before any deployment recommendation."
      : "",
  ]);
  return tests.slice(0, 8);
}

function buildDeploymentChecklist(diagnosis = {}, executionStatus = "awaiting_approval") {
  const checklist = [
    "Confirm the focused fix has been implemented against the mapped files only.",
    "Run targeted tests from the execution packet.",
    "Run focused regression checks on adjacent LPC flows.",
    "Review logs or monitoring for the same path after testing.",
    "Obtain manual reviewer approval before any deployment step.",
  ];

  if (HIGH_RISK_CATEGORIES.has(normalizeCategory(diagnosis.category))) {
    checklist.push("Confirm the high-risk flow was reviewed by a human before changing deployment readiness.");
  }
  if (executionStatus === "resolved") {
    checklist.push("Confirm the resolution note is accurate before notifying the user.");
  }

  return uniqueStrings(checklist);
}

function buildDeploymentReadiness(diagnosis = {}, executionStatus = "awaiting_approval") {
  const category = normalizeCategory(diagnosis.category);
  const riskLevel = HIGH_RISK_CATEGORIES.has(category)
    ? "high"
    : ["high", "critical"].includes(normalizeTechnicalSeverity(diagnosis.technicalSeverity))
      ? "medium"
      : "low";

  const blockers = [];
  if (executionStatus === "blocked") {
    blockers.push("Execution is currently blocked and needs human intervention before work can continue.");
  }
  if (!diagnosis.filesToInspect?.length) {
    blockers.push("Diagnosis packet does not include mapped files to inspect yet.");
  }
  if (!(diagnosis.testPlan || []).length) {
    blockers.push("Diagnosis packet does not include targeted tests yet.");
  }
  if (executionStatus !== "resolved") {
    blockers.push("Implementation has not been completed and verified yet.");
    blockers.push("Manual approval is still required before any deploy recommendation.");
  }

  let status = "not_ready";
  if (executionStatus === "blocked" || blockers.some((item) => /does not include/.test(item))) {
    status = "blocked";
  } else if (executionStatus === "ready_for_test") {
    status = "ready_for_test";
  } else if (executionStatus === "ready_for_review") {
    status = "ready_for_review";
  } else if (executionStatus === "ready_for_deploy" || executionStatus === "resolved") {
    status = "ready_for_deploy";
  }

  return {
    status,
    blockers: uniqueStrings(blockers),
    requiredChecks: buildDeploymentChecklist(diagnosis, executionStatus),
    riskLevel,
    reviewerNotes: HIGH_RISK_CATEGORIES.has(category)
      ? "Keep this flow approval-first. Even after implementation, a human should review the fix and regression scope before deployment."
      : "This execution packet is informative only. Do not move to deployment without manual review and test confirmation.",
  };
}

function buildResolutionMessageDraft(diagnosis = {}, executionStatus = "awaiting_approval") {
  const summary = compactText(diagnosis.diagnosisSummary || "the reported issue", 180);
  if (executionStatus === "resolved") {
    return `Thanks for your patience. The issue affecting ${summary} has been addressed. Please refresh the page and try again. If you still run into the problem, reply here and let us know.`;
  }
  return `Thanks for your patience. We’re actively working on the issue affecting ${summary}. Once the fix has been validated, we’ll ask you to refresh the page and try again. If you still see the problem after that, reply here and let us know.`;
}

function buildCodexExecutionPrompt(diagnosis = {}, execution = {}) {
  return [
    "Implement a narrow LPC production fix from an existing CTO diagnosis packet.",
    "",
    `Category: ${diagnosis.category}`,
    `Urgency: ${diagnosis.urgency}`,
    `Technical severity: ${diagnosis.technicalSeverity}`,
    `Execution status: ${execution.executionStatus}`,
    "",
    `Incident summary: ${diagnosis.diagnosisSummary}`,
    `Recommended fix strategy: ${diagnosis.recommendedFixStrategy}`,
    "",
    `Inspect these files first: ${(diagnosis.filesToInspect || []).join(", ") || "Use the mapped files from the diagnosis packet."}`,
    "",
    `Expected change types: ${(execution.patchArtifact?.likelyChangeTypes || []).join(", ") || "Keep the fix tightly scoped."}`,
    "",
    "Execution constraints:",
    "- Keep the fix narrow and production-minded.",
    "- Do not refactor unrelated code.",
    "- Do not change visual design, layout, or animations.",
    "- Do not add destructive writes or migrations.",
    "- Do not auto-deploy or prepare production data mutations.",
    "- Treat the diagnosis as likely, not confirmed, until verified in code.",
    "",
    "Required tests:",
    ...(execution.requiredTests || []).map((item) => `- ${item}`),
    "",
    "Deployment posture:",
    "- Approval-first only.",
    "- canAutoDeploy must remain false.",
    "- Manual review is required before any deploy recommendation.",
  ].join("\n");
}

async function persistExecutionRun({ execution = {}, diagnosisSnapshot = null, metadata = {} } = {}) {
  if (!dbReady()) {
    return { run: null, saved: false, reason: "Mongo unavailable" };
  }
  try {
    const created = await CtoExecutionRun.create({
      ctoRunId: execution.ctoRunId || null,
      issueId: execution.issueId || null,
      category: execution.category,
      urgency: execution.urgency,
      technicalSeverity: execution.technicalSeverity,
      executionStatus: execution.executionStatus,
      implementationSummary: execution.implementationSummary,
      executionPlan: execution.executionPlan,
      patchArtifact: execution.patchArtifact,
      codexExecutionPrompt: execution.codexExecutionPrompt,
      requiredTests: execution.requiredTests,
      deploymentChecklist: execution.deploymentChecklist,
      deploymentReadiness: execution.deploymentReadiness,
      approvalRequired: execution.approvalRequired,
      canAutoDeploy: execution.canAutoDeploy,
      notifyUserWhenResolved: execution.notifyUserWhenResolved,
      resolutionMessageDraft: execution.resolutionMessageDraft,
      sourceDiagnosisSnapshot: diagnosisSnapshot || {},
      metadata,
      generatedAt: execution.generatedAt,
    });
    return { run: created, saved: true, reason: "" };
  } catch (err) {
    return { run: null, saved: false, reason: compactText(err?.message || "Persistence failed.", 240) };
  }
}

async function buildExecutionPacket(input = {}) {
  const saveRun = input.saveRun === true;
  let loadedRun = null;

  if (input.ctoRunId) {
    const loaded = await loadCtoRunRecord(input.ctoRunId);
    if (loaded?.error) {
      return {
        ok: false,
        statusCode: loaded.statusCode || 400,
        error: loaded.error,
        ctoRunId: String(input.ctoRunId || "").trim(),
        executionRunId: null,
        saved: false,
        saveSkippedReason: loaded.error,
        generatedAt: new Date().toISOString(),
      };
    }
    loadedRun = loaded.run;
  }

  const diagnosis = normalizeDiagnosisPacket({
    run: loadedRun,
    ctoRunId: input.ctoRunId,
    payload: loadedRun ? loadedRun : input,
  });

  if (!diagnosis.diagnosisSummary && !(diagnosis.filesToInspect || []).length && !diagnosis.category) {
    return {
      ok: false,
      statusCode: 400,
      error: "A ctoRunId or a diagnosis payload is required.",
      ctoRunId: diagnosis.ctoRunId || "",
      executionRunId: null,
      saved: false,
      saveSkippedReason: "No diagnosis payload was available.",
      generatedAt: new Date().toISOString(),
    };
  }

  const executionStatus = diagnosis.executionStatus || "awaiting_approval";
  const patchArtifact = buildPatchArtifact(diagnosis);
  const execution = {
    ok: true,
    ctoRunId: diagnosis.ctoRunId || "",
    executionRunId: null,
    issueId: diagnosis.issueId || "",
    category: diagnosis.category,
    urgency: diagnosis.urgency,
    technicalSeverity: diagnosis.technicalSeverity,
    executionStatus,
    implementationSummary: buildImplementationSummary(diagnosis),
    executionPlan: buildExecutionPlan(diagnosis),
    patchArtifact,
    codexExecutionPrompt: "",
    requiredTests: buildRequiredTests(diagnosis),
    deploymentChecklist: buildDeploymentChecklist(diagnosis, executionStatus),
    deploymentReadiness: buildDeploymentReadiness(diagnosis, executionStatus),
    approvalRequired: true,
    canAutoDeploy: false,
    notifyUserWhenResolved: diagnosis.notifyUserWhenResolved === true,
    resolutionMessageDraft: buildResolutionMessageDraft(diagnosis, executionStatus),
    notes: uniqueStrings([
      "This execution packet is planning-oriented and does not confirm the issue is fixed.",
      HIGH_RISK_CATEGORIES.has(normalizeCategory(diagnosis.category))
        ? "This execution packet touches a higher-risk LPC flow and should remain human-reviewed before deployment."
        : "Manual review is still required before deployment.",
      "Auto-deploy is disabled in this phase.",
    ]),
    generatedAt: new Date().toISOString(),
    saved: false,
    saveSkippedReason: saveRun ? "Persistence pending" : "saveRun was false",
  };

  execution.codexExecutionPrompt = buildCodexExecutionPrompt(diagnosis, execution);

  if (saveRun) {
    const persistence = await persistExecutionRun({
      execution,
      diagnosisSnapshot: loadedRun || diagnosis,
      metadata: {
        source: loadedRun ? "cto_run" : "direct_diagnosis_payload",
        metadata: diagnosis.metadata,
      },
    });
    execution.saved = persistence.saved === true;
    execution.saveSkippedReason = persistence.saved ? "" : persistence.reason || "Persistence skipped.";
    if (persistence.run?._id) {
      execution.executionRunId = String(persistence.run._id);
    } else {
      execution.notes = uniqueStrings([
        ...execution.notes,
        `Execution persistence was requested but skipped: ${execution.saveSkippedReason}`,
      ]);
    }
  }

  return execution;
}

module.exports = {
  buildExecutionPacket,
  normalizeDiagnosisPacket,
};
