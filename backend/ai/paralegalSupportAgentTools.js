const mongoose = require("mongoose");
const Application = require("../models/Application");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const Job = require("../models/Job");
const Message = require("../models/Message");
const Payout = require("../models/Payout");
const Task = require("../models/Task");
const User = require("../models/User");
const { retrieveSupportKnowledge } = require("../services/knowledge/retrievalService");
const {
  getPayoutSnapshot,
  getStripeConnectSnapshot,
} = require("../services/support/contextResolverService");
const { getAccountDeactivationEligibility } = require("../services/userDeletion");
const {
  evaluateApplicationEligibility,
  evaluateArchiveAccess,
  evaluateCompletionState,
  evaluateInvitationEligibility,
  evaluateMessagingPermission,
  evaluatePayoutReadiness,
  evaluatePreEngagementSubmission,
  evaluateWithdrawalEligibility,
  evaluateWorkspaceAccess,
  normalizeStatus,
} = require("../services/paralegalWorkflowPolicy");

const EMPTY_PARAMETERS = Object.freeze({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});

const CASE_REFERENCE_PARAMETERS = Object.freeze({
  type: "object",
  properties: {
    case_reference: {
      type: "string",
      description: "Authorized matter ID or title. Use an empty string only when the current page identifies the matter.",
    },
  },
  required: ["case_reference"],
  additionalProperties: false,
});

const PARALEGAL_TOOL_DEFINITIONS = Object.freeze({
  search_lpc_knowledge: {
    type: "function",
    name: "search_lpc_knowledge",
    description: "Search approved LPC product knowledge. This never proves account or matter state.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The LPC product question." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_paralegal_case_overview: {
    type: "function",
    name: "get_paralegal_case_overview",
    description: "Get counts and safe summaries for matters assigned to or previously worked by the signed-in paralegal.",
    parameters: {
      type: "object",
      properties: {
        status_scope: { type: "string", enum: ["all", "active", "completed"] },
      },
      required: ["status_scope"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_paralegal_case_workspace: {
    type: "function",
    name: "get_paralegal_case_workspace",
    description: "Get a least-privilege workspace snapshot for an assigned or withdrawn matter.",
    parameters: CASE_REFERENCE_PARAMETERS,
    strict: true,
  },
  get_paralegal_application_activity: {
    type: "function",
    name: "get_paralegal_application_activity",
    description: "Get the signed-in paralegal's own reconciled application activity.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_paralegal_invitation_activity: {
    type: "function",
    name: "get_paralegal_invitation_activity",
    description: "Get the signed-in paralegal's own invitations and pre-engagement state.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_paralegal_attention_summary: {
    type: "function",
    name: "get_paralegal_attention_summary",
    description: "Get a read-only summary of assigned work, invitations, applications, messages, deadlines, and payout setup needing attention.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_paralegal_payout_setup: {
    type: "function",
    name: "get_paralegal_payout_setup",
    description: "Get safe live/stored Stripe Connect readiness for the signed-in paralegal.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_paralegal_payout_history: {
    type: "function",
    name: "get_paralegal_payout_history",
    description: "Get the signed-in paralegal's own payout history and current release state.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_paralegal_case_financials: {
    type: "function",
    name: "get_paralegal_case_financials",
    description: "Get gross, paralegal platform fee, and net payout for one authorized matter without attorney billing data.",
    parameters: CASE_REFERENCE_PARAMETERS,
    strict: true,
  },
  get_paralegal_account_snapshot: {
    type: "function",
    name: "get_paralegal_account_snapshot",
    description: "Get safe profile, visibility, preference, notification, onboarding, document-presence, and 2FA state for the signed-in paralegal.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_paralegal_deactivation_eligibility: {
    type: "function",
    name: "get_paralegal_deactivation_eligibility",
    description: "Check read-only paralegal account deactivation eligibility and safe blocker categories.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_paralegal_workflow_readiness: {
    type: "function",
    name: "get_paralegal_workflow_readiness",
    description: "Evaluate application, invitation, pre-engagement, workspace, completion, payout, withdrawal, and archive readiness for an authorized matter.",
    parameters: CASE_REFERENCE_PARAMETERS,
    strict: true,
  },
  get_paralegal_messaging_state: {
    type: "function",
    name: "get_paralegal_messaging_state",
    description: "Get send permission, unread count, and response state for one authorized assigned matter.",
    parameters: CASE_REFERENCE_PARAMETERS,
    strict: true,
  },
  find_paralegal_navigation_destination: {
    type: "function",
    name: "find_paralegal_navigation_destination",
    description: "Return one approved paralegal page and label.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          enum: ["cases", "completed_cases", "applications", "browse_cases", "payouts", "messages", "profile", "support", "contact"],
        },
      },
      required: ["destination"],
      additionalProperties: false,
    },
    strict: true,
  },
});

const PARALEGAL_TOOL_NAMES = Object.freeze(Object.keys(PARALEGAL_TOOL_DEFINITIONS));

const PARALEGAL_NAVIGATION = Object.freeze({
  cases: { ctaLabel: "My cases", ctaHref: "dashboard-paralegal.html#cases" },
  completed_cases: { ctaLabel: "Completed cases", ctaHref: "dashboard-paralegal.html#cases-completed" },
  applications: { ctaLabel: "My applications", ctaHref: "dashboard-paralegal.html#cases" },
  browse_cases: { ctaLabel: "Browse cases", ctaHref: "browse-jobs.html" },
  payouts: { ctaLabel: "Payout settings", ctaHref: "profile-settings.html" },
  messages: { ctaLabel: "My cases", ctaHref: "dashboard-paralegal.html#cases" },
  profile: { ctaLabel: "Profile settings", ctaHref: "profile-settings.html" },
  support: { ctaLabel: "Help center", ctaHref: "help.html" },
  contact: { ctaLabel: "Contact Us", ctaHref: "contact.html" },
});

const WORKSPACE_FIELDS = [
  "_id",
  "title",
  "practiceArea",
  "status",
  "deadline",
  "tasks",
  "tasksLocked",
  "files",
  "attorney",
  "attorneyId",
  "attorneyNameSnapshot",
  "paralegal",
  "paralegalId",
  "withdrawnParalegalId",
  "preEngagement",
  "hiredAt",
  "completedAt",
  "readOnly",
  "archived",
  "paralegalAccessRevokedAt",
  "pausedReason",
  "pausedAt",
  "disputeDeadlineAt",
  "payoutFinalizedAt",
  "payoutFinalizedType",
  "partialPayoutAmount",
  "remainingAmount",
  "currency",
  "lockedTotalAmount",
  "totalAmount",
  "feeParalegalPct",
  "feeParalegalAmount",
  "paymentReleased",
  "paidOutAt",
  "escrowIntentId",
  "escrowStatus",
  "paymentStatus",
  "disputes",
  "moderationStatus",
  "archiveReadyAt",
  "purgeScheduledFor",
  "purgedAt",
  "updatedAt",
].join(" ");

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function escapeRegex(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serializeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatMoney(cents, currency = "usd") {
  if (!Number.isFinite(Number(cents))) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: String(currency || "usd").toUpperCase(),
  }).format(Number(cents) / 100);
}

