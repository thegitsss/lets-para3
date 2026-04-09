const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const Incident = require("../../models/Incident");
const IncidentApproval = require("../../models/IncidentApproval");
const IncidentArtifact = require("../../models/IncidentArtifact");
const IncidentPatch = require("../../models/IncidentPatch");
const IncidentRelease = require("../../models/IncidentRelease");
const IncidentVerification = require("../../models/IncidentVerification");
const { publishApprovalDecisionEvent } = require("../approvals/eventService");
const { publishEventSafe } = require("../lpcEvents/publishEventService");
const { selectPatchRecipe } = require("./patchService");
const {
  shouldRequireApproval,
  canAutoDeploy,
  shouldTriggerRollback,
} = require("./riskEngine");
const {
  compactText,
  buildNextJobFields,
  incrementStageAttempt,
  clearIncidentLock,
  buildEventRecorder,
  transitionIncidentState,
} = require("./workflowService");
const { syncIncidentNotifications } = require("./notificationService");

const RELEASE_AGENT_ROLE = "release_agent";
const DEFAULT_PREVIEW_MODE = (process.env.INCIDENT_PREVIEW_DEPLOY_MODE || "disabled").toLowerCase();
const DEFAULT_PRODUCTION_MODE = (process.env.INCIDENT_PRODUCTION_DEPLOY_MODE || "disabled").toLowerCase();
const DEFAULT_ROLLBACK_MODE = (process.env.INCIDENT_ROLLBACK_MODE || "disabled").toLowerCase();
const HTTP_TIMEOUT_MS = Number(process.env.INCIDENT_RELEASE_HTTP_TIMEOUT_MS || 8000);
const NOTIFICATION_RECIPE_KEY = "notifications.style-injection";
const NOTIFICATION_RELATIVE_FILE = "frontend/assets/scripts/utils/notifications.js";
const PREFERENCES_RECIPE_KEY = "preferences.save-button-regression";
const PREFERENCES_RELATIVE_FILE = "frontend/assets/scripts/profile-settings.js";
const PREFERENCES_REGRESSION_MARKER = "LPC-INCIDENT-TEST: intentional preferences save regression marker.";
const WORKSPACE_SYNC_MODE = "workspace_sync";

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => compactText(entry, 240)).filter(Boolean))];
}

function truthyEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function previewMode() {
  return (process.env.INCIDENT_PREVIEW_DEPLOY_MODE || DEFAULT_PREVIEW_MODE).toLowerCase();
}

function productionMode() {
  return (process.env.INCIDENT_PRODUCTION_DEPLOY_MODE || DEFAULT_PRODUCTION_MODE).toLowerCase();
}

function rollbackMode() {
  return (process.env.INCIDENT_ROLLBACK_MODE || DEFAULT_ROLLBACK_MODE).toLowerCase();
}

function workspaceSyncRoot() {
  return path.resolve(process.env.INCIDENT_WORKSPACE_SYNC_ROOT || RUNNER_ROOT);
}

function isLocalWorkspaceSyncEligible(recipe) {
  return recipe?.supportsWorkspaceSync === true && process.env.NODE_ENV !== "production";
}

function resolveEffectivePreviewMode(recipe) {
  const configured = previewMode();
  if (configured === "disabled" && isLocalWorkspaceSyncEligible(recipe)) {
    return WORKSPACE_SYNC_MODE;
  }
  return configured;
}

function resolveEffectiveProductionMode(recipe) {
  const configured = productionMode();
  if (configured === "disabled" && isLocalWorkspaceSyncEligible(recipe)) {
    return WORKSPACE_SYNC_MODE;
  }
  return configured;
}

function resolvePatchRecipe({ incident, patch }) {
  return selectPatchRecipe({
    incident,
    investigation: {
      suspectedFiles: normalizeStringArray([
        ...(patch?.filesTouched || []),
        ...(incident?.classification?.suspectedFiles || []),
      ]),
    },
  });
}

function autoDeployEnabled() {
  return truthyEnv(process.env.INCIDENT_AUTO_DEPLOY_ENABLED);
}

function normalizeUrl(value) {
  const text = compactText(value, 500);
  return text || "";
}

function buildSyntheticDeployId(prefix, incident, attemptNumber) {
  return `${prefix}-${incident.publicId.toLowerCase()}-${attemptNumber}-${crypto.randomBytes(3).toString("hex")}`;
}

function allRequiredChecksPassed(verification) {
  if (!verification || !Array.isArray(verification.requiredChecks)) return false;
  return verification.requiredChecks
    .filter((check) => check?.required)
    .every((check) => check?.status === "passed");
}

function buildProtectedConfigDomains({ incident, patch }) {
  const touched = normalizeStringArray([
    ...(patch?.filesTouched || []),
    ...(incident.classification?.suspectedFiles || []),
  ]).map((entry) => entry.toLowerCase());

  const domains = new Set();
  if (touched.some((entry) => entry.includes("payments") || entry.includes("stripe") || entry.includes("escrow"))) {
    domains.add("payments");
  }
  if (touched.some((entry) => entry.includes("auth"))) {
    domains.add("auth");
  }
  if (touched.some((entry) => entry.includes("dispute"))) {
    domains.add("disputes");
  }
  return Array.from(domains);
}

function determinePolicyDecision({ incident, patch, verification }) {
  if (!patch || !verification || verification.status !== "passed") {
    return {
      policyDecision: "blocked",
      approvalRequired: false,
      reasons: ["verified patch context is incomplete"],
    };
  }

  const approvalDecision = shouldRequireApproval({
    riskLevel: incident.classification?.riskLevel,
    requiredVerificationPassed: verification.status === "passed",
    configDomainsTouched: buildProtectedConfigDomains({ incident, patch }),
  });

  if (approvalDecision.required) {
    return {
      policyDecision: "approval_required",
      approvalRequired: true,
      reasons: approvalDecision.reasons,
    };
  }

  return {
    policyDecision: "auto_allowed",
    approvalRequired: false,
    reasons: [],
  };
}

function resolveProductionCoverageRecipe({ patch = null }) {
  const filesTouched = normalizeStringArray(patch?.filesTouched || []).map((entry) => entry.toLowerCase());
  if (filesTouched.includes(NOTIFICATION_RELATIVE_FILE.toLowerCase())) {
    return {
      key: NOTIFICATION_RECIPE_KEY,
      label: "Notification style injection production smoke",
      smokeUrl: normalizeUrl(process.env.INCIDENT_PRODUCTION_SMOKE_URL),
    };
  }
  if (filesTouched.includes(PREFERENCES_RELATIVE_FILE.toLowerCase())) {
    return {
      key: PREFERENCES_RECIPE_KEY,
      label: "Preferences save workspace sync verification",
      smokeUrl: "",
      localWorkspaceSync: true,
      allowedProtectedPaths: [PREFERENCES_RELATIVE_FILE],
    };
  }
  return null;
}

function resolvePreviewCoverageRecipe({ patch = null, previewUrl = "" }) {
  const filesTouched = normalizeStringArray(patch?.filesTouched || []).map((entry) => entry.toLowerCase());
  if (filesTouched.includes(NOTIFICATION_RELATIVE_FILE.toLowerCase())) {
    const configuredSmokeUrl = normalizeUrl(process.env.INCIDENT_PREVIEW_SMOKE_URL);
    return {
      key: NOTIFICATION_RECIPE_KEY,
      label: "Notification style injection preview smoke",
      smokeUrl: configuredSmokeUrl || buildUrlFromBase(previewUrl, "/smoke/notifications"),
    };
  }
  if (filesTouched.includes(PREFERENCES_RELATIVE_FILE.toLowerCase())) {
    return {
      key: PREFERENCES_RECIPE_KEY,
      label: "Preferences save local workspace sync preview",
      smokeUrl: "",
      localWorkspaceSync: true,
      allowedProtectedPaths: [PREFERENCES_RELATIVE_FILE],
    };
  }
  return null;
}

function buildApprovalPacketBody({ incident, patch, verification, policyReasons }) {
  return {
    incidentPublicId: incident.publicId,
    riskLevel: incident.classification?.riskLevel || "",
    severity: incident.classification?.severity || "",
    domain: incident.classification?.domain || "",
    approvalReasons: policyReasons,
    patch: {
      id: patch ? String(patch._id) : "",
      strategy: patch?.patchStrategy || "",
      summary: patch?.patchSummary || "",
      gitBranch: patch?.gitBranch || "",
      headCommitSha: patch?.headCommitSha || "",
      filesTouched: Array.isArray(patch?.filesTouched) ? patch.filesTouched : [],
    },
    verification: {
      id: verification ? String(verification._id) : "",
      status: verification?.status || "",
      summary: verification?.summary || "",
      failedCheckKeys: Array.isArray(verification?.failedCheckKeys) ? verification.failedCheckKeys : [],
      requiredChecks: Array.isArray(verification?.requiredChecks) ? verification.requiredChecks : [],
    },
    suspectedRoutes: Array.isArray(incident.classification?.suspectedRoutes)
      ? incident.classification.suspectedRoutes
      : [],
    suspectedFiles: Array.isArray(incident.classification?.suspectedFiles)
      ? incident.classification.suspectedFiles
      : [],
  };
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

async function loadCurrentVerification(incident) {
  if (incident.currentVerificationId) {
    const current = await IncidentVerification.findById(incident.currentVerificationId);
    if (current) return current;
  }

  return IncidentVerification.findOne({ incidentId: incident._id }).sort({
    attemptNumber: -1,
    updatedAt: -1,
    createdAt: -1,
  });
}

async function loadCurrentRelease(incident) {
  if (incident.currentReleaseId) {
    const current = await IncidentRelease.findById(incident.currentReleaseId);
    if (current) return current;
  }

  return IncidentRelease.findOne({ incidentId: incident._id }).sort({
    attemptNumber: -1,
    updatedAt: -1,
    createdAt: -1,
  });
}

async function loadCurrentApproval(incident) {
  if (incident.currentApprovalId) {
    const current = await IncidentApproval.findById(incident.currentApprovalId);
    if (current) return current;
  }

  return IncidentApproval.findOne({ incidentId: incident._id }).sort({
    attemptNumber: -1,
    updatedAt: -1,
    createdAt: -1,
  });
}

async function findNextReleaseAttemptNumber(incidentId) {
  const latest = await IncidentRelease.findOne({ incidentId })
    .sort({ attemptNumber: -1, createdAt: -1 })
    .lean();
  return Number(latest?.attemptNumber || 0) + 1;
}

async function findNextApprovalAttemptNumber(incidentId) {
  const latest = await IncidentApproval.findOne({ incidentId })
    .sort({ attemptNumber: -1, createdAt: -1 })
    .lean();
  return Number(latest?.attemptNumber || 0) + 1;
}

async function createArtifact({
  incidentId,
  releaseId,
  artifactType,
  label,
  contentType,
  body,
  stage = "release",
}) {
  return IncidentArtifact.create({
    incidentId,
    releaseId,
    artifactType,
    stage,
    label,
    contentType,
    storageMode: "inline",
    body,
    createdByAgent: RELEASE_AGENT_ROLE,
  });
}

async function saveAndReturn({ incident, recorder, release = null, approval = null, outcome }) {
  clearIncidentLock(incident);
  recorder.finalize();
  if (release) await release.save();
  if (approval) await approval.save();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident, approval, release });
  return {
    incident,
    release,
    approval,
    outcome,
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_err) {
      // Preserve plain-text bodies for deploy evidence.
    }
    return {
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callWebhook({ url, payload, method = "POST" }) {
  return fetchWithTimeout(url, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });
}

function hasRealPreview(release) {
  const previewUrl = String(release?.previewUrl || "");
  return Boolean(release?.previewDeployId) && previewUrl && !previewUrl.startsWith("stub-preview://");
}

function hasRealProductionDeploy(release) {
  const productionDeployId = String(release?.productionDeployId || "");
  return (
    Boolean(productionDeployId) &&
    !productionDeployId.startsWith("prod-stub-") &&
    release?.productionAttestationStatus === "passed"
  );
}

function hasApprovalProductionScope(approval) {
  return approval?.status === "approved" && approval?.decisionScope?.allowProductionDeploy === true;
}

function hasVerifiedPreview(release) {
  return (
    release?.status === "preview_verified" &&
    release?.previewVerificationStatus === "passed" &&
    Boolean(release?.previewVerifiedAt) &&
    hasRealPreview(release)
  );
}

function normalizeLegacyPreviewStatus(release) {
  if (!release || release.status !== "preview_passed") return false;
  release.status = "preview_blocked";
  if (!release.previewVerificationStatus || release.previewVerificationStatus === "not_started") {
    release.previewVerificationStatus = "blocked";
  }
  if (!release.previewVerificationSummary) {
    release.previewVerificationSummary =
      "Legacy preview_passed status is deprecated and is not treated as verified preview evidence.";
  }
  if (!Array.isArray(release.previewVerificationChecks) || !release.previewVerificationChecks.length) {
    release.previewVerificationChecks = [
      buildPreviewCheck(
        "legacy_preview_status",
        "blocked",
        "Legacy preview_passed records are deprecated and must be re-verified before production continuation."
      ),
    ];
  }
  release.previewVerifiedAt = null;
  return true;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return ["http:", "https:"].includes(parsed.protocol);
  } catch (_error) {
    return false;
  }
}

