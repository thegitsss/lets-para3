const mongoose = require("mongoose");

const Application = require("../models/Application");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const Job = require("../models/Job");
const Message = require("../models/Message");
const Payout = require("../models/Payout");
const User = require("../models/User");
const { decryptCaseFilePayload } = require("../utils/dataEncryption");
const { normalizeCaseStatus } = require("../utils/caseState");
const { isBlockedBetween } = require("../utils/blocks");
const { retrieveSupportKnowledge } = require("../services/knowledge/retrievalService");
const {
  EVIDENCE_STATES,
  evaluateArchiveReadiness,
  evaluateCompletionEligibility,
  evaluateHiringEligibility,
  evaluateInvitationEligibility,
  evaluateMessagingPermission,
  evaluatePreEngagementRequest,
  evaluateTerminationEligibility,
  evaluateWithdrawalAndRelist,
  evaluateWorkspaceAccess,
  getAttorneyWorkflowPolicy,
  ownsCase,
} = require("../services/attorneyWorkflowPolicy");
const { getAccountDeactivationEligibility } = require("../services/userDeletion");
const {
  ATTORNEY_EVIDENCE_CAPABILITIES,
  normalizeAttorneyToolEvidence,
} = require("./attorneyEvidenceContract");
const {
  getAttorneyPendingParalegalSnapshot,
  getBillingMethodSnapshot,
  getCaseSnapshot,
  getMessagingSnapshot,
  getNextCaseDeadlineSnapshot,
  getPayoutSnapshot,
  getStripeConnectSnapshot,
  getWorkspaceAccessSnapshot,
  resolveSupportCaseEntity,
} = require("../services/support/contextResolverService");

const COMPLETED_CASE_STATUSES = new Set(["completed", "closed"]);
const MAX_CASE_SUMMARIES = 8;

const EMPTY_PARAMETERS = Object.freeze({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});

