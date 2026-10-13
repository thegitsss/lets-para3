const crypto = require("crypto");

const Incident = require("../../models/Incident");
const IncidentEvent = require("../../models/IncidentEvent");
const {
  assertTransition,
} = require("./stateMachine");
const {
  classifyIncidentRisk,
  determineAutonomyMode,
  shouldRequireApproval,
} = require("./riskEngine");
const { syncIncidentNotifications } = require("./notificationService");

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "button",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "its",
  "my",
  "not",
  "of",
  "on",
  "or",
  "page",
  "screen",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
  "work",
  "working",
]);

const LOW_SIGNAL_TOKENS = new Set([
  "asdf",
  "bug",
  "error",
  "hello",
  "help",
  "hi",
  "issue",
  "na",
  "none",
  "test",
  "testing",
]);

const DOMAIN_RULES = [
  { domain: "payouts", keywords: ["payout", "paid out", "transfer"], routes: ["payout"] },
  { domain: "withdrawals", keywords: ["withdraw", "withdrawal"], routes: ["withdraw"] },
  { domain: "disputes", keywords: ["dispute", "flagged", "flag icon"], routes: ["dispute"] },
  {
    domain: "stripe_onboarding",
    keywords: ["stripe connect", "connect onboarding", "onboarding link"],
    routes: ["stripe", "connect"],
  },
  {
    domain: "payments",
    keywords: ["payment", "billing", "fund", "card", "checkout", "receipt"],
    routes: ["billing", "payment"],
  },
  { domain: "escrow", keywords: ["escrow", "release funds", "fund release"], routes: ["escrow"] },
  {
    domain: "auth",
    keywords: ["login", "sign in", "password", "session", "csrf", "token", "unauthorized", "2fa"],
    routes: ["login", "auth", "verify"],
  },
  {
    domain: "permissions",
    keywords: ["forbidden", "permission", "access denied", "not allowed"],
    routes: ["permission", "admin"],
  },
  {
    domain: "approvals",
    keywords: ["approve", "approval", "deny", "denied", "review decision"],
    routes: ["approval", "review"],
  },
  {
    domain: "profile_visibility",
    keywords: ["profile visible", "hidden profile", "visibility", "public profile", "private profile"],
    routes: ["profile"],
  },
  { domain: "messaging", keywords: ["message", "thread", "chat"], routes: ["message", "chat"] },
  {
    domain: "documents",
    keywords: ["document", "upload", "download", "file", "attachment", "pdf"],
    routes: ["upload", "file", "document"],
  },
  {
    domain: "notifications",
    keywords: ["notification", "alert", "email notice"],
    routes: ["notification"],
  },
  {
    domain: "matching",
    keywords: ["hire", "application", "apply", "invite", "accepted", "declined"],
    routes: ["application", "invite", "browse", "job"],
  },
  {
    domain: "case_lifecycle",
    keywords: ["case", "workspace", "task", "deadline", "calendar", "deliverable"],
    routes: ["case", "workspace", "task", "calendar"],
  },
  {
    domain: "profile",
    keywords: ["profile", "resume", "certificate", "headshot", "settings"],
    routes: ["profile", "settings"],
  },
  { domain: "navigation", keywords: ["redirect", "route", "link"], routes: ["help", "dashboard"] },
  { domain: "performance", keywords: ["slow", "timeout", "frozen", "lag"], routes: [] },
  { domain: "data_integrity", keywords: ["missing data", "wrong data", "duplicated", "corrupt"], routes: [] },
  { domain: "ui", keywords: ["modal", "layout", "spacing", "click", "button"], routes: [] },
];

const JOB_STAGE_FIELD_MAP = Object.freeze({
  intake_validation: "intakeValidation",
  classification: "classification",
  investigation: "investigation",
  patch_planning: "patchPlanning",
  patch_execution: "patchExecution",
  verification: "verification",
  deployment: "deployment",
  post_deploy_verification: "postDeployVerification",
  rollback: "rollback",
});

const BLOCKER_PATTERNS = [
  "does nothing",
  "not working",
  "unable",
  "cannot",
  "can't",
  "fails",
  "failed",
  "stopped",
  "frozen",
  "blank",
  "won't",
];

function compactText(value, maxLength = 5000) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : "";
}