function buildUrlFromBase(baseUrl, pathname) {
  if (!isHttpUrl(baseUrl)) return "";
  try {
    return new URL(pathname, baseUrl).toString();
  } catch (_error) {
    return "";
  }
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

function runPreferencesWorkspaceVerification(source) {
  const checks = [
    {
      key: "no-regression-marker",
      label: "The intentional preferences regression marker is absent from the live workspace file.",
      passed: !source.includes(PREFERENCES_REGRESSION_MARKER),
    },
    {
      key: "preferences-post",
      label: "The live workspace file posts to /api/account/preferences.",
      passed: source.includes('fetch("/api/account/preferences", {'),
    },
    {
      key: "preferences-post-method",
      label: "The live workspace file still uses a POST method for the save request.",
      passed: source.includes('method: "POST"'),
    },
    {
      key: "preferences-body",
      label: "The live workspace file still persists email, theme, and state.",
      passed: source.includes("body: JSON.stringify({ email, theme, state })"),
    },
    {
      key: "preferences-success-toast",
      label: "The live workspace file still confirms successful preference saves.",
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

function copyWorkspaceSyncFiles({ patch, filesTouched = [] }) {
  const copiedFiles = [];
  const root = workspaceSyncRoot();

  for (const relativeFile of normalizeStringArray(filesTouched)) {
    const sourcePath = path.join(patch.worktreePath, relativeFile);
    const targetPath = path.join(root, relativeFile);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Workspace sync could not locate ${relativeFile} inside the isolated patch worktree.`);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    copiedFiles.push(relativeFile);
  }

  return {
    root,
    copiedFiles,
  };
}

function buildPreviewCheck(key, status, details, artifactId = null) {
  return {
    key,
    status,
    details: compactText(details, 500),
    artifactId: artifactId || null,
  };
}

function normalizeCommitSha(value) {
  const text = compactText(value, 120).toLowerCase();
  if (!text) return "";
  return /^[0-9a-f]{7,64}$/i.test(text) ? text : "";
}

function commitEvidenceMatches(expectedCommitSha, providerCommitSha) {
  const expected = normalizeCommitSha(expectedCommitSha);
  const observed = normalizeCommitSha(providerCommitSha);
  if (!expected || !observed) return false;
  return expected === observed || expected.startsWith(observed) || observed.startsWith(expected);
}

function summarizePreviewChecks(checks = []) {
  return checks.map((check) => ({
    key: check.key,
    status: check.status,
    details: check.details || "",
    artifactId: check.artifactId || null,
  }));
}

function summarizeRollbackValidationChecks(checks = []) {
  return checks.map((check) => ({
    key: check.key,
    status: check.status,
    details: check.details || "",
    artifactId: check.artifactId || null,
  }));
}

function summarizeProductionAttestationChecks(checks = []) {
  return checks.map((check) => ({
    key: check.key,
    status: check.status,
    details: check.details || "",
    artifactId: check.artifactId || null,
  }));
}

function applyRollbackTargetValidation(release, { status, summary, checks }) {
  release.rollbackTargetValidationStatus = status;
  release.rollbackTargetValidationSummary = compactText(summary, 500);
  release.rollbackTargetValidationChecks = summarizeRollbackValidationChecks(checks);
}

function applyProductionAttestation(release, { status, summary, checks }) {
  release.productionAttestationStatus = status;
  release.productionAttestationSummary = compactText(summary, 500);
  release.productionAttestationChecks = summarizeProductionAttestationChecks(checks);
}

function resetRollbackTargetValidation(release) {
  release.rollbackTargetValidationStatus = "not_started";
  release.rollbackTargetValidationSummary = "";
  release.rollbackTargetValidationChecks = [];
}

function assignRollbackTarget(release, { target = "", source = "unknown" } = {}) {
  release.rollbackTargetDeployId = compactText(target, 120);
  release.rollbackTargetSource = release.rollbackTargetDeployId ? source : "unknown";
  resetRollbackTargetValidation(release);
}

function canPreparePreview({ patch, verification }) {
  return Boolean(
    patch?.headCommitSha &&
      patch?.gitBranch &&
      patch?.worktreePath &&
      verification?.status === "passed"
  );
}

function buildPreviewStubMetadata({ incident, patch, release }) {
  const previewDeployId = buildSyntheticDeployId("preview-stub", incident, release.attemptNumber);
  const baseUrl = normalizeUrl(process.env.INCIDENT_PREVIEW_BASE_URL);
  const previewUrl = baseUrl
    ? `${baseUrl.replace(/\/+$/g, "")}/${incident.publicId.toLowerCase()}`
    : `stub-preview://${incident.publicId.toLowerCase()}/attempt-${release.attemptNumber}`;

  return {
    previewDeployId,
    previewUrl,
    previewCommitSha: "",
    providerEvidence: {
      mode: "stub",
      evidenceQuality: "stub_only",
      requestedCommitSha: patch.headCommitSha || "",
      providerCommitSha: "",
      summary: "Preview preparation completed in stub mode. No real production-safe preview provider was used.",
    },
  };
}

function buildProductionStubMetadata({ incident, patch, release }) {
  return {
    productionDeployId: buildSyntheticDeployId("prod-stub", incident, release.attemptNumber),
    productionCommitSha: "",
    providerEvidence: {
      mode: "stub",
      evidenceQuality: "stub_only",
      requestedCommitSha: patch.headCommitSha || "",
      providerCommitSha: "",
      summary: "Production deploy stub mode was requested. Stub production deploys never mark incidents fixed/live.",
    },
  };
}

function buildWebhookDeployMetadata({
  kind,
  response,
  patch,
}) {
  const prefix = kind === "preview" ? "preview" : "production";
  const responseBody = typeof response.body === "object" && response.body ? response.body : {};
  const bodyDeployId = compactText(responseBody.deployId || responseBody.id, 120);
  const headerDeployId = compactText(response.headers?.["x-deploy-id"], 120);
  const rollbackTargetFromBody = compactText(
    responseBody.rollbackTargetDeployId ||
      responseBody.rollbackTargetId ||
      responseBody.previousProductionDeployId ||
      responseBody.previousDeployId,
    120
  );
  const rollbackTargetFromHeader = compactText(
    response.headers?.["x-rollback-target-id"] || response.headers?.["x-previous-deploy-id"],
    120
  );
  const deployId = bodyDeployId || headerDeployId;
  const deployIdSource = bodyDeployId
    ? "provider_response"
    : headerDeployId
      ? "provider_header"
      : "missing";
  const bodyDeployUrl = normalizeUrl(responseBody.previewUrl || responseBody.url);
  const headerDeployUrl = normalizeUrl(
    response.headers?.["x-preview-url"] ||
      response.headers?.["x-deploy-url"] ||
      response.headers?.location
  );
  const providerDeployUrl = bodyDeployUrl || headerDeployUrl;
  const deployUrlSource = bodyDeployUrl
    ? "provider_response"
    : headerDeployUrl
      ? "provider_header"
      : "missing";
  const rollbackTargetDeployId = rollbackTargetFromBody || rollbackTargetFromHeader;
  const rollbackTargetSource = rollbackTargetFromBody
    ? "provider_response"
    : rollbackTargetFromHeader
      ? "provider_header"
      : "unknown";
  const bodyCommitSha = normalizeCommitSha(
    responseBody.commitSha ||
      responseBody.commit ||
      responseBody.gitCommitSha ||
      responseBody.revision ||
      responseBody.sha ||
      responseBody.commit_id
  );
  const headerCommitSha = normalizeCommitSha(
    response.headers?.["x-deploy-commit-sha"] ||
      response.headers?.["x-commit-sha"] ||
      response.headers?.etag
  );
  const providerCommitSha = bodyCommitSha || headerCommitSha;
  const commitShaSource = bodyCommitSha
    ? "provider_response"
    : headerCommitSha
      ? "provider_header"
      : "missing";

  return {
    deployId,
    deployUrl: providerDeployUrl,
    commitSha: providerCommitSha,
    rollbackTargetDeployId,
    rollbackTargetSource,
    providerEvidence: {
      mode: "webhook",
      evidenceQuality: summarizeDeployEvidenceQuality({
        mode: "webhook",
        providerDeployId: deployId,
        providerDeployUrl,
        providerCommitSha,
      }),
      status: response.status,
      kind,
      requestedCommitSha: normalizeCommitSha(patch?.headCommitSha),
      providerDeployId: deployId,
      deployIdSource,
      providerDeployUrl,
      deployUrlSource,
      providerCommitSha,
      commitShaSource,
      rollbackTargetDeployId,
      response: response.body,
    },
  };
}

function summarizeDeployEvidenceQuality({
  mode = "",
  providerDeployId = "",
  providerDeployUrl = "",
  providerCommitSha = "",
} = {}) {
  if (mode === "stub") return "stub_only";
  const hasDeployId = Boolean(compactText(providerDeployId, 120));
  const hasDeployUrl = isHttpUrl(providerDeployUrl);
  const hasCommitSha = Boolean(normalizeCommitSha(providerCommitSha));

  if (hasDeployId && hasDeployUrl && hasCommitSha) return "deploy_id_url_commit";
  if (hasDeployId && hasCommitSha) return "deploy_id_and_commit";
  if (hasDeployId && hasDeployUrl) return "deploy_id_and_url";
  if (hasDeployId) return "deploy_id_only";
  if (mode === "webhook") return "webhook_ack_only";
  return "none";
}

function describeDeployEvidenceQuality(quality = "") {
  switch (quality) {
    case "stub_only":
      return "stub-only evidence";
    case "webhook_ack_only":
      return "webhook acknowledgement only";
    case "deploy_id_only":
      return "provider deploy id only";
    case "deploy_id_and_url":
      return "provider deploy id and URL";
    case "deploy_id_and_commit":
      return "provider deploy id and commit";
    case "deploy_id_url_commit":
      return "provider deploy id, URL, and commit";
    case "workspace_sync":
      return "local workspace sync evidence";
    default:
      return "no deploy-specific evidence";
  }
}

function previewEvidenceQualityIsAcceptable(quality = "") {
  return quality === "deploy_id_url_commit" || quality === "workspace_sync";
}

function productionEvidenceQualityIsAcceptable(quality = "") {
  return quality === "deploy_id_and_commit" || quality === "deploy_id_url_commit" || quality === "workspace_sync";
}

function buildCommitAttestationCheck({
  expectedCommitSha,
  providerCommitSha,
  deployArtifactId = null,
  label = "Deploy",
}) {
  const expected = normalizeCommitSha(expectedCommitSha);
  const observed = normalizeCommitSha(providerCommitSha);
  if (!expected) {
    return buildPreviewCheck(
      "provider_commit_sha",
      "blocked",
      `${label} commit attestation could not be evaluated because the requested patch commit is missing.`,
      deployArtifactId
    );
  }
  if (!observed) {
    return buildPreviewCheck(
      "provider_commit_sha",
      "blocked",
      `${label} provider did not return a deploy-specific commit sha, so deploy identity cannot be trusted.`,
      deployArtifactId
    );
  }
  if (!commitEvidenceMatches(expected, observed)) {
    return buildPreviewCheck(
      "provider_commit_sha",
      "failed",
      `${label} provider commit ${observed} does not match requested patch commit ${expected}.`,
      deployArtifactId
    );
  }
  return buildPreviewCheck(
    "provider_commit_sha",
    "passed",
    `${label} provider commit ${observed} matches the requested patch commit ${expected}.`,
    deployArtifactId
  );
}

function validatePreviewProviderEvidence({
  metadata,
  patch,
  previewArtifactId = null,
  deployArtifactId = null,
}) {
  const evidenceQuality = compactText(metadata?.providerEvidence?.evidenceQuality, 40) || "none";
  const commitCheck = buildCommitAttestationCheck({
    expectedCommitSha: patch?.headCommitSha,
    providerCommitSha: metadata?.providerEvidence?.providerCommitSha,
    deployArtifactId,
    label: "Preview",
  });
  const checks = [
    buildPreviewCheck(
      "provider_deploy_id",
      metadata?.providerEvidence?.providerDeployId ? "passed" : "blocked",
      metadata?.providerEvidence?.providerDeployId
        ? `Preview deploy id was returned by ${metadata.providerEvidence.deployIdSource.replace("_", " ")} evidence.`
        : "Preview provider did not return a deploy-specific id, so preview verification cannot be trusted.",
      deployArtifactId
    ),
    buildPreviewCheck(
      "preview_url",
      isHttpUrl(metadata?.deployUrl) ? "passed" : "blocked",
      isHttpUrl(metadata?.deployUrl)
        ? `Preview URL is valid: ${metadata.deployUrl}`
        : "Preview URL is missing or invalid for verification.",
      previewArtifactId
    ),
    buildPreviewCheck(
      "provider_evidence_quality",
      previewEvidenceQualityIsAcceptable(evidenceQuality) ? "passed" : "blocked",
      previewEvidenceQualityIsAcceptable(evidenceQuality)
        ? `Preview evidence quality is acceptable: ${describeDeployEvidenceQuality(evidenceQuality)}.`
        : `Preview evidence quality is insufficient: ${describeDeployEvidenceQuality(evidenceQuality)}.`,
      deployArtifactId
    ),
    commitCheck,
  ];

  const valid =
    previewEvidenceQualityIsAcceptable(evidenceQuality) &&
    Boolean(metadata?.providerEvidence?.providerDeployId) &&
    isHttpUrl(metadata?.deployUrl) &&
    commitCheck.status === "passed";
  const failed = commitCheck.status === "failed";
  return {
    valid,
    status: failed ? "failed" : "blocked",
    summary: valid
      ? "Preview deploy provider returned deploy-specific id, URL, and commit evidence that can be verified."
      : failed
        ? "Preview deploy evidence conflicts with the requested patch commit and cannot be trusted."
        : "Preview deploy evidence is incomplete and cannot be treated as a verified preview.",
    checks,
  };
}

function validateProductionDeployEvidence({ metadata, patch, deployArtifactId = null }) {
  const evidenceQuality = compactText(metadata?.providerEvidence?.evidenceQuality, 40) || "none";
  const commitCheck = buildCommitAttestationCheck({
    expectedCommitSha: patch?.headCommitSha,
    providerCommitSha: metadata?.providerEvidence?.providerCommitSha,
    deployArtifactId,
    label: "Production",
  });
  const checks = [
    buildPreviewCheck(
      "provider_deploy_id",
      metadata?.providerEvidence?.providerDeployId ? "passed" : "blocked",
      metadata?.providerEvidence?.providerDeployId
        ? `Production deploy id was returned by ${metadata.providerEvidence.deployIdSource.replace("_", " ")} evidence.`
        : "Production provider did not return a deploy-specific id, so automatic production continuation cannot be trusted.",
      deployArtifactId
    ),
    buildPreviewCheck(
      "provider_deploy_url",
      metadata?.providerEvidence?.providerDeployUrl ? "passed" : "skipped",
      metadata?.providerEvidence?.providerDeployUrl
        ? `Provider returned deploy URL evidence from ${metadata.providerEvidence.deployUrlSource.replace("_", " ")}.`
        : "Provider did not return a deploy-specific URL. Automatic continuation relies on deploy id attestation plus post-deploy checks.",
      deployArtifactId
    ),
    buildPreviewCheck(
      "provider_evidence_quality",
      productionEvidenceQualityIsAcceptable(evidenceQuality) ? "passed" : "blocked",
      productionEvidenceQualityIsAcceptable(evidenceQuality)
        ? `Production evidence quality is acceptable: ${describeDeployEvidenceQuality(evidenceQuality)}.`
        : `Production evidence quality is insufficient: ${describeDeployEvidenceQuality(evidenceQuality)}.`,
      deployArtifactId
    ),
    commitCheck,
  ];

  const valid =
    productionEvidenceQualityIsAcceptable(evidenceQuality) &&
    Boolean(metadata?.providerEvidence?.providerDeployId) &&
    commitCheck.status === "passed";
  const failed = commitCheck.status === "failed";
  return {
    valid,
    status: failed ? "failed" : "blocked",
    summary: valid
      ? "Production deploy is attested by provider-returned deploy-specific id and commit evidence."
      : failed
        ? "Production deploy evidence conflicts with the requested patch commit and cannot be trusted for automatic continuation."
        : "Production deploy evidence is incomplete and cannot be trusted for automatic continuation.",
    checks,
  };
}

async function validateRollbackTargetForProduction({ release }) {
  const checks = [];
  const mode = rollbackMode();
  const rollbackUrl = normalizeUrl(process.env.INCIDENT_PRODUCTION_ROLLBACK_WEBHOOK_URL);
  const target = compactText(release?.rollbackTargetDeployId, 120);
  const source = compactText(release?.rollbackTargetSource, 40) || "unknown";
  const configuredBaseline = compactText(process.env.INCIDENT_RELEASE_BASELINE_ID, 120);

  checks.push(
    buildPreviewCheck(
      "rollback_mode",
      mode === "webhook" ? "passed" : "blocked",
      mode === "webhook"
        ? "Rollback mode is configured for webhook execution."
        : `Rollback mode "${mode || "disabled"}" cannot validate or execute automated rollback safely.`
    )
  );
  if (mode !== "webhook") {
    return {
      valid: false,
      status: "blocked",
      summary: `Rollback mode "${mode || "disabled"}" cannot validate an operational rollback target.`,
      checks,
    };
  }

  checks.push(
    buildPreviewCheck(
      "rollback_provider",
      rollbackUrl ? "passed" : "blocked",
      rollbackUrl
        ? "Rollback webhook configuration is present."
        : "Rollback webhook configuration is missing."
    )
  );
  if (!rollbackUrl) {
    return {
      valid: false,
      status: "blocked",
      summary: "Rollback webhook configuration is missing, so automated rollback target validation cannot be trusted.",
      checks,
    };
  }

  checks.push(
    buildPreviewCheck(
      "rollback_target_present",
      target ? "passed" : "blocked",
      target
        ? `Rollback target candidate is present: ${target}`
        : configuredBaseline
          ? "Only INCIDENT_RELEASE_BASELINE_ID is configured, which is not treated as validated rollback evidence."
          : "No rollback target has been recorded."
    )
  );
  if (!target) {
    return {
      valid: false,
      status: "blocked",
      summary: configuredBaseline
        ? "A configured baseline id exists, but baseline-only rollback targets are not trusted for production continuation."
        : "Rollback target is missing.",
      checks,
    };
  }

  checks.push(
    buildPreviewCheck(
      "rollback_target_source",
      ["provider_response", "provider_header"].includes(source) ? "passed" : "blocked",
      ["provider_response", "provider_header"].includes(source)
        ? `Rollback target was attested by ${source.replace("_", " ")} evidence.`
        : `Rollback target source "${source}" is not provider-attested enough for production continuation.`
    )
  );
  if (!["provider_response", "provider_header"].includes(source)) {
    return {
      valid: false,
      status: "blocked",
      summary: "Rollback target is not provider-attested, so production continuation remains blocked.",
      checks,
    };
  }

  const corroboratingRelease = await IncidentRelease.findOne({
    _id: { $ne: release?._id || null },
    productionDeployId: target,
    status: "succeeded",
  })
    .sort({ deployedAt: -1, updatedAt: -1, createdAt: -1 })
    .lean();
  const latestTrustedRelease = await IncidentRelease.findOne({
    _id: { $ne: release?._id || null },
    status: "succeeded",
    productionAttestationStatus: "passed",
    smokeStatus: "passed",
    deployedAt: { $ne: null },
    rollbackAt: null,
    deployProvider: release?.deployProvider || "render",
    productionDeployId: { $exists: true, $ne: "" },
  })
    .sort({ deployedAt: -1, updatedAt: -1, createdAt: -1 })
    .lean();

  if (configuredBaseline && target === configuredBaseline) {
    checks.push(
      buildPreviewCheck(
        "rollback_target_baseline",
        corroboratingRelease ? "passed" : "blocked",
        corroboratingRelease
          ? "Rollback target matches INCIDENT_RELEASE_BASELINE_ID but is corroborated by a prior successful production release."
          : "Rollback target matches INCIDENT_RELEASE_BASELINE_ID and is not trusted until it is corroborated by a prior successful production release."
      )
    );
  }

  checks.push(
    buildPreviewCheck(
      "rollback_target_history",
      corroboratingRelease ? "passed" : "blocked",
      corroboratingRelease
        ? `Rollback target matches prior successful release ${String(corroboratingRelease._id)}.`
        : "Rollback target does not match any prior successful production release recorded by the incident system."
    )
  );
  if (!corroboratingRelease) {
    return {
      valid: false,
      status: "blocked",
      summary:
        "Rollback target is not corroborated by a prior successful production release, so production continuation remains blocked.",
      checks,
    };
  }

  checks.push(
    buildPreviewCheck(
      "rollback_target_attested_release",
      corroboratingRelease?.productionAttestationStatus === "passed" ? "passed" : "blocked",
      corroboratingRelease?.productionAttestationStatus === "passed"
        ? "Rollback target maps to a prior production release with passed deploy attestation."
        : "Rollback target does not map to a prior production release with passed deploy attestation."
    )
  );
  if (corroboratingRelease?.productionAttestationStatus !== "passed") {
    return {
      valid: false,
      status: "blocked",
      summary:
        "Rollback target is not backed by a prior production release with passed deploy attestation, so production continuation remains blocked.",
      checks,
    };
  }

  checks.push(
    buildPreviewCheck(
      "rollback_target_smoke",
      corroboratingRelease?.smokeStatus === "passed" ? "passed" : "blocked",
      corroboratingRelease?.smokeStatus === "passed"
        ? "Rollback target maps to a prior production release with passed post-deploy smoke checks."
        : "Rollback target does not map to a prior production release with passed post-deploy smoke checks."
    )
  );
  if (corroboratingRelease?.smokeStatus !== "passed") {
    return {
      valid: false,
      status: "blocked",
      summary:
        "Rollback target is not backed by a prior production release with passed post-deploy smoke checks, so production continuation remains blocked.",
      checks,
    };
  }

  checks.push(
    buildPreviewCheck(
      "rollback_target_deployed",
      Boolean(corroboratingRelease?.deployedAt) ? "passed" : "blocked",
      corroboratingRelease?.deployedAt
        ? "Rollback target maps to a prior production release with a recorded deploy timestamp."
        : "Rollback target does not map to a prior production release with a recorded deploy timestamp."
    )
  );
  if (!corroboratingRelease?.deployedAt) {
    return {
      valid: false,
      status: "blocked",
      summary:
        "Rollback target is not backed by a prior production release with a recorded deploy timestamp, so production continuation remains blocked.",
      checks,
    };
  }

  checks.push(
    buildPreviewCheck(
      "rollback_target_provider_match",
      (corroboratingRelease?.deployProvider || "") === (release?.deployProvider || "render")
        ? "passed"
        : "blocked",
      (corroboratingRelease?.deployProvider || "") === (release?.deployProvider || "render")
        ? "Rollback target matches the current deploy provider."
        : "Rollback target does not match the current deploy provider."
    )
  );
  if ((corroboratingRelease?.deployProvider || "") !== (release?.deployProvider || "render")) {
    return {
      valid: false,
      status: "blocked",
      summary:
        "Rollback target is not backed by a prior production release on the same deploy provider, so production continuation remains blocked.",
      checks,
    };
  }

  checks.push(
    buildPreviewCheck(
      "rollback_target_latest_trusted",
      latestTrustedRelease?.productionDeployId === target ? "passed" : "blocked",
      latestTrustedRelease?.productionDeployId === target
        ? "Rollback target matches the latest known good production release recorded by the incident system."
        : latestTrustedRelease?.productionDeployId
          ? `Rollback target does not match the latest known good production release (${latestTrustedRelease.productionDeployId}).`
          : "The incident system cannot confirm a latest known good production release for this provider."
    )
  );
  if (latestTrustedRelease?.productionDeployId !== target) {
    return {
      valid: false,
      status: "blocked",
      summary:
        "Rollback target does not match the latest known good production release recorded by the incident system, so production continuation remains blocked.",
      checks,
    };
  }

  if (release?.productionDeployId && target === compactText(release.productionDeployId, 120)) {
    checks.push(
      buildPreviewCheck(
        "rollback_target_not_current",
        "failed",
        "Rollback target cannot be the same as the current production deploy id."
      )
    );
    return {
      valid: false,
      status: "failed",
      summary: "Rollback target cannot point at the same deploy that is currently being released.",
      checks,
    };
  }

  checks.push(
    buildPreviewCheck(
      "rollback_target_not_current",
      "passed",
      "Rollback target is distinct from the current production deploy."
    )
  );

  return {
    valid: true,
    status: "passed",
    summary:
      "Rollback target is provider-attested, maps to the latest known good production release, and is usable for automated rollback.",
    checks,
  };
}

async function createApprovalForRelease({
  incident,
  release,
  patch,
  verification,
  policyReasons,
  recorder,
}) {
  const packetArtifact = await createArtifact({
    incidentId: incident._id,
    releaseId: release._id,
    artifactType: "approval_packet",
    label: "Founder approval packet",
    contentType: "json",
    body: buildApprovalPacketBody({ incident, patch, verification, policyReasons }),
  });

  const approval = await IncidentApproval.create({
    incidentId: incident._id,
    attemptNumber: await findNextApprovalAttemptNumber(incident._id),
    approvalType: "production_deploy",
    status: "pending",
    requiredByPolicy: true,
    requestedAt: new Date(),
    releaseId: release._id,
    packetArtifactId: packetArtifact._id,
  });

  release.status = "awaiting_founder_approval";
  incident.currentApprovalId = approval._id;
  incident.approvalState = "pending";
  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "awaiting_approval";
  Object.assign(incident.orchestration, buildNextJobFields("none"));

  recorder.push({
    eventType: "approval_requested",
    actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
    summary: "Founder approval is required before this verified incident can move toward production release.",
    detail: {
      releaseId: String(release._id),
      approvalId: String(approval._id),
      policyReasons,
    },
    artifactIds: [packetArtifact._id],
  });

  await transitionIncidentState(
    incident,
    "awaiting_founder_approval",
    "Founder approval is required before production release can continue.",
    recorder
  );

  await publishEventSafe({
    eventType: "approval.requested",
    eventFamily: "approval",
    idempotencyKey: `incident-approval:${approval._id}:requested`,
    correlationId: `incident:${incident._id}`,
    actor: {
      actorType: "agent",
      role: "system",
      label: "Incident Release Service",
    },
    subject: {
      entityType: "incident_approval",
      entityId: String(approval._id),
      publicId: incident.publicId || "",
    },
    related: {
      incidentId: incident._id,
      caseId: incident.context?.caseId || null,
      approvalTaskId: null,
    },
    source: {
      surface: "system",
      route: "",
      service: "incidents",
      producer: "service",
    },
    facts: {
      title: `Founder approval requested for ${incident.publicId || "incident"}`,
      summary: "Founder approval is required before production release can continue.",
      approvalTargetType: "incident_approval",
      approvalTargetId: String(approval._id),
      ownerLabel: "Samantha",
      incidentPublicId: incident.publicId || "",
      policyReasons,
    },
    signals: {
      confidence: "high",
      priority: "urgent",
      founderVisible: true,
      approvalRequired: true,
      moneyRisk: incident.classification?.riskFlags?.affectsMoney === true,
      authRisk: incident.classification?.riskFlags?.affectsAuth === true,
    },
  });

  return { approval, packetArtifact };
}

async function ensureReleaseCandidateRecord({ incident, patch, verification }) {
  let release = await loadCurrentRelease(incident);
  if (release) return release;

  const attemptNumber = await findNextReleaseAttemptNumber(incident._id);
  release = await IncidentRelease.create({
    incidentId: incident._id,
    verificationId: verification?._id || null,
    attemptNumber,
    status: "awaiting_policy_check",
    policyDecision: "blocked",
    deployProvider: "render",
    previewCommitSha: "",
    smokeStatus: "pending",
  });

  incident.currentReleaseId = release._id;
  return release;
}

async function decideIncidentApproval({
  incidentIdentifier,
  approvalId,
  decision,
  actor,
  note = "",
  scope = null,
}) {
  const incidentQuery = compactText(incidentIdentifier, 120);
  const approvalQuery = compactText(approvalId, 120);
  const nextDecision = String(decision || "").trim().toLowerCase();
  if (!["approve", "reject"].includes(nextDecision)) {
    const error = new Error("A valid approval decision is required.");
    error.statusCode = 400;
    throw error;
  }

  const incident = await Incident.findOne(
    mongoose.isValidObjectId(incidentQuery)
      ? {
          $or: [{ publicId: incidentQuery }, { _id: incidentQuery }],
        }
      : { publicId: incidentQuery }
  );
  if (!incident) {
    const error = new Error("Incident not found.");
    error.statusCode = 404;
    throw error;
  }

  const approval = await IncidentApproval.findOne({
    _id: approvalQuery,
    incidentId: incident._id,
  });
  if (!approval) {
    const error = new Error("Approval record not found.");
    error.statusCode = 404;
    throw error;
  }
  if (approval.status !== "pending") {
    const error = new Error("Only pending approvals can be decided.");
    error.statusCode = 409;
    throw error;
  }

  const release = approval.releaseId ? await IncidentRelease.findById(approval.releaseId) : null;
  const recorder = buildEventRecorder(incident);
  const actorRole = actor?.role || "admin";
  const decisionRole = actor?.decisionRole || "founder_approver";
  const decisionAt = new Date();

  approval.status = nextDecision === "approve" ? "approved" : "rejected";
  approval.decisionByUserId = actor?.userId || null;
  approval.decisionByEmail = compactText(actor?.email, 240);
  approval.decisionRole = decisionRole;
  approval.decisionNote = compactText(note, 1000);
  approval.decisionScope = scope || {
    allowProductionDeploy: nextDecision === "approve",
    allowUserResolution: false,
    allowManualRepair: false,
  };
  approval.decidedAt = decisionAt;

  if (nextDecision === "approve") {
    incident.approvalState = "approved";
    incident.userVisibleStatus = "awaiting_internal_review";
    incident.adminVisibleStatus = "active";
    const allowProductionDeploy = approval.decisionScope?.allowProductionDeploy === true;
    Object.assign(
      incident.orchestration,
      allowProductionDeploy ? buildNextJobFields("deployment") : buildNextJobFields("none")
    );
    if (release) {
      release.status = allowProductionDeploy ? "queued" : "blocked";
      await release.save();
    }

    if (allowProductionDeploy) {
      await transitionIncidentState(
        incident,
        "verified_release_candidate",
        "Founder approval granted. Release candidate re-queued for preview and production continuation.",
        recorder,
        { founderApprovalGranted: true }
      );
    } else {
      await transitionIncidentState(
        incident,
        "needs_human_owner",
        "Founder approval granted manual review only. Automatic production continuation remains blocked.",
        recorder
      );
    }

    recorder.push({
      eventType: "approval_granted",
      actor: { type: "admin", userId: actor?.userId || null, role: actorRole },
      summary: "Founder approval granted for production release continuation.",
      detail: {
        approvalId: String(approval._id),
        releaseId: release ? String(release._id) : "",
        note: approval.decisionNote,
        decisionRole,
        allowProductionDeploy,
      },
    });
  } else {
    incident.approvalState = "rejected";
    incident.userVisibleStatus = "awaiting_internal_review";
    incident.adminVisibleStatus = "active";
    Object.assign(incident.orchestration, buildNextJobFields("none"));
    if (release) {
      release.status = "blocked";
      await release.save();
    }

    recorder.push({
      eventType: "approval_rejected",
      actor: { type: "admin", userId: actor?.userId || null, role: actorRole },
      summary: "Founder approval rejected the release candidate.",
      detail: {
        approvalId: String(approval._id),
        releaseId: release ? String(release._id) : "",
        note: approval.decisionNote,
        decisionRole,
      },
    });

    await transitionIncidentState(
      incident,
      "needs_human_owner",
      "Founder approval rejected automatic production release and sent the incident to manual review.",
      recorder
    );
  }

  clearIncidentLock(incident);
  recorder.finalize();
  await approval.save();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident, approval, release });

  await publishApprovalDecisionEvent({
    decision: nextDecision === "approve" ? "approved" : "rejected",
    approvalRecordType: "incident_approval",
    approvalRecordId: String(approval._id),
    approvalTargetType: "incident_approval",
    approvalTargetId: String(approval._id),
    title: `Incident approval ${nextDecision === "approve" ? "approved" : "rejected"}: ${incident.publicId || "incident"}`,
    summary:
      nextDecision === "approve"
        ? "Founder approval decision recorded for the incident release workflow."
        : "Founder rejection recorded for the incident release workflow.",
    actor: {
      actorType: "user",
      userId: actor?.userId || null,
      role: actorRole,
      email: actor?.email || "",
      label: actor?.email || "Admin",
    },
    related: {
      incidentId: incident._id,
    },
    service: "incidents",
    sourceSurface: "admin",
    route: `/api/admin/incidents/${incident.publicId || incident._id}/approval`,
    correlationId: `incident:${incident._id}`,
    founderVisible: true,
    publicFacing: false,
    priority: "urgent",
    metadata: {
      releaseId: release ? String(release._id) : "",
      decisionRole,
      allowProductionDeploy: approval.decisionScope?.allowProductionDeploy === true,
    },
  });

  return {
    incident,
    approval,
    release,
  };
}

function buildDeployPayload({ incident, release, patch, approval }) {
  return {
    incidentPublicId: incident.publicId,
    releaseAttempt: release.attemptNumber,
    branch: patch?.gitBranch || "",
    commitSha: patch?.headCommitSha || "",
    approvalId: approval ? String(approval._id) : "",
    riskLevel: incident.classification?.riskLevel || "",
  };
}

async function finalizePreviewReturnToCandidate({
  incident,
  release,
  recorder,
  summary,
}) {
  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "active";
  Object.assign(incident.orchestration, buildNextJobFields("none"));

  await transitionIncidentState(
    incident,
    "verified_release_candidate",
    summary,
    recorder,
    { previewPreparedOnly: true }
  );

  return saveAndReturn({
    incident,
    release,
    recorder,
    outcome: "verified_release_candidate",
  });
}

async function finalizeNeedsHumanOwner({
  incident,
  release,
  approval = null,
  recorder,
  summary,
}) {
  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "active";
  Object.assign(incident.orchestration, buildNextJobFields("none"));

  if (incident.state !== "needs_human_owner") {
    await transitionIncidentState(
      incident,
      "needs_human_owner",
      summary,
      recorder
    );
  }

  return saveAndReturn({
    incident,
    release,
    approval,
    recorder,
    outcome: "needs_human_owner",
  });
}

async function finalizeDeployFailed({
  incident,
  release,
  recorder,
  summary,
}) {
  incident.userVisibleStatus = "awaiting_internal_review";
  incident.adminVisibleStatus = "deploy_failed";
  Object.assign(incident.orchestration, buildNextJobFields("none"));

  if (incident.state !== "deploy_failed") {
    await transitionIncidentState(incident, "deploy_failed", summary, recorder);
  }

  return saveAndReturn({
    incident,
    release,
    recorder,
    outcome: "deploy_failed",
  });
}

async function runPreviewHealthChecks({ previewUrl = "" }) {
  const configuredUrl = normalizeUrl(process.env.INCIDENT_PREVIEW_HEALTH_URL);
  const healthUrl = configuredUrl || buildUrlFromBase(previewUrl, "/api/health");
  const results = [];

  if (!healthUrl) {
    return {
      available: false,
      passed: false,
      failures: 0,
      results,
      reason: "Preview health URL is unavailable.",
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchWithTimeout(healthUrl, { method: "GET" });
      const passed = response.ok;
      results.push({
        url: healthUrl,
        status: response.status,
        passed,
        body: response.body,
      });
      if (passed) break;
    } catch (error) {
      results.push({
        url: healthUrl,
        status: 0,
        passed: false,
        body: { error: error?.message || "Preview health request failed." },
      });
    }
  }

  const failures = results.filter((entry) => entry.passed !== true).length;
  return {
    available: true,
    passed: results.some((entry) => entry.passed === true),
    failures,
    results,
    reason: "",
  };
}

async function runPreviewSmokeChecks({ coverageRecipe = null }) {
  const results = [];
  if (!coverageRecipe) {
    return {
      available: false,
      passed: false,
      failures: 0,
      results,
      reason: "No supported preview smoke recipe matched this patch.",
    };
  }
  if (!coverageRecipe.smokeUrl) {
    return {
      available: false,
      passed: false,
      failures: 0,
      results,
      reason: "Preview smoke URL is not configured.",
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchWithTimeout(coverageRecipe.smokeUrl, { method: "GET" });
      const passed = response.ok;
      results.push({
        url: coverageRecipe.smokeUrl,
        status: response.status,
        passed,
        body: response.body,
      });
      if (passed) break;
    } catch (error) {
      results.push({
        url: coverageRecipe.smokeUrl,
        status: 0,
        passed: false,
        body: { error: error?.message || "Preview smoke request failed." },
      });
    }
  }

  const failures = results.filter((entry) => entry.passed !== true).length;
  return {
    available: true,
    passed: results.some((entry) => entry.passed === true),
    failures,
    results,
    reason: "",
  };
}

function applyPreviewVerification(release, { status, summary, checks, verifiedAt = null }) {
  release.previewVerificationStatus = status;
  release.previewVerificationSummary = compactText(summary, 500);
  release.previewVerificationChecks = summarizePreviewChecks(checks);
  release.previewVerifiedAt = verifiedAt || null;
}

async function finalizePreviewVerification({
  incident,
  release,
  approval = null,
  patch = null,
  recorder,
  previewArtifactId = null,
  deployArtifactId = null,
  previewUrl,
  providerEvidence,
  summaryPrefix,
}) {
  const evidence = validatePreviewProviderEvidence({
    metadata: { deployUrl: previewUrl, providerEvidence },
    patch,
    previewArtifactId,
    deployArtifactId,
  });
  const checks = [...evidence.checks];

  if (!evidence.valid) {
    release.status = evidence.status === "failed" ? "preview_failed" : "preview_blocked";
    applyPreviewVerification(release, {
      status: evidence.status,
      summary: `${summaryPrefix} ${evidence.summary}`,
      checks,
    });
    await release.save();
    return approval?.status === "approved"
      ? finalizeNeedsHumanOwner({
          incident,
          release,
          approval,
          recorder,
          summary: `${evidence.summary} Production release remains blocked pending manual review.`,
        })
      : finalizePreviewReturnToCandidate({
          incident,
          release,
          recorder,
          summary: `${evidence.summary} The incident remains blocked until preview verification can run.`,
        });
  }

  const health = await runPreviewHealthChecks({ previewUrl });
  const coverageRecipe = resolvePreviewCoverageRecipe({ patch, previewUrl });
  const smoke = await runPreviewSmokeChecks({ coverageRecipe });

  const healthArtifact = await createArtifact({
    incidentId: incident._id,
    releaseId: release._id,
    artifactType: "health_snapshot",
    label: "Preview health snapshot",
    contentType: "json",
    body: {
      available: health.available,
      passed: health.passed,
      results: health.results,
    },
  });

  const summaryArtifact = await createArtifact({
    incidentId: incident._id,
    releaseId: release._id,
    artifactType: "coverage_summary",
    label: "Preview verification summary",
    contentType: "json",
    body: {
      previewUrl,
      health,
      smoke,
      providerEvidence,
    },
  });

  checks.push(
    buildPreviewCheck(
      "preview_health",
      !health.available ? "blocked" : health.passed ? "passed" : "failed",
      !health.available
        ? health.reason || "Preview health check is unavailable."
        : health.passed
          ? "Preview health check passed."
          : "Preview health check failed.",
      healthArtifact._id
    )
  );
  checks.push(
    buildPreviewCheck(
      "preview_smoke",
      !smoke.available ? "blocked" : smoke.passed ? "passed" : "failed",
      !smoke.available
        ? smoke.reason || "Preview smoke check is unavailable."
        : smoke.passed
          ? "Preview smoke check passed."
          : "Preview smoke check failed.",
      summaryArtifact._id
    )
  );

  if (!health.available || !smoke.available) {
    release.status = "preview_prepared";
    applyPreviewVerification(release, {
      status: "blocked",
      summary: `${summaryPrefix} Preview deployed, but verification coverage is incomplete.`,
      checks,
    });
    await release.save();

    return approval?.status === "approved"
      ? finalizeNeedsHumanOwner({
          incident,
          release,
          approval,
          recorder,
          summary:
            "Preview deployed, but preview verification coverage is incomplete. Production release remains blocked pending manual review.",
        })
      : finalizePreviewReturnToCandidate({
          incident,
          release,
          recorder,
          summary:
            "Preview was deployed, but preview verification coverage is incomplete. The incident remains blocked until preview verification is available.",
        });
  }

  if (!health.passed || !smoke.passed) {
    release.status = "preview_failed";
    applyPreviewVerification(release, {
      status: "failed",
      summary: `${summaryPrefix} Preview verification failed.`,
      checks,
    });
    await release.save();

    const artifactIds = [previewArtifactId, deployArtifactId, healthArtifact._id, summaryArtifact._id].filter(Boolean);
    recorder.push({
      eventType: "deploy_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Preview verification failed after preview deploy.",
      detail: {
        releaseId: String(release._id),
        previewDeployId: release.previewDeployId || "",
      },
      artifactIds,
    });

    return approval?.status === "approved"
      ? finalizeNeedsHumanOwner({
          incident,
          release,
          approval,
          recorder,
          summary: "Preview verification failed after approval and requires human release review.",
        })
      : finalizePreviewReturnToCandidate({
          incident,
          release,
          recorder,
          summary:
            "Preview verification failed and the incident remains a blocked release candidate pending manual review.",
        });
  }

  release.status = "preview_verified";
  applyPreviewVerification(release, {
    status: "passed",
    summary: `${summaryPrefix} Preview deploy id, URL, commit, health, and smoke verification passed.`,
    checks,
    verifiedAt: new Date(),
  });
  await release.save();

  recorder.push({
    eventType: "deploy_succeeded",
    actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
    summary: "Preview deployment passed provider, health, and smoke verification.",
    detail: {
      releaseId: String(release._id),
      previewDeployId: release.previewDeployId,
      previewUrl: release.previewUrl,
    },
    artifactIds: [previewArtifactId, deployArtifactId, healthArtifact._id, summaryArtifact._id].filter(Boolean),
  });

  return {
    incident,
    release,
    approval,
    continueRelease: true,
    outcome: "preview_verified",
  };
}

async function runPreviewPhase({
  incident,
  release,
  patch,
  verification,
  approval = null,
  recorder,
}) {
  const recipe = resolvePatchRecipe({ incident, patch });
  const activePreviewMode = resolveEffectivePreviewMode(recipe);

  if (!canPreparePreview({ patch, verification })) {
    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Preview deployment preparation log",
      contentType: "json",
      body: {
        mode: activePreviewMode,
        status: "blocked",
        reason: "Preview deployment could not run safely because the patch or verification context was incomplete.",
      },
    });
    release.status = "preview_blocked";
    applyPreviewVerification(release, {
      status: "blocked",
      summary: "Preview deployment could not run safely because the patch or verification context was incomplete.",
      checks: [
        buildPreviewCheck(
          "preview_context",
          "blocked",
          "Patch branch, worktree, commit, or verification context is incomplete for preview deployment.",
          artifact._id
        ),
      ],
    });
    await release.save();
    recorder.push({
      eventType: "deploy_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Preview deployment could not run safely because the patch or verification context was incomplete.",
      detail: { releaseId: String(release._id) },
      artifactIds: [artifact._id],
    });
    return approval?.status === "approved"
      ? finalizeNeedsHumanOwner({
          incident,
          release,
          approval,
          recorder,
          summary:
            "Approval was granted, but preview deployment could not run safely because the isolated patch context was incomplete.",
        })
      : finalizePreviewReturnToCandidate({
          incident,
          release,
          recorder,
          summary:
            "Preview deployment could not run safely because the isolated patch context was incomplete. The incident remains a verified release candidate.",
        });
  }

  if (incident.state !== "deploying_preview") {
    await transitionIncidentState(
      incident,
      "deploying_preview",
      "Preview deployment started for the verified release candidate.",
      recorder
    );
  }

  release.status = "deploying_preview";
  release.previewDeployRequestedAt = new Date();
  release.previewDeployAcknowledgedAt = null;
  release.previewEvidenceReceivedAt = null;
  release.previewEvidenceQuality = "none";
  release.previewPreparedAt = null;
  release.previewVerifiedAt = null;
  await release.save();

  recorder.push({
    eventType: "deploy_started",
    actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Preview deployment started for the verified release candidate.",
      detail: {
        releaseId: String(release._id),
        patchId: patch ? String(patch._id) : "",
        verificationId: verification ? String(verification._id) : "",
        mode: activePreviewMode,
      },
    });

  if (activePreviewMode === WORKSPACE_SYNC_MODE) {
    const previewUrl = `workspace-sync://${incident.publicId.toLowerCase()}/preview`;
    release.status = "preview_verified";
    release.previewDeployId = buildSyntheticDeployId("preview-workspace-sync", incident, release.attemptNumber);
    release.previewUrl = previewUrl;
    release.previewCommitSha = patch?.headCommitSha || "";
    release.previewDeployAcknowledgedAt = new Date();
    release.previewEvidenceReceivedAt = new Date();
    release.previewEvidenceQuality = "workspace_sync";
    release.previewPreparedAt = new Date();

    const previewArtifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "preview_url",
      label: "Workspace sync preview reference",
      contentType: "link",
      body: previewUrl,
    });
    const deployArtifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Workspace sync preview log",
      contentType: "json",
      body: {
        mode: WORKSPACE_SYNC_MODE,
        status: "passed",
        workspaceSyncRoot: workspaceSyncRoot(),
        summary: "Local workspace sync preview preparation passed for this trusted frontend-only recipe.",
      },
    });
    applyPreviewVerification(release, {
      status: "passed",
      summary: "Local workspace sync preview verification passed for this trusted frontend-only recipe.",
      checks: [
        buildPreviewCheck(
          "provider_evidence",
          "passed",
          "Local workspace sync preview is allowed for this trusted frontend-only recipe.",
          deployArtifact._id
        ),
        buildPreviewCheck(
          "preview_url",
          "passed",
          "Workspace sync preview reference was recorded for the local environment.",
          previewArtifact._id
        ),
      ],
      verifiedAt: new Date(),
    });
    await release.save();

    recorder.push({
      eventType: "deploy_succeeded",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Local workspace sync preview verification passed.",
      detail: {
        releaseId: String(release._id),
        previewDeployId: release.previewDeployId,
        previewUrl,
      },
      artifactIds: [previewArtifact._id, deployArtifact._id],
    });

    return {
      incident,
      release,
      approval,
      continueRelease: true,
      outcome: "preview_verified",
    };
  }

  if (activePreviewMode === "disabled") {
    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Preview deployment log",
      contentType: "json",
      body: {
        mode: "disabled",
        status: "blocked",
        reason: "Preview deployment is not configured in this environment.",
      },
    });
    release.status = "preview_blocked";
    release.previewEvidenceQuality = "none";
    applyPreviewVerification(release, {
      status: "blocked",
      summary: "Preview deployment is not configured in this environment.",
      checks: [
        buildPreviewCheck(
          "provider_evidence",
          "blocked",
          "Preview deployment is disabled in this environment.",
          artifact._id
        ),
      ],
    });
    await release.save();
    recorder.push({
      eventType: "deploy_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Preview deployment is not configured in this environment.",
      detail: { releaseId: String(release._id) },
      artifactIds: [artifact._id],
    });
    return approval?.status === "approved"
      ? finalizeNeedsHumanOwner({
          incident,
          release,
          approval,
          recorder,
          summary: "Approval was granted, but a real preview provider is not configured for this environment.",
        })
      : finalizePreviewReturnToCandidate({
          incident,
          release,
          recorder,
          summary:
            "Preview deployment is not configured in this environment yet. The incident remains a verified release candidate.",
        });
  }

  if (activePreviewMode === "stub") {
    const metadata = buildPreviewStubMetadata({ incident, patch, release });
    release.status = "preview_blocked";
    release.previewDeployId = metadata.previewDeployId;
    release.previewUrl = metadata.previewUrl;
    release.previewCommitSha = metadata.previewCommitSha;
    release.previewDeployAcknowledgedAt = new Date();
    release.previewEvidenceReceivedAt = null;
    release.previewEvidenceQuality = metadata.providerEvidence.evidenceQuality || "stub_only";
    release.previewPreparedAt = new Date();

    const previewArtifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "preview_url",
      label: "Preview deployment reference",
      contentType: "link",
      body: metadata.previewUrl,
    });
    const deployArtifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Preview deployment log",
      contentType: "json",
      body: metadata.providerEvidence,
    });
    applyPreviewVerification(release, {
      status: "blocked",
      summary: "Preview was prepared in stub mode only. No real preview verification exists.",
      checks: [
        buildPreviewCheck(
          "provider_evidence",
          "blocked",
          "Stub preview mode does not provide real deploy evidence.",
          deployArtifact._id
        ),
        buildPreviewCheck(
          "preview_url",
          "blocked",
          "Stub preview URLs are not valid for real preview verification.",
          previewArtifact._id
        ),
      ],
    });
    await release.save();

    return approval?.status === "approved"
      ? finalizeNeedsHumanOwner({
          incident,
          release,
          approval,
          recorder,
          summary:
            "Approval was granted, but only stub preview preparation is available. Production release remains blocked until preview verification exists.",
        })
      : finalizePreviewReturnToCandidate({
          incident,
          release,
          recorder,
          summary:
            "Preview was prepared in stub mode, but no preview verification exists. The incident remains a blocked release candidate.",
        });
  }

  if (activePreviewMode !== "webhook") {
    release.status = "preview_blocked";
    release.previewEvidenceQuality = "none";
    applyPreviewVerification(release, {
      status: "blocked",
      summary: `Unsupported preview mode "${activePreviewMode}" cannot produce a verifiable preview.`,
      checks: [
        buildPreviewCheck(
          "provider_evidence",
          "blocked",
          `Unsupported preview mode "${activePreviewMode}" cannot produce a verifiable preview.`
        ),
      ],
    });
    await release.save();
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: `Unsupported preview mode "${activePreviewMode}" requires human review.`,
    });
  }

  const deployUrl = normalizeUrl(process.env.INCIDENT_PREVIEW_DEPLOY_WEBHOOK_URL);
  if (!deployUrl) {
    release.status = "preview_blocked";
    release.previewEvidenceQuality = "none";
    applyPreviewVerification(release, {
      status: "blocked",
      summary: "Preview webhook configuration is missing, so no verifiable preview can be prepared.",
      checks: [
        buildPreviewCheck(
          "provider_evidence",
          "blocked",
          "Preview deploy webhook URL is missing."
        ),
      ],
    });
    await release.save();
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Preview webhook configuration is missing, so preview deployment cannot continue safely.",
    });
  }

  try {
    const response = await callWebhook({
      url: deployUrl,
      payload: buildDeployPayload({ incident, release, patch, approval }),
    });
    if (!response.ok) {
      throw new Error(`Preview deploy webhook returned HTTP ${response.status}.`);
    }

    const metadata = buildWebhookDeployMetadata({
      kind: "preview",
      response,
      patch,
    });

    release.status = "preview_prepared";
    release.previewDeployId = metadata.deployId;
    release.previewUrl = metadata.deployUrl;
    release.previewCommitSha = metadata.commitSha;
    release.previewDeployAcknowledgedAt = new Date();
    release.previewEvidenceReceivedAt =
      metadata.providerEvidence.evidenceQuality &&
      metadata.providerEvidence.evidenceQuality !== "webhook_ack_only"
        ? new Date()
        : null;
    release.previewEvidenceQuality = metadata.providerEvidence.evidenceQuality || "webhook_ack_only";
    if (metadata.rollbackTargetDeployId) {
      assignRollbackTarget(release, {
        target: metadata.rollbackTargetDeployId,
        source: metadata.rollbackTargetSource,
      });
    }
    release.previewPreparedAt = new Date();
    await release.save();

    const previewArtifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "preview_url",
      label: "Preview deployment reference",
      contentType: metadata.deployUrl ? "link" : "json",
      body: metadata.deployUrl || metadata.providerEvidence,
    });
    const deployArtifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Preview deployment log",
      contentType: "json",
      body: metadata.providerEvidence,
    });

    return finalizePreviewVerification({
      incident,
      release,
      approval,
      patch,
      recorder,
      previewArtifactId: previewArtifact._id,
      deployArtifactId: deployArtifact._id,
      previewUrl: metadata.deployUrl,
      providerEvidence: metadata.providerEvidence,
      summaryPrefix: "Preview deployed successfully.",
    });
  } catch (error) {
    release.status = "preview_failed";
    release.previewEvidenceQuality = release.previewEvidenceQuality || "none";
    applyPreviewVerification(release, {
      status: "failed",
      summary: "Preview deployment failed before verification could run.",
      checks: [
        buildPreviewCheck(
          "provider_evidence",
          "failed",
          error?.message || "Unknown preview deployment error."
        ),
      ],
    });
    await release.save();
    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Preview deployment log",
      contentType: "json",
      body: {
        mode: "webhook",
        status: "preview_failed",
        error: error?.message || "Unknown preview deployment error.",
      },
    });
    recorder.push({
      eventType: "deploy_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Preview deployment failed.",
      detail: {
        releaseId: String(release._id),
        previewDeployId: release.previewDeployId || "",
      },
      artifactIds: [artifact._id],
    });
    return approval?.status === "approved"
      ? finalizeNeedsHumanOwner({
          incident,
          release,
          approval,
          recorder,
          summary: "Preview deployment failed after approval and requires human release review.",
        })
      : finalizePreviewReturnToCandidate({
          incident,
          release,
          recorder,
          summary:
            "Preview deployment failed and the incident remains a verified release candidate pending manual release review.",
        });
  }
}