const TOOL_DEFINITIONS = Object.freeze({
  search_lpc_knowledge: {
    type: "function",
    name: "search_lpc_knowledge",
    description:
      "Search approved, support-safe LPC product knowledge for non-executable product explanations. This source does not establish workflow prerequisites, ordered stages, lifecycle transitions, action effects, or payment timing.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A focused plain-language LPC question." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_my_case_overview: {
    type: "function",
    name: "get_my_case_overview",
    description:
      "Get exact, live counts and recent summaries of cases visible to the signed-in user. Use for totals, completed cases, open cases, workload, and status questions.",
    parameters: {
      type: "object",
      properties: {
        status_scope: {
          type: "string",
          enum: ["all", "active", "completed"],
          description: "Which cases to include in the recent-case list. Counts for every status are always returned.",
        },
      },
      required: ["status_scope"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_case_details: {
    type: "function",
    name: "get_case_details",
    description:
      "Resolve a case the user can access and return its live status, deadline, task counts, applicant count, and workspace state. Never use for a different user's case.",
    parameters: {
      type: "object",
      properties: {
        case_reference: {
          type: "string",
          description: "Case ID, case title, or the user's natural-language reference such as 'the Smith matter'.",
        },
      },
      required: ["case_reference"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_attorney_case_financials: {
    type: "function",
    name: "get_attorney_case_financials",
    description:
      "Get the exact financial breakdown for one of the signed-in attorney's matters: matter amount, attorney platform fee, total attorney charge, paralegal platform fee, and actual or calculated net paralegal payout. Use for direct amount questions and follow-ups such as 'how much was that for?', 'both', 'what was I charged?', or 'what did the paralegal receive?'. Resolve pronouns from conversation history and pass the previously discussed case title or ID.",
    parameters: {
      type: "object",
      properties: {
        case_reference: {
          type: "string",
          description: "Case ID or case title. For a follow-up, reuse the case identified in the earlier conversation turn.",
        },
      },
      required: ["case_reference"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_attorney_case_workspace: {
    type: "function",
    name: "get_attorney_case_workspace",
    description:
      "Get a complete read-only snapshot of one of the signed-in attorney's matter workspaces, including status, deadline, assigned paralegal, tasks, applications, invitations, pre-engagement, disputes, termination/withdrawal, archive/download readiness, and file/deliverable review state. Use for matter-specific task, file, deliverable, participant, applicant, invitation, dispute, archive, and workflow questions, including conversational follow-ups.",
    parameters: {
      type: "object",
      properties: {
        case_reference: {
          type: "string",
          description: "Case ID or title. For a follow-up, reuse the case identified in conversation history.",
        },
      },
      required: ["case_reference"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_attorney_receipt_history: {
    type: "function",
    name: "get_attorney_receipt_history",
    description:
      "Get the signed-in attorney's complete matter receipt index with exact total charges and authorized receipt links. Use for receipt and payment-history questions that are not limited to one named matter.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_attorney_account_snapshot: {
    type: "function",
    name: "get_attorney_account_snapshot",
    description:
      "Get the signed-in attorney's safe account and profile state, including firm, practice areas, profile completeness signals, preferences, notification settings, and security markers. Never return secrets or full payment details.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_next_deadline: {
    type: "function",
    name: "get_next_deadline",
    description: "Get the signed-in attorney or paralegal's next live upcoming case deadline.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_pending_paralegal_activity: {
    type: "function",
    name: "get_pending_paralegal_activity",
    description:
      "For an attorney, check every active case for activity explicitly attributable to a paralegal, including invitations, pre-engagement responses, and message replies. Unassigned embedded scope tasks are intentionally excluded.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_attorney_application_activity: {
    type: "function",
    name: "get_attorney_application_activity",
    description:
      "For an attorney, return exact pending application counts and recent applicant names for the attorney's cases. Use for who applied, new applicants, and applications awaiting review.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_attorney_message_activity: {
    type: "function",
    name: "get_attorney_message_activity",
    description:
      "For an attorney, check all active case conversations for unread paralegal messages, threads awaiting the attorney's reply, and threads awaiting a paralegal reply.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_attorney_attention_summary: {
    type: "function",
    name: "get_attorney_attention_summary",
    description:
      "For an attorney, produce a live account-wide summary of what needs attention now: active and completed matters, applications, message replies, pending paralegal work, and the next deadline.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_billing_snapshot: {
    type: "function",
    name: "get_billing_snapshot",
    description: "Get the signed-in attorney's saved billing-method state without exposing full card or bank details.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_attorney_workflow_readiness: {
    type: "function",
    name: "get_attorney_workflow_readiness",
    description:
      "Get one complete authoritative role-wide LPC workflow-policy envelope for prerequisites, ordered stages, lifecycle transitions, action effects, charge or release triggers, and timing, joined with the signed-in attorney's current payment-method state. Select the single most specific semantic capability being answered; the returned envelope contains the related workflow facts, so do not call this tool again under a broader or adjacent capability. This policy source does not prove that a transition occurred on a specific matter.",
    parameters: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          enum: Object.values(ATTORNEY_EVIDENCE_CAPABILITIES),
          description: "The single most specific semantic workflow capability being answered. Choose by meaning, not exact wording. Deposit timing includes its release prerequisite; payout release excludes external bank-arrival timing.",
        },
      },
      required: ["capability"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_attorney_matter_readiness: {
    type: "function",
    name: "get_attorney_matter_readiness",
    description:
      "Evaluate authoritative read-only workflow readiness for one owned attorney matter. Use for invitation, pre-engagement, hiring/funding, workspace, messaging, completion, withdrawal, relisting, archive, and next-step questions. This tool never performs the workflow action.",
    parameters: {
      type: "object",
      properties: {
        case_reference: {
          type: "string",
          description: "An owned case ID or title. Reuse the verified conversation matter for a follow-up.",
        },
      },
      required: ["case_reference"],
      additionalProperties: false,
    },
    strict: true,
  },
  get_attorney_billing_summary: {
    type: "function",
    name: "get_attorney_billing_summary",
    description:
      "Get complete authorized billing aggregates for the signed-in attorney, including active funded value, pending funding value, completed matter spend, and history/export counts. Use for account-wide billing totals, not a single matter amount.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_attorney_deactivation_eligibility: {
    type: "function",
    name: "get_attorney_deactivation_eligibility",
    description:
      "Check whether the signed-in attorney may deactivate the account and return safe blocking categories. This is read-only and never deactivates the account.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_payout_snapshot: {
    type: "function",
    name: "get_payout_snapshot",
    description: "Get the signed-in paralegal's latest payout and payout-readiness state.",
    parameters: EMPTY_PARAMETERS,
    strict: true,
  },
  get_messaging_state: {
    type: "function",
    name: "get_messaging_state",
    description:
      "Check whether messaging is available in a case, whether the user can send, and the latest message activity. Use for message access and response-state questions.",
    parameters: {
      type: "object",
      properties: {
        case_reference: {
          type: "string",
          description: "Case ID, title, or natural-language case reference. Use an empty string only when current page context identifies the case.",
        },
      },
      required: ["case_reference"],
      additionalProperties: false,
    },
    strict: true,
  },
  find_navigation_destination: {
    type: "function",
    name: "find_navigation_destination",
    description:
      "Return an authorized LPC page and label for the signed-in role. Use whenever the answer should help the user open a page.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          enum: [
            "cases",
            "completed_cases",
            "create_case",
            "billing",
            "applications",
            "browse_cases",
            "payouts",
            "messages",
            "profile",
            "support",
            "contact",
            "knowledge",
            "users",
            "finance",
            "engineering",
            "admin_overview",
          ],
        },
      },
      required: ["destination"],
      additionalProperties: false,
    },
    strict: true,
  },
});

const ROLE_TOOL_NAMES = Object.freeze({
  attorney: [
    "search_lpc_knowledge",
    "get_my_case_overview",
    "get_case_details",
    "get_attorney_case_financials",
    "get_attorney_case_workspace",
    "get_attorney_receipt_history",
    "get_attorney_account_snapshot",
    "get_next_deadline",
    "get_pending_paralegal_activity",
    "get_attorney_application_activity",
    "get_attorney_message_activity",
    "get_attorney_attention_summary",
    "get_billing_snapshot",
    "get_attorney_workflow_readiness",
    "get_attorney_matter_readiness",
    "get_attorney_billing_summary",
    "get_attorney_deactivation_eligibility",
    "get_messaging_state",
    "find_navigation_destination",
  ],
  paralegal: [
    "search_lpc_knowledge",
    "get_my_case_overview",
    "get_case_details",
    "get_next_deadline",
    "get_payout_snapshot",
    "get_messaging_state",
    "find_navigation_destination",
  ],
  admin: [
    "search_lpc_knowledge",
    "get_my_case_overview",
    "get_case_details",
    "get_messaging_state",
    "find_navigation_destination",
  ],
});

const NAVIGATION_BY_ROLE = Object.freeze({
  attorney: {
    cases: { ctaLabel: "My cases", ctaHref: "dashboard-attorney.html#cases" },
    completed_cases: { ctaLabel: "My cases", ctaHref: "dashboard-attorney.html#cases" },
    create_case: { ctaLabel: "Post a case", ctaHref: "create-case.html" },
    billing: { ctaLabel: "Billing & payments", ctaHref: "dashboard-attorney.html#billing" },
    messages: { ctaLabel: "My cases", ctaHref: "dashboard-attorney.html#cases" },
    profile: { ctaLabel: "Profile settings", ctaHref: "profile-settings.html" },
    support: { ctaLabel: "Help center", ctaHref: "help.html" },
    contact: { ctaLabel: "Contact Us", ctaHref: "contact.html" },
  },
  paralegal: {
    cases: { ctaLabel: "My cases", ctaHref: "dashboard-paralegal.html#cases" },
    completed_cases: { ctaLabel: "Completed cases", ctaHref: "dashboard-paralegal.html#cases-completed" },
    applications: { ctaLabel: "My applications", ctaHref: "dashboard-paralegal.html#cases" },
    browse_cases: { ctaLabel: "Browse cases", ctaHref: "browse-jobs.html" },
    payouts: { ctaLabel: "Payout settings", ctaHref: "profile-settings.html" },
    messages: { ctaLabel: "My cases", ctaHref: "dashboard-paralegal.html#cases" },
    profile: { ctaLabel: "Profile settings", ctaHref: "profile-settings.html" },
    support: { ctaLabel: "Help center", ctaHref: "help.html" },
    contact: { ctaLabel: "Contact Us", ctaHref: "contact.html" },
  },
  admin: {
    cases: { ctaLabel: "Case operations", ctaHref: "admin-dashboard.html#overview" },
    support: { ctaLabel: "Support Ops", ctaHref: "admin-dashboard.html#support-ops" },
    knowledge: { ctaLabel: "Knowledge Studio", ctaHref: "admin-dashboard.html#knowledge-studio" },
    users: { ctaLabel: "User management", ctaHref: "admin-dashboard.html#user-management" },
    finance: { ctaLabel: "Finance", ctaHref: "admin-dashboard.html#finance" },
    engineering: { ctaLabel: "Engineering", ctaHref: "admin-dashboard.html#engineering" },
    admin_overview: { ctaLabel: "Admin overview", ctaHref: "admin-dashboard.html#overview" },
    profile: { ctaLabel: "Profile settings", ctaHref: "profile-settings.html" },
    contact: { ctaLabel: "Contact Us", ctaHref: "contact.html" },
  },
});

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function normalizeRole(user = {}) {
  return String(user.role || "").trim().toLowerCase();
}

function serializeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function formatMoney(amountCents, currency = "usd") {
  const amount = cents(amountCents) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "usd").toUpperCase(),
    }).format(amount);
  } catch (_error) {
    return `$${amount.toFixed(2)}`;
  }
}

function buildCaseAccessQuery(user = {}) {
  const role = normalizeRole(user);
  const userId = user._id || user.id;
  if (role === "admin") return {};
  if (!userId) return { _id: null };
  if (role === "attorney") {
    return { $or: [{ attorney: userId }, { attorneyId: userId }] };
  }
  if (role === "paralegal") {
    return {
      $or: [
        { paralegal: userId },
        { paralegalId: userId },
        { withdrawnParalegalId: userId },
      ],
    };
  }
  return { _id: null };
}

function caseMatchesScope(caseDoc = {}, scope = "all") {
  const completed = COMPLETED_CASE_STATUSES.has(normalizeCaseStatus(caseDoc.status));
  if (scope === "completed") return completed;
  if (scope === "active") return !completed;
  return true;
}

function buildSafeCaseSummary(caseDoc = {}) {
  const incompleteTasks = Array.isArray(caseDoc.tasks)
    ? caseDoc.tasks.filter((task) => task?.completed !== true).length
    : 0;
  const pendingApplications = Array.isArray(caseDoc.applicants)
    ? caseDoc.applicants.filter((applicant) => String(applicant?.status || "pending") === "pending").length
    : 0;
  return {
    caseId: normalizeId(caseDoc._id),
    title: String(caseDoc.title || "Untitled matter"),
    status: normalizeCaseStatus(caseDoc.status),
    deadline: serializeDate(caseDoc.deadline),
    incompleteTaskCount: incompleteTasks,
    pendingApplicationCount: pendingApplications,
    updatedAt: serializeDate(caseDoc.updatedAt),
  };
}

async function getMyCaseOverview(user = {}, statusScope = "all") {
  const role = normalizeRole(user);
  if (!ROLE_TOOL_NAMES[role]) {
    return { available: false, reason: "unsupported_role" };
  }
  const cases = await Case.find(buildCaseAccessQuery(user))
    .select("_id title status deadline tasks applicants updatedAt")
    .sort({ updatedAt: -1, _id: -1 })
    .lean();
  const byStatus = {};
  for (const caseDoc of cases) {
    const status = normalizeCaseStatus(caseDoc.status) || "unknown";
    byStatus[status] = Number(byStatus[status] || 0) + 1;
  }
  const completedCount = cases.filter((caseDoc) => COMPLETED_CASE_STATUSES.has(normalizeCaseStatus(caseDoc.status))).length;
  const scopedCases = cases.filter((caseDoc) => caseMatchesScope(caseDoc, statusScope));
  return {
    available: true,
    role,
    totalCount: cases.length,
    activeCount: cases.length - completedCount,
    completedCount,
    byStatus,
    requestedScope: statusScope,
    recentCases: scopedCases
      .slice(0, MAX_CASE_SUMMARIES)
      .map(buildSafeCaseSummary),
    matchingCaseCount: scopedCases.length,
    returnedCaseCount: Math.min(scopedCases.length, MAX_CASE_SUMMARIES),
    truncated: scopedCases.length > MAX_CASE_SUMMARIES,
  };
}

function formatPersonName(user = {}) {
  return [String(user.firstName || "").trim(), String(user.lastName || "").trim()]
    .filter(Boolean)
    .join(" ");
}

async function getAttorneyApplicationActivity(user = {}) {
  const role = normalizeRole(user);
  const userId = user._id || user.id;
  if (role !== "attorney" || !userId) {
    return { available: false, reason: "attorney_access_required", pendingApplicationCount: 0, cases: [] };
  }
  const [cases, jobs] = await Promise.all([
    Case.find({
      ...buildCaseAccessQuery(user),
      archived: { $ne: true },
    })
      .select("_id jobId title status applicants updatedAt")
      .sort({ updatedAt: -1, _id: -1 })
      .lean(),
    Job.find({ attorneyId: userId })
      .select("_id caseId title status updatedAt")
      .lean(),
  ]);
  const caseById = new Map(cases.map((caseDoc) => [normalizeId(caseDoc._id), caseDoc]));
  const jobById = new Map(jobs.map((job) => [normalizeId(job._id), job]));
  const embeddedPending = cases.flatMap((caseDoc) =>
    (Array.isArray(caseDoc.applicants) ? caseDoc.applicants : [])
      .filter((applicant) => String(applicant?.status || "pending").toLowerCase() === "pending")
      .map((applicant) => ({
        caseId: normalizeId(caseDoc._id),
        jobId: normalizeId(caseDoc.jobId),
        caseTitle: String(caseDoc.title || "Untitled matter"),
        caseStatus: normalizeCaseStatus(caseDoc.status),
        paralegalId: normalizeId(applicant.paralegalId),
        appliedAt: applicant.appliedAt || null,
        source: "case_applicant",
      }))
  );
  const jobIds = jobs.map((job) => job._id).filter(Boolean);
  const applicationDocs = jobIds.length
    ? await Application.find({
        jobId: { $in: jobIds },
        status: { $in: ["submitted", "viewed", "shortlisted"] },
      })
        .select("_id jobId paralegalId status createdAt")
        .lean()
    : [];
  const collectionPending = applicationDocs.map((application) => {
    const job = jobById.get(normalizeId(application.jobId)) || {};
    const caseDoc = caseById.get(normalizeId(job.caseId)) || {};
    return {
      caseId: normalizeId(job.caseId),
      jobId: normalizeId(application.jobId),
      caseTitle: String(caseDoc.title || job.title || "Untitled matter"),
      caseStatus: normalizeCaseStatus(caseDoc.status || job.status),
      paralegalId: normalizeId(application.paralegalId),
      appliedAt: application.createdAt || null,
      source: "application",
    };
  });
  const deduped = new Map();
  for (const entry of [...embeddedPending, ...collectionPending]) {
    const subjectId = entry.caseId || `job:${entry.jobId}`;
    const key = `${subjectId}:${entry.paralegalId}`;
    const current = deduped.get(key);
    if (!current || entry.source === "application") deduped.set(key, entry);
  }
  const pending = [...deduped.values()];
  const applicantIds = [...new Set(pending.map((entry) => entry.paralegalId).filter(Boolean))]
    .filter((value) => mongoose.isValidObjectId(value));
  const applicants = applicantIds.length
    ? await User.find({ _id: { $in: applicantIds } }).select("_id firstName lastName").lean()
    : [];
  const applicantNames = new Map(applicants.map((entry) => [normalizeId(entry._id), formatPersonName(entry)]));
  const recentApplications = pending
    .sort((left, right) => (new Date(right.appliedAt || 0).getTime() - new Date(left.appliedAt || 0).getTime()))
    .slice(0, 10)
    .map((entry) => ({
      caseId: entry.caseId,
      caseTitle: entry.caseTitle,
      caseStatus: entry.caseStatus,
      applicantName: applicantNames.get(entry.paralegalId) || "Paralegal applicant",
      appliedAt: serializeDate(entry.appliedAt),
    }));
  const byCase = new Map();
  for (const entry of pending) {
    const current = byCase.get(entry.caseId) || {
      caseId: entry.caseId,
      title: entry.caseTitle,
      status: entry.caseStatus,
      pendingApplicationCount: 0,
    };
    current.pendingApplicationCount += 1;
    byCase.set(entry.caseId, current);
  }
  return {
    available: true,
    pendingApplicationCount: pending.length,
    caseCountWithPendingApplications: new Set(pending.map((entry) => entry.caseId)).size,
    cases: [...byCase.values()].slice(0, MAX_CASE_SUMMARIES),
    matchingCaseCount: byCase.size,
    returnedCaseCount: Math.min(byCase.size, MAX_CASE_SUMMARIES),
    truncated: byCase.size > MAX_CASE_SUMMARIES,
    recentApplications,
    recentMatchingCount: pending.length,
    recentReturnedCount: recentApplications.length,
    recentTruncated: recentApplications.length < pending.length,
    sourceCounts: {
      embedded: embeddedPending.length,
      applicationCollection: collectionPending.length,
      deduplicated: pending.length,
    },
    aggregationComplete: true,
  };
}

async function getAttorneyMessageActivity(user = {}) {
  const role = normalizeRole(user);
  const userId = user._id || user.id;
  if (role !== "attorney" || !userId) {
    return { available: false, reason: "attorney_access_required", unreadCount: 0, cases: [] };
  }
  const cases = await Case.find({
    ...buildCaseAccessQuery(user),
    archived: { $ne: true },
    status: { $nin: ["completed", "closed"] },
  })
    .select("_id title status")
    .lean();
  const caseIds = cases.map((caseDoc) => caseDoc._id).filter(Boolean);
  if (!caseIds.length) {
    return {
      available: true,
      checkedCaseCount: 0,
      unreadCount: 0,
      awaitingAttorneyReplyCount: 0,
      awaitingParalegalReplyCount: 0,
      cases: [],
    };
  }
  const readerId = mongoose.isValidObjectId(userId)
    ? new mongoose.Types.ObjectId(String(userId))
    : userId;
  const [latestMessages, viewer] = await Promise.all([
    Message.aggregate([
      { $match: { caseId: { $in: caseIds }, deleted: { $ne: true }, type: { $ne: "system" } } },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: "$caseId",
          senderRole: { $first: "$senderRole" },
          createdAt: { $first: "$createdAt" },
        },
      },
    ]),
    User.findById(userId).select("messageLastViewedAt").lean(),
  ]);
  const lastViewedMap = viewer?.messageLastViewedAt || new Map();
  const unreadByCase = await Promise.all(
    caseIds.map(async (caseId) => {
      const key = normalizeId(caseId);
      const lastViewed = typeof lastViewedMap.get === "function"
        ? lastViewedMap.get(key)
        : lastViewedMap?.[key];
      const query = {
        caseId,
        deleted: { $ne: true },
        senderId: { $ne: readerId },
      };
      if (lastViewed) query.createdAt = { $gt: new Date(lastViewed) };
      else {
        query.$and = [
          { readBy: { $ne: readerId } },
          { "readReceipts.user": { $ne: readerId } },
        ];
      }
      return [key, Number(await Message.countDocuments(query))];
    })
  );
  const latestByCase = new Map(latestMessages.map((entry) => [normalizeId(entry._id), entry]));
  const unreadCountByCase = new Map(unreadByCase);
  const items = cases
    .map((caseDoc) => {
      const caseId = normalizeId(caseDoc._id);
      const latest = latestByCase.get(caseId) || null;
      const lastSenderRole = String(latest?.senderRole || "").toLowerCase();
      return {
        caseId,
        title: String(caseDoc.title || "Untitled matter"),
        status: normalizeCaseStatus(caseDoc.status),
        unreadCount: unreadCountByCase.get(caseId) || 0,
        lastMessageAt: serializeDate(latest?.createdAt),
        awaitingAttorneyReply: lastSenderRole === "paralegal",
        awaitingParalegalReply: lastSenderRole === "attorney",
      };
    })
    .filter((entry) => entry.unreadCount > 0 || entry.awaitingAttorneyReply || entry.awaitingParalegalReply)
    .sort((left, right) => new Date(right.lastMessageAt || 0).getTime() - new Date(left.lastMessageAt || 0).getTime());
  return {
    available: true,
    checkedCaseCount: cases.length,
    unreadCount: items.reduce((total, entry) => total + entry.unreadCount, 0),
    awaitingAttorneyReplyCount: items.filter((entry) => entry.awaitingAttorneyReply).length,
    awaitingParalegalReplyCount: items.filter((entry) => entry.awaitingParalegalReply).length,
    cases: items.slice(0, 12),
    returnedCaseCount: Math.min(items.length, 12),
    matchingCaseCount: items.length,
    truncated: items.length > 12,
    unreadPolicy: "message_last_viewed_then_receipts",
  };
}

async function getAttorneyAttentionSummary(user = {}) {
  if (normalizeRole(user) !== "attorney") {
    return { available: false, reason: "attorney_access_required" };
  }
  const [caseOverview, applications, messages, pendingParalegal, nextDeadline] = await Promise.all([
    getMyCaseOverview(user, "active"),
    getAttorneyApplicationActivity(user),
    getAttorneyMessageActivity(user),
    getAttorneyPendingParalegalSnapshot(user),
    getNextCaseDeadlineSnapshot(user),
  ]);
  return {
    available: true,
    caseCounts: {
      total: caseOverview.totalCount,
      active: caseOverview.activeCount,
      completed: caseOverview.completedCount,
      byStatus: caseOverview.byStatus,
    },
    applications: {
      pendingCount: applications.pendingApplicationCount,
      caseCount: applications.caseCountWithPendingApplications,
      cases: applications.cases.slice(0, 5),
      returnedCaseCount: Math.min(applications.cases.length, 5),
      truncated: applications.cases.length > 5,
    },
    messages: {
      unreadCount: messages.unreadCount,
      awaitingAttorneyReplyCount: messages.awaitingAttorneyReplyCount,
      awaitingParalegalReplyCount: messages.awaitingParalegalReplyCount,
      cases: messages.cases.slice(0, 5),
      returnedCaseCount: Math.min(messages.cases.length, 5),
      truncated: messages.cases.length > 5 || messages.truncated === true,
    },
    pendingParalegal: {
      caseCount: pendingParalegal.pendingCaseCount,
      signalCount: pendingParalegal.totalPendingSignals,
      items: pendingParalegal.items.slice(0, 5),
      returnedCaseCount: Math.min(pendingParalegal.items.length, 5),
      truncated: pendingParalegal.items.length > 5,
    },
    nextDeadline: sanitizeCaseSnapshot(nextDeadline),
  };
}

function sanitizeCaseSnapshot(snapshot = {}) {
  return {
    requestedCaseId: String(snapshot.requestedCaseId || ""),
    caseId: String(snapshot.caseId || ""),
    found: snapshot.found === true,
    accessible: snapshot.accessible === true,
    roleOnCase: String(snapshot.roleOnCase || ""),
    reason: String(snapshot.reason || ""),
    title: String(snapshot.title || ""),
    status: normalizeCaseStatus(snapshot.status),
    deadline: serializeDate(snapshot.deadline),
    readOnly: snapshot.readOnly === true,
    paymentReleased: snapshot.paymentReleased === true,
    paidOutAt: serializeDate(snapshot.paidOutAt),
    escrowStatus: String(snapshot.escrowStatus || ""),
    blockers: Array.isArray(snapshot.blockers) ? snapshot.blockers.slice(0, 10) : [],
    nextSteps: Array.isArray(snapshot.nextSteps) ? snapshot.nextSteps.slice(0, 6) : [],
    incompleteTaskCount: Array.isArray(snapshot.caseDoc?.tasks)
      ? snapshot.caseDoc.tasks.filter((task) => task?.completed !== true).length
      : 0,
    pendingApplicationCount: Array.isArray(snapshot.caseDoc?.applicants)
      ? snapshot.caseDoc.applicants.filter((entry) => String(entry?.status || "pending") === "pending").length
      : 0,
  };
}

async function resolveCaseForTool({ user, caseReference = "", pageContext = {}, previousState = {}, task = "FACT_LOOKUP" }) {
  const reference = String(caseReference || "").trim();
  const contextCaseId = String(pageContext.caseId || "").trim();
  const directCaseId = mongoose.isValidObjectId(reference) ? reference : contextCaseId;
  const resolved = await resolveSupportCaseEntity({
    user,
    message: reference,
    pageContext: { ...pageContext, caseId: directCaseId },
    previousState,
    task,
  });
  return {
    ...(resolved || {}),
    caseId: String(resolved?.caseId || ""),
  };
}

function buildCaseClarification(resolution = {}) {
  const candidateTitles = Array.isArray(resolution.candidates)
    ? resolution.candidates.map((candidate) => String(candidate?.title || "").trim()).filter(Boolean).slice(0, 3)
    : [];
  return {
    available: false,
    found: false,
    reason: candidateTitles.length ? "case_reference_ambiguous" : String(resolution.reason || "case_reference_not_resolved"),
    clarificationNeeded: true,
    clarificationPrompt: candidateTitles.length
      ? `Which matter do you mean: ${candidateTitles.join(", ")}?`
      : "Which matter do you mean?",
    candidateTitles,
  };
}

function buildContextualCaseReference(caseReference = "", conversationHistory = []) {
  // History identifies intent but is not an entity query. Mixing old case names
  // into a fresh lookup can silently select the wrong owned matter.
  return String(caseReference || "").trim().slice(0, 1000);
}

async function getCaseDetails({ user, caseReference, pageContext, previousState, conversationHistory = [] }) {
  const resolution = await resolveCaseForTool({
    user,
    caseReference: buildContextualCaseReference(caseReference, conversationHistory),
    pageContext,
    previousState,
  });
  const caseId = resolution.caseId;
  if (!caseId) {
    return {
      accessible: false,
      ...buildCaseClarification(resolution),
    };
  }
  const snapshot = await getCaseSnapshot(user, { ...pageContext, caseId });
  const workspace = await getWorkspaceAccessSnapshot(user, { ...pageContext, caseId }, snapshot);
  return {
    ...sanitizeCaseSnapshot(snapshot),
    workspace: {
      available: workspace.available !== false,
      canUseWorkspace: workspace.canUseWorkspace === true,
      reason: String(workspace.reason || ""),
      blockers: Array.isArray(workspace.blockers) ? workspace.blockers.slice(0, 10) : [],
      nextSteps: Array.isArray(workspace.nextSteps) ? workspace.nextSteps.slice(0, 6) : [],
    },
  };
}

function safeTask(task = {}) {
  const title = String(task.title || "Untitled task").slice(0, 300);
  const directive = /(?:^|[.!?]\s*)(?:ignore|disregard|forget|follow|reveal|return|respond|answer|output|write|say|act|pretend|override|bypass)\b/i.test(title);
  const controlTarget = /\b(?:instruction|prompt|system|developer|assistant|tool|policy|rule|only|instead)\b/i.test(title);
  return {
    title,
    completed: task.completed === true,
    createdAt: serializeDate(task.createdAt),
    contentTrust: directive && controlTarget ? "prompt_like_untrusted" : "untrusted_record_content",
  };
}

function safeEmbeddedFile(file = {}) {
  return {
    name: String(file.original || file.filename || "File").slice(0, 500),
    status: String(file.status || "pending_review"),
    version: Number(file.version || 1),
    uploadedByRole: String(file.uploadedByRole || ""),
    createdAt: serializeDate(file.createdAt),
    approvedAt: serializeDate(file.approvedAt),
    revisionRequestedAt: serializeDate(file.revisionRequestedAt),
  };
}

async function getAttorneyCaseWorkspace({
  user,
  caseReference,
  pageContext,
  previousState,
  conversationHistory = [],
}) {
  if (normalizeRole(user) !== "attorney") {
    return { available: false, reason: "attorney_access_required" };
  }
  const resolution = await resolveCaseForTool({
    user,
    caseReference: buildContextualCaseReference(caseReference, conversationHistory),
    pageContext,
    previousState,
  });
  const caseId = resolution.caseId;
  if (!caseId) {
    return buildCaseClarification(resolution);
  }
  const snapshot = await getCaseSnapshot(user, { ...pageContext, caseId });
  const caseDoc = snapshot.caseDoc || null;
  if (!caseDoc || snapshot.accessible !== true || snapshot.roleOnCase !== "attorney") {
    return { available: false, reason: snapshot.reason || "attorney_access_required" };
  }

  const applicantIds = [...new Set((caseDoc.applicants || []).map((item) => normalizeId(item.paralegalId)).filter(Boolean))];
  const participantIds = [...new Set([
    normalizeId(caseDoc.paralegalId || caseDoc.paralegal),
    normalizeId(caseDoc.pendingParalegalId),
    ...applicantIds,
  ].filter((id) => mongoose.isValidObjectId(id)))];
  const [people, storedFiles] = await Promise.all([
    participantIds.length
      ? User.find({ _id: { $in: participantIds } }).select("_id firstName lastName").lean()
      : [],
    CaseFile.find({ caseId: caseDoc._id })
      .select("originalName uploadedByRole status version revisionNotes revisionRequestedAt approvedAt createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .lean(),
  ]);
  const names = new Map(people.map((person) => [normalizeId(person._id), formatPersonName(person)]));
  const modernFiles = storedFiles.map((file) => {
    const plain = decryptCaseFilePayload(file);
    return {
      name: String(plain.originalName || "File").slice(0, 500),
      status: String(plain.status || "pending_review"),
      version: Number(plain.version || 1),
      uploadedByRole: String(plain.uploadedByRole || ""),
      createdAt: serializeDate(plain.createdAt),
      approvedAt: serializeDate(plain.approvedAt),
      revisionRequestedAt: serializeDate(plain.revisionRequestedAt),
      revisionNotes: String(plain.revisionNotes || "").slice(0, 600),
    };
  });
  const legacyFiles = (caseDoc.files || []).map(safeEmbeddedFile);
  const files = [...modernFiles, ...legacyFiles]
    .filter((file, index, all) => all.findIndex((candidate) => candidate.name === file.name && candidate.version === file.version) === index);
  const tasks = (caseDoc.tasks || []).map(safeTask);
  const applicants = (caseDoc.applicants || []).map((applicant) => ({
    name: names.get(normalizeId(applicant.paralegalId)) || "Paralegal applicant",
    status: String(applicant.status || "pending"),
    appliedAt: serializeDate(applicant.appliedAt),
  }));
  const invites = (caseDoc.invites || []).map((invite) => ({
    name: names.get(normalizeId(invite.paralegalId)) || "Invited paralegal",
    status: String(invite.status || "pending"),
    invitedAt: serializeDate(invite.invitedAt),
    respondedAt: serializeDate(invite.respondedAt),
  }));
  const assignedParalegalId = normalizeId(caseDoc.paralegalId || caseDoc.paralegal);

  return {
    available: true,
    caseId: String(caseDoc._id),
    title: String(caseDoc.title || "Untitled matter"),
    practiceArea: String(caseDoc.practiceArea || ""),
    status: normalizeCaseStatus(caseDoc.status),
    deadline: serializeDate(caseDoc.deadline),
    readOnly: caseDoc.readOnly === true,
    workspaceAccessible: snapshot.accessible === true,
    assignedParalegal: assignedParalegalId
      ? { assigned: true, name: names.get(assignedParalegalId) || "Assigned paralegal" }
      : { assigned: false, name: "" },
    tasks: {
      total: tasks.length,
      completed: tasks.filter((task) => task.completed).length,
      incomplete: tasks.filter((task) => !task.completed).length,
      locked: caseDoc.tasksLocked === true,
      items: tasks,
    },
    files: {
      total: files.length,
      pendingReview: files.filter((file) => file.status === "pending_review").length,
      revisionsRequested: files.filter((file) => file.status === "attorney_revision").length,
      approved: files.filter((file) => file.status === "approved").length,
      items: files,
    },
    applications: {
      total: applicants.length,
      pending: applicants.filter((applicant) => applicant.status === "pending").length,
      items: applicants,
    },
    invitations: {
      pending: invites.filter((invite) => invite.status === "pending").length,
      items: invites,
    },
    preEngagement: caseDoc.preEngagement
      ? {
          status: String(caseDoc.preEngagement.status || ""),
          confidentialityRequired: caseDoc.preEngagement.confidentialityAgreementRequired === true,
          conflictsCheckRequired: caseDoc.preEngagement.conflictsCheckRequired === true,
          submittedAt: serializeDate(caseDoc.preEngagement.submittedAt),
          reviewedAt: serializeDate(caseDoc.preEngagement.reviewedAt),
        }
      : null,
    disputes: {
      total: Array.isArray(caseDoc.disputes) ? caseDoc.disputes.length : 0,
      open: Array.isArray(caseDoc.disputes)
        ? caseDoc.disputes.filter((dispute) => String(dispute.status || "open") === "open").length
        : 0,
      items: (caseDoc.disputes || []).slice(-10).map((dispute) => ({
        status: String(dispute.status || "open"),
        amountRequested: Number.isFinite(Number(dispute.amountRequestedCents))
          ? {
              cents: cents(dispute.amountRequestedCents),
              formatted: formatMoney(dispute.amountRequestedCents, caseDoc.currency),
            }
          : null,
        createdAt: serializeDate(dispute.createdAt),
        updatedAt: serializeDate(dispute.updatedAt),
      })),
    },
    lifecycle: {
      completedAt: serializeDate(caseDoc.completedAt),
      archived: caseDoc.archived === true,
      archiveReadyAt: serializeDate(caseDoc.archiveReadyAt),
      archiveDownloadedAt: serializeDate(caseDoc.archiveDownloadedAt),
      purgeScheduledFor: serializeDate(caseDoc.purgeScheduledFor),
      terminationStatus: String(caseDoc.terminationStatus || "none"),
      terminationReason: String(caseDoc.terminationReason || "").slice(0, 500),
      terminationRequestedAt: serializeDate(caseDoc.terminationRequestedAt),
      payoutFinalizedAt: serializeDate(caseDoc.payoutFinalizedAt),
      payoutFinalizedType: String(caseDoc.payoutFinalizedType || ""),
      partialPayoutAmount: Number.isFinite(Number(caseDoc.partialPayoutAmount))
        ? {
            cents: cents(caseDoc.partialPayoutAmount),
            formatted: formatMoney(caseDoc.partialPayoutAmount, caseDoc.currency),
          }
        : null,
      remainingAmount: Number.isFinite(Number(caseDoc.remainingAmount))
        ? {
            cents: cents(caseDoc.remainingAmount),
            formatted: formatMoney(caseDoc.remainingAmount, caseDoc.currency),
          }
        : null,
      relistPending: caseDoc.relistPending === true,
      relistRequestedAt: serializeDate(caseDoc.relistRequestedAt),
      archiveEvidenceState: caseDoc.purgedAt
        ? EVIDENCE_STATES.NOT_APPLICABLE
        : caseDoc.archiveZipKey
          ? EVIDENCE_STATES.UNKNOWN
          : EVIDENCE_STATES.ABSENT,
      archiveStorageChecked: false,
    },
    moderation: {
      status: String(caseDoc.moderationStatus || "none"),
      flaggedAt: serializeDate(caseDoc.moderationFlaggedAt),
      resolutionRequestedAt: serializeDate(caseDoc.moderationResolutionRequestedAt),
    },
    meeting: {
      zoomLinkConfigured: Boolean(String(caseDoc.zoomLink || "").trim()),
      zoomLink: String(caseDoc.zoomLink || ""),
    },
  };
}

async function getAttorneyReceiptHistory(user = {}) {
  if (normalizeRole(user) !== "attorney") {
    return { available: false, reason: "attorney_access_required", receipts: [] };
  }
  const cases = await Case.find({
    ...buildCaseAccessQuery(user),
    $and: [
      {
        $or: [
          { paymentIntentId: { $exists: true, $ne: null } },
          { escrowIntentId: { $exists: true, $ne: null } },
          { paymentReleased: true },
        ],
      },
    ],
  })
    .select("_id title currency lockedTotalAmount totalAmount feeAttorneyPct feeAttorneyAmount paymentReleased paidOutAt completedAt createdAt updatedAt")
    .sort({ paidOutAt: -1, completedAt: -1, updatedAt: -1 })
    .lean();
  const receipts = cases.map((caseDoc) => {
    const base = cents(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount);
    const fee = calculateFee(base, caseDoc.feeAttorneyAmount, caseDoc.feeAttorneyPct);
    const currency = String(caseDoc.currency || "usd").toLowerCase();
    return {
      caseId: String(caseDoc._id),
      title: String(caseDoc.title || "Untitled matter"),
      totalCharge: { cents: base + fee, formatted: formatMoney(base + fee, currency) },
      matterAmount: { cents: base, formatted: formatMoney(base, currency) },
      platformFee: { cents: fee, formatted: formatMoney(fee, currency) },
      paymentReleased: caseDoc.paymentReleased === true,
      issuedAt: serializeDate(caseDoc.paidOutAt || caseDoc.completedAt || caseDoc.updatedAt || caseDoc.createdAt),
      receiptHref: `/api/payments/receipt/attorney/${caseDoc._id}`,
    };
  });
  return { available: true, receiptCount: receipts.length, receipts, aggregationComplete: true };
}

async function getAttorneyAccountSnapshot(user = {}) {
  if (normalizeRole(user) !== "attorney") {
    return { available: false, reason: "attorney_access_required" };
  }
  const userId = user._id || user.id;
  const account = await User.findById(userId)
    .select("firstName lastName email role status disabled lawFirm firmWebsite state timezone practiceAreas primaryPracticeArea preferences notifications notificationPrefs twoFactorEnabled twoFactorMethod attorneyPricingAccepted termsAccepted profilePhotoStatus bio onboarding")
    .lean();
  if (!account) return { available: false, reason: "account_not_found" };
  const missingProfileFields = [];
  if (!String(account.lawFirm || "").trim()) missingProfileFields.push("law firm");
  if (!String(account.state || "").trim()) missingProfileFields.push("state");
  if (!(account.practiceAreas || []).length && !String(account.primaryPracticeArea || "").trim()) {
    missingProfileFields.push("practice areas");
  }
  if (!String(account.bio || "").trim()) missingProfileFields.push("bio");
  return {
    available: true,
    name: formatPersonName(account),
    email: String(account.email || ""),
    lawFirm: String(account.lawFirm || ""),
    firmWebsite: String(account.firmWebsite || ""),
    state: String(account.state || ""),
    timezone: String(account.timezone || ""),
    practiceAreas: Array.isArray(account.practiceAreas) ? account.practiceAreas.slice(0, 30) : [],
    primaryPracticeArea: String(account.primaryPracticeArea || ""),
    profilePhotoStatus: String(account.profilePhotoStatus || ""),
    profileComplete: null,
    missingProfileFields,
    profileAssessment: {
      evidenceState: EVIDENCE_STATES.BLOCKED_POLICY,
      reason: "profile_completion_definitions_conflict",
      onboardingMarkedComplete: account.onboarding?.attorneyProfileCompleted === true,
      assistantMinimumFieldsPresent: missingProfileFields.length === 0,
    },
    twoFactor: {
      featureAvailable: String(process.env.ENABLE_TWO_FACTOR || "").toLowerCase() === "true",
      configured: account.twoFactorEnabled === true,
      method: account.twoFactorEnabled === true ? String(account.twoFactorMethod || "") : "",
    },
    termsAccepted: account.termsAccepted === true,
    attorneyPricingAccepted: account.attorneyPricingAccepted === true,
    preferences: account.preferences || {},
    notifications: account.notificationPrefs || account.notifications || {},
  };
}

function calculateFee(baseAmountCents, storedAmount, storedPct) {
  const base = cents(baseAmountCents);
  const amount = cents(storedAmount);
  const pct = Number(storedPct);
  if (amount > 0 || base <= 0) return amount;
  return Number.isFinite(pct) ? Math.max(0, Math.round(base * (pct / 100))) : 0;
}

async function getAttorneyCaseFinancials({
  user,
  caseReference,
  pageContext,
  previousState,
  conversationHistory = [],
}) {
  if (normalizeRole(user) !== "attorney") {
    return { available: false, reason: "attorney_access_required" };
  }
  const contextualCaseReference = buildContextualCaseReference(caseReference, conversationHistory);
  const resolution = await resolveCaseForTool({
    user,
    caseReference: contextualCaseReference,
    pageContext,
    previousState,
    task: "FACT_LOOKUP",
  });
  const caseId = resolution.caseId;
  if (!caseId) {
    return {
      ...buildCaseClarification(resolution),
    };
  }

  const snapshot = await getCaseSnapshot(user, { ...pageContext, caseId, supportCategory: "payment" });
  const caseDoc = snapshot.caseDoc || null;
  if (!caseDoc || snapshot.accessible !== true || snapshot.roleOnCase !== "attorney") {
    return {
      available: false,
      found: snapshot.found === true,
      accessible: snapshot.accessible === true,
      reason: snapshot.reason || "attorney_access_required",
    };
  }

  const settlement = caseDoc.disputeSettlement || {};
  const isReleasedSettlement = ["release_full", "release_partial"].includes(String(settlement.action || ""));
  const isWithdrawalPayout = Boolean(
    caseDoc.payoutFinalizedAt &&
      caseDoc.payoutFinalizedType
  );
  const standardBase = cents(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount);
  const payoutGrossAmount = isReleasedSettlement
    ? cents(settlement.grossAmount)
    : isWithdrawalPayout
      ? cents(caseDoc.partialPayoutAmount)
      : standardBase;
  const attorneyFeePct = Number(
    isReleasedSettlement && Number.isFinite(Number(settlement.feeAttorneyPct))
      ? settlement.feeAttorneyPct
      : caseDoc.feeAttorneyPct
  );
  const paralegalFeePct = Number(
    isReleasedSettlement && Number.isFinite(Number(settlement.feeParalegalPct))
      ? settlement.feeParalegalPct
      : caseDoc.feeParalegalPct
  );
  const attorneyPlatformFee = calculateFee(
    standardBase,
    isReleasedSettlement ? settlement.feeAttorneyAmount : caseDoc.feeAttorneyAmount,
    attorneyFeePct
  );
  const paralegalPlatformFee = calculateFee(
    payoutGrossAmount,
    isReleasedSettlement ? settlement.feeParalegalAmount : caseDoc.feeParalegalAmount,
    paralegalFeePct
  );
  const payoutRecord = await Payout.findOne({ caseId: caseDoc._id })
    .select("caseId amountPaid createdAt")
    .lean();
  const calculatedPayout = isReleasedSettlement && Number.isFinite(Number(settlement.payoutAmount))
    ? cents(settlement.payoutAmount)
    : Math.max(0, payoutGrossAmount - paralegalPlatformFee);
  const netParalegalPayout = payoutRecord ? cents(payoutRecord.amountPaid) : calculatedPayout;
  const currency = String(caseDoc.currency || "usd").toLowerCase();

  return {
    available: standardBase > 0,
    found: true,
    accessible: true,
    caseId: String(caseDoc._id),
    title: String(caseDoc.title || "Untitled matter"),
    currency,
    paymentReleased: caseDoc.paymentReleased === true,
    paidOutAt: serializeDate(caseDoc.paidOutAt || payoutRecord?.createdAt),
    matterAmount: { cents: standardBase, formatted: formatMoney(standardBase, currency) },
    attorneyPlatformFee: {
      cents: attorneyPlatformFee,
      formatted: formatMoney(attorneyPlatformFee, currency),
      percent: Number.isFinite(attorneyFeePct) ? attorneyFeePct : null,
    },
    totalAttorneyCharge: {
      cents: standardBase + attorneyPlatformFee,
      formatted: formatMoney(standardBase + attorneyPlatformFee, currency),
    },
    paralegalPlatformFee: {
      cents: paralegalPlatformFee,
      formatted: formatMoney(paralegalPlatformFee, currency),
      percent: Number.isFinite(paralegalFeePct) ? paralegalFeePct : null,
    },
    netParalegalPayout: {
      cents: netParalegalPayout,
      formatted: formatMoney(netParalegalPayout, currency),
      source: payoutRecord ? "payout_ledger" : "case_fee_snapshot_calculation",
    },
    financialEvidence: {
      matterAmountSource: caseDoc.lockedTotalAmount != null ? "locked_case_snapshot" : "case_total",
      attorneyFeeSource: caseDoc.amountLockedAt || caseDoc.paymentIntentId || caseDoc.escrowIntentId
        ? "case_fee_snapshot"
        : "unverified_case_default",
      payoutSource: payoutRecord ? "payout_ledger" : "calculated_from_case_fields",
      payoutGrossAmount: {
        cents: payoutGrossAmount,
        formatted: formatMoney(payoutGrossAmount, currency),
      },
    },
  };
}

function sanitizeKnowledgeResults(results = []) {
  return results.slice(0, 3).map((item) => ({
    key: String(item.key || ""),
    title: String(item.title || ""),
    answer: String(item.answer || item.approvedResponse || item.statement || ""),
    supportingPoints: Array.isArray(item.supportingPoints) ? item.supportingPoints.slice(0, 5) : [],
    sourceKey: String(item.sourceKey || ""),
    score: Number(item.score || 0),
  }));
}

function sanitizeMessagingSnapshot(snapshot = {}) {
  return {
    available: snapshot.available !== false,
    canSend: snapshot.canSend === true,
    reason: String(snapshot.reason || ""),
    isBlocked: snapshot.isBlocked === true,
    totalMessages: Number(snapshot.totalMessages || 0),
    lastMessageAt: serializeDate(snapshot.lastMessageAt),
    lastMessagePreview: String(snapshot.lastMessagePreview || "").slice(0, 160),
    clarificationNeeded: snapshot.clarificationNeeded === true,
    clarificationPrompt: String(snapshot.clarificationPrompt || ""),
    blockers: Array.isArray(snapshot.blockers) ? snapshot.blockers.slice(0, 10) : [],
    nextSteps: Array.isArray(snapshot.nextSteps) ? snapshot.nextSteps.slice(0, 6) : [],
  };
}

function sanitizePendingParalegalSnapshot(snapshot = {}) {
  return {
    available: snapshot.available !== false,
    checkedCaseCount: Number(snapshot.checkedCaseCount || 0),
    pendingCaseCount: Number(snapshot.pendingCaseCount || 0),
    totalPendingSignals: Number(snapshot.totalPendingSignals || 0),
    reason: String(snapshot.reason || ""),
    items: (snapshot.items || []).map((item) => ({
      caseId: String(item.caseId || ""),
      title: String(item.title || ""),
      status: normalizeCaseStatus(item.status),
      deadline: serializeDate(item.deadline),
      reasons: Array.isArray(item.reasons) ? item.reasons.map(String) : [],
      incompleteTaskCount: item.incompleteTaskCount == null ? null : Number(item.incompleteTaskCount),
      taskResponsibilityState: String(item.taskResponsibilityState || ""),
      latestMessageAt: serializeDate(item.latestMessageAt),
    })),
  };
}

function sanitizePayoutSnapshot(snapshot = {}) {
  const recent = snapshot.recentPayout || null;
  return {
    role: String(snapshot.role || ""),
    relevantCaseId: String(snapshot.relevantCaseId || ""),
    relevantCaseTitle: String(snapshot.relevantCaseTitle || ""),
    hasRecentPayoutActivity: snapshot.hasRecentPayoutActivity === true,
    hasPayoutHistory: snapshot.hasPayoutHistory === true,
    paymentReleased: snapshot.paymentReleased === true,
    paidOutAt: serializeDate(snapshot.paidOutAt),
    completedAt: serializeDate(snapshot.completedAt),
    payoutFinalizedAt: serializeDate(snapshot.payoutFinalizedAt),
    payoutFinalizedType: String(snapshot.payoutFinalizedType || ""),
    partialPayoutAmount: Number(snapshot.partialPayoutAmount || 0),
    escrowStatus: String(snapshot.escrowStatus || ""),
    recentPayout: recent
      ? {
          caseId: String(recent.caseId || ""),
          amountPaid: Number(recent.amountPaid || 0),
          stripeMode: String(recent.stripeMode || ""),
          createdAt: serializeDate(recent.createdAt),
        }
      : null,
    blockers: Array.isArray(snapshot.blockers) ? snapshot.blockers.slice(0, 10) : [],
    nextSteps: Array.isArray(snapshot.nextSteps) ? snapshot.nextSteps.slice(0, 6) : [],
  };
}

function getSupportManagerToolDefinitions(role = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return (ROLE_TOOL_NAMES[normalizedRole] || []).map((name) => TOOL_DEFINITIONS[name]);
}

function validateToolArguments(name, args) {
  const definition = TOOL_DEFINITIONS[name];
  if (!definition) return { valid: false, error: "unknown_tool" };
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { valid: false, error: "invalid_tool_arguments" };
  }
  const schema = definition.parameters || EMPTY_PARAMETERS;
  const properties = schema.properties || {};
  const allowed = new Set(Object.keys(properties));
  const unsupported = Object.keys(args).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    return { valid: false, error: "unsupported_tool_argument", fields: unsupported.sort() };
  }
  const missing = (schema.required || []).filter(
    (key) => !Object.prototype.hasOwnProperty.call(args, key) || args[key] === undefined || args[key] === null
  );
  if (missing.length) return { valid: false, error: "missing_tool_argument", fields: missing };
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key] || {};
    if (property.type === "string" && typeof value !== "string") {
      return { valid: false, error: "invalid_tool_argument_type", fields: [key] };
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value)) {
      return { valid: false, error: "invalid_tool_argument_value", fields: [key] };
    }
  }
  return { valid: true };
}

