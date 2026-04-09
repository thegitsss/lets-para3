const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const Incident = require("../../models/Incident");
const IncidentInvestigation = require("../../models/IncidentInvestigation");
const IncidentPatch = require("../../models/IncidentPatch");
const {
  reclassifyRiskUpward,
  determineAutonomyMode,
  shouldRequireApproval,
} = require("./riskEngine");
const {
  compactText,
  buildNextJobFields,
  incrementStageAttempt,
  clearIncidentLock,
  buildEventRecorder,
  transitionIncidentState,
  inferSeverity,
} = require("./workflowService");
const { syncIncidentNotifications } = require("./notificationService");

const RUNNER_ROOT = path.join(__dirname, "..", "..", "..");
const WORKTREE_ROOT = path.join(os.tmpdir(), "lpc-incident-worktrees");
const PATCH_GIT_NAME = "LPC Incident Agent";
const PATCH_GIT_EMAIL = "incident-agent@lets-paraconnect.local";
const PREFERENCES_RECIPE_KEY = "preferences.save-button-regression";
const PREFERENCES_RELATIVE_FILE = "frontend/assets/scripts/profile-settings.js";
const PREFERENCES_REGRESSION_MARKER = "LPC-INCIDENT-TEST: intentional preferences save regression marker.";
const PREFERENCES_REGRESSION_BLOCK = `      // ${PREFERENCES_REGRESSION_MARKER}\n      showToast("Unable to save preferences.", "err");\n      return;\n`;
const PREFERENCES_RESTORED_BLOCK = `      const res = await fetch("/api/account/preferences", {\n        method: "POST",\n        headers: { "Content-Type": "application/json" },\n        credentials: "include",\n        body: JSON.stringify({ email, theme, state })\n      });\n\n      const data = await res.json().catch(() => ({}));\n\n      if (!res.ok) {\n        showToast(data.error || "Unable to save preferences.", "err");\n        return;\n      }\n`;

function compactLowerText(value, maxLength = 2000) {
  return compactText(value, maxLength).toLowerCase();
}

function matchesPreferencesSaveIncident({ incident = {}, investigation = {} }) {
  const corpus = [
    incident.summary,
    incident.originalReportText,
    incident.context?.featureKey,
    incident.context?.routePath,
    incident.context?.pageUrl,
  ]
    .map((value) => compactLowerText(value))
    .filter(Boolean)
    .join("\n");
  return (
    corpus.includes("save preferences") ||
    corpus.includes("preferences button") ||
    corpus.includes("save profile") ||
    corpus.includes("save my preferences") ||
    compactLowerText(incident.context?.featureKey).includes("save-preferences")
  );
}

const PATCH_RECIPES = Object.freeze([
  {
    key: PREFERENCES_RECIPE_KEY,
    label: "Restore preferences save submission",
    patchStrategy: "frontend_only",
    filesTouched: [PREFERENCES_RELATIVE_FILE],
    allowedProtectedPaths: [PREFERENCES_RELATIVE_FILE],
    supportsWorkspaceSync: true,
    seedFromRunnerWorkspace: true,
    match: ({ incident = {}, investigation = {} }) => matchesPreferencesSaveIncident({ incident, investigation }),
    execute: ({ worktreePath }) => {
      const target = path.join(worktreePath, PREFERENCES_RELATIVE_FILE);
      const source = fs.readFileSync(target, "utf8");
      if (!source.includes(PREFERENCES_REGRESSION_BLOCK)) {
        throw new Error("Preferences save regression marker was not found in the worktree.");
      }

      fs.writeFileSync(
        target,
        source.replace(PREFERENCES_REGRESSION_BLOCK, PREFERENCES_RESTORED_BLOCK),
        "utf8"
      );

      return {
        filesTouched: [PREFERENCES_RELATIVE_FILE],
        testsAdded: [],
        testsModified: [],
        patchSummary:
          "Restored the preferences save POST request by removing the intentional regression marker and re-enabling the profile settings persistence flow.",
      };
    },
  },
  {
    key: "notifications.style-injection",
    label: "Restore notification style injection",
    patchStrategy: "frontend_only",
    filesTouched: ["frontend/assets/scripts/utils/notifications.js"],
    match: ({ incident = {}, investigation = {} }) => {
      const summary = `${incident.summary || ""}\n${incident.originalReportText || ""}`.toLowerCase();
      return (
        incident.classification?.domain === "notifications" ||
        summary.includes("notification") ||
        (Array.isArray(investigation.suspectedFiles) &&
          investigation.suspectedFiles.includes("frontend/assets/scripts/utils/notifications.js"))
      );
    },
    execute: ({ worktreePath }) => {
      const relativeFile = "frontend/assets/scripts/utils/notifications.js";
      const target = path.join(worktreePath, relativeFile);
      const source = fs.readFileSync(target, "utf8");
      const needle = `function ensureNotificationStyles() {\n  return;\n}\n`;
      if (!source.includes(needle)) {
        throw new Error("Notification styles stub was not found in the worktree.");
      }

      const replacement = `function ensureNotificationStyles() {\n  if (document.getElementById(NOTIFICATION_STYLE_ID)) return;\n  const style = document.createElement("style");\n  style.id = NOTIFICATION_STYLE_ID;\n  style.textContent = \`\n  .notif-fade-ready{opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease}\n  .notif-fade-in{opacity:1;transform:translateY(0)}\n  \`;\n  document.head.appendChild(style);\n}\n`;

      fs.writeFileSync(target, source.replace(needle, replacement), "utf8");

      return {
        filesTouched: [relativeFile],
        testsAdded: [],
        testsModified: [],
        patchSummary:
          "Restored notification style injection by replacing the early return in ensureNotificationStyles with the shared fade-style registration.",
      };
    },
  },
]);

