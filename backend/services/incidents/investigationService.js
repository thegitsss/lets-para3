const path = require("path");
const { execFileSync } = require("child_process");

const AuditLog = require("../../models/AuditLog");
const Incident = require("../../models/Incident");
const IncidentArtifact = require("../../models/IncidentArtifact");
const IncidentInvestigation = require("../../models/IncidentInvestigation");
const IncidentRelease = require("../../models/IncidentRelease");
const {
  reclassifyRiskUpward,
  determineAutonomyMode,
  shouldRequireApproval,
} = require("./riskEngine");
const {
  compactText,
  normalizeIncidentSummary,
  detectDomain,
  deriveRiskFlags,
  inferConfidence,
  inferSeverity,
  buildNextJobFields,
  incrementStageAttempt,
  clearIncidentLock,
  buildEventRecorder,
  transitionIncidentState,
} = require("./workflowService");
const { syncIncidentNotifications } = require("./notificationService");
const { selectPatchRecipe } = require("./patchService");

const RUNNER_ROOT = path.join(__dirname, "..", "..", "..");
const LOOKBACK_DAYS = 14;
const MAX_CLUSTER_INCIDENTS = 5;
const MAX_AUDIT_LOGS = 10;

const ROUTE_CORRELATION_RULES = Object.freeze([
  {
    key: "matching.case-detail-hire",
    label: "Case detail hiring flow",
    domains: ["matching", "case_lifecycle"],
    keywords: ["hire", "hiring", "invite", "application", "apply", "accept"],
    routeHints: ["/api/applications", "/api/cases", "/case-detail", "case-detail"],
    pageHints: ["case-detail", "case-applications"],
    suspectedRoutes: ["/api/applications", "/api/cases/:caseId"],
    suspectedFiles: [
      "backend/routes/applications.js",
      "backend/routes/cases.js",
      "frontend/case-detail.html",
      "frontend/assets/scripts/case-detail.js",
      "frontend/assets/scripts/views/case-detail.js",
      "frontend/case-applications.html",
      "frontend/assets/scripts/case-applications.js",
    ],
    impactedDomains: ["matching", "case_lifecycle"],
  },
  {
    key: "messaging.thread-delivery",
    label: "Messaging thread delivery",
    domains: ["messaging"],
    keywords: ["message", "chat", "thread", "reply", "send"],
    routeHints: ["/api/messages", "/messages", "message"],
    pageHints: ["case-detail"],
    suspectedRoutes: ["/api/messages"],
    suspectedFiles: [
      "backend/routes/messages.js",
      "frontend/assets/scripts/case-detail.js",
      "frontend/assets/scripts/views/case-detail.js",
    ],
    impactedDomains: ["messaging"],
  },
  {
    key: "documents.upload-flow",
    label: "Document upload flow",
    domains: ["documents"],
    keywords: ["document", "upload", "attachment", "file", "download", "pdf"],
    routeHints: ["/api/uploads", "/uploads", "/documents"],
    pageHints: ["documents", "case-detail"],
    suspectedRoutes: ["/api/uploads"],
    suspectedFiles: [
      "backend/routes/uploads.js",
      "frontend/assets/scripts/views/documents.js",
      "frontend/assets/scripts/case-files-view.js",
      "frontend/assets/scripts/views/case-detail.js",
    ],
    impactedDomains: ["documents"],
  },
  {
    key: "notifications.delivery",
    label: "Notification delivery",
    domains: ["notifications"],
    keywords: ["notification", "notice", "alert", "email"],
    routeHints: ["/api/notifications", "/notifications"],
    pageHints: ["dashboard"],
    suspectedRoutes: ["/api/notifications"],
    suspectedFiles: [
      "backend/routes/notifications.js",
      "frontend/assets/scripts/utils/notifications.js",
    ],
    impactedDomains: ["notifications"],
  },
  {
    key: "auth.session-access",
    label: "Authentication and session access",
    domains: ["auth", "permissions"],
    keywords: ["login", "sign in", "session", "auth", "password", "csrf", "unauthorized", "forbidden"],
    routeHints: ["/api/auth", "/auth", "/login"],
    pageHints: ["login", "auth"],
    suspectedRoutes: ["/api/auth"],
    suspectedFiles: [
      "backend/routes/auth.js",
      "backend/utils/authz.js",
      "frontend/assets/scripts/auth.js",
    ],
    impactedDomains: ["auth", "permissions"],
  },
  {
    key: "payments.risk-flow",
    label: "Payments and dispute flow",
    domains: ["payments", "stripe_onboarding", "escrow", "payouts", "withdrawals", "disputes"],
    keywords: ["payment", "payout", "stripe", "escrow", "withdraw", "dispute", "refund", "release"],
    routeHints: ["/api/payments", "/api/disputes", "/payments", "/billing", "/dispute"],
    pageHints: ["dashboard-paralegal", "billing", "case-detail"],
    suspectedRoutes: ["/api/payments", "/api/disputes"],
    suspectedFiles: [
      "backend/routes/payments.js",
      "backend/routes/paymentsWebhook.js",
      "backend/routes/disputes.js",
      "frontend/assets/scripts/payments.js",
      "frontend/assets/scripts/utils/stripe-connect.js",
      "frontend/dashboard-paralegal.html",
    ],
    impactedDomains: ["payments", "escrow", "payouts", "withdrawals", "disputes", "stripe_onboarding"],
  },
  {
    key: "profile.settings",
    label: "Profile settings flow",
    domains: ["profile", "profile_visibility"],
    keywords: ["profile", "settings", "resume", "certificate", "headshot", "toggle", "save"],
    routeHints: ["/profile", "/settings"],
    pageHints: ["profile-attorney", "profile-paralegal", "profile-settings"],
    suspectedRoutes: ["/api/users/profile"],
    suspectedFiles: [
      "backend/routes/users.js",
      "frontend/profile-settings.html",
      "frontend/assets/scripts/profile-attorney.js",
      "frontend/assets/scripts/profile-paralegal.js",
      "frontend/assets/scripts/profile-settings.js",
    ],
    impactedDomains: ["profile", "profile_visibility"],
  },
  {
    key: "jobs.application-flow",
    label: "Jobs and application flow",
    domains: ["matching"],
    keywords: ["job", "application", "browse jobs", "openings", "submit application"],
    routeHints: ["/api/jobs", "/api/applications", "/jobs", "/applications"],
    pageHints: ["browse-jobs", "job-detail", "paralegal-applications"],
    suspectedRoutes: ["/api/jobs", "/api/applications"],
    suspectedFiles: [
      "backend/routes/jobs.js",
      "backend/routes/applications.js",
      "frontend/assets/scripts/browse-jobs.js",
      "frontend/assets/scripts/views/browse-jobs.js",
      "frontend/assets/scripts/views/job-detail.js",
      "frontend/assets/scripts/paralegal-applications.js",
    ],
    impactedDomains: ["matching"],
  },
  {
    key: "case.workspace",
    label: "Case workspace flow",
    domains: ["case_lifecycle", "matching"],
    keywords: ["case", "workspace", "task", "deadline", "calendar", "deliverable"],
    routeHints: ["/api/cases", "/api/caseTasks", "/case-detail", "/active-cases"],
    pageHints: ["case-detail", "active-cases", "calendar"],
    suspectedRoutes: ["/api/cases", "/api/caseTasks"],
    suspectedFiles: [
      "backend/routes/cases.js",
      "backend/routes/caseTasks.js",
      "backend/services/caseLifecycle.js",
      "frontend/case-detail.html",
      "frontend/assets/scripts/case-detail.js",
      "frontend/assets/scripts/views/case-detail.js",
      "frontend/assets/scripts/views/calendar.js",
    ],
    impactedDomains: ["case_lifecycle"],
  },
  {
    key: "admin.dashboard",
    label: "Admin dashboard control room",
    domains: ["admin_tools"],
    keywords: ["war room", "control room", "admin dashboard", "admin"],
    routeHints: ["/api/admin", "/admin"],
    pageHints: ["admin-dashboard"],
    suspectedRoutes: ["/api/admin"],
    suspectedFiles: [
      "frontend/admin-dashboard.html",
      "frontend/assets/scripts/admin-dashboard.js",
    ],
    impactedDomains: ["admin_tools"],
  },
]);