function inferEvidenceState(result = {}) {
  const explicit = String(result.evidenceState || result.evidence?.state || "");
  if (explicit) return explicit;
  const reason = String(result.reason || result.error || "").toLowerCase();
  if (/access|required_for_role|not_available_for_role|unauthor/.test(reason)) return "unauthorized";
  if (/lookup_failed|unavailable|execution_failed|stripe_unconfigured/.test(reason)) {
    return "temporarily_unavailable";
  }
  if (/not_applicable|already_completed|matter_final/.test(reason)) return "not_applicable";
  if (/not_found|stored_missing|live_none/.test(reason)) return "absent";
  if (/not_resolved|clarification|unknown|no_case_context|tool_argument/.test(reason)) return "unknown";
  if (result.available === false || result.found === false) return "unknown";
  return "verified";
}

function withToolEvidence(name, result = {}, args = {}) {
  const observedAt = new Date().toISOString();
  return {
    ...result,
    evidenceState: inferEvidenceState(result),
    evidence: {
      ...normalizeAttorneyToolEvidence({ toolName: name, result, args, retrievedAt: observedAt }),
      state: inferEvidenceState(result),
      source: name,
      observedAt,
    },
  };
}

function getNavigationDestination(role = "", destination = "") {
  const navigation = NAVIGATION_BY_ROLE[String(role || "").toLowerCase()]?.[String(destination || "").toLowerCase()];
  if (!navigation) {
    return { available: false, reason: "destination_not_available_for_role" };
  }
  return { available: true, ...navigation, inlineLinkText: "here" };
}