function evidence(capabilityId, facts = {}, options = {}) {
  return {
    capabilityId,
    state: options.state || "verified",
    authorized: options.authorized !== false,
    subjectType: options.subjectType || "account",
    subjectId: options.subjectId || "",
    matterId: options.matterId || "",
    policyOrLiveState: options.policyOrLiveState || "live_state",
    observedAt: options.observedAt || new Date().toISOString(),
    facts: Object.entries(facts).map(([key, value]) => ({ key, value })),
    missingFacts: options.missingFacts || [],
  };
}

function unavailable(capabilityId, state = "temporarily_unavailable", reason = "") {
  return {
    ok: state !== "temporarily_unavailable",
    available: false,
    authorized: state !== "unauthorized",
    evidenceState: state,
    reason,
    evidence: evidence(capabilityId, {}, {
      state,
      authorized: state !== "unauthorized",
      missingFacts: reason ? [reason] : [],
    }),
  };
}

function buildParalegalParticipationFilter(userId, { includeWithdrawn = true } = {}) {
  const relationships = [{ paralegal: userId }, { paralegalId: userId }];
  if (includeWithdrawn) relationships.push({ withdrawnParalegalId: userId });
  return { $or: relationships };
}

function buildParalegalApplicationRelationshipFilter(userId) {
  return {
    $or: [
      { "applicants.paralegalId": userId },
      { "invites.paralegalId": userId },
      { pendingParalegalId: userId },
    ],
  };
}

async function resolveParalegalCase(user = {}, caseReference = "", { includeWithdrawn = true } = {}) {
  const userId = user._id || user.id;
  if (!userId) return unavailable("P02_matter_details", "unauthorized", "missing_authenticated_user");
  const reference = String(caseReference || "").trim();
  if (!reference) {
    return {
      ok: true,
      available: false,
      authorized: true,
      clarificationNeeded: true,
      clarificationPrompt: "Which matter do you mean?",
      evidenceState: "unknown",
      evidence: evidence("P02_matter_details", {}, { state: "unknown", missingFacts: ["case_reference"] }),
    };
  }
  const clauses = [buildParalegalParticipationFilter(userId, { includeWithdrawn })];
  if (mongoose.isValidObjectId(reference)) clauses.push({ _id: reference });
  else clauses.push({ title: { $regex: escapeRegex(reference), $options: "i" } });
  const docs = await Case.find({ $and: clauses }).select(WORKSPACE_FIELDS).sort({ updatedAt: -1 }).limit(3).lean();
  if (!docs.length) return unavailable("P02_matter_details", "unauthorized", "matter_not_accessible");
  if (docs.length > 1) {
    return {
      ok: true,
      available: false,
      authorized: true,
      clarificationNeeded: true,
      clarificationPrompt: `I found more than one matching matter: ${docs.map((doc) => doc.title).join(", ")}. Which one do you mean?`,
      candidates: docs.map((doc) => ({ caseId: String(doc._id), title: String(doc.title || "") })),
      evidenceState: "unknown",
      evidence: evidence("P02_matter_details", {}, { state: "unknown", missingFacts: ["unique_matter"] }),
    };
  }
  return { ok: true, available: true, authorized: true, evidenceState: "verified", caseDoc: docs[0] };
}

function safeAttorneyName(caseDoc = {}) {
  const attorney = caseDoc.attorney && typeof caseDoc.attorney === "object"
    ? caseDoc.attorney
    : caseDoc.attorneyId && typeof caseDoc.attorneyId === "object"
      ? caseDoc.attorneyId
      : null;
  return [attorney?.firstName, attorney?.lastName].filter(Boolean).join(" ").trim() ||
    String(caseDoc.attorneyNameSnapshot || "");
}