function compactMultilineText(value, maxLength = 5000) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  return text ? text.slice(0, maxLength) : "";
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => compactText(item, 240)).filter(Boolean))];
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toLowerText(value) {
  return compactText(value, 5000).toLowerCase();
}

function inferAttemptNumber(incident) {
  const current = Number(incident.orchestration?.stageAttempts?.investigation || 0);
  return Math.max(1, current);
}

function buildSearchCorpus(incident = {}) {
  return [
    incident.summary,
    incident.originalReportText,
    incident.context?.featureKey,
    incident.context?.routePath,
    incident.context?.pageUrl,
  ]
    .map((value) => toLowerText(value))
    .filter(Boolean)
    .join("\n");
}

function hasRelatedIds(incident = {}) {
  return Boolean(
    incident.context?.caseId || incident.context?.jobId || incident.context?.applicationId
  );
}

function buildRouteCorrelation(incident = {}) {
  const corpus = buildSearchCorpus(incident);
  const routePath = toLowerText(incident.context?.routePath);
  const pageUrl = toLowerText(incident.context?.pageUrl);
  const domain = compactText(incident.classification?.domain || detectDomain(incident), 120);

  const matches = ROUTE_CORRELATION_RULES.map((rule) => {
    let score = 0;
    const reasons = [];
    const keywordHits = rule.keywords.filter((keyword) => corpus.includes(String(keyword).toLowerCase()));
    const routeHits = rule.routeHints.filter(
      (hint) => routePath.includes(String(hint).toLowerCase()) || pageUrl.includes(String(hint).toLowerCase())
    );
    const pageHits = rule.pageHints.filter((hint) => pageUrl.includes(String(hint).toLowerCase()));
    const domainMatch = rule.domains.includes(domain);

    if (domainMatch) {
      score += 3;
      reasons.push(`domain:${domain}`);
    }
    if (routeHits.length) {
      score += 3;
      reasons.push(`route:${routeHits.join(",")}`);
    }
    if (pageHits.length) {
      score += 2;
      reasons.push(`page:${pageHits.join(",")}`);
    }
    if (keywordHits.length) {
      score += Math.min(3, keywordHits.length);
      reasons.push(`keywords:${keywordHits.join(",")}`);
    }

    if (score < 2) return null;

    const confidence = score >= 6 ? "high" : score >= 4 ? "medium" : "low";
    return {
      key: rule.key,
      label: rule.label,
      score,
      confidence,
      reasons,
      suspectedRoutes: normalizeStringArray(rule.suspectedRoutes),
      suspectedFiles: normalizeStringArray(rule.suspectedFiles),
      impactedDomains: normalizeStringArray(rule.impactedDomains),
    };
  })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  const explicitRoute = routePath.startsWith("/api/") ? compactText(incident.context?.routePath, 200) : "";
  const suspectedRoutes = normalizeStringArray([
    ...matches.flatMap((match) => match.suspectedRoutes),
    explicitRoute,
  ]);
  const suspectedFiles = normalizeStringArray(matches.flatMap((match) => match.suspectedFiles));
  const impactedDomains = normalizeStringArray([
    incident.classification?.domain,
    ...matches.flatMap((match) => match.impactedDomains),
  ]);

  return {
    matchedRules: matches.slice(0, 3),
    suspectedRoutes,
    suspectedFiles,
    impactedDomains,
  };
}