function compactMultilineText(value, maxLength = 5000) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  return text ? text.slice(0, maxLength) : "";
}

function normalizeIncidentSummary(summary) {
  return compactText(summary, 180).replace(/\s+([?.!,;:])/g, "$1");
}

function slugify(value, maxLength = 80) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.slice(0, maxLength).replace(/-+$/g, "");
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function extractKeywords(value, limit = 4) {
  const tokens = tokenize(value);
  const keywords = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (STOP_WORDS.has(token)) continue;
    if (keywords.includes(token)) continue;
    keywords.push(token);
    if (keywords.length >= limit) break;
  }
  return keywords;
}

function buildCorpus(incident = {}) {
  return compactMultilineText(
    [
      incident.summary,
      incident.originalReportText,
      incident.context?.featureKey,
      incident.context?.routePath,
      incident.context?.pageUrl,
    ]
      .filter(Boolean)
      .join("\n"),
    8000
  );
}

function getRouteSeed(incident = {}) {
  const routePath = compactText(incident.context?.routePath || incident.context?.pageUrl, 300);
  if (!routePath) return "general";

  const cleaned = routePath
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/\.[a-z0-9]+$/i, ""))
    .filter((segment) => segment && !/^[a-f0-9]{24}$/i.test(segment) && !/^\d+$/.test(segment));

  if (!cleaned.length) return "general";
  return slugify(cleaned[cleaned.length - 1], 32) || "general";
}

function buildIssueFingerprint(incident = {}) {
  const surface = compactText(incident.context?.surface || incident.reporter?.role || "system", 32).toLowerCase();
  const routeSeed = getRouteSeed(incident);
  const featureKey = slugify(incident.context?.featureKey || "", 40);
  const keywordSeed = extractKeywords(
    `${incident.summary || ""} ${incident.context?.featureKey || ""}`,
    8
  ).join("-");
  const base = [surface, routeSeed, featureKey, keywordSeed || "general"].filter(Boolean).join("|");
  return crypto.createHash("sha256").update(base, "utf8").digest("hex");
}

function buildClusterKey(incident = {}) {
  const routeSeed = getRouteSeed(incident);
  const featureTokens = extractKeywords(incident.context?.featureKey || "", 2);
  const summaryTokens = extractKeywords(incident.summary || "", 3);
  const tokens = [...new Set([...featureTokens, ...summaryTokens])].slice(0, 3);
  const seed = [routeSeed, ...(tokens.length ? tokens : [incident.context?.surface || "general"])].join("-");
  return slugify(seed, 80) || "general";
}

function evaluateIntakeSignal(incident = {}) {
  const summary = normalizeIncidentSummary(incident.summary);
  const description = compactMultilineText(incident.originalReportText, 5000);
  const corpus = compactText(`${summary} ${description}`, 6000).toLowerCase();
  const keywords = extractKeywords(corpus, 12);
  const alphaChars = corpus.replace(/[^a-z]/g, "").length;

  const lowSignalOnly =
    keywords.length > 0 && keywords.every((token) => LOW_SIGNAL_TOKENS.has(token));

  if (!summary || !description) {
    return { actionable: false, reason: "Missing core intake fields." };
  }

  if (alphaChars < 20 || keywords.length < 2 || lowSignalOnly) {
    return { actionable: false, reason: "Not enough actionable detail was provided." };
  }

  return { actionable: true, reason: "" };
}

function detectDomain(incident = {}) {
  const corpus = buildCorpus(incident).toLowerCase();
  const routePath = compactText(incident.context?.routePath || incident.context?.pageUrl, 300).toLowerCase();

  for (const rule of DOMAIN_RULES) {
    if (rule.keywords.some((keyword) => corpus.includes(String(keyword).toLowerCase()))) {
      return rule.domain;
    }
    if (rule.routes.some((hint) => routePath.includes(String(hint).toLowerCase()))) {
      return rule.domain;
    }
  }

  return "unknown";
}

