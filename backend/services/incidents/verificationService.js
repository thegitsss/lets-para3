const fs = require("fs");
const path = require("path");

const IncidentArtifact = require("../../models/IncidentArtifact");
const IncidentInvestigation = require("../../models/IncidentInvestigation");
const IncidentPatch = require("../../models/IncidentPatch");
const IncidentVerification = require("../../models/IncidentVerification");
const {
  compactText,
  buildNextJobFields,
  incrementStageAttempt,
  clearIncidentLock,
  buildEventRecorder,
  transitionIncidentState,
} = require("./workflowService");
const { selectPatchRecipe } = require("./patchService");
const { syncIncidentNotifications } = require("./notificationService");

const VERIFIER_AGENT_ROLE = "verifier_agent";
const NOTIFICATION_RECIPE_KEY = "notifications.style-injection";
const NOTIFICATION_RELATIVE_FILE = "frontend/assets/scripts/utils/notifications.js";
const PREFERENCES_RECIPE_KEY = "preferences.save-button-regression";
const PREFERENCES_RELATIVE_FILE = "frontend/assets/scripts/profile-settings.js";
const PREFERENCES_REGRESSION_MARKER = "LPC-INCIDENT-TEST: intentional preferences save regression marker.";

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => compactText(item, 240)).filter(Boolean))];
}

async function loadCurrentInvestigation(incident) {
  if (incident.currentInvestigationId) {
    const current = await IncidentInvestigation.findById(incident.currentInvestigationId);
    if (current) return current;
  }

  return IncidentInvestigation.findOne({ incidentId: incident._id }).sort({
    attemptNumber: -1,
    updatedAt: -1,
    createdAt: -1,
  });
}

async function loadCurrentPatch(incident) {
  if (incident.currentPatchId) {
    const current = await IncidentPatch.findById(incident.currentPatchId);
    if (current) return current;
  }

  return IncidentPatch.findOne({ incidentId: incident._id }).sort({
    attemptNumber: -1,
    updatedAt: -1,
    createdAt: -1,
  });
}

async function findNextVerificationAttemptNumber(incidentId) {
  const latest = await IncidentVerification.findOne({ incidentId })
    .sort({ attemptNumber: -1, createdAt: -1 })
    .lean();
  return Number(latest?.attemptNumber || 0) + 1;
}

async function createArtifact({
  incidentId,
  verificationId,
  artifactType,
  label,
  contentType,
  body,
}) {
  return IncidentArtifact.create({
    incidentId,
    verificationId,
    artifactType,
    stage: "verification",
    label,
    contentType,
    storageMode: "inline",
    body,
    createdByAgent: VERIFIER_AGENT_ROLE,
  });
}

function createCheck(key, required, status = "pending", details = "", attemptsOverride = null) {
  return {
    key,
    required: required === true,
    status,
    attempts:
      Number.isFinite(attemptsOverride)
        ? Number(attemptsOverride)
        : status === "pending"
          ? 0
          : status === "skipped"
            ? 0
            : 1,
    artifactId: null,
    details: compactText(details, 500),
  };
}

function updateCheck(checks, key, updates = {}) {
  const target = checks.find((entry) => entry.key === key);
  if (!target) return null;

  if (typeof updates.required === "boolean") target.required = updates.required;
  if (updates.status) target.status = updates.status;
  if (typeof updates.attempts === "number") target.attempts = updates.attempts;
  if (updates.artifactId) target.artifactId = updates.artifactId;
  if (Object.prototype.hasOwnProperty.call(updates, "details")) {
    target.details = compactText(updates.details, 500);
  }

  return target;
}

function summarizeChecks(checks = []) {
  return checks.map((check) => ({
    key: check.key,
    required: check.required,
    status: check.status,
    attempts: Number(check.attempts || 0),
    artifactId: check.artifactId || null,
    details: check.details || "",
  }));
}