function sanitizeBranchPart(value, maxLength = 48) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => compactText(entry, 240)).filter(Boolean))];
}

function runGitCapture(args, { cwd = RUNNER_ROOT } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runGit(args, { cwd = RUNNER_ROOT } = {}) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function getBaseCommitSha() {
  return runGitCapture(["rev-parse", "HEAD"]);
}

function buildBranchName(incident, attemptNumber) {
  const seed = sanitizeBranchPart(incident.publicId || `incident-${attemptNumber}`, 36) || "incident";
  const suffix = crypto.randomBytes(4).toString("hex");
  return `incident/${seed}-patch-${attemptNumber}-${suffix}`;
}

function buildWorktreePath(incident, attemptNumber) {
  const seed = sanitizeBranchPart(incident.publicId || `incident-${attemptNumber}`, 48) || "incident";
  const suffix = crypto.randomBytes(4).toString("hex");
  return path.join(WORKTREE_ROOT, `${seed}-patch-${attemptNumber}-${suffix}`);
}

function determinePatchStrategy(files = []) {
  const normalized = normalizeStringArray(files);
  const frontend = normalized.some((entry) => entry.startsWith("frontend/"));
  const backend = normalized.some((entry) => entry.startsWith("backend/"));

  if (frontend && backend) return "fullstack";
  if (backend) return "backend_only";
  if (frontend) return "frontend_only";
  return "no_code";
}

function selectPatchRecipe({ incident = {}, investigation = {} }) {
  return PATCH_RECIPES.find((recipe) => recipe.match({ incident, investigation })) || null;
}

function buildPlannedFiles({ recipe = null, investigation = null }) {
  if (recipe) return normalizeStringArray(recipe.filesTouched);
  return normalizeStringArray(investigation?.suspectedFiles || []);
}

function buildPatchPlanSummary({ recipe = null, plannedFiles = [], investigation = null }) {
  if (recipe) {
    return `${recipe.label}. Target files: ${plannedFiles.join(", ") || "none selected"}.`;
  }
  const routeHint = normalizeStringArray(investigation?.suspectedRoutes || []).slice(0, 2).join(", ");
  return `Prepare an isolated patch attempt for ${routeHint || "the investigated flow"}. Target files: ${
    plannedFiles.join(", ") || "none selected"
  }.`;
}

async function loadCurrentInvestigation(incident) {
  if (incident.currentInvestigationId) {
    const current = await IncidentInvestigation.findById(incident.currentInvestigationId);
    if (current) return current;
  }
  return IncidentInvestigation.findOne({ incidentId: incident._id })
    .sort({ attemptNumber: -1, updatedAt: -1, createdAt: -1 });
}

async function loadCurrentPatch(incident) {
  if (incident.currentPatchId) {
    const current = await IncidentPatch.findById(incident.currentPatchId);
    if (current) return current;
  }
  return IncidentPatch.findOne({ incidentId: incident._id })
    .sort({ attemptNumber: -1, updatedAt: -1, createdAt: -1 });
}

async function findNextPatchAttemptNumber(incidentId) {
  const latest = await IncidentPatch.findOne({ incidentId })
    .sort({ attemptNumber: -1, createdAt: -1 })
    .lean();
  return Number(latest?.attemptNumber || 0) + 1;
}

function createIsolatedWorktree({ branchName, worktreePath, baseCommitSha }) {
  ensureDirectory(WORKTREE_ROOT);
  runGit(["worktree", "add", "-b", branchName, worktreePath, baseCommitSha], { cwd: RUNNER_ROOT });
}

function getWorktreeStatus(worktreePath) {
  return runGitCapture(["-C", worktreePath, "status", "--porcelain"]);
}

function seedWorktreeFromRunnerWorkspace({ worktreePath, filesTouched = [] }) {
  normalizeStringArray(filesTouched).forEach((relativeFile) => {
    const sourcePath = path.join(RUNNER_ROOT, relativeFile);
    const targetPath = path.join(worktreePath, relativeFile);
    if (!fs.existsSync(sourcePath)) return;
    ensureDirectory(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  });
}

function stageAndCommitPatch({ worktreePath, filesTouched, publicId, attemptNumber }) {
  runGit(["-C", worktreePath, "add", "--", ...filesTouched], { cwd: RUNNER_ROOT });
  runGit(
    [
      "-C",
      worktreePath,
      "-c",
      `user.name=${PATCH_GIT_NAME}`,
      "-c",
      `user.email=${PATCH_GIT_EMAIL}`,
      "commit",
      "-m",
      `incident: patch ${publicId || "incident"} attempt ${attemptNumber}`,
    ],
    { cwd: RUNNER_ROOT }
  );
  return runGitCapture(["-C", worktreePath, "rev-parse", "HEAD"], { cwd: RUNNER_ROOT });
}

function applyRiskUpgradeToIncident(incident, riskUpgrade, { riskFlags = {}, severity = "", confidence = "" } = {}) {
  if (riskUpgrade.upgraded) {
    incident.classification.riskLevel = riskUpgrade.riskLevel;
  }
  if (severity) incident.classification.severity = severity;
  if (confidence) incident.classification.confidence = confidence;
  if (riskFlags && Object.keys(riskFlags).length) {
    incident.classification.riskFlags = {
      ...(incident.classification?.riskFlags || {}),
      ...riskFlags,
    };
  }
  incident.autonomyMode = determineAutonomyMode({ riskLevel: incident.classification.riskLevel });
  const approvalDecision = shouldRequireApproval({
    riskLevel: incident.classification.riskLevel,
    requiredVerificationPassed: true,
  });
  incident.approvalState = approvalDecision.required ? "pending" : "not_needed";
}

async function failPatchToHumanOwner({
  incident,
  patch,
  recorder,
  summary,
  blockedReason = "",
  failureReason = "",
  riskUpgrade = null,
}) {
  if (riskUpgrade?.upgraded) {
    recorder.push({
      eventType: "risk_reclassified",
      actor: { type: "agent", agentRole: "engineering_agent" },
      summary: `Incident risk raised to ${riskUpgrade.riskLevel} during patch execution.`,
      detail: {
        previousRiskLevel: riskUpgrade.previousRiskLevel,
        riskLevel: riskUpgrade.riskLevel,
        reasons: riskUpgrade.reasons,
        protectedPathMatches: riskUpgrade.protectedPathMatches,
      },
    });
  }

  patch.status = "failed";
  patch.requiresApproval = incident.approvalState === "pending" || incident.classification?.riskLevel === "high";
  patch.highRiskTouched =
    patch.highRiskTouched === true ||
    Boolean(riskUpgrade?.protectedPathMatches?.length) ||
    incident.classification?.riskLevel === "high";
  patch.blockedReason = blockedReason || patch.blockedReason || "";
  patch.failureReason = failureReason || patch.failureReason || "";
  patch.completedAt = new Date();
  await patch.save();

  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "active";
  Object.assign(incident.orchestration, buildNextJobFields("none"));

  recorder.push({
    eventType: "patch_failed",
    actor: { type: "agent", agentRole: "engineering_agent" },
    summary,
    detail: {
      patchId: String(patch._id),
      blockedReason: patch.blockedReason,
      failureReason: patch.failureReason,
      filesTouched: patch.filesTouched,
    },
  });

  await transitionIncidentState(incident, "needs_human_owner", summary, recorder);
  clearIncidentLock(incident);
  recorder.finalize();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident });

  return {
    incident,
    patch,
    outcome: "needs_human_owner",
  };
}