function deriveRiskFlags(incident = {}) {
  const corpus = buildCorpus(incident).toLowerCase();
  const routePath = compactText(incident.context?.routePath || incident.context?.pageUrl, 300).toLowerCase();
  const contains = (value) => corpus.includes(value) || routePath.includes(value);

  const affectsAuth = contains("login") || contains("auth") || contains("password") || contains("2fa") || contains("csrf") || contains("session");
  const affectsPermissions = contains("permission") || contains("forbidden") || contains("access denied") || contains("not allowed");
  const affectsApprovalDecision = contains("approve") || contains("approval") || contains("deny") || contains("denied");
  const affectsProfileVisibility = contains("profile visible") || contains("hidden profile") || contains("visibility");
  const affectsDisputes = contains("dispute") || contains("flag icon");
  const affectsWithdrawals = contains("withdraw");
  const affectsMoney =
    contains("stripe") ||
    contains("payment") ||
    contains("payout") ||
    contains("escrow") ||
    contains("refund") ||
    affectsDisputes ||
    affectsWithdrawals;
  const affectsAccess = affectsAuth || affectsPermissions || contains("access");
  const affectsLegal = affectsDisputes || contains("privacy") || contains("terms") || contains("compliance") || affectsProfileVisibility;

  return {
    affectsMoney,
    affectsAccess,
    affectsLegal,
    affectsAuth,
    affectsPermissions,
    affectsApprovalDecision,
    affectsProfileVisibility,
    affectsDisputes,
    affectsWithdrawals,
  };
}

function inferConfidence(incident = {}, { domain = "unknown", clusterIncidentCount = 1 } = {}) {
  let signals = 0;
  if (compactText(incident.context?.routePath, 300) || compactText(incident.context?.pageUrl, 300)) signals += 1;
  if (compactText(incident.context?.featureKey, 120)) signals += 1;
  if (compactText(incident.context?.browser, 160) || compactText(incident.context?.device, 160)) signals += 1;
  if (domain !== "unknown") signals += 1;
  if (Number(clusterIncidentCount) > 1) signals += 1;

  if (signals >= 4) return "high";
  if (signals >= 2) return "medium";
  return "low";
}

function inferSeverity({ incident = {}, riskLevel = "low", riskFlags = {}, clusterIncidentCount = 1 } = {}) {
  const corpus = buildCorpus(incident).toLowerCase();
  const blocker = BLOCKER_PATTERNS.some((pattern) => corpus.includes(pattern));
  const protectedImpact = riskFlags.affectsMoney || riskFlags.affectsAccess || riskFlags.affectsLegal;

  if (riskLevel === "high" && protectedImpact && blocker) return "critical";
  if (riskLevel === "high" || Number(clusterIncidentCount) >= 5) return "high";
  if (riskLevel === "medium" || blocker || Number(clusterIncidentCount) >= 2) return "medium";
  return "low";
}

async function findPotentialDuplicate(incident = {}, issueFingerprint = "") {
  const reporterUserId = incident.reporter?.userId || null;
  if (!reporterUserId || !issueFingerprint) return null;

  return Incident.findOne({
    _id: { $ne: incident._id },
    "reporter.userId": reporterUserId,
    "classification.issueFingerprint": issueFingerprint,
    createdAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
  })
    .sort({ createdAt: -1 })
    .lean();
}

async function countClusterIncidents(clusterKey, incidentId) {
  if (!clusterKey) return 1;
  const count = await Incident.countDocuments({
    _id: { $ne: incidentId },
    "classification.clusterKey": clusterKey,
  });
  return count + 1;
}

function buildNextJobFields(nextJobType, delayMs = 0) {
  return {
    nextJobType,
    nextJobRunAt: new Date(Date.now() + Math.max(0, Number(delayMs) || 0)),
  };
}

function incrementStageAttempt(incident, jobType) {
  const field = JOB_STAGE_FIELD_MAP[jobType];
  if (!field) return;
  incident.orchestration = incident.orchestration || {};
  incident.orchestration.stageAttempts = incident.orchestration.stageAttempts || {};
  incident.orchestration.stageAttempts[field] =
    Number(incident.orchestration.stageAttempts[field] || 0) + 1;
}

function clearIncidentLock(incident) {
  incident.orchestration.lockToken = "";
  incident.orchestration.lockOwner = "";
  incident.orchestration.lockExpiresAt = null;
  incident.orchestration.lastWorkerAt = new Date();
}