async function evaluateProductionEligibility({
  incident,
  release,
  patch,
  verification,
  approval,
}) {
  const coverageRecipe = resolveProductionCoverageRecipe({ patch });
  if (!coverageRecipe) {
    return {
      allowed: false,
      reasons: ["production smoke coverage is unavailable for this patch recipe"],
      coverageRecipe: null,
    };
  }

  if (!coverageRecipe.localWorkspaceSync && !coverageRecipe.smokeUrl) {
    return {
      allowed: false,
      reasons: ["production smoke URL is not configured"],
      coverageRecipe,
    };
  }

  let rollbackValidation = {
    valid: true,
    status: "passed",
    summary: "Local workspace sync does not require provider rollback validation.",
    checks: [
      buildPreviewCheck(
        "rollback_mode",
        "passed",
        "Local workspace sync uses direct repository application and does not require provider rollback attestation."
      ),
    ],
  };

  if (!coverageRecipe.localWorkspaceSync) {
    rollbackValidation = await validateRollbackTargetForProduction({ release });
    applyRollbackTargetValidation(release, {
      status: rollbackValidation.status,
      summary: rollbackValidation.summary,
      checks: rollbackValidation.checks,
    });
  } else {
    applyRollbackTargetValidation(release, {
      status: rollbackValidation.status,
      summary: rollbackValidation.summary,
      checks: rollbackValidation.checks,
    });
  }

  if (approval?.status === "approved") {
    if (!hasApprovalProductionScope(approval)) {
      return {
        allowed: false,
        reasons: ["approval scope does not allow production deploy"],
        coverageRecipe,
      };
    }
    if (!rollbackValidation.valid) {
      return {
        allowed: false,
        reasons: [rollbackValidation.summary || "rollback target validation failed"],
        coverageRecipe,
      };
    }
    if (!hasVerifiedPreview(release)) {
      return {
        allowed: false,
        reasons: ["verified preview is required before approved production deploy can continue"],
        coverageRecipe,
      };
    }

    return {
      allowed: true,
      reasons: [],
      coverageRecipe,
      mode: "approved",
    };
  }

  const autoDeployDecision = canAutoDeploy({
    autoDeployEnabled: coverageRecipe.localWorkspaceSync === true ? true : autoDeployEnabled(),
    riskLevel: incident.classification?.riskLevel,
    approvalState: incident.approvalState,
    verificationStatus: verification?.status,
    requiredChecksPassed: allRequiredChecksPassed(verification),
    filesTouched: patch?.filesTouched,
    previewStatus: hasVerifiedPreview(release) ? "passed" : "blocked",
    rollbackTargetDeployId: release.rollbackTargetDeployId,
    freshClusterIncidentCount: 0,
    allowedProtectedPaths: coverageRecipe.allowedProtectedPaths || [],
    skipRollbackTargetRequirement: coverageRecipe.localWorkspaceSync === true,
  });

  return {
    allowed: autoDeployDecision.allowed && rollbackValidation.valid,
    reasons: autoDeployDecision.allowed
      ? rollbackValidation.valid
        ? []
        : [rollbackValidation.summary || "rollback target validation failed"]
      : autoDeployDecision.reasons,
    coverageRecipe,
    mode: "auto",
  };
}