function getWithdrawnAccessCutoff(caseDoc = {}, relationship = "") {
  if (relationship !== "withdrawn") return null;
  const value = caseDoc.paralegalAccessRevokedAt || caseDoc.pausedAt || caseDoc.payoutFinalizedAt;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecordVisibleAtCutoff(record = {}, cutoff = null) {
  if (!cutoff) return true;
  if (!record.createdAt) return false;
  const createdAt = record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt);
  return !Number.isNaN(createdAt.getTime()) && createdAt <= cutoff;
}

function getOwnParalegalInviteRecords(caseDoc = {}, userId = "") {
  const ownInvites = (Array.isArray(caseDoc.invites) ? caseDoc.invites : [])
    .filter((item) => normalizeId(item?.paralegalId) === normalizeId(userId));
  if (ownInvites.length) return ownInvites;
  if (normalizeId(caseDoc.pendingParalegalId) !== normalizeId(userId)) return [];
  return [{
    paralegalId: userId,
    status: "pending",
    invitedAt: caseDoc.pendingParalegalInvitedAt || null,
    respondedAt: null,
    source: "legacy_pending",
  }];
}

async function loadParalegalPayoutUser(user = {}) {
  const userId = user._id || user.id;
  if (!userId) return null;
  return User.findOne({ _id: userId, role: "paralegal" })
    .select("_id role status stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled")
    .lean();
}