function buildEventRecorder(incident) {
  let seq = Number(incident.lastEventSeq || 0);
  const events = [];

  const push = ({ eventType, actor = { type: "worker" }, summary, fromState = "", toState = "", detail = {}, artifactIds = [] }) => {
    seq += 1;
    events.push({
      incidentId: incident._id,
      seq,
      eventType,
      actor,
      summary,
      fromState,
      toState,
      detail,
      artifactIds,
    });
  };

  const finalize = () => {
    incident.lastEventSeq = seq;
    return events;
  };

  const save = async () => {
    incident.lastEventSeq = seq;
    if (events.length) {
      await IncidentEvent.insertMany(events, { ordered: true });
    }
    return events;
  };

  return { push, finalize, save, get events() { return events; } };
}

async function transitionIncidentState(incident, toState, summary, recorder, context = {}) {
  assertTransition(incident.state, toState, context);
  const fromState = incident.state;
  incident.state = toState;
  recorder.push({
    eventType: "state_changed",
    actor: { type: "worker" },
    summary,
    fromState,
    toState,
  });
}

async function runIntakeValidation(incident) {
  const recorder = buildEventRecorder(incident);
  incrementStageAttempt(incident, "intake_validation");

  incident.summary = normalizeIncidentSummary(incident.summary);
  incident.classification.issueFingerprint = buildIssueFingerprint(incident);
  incident.classification.clusterKey = buildClusterKey(incident);

  recorder.push({
    eventType: "cluster_linked",
    actor: { type: "worker" },
    summary: `Incident assigned to cluster "${incident.classification.clusterKey}".`,
    detail: {
      clusterKey: incident.classification.clusterKey,
      issueFingerprint: incident.classification.issueFingerprint,
    },
  });

  const signal = evaluateIntakeSignal(incident);
  const duplicate = signal.actionable
    ? await findPotentialDuplicate(incident, incident.classification.issueFingerprint)
    : null;

  if (duplicate) {
    incident.duplicateOfIncidentId = duplicate._id;
    incident.userVisibleStatus = "closed";
    incident.adminVisibleStatus = "closed";
    incident.resolution = {
      code: "duplicate",
      summary: `Linked to existing incident ${duplicate.publicId}.`,
      resolvedAt: new Date(),
      closedAt: new Date(),
    };
    Object.assign(incident.orchestration, buildNextJobFields("none"));
    await transitionIncidentState(
      incident,
      "closed_duplicate",
      `Duplicate report matched existing incident ${duplicate.publicId}.`,
      recorder
    );
  } else if (!signal.actionable) {
    incident.userVisibleStatus = "needs_more_info";
    incident.adminVisibleStatus = "active";
    Object.assign(incident.orchestration, buildNextJobFields("none"));
    await transitionIncidentState(
      incident,
      "needs_more_context",
      "More actionable detail is needed before this report can be classified.",
      recorder
    );
  } else {
    incident.userVisibleStatus = "received";
    incident.adminVisibleStatus = "active";
    Object.assign(incident.orchestration, buildNextJobFields("classification"));
    await transitionIncidentState(
      incident,
      "intake_validated",
      "Incident intake validated and queued for classification.",
      recorder
    );
  }

  clearIncidentLock(incident);
  recorder.finalize();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident });

  return {
    incident,
    outcomeState: incident.state,
    duplicateOfIncidentId: duplicate ? String(duplicate._id) : "",
    clusterKey: incident.classification.clusterKey,
    issueFingerprint: incident.classification.issueFingerprint,
  };
}