function buildBlockedCoverageChecks(patch, reason) {
  const strategy = compactText(patch?.patchStrategy, 80).toLowerCase();
  const isFrontend = ["frontend_only", "fullstack"].includes(strategy);
  const isBackend = ["backend_only", "fullstack", "config_only"].includes(strategy);

  return [
    createCheck("build", true, "failed", reason, 0),
    createCheck(
      "unit_tests",
      isBackend,
      isBackend ? "failed" : "skipped",
      isBackend ? reason : "No backend unit-test scope was identified for this patch.",
      0
    ),
    createCheck(
      "integration_tests",
      isBackend,
      isBackend ? "failed" : "skipped",
      isBackend ? reason : "No backend integration-test scope was identified for this patch.",
      0
    ),
    createCheck(
      "api_replay",
      isBackend,
      isBackend ? "failed" : "skipped",
      isBackend ? reason : "No backend route or API replay scope was identified for this patch.",
      0
    ),
    createCheck(
      "ui_flow",
      isFrontend,
      isFrontend ? "failed" : "skipped",
      isFrontend ? reason : "No supported UI flow verification was required for this patch.",
      0
    ),
  ];
}

function sanitizeModuleSource(source) {
  return String(source || "")
    .replace(/^\s*import\s+[^;]+;\s*$/gm, "")
    .replace(/^\s*export\s+\{[^}]+\};?\s*$/gm, "")
    .replace(/\bexport\s+default\s+/g, "")
    .replace(/\bexport\s+(?=(async\s+function|function|class|const|let|var)\b)/g, "");
}

function runJavaScriptBuildCheck(source, relativeFile) {
  const sanitized = sanitizeModuleSource(source);
  // eslint-disable-next-line no-new-func
  new Function(sanitized);
  return {
    ok: true,
    output: `Syntax check passed for ${relativeFile}.`,
  };
}

function runNotificationUiVerification(source) {
  const checks = [
    {
      key: "style-lookup",
      label: "Looks up the shared notification style id before injecting.",
      passed: source.includes("document.getElementById(NOTIFICATION_STYLE_ID)"),
    },
    {
      key: "style-node",
      label: "Creates a style element for shared notification transitions.",
      passed: source.includes('document.createElement("style")'),
    },
    {
      key: "style-id",
      label: "Applies the shared notification style id to the style element.",
      passed: source.includes("style.id = NOTIFICATION_STYLE_ID"),
    },
    {
      key: "fade-ready",
      label: "Includes the notif-fade-ready class definition.",
      passed: source.includes(".notif-fade-ready"),
    },
    {
      key: "fade-in",
      label: "Includes the notif-fade-in class definition.",
      passed: source.includes(".notif-fade-in"),
    },
    {
      key: "append-head",
      label: "Appends the shared style element into document.head.",
      passed: source.includes("document.head.appendChild(style)"),
    },
    {
      key: "no-early-return",
      label: "No longer exits early before style registration.",
      passed: !/function\s+ensureNotificationStyles\(\)\s*\{\s*return;?\s*\}/m.test(source),
    },
  ];

  const missing = checks.filter((entry) => entry.passed !== true).map((entry) => entry.label);
  return {
    ok: missing.length === 0,
    checks,
    missing,
  };
}

function runPreferencesUiVerification(source) {
  const checks = [
    {
      key: "no-regression-marker",
      label: "The intentional preferences regression marker has been removed.",
      passed: !source.includes(PREFERENCES_REGRESSION_MARKER),
    },
    {
      key: "preferences-post",
      label: "The preferences flow posts back to /api/account/preferences.",
      passed: source.includes('fetch("/api/account/preferences", {'),
    },
    {
      key: "preferences-post-method",
      label: "The preferences flow still uses a POST request for persistence.",
      passed: source.includes('method: "POST"'),
    },
    {
      key: "preferences-body",
      label: "The preferences payload still includes email, theme, and state.",
      passed: source.includes("body: JSON.stringify({ email, theme, state })"),
    },
    {
      key: "preferences-response-guard",
      label: "The preferences flow still handles failed saves before returning.",
      passed: source.includes('showToast(data.error || "Unable to save preferences.", "err")'),
    },
    {
      key: "preferences-success-toast",
      label: "The preferences flow still confirms successful saves.",
      passed: source.includes('showToast("Preferences saved", "ok")'),
    },
  ];

  const missing = checks.filter((entry) => entry.passed !== true).map((entry) => entry.label);
  return {
    ok: missing.length === 0,
    checks,
    missing,
  };
}