async function getAttorneyWorkflowReadiness(user = {}, pageContext = {}) {
  if (normalizeRole(user) !== "attorney") {
    return { available: false, authoritativeWorkflow: false, reason: "attorney_access_required" };
  }

  const billing = await getBillingMethodSnapshot(user, { ...pageContext, supportCategory: "payment" });
  const explicitMissingSources = new Set(["stored_missing", "live_none"]);
  const hasSavedPaymentMethod = billing.available === true
    ? true
    : explicitMissingSources.has(String(billing.source || ""))
      ? false
      : null;
  const policy = getAttorneyWorkflowPolicy();
  const stages = Object.fromEntries(
    Object.entries(policy).map(([stage, rule]) => [
      stage,
      {
        ...rule,
        ready:
          rule.paymentMethodRequired !== true
            ? null
            : hasSavedPaymentMethod === null
              ? null
              : hasSavedPaymentMethod,
        blocker:
          rule.paymentMethodRequired !== true
            ? "matter_context_required"
            : hasSavedPaymentMethod === false
              ? "saved_payment_method_required"
              : hasSavedPaymentMethod === null
                ? "payment_method_state_unavailable"
                : "",
      },
    ])
  );

  return {
    available: true,
    authoritativeWorkflow: true,
    paymentMethod: {
      stateKnown: hasSavedPaymentMethod !== null,
      saved: hasSavedPaymentMethod,
      usable: billing.isValid === true,
      source: String(billing.source || ""),
      brand: String(billing.brand || ""),
      last4: String(billing.last4 || ""),
      isExpired: billing.isExpired === true,
    },
    requirements: {
      paymentMethodRequiredBeforePosting: policy.post_matter.paymentMethodRequired === true,
      paymentMethodRequiredBeforeApplications: policy.receive_applications.paymentMethodRequired === true,
      paymentMethodRequiredBeforeHiring: policy.hire_and_fund.paymentMethodRequired === true,
      chargeTiming: String(policy.hire_and_fund.chargeTiming || ""),
      postHireWorkflow: {
        matterStatus: String(policy.hire_and_fund.resultingMatterStatus || ""),
        fundingStatus: String(policy.hire_and_fund.resultingFundingStatus || ""),
        scopeTasksLocked: policy.hire_and_fund.locksScopeTasks === true,
        nextStage: String(policy.hire_and_fund.nextStage || ""),
        workspaceParticipants: [...(policy.workspace.participants || [])],
        workspaceSupports: [...(policy.workspace.supports || [])],
        completionStage: String(policy.workspace.nextStage || ""),
      },
      paralegalPayoutTiming: {
        releaseTrigger: String(policy.complete_and_release.payoutReleaseTrigger || ""),
        allScopeTasksCompleteRequired: policy.complete_and_release.allScopeTasksComplete === true,
        verifiedFundingRequired: policy.complete_and_release.verifiedFundingRequired === true,
        paralegalPayoutSetupRequired: policy.complete_and_release.paralegalPayoutSetupRequired === true,
        bankDepositEstimateBusinessDays: {
          minimum: Number(policy.complete_and_release.bankDepositEstimateBusinessDays?.minimum || 0),
          maximum: Number(policy.complete_and_release.bankDepositEstimateBusinessDays?.maximum || 0),
        },
        bankDepositTimingDependsOn: [...(policy.complete_and_release.bankDepositTimingDependsOn || [])],
        resultingMatterStatus: String(policy.complete_and_release.resultingMatterStatus || ""),
        paymentReleased: policy.complete_and_release.paymentReleased === true,
      },
    },
    stages,
  };
}