async function buildClusterSummary(incident = {}) {
  const clusterKey = compactText(incident.classification?.clusterKey, 120);
  if (!clusterKey) {
    return {
      clusterKey: "",
      count: 1,
      incidents: [],
    };
  }

  const [count, incidents] = await Promise.all([
    Incident.countDocuments({ "classification.clusterKey": clusterKey }),
    Incident.find({
      "classification.clusterKey": clusterKey,
    })
      .sort({ createdAt: -1 })
      .limit(MAX_CLUSTER_INCIDENTS)
      .lean(),
  ]);

  return {
    clusterKey,
    count,
    incidents: incidents.map((row) => ({
      publicId: row.publicId || "",
      state: row.state || "",
      summary: normalizeIncidentSummary(row.summary || ""),
      riskLevel: row.classification?.riskLevel || "",
      surface: row.context?.surface || "",
      createdAt: row.createdAt || null,
    })),
  };
}

async function buildAuditLogExcerpt(incident = {}, correlation = {}) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const orClauses = [];
  const routePath = compactText(incident.context?.routePath, 240);
  const caseId = incident.context?.caseId || null;
  const routeHints = correlation.suspectedRoutes || [];

  if (routePath) {
    orClauses.push({ path: { $regex: escapeRegex(routePath), $options: "i" } });
  }
  routeHints.forEach((hint) => {
    const normalized = compactText(hint, 240);
    if (!normalized) return;
    orClauses.push({ path: { $regex: escapeRegex(normalized.replace(/:\w+/g, "")), $options: "i" } });
  });
  if (caseId) {
    orClauses.push({ case: caseId });
  }

  if (!orClauses.length) {
    return {
      matchedCount: 0,
      note: "No scoped audit-log query was available for this incident yet.",
      entries: [],
    };
  }

  const logs = await AuditLog.find({
    createdAt: { $gte: since },
    $or: orClauses,
  })
    .sort({ createdAt: -1 })
    .limit(MAX_AUDIT_LOGS)
    .lean();

  return {
    matchedCount: logs.length,
    note: logs.length
      ? `Found ${logs.length} recent audit-log entries matching the reported flow.`
      : "No recent audit-log matches were found for the reported flow.",
    entries: logs.map((entry) => ({
      action: entry.action || "",
      targetType: entry.targetType || "",
      targetId: entry.targetId || "",
      caseId: entry.case ? String(entry.case) : "",
      path: entry.path || "",
      actorRole: entry.actorRole || "",
      createdAt: entry.createdAt || null,
    })),
  };
}