async function getParalegalCaseOverview(user = {}, statusScope = "all") {
  const userId = user._id || user.id;
  const docs = await Case.find(buildParalegalParticipationFilter(userId))
    .select("_id title status deadline paralegal paralegalId withdrawnParalegalId archived readOnly paymentReleased completedAt updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
  const completed = (doc) => ["completed", "closed"].includes(normalizeStatus(doc.status)) || doc.paymentReleased === true;
  const activeDocs = docs.filter((doc) => !completed(doc) && doc.archived !== true);
  const completedDocs = docs.filter(completed);
  const scoped = statusScope === "active" ? activeDocs : statusScope === "completed" ? completedDocs : docs;
  const items = scoped.slice(0, 20).map((doc) => ({
    caseId: String(doc._id),
    title: String(doc.title || "Untitled matter"),
    status: normalizeStatus(doc.status),
    deadline: serializeDate(doc.deadline),
    relationship: normalizeId(doc.withdrawnParalegalId) === normalizeId(userId) ? "withdrawn" : "assigned",
    archived: doc.archived === true,
    readOnly: doc.readOnly === true,
  }));
  const facts = {
    totalCount: docs.length,
    activeCount: activeDocs.length,
    completedCount: completedDocs.length,
    requestedScope: statusScope,
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    items,
    evidence: evidence("P01_assigned_overview", facts),
  };
}

async function getParalegalCaseWorkspace(user = {}, caseReference = "") {
  const resolved = await resolveParalegalCase(user, caseReference);
  if (!resolved.caseDoc) return resolved;
  const caseDoc = resolved.caseDoc;
  const userId = user._id || user.id;
  const workspace = evaluateWorkspaceAccess({ user, caseDoc });
  const withdrawnCutoff = getWithdrawnAccessCutoff(caseDoc, workspace.facts.relationship);
  const taskQuery = { caseId: caseDoc._id, paralegalId: userId };
  const fileQuery = { caseId: caseDoc._id };
  if (withdrawnCutoff) {
    taskQuery.createdAt = { $lte: withdrawnCutoff };
    fileQuery.createdAt = { $lte: withdrawnCutoff };
  }
  const [standaloneTasks, fileDocs] = await Promise.all([
    Task.find(taskQuery)
      .select("_id title description dueDate status createdAt")
      .sort({ createdAt: 1 })
      .lean(),
    CaseFile.find(fileQuery)
      .select("_id originalName mimeType size uploadedByRole status version revisionNotes revisionRequestedAt approvedAt createdAt")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);
  const visibleScopeTasks = (caseDoc.tasks || []).filter((task) =>
    isRecordVisibleAtCutoff(task, withdrawnCutoff)
  );
  const visibleEmbeddedFiles = (caseDoc.files || []).filter((file) =>
    isRecordVisibleAtCutoff(file, withdrawnCutoff)
  );
  const facts = {
    matterId: String(caseDoc._id),
    title: String(caseDoc.title || ""),
    status: normalizeStatus(caseDoc.status),
    deadline: serializeDate(caseDoc.deadline),
    attorneyName: safeAttorneyName(caseDoc),
    relationship: workspace.facts.relationship,
    readOnly: workspace.facts.readOnly,
    archived: workspace.facts.archived,
    scopeTasks: visibleScopeTasks.map((task) => ({
      title: String(task?.title || ""),
      completed: task?.completed === true,
    })),
    standaloneTasks: standaloneTasks.map((task) => ({
      taskId: String(task._id),
      title: String(task.title || ""),
      description: String(task.description || ""),
      dueDate: serializeDate(task.dueDate),
      status: String(task.status || ""),
    })),
    files: [
      ...visibleEmbeddedFiles.map((file) => ({
        fileId: normalizeId(file._id),
        name: String(file.original || file.filename || ""),
        mimeType: String(file.mime || ""),
        size: Number(file.size || 0),
        uploadedByRole: String(file.uploadedByRole || ""),
        status: String(file.status || ""),
        version: Number(file.version || 1),
        revisionNotes: String(file.revisionNotes || ""),
        revisionRequestedAt: serializeDate(file.revisionRequestedAt),
        approvedAt: serializeDate(file.approvedAt),
      })),
      ...fileDocs.map((file) => ({
        fileId: String(file._id),
        name: String(file.originalName || ""),
        mimeType: String(file.mimeType || ""),
        size: Number(file.size || 0),
        uploadedByRole: String(file.uploadedByRole || ""),
        status: String(file.status || ""),
        version: Number(file.version || 1),
        revisionNotes: String(file.revisionNotes || ""),
        revisionRequestedAt: serializeDate(file.revisionRequestedAt),
        approvedAt: serializeDate(file.approvedAt),
      })),
    ].slice(0, 75),
    preEngagement: caseDoc.preEngagement && normalizeId(caseDoc.preEngagement.requestedParalegalId) === normalizeId(userId)
      ? {
          status: String(caseDoc.preEngagement.status || ""),
          confidentialityAgreementRequired: caseDoc.preEngagement.confidentialityAgreementRequired === true,
          conflictsCheckRequired: caseDoc.preEngagement.conflictsCheckRequired === true,
          confidentialityAcknowledged: caseDoc.preEngagement.confidentialityAcknowledged === true,
          conflictsResponseType: String(caseDoc.preEngagement.conflictsResponseType || ""),
          submittedAt: serializeDate(caseDoc.preEngagement.submittedAt),
          reviewedAt: serializeDate(caseDoc.preEngagement.reviewedAt),
        }
      : null,
    completion: {
      completedAt: serializeDate(caseDoc.completedAt),
      paymentReleased: caseDoc.paymentReleased === true,
      paidOutAt: serializeDate(caseDoc.paidOutAt),
    },
    withdrawal: {
      pausedReason: String(caseDoc.pausedReason || ""),
      disputeDeadlineAt: serializeDate(caseDoc.disputeDeadlineAt),
      payoutFinalizedAt: serializeDate(caseDoc.payoutFinalizedAt),
      payoutFinalizedType: String(caseDoc.payoutFinalizedType || ""),
    },
    visibleDisputeCount: (caseDoc.disputes || []).filter((item) => normalizeId(item.raisedBy) === normalizeId(userId)).length,
    moderationStatus: String(caseDoc.moderationStatus || "none"),
    archive: {
      archiveReadyAt: serializeDate(caseDoc.archiveReadyAt),
      purgeScheduledFor: serializeDate(caseDoc.purgeScheduledFor),
      purgedAt: serializeDate(caseDoc.purgedAt),
      storageChecked: false,
    },
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    evidence: evidence("P02_matter_details", facts, {
      subjectType: "matter",
      subjectId: facts.matterId,
      matterId: facts.matterId,
    }),
  };
}

async function getParalegalApplicationActivity(user = {}) {
  const userId = user._id || user.id;
  const [applications, relatedCases] = await Promise.all([
    Application.find({ paralegalId: userId })
      .select("_id jobId status createdAt")
      .sort({ createdAt: -1 })
      .lean(),
    Case.find(buildParalegalApplicationRelationshipFilter(userId))
      .select("_id jobId title status applicants invites pendingParalegalId pendingParalegalInvitedAt updatedAt")
      .sort({ updatedAt: -1 })
      .lean(),
  ]);
  const jobIds = applications.map((item) => item.jobId).filter(Boolean);
  const jobs = jobIds.length
    ? await Job.find({ _id: { $in: jobIds } }).select("_id caseId title status").lean()
    : [];
  const jobMap = new Map(jobs.map((job) => [String(job._id), job]));
  const items = applications.map((application) => {
    const job = jobMap.get(String(application.jobId || ""));
    return {
      applicationId: String(application._id),
      jobId: String(application.jobId || ""),
      caseId: String(job?.caseId || ""),
      title: String(job?.title || "Matter application"),
      status: String(application.status || ""),
      source: "application",
      createdAt: serializeDate(application.createdAt),
    };
  });
  for (const caseDoc of relatedCases) {
    const existing = items.some((item) =>
      String(item.caseId || "") === String(caseDoc._id) ||
      (caseDoc.jobId && String(item.jobId || "") === String(caseDoc.jobId))
    );
    if (existing) continue;
    const ownApplicant = (caseDoc.applicants || []).find((item) => normalizeId(item.paralegalId) === normalizeId(userId));
    const ownInvite = getOwnParalegalInviteRecords(caseDoc, userId)[0] || null;
    if (!ownApplicant && !ownInvite) continue;
    items.push({
      applicationId: "",
      jobId: String(caseDoc.jobId || ""),
      caseId: String(caseDoc._id),
      title: String(caseDoc.title || "Matter application"),
      status: String(ownApplicant?.status || ownInvite?.status || "pending"),
      source: ownInvite?.source === "legacy_pending" ? "legacy_pending_invitation" : ownInvite ? "invitation" : "case_applicant",
      createdAt: serializeDate(ownApplicant?.appliedAt || ownInvite?.invitedAt || caseDoc.updatedAt),
    });
  }
  const counts = items.reduce((result, item) => {
    const status = String(item.status || "unknown").toLowerCase();
    result[status] = Number(result[status] || 0) + 1;
    return result;
  }, {});
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    totalCount: items.length,
    counts,
    items: items.slice(0, 50),
    evidence: evidence("P06_applications", { totalCount: items.length, counts, items: items.slice(0, 50) }),
  };
}

async function getParalegalInvitationActivity(user = {}) {
  const userId = user._id || user.id;
  const docs = await Case.find({
    $or: [{ "invites.paralegalId": userId }, { pendingParalegalId: userId }],
  })
    .select("_id title status invites pendingParalegalId pendingParalegalInvitedAt preEngagement attorney attorneyId updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
  const items = docs.flatMap((caseDoc) => {
    const ownInvites = getOwnParalegalInviteRecords(caseDoc, userId);
    return ownInvites.map((invite) => ({
      caseId: String(caseDoc._id),
      title: String(caseDoc.title || ""),
      matterStatus: normalizeStatus(caseDoc.status),
      invitationStatus: String(invite.status || "pending"),
      source: String(invite.source || "invite"),
      invitedAt: serializeDate(invite.invitedAt),
      respondedAt: serializeDate(invite.respondedAt),
      preEngagement:
        caseDoc.preEngagement &&
        normalizeId(caseDoc.preEngagement.requestedParalegalId) === normalizeId(userId)
          ? {
              status: String(caseDoc.preEngagement.status || ""),
              confidentialityAgreementRequired: caseDoc.preEngagement.confidentialityAgreementRequired === true,
              conflictsCheckRequired: caseDoc.preEngagement.conflictsCheckRequired === true,
              confidentialityAcknowledged: caseDoc.preEngagement.confidentialityAcknowledged === true,
              conflictsResponseType: String(caseDoc.preEngagement.conflictsResponseType || ""),
              submittedAt: serializeDate(caseDoc.preEngagement.submittedAt),
              reviewedAt: serializeDate(caseDoc.preEngagement.reviewedAt),
            }
          : null,
    }));
  });
  const pendingCount = items.filter((item) => item.invitationStatus === "pending").length;
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    totalCount: items.length,
    pendingCount,
    items: items.slice(0, 50),
    evidence: evidence("P08_invitations", { totalCount: items.length, pendingCount, items: items.slice(0, 50) }),
  };
}

async function getParalegalPayoutSetup(user = {}) {
  const userDoc = await loadParalegalPayoutUser(user);
  if (!userDoc) return unavailable("P14_payout_setup", "unauthorized", "paralegal_account_not_accessible");
  const snapshot = await getStripeConnectSnapshot(userDoc);
  const facts = {
    source: String(snapshot.source || "stored"),
    ready: snapshot.connected === true,
    detailsSubmitted: snapshot.detailsSubmitted === true,
    chargesEnabled: snapshot.chargesEnabled === true,
    payoutsEnabled: snapshot.payoutsEnabled === true,
    bankName: String(snapshot.bankName || ""),
    bankLast4: String(snapshot.bankLast4 || ""),
    blockers: snapshot.blockers || [],
    nextSteps: snapshot.nextSteps || [],
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    evidence: evidence("P14_payout_setup", facts),
  };
}

async function getParalegalPayoutHistory(user = {}) {
  const userId = user._id || user.id;
  const payoutUser = await loadParalegalPayoutUser(user);
  if (!payoutUser) return unavailable("P16_payout_history", "unauthorized", "paralegal_account_not_accessible");
  const [payouts, current] = await Promise.all([
    Payout.find({ paralegalId: userId })
      .select("_id caseId amountPaid stripeMode createdAt")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
    getPayoutSnapshot(payoutUser, {}),
  ]);
  const caseIds = payouts.map((item) => item.caseId).filter(Boolean);
  const cases = caseIds.length
    ? await Case.find({
        $and: [
          { _id: { $in: caseIds } },
          buildParalegalParticipationFilter(userId),
        ],
      }).select("_id title currency").lean()
    : [];
  const caseMap = new Map(cases.map((item) => [String(item._id), item]));
  const items = payouts.map((payout) => {
    const caseDoc = caseMap.get(String(payout.caseId || ""));
    return {
      payoutId: String(payout._id),
      caseId: String(payout.caseId || ""),
      title: String(caseDoc?.title || "Matter payout"),
      amountCents: Number(payout.amountPaid || 0),
      amount: formatMoney(Number(payout.amountPaid || 0), caseDoc?.currency || "usd"),
      recordedAt: serializeDate(payout.createdAt),
      finalized: true,
    };
  });
  const totalPaidCents = items.reduce((sum, item) => sum + item.amountCents, 0);
  const facts = {
    payoutCount: items.length,
    totalPaidCents,
    totalPaid: formatMoney(totalPaidCents),
    latest: items[0] || null,
    currentRelease: {
      relevantCaseId: String(current.relevantCaseId || ""),
      relevantCaseTitle: String(current.relevantCaseTitle || ""),
      paymentReleased: current.paymentReleased === true,
      paidOutAt: serializeDate(current.paidOutAt),
      payoutFinalizedAt: serializeDate(current.payoutFinalizedAt),
      payoutFinalizedType: String(current.payoutFinalizedType || ""),
    },
    items,
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    evidence: evidence("P16_payout_history", facts),
  };
}

async function getParalegalCaseFinancials(user = {}, caseReference = "") {
  const resolved = await resolveParalegalCase(user, caseReference);
  if (!resolved.caseDoc) return resolved;
  const caseDoc = resolved.caseDoc;
  const userId = user._id || user.id;
  const payout = await Payout.findOne({ caseId: caseDoc._id, paralegalId: userId })
    .select("amountPaid createdAt")
    .lean();
  const withdrawn = normalizeId(caseDoc.withdrawnParalegalId) === normalizeId(userId);
  const grossCents = withdrawn && Number.isFinite(Number(caseDoc.partialPayoutAmount))
    ? Number(caseDoc.partialPayoutAmount)
    : Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0);
  const percent = Number(caseDoc.feeParalegalPct);
  const snapshotFee = Number(caseDoc.feeParalegalAmount);
  const platformFeeCents = withdrawn && Number.isFinite(percent)
    ? Math.round(grossCents * percent / 100)
    : Number.isFinite(snapshotFee)
      ? snapshotFee
      : Number.isFinite(percent)
        ? Math.round(grossCents * percent / 100)
        : null;
  const calculatedNet = platformFeeCents == null ? null : Math.max(0, grossCents - platformFeeCents);
  const finalizedNetCents = payout ? Number(payout.amountPaid || 0) : null;
  const netCents = finalizedNetCents ?? calculatedNet;
  const currency = String(caseDoc.currency || "usd");
  const facts = {
    matterId: String(caseDoc._id),
    title: String(caseDoc.title || ""),
    gross: { cents: grossCents, formatted: formatMoney(grossCents, currency) },
    platformFee: {
      cents: platformFeeCents,
      formatted: platformFeeCents == null ? "" : formatMoney(platformFeeCents, currency),
      percent: Number.isFinite(percent) ? percent : null,
    },
    net: {
      cents: netCents,
      formatted: netCents == null ? "" : formatMoney(netCents, currency),
    },
    finalized: Boolean(payout),
    finalizedAt: serializeDate(payout?.createdAt || caseDoc.payoutFinalizedAt),
    paymentReleased: caseDoc.paymentReleased === true,
    paidOutAt: serializeDate(caseDoc.paidOutAt),
    calculationSource: payout ? "payout_record" : withdrawn ? "withdrawal_snapshot" : "case_fee_snapshot",
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    evidence: evidence("P17_matter_financials", facts, {
      subjectType: "matter",
      subjectId: facts.matterId,
      matterId: facts.matterId,
    }),
  };
}