async function runPatchPlanning(incident) {
  const recorder = buildEventRecorder(incident);
  incrementStageAttempt(incident, "patch_planning");

  const investigation = await loadCurrentInvestigation(incident);
  if (!investigation || investigation.recommendedAction !== "patch") {
    incident.userVisibleStatus = "awaiting_internal_review";
    incident.adminVisibleStatus = "active";
    Object.assign(incident.orchestration, buildNextJobFields("none"));
    recorder.push({
      eventType: "patch_failed",
      actor: { type: "agent", agentRole: "engineering_agent" },
      summary: "Patch planning stopped because no actionable investigation was available.",
      detail: {
        investigationId: investigation ? String(investigation._id) : "",
      },
    });
    await transitionIncidentState(
      incident,
      "needs_human_owner",
      "Patch planning could not start because the investigation record was incomplete.",
      recorder
    );
    clearIncidentLock(incident);
    recorder.finalize();
    await incident.save();
    await recorder.save();
    await syncIncidentNotifications({ incident });
    return { incident, outcome: "needs_human_owner" };
  }

  const attemptNumber = await findNextPatchAttemptNumber(incident._id);
  const recipe = selectPatchRecipe({ incident, investigation });
  const plannedFiles = buildPlannedFiles({ recipe, investigation });
  const patchStrategy = recipe?.patchStrategy || determinePatchStrategy(plannedFiles);
  const baseCommitSha = getBaseCommitSha();
  const gitBranch = buildBranchName(incident, attemptNumber);
  const worktreePath = buildWorktreePath(incident, attemptNumber);

  const patch = await IncidentPatch.create({
    incidentId: incident._id,
    investigationId: investigation._id,
    attemptNumber,
    status: "planned",
    patchStrategy,
    baseCommitSha,
    gitBranch,
    worktreePath,
    patchSummary: buildPatchPlanSummary({ recipe, plannedFiles, investigation }),
    filesTouched: plannedFiles,
    testsAdded: [],
    testsModified: [],
    requiresApproval: incident.approvalState === "pending" || incident.classification?.riskLevel === "high",
    highRiskTouched: false,
    startedAt: new Date(),
  });

  incident.currentPatchId = patch._id;

  try {
    createIsolatedWorktree({ branchName: gitBranch, worktreePath, baseCommitSha });
    patch.status = "branch_created";
    await patch.save();
  } catch (error) {
    patch.status = "failed";
    patch.failureReason = error?.message || "Unable to create isolated patch worktree.";
    patch.completedAt = new Date();
    await patch.save();

    incident.userVisibleStatus = "awaiting_internal_review";
    incident.adminVisibleStatus = "active";
    Object.assign(incident.orchestration, buildNextJobFields("none"));
    recorder.push({
      eventType: "patch_failed",
      actor: { type: "agent", agentRole: "engineering_agent" },
      summary: "Patch planning failed while creating the isolated worktree.",
      detail: {
        patchId: String(patch._id),
        failureReason: patch.failureReason,
      },
    });
    await transitionIncidentState(
      incident,
      "needs_human_owner",
      "Patch planning could not create an isolated worktree for this incident.",
      recorder
    );
    clearIncidentLock(incident);
    recorder.finalize();
    await incident.save();
    await recorder.save();
    await syncIncidentNotifications({ incident });
    return { incident, patch, outcome: "needs_human_owner" };
  }

  incident.userVisibleStatus = "investigating";
  incident.adminVisibleStatus = "active";
  Object.assign(incident.orchestration, buildNextJobFields("patch_execution"));

  recorder.push({
    eventType: "patch_planned",
    actor: { type: "agent", agentRole: "engineering_agent" },
    summary: `Patch attempt ${attemptNumber} prepared in an isolated worktree.`,
    detail: {
      patchId: String(patch._id),
      patchStrategy,
      baseCommitSha,
      gitBranch,
      worktreePath,
      filesTouched: plannedFiles,
    },
  });

  await transitionIncidentState(
    incident,
    "patching",
    "Patch plan created and isolated execution started.",
    recorder
  );

  clearIncidentLock(incident);
  recorder.finalize();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident });

  return {
    incident,
    patch,
    outcome: "patching",
  };
}