function readCurrentCommitSha() {
  const envValue = compactText(
    process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || process.env.COMMIT_SHA,
    120
  );
  if (envValue) return envValue;

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: RUNNER_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

async function buildRecentDeployCorrelation() {
  const latestRelease = await IncidentRelease.findOne({})
    .sort({ deployedAt: -1, createdAt: -1 })
    .lean();
  const currentCommitSha = readCurrentCommitSha();
  const suspectedDeploySha =
    compactText(latestRelease?.productionCommitSha, 120) ||
    compactText(latestRelease?.previewCommitSha, 120) ||
    currentCommitSha;

  return {
    available: Boolean(latestRelease || currentCommitSha),
    note: latestRelease
      ? "Recent incident release metadata is available for comparison."
      : currentCommitSha
      ? "Using the runner repository commit as the latest available deploy hint."
      : "No deploy metadata is available yet.",
    latestRelease: latestRelease
      ? {
          releaseId: String(latestRelease._id),
          status: latestRelease.status || "",
          deployedAt: latestRelease.deployedAt || latestRelease.createdAt || null,
          productionCommitSha: latestRelease.productionCommitSha || "",
          previewCommitSha: latestRelease.previewCommitSha || "",
        }
      : null,
    currentCommitSha,
    suspectedDeploySha,
  };
}

function buildReproContext(incident = {}, correlation = {}, clusterSummary = {}) {
  const related = [];
  if (incident.context?.caseId) related.push(`case ${incident.context.caseId}`);
  if (incident.context?.jobId) related.push(`job ${incident.context.jobId}`);
  if (incident.context?.applicationId) related.push(`application ${incident.context.applicationId}`);

  const steps = [];
  if (incident.reporter?.role) {
    steps.push(`Sign in as the reported ${incident.reporter.role} role.`);
  }
  if (incident.context?.pageUrl) {
    steps.push(`Open ${incident.context.pageUrl}.`);
  } else if (incident.context?.routePath) {
    steps.push(`Open the reported route ${incident.context.routePath}.`);
  }
  if (incident.context?.featureKey) {
    steps.push(`Navigate to the "${incident.context.featureKey}" surface.`);
  }
  if (related.length) {
    steps.push(`Use the related ${related.join(", ")} context if available.`);
  }
  steps.push(`Attempt the action described in the report: ${normalizeIncidentSummary(incident.summary || "reported issue")}.`);

  return {
    derivedFromReport: true,
    clusterCount: Number(clusterSummary.count || 0),
    suspectedRoutes: correlation.suspectedRoutes || [],
    suspectedFiles: correlation.suspectedFiles || [],
    steps,
  };
}

function buildHypotheses({
  incident = {},
  correlation = {},
  clusterSummary = {},
  auditLogExcerpt = {},
  deployCorrelation = {},
}) {
  const hypotheses = [];

  correlation.matchedRules.forEach((match, index) => {
    const routeHint = match.suspectedRoutes[0] ? ` via ${match.suspectedRoutes[0]}` : "";
    const fileHint = match.suspectedFiles[0] ? ` in ${match.suspectedFiles[0]}` : "";
    hypotheses.push({
      key: match.key,
      statement: `Likely issue in ${match.label.toLowerCase()}${routeHint}${fileHint}. Reported context matched ${match.reasons.join("; ")}.`,
      confidence: match.confidence,
      selected: index === 0,
      status: index === 0 && match.confidence === "high" ? "confirmed" : "pending",
    });
  });

  if (clusterSummary.count > 1) {
    hypotheses.push({
      key: "cluster-regression",
      statement: `The incident aligns with ${clusterSummary.count} reports in cluster ${clusterSummary.clusterKey}, suggesting a shared regression rather than an isolated user issue.`,
      confidence: clusterSummary.count >= 3 ? "high" : "medium",
      selected: hypotheses.length === 0,
      status: "pending",
    });
  }

  if (auditLogExcerpt.matchedCount > 0) {
    hypotheses.push({
      key: "audit-log-correlation",
      statement: `Recent audit-log activity overlaps the reported flow, which supports investigating the correlated route handling before attempting a fix.`,
      confidence: auditLogExcerpt.matchedCount >= 3 ? "medium" : "low",
      selected: hypotheses.length === 0,
      status: "pending",
    });
  }

  if (deployCorrelation.suspectedDeploySha) {
    hypotheses.push({
      key: "recent-deploy-correlation",
      statement: `A recent repository or release commit (${deployCorrelation.suspectedDeploySha.slice(0, 12)}) is the latest available deploy hint for this investigation.`,
      confidence: deployCorrelation.latestRelease ? "medium" : "low",
      selected: hypotheses.length === 0,
      status: "pending",
    });
  }

  return hypotheses.slice(0, 3).map((hypothesis, index, list) => ({
    ...hypothesis,
    selected: list.some((entry) => entry.selected) ? hypothesis.selected : index === 0,
  }));
}

function selectRootCauseSummary(hypotheses = [], correlation = {}) {
  const selected = hypotheses.find((hypothesis) => hypothesis.selected) || hypotheses[0];
  if (!selected) {
    return "The current report did not produce a confident technical hypothesis.";
  }

  const matchedRule = correlation.matchedRules[0];
  const prefix = selected.confidence === "high" ? "Likely cause" : "Working hypothesis";
  const routeHint = matchedRule?.suspectedRoutes?.[0]
    ? ` Focus route: ${matchedRule.suspectedRoutes[0]}.`
    : "";
  return `${prefix}: ${selected.statement}${routeHint}`;
}

function determineInvestigationOutcome({
  incident = {},
  correlation = {},
  hypotheses = [],
  auditLogExcerpt = {},
  riskUpgrade = {},
}) {
  const hasContext = Boolean(
    incident.context?.routePath ||
      incident.context?.pageUrl ||
      incident.context?.featureKey ||
      hasRelatedIds(incident)
  );
  const selectedHypothesis = hypotheses.find((hypothesis) => hypothesis.selected) || hypotheses[0] || null;
  const hasActionableHypothesis =
    Boolean(selectedHypothesis) &&
    ["medium", "high"].includes(selectedHypothesis.confidence) &&
    Boolean(correlation.suspectedRoutes.length || correlation.suspectedFiles.length);
  const protectedUpgradeWithoutEvidence =
    riskUpgrade.upgraded === true &&
    riskUpgrade.riskLevel === "high" &&
    !hasContext &&
    auditLogExcerpt.matchedCount === 0;
  const lacksInvestigationContext =
    !hasContext && correlation.matchedRules.length === 0 && auditLogExcerpt.matchedCount === 0;

  if (protectedUpgradeWithoutEvidence) {
    return {
      finalState: "needs_human_owner",
      investigationStatus: "escalated",
      recommendedAction: "manual_handoff",
      userVisibleStatus: "awaiting_internal_review",
      adminVisibleStatus: "active",
      nextJobType: "none",
      summary: "Investigation escalated because protected-domain evidence could not be validated safely with the available context.",
      resolution: null,
    };
  }

  if (lacksInvestigationContext) {
    return {
      finalState: "needs_more_context",
      investigationStatus: "needs_more_context",
      recommendedAction: "request_context",
      userVisibleStatus: "needs_more_info",
      adminVisibleStatus: "active",
      nextJobType: "none",
      summary: "Investigation needs more route or case context before a technical hypothesis can be trusted.",
      resolution: null,
    };
  }

  if (hasActionableHypothesis) {
    return {
      finalState: "patch_planning",
      investigationStatus: "completed",
      recommendedAction: "patch",
      userVisibleStatus: "investigating",
      adminVisibleStatus: "active",
      nextJobType: "patch_planning",
      summary: "Investigation found an actionable technical hypothesis and queued patch planning.",
      resolution: null,
    };
  }

  return {
    finalState: "closed_no_repro",
    investigationStatus: "no_repro",
    recommendedAction: "close_not_actionable",
    userVisibleStatus: "closed",
    adminVisibleStatus: "closed",
    nextJobType: "none",
    summary: "Investigation did not reproduce the issue or produce an actionable hypothesis with the current evidence.",
    resolution: {
      code: "no_repro",
      summary: "Investigation closed after a no-repro outcome.",
      resolvedAt: new Date(),
      closedAt: new Date(),
    },
  };
}

async function createArtifact({
  incidentId,
  investigationId,
  artifactType,
  label,
  contentType,
  body,
}) {
  return IncidentArtifact.create({
    incidentId,
    investigationId,
    artifactType,
    stage: "investigation",
    label,
    contentType,
    storageMode: "inline",
    body,
    createdByAgent: "engineering_agent",
  });
}

async function createInvestigationArtifacts({
  incident,
  investigation,
  correlation,
  clusterSummary,
  reproContext,
  auditLogExcerpt,
  deployCorrelation,
  hypotheses,
}) {
  const routeMapArtifact = await createArtifact({
    incidentId: incident._id,
    investigationId: investigation._id,
    artifactType: "route_map",
    label: "Investigation route and file correlation",
    contentType: "json",
    body: {
      matchedRules: correlation.matchedRules,
      suspectedRoutes: correlation.suspectedRoutes,
      suspectedFiles: correlation.suspectedFiles,
      impactedDomains: correlation.impactedDomains,
      deployCorrelation,
      selectedHypothesis: hypotheses.find((hypothesis) => hypothesis.selected) || null,
    },
  });

  const clusterArtifact = await createArtifact({
    incidentId: incident._id,
    investigationId: investigation._id,
    artifactType: "cluster_summary",
    label: "Cluster comparison",
    contentType: "json",
    body: clusterSummary,
  });

  const reproArtifact = await createArtifact({
    incidentId: incident._id,
    investigationId: investigation._id,
    artifactType: "repro_steps",
    label: "Derived reproduction context",
    contentType: "json",
    body: reproContext,
  });

  const logArtifact = await createArtifact({
    incidentId: incident._id,
    investigationId: investigation._id,
    artifactType: "log_excerpt",
    label: "Recent audit-log excerpt",
    contentType: "json",
    body: auditLogExcerpt,
  });

  return {
    routeMapArtifact,
    clusterArtifact,
    reproArtifact,
    logArtifact,
  };
}

async function runInvestigation(incident) {
  const recorder = buildEventRecorder(incident);
  incrementStageAttempt(incident, "investigation");

  const attemptNumber = inferAttemptNumber(incident);
  const investigation = await IncidentInvestigation.create({
    incidentId: incident._id,
    attemptNumber,
    status: "running",
    triggerType: "auto",
    assignedAgent: "engineering_agent",
    startedAt: new Date(),
  });

  incident.currentInvestigationId = investigation._id;

  if (incident.state === "classified") {
    await transitionIncidentState(
      incident,
      "investigating",
      "Incident investigation started.",
      recorder
    );
  }

  recorder.push({
    eventType: "investigation_started",
    actor: { type: "agent", agentRole: "engineering_agent" },
    summary: `Investigation attempt ${attemptNumber} started.`,
    detail: {
      investigationId: String(investigation._id),
      attemptNumber,
    },
  });

  const correlation = buildRouteCorrelation(incident);
  const clusterSummary = await buildClusterSummary(incident);
  const auditLogExcerpt = await buildAuditLogExcerpt(incident, correlation);
  const deployCorrelation = await buildRecentDeployCorrelation();
  const reproContext = buildReproContext(incident, correlation, clusterSummary);
  const hypotheses = buildHypotheses({
    incident,
    correlation,
    clusterSummary,
    auditLogExcerpt,
    deployCorrelation,
  });
  const rootCauseSummary = selectRootCauseSummary(hypotheses, correlation);
  const riskFlags = {
    ...(incident.classification?.riskFlags || {}),
    ...deriveRiskFlags(incident),
  };
  const reclassifiedDomain =
    correlation.impactedDomains.find((value) => value === "auth" || value === "payments") ||
    incident.classification?.domain ||
    detectDomain(incident);
  const confidence = inferConfidence(incident, {
    domain: reclassifiedDomain,
    clusterIncidentCount: clusterSummary.count,
  });
  const automationRecipe = selectPatchRecipe({
    incident,
    investigation: {
      suspectedFiles: correlation.suspectedFiles,
    },
  });
  const riskUpgrade = reclassifyRiskUpward(incident.classification?.riskLevel, {
    domain: reclassifiedDomain,
    summary: incident.summary,
    originalReportText: incident.originalReportText,
    rootCauseSummary,
    confidence,
    suspectedRoutes: correlation.suspectedRoutes,
    suspectedFiles: correlation.suspectedFiles,
    riskFlags,
    clusterIncidentCount: clusterSummary.count,
    allowedProtectedPaths: automationRecipe?.allowedProtectedPaths || [],
  });
  const effectiveRiskLevel =
    automationRecipe?.key === "preferences.save-button-regression" ? "low" : riskUpgrade.riskLevel;
  const severity = inferSeverity({
    incident,
    riskLevel: effectiveRiskLevel,
    riskFlags,
    clusterIncidentCount: clusterSummary.count,
  });
  const autonomyMode = determineAutonomyMode({ riskLevel: effectiveRiskLevel });
  const approvalDecision = shouldRequireApproval({
    riskLevel: effectiveRiskLevel,
    requiredVerificationPassed: true,
  });
  const approvalState = approvalDecision.required ? "pending" : "not_needed";

  if (riskUpgrade.upgraded) {
    incident.classification.riskLevel = riskUpgrade.riskLevel;
    incident.classification.severity = severity;
    incident.classification.confidence = confidence;
    incident.classification.riskFlags = riskFlags;
    incident.autonomyMode = autonomyMode;
    incident.approvalState = approvalState;
    recorder.push({
      eventType: "risk_reclassified",
      actor: { type: "agent", agentRole: "engineering_agent" },
      summary: `Incident risk raised to ${riskUpgrade.riskLevel} during investigation.`,
      detail: {
        previousRiskLevel: riskUpgrade.previousRiskLevel,
        riskLevel: riskUpgrade.riskLevel,
        reasons: riskUpgrade.reasons,
        protectedPathMatches: riskUpgrade.protectedPathMatches,
      },
    });
  }

  if (automationRecipe?.key === "preferences.save-button-regression") {
    incident.classification.riskLevel = effectiveRiskLevel;
    incident.autonomyMode = autonomyMode;
    incident.approvalState = approvalState;
  }

  incident.classification.suspectedRoutes = normalizeStringArray([
    ...(incident.classification?.suspectedRoutes || []),
    ...correlation.suspectedRoutes,
  ]);
  incident.classification.suspectedFiles = normalizeStringArray([
    ...(incident.classification?.suspectedFiles || []),
    ...correlation.suspectedFiles,
  ]);
  if (
    (!incident.classification.domain || incident.classification.domain === "unknown") &&
    correlation.impactedDomains.length
  ) {
    incident.classification.domain = correlation.impactedDomains[0];
  }
  incident.classification.confidence = confidence;
  incident.classification.riskFlags = riskFlags;
  incident.classification.severity = severity;

  const artifacts = await createInvestigationArtifacts({
    incident,
    investigation,
    correlation,
    clusterSummary,
    reproContext,
    auditLogExcerpt,
    deployCorrelation,
    hypotheses,
  });

  investigation.status = "completed";
  investigation.rootCauseSummary = compactMultilineText(rootCauseSummary, 1200);
  investigation.rootCauseConfidence = hypotheses[0]?.confidence || "low";
  investigation.reproductionStatus =
    auditLogExcerpt.matchedCount > 0 || clusterSummary.count > 1 ? "partially_reproduced" : "not_reproduced";
  investigation.hypotheses = hypotheses;
  investigation.impactedDomains = correlation.impactedDomains;
  investigation.suspectedRoutes = correlation.suspectedRoutes;
  investigation.suspectedFiles = correlation.suspectedFiles;
  investigation.suspectedDeploySha = deployCorrelation.suspectedDeploySha || "";
  investigation.summaryArtifactId = artifacts.routeMapArtifact._id;
  investigation.completedAt = new Date();

  const outcome = determineInvestigationOutcome({
    incident,
    correlation,
    hypotheses,
    auditLogExcerpt,
    riskUpgrade,
  });

  if (outcome.investigationStatus !== "completed") {
    investigation.status = outcome.investigationStatus;
    if (outcome.investigationStatus === "escalated") {
      investigation.failedAt = new Date();
    }
    if (outcome.investigationStatus === "needs_more_context" || outcome.investigationStatus === "no_repro") {
      investigation.reproductionStatus = "not_reproduced";
    }
  }

  investigation.recommendedAction = outcome.recommendedAction;
  await investigation.save();

  incident.userVisibleStatus = outcome.userVisibleStatus;
  incident.adminVisibleStatus = outcome.adminVisibleStatus;
  Object.assign(incident.orchestration, buildNextJobFields(outcome.nextJobType));

  if (outcome.resolution) {
    incident.resolution = outcome.resolution;
  }

  recorder.push({
    eventType: "investigation_completed",
    actor: { type: "agent", agentRole: "engineering_agent" },
    summary: outcome.summary,
    detail: {
      investigationId: String(investigation._id),
      status: investigation.status,
      reproductionStatus: investigation.reproductionStatus,
      recommendedAction: outcome.recommendedAction,
      impactedDomains: investigation.impactedDomains,
      suspectedRoutes: investigation.suspectedRoutes,
      suspectedFiles: investigation.suspectedFiles,
    },
    artifactIds: [
      artifacts.routeMapArtifact._id,
      artifacts.clusterArtifact._id,
      artifacts.reproArtifact._id,
      artifacts.logArtifact._id,
    ],
  });

  await transitionIncidentState(
    incident,
    outcome.finalState,
    outcome.summary,
    recorder
  );

  clearIncidentLock(incident);
  recorder.finalize();
  await incident.save();
  await recorder.save();
  await syncIncidentNotifications({ incident });

  return {
    incident,
    investigation,
    artifacts: {
      routeMapArtifactId: String(artifacts.routeMapArtifact._id),
      clusterArtifactId: String(artifacts.clusterArtifact._id),
      reproArtifactId: String(artifacts.reproArtifact._id),
      logArtifactId: String(artifacts.logArtifact._id),
    },
    outcome,
  };
}

module.exports = {
  ROUTE_CORRELATION_RULES,
  buildRouteCorrelation,
  buildClusterSummary,
  buildAuditLogExcerpt,
  buildRecentDeployCorrelation,
  buildReproContext,
  buildHypotheses,
  determineInvestigationOutcome,
  runInvestigation,
};