async function getParalegalAccountSnapshot(user = {}) {
  const userDoc = await User.findOne({ _id: user._id || user.id, role: "paralegal" })
    .select(
      "_id role status firstName lastName bio about availability availabilityDetails location preferredPracticeAreas specialties jurisdictions stateExperience skills yearsExperience languages collaborationStyle resumeURL certificateURL writingSampleURL writingSamples profilePhotoStatus preferences notifications notificationPrefs onboarding termsAccepted emailVerified twoFactorEnabled twoFactorMethod"
    )
    .lean();
  if (!userDoc) return unavailable("P23_profile", "unauthorized", "paralegal_account_not_accessible");
  const profileFields = [
    userDoc.bio || userDoc.about,
    userDoc.location,
    userDoc.availability,
    (userDoc.specialties || []).length,
    (userDoc.skills || []).length,
    userDoc.yearsExperience,
  ];
  const facts = {
    approved: String(userDoc.status || "").toLowerCase() === "approved",
    profile: {
      displayName: [userDoc.firstName, userDoc.lastName].filter(Boolean).join(" ").trim(),
      completionSignalCount: profileFields.filter(Boolean).length,
      availability: String(userDoc.availability || ""),
      availabilityStatus: String(userDoc.availabilityDetails?.status || ""),
      nextAvailable: serializeDate(userDoc.availabilityDetails?.nextAvailable),
      hidden: userDoc.preferences?.hideProfile === true,
      photoStatus: String(userDoc.profilePhotoStatus || ""),
      resumePresent: Boolean(userDoc.resumeURL),
      certificatePresent: Boolean(userDoc.certificateURL),
      writingSamplePresent: Boolean(userDoc.writingSampleURL || (userDoc.writingSamples || []).length),
    },
    preferences: {
      theme: String(userDoc.preferences?.theme || ""),
      fontSize: String(userDoc.preferences?.fontSize || ""),
      notifications: userDoc.notificationPrefs || userDoc.notifications || {},
    },
    onboarding: {
      welcomeDismissed: userDoc.onboarding?.paralegalWelcomeDismissed === true,
      tourCompleted: userDoc.onboarding?.paralegalTourCompleted === true,
      profileTourCompleted: userDoc.onboarding?.paralegalProfileTourCompleted === true,
      termsAccepted: userDoc.termsAccepted === true,
      emailVerified: userDoc.emailVerified === true,
    },
    security: {
      twoFactorFeatureAvailable: ["1", "true", "on", "enabled"].includes(
        String(process.env.ENABLE_TWO_FACTOR || "").toLowerCase()
      ),
      twoFactorEnabled: userDoc.twoFactorEnabled === true,
      twoFactorMethod: userDoc.twoFactorEnabled ? String(userDoc.twoFactorMethod || "") : "",
    },
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    evidence: evidence("P23_profile", facts),
  };
}