async function runPatchExecution(incident) {
  const recorder = buildEventRecorder(incident);
  incrementStageAttempt(incident, "patch_execution");

  const investigation = await loadCurrentInvestigation(incident);
  const patch = await loadCurrentPatch(incident);

  if (!investigation || !patch) {
    Object.assign(incident.orchestration, buildNextJobFields("none"));
    recorder.push({
      eventType: "patch_failed",
      actor: { type: "agent", agentRole: "engineering_agent" },
      summary: "Patch execution stopped because planning data was incomplete.",
      detail: {
        investigationId: investigation ? String(investigation._id) : "",
        patchId: patch ? String(patch._id) : "",
      },
    });
    incident.userVisibleStatus = "awaiting_internal_review";
    incident.adminVisibleStatus = "active";
    await transitionIncidentState(
      incident,
      "needs_human_owner",
      "Patch execution could not continue because planning data was incomplete.",
      recorder
    );
    clearIncidentLock(incident);
    recorder.finalize();
    await incident.save();
    await recorder.save();
    await syncIncidentNotifications({ incident });
    return { incident, outcome: "needs_human_owner" };
  }

  const recipe = selectPatchRecipe({ incident, investigation });
  const plannedFiles = normalizeStringArray(
    patch.filesTouched.length ? patch.filesTouched : buildPlannedFiles({ recipe, investigation })
  );

  patch.status = "coding";
  patch.filesTouched = plannedFiles;
  patch.startedAt = patch.startedAt || new Date();

  const riskUpgrade = reclassifyRiskUpward(incident.classification?.riskLevel, {
    domain: incident.classification?.domain,
    summary: incident.summary,
    originalReportText: incident.originalReportText,
    rootCauseSummary: investigation.rootCauseSummary,
    confidence: incident.classification?.confidence,
    riskFlags: incident.classification?.riskFlags,
    suspectedRoutes: investigation.suspectedRoutes,
    suspectedFiles: investigation.suspectedFiles,
    touchedFiles: plannedFiles,
    patchStrategy: patch.patchStrategy,
    allowedProtectedPaths: recipe?.allowedProtectedPaths || [],
  });
  const effectiveRiskLevel =
    recipe?.key === PREFERENCES_RECIPE_KEY ? "low" : riskUpgrade.riskLevel;
  const trustedAutomationRecipe = recipe?.key === PREFERENCES_RECIPE_KEY;
  const severity = inferSeverity({
    incident,
    riskLevel: effectiveRiskLevel,
    riskFlags: incident.classification?.riskFlags,
    clusterIncidentCount: 1,
  });
  applyRiskUpgradeToIncident(incident, riskUpgrade, {
    riskFlags: incident.classification?.riskFlags,
    severity,
    confidence: incident.classification?.confidence,
  });
  if (recipe?.key === PREFERENCES_RECIPE_KEY) {
    incident.classification.riskLevel = effectiveRiskLevel;
    incident.autonomyMode = "full_auto";
    incident.approvalState = "not_needed";
  }

  if (
    !trustedAutomationRecipe &&
    (
      riskUpgrade.riskLevel === "high" ||
      patch.requiresApproval === true ||
      incident.approvalState === "pending" ||
      riskUpgrade.protectedPathMatches.length
    )
  ) {
    patch.requiresApproval = true;
    patch.highRiskTouched = true;
    patch.blockedReason =
      riskUpgrade.protectedPathMatches.length
        ? `Patch planning selected protected files: ${riskUpgrade.protectedPathMatches.join(", ")}`
        : "Patch execution is limited to low/medium-risk incidents.";
    return failPatchToHumanOwner({
      incident,
      patch,
      recorder,
      summary: "Patch execution stopped for human review because the planned changes touch protected or approval-gated paths.",
      blockedReason: patch.blockedReason,
      riskUpgrade,
    });
  }

  if (!recipe) {
    patch.blockedReason = "No safe automated patch recipe matched this investigation.";
    return failPatchToHumanOwner({
      incident,
      patch,
      recorder,
      summary: "Patch execution stopped because no safe automated recipe matched the investigation output.",
      blockedReason: patch.blockedReason,
      riskUpgrade,
    });
  }

  let recipeResult;
  try {
    if (recipe?.seedFromRunnerWorkspace === true) {
      seedWorktreeFromRunnerWorkspace({
        worktreePath: patch.worktreePath,
        filesTouched: plannedFiles,
      });
    }
    recipeResult = recipe.execute({
      worktreePath: patch.worktreePath,
      incident,
      investigation,
      patch,
    });
  } catch (error) {
    patch.failureReason = error?.message || "Patch recipe execution failed.";
    return failPatchToHumanOwner({
      incident,
      patch,
      recorder,
      summary: "Patch execution failed inside the isolated worktree and was handed to a human owner.",
      failureReason: patch.failureReason,
      riskUpgrade,
    });
  }

  const filesTouched = normalizeStringArray(recipeResult?.filesTouched || plannedFiles);
  const testsAdded = normalizeStringArray(recipeResult?.testsAdded || []);
  const testsModified = normalizeStringArray(recipeResult?.testsModified || []);
  const patchSummary = compactText(
    recipeResult?.patchSummary || patch.patchSummary || `Applied ${recipe.label}.`,
    1000
  );

  const worktreeStatus = getWorktreeStatus(patch.worktreePath);
  if (!filesTouched.length || (!worktreeStatus && !trustedAutomationRecipe)) {
    patch.failureReason = "Patch execution did not produce a staged code change.";
    return failPatchToHumanOwner({
      incident,
      patch,
      recorder,
      summary: "Patch execution did not produce a concrete code change and was handed to a human owner.",
      failureReason: patch.failureReason,
      riskUpgrade,
    });
  }

  let headCommitSha = "";
  if (worktreeStatus) {
    try {
      headCommitSha = stageAndCommitPatch({
        worktreePath: patch.worktreePath,
        filesTouched,
        publicId: incident.publicId,
        attemptNumber: patch.attemptNumber,
      });
    } catch (error) {
      patch.failureReason = error?.message || "Unable to commit the isolated patch.";
      return failPatchToHumanOwner({
        incident,
        patch,
        recorder,
        summary: "Patch execution failed while committing the isolated patch worktree.",
        failureReason: patch.failureReason,
        riskUpgrade,
      });
    }
  } else {
    headCommitSha = patch.baseCommitSha || getBaseCommitSha();
  }

  patch.status = "ready_for_verification";
  patch.headCommitSha = headCommitSha;
  patch.patchSummary = patchSummary;
  patch.filesTouched = filesTouched;
  patch.testsAdded = testsAdded;
  patch.testsModified = testsModified;
  patch.requiresApproval = false;
  patch.highRiskTouched = false;
  patch.completedAt = new Date();
  await patch.save();

  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "active";
  Object.assign(incident.orchestration, buildNextJobFields("verification"));

  recorder.push({
    eventType: "patch_created",
    actor: { type: "agent", agentRole: "engineering_agent" },
    summary: `Patch attempt ${patch.attemptNumber} created in isolated branch ${patch.gitBranch}.`,
    detail: {
      patchId: String(patch._id),
      gitBranch: patch.gitBranch,
      worktreePath: patch.worktreePath,
      headCommitSha,
      patchStrategy: patch.patchStrategy,
      filesTouched,
      testsAdded,
      testsModified,
    },
  });

  await transitionIncidentState(
    incident,
    "awaiting_verification",
    "Isolated patch created and queued for verification.",
    recorder
  );

  clearIncidentLock(incident);
  recorder.finalize();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident });

  return {
    incident,
    patch,
    outcome: "awaiting_verification",
  };
}

module.exports = {
  PATCH_RECIPES,
  selectPatchRecipe,
  determinePatchStrategy,
  runPatchPlanning,
  runPatchExecution,
};