async function runNotificationStyleVerification({ incident, patch, verification }) {
  const checks = [
    createCheck("build", true),
    createCheck(
      "unit_tests",
      false,
      "skipped",
      "No targeted unit test suite exists for this frontend-only patch recipe."
    ),
    createCheck(
      "integration_tests",
      false,
      "skipped",
      "No targeted integration test suite exists for this frontend-only patch recipe."
    ),
    createCheck(
      "api_replay",
      false,
      "skipped",
      "No backend route changed in this patch, so API replay is not applicable."
    ),
    createCheck("ui_flow", true),
  ];
  const artifactIds = [];
  const relativeFile = NOTIFICATION_RELATIVE_FILE;
  const targetPath = path.join(patch.worktreePath, relativeFile);

  if (!patch.worktreePath || !fs.existsSync(patch.worktreePath)) {
    return {
      status: "blocked",
      checks: buildBlockedCoverageChecks(
        patch,
        "Verification could not run because the isolated patch worktree is unavailable."
      ),
      failedCheckKeys: ["build", "ui_flow"],
      artifactIds: [],
      summary:
        "Verification could not run because the isolated patch worktree was unavailable for safe replay.",
    };
  }

  if (!fs.existsSync(targetPath)) {
    return {
      status: "blocked",
      checks: buildBlockedCoverageChecks(
        patch,
        `Verification could not locate ${relativeFile} inside the isolated patch worktree.`
      ),
      failedCheckKeys: ["build", "ui_flow"],
      artifactIds: [],
      summary: `Verification could not locate ${relativeFile} inside the isolated worktree.`,
    };
  }

  const source = fs.readFileSync(targetPath, "utf8");

  try {
    const buildResult = runJavaScriptBuildCheck(source, relativeFile);
    const buildArtifact = await createArtifact({
      incidentId: incident._id,
      verificationId: verification._id,
      artifactType: "test_output",
      label: "Build verification output",
      contentType: "text",
      body: buildResult.output,
    });
    artifactIds.push(buildArtifact._id);
    updateCheck(checks, "build", {
      status: "passed",
      attempts: 1,
      artifactId: buildArtifact._id,
      details: buildResult.output,
    });
  } catch (error) {
    const buildArtifact = await createArtifact({
      incidentId: incident._id,
      verificationId: verification._id,
      artifactType: "test_output",
      label: "Build verification output",
      contentType: "text",
      body: `Syntax check failed for ${relativeFile}: ${error?.message || "Unknown syntax error."}`,
    });
    artifactIds.push(buildArtifact._id);
    updateCheck(checks, "build", {
      status: "failed",
      attempts: 1,
      artifactId: buildArtifact._id,
      details: `Syntax check failed for ${relativeFile}.`,
    });
  }

  if (checks.find((check) => check.key === "build")?.status === "passed") {
    const uiResult = runNotificationUiVerification(source);
    const uiArtifact = await createArtifact({
      incidentId: incident._id,
      verificationId: verification._id,
      artifactType: "test_output",
      label: "UI flow verification output",
      contentType: "json",
      body: {
        relativeFile,
        checks: uiResult.checks,
        missing: uiResult.missing,
      },
    });
    artifactIds.push(uiArtifact._id);
    updateCheck(checks, "ui_flow", {
      status: uiResult.ok ? "passed" : "failed",
      attempts: 1,
      artifactId: uiArtifact._id,
      details: uiResult.ok
        ? "Static UI verification confirmed the shared notification style injection flow."
        : `Missing UI verification signals: ${uiResult.missing.join("; ")}`,
    });
  } else {
    updateCheck(checks, "ui_flow", {
      status: "failed",
      attempts: 0,
      details: "UI flow verification was blocked because the build check did not pass.",
    });
  }

  const failedCheckKeys = checks
    .filter((check) => check.required && check.status === "failed")
    .map((check) => check.key);

  return {
    status: failedCheckKeys.length ? "failed" : "passed",
    checks,
    failedCheckKeys,
    artifactIds,
    summary: failedCheckKeys.length
      ? "Verification failed because one or more required notification checks did not pass."
      : "Verification passed for the isolated notification patch candidate.",
  };
}