async function getParalegalDeactivationEligibility(user = {}) {
  const eligibility = await getAccountDeactivationEligibility({
    _id: user._id || user.id,
    role: "paralegal",
    disabled: user.disabled === true,
    deleted: user.deleted === true,
  });
  const facts = {
    canDeactivate: eligibility.canDeactivate === true,
    blockers: (eligibility.blockers || []).map((item) => ({
      code: String(item.code || ""),
      message: String(item.message || ""),
      count: Number(item.count || 0),
    })),
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    evidence: evidence("P28_deactivation", facts),
  };
}

async function getParalegalWorkflowReadiness(user = {}, caseReference = "") {
  const resolved = await resolveParalegalCase(user, caseReference);
  if (!resolved.caseDoc) return resolved;
  const caseDoc = resolved.caseDoc;
  const userId = user._id || user.id;
  const payoutUser = await loadParalegalPayoutUser(user);
  if (!payoutUser) return unavailable("P21_completion_release", "unauthorized", "paralegal_account_not_accessible");
  const stripeState = await getStripeConnectSnapshot(payoutUser);
  const ownInvite = (caseDoc.invites || []).find((item) => normalizeId(item.paralegalId) === normalizeId(userId));
  const ownApplicant = (caseDoc.applicants || []).find((item) => normalizeId(item.paralegalId) === normalizeId(userId));
  const evaluations = {
    application: evaluateApplicationEligibility({
      user,
      caseDoc,
      alreadyApplied: Boolean(ownApplicant),
    }),
    invitation: evaluateInvitationEligibility({
      user,
      caseDoc,
      inviteStatus: ownInvite?.status || "",
      stripeState,
    }),
    preEngagement: evaluatePreEngagementSubmission({ user, caseDoc }),
    workspace: evaluateWorkspaceAccess({ user, caseDoc }),
    completion: evaluateCompletionState({ user, caseDoc }),
    payout: evaluatePayoutReadiness({ user, caseDoc, stripeState }),
    withdrawal: evaluateWithdrawalEligibility({ user, caseDoc }),
    archive: evaluateArchiveAccess({ user, caseDoc, storageChecked: false }),
  };
  const facts = {
    matterId: String(caseDoc._id),
    title: String(caseDoc.title || ""),
    matterStatus: normalizeStatus(caseDoc.status),
    stripe: {
      ready: stripeState.connected === true,
      detailsSubmitted: stripeState.detailsSubmitted === true,
      payoutsEnabled: stripeState.payoutsEnabled === true,
      blockers: stripeState.blockers || [],
    },
    evaluations,
    bankDepositEstimateBusinessDays: evaluations.payout.facts.bankDepositEstimateBusinessDays,
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    evidence: evidence("P21_completion_release", facts, {
      subjectType: "matter",
      subjectId: facts.matterId,
      matterId: facts.matterId,
      policyOrLiveState: "policy_and_live_state",
    }),
  };
}