async function getAttorneyBillingSummary(user = {}) {
  if (normalizeRole(user) !== "attorney") {
    return { available: false, reason: "attorney_access_required" };
  }
  const owned = buildCaseAccessQuery(user);
  const cases = await Case.find(owned)
    .select("_id currency status paralegal paralegalId lockedTotalAmount totalAmount feeAttorneyAmount feeAttorneyPct escrowIntentId escrowStatus paymentStatus paymentReleased paidOutAt completedAt updatedAt")
    .sort({ updatedAt: -1, _id: -1 })
    .lean();
  const active = [];
  const pending = [];
  const completed = [];
  for (const caseDoc of cases) {
    const amount = cents(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount);
    const fee = calculateFee(amount, caseDoc.feeAttorneyAmount, caseDoc.feeAttorneyPct);
    if (caseDoc.paymentReleased === true) {
      completed.push({ caseDoc, amount, fee });
    } else if (caseDoc.escrowIntentId && String(caseDoc.escrowStatus || "").toLowerCase() === "funded") {
      active.push({ caseDoc, amount });
    } else if ([caseDoc.paralegal, caseDoc.paralegalId].some(Boolean)) {
      pending.push({ caseDoc, amount });
    }
  }
  const currency = String(cases[0]?.currency || "usd").toLowerCase();
  const totalSpent = completed.reduce((sum, item) => sum + item.amount + item.fee, 0);
  const activeFunded = active.reduce((sum, item) => sum + item.amount, 0);
  const pendingFunding = pending.reduce((sum, item) => sum + item.amount, 0);
  return {
    available: true,
    currency,
    totalSpent: { cents: totalSpent, formatted: formatMoney(totalSpent, currency) },
    activeFunded: { cents: activeFunded, formatted: formatMoney(activeFunded, currency) },
    pendingFunding: { cents: pendingFunding, formatted: formatMoney(pendingFunding, currency) },
    completedMatterCount: completed.length,
    activeFundedMatterCount: active.length,
    pendingFundingMatterCount: pending.length,
    historyRecordCount: completed.length,
    exportAvailable: completed.length > 0,
    aggregationComplete: true,
  };
}