async function runProductionPhase({
  incident,
  release,
  patch,
  verification,
  approval = null,
  recorder,
}) {
  const recipe = resolvePatchRecipe({ incident, patch });
  const activeProductionMode = resolveEffectiveProductionMode(recipe);
  const eligibility = await evaluateProductionEligibility({
    incident,
    release,
    patch,
    verification,
    approval,
  });

  if (!eligibility.allowed) {
    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Production continuation gate",
      contentType: "json",
      body: {
        status: "blocked",
        reasons: eligibility.reasons,
        previewReal: hasRealPreview(release),
        previewVerified: hasVerifiedPreview(release),
      },
    });

    if (approval?.status === "approved") {
      recorder.push({
        eventType: "deploy_failed",
        actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
        summary: "Approved release candidate could not continue to production safely.",
        detail: { releaseId: String(release._id), reasons: eligibility.reasons },
        artifactIds: [artifact._id],
      });
      return finalizeNeedsHumanOwner({
        incident,
        release,
        approval,
        recorder,
        summary: `Approved production continuation is blocked: ${eligibility.reasons.join(", ")}.`,
      });
    }

    if (incident.state === "deploying_production") {
      return finalizeNeedsHumanOwner({
        incident,
        release,
        approval,
        recorder,
        summary: `Production continuation is blocked after deployment started: ${eligibility.reasons.join(", ")}.`,
      });
    }

    return finalizePreviewReturnToCandidate({
      incident,
      release,
      recorder,
      summary: `Production continuation is blocked: ${eligibility.reasons.join(", ")}.`,
    });
  }

  if (activeProductionMode === "disabled") {
    if (approval?.status === "approved" || incident.state === "deploying_production") {
      return finalizeNeedsHumanOwner({
        incident,
        release,
        approval,
        recorder,
        summary: "Production deploy is not configured in this environment, so release continuation requires human handling.",
      });
    }

    return finalizePreviewReturnToCandidate({
      incident,
      release,
      recorder,
      summary:
        "Production deploy is not configured in this environment. The incident remains a verified release candidate.",
    });
  }

  if (incident.state !== "deploying_production") {
    await transitionIncidentState(
      incident,
      "deploying_production",
      "Production deployment started for the release candidate.",
      recorder
    );
  }

  release.status = "deploying_production";
  release.productionDeployRequestedAt = new Date();
  release.productionDeployAcknowledgedAt = null;
  release.productionEvidenceReceivedAt = null;
  release.productionEvidenceQuality = "none";
  release.productionVerifiedAt = null;
  await release.save();

  recorder.push({
    eventType: "deploy_started",
    actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
    summary: "Production deployment started for the release candidate.",
    detail: {
      releaseId: String(release._id),
      previewDeployId: release.previewDeployId || "",
      mode: activeProductionMode,
    },
  });

  if (activeProductionMode === WORKSPACE_SYNC_MODE) {
    try {
      const syncResult = copyWorkspaceSyncFiles({
        patch,
        filesTouched: patch?.filesTouched || [],
      });
      const artifact = await createArtifact({
        incidentId: incident._id,
        releaseId: release._id,
        artifactType: "deploy_log",
        label: "Workspace sync production log",
        contentType: "json",
        body: {
          mode: WORKSPACE_SYNC_MODE,
          status: "passed",
          workspaceSyncRoot: syncResult.root,
          filesTouched: syncResult.copiedFiles,
          commitSha: patch?.headCommitSha || "",
        },
      });

      release.productionDeployId = buildSyntheticDeployId("workspace-sync", incident, release.attemptNumber);
      release.productionCommitSha = patch?.headCommitSha || "";
      release.productionDeployAcknowledgedAt = new Date();
      release.productionEvidenceReceivedAt = new Date();
      release.productionEvidenceQuality = "workspace_sync";
      applyProductionAttestation(release, {
        status: "passed",
        summary: "Local workspace sync applied the verified patch into the live workspace.",
        checks: [
          buildPreviewCheck(
            "workspace_sync_apply",
            "passed",
            `Applied ${syncResult.copiedFiles.join(", ")} into ${syncResult.root}.`,
            artifact._id
          ),
        ],
      });
      release.status = "post_deploy_verifying";
      release.deployedAt = new Date();
      release.productionVerifiedAt = new Date();
      await release.save();

      recorder.push({
        eventType: "deploy_succeeded",
        actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
        summary: "Local workspace sync applied the verified production patch.",
        detail: {
          releaseId: String(release._id),
          productionDeployId: release.productionDeployId,
          workspaceSyncRoot: syncResult.root,
          filesTouched: syncResult.copiedFiles,
        },
        artifactIds: [artifact._id],
      });

      await transitionIncidentState(
        incident,
        "post_deploy_verifying",
        "Local workspace sync applied the verified patch and moved into post-deploy verification.",
        recorder
      );

      incident.userVisibleStatus = "awaiting_internal_review";
      incident.adminVisibleStatus = "active";
      Object.assign(incident.orchestration, buildNextJobFields("deployment"));

      return {
        incident,
        release,
        approval,
        coverageRecipe: eligibility.coverageRecipe,
        outcome: "post_deploy_verifying",
      };
    } catch (error) {
      release.status = "production_failed";
      release.productionEvidenceQuality = release.productionEvidenceQuality || "none";
      await release.save();
      const artifact = await createArtifact({
        incidentId: incident._id,
        releaseId: release._id,
        artifactType: "deploy_log",
        label: "Workspace sync production log",
        contentType: "json",
        body: {
          mode: WORKSPACE_SYNC_MODE,
          status: "production_failed",
          error: error?.message || "Unknown workspace sync deployment error.",
        },
      });
      recorder.push({
        eventType: "deploy_failed",
        actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
        summary: "Local workspace sync production deployment failed.",
        detail: { releaseId: String(release._id), error: error?.message || "" },
        artifactIds: [artifact._id],
      });
      return finalizeDeployFailed({
        incident,
        release,
        recorder,
        summary: "Local workspace sync production deployment failed and requires manual review.",
      });
    }
  }

  if (activeProductionMode === "stub") {
    const metadata = buildProductionStubMetadata({ incident, patch, release });
    release.productionDeployId = metadata.productionDeployId;
    release.productionCommitSha = metadata.productionCommitSha;
    release.productionDeployAcknowledgedAt = new Date();
    release.productionEvidenceReceivedAt = null;
    release.productionEvidenceQuality = metadata.providerEvidence.evidenceQuality || "stub_only";
    release.status = "production_failed";
    applyProductionAttestation(release, {
      status: "blocked",
      summary: "Stub production deploys do not provide real provider deploy evidence.",
      checks: [
        buildPreviewCheck(
          "provider_deploy_id",
          "blocked",
          "Stub production deploy mode does not provide real deploy identity."
        ),
      ],
    });
    await release.save();

    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Production deployment log",
      contentType: "json",
      body: metadata.providerEvidence,
    });
    recorder.push({
      eventType: "deploy_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Stub production deploys do not count as real production release and require human follow-up.",
      detail: { releaseId: String(release._id), productionDeployId: release.productionDeployId },
      artifactIds: [artifact._id],
    });
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Only stub production deploy behavior is available, so the incident cannot be marked fixed/live automatically.",
    });
  }

  if (activeProductionMode !== "webhook") {
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: `Unsupported production deploy mode "${activeProductionMode}" requires human review.`,
    });
  }

  const deployUrl = normalizeUrl(process.env.INCIDENT_PRODUCTION_DEPLOY_WEBHOOK_URL);
  if (!deployUrl) {
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Production deploy webhook configuration is missing, so production release cannot continue safely.",
    });
  }

  try {
    const response = await callWebhook({
      url: deployUrl,
      payload: buildDeployPayload({ incident, release, patch, approval }),
    });
    if (!response.ok) {
      throw new Error(`Production deploy webhook returned HTTP ${response.status}.`);
    }

    const metadata = buildWebhookDeployMetadata({
      kind: "production",
      response,
      patch,
    });

    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Production deployment log",
      contentType: "json",
      body: metadata.providerEvidence,
    });

    release.productionDeployId = metadata.deployId || "";
    release.productionCommitSha = metadata.commitSha || "";
    release.productionDeployAcknowledgedAt = new Date();
    release.productionEvidenceReceivedAt =
      metadata.providerEvidence.evidenceQuality &&
      metadata.providerEvidence.evidenceQuality !== "webhook_ack_only"
        ? new Date()
        : null;
    release.productionEvidenceQuality = metadata.providerEvidence.evidenceQuality || "webhook_ack_only";

    const productionEvidence = validateProductionDeployEvidence({
      metadata,
      patch,
      deployArtifactId: artifact._id,
    });
    applyProductionAttestation(release, {
      status: productionEvidence.valid ? "passed" : productionEvidence.status,
      summary: productionEvidence.summary,
      checks: productionEvidence.checks,
    });

    if (!productionEvidence.valid) {
      release.status = productionEvidence.status === "failed" ? "production_failed" : "blocked";
      await release.save();
      recorder.push({
        eventType: "deploy_failed",
        actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
        summary: productionEvidence.summary,
        detail: {
          releaseId: String(release._id),
          productionDeployId: metadata.deployId || "",
        },
        artifactIds: [artifact._id],
      });
      return finalizeNeedsHumanOwner({
        incident,
        release,
        approval,
        recorder,
        summary: `${productionEvidence.summary} Automatic post-deploy verification and resolution stopped safely.`,
      });
    }

    if (metadata.rollbackTargetDeployId) {
      assignRollbackTarget(release, {
        target: metadata.rollbackTargetDeployId,
        source: metadata.rollbackTargetSource,
      });
      const rollbackValidation = await validateRollbackTargetForProduction({ release });
      applyRollbackTargetValidation(release, {
        status: rollbackValidation.status,
        summary: rollbackValidation.summary,
        checks: rollbackValidation.checks,
      });
    }
    release.status = "post_deploy_verifying";
    release.deployedAt = new Date();
    release.productionVerifiedAt = new Date();
    await release.save();

    recorder.push({
      eventType: "deploy_succeeded",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Production deployment completed and moved into post-deploy verification.",
      detail: {
        releaseId: String(release._id),
        productionDeployId: release.productionDeployId,
      },
      artifactIds: [artifact._id],
    });

    await transitionIncidentState(
      incident,
      "post_deploy_verifying",
      "Production deployment completed and moved into post-deploy verification.",
      recorder
    );

    incident.userVisibleStatus = "awaiting_internal_review";
    incident.adminVisibleStatus = "active";
    Object.assign(incident.orchestration, buildNextJobFields("deployment"));

    return {
      incident,
      release,
      approval,
      coverageRecipe: eligibility.coverageRecipe,
      outcome: "post_deploy_verifying",
    };
  } catch (error) {
    release.status = "production_failed";
    release.productionEvidenceQuality = release.productionEvidenceQuality || "none";
    await release.save();
    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "deploy_log",
      label: "Production deployment log",
      contentType: "json",
      body: {
        mode: "webhook",
        status: "production_failed",
        error: error?.message || "Unknown production deployment error.",
      },
    });
    recorder.push({
      eventType: "deploy_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Production deployment failed.",
      detail: { releaseId: String(release._id), error: error?.message || "" },
      artifactIds: [artifact._id],
    });
    return finalizeDeployFailed({
      incident,
      release,
      recorder,
      summary: "Production deployment failed and requires manual release review.",
    });
  }
}