async function getParalegalMessagingState(user = {}, caseReference = "") {
  const resolved = await resolveParalegalCase(user, caseReference, { includeWithdrawn: false });
  if (!resolved.caseDoc) return resolved;
  const caseDoc = resolved.caseDoc;
  const userId = user._id || user.id;
  const permission = evaluateMessagingPermission({ user, caseDoc });
  const [totalMessages, unreadMessages, latest] = await Promise.all([
    Message.countDocuments({ caseId: caseDoc._id, deleted: { $ne: true } }),
    Message.countDocuments({
      caseId: caseDoc._id,
      deleted: { $ne: true },
      senderId: { $ne: userId },
      readBy: { $ne: userId },
    }),
    Message.findOne({ caseId: caseDoc._id, deleted: { $ne: true } })
      .select("_id senderId senderRole createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .lean(),
  ]);
  const facts = {
    matterId: String(caseDoc._id),
    title: String(caseDoc.title || ""),
    canSend: permission.allowed,
    blockers: permission.blockers,
    totalMessages,
    unreadCount: unreadMessages,
    lastMessageAt: serializeDate(latest?.createdAt),
    lastSenderRole: String(latest?.senderRole || ""),
    awaitingMyReply: Boolean(latest && normalizeId(latest.senderId) !== normalizeId(userId)),
    awaitingAttorneyReply: Boolean(latest && normalizeId(latest.senderId) === normalizeId(userId)),
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    evidence: evidence("P13_message_activity", facts, {
      subjectType: "matter",
      subjectId: facts.matterId,
      matterId: facts.matterId,
    }),
  };
}

async function getParalegalAttentionSummary(user = {}) {
  const [overview, applications, invitations, payoutSetup] = await Promise.all([
    getParalegalCaseOverview(user, "all"),
    getParalegalApplicationActivity(user),
    getParalegalInvitationActivity(user),
    getParalegalPayoutSetup(user),
  ]);
  const upcoming = (overview.items || [])
    .filter((item) => item.deadline && new Date(item.deadline).getTime() > Date.now())
    .sort((left, right) => new Date(left.deadline) - new Date(right.deadline))[0] || null;
  const facts = {
    activeMatterCount: Number(overview.activeCount || 0),
    pendingApplicationCount: Number(applications.counts?.submitted || 0) +
      Number(applications.counts?.viewed || 0) +
      Number(applications.counts?.shortlisted || 0),
    pendingInvitationCount: Number(invitations.pendingCount || 0),
    payoutSetupReady: payoutSetup.ready === true,
    nextDeadline: upcoming,
  };
  return {
    ok: true,
    available: true,
    authorized: true,
    evidenceState: "verified",
    ...facts,
    evidence: evidence("P01_assigned_overview", facts),
  };
}

function getParalegalNavigationDestination(destination = "") {
  const match = PARALEGAL_NAVIGATION[String(destination || "")];
  return match
    ? { available: true, ...match }
    : { available: false, reason: "destination_not_available_for_paralegal" };
}

function getParalegalSupportToolDefinitions() {
  return PARALEGAL_TOOL_NAMES.map((name) => PARALEGAL_TOOL_DEFINITIONS[name]);
}

function validateParalegalToolArguments(name, args) {
  const definition = PARALEGAL_TOOL_DEFINITIONS[name];
  if (!definition) return { valid: false, error: "unknown_tool" };
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { valid: false, error: "invalid_tool_arguments" };
  }
  const schema = definition.parameters || EMPTY_PARAMETERS;
  const properties = schema.properties || {};
  const allowed = new Set(Object.keys(properties));
  const unsupported = Object.keys(args).filter((key) => !allowed.has(key));
  if (unsupported.length) return { valid: false, error: "unsupported_tool_argument", fields: unsupported };
  const missing = (schema.required || []).filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length) return { valid: false, error: "missing_tool_argument", fields: missing };
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key] || {};
    if (property.type === "string" && typeof value !== "string") {
      return { valid: false, error: "invalid_tool_argument_type", fields: [key] };
    }
    if (property.enum && !property.enum.includes(value)) {
      return { valid: false, error: "invalid_tool_argument_value", fields: [key] };
    }
  }
  return { valid: true };
}