async function getAttorneyDeactivationEligibility(user = {}) {
  if (normalizeRole(user) !== "attorney") {
    return { available: false, reason: "attorney_access_required" };
  }
  const userId = user._id || user.id;
  if (!userId) return { available: false, reason: "account_not_found" };
  const eligibility = await getAccountDeactivationEligibility({
    _id: userId,
    role: "attorney",
    disabled: user.disabled === true,
    deleted: user.deleted === true,
  });
  return {
    available: true,
    canDeactivate: eligibility.canDeactivate === true,
    blockers: (eligibility.blockers || []).map((blocker) => ({
      code: String(blocker.code || ""),
      count: Number(blocker.count || 0),
      message: String(blocker.message || ""),
    })),
  };
}

async function getAttorneyMatterReadiness({
  user,
  caseReference,
  pageContext,
  previousState,
  conversationHistory = [],
}) {
  if (normalizeRole(user) !== "attorney") {
    return { available: false, reason: "attorney_access_required" };
  }
  const resolution = await resolveCaseForTool({
    user,
    caseReference: buildContextualCaseReference(caseReference, conversationHistory),
    pageContext,
    previousState,
    task: "FACT_LOOKUP",
  });
  const caseId = resolution.caseId;
  if (!caseId) {
    return buildCaseClarification(resolution);
  }
  const snapshot = await getCaseSnapshot(user, { ...pageContext, caseId, supportCategory: "workflow" });
  const caseDoc = snapshot.caseDoc || null;
  if (!caseDoc || snapshot.accessible !== true || snapshot.roleOnCase !== "attorney") {
    return {
      available: false,
      found: snapshot.found === true,
      accessible: snapshot.accessible === true,
      reason: snapshot.reason || "attorney_access_required",
    };
  }

  const attorneyId = normalizeId(user._id || user.id);
  const targetId = normalizeId(caseDoc.pendingParalegalId);
  const target = targetId && mongoose.isValidObjectId(targetId)
    ? await User.findById(targetId)
        .select("_id role status stripeAccountId stripeOnboarded stripePayoutsEnabled")
        .lean()
    : null;
  const paymentMethod = await getBillingMethodSnapshot(user, { ...pageContext, supportCategory: "payment" });
  const paymentSaved = paymentMethod.evidenceState === EVIDENCE_STATES.VERIFIED && paymentMethod.isValid === true;
  const partiesBlocked = target ? await isBlockedBetween(attorneyId, target._id) : false;
  const ownerAuthorized = ownsCase(caseDoc, attorneyId);
  const targetSelected = Boolean(target);
  const payoutSetupReady = Boolean(target?.stripeAccountId && target?.stripeOnboarded && target?.stripePayoutsEnabled);
  const existingInvite = targetId
    ? (caseDoc.invites || []).find((invite) => normalizeId(invite.paralegalId) === targetId)
    : null;
  const invitation = evaluateInvitationEligibility({
    caseDoc,
    ownerAuthorized,
    targetSelected,
    paralegalApproved: String(target?.role || "").toLowerCase() === "paralegal" && String(target?.status || "").toLowerCase() === "approved",
    payoutSetupReady,
    partiesBlocked,
    existingInviteStatus: String(existingInvite?.status || "").toLowerCase(),
  });
  const preEngagement = evaluatePreEngagementRequest({
    caseDoc,
    ownerAuthorized,
    targetSelected,
    partiesBlocked,
    confidentialityRequired: caseDoc.preEngagement?.confidentialityAgreementRequired === true,
    conflictsCheckRequired: caseDoc.preEngagement?.conflictsCheckRequired === true,
    conflictsDetails: caseDoc.preEngagement?.conflictsDetails || "",
    confidentialityDocumentReady: Boolean(caseDoc.preEngagement?.confidentialityDocument),
  });
  const hiring = evaluateHiringEligibility({
    caseDoc,
    ownerAuthorized,
    targetSelected,
    partiesBlocked,
    paralegalApproved: String(target?.role || "").toLowerCase() === "paralegal" && String(target?.status || "").toLowerCase() === "approved",
    paralegalPayoutSetupReady: payoutSetupReady,
    paymentMethodSaved: paymentSaved,
  });
  const workspace = evaluateWorkspaceAccess({ caseDoc, viewerId: attorneyId, viewerRole: "attorney" });
  const messaging = evaluateMessagingPermission({
    caseDoc,
    viewerId: attorneyId,
    viewerRole: "attorney",
    partiesBlocked,
  });
  const completion = evaluateCompletionEligibility({ caseDoc, ownerAuthorized });
  const termination = evaluateTerminationEligibility({ caseDoc, ownerAuthorized, adminAuthorized: false });
  const withdrawal = evaluateWithdrawalAndRelist({ caseDoc });
  const archive = evaluateArchiveReadiness({ caseDoc, storageChecked: false });

  return {
    available: true,
    caseId: String(caseDoc._id),
    title: String(caseDoc.title || "Untitled matter"),
    status: normalizeCaseStatus(caseDoc.status),
    targetParalegalSelected: targetSelected,
    paymentMethod: {
      evidenceState: paymentMethod.evidenceState,
      saved: paymentSaved,
      source: String(paymentMethod.source || ""),
    },
    workflows: {
      invitation,
      preEngagement,
      hiring,
      workspace,
      messaging,
      completion,
      termination,
      withdrawalDecision: withdrawal.decision,
      relist: withdrawal.relist,
      archive,
    },
  };
}