async function runHealthChecks({ incident, release }) {
  const baseUrl = normalizeUrl(process.env.INCIDENT_PRODUCTION_BASE_URL);
  const healthUrl = normalizeUrl(process.env.INCIDENT_PRODUCTION_HEALTH_URL) || (baseUrl ? `${baseUrl.replace(/\/+$/g, "")}/api/health` : "");
  const results = [];

  if (!healthUrl) {
    return { available: false, passed: false, failures: 0, results };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchWithTimeout(healthUrl, { method: "GET" });
      const passed = response.ok;
      results.push({
        url: healthUrl,
        status: response.status,
        passed,
        body: response.body,
      });
      if (passed) break;
    } catch (error) {
      results.push({
        url: healthUrl,
        status: 0,
        passed: false,
        body: { error: error?.message || "Health request failed." },
      });
    }
  }

  const failures = results.filter((entry) => entry.passed !== true).length;
  return {
    available: true,
    passed: results.some((entry) => entry.passed === true),
    failures,
    results,
  };
}

async function runSmokeChecks({ coverageRecipe }) {
  const results = [];
  if (!coverageRecipe) {
    return {
      available: false,
      passed: false,
      failures: 0,
      results,
      reason: "No supported production smoke recipe matched this patch.",
    };
  }
  if (!coverageRecipe.smokeUrl) {
    return {
      available: false,
      passed: false,
      failures: 0,
      results,
      reason: "Production smoke URL is not configured.",
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchWithTimeout(coverageRecipe.smokeUrl, { method: "GET" });
      const passed = response.ok;
      results.push({
        url: coverageRecipe.smokeUrl,
        status: response.status,
        passed,
        body: response.body,
      });
      if (passed) break;
    } catch (error) {
      results.push({
        url: coverageRecipe.smokeUrl,
        status: 0,
        passed: false,
        body: { error: error?.message || "Production smoke request failed." },
      });
    }
  }

  const failures = results.filter((entry) => entry.passed !== true).length;
  return {
    available: true,
    passed: results.some((entry) => entry.passed === true),
    failures,
    results,
    reason: "",
  };
}