async function runPreferencesSaveVerification({ incident, patch, verification }) {
  const checks = [
    createCheck("build", true),
    createCheck(
      "unit_tests",
      false,
      "skipped",
      "No targeted unit test suite exists for this frontend-only patch recipe."
    ),
    createCheck(
      "integration_tests",
      false,
      "skipped",
      "No targeted integration test suite exists for this frontend-only patch recipe."
    ),
    createCheck(
      "api_replay",
      false,
      "skipped",
      "No backend route changed in this patch, so API replay is not applicable."
    ),
    createCheck("ui_flow", true),
  ];
  const artifactIds = [];
  const relativeFile = PREFERENCES_RELATIVE_FILE;
  const targetPath = path.join(patch.worktreePath, relativeFile);

  if (!patch.worktreePath || !fs.existsSync(patch.worktreePath)) {
    return {
      status: "blocked",
      checks: buildBlockedCoverageChecks(
        patch,
        "Verification could not run because the isolated patch worktree was unavailable."
      ),
      failedCheckKeys: ["build", "ui_flow"],
      artifactIds: [],
      summary:
        "Verification could not run because the isolated preferences patch worktree was unavailable for safe replay.",
    };
  }

  if (!fs.existsSync(targetPath)) {
    return {
      status: "blocked",
      checks: buildBlockedCoverageChecks(
        patch,
        `Verification could not locate ${relativeFile} inside the isolated patch worktree.`
      ),
      failedCheckKeys: ["build", "ui_flow"],
      artifactIds: [],
      summary: `Verification could not locate ${relativeFile} inside the isolated worktree.`,
    };
  }

  const source = fs.readFileSync(targetPath, "utf8");

  try {
    const buildResult = runJavaScriptBuildCheck(source, relativeFile);
    const buildArtifact = await createArtifact({
      incidentId: incident._id,
      verificationId: verification._id,
      artifactType: "test_output",
      label: "Build verification output",
      contentType: "text",
      body: buildResult.output,
    });
    artifactIds.push(buildArtifact._id);
    updateCheck(checks, "build", {
      status: "passed",
      attempts: 1,
      artifactId: buildArtifact._id,
      details: buildResult.output,
    });
  } catch (error) {
    const buildArtifact = await createArtifact({
      incidentId: incident._id,
      verificationId: verification._id,
      artifactType: "test_output",
      label: "Build verification output",
      contentType: "text",
      body: `Syntax check failed for ${relativeFile}: ${error?.message || "Unknown syntax error."}`,
    });
    artifactIds.push(buildArtifact._id);
    updateCheck(checks, "build", {
      status: "failed",
      attempts: 1,
      artifactId: buildArtifact._id,
      details: `Syntax check failed for ${relativeFile}.`,
    });
  }

  if (checks.find((check) => check.key === "build")?.status === "passed") {
    const uiResult = runPreferencesUiVerification(source);
    const uiArtifact = await createArtifact({
      incidentId: incident._id,
      verificationId: verification._id,
      artifactType: "test_output",
      label: "UI flow verification output",
      contentType: "json",
      body: {
        relativeFile,
        checks: uiResult.checks,
        missing: uiResult.missing,
      },
    });
    artifactIds.push(uiArtifact._id);
    updateCheck(checks, "ui_flow", {
      status: uiResult.ok ? "passed" : "failed",
      attempts: 1,
      artifactId: uiArtifact._id,
      details: uiResult.ok
        ? "Static UI verification confirmed the preferences save submission flow was restored."
        : `Missing UI verification signals: ${uiResult.missing.join("; ")}`,
    });
  } else {
    updateCheck(checks, "ui_flow", {
      status: "failed",
      attempts: 0,
      details: "UI flow verification was blocked because the build check did not pass.",
    });
  }

  const failedCheckKeys = checks
    .filter((check) => check.required && check.status === "failed")
    .map((check) => check.key);

  return {
    status: failedCheckKeys.length ? "failed" : "passed",
    checks,
    failedCheckKeys,
    artifactIds,
    summary: failedCheckKeys.length
      ? "Verification failed because one or more required preferences-save checks did not pass."
      : "Verification passed for the isolated preferences save patch candidate.",
  };
}