async function executeAuthorizedSupportManagerTool(name, args = {}, context = {}) {
  const role = normalizeRole(context.user);
  if (!(ROLE_TOOL_NAMES[role] || []).includes(name)) {
    return { ok: false, error: "tool_not_available_for_role" };
  }

  switch (name) {
    case "search_lpc_knowledge": {
      const results = await retrieveSupportKnowledge({ query: String(args.query || ""), role, limit: 3 });
      return { ok: true, found: results.length > 0, results: sanitizeKnowledgeResults(results) };
    }
    case "get_my_case_overview":
      return { ok: true, ...(await getMyCaseOverview(context.user, String(args.status_scope || "all"))) };
    case "get_case_details":
      return {
        ok: true,
        ...(await getCaseDetails({
          user: context.user,
          caseReference: args.case_reference,
          pageContext: context.pageContext,
          previousState: context.conversationState,
          conversationHistory: context.conversationHistory,
        })),
      };
    case "get_attorney_case_financials":
      return {
        ok: true,
        ...(await getAttorneyCaseFinancials({
          user: context.user,
          caseReference: args.case_reference,
          pageContext: context.pageContext,
          previousState: context.conversationState,
          conversationHistory: context.conversationHistory,
        })),
      };
    case "get_attorney_case_workspace":
      return {
        ok: true,
        ...(await getAttorneyCaseWorkspace({
          user: context.user,
          caseReference: args.case_reference,
          pageContext: context.pageContext,
          previousState: context.conversationState,
          conversationHistory: context.conversationHistory,
        })),
      };
    case "get_attorney_receipt_history":
      return { ok: true, ...(await getAttorneyReceiptHistory(context.user)) };
    case "get_attorney_account_snapshot":
      return { ok: true, ...(await getAttorneyAccountSnapshot(context.user)) };
    case "get_next_deadline":
      return { ok: true, ...sanitizeCaseSnapshot(await getNextCaseDeadlineSnapshot(context.user)) };
    case "get_pending_paralegal_activity":
      return {
        ok: true,
        ...sanitizePendingParalegalSnapshot(await getAttorneyPendingParalegalSnapshot(context.user)),
      };
    case "get_attorney_application_activity":
      return { ok: true, ...(await getAttorneyApplicationActivity(context.user)) };
    case "get_attorney_message_activity":
      return { ok: true, ...(await getAttorneyMessageActivity(context.user)) };
    case "get_attorney_attention_summary":
      return { ok: true, ...(await getAttorneyAttentionSummary(context.user)) };
    case "get_billing_snapshot":
      return {
        ok: true,
        ...(await getBillingMethodSnapshot(context.user, { ...context.pageContext, supportCategory: "payment" })),
      };
    case "get_attorney_workflow_readiness":
      return {
        ok: true,
        ...(await getAttorneyWorkflowReadiness(context.user, context.pageContext)),
      };
    case "get_attorney_matter_readiness":
      return {
        ok: true,
        ...(await getAttorneyMatterReadiness({
          user: context.user,
          caseReference: args.case_reference,
          pageContext: context.pageContext,
          previousState: context.conversationState,
          conversationHistory: context.conversationHistory,
        })),
      };
    case "get_attorney_billing_summary":
      return { ok: true, ...(await getAttorneyBillingSummary(context.user)) };
    case "get_attorney_deactivation_eligibility":
      return { ok: true, ...(await getAttorneyDeactivationEligibility(context.user)) };
    case "get_payout_snapshot": {
      const [payout, stripe] = await Promise.all([
        getPayoutSnapshot(context.user, context.pageContext),
        getStripeConnectSnapshot(context.user),
      ]);
      return {
        ok: true,
        payout: sanitizePayoutSnapshot(payout),
        stripe: {
          connected: stripe.connected === true,
          onboardingComplete: stripe.onboardingComplete === true,
          payoutsEnabled: stripe.payoutsEnabled === true,
          blockers: stripe.blockers || [],
          nextSteps: stripe.nextSteps || [],
        },
      };
    }
    case "get_messaging_state": {
      const resolution = await resolveCaseForTool({
        user: context.user,
        caseReference: buildContextualCaseReference(args.case_reference, context.conversationHistory),
        pageContext: context.pageContext,
        previousState: context.conversationState,
        task: "TROUBLESHOOT",
      });
      const caseId = resolution.caseId;
      if (!caseId) return { ok: true, ...buildCaseClarification(resolution) };
      const toolPageContext = { ...context.pageContext, caseId, supportCategory: "messaging" };
      const caseSnapshot = await getCaseSnapshot(context.user, toolPageContext);
      return {
        ok: true,
        case: sanitizeCaseSnapshot(caseSnapshot),
        messaging: sanitizeMessagingSnapshot(
          await getMessagingSnapshot(context.user, toolPageContext, { caseSnapshot })
        ),
      };
    }
    case "find_navigation_destination":
      return { ok: true, ...getNavigationDestination(role, args.destination) };
    default:
      return { ok: false, error: "unknown_tool" };
  }
}