async function runLogWatch(_options = {}) {
  const logWatchUrl = normalizeUrl(process.env.INCIDENT_PRODUCTION_LOG_WATCH_URL);
  if (!logWatchUrl) {
    return {
      configured: false,
      available: false,
      passed: true,
      response: {},
    };
  }

  try {
    const response = await fetchWithTimeout(logWatchUrl, { method: "GET" });
    const body = typeof response.body === "object" && response.body ? response.body : {};
    return {
      configured: true,
      available: true,
      passed: response.ok,
      response: {
        status: response.status,
        body,
      },
      errorFingerprintCount: Number(body.errorFingerprintCount || 0),
      newClusterIncidentsWithin15Min: Number(body.newClusterIncidentsWithin15Min || 0),
      unauthorizedFailure: body.unauthorizedFailure === true,
      protectedDomainSignal: body.protectedDomainSignal === true,
    };
  } catch (error) {
    return {
      configured: true,
      available: true,
      passed: false,
      response: {
        status: 0,
        body: { error: error?.message || "Log watch request failed." },
      },
      errorFingerprintCount: 0,
      newClusterIncidentsWithin15Min: 0,
      unauthorizedFailure: false,
      protectedDomainSignal: false,
    };
  }
}

async function runRollbackPhase({
  incident,
  release,
  approval = null,
  recorder,
}) {
  incrementStageAttempt(incident, "rollback");

  if (incident.state !== "rollback_in_progress") {
    await transitionIncidentState(
      incident,
      "rollback_in_progress",
      "Rollback started after failed post-deploy verification.",
      recorder
    );
  }

  release.status = "rollback_requested";
  await release.save();

  recorder.push({
    eventType: "rollback_started",
    actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
    summary: "Rollback started after failed post-deploy verification.",
    detail: {
      releaseId: String(release._id),
      rollbackTargetDeployId: release.rollbackTargetDeployId || "",
      rollbackReason: release.rollbackReason || "",
    },
  });

  if (rollbackMode() !== "webhook") {
    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "rollback_report",
      stage: "rollback",
      label: "Rollback execution report",
      contentType: "json",
      body: {
        mode: rollbackMode(),
        status: "rollback_failed",
        reason: "Rollback is not configured for this environment.",
      },
    });

    release.status = "rollback_failed";
    await release.save();

    recorder.push({
      eventType: "rollback_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Rollback could not run because no real rollback provider is configured.",
      detail: {
        releaseId: String(release._id),
        rollbackTargetDeployId: release.rollbackTargetDeployId || "",
      },
      artifactIds: [artifact._id],
    });

    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Rollback failed because no real rollback provider is configured for this environment.",
    });
  }

  const rollbackUrl = normalizeUrl(process.env.INCIDENT_PRODUCTION_ROLLBACK_WEBHOOK_URL);
  if (!rollbackUrl) {
    release.status = "rollback_failed";
    await release.save();
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Rollback webhook configuration is missing, so rollback requires human intervention.",
    });
  }

  try {
    const response = await callWebhook({
      url: rollbackUrl,
      payload: {
        incidentPublicId: incident.publicId,
        releaseAttempt: release.attemptNumber,
        rollbackTargetDeployId: release.rollbackTargetDeployId || "",
      },
    });
    if (!response.ok) {
      throw new Error(`Rollback webhook returned HTTP ${response.status}.`);
    }

    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "rollback_report",
      stage: "rollback",
      label: "Rollback execution report",
      contentType: "json",
      body: {
        mode: "webhook",
        status: "rolled_back",
        response: response.body,
      },
    });

    release.status = "rolled_back";
    release.rollbackAt = new Date();
    await release.save();

    incident.userVisibleStatus = "closed";
    incident.adminVisibleStatus = "rolled_back";
    incident.resolution = {
      code: "rolled_back",
      summary: compactText(release.rollbackReason || "Release was rolled back after failed post-deploy verification.", 240),
      resolvedAt: new Date(),
      closedAt: new Date(),
    };
    Object.assign(incident.orchestration, buildNextJobFields("none"));

    recorder.push({
      eventType: "rollback_succeeded",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Rollback completed after failed post-deploy verification.",
      detail: {
        releaseId: String(release._id),
        rollbackTargetDeployId: release.rollbackTargetDeployId || "",
      },
      artifactIds: [artifact._id],
    });

    await transitionIncidentState(
      incident,
      "closed_rolled_back",
      "Rollback completed after failed post-deploy verification.",
      recorder
    );

    return saveAndReturn({
      incident,
      release,
      approval,
      recorder,
      outcome: "closed_rolled_back",
    });
  } catch (error) {
    const artifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "rollback_report",
      stage: "rollback",
      label: "Rollback execution report",
      contentType: "json",
      body: {
        mode: "webhook",
        status: "rollback_failed",
        error: error?.message || "Unknown rollback error.",
      },
    });

    release.status = "rollback_failed";
    await release.save();

    recorder.push({
      eventType: "rollback_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Rollback failed after post-deploy verification triggered a rollback.",
      detail: {
        releaseId: String(release._id),
        error: error?.message || "",
      },
      artifactIds: [artifact._id],
    });

    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Rollback failed and requires human intervention.",
    });
  }
}