function resolveVerificationRecipe({ incident, investigation, patch }) {
  const recipe = selectPatchRecipe({ incident, investigation });
  if (!recipe) {
    return {
      supported: false,
      reason: "Verification coverage is unavailable because no trusted verification recipe matched this patch.",
    };
  }

  if (recipe.key === NOTIFICATION_RECIPE_KEY) {
    return {
      supported: true,
      key: recipe.key,
      label: recipe.label,
      run: (context) => runNotificationStyleVerification(context),
    };
  }

  if (recipe.key === PREFERENCES_RECIPE_KEY) {
    return {
      supported: true,
      key: recipe.key,
      label: recipe.label,
      run: (context) => runPreferencesSaveVerification(context),
    };
  }

  return {
    supported: false,
    reason: `Verification coverage is unavailable for patch recipe ${recipe.key}.`,
  };
}

function buildVerificationSummaryArtifactBody({
  incident,
  patch,
  verification,
  requiredChecks,
  failedCheckKeys,
}) {
  return {
    incidentId: String(incident._id),
    incidentPublicId: incident.publicId,
    patchId: patch ? String(patch._id) : "",
    verificationId: String(verification._id),
    attemptNumber: verification.attemptNumber,
    status: verification.status,
    summary: verification.summary,
    failedCheckKeys,
    requiredChecks: summarizeChecks(requiredChecks),
  };
}

async function finalizeVerificationToHumanOwner({
  incident,
  patch,
  verification,
  recorder,
  summary,
  failedCheckKeys,
  artifactIds,
}) {
  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "active";
  Object.assign(incident.orchestration, buildNextJobFields("none"));

  recorder.push({
    eventType: "verification_failed",
    actor: { type: "agent", agentRole: VERIFIER_AGENT_ROLE },
    summary,
    detail: {
      verificationId: String(verification._id),
      patchId: patch ? String(patch._id) : "",
      failedCheckKeys,
      blocked: true,
    },
    artifactIds,
  });

  await transitionIncidentState(
    incident,
    "needs_human_owner",
    "Verification could not run safely with the available coverage and requires human review.",
    recorder
  );

  clearIncidentLock(incident);
  recorder.finalize();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident });

  return {
    incident,
    verification,
    outcome: "needs_human_owner",
  };
}

async function finalizeVerificationFailure({
  incident,
  patch,
  verification,
  recorder,
  summary,
  failedCheckKeys,
  artifactIds,
}) {
  incident.userVisibleStatus = "investigating";
  incident.adminVisibleStatus = "verification_failed";
  Object.assign(incident.orchestration, buildNextJobFields("none"));

  recorder.push({
    eventType: "verification_failed",
    actor: { type: "agent", agentRole: VERIFIER_AGENT_ROLE },
    summary,
    detail: {
      verificationId: String(verification._id),
      patchId: patch ? String(patch._id) : "",
      failedCheckKeys,
      blocked: false,
    },
    artifactIds,
  });

  await transitionIncidentState(
    incident,
    "verification_failed",
    "Verification failed for the isolated patch candidate.",
    recorder
  );

  clearIncidentLock(incident);
  recorder.finalize();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident });

  return {
    incident,
    verification,
    outcome: "verification_failed",
  };
}

async function finalizeVerificationPass({
  incident,
  patch,
  verification,
  recorder,
  summary,
  artifactIds,
}) {
  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = incident.approvalState === "pending" ? "awaiting_approval" : "active";
  Object.assign(incident.orchestration, buildNextJobFields("deployment"));

  recorder.push({
    eventType: "verification_passed",
    actor: { type: "agent", agentRole: VERIFIER_AGENT_ROLE },
    summary,
    detail: {
      verificationId: String(verification._id),
      patchId: patch ? String(patch._id) : "",
    },
    artifactIds,
  });

  await transitionIncidentState(
    incident,
    "verified_release_candidate",
    "Verification passed for the isolated patch candidate.",
    recorder
  );

  clearIncidentLock(incident);
  recorder.finalize();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident });

  return {
    incident,
    verification,
    outcome: "verified_release_candidate",
  };
}