async function executeParalegalSupportTool({ name = "", args = {}, context = {} } = {}) {
  const user = context.user || {};
  if (String(user.role || "").toLowerCase() !== "paralegal" || !(user._id || user.id)) {
    return unavailable("", "unauthorized", "paralegal_role_required");
  }
  if (!PARALEGAL_TOOL_NAMES.includes(name)) return unavailable("", "unknown", "tool_not_available");
  const validation = validateParalegalToolArguments(name, args);
  if (!validation.valid) return { ok: false, available: false, evidenceState: "unknown", ...validation };

  try {
    switch (name) {
      case "search_lpc_knowledge": {
        const results = await retrieveSupportKnowledge({ query: String(args.query || ""), role: "paralegal", limit: 3 });
        const safeResults = results.map((item) => ({
          title: String(item.title || ""),
          answer: String(item.answer || item.content || ""),
          href: String(item.href || ""),
        }));
        return {
          ok: true,
          available: true,
          authorized: true,
          evidenceState: safeResults.length ? "verified" : "absent",
          results: safeResults,
          evidence: evidence("P31_product_knowledge", { results: safeResults }, { policyOrLiveState: "policy" }),
        };
      }
      case "get_paralegal_case_overview":
        return getParalegalCaseOverview(user, args.status_scope);
      case "get_paralegal_case_workspace":
        return getParalegalCaseWorkspace(user, args.case_reference);
      case "get_paralegal_application_activity":
        return getParalegalApplicationActivity(user);
      case "get_paralegal_invitation_activity":
        return getParalegalInvitationActivity(user);
      case "get_paralegal_attention_summary":
        return getParalegalAttentionSummary(user);
      case "get_paralegal_payout_setup":
        return getParalegalPayoutSetup(user);
      case "get_paralegal_payout_history":
        return getParalegalPayoutHistory(user);
      case "get_paralegal_case_financials":
        return getParalegalCaseFinancials(user, args.case_reference);
      case "get_paralegal_account_snapshot":
        return getParalegalAccountSnapshot(user);
      case "get_paralegal_deactivation_eligibility":
        return getParalegalDeactivationEligibility(user);
      case "get_paralegal_workflow_readiness":
        return getParalegalWorkflowReadiness(user, args.case_reference);
      case "get_paralegal_messaging_state":
        return getParalegalMessagingState(user, args.case_reference);
      case "find_paralegal_navigation_destination":
        return {
          ok: true,
          authorized: true,
          evidenceState: "verified",
          ...getParalegalNavigationDestination(args.destination),
          evidence: evidence("P30_navigation", getParalegalNavigationDestination(args.destination)),
        };
      default:
        return unavailable("", "unknown", "tool_not_available");
    }
  } catch (_error) {
    return unavailable("", "temporarily_unavailable", "tool_lookup_failed");
  }
}

module.exports = {
  PARALEGAL_TOOL_DEFINITIONS,
  PARALEGAL_TOOL_NAMES,
  buildParalegalApplicationRelationshipFilter,
  buildParalegalParticipationFilter,
  executeParalegalSupportTool,
  getParalegalAccountSnapshot,
  getParalegalApplicationActivity,
  getParalegalAttentionSummary,
  getParalegalCaseFinancials,
  getParalegalCaseOverview,
  getParalegalCaseWorkspace,
  getParalegalDeactivationEligibility,
  getParalegalInvitationActivity,
  getOwnParalegalInviteRecords,
  getWithdrawnAccessCutoff,
  isRecordVisibleAtCutoff,
  loadParalegalPayoutUser,
  getParalegalMessagingState,
  getParalegalNavigationDestination,
  getParalegalPayoutHistory,
  getParalegalPayoutSetup,
  getParalegalSupportToolDefinitions,
  getParalegalWorkflowReadiness,
  resolveParalegalCase,
  validateParalegalToolArguments,
};