async function runPostDeployVerificationPhase({
  incident,
  release,
  patch,
  approval = null,
  recorder,
  coverageRecipe,
}) {
  incrementStageAttempt(incident, "post_deploy_verification");

  if (coverageRecipe?.localWorkspaceSync === true) {
    const relativeFile = PREFERENCES_RELATIVE_FILE;
    const targetPath = path.join(workspaceSyncRoot(), relativeFile);
    let buildResult = null;
    let uiResult = null;
    let source = "";

    try {
      source = fs.readFileSync(targetPath, "utf8");
      buildResult = runJavaScriptBuildCheck(source, relativeFile);
      uiResult = runPreferencesWorkspaceVerification(source);
    } catch (error) {
      const artifact = await createArtifact({
        incidentId: incident._id,
        releaseId: release._id,
        artifactType: "coverage_summary",
        stage: "post_deploy",
        label: "Workspace sync post-deploy verification summary",
        contentType: "json",
        body: {
          coverageRecipe: coverageRecipe.key,
          workspaceSyncRoot: workspaceSyncRoot(),
          error: error?.message || "Workspace sync verification failed.",
        },
      });
      release.smokeStatus = "failed";
      await release.save();
      recorder.push({
        eventType: "post_deploy_verification_failed",
        actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
        summary: "Workspace sync post-deploy verification failed.",
        detail: {
          releaseId: String(release._id),
          coverageRecipe: coverageRecipe.key,
          error: error?.message || "",
        },
        artifactIds: [artifact._id],
      });
      return finalizeNeedsHumanOwner({
        incident,
        release,
        approval,
        recorder,
        summary: "Workspace sync post-deploy verification failed and requires manual review.",
      });
    }

    const healthArtifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "health_snapshot",
      stage: "post_deploy",
      label: "Workspace sync health snapshot",
      contentType: "json",
      body: {
        available: true,
        passed: true,
        mode: WORKSPACE_SYNC_MODE,
        workspaceSyncRoot: workspaceSyncRoot(),
        buildOutput: buildResult.output,
      },
    });

    const summaryArtifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "coverage_summary",
      stage: "post_deploy",
      label: "Workspace sync post-deploy verification summary",
      contentType: "json",
      body: {
        coverageRecipe: coverageRecipe.key,
        workspaceSyncRoot: workspaceSyncRoot(),
        checks: uiResult.checks,
        missing: uiResult.missing,
      },
    });

    if (!uiResult.ok) {
      release.smokeStatus = "failed";
      await release.save();
      recorder.push({
        eventType: "post_deploy_verification_failed",
        actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
        summary: "Workspace sync post-deploy verification found an incomplete preferences save fix.",
        detail: {
          releaseId: String(release._id),
          coverageRecipe: coverageRecipe.key,
          missing: uiResult.missing,
        },
        artifactIds: [healthArtifact._id, summaryArtifact._id],
      });
      return finalizeNeedsHumanOwner({
        incident,
        release,
        approval,
        recorder,
        summary: "Workspace sync post-deploy verification found an incomplete preferences save fix.",
      });
    }

    release.status = "succeeded";
    release.smokeStatus = "passed";
    await release.save();

    incident.userVisibleStatus = "fixed_live";
    incident.adminVisibleStatus = "resolved";
    incident.resolution = {
      code: "fixed_deployed",
      summary: compactText(patch?.patchSummary || "Workspace sync applied and verified the preferences save fix.", 240),
      resolvedAt: new Date(),
      closedAt: null,
    };
    Object.assign(incident.orchestration, buildNextJobFields("none"));

    recorder.push({
      eventType: "post_deploy_verification_passed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Workspace sync production patch passed post-deploy verification.",
      detail: {
        releaseId: String(release._id),
        coverageRecipe: coverageRecipe.key,
        workspaceSyncRoot: workspaceSyncRoot(),
      },
      artifactIds: [healthArtifact._id, summaryArtifact._id],
    });

    await transitionIncidentState(
      incident,
      "resolved",
      "Workspace sync applied and verified the preferences save fix in the live workspace.",
      recorder,
      { postDeployChecksPassed: true }
    );

    return saveAndReturn({
      incident,
      release,
      approval,
      recorder,
      outcome: "resolved",
    });
  }

  const health = await runHealthChecks({ incident, release });
  const smoke = await runSmokeChecks({ coverageRecipe });
  const logWatch = await runLogWatch();

  if (!hasRealProductionDeploy(release)) {
    const attestationArtifact = await createArtifact({
      incidentId: incident._id,
      releaseId: release._id,
      artifactType: "coverage_summary",
      stage: "post_deploy",
      label: "Production deploy attestation summary",
      contentType: "json",
      body: {
        productionAttestationStatus: release.productionAttestationStatus || "not_started",
        productionAttestationSummary: release.productionAttestationSummary || "",
        productionAttestationChecks: Array.isArray(release.productionAttestationChecks)
          ? release.productionAttestationChecks
          : [],
      },
    });
    release.smokeStatus = "failed";
    await release.save();
    recorder.push({
      eventType: "post_deploy_verification_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Production deploy evidence is incomplete, so automatic resolution stopped safely.",
      detail: {
        releaseId: String(release._id),
        productionAttestationStatus: release.productionAttestationStatus || "not_started",
      },
      artifactIds: [attestationArtifact._id],
    });
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Production deploy evidence is incomplete, so automatic resolution requires human review.",
    });
  }

  const healthArtifact = await createArtifact({
    incidentId: incident._id,
    releaseId: release._id,
    artifactType: "health_snapshot",
    stage: "post_deploy",
    label: "Post-deploy health snapshot",
    contentType: "json",
    body: {
      available: health.available,
      passed: health.passed,
      results: health.results,
    },
  });

  const summaryArtifact = await createArtifact({
    incidentId: incident._id,
    releaseId: release._id,
    artifactType: "coverage_summary",
    stage: "post_deploy",
    label: "Post-deploy verification summary",
    contentType: "json",
    body: {
      coverageRecipe: coverageRecipe?.key || "",
      health,
      smoke,
      logWatch,
    },
  });

  if (!health.available || !smoke.available) {
    release.smokeStatus = "failed";
    await release.save();
    recorder.push({
      eventType: "post_deploy_verification_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Post-deploy verification coverage was incomplete, so automatic resolution stopped safely.",
      detail: {
        releaseId: String(release._id),
        coverageRecipe: coverageRecipe?.key || "",
        healthAvailable: health.available,
        smokeAvailable: smoke.available,
      },
      artifactIds: [healthArtifact._id, summaryArtifact._id],
    });
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Post-deploy verification coverage is incomplete, so automatic resolution requires human review.",
    });
  }

  if (logWatch.configured === true && logWatch.passed !== true) {
    release.smokeStatus = "failed";
    await release.save();
    recorder.push({
      eventType: "post_deploy_verification_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Post-deploy log-watch transport failed, so automatic resolution stopped safely.",
      detail: {
        releaseId: String(release._id),
        logWatchResponse: logWatch.response || {},
      },
      artifactIds: [healthArtifact._id, summaryArtifact._id],
    });
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Post-deploy log-watch verification failed, so automatic resolution requires human review.",
    });
  }

  const rollbackDecision = shouldTriggerRollback({
    healthFailuresWithinTwoMinutes: health.failures,
    prodSmokeFailures: smoke.failures,
    postDeployErrorFingerprintCount: Number(logWatch.errorFingerprintCount || 0),
    newClusterIncidentsWithin15Min: Number(logWatch.newClusterIncidentsWithin15Min || 0),
    unauthorizedFailure: logWatch.unauthorizedFailure === true,
    protectedDomainSignal: logWatch.protectedDomainSignal === true,
  });

  if (rollbackDecision.shouldRollback) {
    release.smokeStatus = "failed";
    release.rollbackReason = rollbackDecision.reasons.join("; ");
    await release.save();

    recorder.push({
      eventType: "post_deploy_verification_failed",
      actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
      summary: "Post-deploy verification failed and triggered rollback.",
      detail: {
        releaseId: String(release._id),
        reasons: rollbackDecision.reasons,
      },
      artifactIds: [healthArtifact._id, summaryArtifact._id],
    });

    await transitionIncidentState(
      incident,
      "rollback_in_progress",
      "Post-deploy verification failed and triggered rollback.",
      recorder
    );

    return runRollbackPhase({
      incident,
      release,
      approval,
      recorder,
    });
  }

  release.status = "succeeded";
  release.smokeStatus = "passed";
  await release.save();

  incident.userVisibleStatus = "fixed_live";
  incident.adminVisibleStatus = "resolved";
  incident.resolution = {
    code: "fixed_deployed",
    summary: compactText(patch?.patchSummary || "Release deployed and verified in production.", 240),
    resolvedAt: new Date(),
    closedAt: null,
  };
  Object.assign(incident.orchestration, buildNextJobFields("none"));

  recorder.push({
    eventType: "post_deploy_verification_passed",
    actor: { type: "agent", agentRole: RELEASE_AGENT_ROLE },
    summary: "Production deploy passed the required post-deploy verification checks.",
    detail: {
      releaseId: String(release._id),
      coverageRecipe: coverageRecipe?.key || "",
    },
    artifactIds: [healthArtifact._id, summaryArtifact._id],
  });

  await transitionIncidentState(
    incident,
    "resolved",
    "Production deploy passed the required post-deploy verification checks.",
    recorder,
    { postDeployChecksPassed: true }
  );

  return saveAndReturn({
    incident,
    release,
    approval,
    recorder,
    outcome: "resolved",
  });
}