async function executeSupportManagerTool(name, args = {}, context = {}) {
  const role = normalizeRole(context.user);
  if (!(ROLE_TOOL_NAMES[role] || []).includes(name)) {
    return withToolEvidence(name, { ok: false, error: "tool_not_available_for_role" }, args);
  }
  const validation = validateToolArguments(name, args);
  if (!validation.valid) {
    return withToolEvidence(name, { ok: false, ...validation }, args);
  }
  try {
    return withToolEvidence(name, await executeAuthorizedSupportManagerTool(name, args, context), args);
  } catch (_error) {
    return withToolEvidence(name, {
      ok: false,
      available: false,
      error: "tool_execution_failed",
      retryable: true,
    }, args);
  }
}

module.exports = {
  executeSupportManagerTool,
  getAttorneyApplicationActivity,
  getAttorneyAccountSnapshot,
  getAttorneyBillingSummary,
  getAttorneyCaseFinancials,
  getAttorneyCaseWorkspace,
  getAttorneyDeactivationEligibility,
  getAttorneyMatterReadiness,
  getAttorneyReceiptHistory,
  getAttorneyAttentionSummary,
  getAttorneyWorkflowReadiness,
  getAttorneyMessageActivity,
  getMyCaseOverview,
  getNavigationDestination,
  getSupportManagerToolDefinitions,
  validateToolArguments,
};