async function runClassification(incident) {
  const recorder = buildEventRecorder(incident);
  incrementStageAttempt(incident, "classification");
  const previousRiskLevel = incident.classification?.riskLevel || "low";

  const domain = detectDomain(incident);
  const riskFlags = deriveRiskFlags(incident);
  const clusterKey = incident.classification.clusterKey || buildClusterKey(incident);
  const issueFingerprint = incident.classification.issueFingerprint || buildIssueFingerprint(incident);
  const clusterIncidentCount = await countClusterIncidents(clusterKey, incident._id);
  const confidence = inferConfidence(incident, { domain, clusterIncidentCount });
  const risk = classifyIncidentRisk({
    domain,
    summary: incident.summary,
    originalReportText: incident.originalReportText,
    confidence,
    suspectedRoutes: [incident.context?.routePath].filter(Boolean),
    riskFlags,
    clusterIncidentCount,
  });
  const severity = inferSeverity({
    incident,
    riskLevel: risk.riskLevel,
    riskFlags,
    clusterIncidentCount,
  });
  const autonomyMode = determineAutonomyMode({ riskLevel: risk.riskLevel });
  const approvalDecision = shouldRequireApproval({
    riskLevel: risk.riskLevel,
    requiredVerificationPassed: true,
  });
  const approvalState = approvalDecision.required ? "pending" : "not_needed";

  incident.classification.domain = domain;
  incident.classification.severity = severity;
  incident.classification.riskLevel = risk.riskLevel;
  incident.classification.confidence = confidence;
  incident.classification.issueFingerprint = issueFingerprint;
  incident.classification.clusterKey = clusterKey;
  incident.classification.riskFlags = riskFlags;
  incident.classification.suspectedRoutes = [incident.context?.routePath].filter(Boolean);
  incident.autonomyMode = autonomyMode;
  incident.approvalState = approvalState;
  incident.userVisibleStatus = "investigating";
  incident.adminVisibleStatus = "active";
  Object.assign(incident.orchestration, buildNextJobFields("investigation"));

  recorder.push({
    eventType: "classification_written",
    actor: { type: "worker" },
    summary: "Incident classified for routing.",
    detail: {
      domain,
      severity,
      riskLevel: risk.riskLevel,
      confidence,
      clusterKey,
      issueFingerprint,
      riskFlags,
      clusterIncidentCount,
      autonomyMode,
      approvalState,
      reasons: risk.reasons,
    },
  });

  if (risk.riskLevel !== previousRiskLevel && risk.riskLevel !== "low") {
    recorder.push({
      eventType: "risk_reclassified",
      actor: { type: "worker" },
      summary: `Incident risk set to ${risk.riskLevel}.`,
      detail: {
        riskLevel: risk.riskLevel,
        reasons: risk.reasons,
      },
    });
  }

  await transitionIncidentState(
    incident,
    "classified",
    "Incident classified and queued for investigation.",
    recorder
  );

  clearIncidentLock(incident);
  recorder.finalize();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident });

  return {
    incident,
    domain,
    severity,
    riskLevel: risk.riskLevel,
    confidence,
    issueFingerprint,
    clusterKey,
    riskFlags,
    autonomyMode,
    approvalState,
    clusterIncidentCount,
  };
}

async function loadIncidentForLockedJob(incidentId, lockToken) {
  return Incident.findOne({
    _id: incidentId,
    "orchestration.lockToken": lockToken,
  });
}

async function processLockedIncidentJob({ incidentId, lockToken }) {
  const incident = await loadIncidentForLockedJob(incidentId, lockToken);
  if (!incident) return null;

  if (incident.orchestration.nextJobType === "intake_validation") {
    return runIntakeValidation(incident);
  }
  if (incident.orchestration.nextJobType === "classification") {
    return runClassification(incident);
  }
  if (incident.orchestration.nextJobType === "investigation") {
    const { runInvestigation } = require("./investigationService");
    return runInvestigation(incident);
  }
  if (incident.orchestration.nextJobType === "patch_planning") {
    const { runPatchPlanning } = require("./patchService");
    return runPatchPlanning(incident);
  }
  if (incident.orchestration.nextJobType === "patch_execution") {
    const { runPatchExecution } = require("./patchService");
    return runPatchExecution(incident);
  }
  if (incident.orchestration.nextJobType === "verification") {
    const { runVerification } = require("./verificationService");
    return runVerification(incident);
  }
  if (incident.orchestration.nextJobType === "deployment") {
    const { runRelease } = require("./releaseService");
    return runRelease(incident);
  }
  return null;
}

module.exports = {
  compactText,
  compactMultilineText,
  normalizeIncidentSummary,
  buildCorpus,
  buildIssueFingerprint,
  buildClusterKey,
  detectDomain,
  deriveRiskFlags,
  inferConfidence,
  inferSeverity,
  findPotentialDuplicate,
  countClusterIncidents,
  buildNextJobFields,
  incrementStageAttempt,
  clearIncidentLock,
  buildEventRecorder,
  transitionIncidentState,
  loadIncidentForLockedJob,
  runIntakeValidation,
  runClassification,
  processLockedIncidentJob,
};