async function runRelease(incident) {
  const recorder = buildEventRecorder(incident);
  incrementStageAttempt(incident, "deployment");

  const [patch, verification] = await Promise.all([
    loadCurrentPatch(incident),
    loadCurrentVerification(incident),
  ]);

  let release = await loadCurrentRelease(incident);
  let approval = await loadCurrentApproval(incident);

  if (release && normalizeLegacyPreviewStatus(release)) {
    await release.save();
  }

  if (!verification) {
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Release cannot continue because verification context is missing.",
    });
  }

  if (incident.state === "awaiting_founder_approval") {
    if (!approval || approval.status === "pending") {
      incident.userVisibleStatus = "awaiting_internal_review";
      incident.adminVisibleStatus = "awaiting_approval";
      Object.assign(incident.orchestration, buildNextJobFields("none"));
      return saveAndReturn({
        incident,
        release,
        approval,
        recorder,
        outcome: "awaiting_founder_approval",
      });
    }
    if (approval.status === "rejected") {
      incident.userVisibleStatus = "awaiting_internal_review";
      incident.adminVisibleStatus = "active";
      Object.assign(incident.orchestration, buildNextJobFields("none"));
      return saveAndReturn({
        incident,
        release,
        approval,
        recorder,
        outcome: "needs_human_owner",
      });
    }
  }

  if (incident.state === "verified_release_candidate" && !release) {
    release = await ensureReleaseCandidateRecord({ incident, patch, verification });
    const policy = determinePolicyDecision({ incident, patch, verification });
    release.policyDecision = policy.policyDecision;
    release.previewCommitSha = release.previewCommitSha || "";

    if (policy.policyDecision === "blocked") {
      release.status = "blocked";
      await release.save();
      incident.userVisibleStatus = "awaiting_internal_review";
      incident.adminVisibleStatus = "active";
      Object.assign(incident.orchestration, buildNextJobFields("none"));
      return saveAndReturn({
        incident,
        release,
        recorder,
        outcome: "verified_release_candidate",
      });
    }

    if (policy.approvalRequired && (!approval || approval.status !== "approved")) {
      const created = await createApprovalForRelease({
        incident,
        release,
        patch,
        verification,
        policyReasons: policy.reasons,
        recorder,
      });
      approval = created.approval;
      return saveAndReturn({
        incident,
        release,
        approval,
        recorder,
        outcome: "awaiting_founder_approval",
      });
    }
  }

  if (!release) {
    return finalizeNeedsHumanOwner({
      incident,
      release,
      approval,
      recorder,
      summary: "Release cannot continue because no release record is available.",
    });
  }

  if (incident.state === "verified_release_candidate" || incident.state === "awaiting_founder_approval") {
    const needsPreview = !hasVerifiedPreview(release);
    if (needsPreview) {
      const previewResult = await runPreviewPhase({
        incident,
        release,
        patch,
        verification,
        approval,
        recorder,
      });
      if (previewResult?.continueRelease === true) {
        release = previewResult.release || release;
        approval = previewResult.approval || approval;
      } else {
        return previewResult;
      }
    }
  }

  if (incident.state === "deploying_preview" || incident.state === "deploying_production") {
    const productionResult = await runProductionPhase({
      incident,
      release,
      patch,
      verification,
      approval,
      recorder,
    });
    if (productionResult?.outcome !== "post_deploy_verifying") {
      return productionResult;
    }
    release = productionResult.release || release;
  }

  if (incident.state === "post_deploy_verifying") {
    return runPostDeployVerificationPhase({
      incident,
      release,
      patch,
      approval,
      recorder,
      coverageRecipe: resolveProductionCoverageRecipe({ patch }),
    });
  }

  if (incident.state === "rollback_in_progress") {
    return runRollbackPhase({
      incident,
      release,
      approval,
      recorder,
    });
  }

  return saveAndReturn({
    incident,
    release,
    approval,
    recorder,
    outcome: incident.state || "deployment",
  });
}

module.exports = {
  runRelease,
  decideIncidentApproval,
};