async function runVerification(incident) {
  const recorder = buildEventRecorder(incident);
  incrementStageAttempt(incident, "verification");

  const [investigation, patch] = await Promise.all([
    loadCurrentInvestigation(incident),
    loadCurrentPatch(incident),
  ]);
  const attemptNumber = await findNextVerificationAttemptNumber(incident._id);

  const verification = await IncidentVerification.create({
    incidentId: incident._id,
    patchId: patch?._id || null,
    attemptNumber,
    status: "running",
    verificationLevel: "release_candidate",
    requiredChecks: [],
    failedCheckKeys: [],
    summary: "",
    startedAt: new Date(),
    verifierAgent: VERIFIER_AGENT_ROLE,
  });

  incident.currentVerificationId = verification._id;

  recorder.push({
    eventType: "verification_started",
    actor: { type: "agent", agentRole: VERIFIER_AGENT_ROLE },
    summary: `Verification attempt ${attemptNumber} started for isolated patch review.`,
    detail: {
      verificationId: String(verification._id),
      patchId: patch ? String(patch._id) : "",
      patchStrategy: patch?.patchStrategy || "",
      worktreePath: patch?.worktreePath || "",
    },
  });

  if (!patch || !investigation) {
    const reason = !patch
      ? "Verification could not run because the incident has no patch record."
      : "Verification could not run because the latest investigation context is unavailable.";
    verification.status = "blocked";
    verification.requiredChecks = buildBlockedCoverageChecks(patch, reason);
    verification.failedCheckKeys = verification.requiredChecks
      .filter((check) => check.required && check.status === "failed")
      .map((check) => check.key);
    verification.summary = reason;
    verification.completedAt = new Date();
    await verification.save();

    const summaryArtifact = await createArtifact({
      incidentId: incident._id,
      verificationId: verification._id,
      artifactType: "coverage_summary",
      label: "Verification coverage summary",
      contentType: "json",
      body: buildVerificationSummaryArtifactBody({
        incident,
        patch,
        verification,
        requiredChecks: verification.requiredChecks,
        failedCheckKeys: verification.failedCheckKeys,
      }),
    });

    return finalizeVerificationToHumanOwner({
      incident,
      patch,
      verification,
      recorder,
      summary: reason,
      failedCheckKeys: verification.failedCheckKeys,
      artifactIds: [summaryArtifact._id],
    });
  }

  const verificationRecipe = resolveVerificationRecipe({ incident, investigation, patch });
  let verificationResult;
  if (!verificationRecipe.supported) {
    const blockedChecks = buildBlockedCoverageChecks(patch, verificationRecipe.reason);
    verificationResult = {
      status: "blocked",
      checks: blockedChecks,
      failedCheckKeys: blockedChecks
        .filter((check) => check.required && check.status === "failed")
        .map((check) => check.key),
      artifactIds: [],
      summary: verificationRecipe.reason,
    };
  } else {
    verificationResult = await verificationRecipe.run({
      incident,
      investigation,
      patch,
      verification,
    });
  }

  verification.requiredChecks = verificationResult.checks;
  verification.failedCheckKeys = normalizeStringArray(verificationResult.failedCheckKeys);
  verification.summary = compactText(verificationResult.summary, 1000);
  verification.status = verificationResult.status;
  verification.completedAt = new Date();

  const summaryArtifact = await createArtifact({
    incidentId: incident._id,
    verificationId: verification._id,
    artifactType: "coverage_summary",
    label: "Verification coverage summary",
    contentType: "json",
    body: buildVerificationSummaryArtifactBody({
      incident,
      patch,
      verification,
      requiredChecks: verification.requiredChecks,
      failedCheckKeys: verification.failedCheckKeys,
    }),
  });

  const artifactIds = [...(verificationResult.artifactIds || []), summaryArtifact._id];
  await verification.save();

  if (verification.status === "blocked") {
    return finalizeVerificationToHumanOwner({
      incident,
      patch,
      verification,
      recorder,
      summary: verification.summary,
      failedCheckKeys: verification.failedCheckKeys,
      artifactIds,
    });
  }

  if (verification.status === "failed") {
    return finalizeVerificationFailure({
      incident,
      patch,
      verification,
      recorder,
      summary: verification.summary,
      failedCheckKeys: verification.failedCheckKeys,
      artifactIds,
    });
  }

  return finalizeVerificationPass({
    incident,
    patch,
    verification,
    recorder,
    summary: verification.summary,
    artifactIds,
  });
}

module.exports = {
  runVerification,
};
