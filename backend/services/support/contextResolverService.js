const mongoose = require("mongoose");

const Case = require("../../models/Case");
const Message = require("../../models/Message");
const Payout = require("../../models/Payout");
const User = require("../../models/User");
const stripe = require("../../utils/stripe");
const { normalizeCaseStatus } = require("../../utils/caseState");
const { BLOCKED_MESSAGE, isBlockedBetween } = require("../../utils/blocks");
const {
  EVIDENCE_STATES,
  evaluateWorkspaceAccess,
} = require("../attorneyWorkflowPolicy");

const SUPPORT_CASE_FIELDS = [
  "_id",
  "title",
  "practiceArea",
  "status",
  "tasks",
  "tasksLocked",
  "files",
  "updatedAt",
  "createdAt",
  "deadline",
  "pausedReason",
  "readOnly",
  "paralegalAccessRevokedAt",
  "escrowIntentId",
  "escrowStatus",
  "paymentReleased",
  "paidOutAt",
  "completedAt",
  "archived",
  "archiveReadyAt",
  "archiveZipKey",
  "archiveDownloadedAt",
  "purgeScheduledFor",
  "purgedAt",
  "disputeDeadlineAt",
  "payoutFinalizedAt",
  "payoutFinalizedType",
  "partialPayoutAmount",
  "remainingAmount",
  "relistPending",
  "relistRequestedAt",
  "terminationStatus",
  "terminationReason",
  "terminationRequestedAt",
  "zoomLink",
  "moderationStatus",
  "moderationFlaggedAt",
  "moderationResolutionRequestedAt",
  "disputes",
  "currency",
  "totalAmount",
  "lockedTotalAmount",
  "amountLockedAt",
  "paymentIntentId",
  "feeAttorneyPct",
  "feeAttorneyAmount",
  "feeParalegalPct",
  "feeParalegalAmount",
  "disputeSettlement",
  "attorney",
  "attorneyId",
  "paralegal",
  "paralegalId",
  "pendingParalegalId",
  "pendingParalegalInvitedAt",
  "withdrawnParalegalId",
  "invites",
  "preEngagement",
  "applicants",
  "hiredAt",
].join(" ");

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value._id) return String(value._id);
    if (value.id) return String(value.id);
  }
  return String(value);
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function tokenizeSupportText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry.length >= 3)
    .filter((entry) => !new Set([
      "the",
      "this",
      "that",
      "case",
      "matter",
      "workspace",
      "messages",
      "message",
      "status",
      "find",
      "open",
      "help",
      "with",
      "for",
      "about",
      "please",
    ]).has(entry));
}

function formatPersonName(user = {}) {
  const first = String(user?.firstName || "").trim();
  const last = String(user?.lastName || "").trim();
  return `${first} ${last}`.trim();
}

function isObjectId(value) {
  return Boolean(value) && mongoose.isValidObjectId(String(value));
}

function inferViewName(pageContext = {}) {
  const explicit = String(pageContext.viewName || "").trim();
  if (explicit) return explicit;

  const pathname = String(pageContext.pathname || "").toLowerCase();
  const hash = String(pageContext.hash || "").toLowerCase();

  if (pathname.includes("profile-settings")) return "profile-settings";
  if (pathname.includes("create-case")) return "create-case";
  if (pathname.includes("dashboard-attorney")) {
    if (hash.includes("billing")) return "billing";
    return "dashboard-attorney";
  }
  if (pathname.includes("dashboard-paralegal")) return "dashboard-paralegal";
  if (pathname.includes("message")) return "messages";
  if (pathname.includes("billing")) return "billing";
  if (pathname.includes("case") || pageContext.caseId) return "case-detail";
  return pathname ? pathname.split("/").pop().replace(/\.html$/i, "") : "";
}

function buildBaseCaseSnapshot(overrides = {}) {
  return {
    requestedCaseId: "",
    caseId: "",
    found: false,
    accessible: false,
    roleOnCase: "",
    reason: "no_case_context",
    title: "",
    status: "",
    normalizedStatus: "",
    pausedReason: "",
    deadline: null,
    readOnly: false,
    paralegalAccessRevokedAt: null,
    paymentReleased: false,
    paidOutAt: null,
    payoutFinalizedAt: null,
    payoutFinalizedType: "",
    partialPayoutAmount: 0,
    escrowStatus: "",
    currency: "",
    preEngagementStatus: "",
    blockers: [],
    nextSteps: [],
    caseDoc: null,
    inferred: false,
    inferenceSource: "",
    clarificationNeeded: false,
    clarificationPrompt: "",
    ...overrides,
  };
}

function buildCaseSnapshotFromDoc(caseDoc, user, overrides = {}) {
  const roleOnCase = getRoleOnCase(caseDoc, user);
  const accessible = canAccessCase(caseDoc, user);
  const blockers = [];
  const nextSteps = [];

  if (!accessible) {
    blockers.push("case_access_denied");
    nextSteps.push("If this is a different case, tell me which one. If not, I can send this to the team for review.");
  }
  if (roleOnCase === "withdrawn_paralegal") {
    blockers.push("withdrawn_from_case");
  }

  return buildBaseCaseSnapshot({
    requestedCaseId: String(overrides.requestedCaseId || ""),
    caseId: String(caseDoc._id),
    found: true,
    accessible,
    roleOnCase,
    reason: accessible ? "" : "access_denied",
    title: String(caseDoc.title || ""),
    status: String(caseDoc.status || ""),
    normalizedStatus: normalizeCaseStatus(caseDoc.status),
    pausedReason: String(caseDoc.pausedReason || ""),
    deadline: asDate(caseDoc.deadline),
    readOnly: caseDoc.readOnly === true,
    paralegalAccessRevokedAt: asDate(caseDoc.paralegalAccessRevokedAt),
    paymentReleased: caseDoc.paymentReleased === true,
    paidOutAt: asDate(caseDoc.paidOutAt),
    payoutFinalizedAt: asDate(caseDoc.payoutFinalizedAt),
    payoutFinalizedType: String(caseDoc.payoutFinalizedType || ""),
    partialPayoutAmount: Number(caseDoc.partialPayoutAmount || 0),
    escrowStatus: String(caseDoc.escrowStatus || ""),
    currency: String(caseDoc.currency || "USD"),
    preEngagementStatus: String(caseDoc.preEngagement?.status || ""),
    blockers: uniqueStrings(blockers),
    nextSteps: uniqueStrings(nextSteps),
    caseDoc,
    ...overrides,
  });
}

function getRoleOnCase(caseDoc, user) {
  const userId = normalizeId(user?._id || user?.id);
  const role = String(user?.role || "").toLowerCase();
  if (!userId) return "";
  if (role === "admin") return "admin";

  const attorneyId = normalizeId(caseDoc?.attorneyId || caseDoc?.attorney);
  const paralegalId = normalizeId(caseDoc?.paralegalId || caseDoc?.paralegal);
  const withdrawnParalegalId = normalizeId(caseDoc?.withdrawnParalegalId);

  if (attorneyId && attorneyId === userId) return "attorney";
  if (paralegalId && paralegalId === userId) return "paralegal";
  if (withdrawnParalegalId && withdrawnParalegalId === userId) return "withdrawn_paralegal";
  return "";
}

function canAccessCase(caseDoc, user) {
  const roleOnCase = getRoleOnCase(caseDoc, user);
  return roleOnCase === "admin" || roleOnCase === "attorney" || roleOnCase === "paralegal";
}

function buildUserCaseParticipantQuery(user = {}) {
  const role = String(user?.role || "").toLowerCase();
  const userId = normalizeId(user?._id || user?.id);
  if (!userId) return null;
  if (role === "admin") return null;
  if (role === "attorney") {
    return {
      $or: [{ attorney: userId }, { attorneyId: userId }],
    };
  }
  if (role === "paralegal") {
    return {
      $or: [{ paralegal: userId }, { paralegalId: userId }, { withdrawnParalegalId: userId }],
    };
  }
  return null;
}

function getLikelyMessagingInference(caseDoc, user) {
  const roleOnCase = getRoleOnCase(caseDoc, user);
  const normalizedStatus = normalizeCaseStatus(caseDoc?.status);
  const workspaceGate = resolveWorkspaceGate(caseDoc, user);
  if (workspaceGate.canUseWorkspace === true) {
    return {
      weight: 4,
      inferenceSource: "recent_active_case",
    };
  }
  if (roleOnCase === "withdrawn_paralegal" || caseDoc?.paralegalAccessRevokedAt) {
    return {
      weight: 3,
      inferenceSource: "recent_access_change_case",
    };
  }
  if (!["completed", "closed", "disputed"].includes(normalizedStatus)) {
    return {
      weight: 2,
      inferenceSource: "recent_open_case",
    };
  }
  return {
    weight: 1,
    inferenceSource: "recently_updated_case",
  };
}

function getLikelySupportCaseInference(caseDoc, user) {
  const roleOnCase = getRoleOnCase(caseDoc, user);
  const normalizedStatus = normalizeCaseStatus(caseDoc?.status);
  const workspaceGate = resolveWorkspaceGate(caseDoc, user);

  if (workspaceGate.canUseWorkspace === true) {
    return {
      weight: 4,
      inferenceSource: "recent_active_case",
    };
  }
  if (["in progress", "active"].includes(normalizedStatus)) {
    return {
      weight: 3,
      inferenceSource: "recent_in_progress_case",
    };
  }
  if (roleOnCase === "withdrawn_paralegal" || caseDoc?.paralegalAccessRevokedAt) {
    return {
      weight: 2,
      inferenceSource: "recent_access_change_case",
    };
  }
  return {
    weight: 1,
    inferenceSource: "recently_updated_case",
  };
}

async function inferCaseForMessaging(user = {}) {
  const query = buildUserCaseParticipantQuery(user);
  if (!query) {
    return {
      caseDoc: null,
      inferenceSource: "",
      candidateCount: 0,
    };
  }

  const candidates = await Case.find(query)
    .select(SUPPORT_CASE_FIELDS)
    .sort({ updatedAt: -1, hiredAt: -1, createdAt: -1, _id: -1 })
    .limit(8)
    .lean();

  if (!candidates.length) {
    return {
      caseDoc: null,
      inferenceSource: "",
      candidateCount: 0,
    };
  }

  const ranked = candidates
    .map((caseDoc) => ({
      caseDoc,
      ...getLikelyMessagingInference(caseDoc, user),
      updatedAt: asDate(caseDoc.updatedAt) || asDate(caseDoc.createdAt) || new Date(0),
    }))
    .sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight;
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    });

  return {
    caseDoc: ranked[0]?.caseDoc || null,
    inferenceSource: ranked[0]?.inferenceSource || "",
    candidateCount: candidates.length,
  };
}

async function inferCaseForSupport(user = {}) {
  const query = buildUserCaseParticipantQuery(user);
  if (!query) {
    return {
      caseDoc: null,
      inferenceSource: "",
      candidateCount: 0,
    };
  }

  const candidates = await Case.find(query)
    .select(SUPPORT_CASE_FIELDS)
    .sort({ updatedAt: -1, hiredAt: -1, createdAt: -1, _id: -1 })
    .limit(8)
    .lean();

  if (!candidates.length) {
    return {
      caseDoc: null,
      inferenceSource: "",
      candidateCount: 0,
    };
  }

  const ranked = candidates
    .map((caseDoc) => ({
      caseDoc,
      ...getLikelySupportCaseInference(caseDoc, user),
      updatedAt: asDate(caseDoc.updatedAt) || asDate(caseDoc.createdAt) || new Date(0),
    }))
    .sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight;
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    });

  return {
    caseDoc: ranked[0]?.caseDoc || null,
    inferenceSource: ranked[0]?.inferenceSource || "",
    candidateCount: candidates.length,
  };
}

async function resolveSupportCaseEntity({
  user = {},
  message = "",
  pageContext = {},
  previousState = {},
  task = "",
} = {}) {
  const requestedCaseId = String(pageContext.caseId || "").trim();
  if (requestedCaseId && isObjectId(requestedCaseId)) {
    const caseDoc = await Case.findById(requestedCaseId).select(SUPPORT_CASE_FIELDS).lean();
    if (caseDoc && canAccessCase(caseDoc, user)) {
      return {
        caseId: String(caseDoc._id),
        caseDoc,
        source: "page_context",
      };
    }
    return {
      caseId: "",
      caseDoc: null,
      source: "page_context",
      found: Boolean(caseDoc),
      reason: caseDoc ? "access_denied" : "case_not_found",
    };
  }

  const previousCaseId = normalizeId(previousState?.activeEntity?.id || "");
  const messageText = String(message || "").trim();
  const isReferential = /^(?:and\s+)?(?:it|that|this|there|both|yes|no|why|how much|same one|same case|same matter)[?.!\s]*$/i.test(
    messageText
  );
  const previousName = String(previousState?.activeEntity?.name || "").trim().toLowerCase();
  const referenceMatchesMemory = Boolean(previousName && messageText.toLowerCase().includes(previousName));
  const shouldResolveByName =
    previousState?.awaiting === "case" ||
    /\b(case|matter|workspace)\b/i.test(messageText) ||
    tokenizeSupportText(messageText).length >= 1;

  if (shouldResolveByName) {
    const query = buildUserCaseParticipantQuery(user);
    if (query) {
      const candidates = await Case.find(query)
        .select(SUPPORT_CASE_FIELDS)
        .sort({ updatedAt: -1, hiredAt: -1, createdAt: -1, _id: -1 })
        .limit(12)
        .lean();
      const tokens = tokenizeSupportText(messageText);

      const ranked = candidates
        .map((caseDoc) => {
          const haystack = String(caseDoc.title || "").toLowerCase();
          const tokenMatches = tokens.filter((token) => haystack.includes(token)).length;
          return { caseDoc, tokenMatches };
        })
        .filter((entry) => entry.tokenMatches > 0)
        .sort((left, right) => {
          if (right.tokenMatches !== left.tokenMatches) return right.tokenMatches - left.tokenMatches;
          return (asDate(right.caseDoc.updatedAt)?.getTime() || 0) - (asDate(left.caseDoc.updatedAt)?.getTime() || 0);
        });

      const topScore = ranked[0]?.tokenMatches || 0;
      const topMatches = ranked.filter((entry) => entry.tokenMatches === topScore);
      if (topMatches.length === 1 && ranked[0]?.caseDoc) {
        return {
          caseId: String(ranked[0].caseDoc._id),
          caseDoc: ranked[0].caseDoc,
          source: "case_name_match",
        };
      }
      if (topMatches.length > 1) {
        return {
          caseId: "",
          caseDoc: null,
          source: "ambiguous_case_name",
          reason: "case_reference_ambiguous",
          candidates: topMatches.slice(0, 3).map((entry) => ({
            id: String(entry.caseDoc._id),
            title: String(entry.caseDoc.title || "Untitled matter"),
          })),
        };
      }
    }
  }

  if (
    previousCaseId &&
    task !== "NAVIGATION" &&
    isObjectId(previousCaseId) &&
    previousState?.correctionAmbiguous !== true &&
    previousState?.subjectChanged !== true &&
    (isReferential || referenceMatchesMemory || previousState?.correctionReference === true)
  ) {
    const caseDoc = await Case.findById(previousCaseId).select(SUPPORT_CASE_FIELDS).lean();
    if (caseDoc && canAccessCase(caseDoc, user)) {
      return {
        caseId: String(caseDoc._id),
        caseDoc,
        source: "memory",
      };
    }
  }

  if (task === "TROUBLESHOOT" && previousState?.authoritativeManager !== true) {
    const inferred = await inferCaseForMessaging(user);
    if (inferred.caseDoc) {
      return {
        caseId: String(inferred.caseDoc._id),
        caseDoc: inferred.caseDoc,
        source: inferred.inferenceSource || "inferred_case",
      };
    }
  }

  if (task === "FACT_LOOKUP" && previousState?.authoritativeManager !== true) {
    const inferred = await inferCaseForSupport(user);
    if (inferred.caseDoc) {
      return {
        caseId: String(inferred.caseDoc._id),
        caseDoc: inferred.caseDoc,
        source: inferred.inferenceSource || "inferred_case",
      };
    }
  }

  return {
    caseId: null,
    caseDoc: null,
    source: "",
  };
}

function getOtherParticipantId(caseDoc, user) {
  const role = String(user?.role || "").toLowerCase();
  if (role === "attorney") {
    return normalizeId(caseDoc?.paralegalId || caseDoc?.paralegal);
  }
  if (role === "paralegal") {
    return normalizeId(caseDoc?.attorneyId || caseDoc?.attorney);
  }
  return "";
}

async function refreshStripeAccountSnapshot(accountId) {
  if (!accountId) return null;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripe?.accounts?.retrieve) return null;

  try {
    const account = await stripe.accounts.retrieve(accountId, {
      expand: ["external_accounts"],
    });
    const externalAccounts = account?.external_accounts?.data || [];
    const primaryBank = externalAccounts.find((entry) => entry?.object === "bank_account") || externalAccounts[0] || null;
    return {
      source: "live",
      detailsSubmitted: !!account?.details_submitted,
      chargesEnabled: !!account?.charges_enabled,
      payoutsEnabled: !!account?.payouts_enabled,
      connected: !!account?.details_submitted && !!account?.payouts_enabled,
      bankName: String(primaryBank?.bank_name || ""),
      bankLast4: String(primaryBank?.last4 || ""),
    };
  } catch (_error) {
    return null;
  }
}

async function getStripeConnectSnapshot(user = {}) {
  const stored = {
    source: "stored",
    accountId: String(user?.stripeAccountId || ""),
    onboardingComplete: user?.stripeOnboarded === true,
    chargesEnabled: user?.stripeChargesEnabled === true,
    payoutsEnabled: user?.stripePayoutsEnabled === true,
    detailsSubmitted: user?.stripeOnboarded === true,
    connected: user?.stripeOnboarded === true && user?.stripePayoutsEnabled === true,
    bankName: "",
    bankLast4: "",
  };

  const live = stored.accountId ? await refreshStripeAccountSnapshot(stored.accountId) : null;
  const snapshot = live
    ? {
        ...stored,
        ...live,
        accountId: stored.accountId,
        onboardingComplete: live.connected,
      }
    : stored;

  const blockers = [];
  const nextSteps = [];

  if (!snapshot.accountId) {
    blockers.push("missing_stripe_account");
    nextSteps.push("Return to Stripe onboarding and complete any remaining identity or bank details.");
  } else {
    if (!snapshot.detailsSubmitted) {
      blockers.push("stripe_details_missing");
      nextSteps.push("Return to Stripe onboarding and complete any remaining identity or bank details.");
    }
    if (!snapshot.chargesEnabled) {
      blockers.push("stripe_charges_disabled");
    }
    if (!snapshot.payoutsEnabled) {
      blockers.push("stripe_payouts_disabled");
      nextSteps.push("Finish any remaining Stripe requirements before payouts can be enabled.");
    }
  }

  return {
    accountId: snapshot.accountId,
    source: snapshot.source,
    onboardingComplete: snapshot.onboardingComplete,
    detailsSubmitted: snapshot.detailsSubmitted,
    chargesEnabled: snapshot.chargesEnabled,
    payoutsEnabled: snapshot.payoutsEnabled,
    connected: snapshot.connected,
    bankName: snapshot.bankName,
    bankLast4: snapshot.bankLast4,
    blockers: uniqueStrings(blockers),
    nextSteps: uniqueStrings(nextSteps),
  };
}

function billingEvidenceState(source = "none", hasMethod = false) {
  if (["lookup_failed", "stripe_unconfigured"].includes(source)) {
    return EVIDENCE_STATES.TEMPORARILY_UNAVAILABLE;
  }
  if (["stored_missing", "live_none"].includes(source)) return EVIDENCE_STATES.ABSENT;
  if (hasMethod) return EVIDENCE_STATES.VERIFIED;
  return EVIDENCE_STATES.UNKNOWN;
}

function normalizeBillingMethodSnapshot(paymentMethod = null, source = "none") {
  const brand = String(paymentMethod?.brand || paymentMethod?.type || "").trim();
  const last4 = String(paymentMethod?.last4 || "").trim();
  const expMonth = Number(paymentMethod?.exp_month || 0) || null;
  const expYear = Number(paymentMethod?.exp_year || 0) || null;
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const isExpired =
    Boolean(expMonth && expYear) && (expYear < currentYear || (expYear === currentYear && expMonth < currentMonth));

  const hasMethod = Boolean(brand || last4 || expMonth || expYear);
  return {
    available: hasMethod,
    evidenceState: billingEvidenceState(source, hasMethod),
    source,
    brand,
    last4,
    exp_month: expMonth,
    exp_year: expYear,
    isExpired,
    isValid: Boolean((brand || last4) && !isExpired),
  };
}

async function getBillingMethodSnapshot(user = {}, pageContext = {}) {
  const visiblePaymentMethod =
    pageContext.paymentMethod && typeof pageContext.paymentMethod === "object" && !Array.isArray(pageContext.paymentMethod)
      ? pageContext.paymentMethod
      : null;
  if (visiblePaymentMethod) {
    return normalizeBillingMethodSnapshot(visiblePaymentMethod, "page_context");
  }

  const role = String(user?.role || "").toLowerCase();
  const shouldCheckStripeCustomer =
    role === "attorney" &&
    (String(pageContext.viewName || "").toLowerCase() === "billing" || String(pageContext.supportCategory || "").toLowerCase() === "payment");
  if (!shouldCheckStripeCustomer) {
    return normalizeBillingMethodSnapshot(null, "none");
  }
  if (!process.env.STRIPE_SECRET_KEY || !stripe?.customers?.retrieve || !stripe?.paymentMethods?.retrieve) {
    return normalizeBillingMethodSnapshot(null, "stripe_unconfigured");
  }

  const customerId = String(user?.stripeCustomerId || "").trim();
  if (!customerId) {
    return normalizeBillingMethodSnapshot(null, "stored_missing");
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    const defaultPmId = customer?.invoice_settings?.default_payment_method;
    if (!defaultPmId) {
      return normalizeBillingMethodSnapshot(null, "live_none");
    }
    const paymentMethod = await stripe.paymentMethods.retrieve(defaultPmId);
    const card = paymentMethod?.card || paymentMethod || null;
    return normalizeBillingMethodSnapshot(
      {
        type: paymentMethod?.type || "",
        brand: card?.brand || "",
        last4: card?.last4 || "",
        exp_month: card?.exp_month || null,
        exp_year: card?.exp_year || null,
      },
      "live"
    );
  } catch (_error) {
    return normalizeBillingMethodSnapshot(null, "lookup_failed");
  }
}

async function getCaseParticipantSnapshot(caseSnapshot = null) {
  const caseDoc = caseSnapshot?.caseDoc || null;
  const attorneyId = normalizeId(caseDoc?.attorneyId || caseDoc?.attorney);
  const paralegalId = normalizeId(caseDoc?.paralegalId || caseDoc?.paralegal);
  const participantIds = uniqueStrings([attorneyId, paralegalId]).filter((value) => isObjectId(value));

  if (!participantIds.length) {
    return {
      attorney: { id: attorneyId, name: "", email: "", present: false },
      paralegal: { id: paralegalId, name: "", email: "", present: false },
    };
  }

  const users = await User.find({ _id: { $in: participantIds } })
    .select("_id firstName lastName email")
    .lean();
  const byId = new Map(users.map((entry) => [String(entry._id), entry]));

  const buildParticipant = (participantId = "") => {
    const user = byId.get(String(participantId || ""));
    return {
      id: String(participantId || ""),
      name: user ? formatPersonName(user) : "",
      email: String(user?.email || ""),
      present: Boolean(participantId),
    };
  };

  return {
    attorney: buildParticipant(attorneyId),
    paralegal: buildParticipant(paralegalId),
  };
}

async function getCaseSnapshot(user = {}, pageContext = {}) {
  const requestedCaseId = String(pageContext.caseId || "").trim();
  const supportCategory = String(pageContext.supportCategory || "").trim().toLowerCase();
  if (!requestedCaseId) {
    if (pageContext.supportCategory === "messaging") {
      const inferred = await inferCaseForMessaging(user);
      if (inferred.caseDoc) {
        return buildCaseSnapshotFromDoc(inferred.caseDoc, user, {
          inferred: true,
          inferenceSource: inferred.inferenceSource,
        });
      }
      return buildBaseCaseSnapshot({
        clarificationNeeded: true,
        clarificationPrompt: "Is this happening in a specific case or across all messages?",
      });
    }
    if (["case_posting", "workspace_access"].includes(supportCategory)) {
      const inferred = await inferCaseForSupport(user);
      if (inferred.caseDoc) {
        return buildCaseSnapshotFromDoc(inferred.caseDoc, user, {
          inferred: true,
          inferenceSource: inferred.inferenceSource,
        });
      }
    }
    return buildBaseCaseSnapshot();
  }

  if (!isObjectId(requestedCaseId)) {
    return buildBaseCaseSnapshot({
      requestedCaseId,
      reason: "invalid_case_id",
      blockers: ["invalid_case_context"],
      nextSteps: ["Tell me which case this is about, or I can send this to the team for review."],
      clarificationNeeded: pageContext.supportCategory === "messaging",
      clarificationPrompt:
        pageContext.supportCategory === "messaging"
          ? "Is this happening in a specific case or across all messages?"
          : "",
    });
  }

  const caseDoc = await Case.findById(requestedCaseId).select(SUPPORT_CASE_FIELDS).lean();
  if (!caseDoc) {
    return buildBaseCaseSnapshot({
      requestedCaseId,
      reason: "case_not_found",
      blockers: ["case_not_found"],
      nextSteps: ["Tell me the case title or the other participant's name if this is the wrong case."],
      clarificationNeeded: pageContext.supportCategory === "messaging",
      clarificationPrompt:
        pageContext.supportCategory === "messaging"
          ? "Is this happening in a specific case or across all messages?"
          : "",
    });
  }

  return buildCaseSnapshotFromDoc(caseDoc, user, {
    requestedCaseId,
  });
}

async function getNextCaseDeadlineSnapshot(user = {}) {
  const role = String(user?.role || "").toLowerCase();
  const userId = normalizeId(user?._id || user?.id);
  if (!userId || !["attorney", "paralegal"].includes(role)) {
    return buildBaseCaseSnapshot({ reason: "deadline_not_available_for_role" });
  }

  const participantQuery =
    role === "attorney"
      ? { $or: [{ attorney: userId }, { attorneyId: userId }] }
      : { $or: [{ paralegal: userId }, { paralegalId: userId }] };
  const caseDoc = await Case.findOne({
    ...participantQuery,
    deadline: { $gte: new Date() },
    archived: { $ne: true },
    status: { $nin: ["completed", "closed", "cancelled", "canceled", "archived"] },
  })
    .select(SUPPORT_CASE_FIELDS)
    .sort({ deadline: 1, updatedAt: -1, _id: 1 })
    .lean();

  if (!caseDoc) {
    return buildBaseCaseSnapshot({ reason: "no_upcoming_deadline" });
  }
  return buildCaseSnapshotFromDoc(caseDoc, user, {
    requestedCaseId: String(caseDoc._id),
    inferred: true,
    inferenceSource: "next_upcoming_deadline",
  });
}

async function getAttorneyPendingParalegalSnapshot(user = {}) {
  const role = String(user?.role || "").toLowerCase();
  const userId = normalizeId(user?._id || user?.id);
  if (role !== "attorney" || !userId) {
    return {
      available: false,
      checkedCaseCount: 0,
      pendingCaseCount: 0,
      totalPendingSignals: 0,
      items: [],
      reason: "attorney_access_required",
    };
  }

  const cases = await Case.find({
    $or: [{ attorney: userId }, { attorneyId: userId }],
    archived: { $ne: true },
    status: { $nin: ["completed", "closed"] },
  })
    .select(SUPPORT_CASE_FIELDS)
    .sort({ deadline: 1, updatedAt: -1, _id: 1 })
    .lean();
  const caseIds = cases.map((caseDoc) => caseDoc._id).filter(Boolean);
  const latestMessages = caseIds.length
    ? await Message.aggregate([
        {
          $match: {
            caseId: { $in: caseIds },
            deleted: { $ne: true },
            type: { $ne: "system" },
          },
        },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $group: {
            _id: "$caseId",
            senderRole: { $first: "$senderRole" },
            senderId: { $first: "$senderId" },
            createdAt: { $first: "$createdAt" },
          },
        },
      ])
    : [];
  const latestMessageByCaseId = new Map(latestMessages.map((message) => [String(message._id), message]));

  const items = cases
    .map((caseDoc) => {
      const reasons = [];
      const paralegalId = normalizeId(caseDoc.paralegalId || caseDoc.paralegal);
      const pendingParalegalId = normalizeId(caseDoc.pendingParalegalId);
      const pendingInvites = (caseDoc.invites || []).filter((invite) => String(invite?.status || "").toLowerCase() === "pending");
      const preEngagementStatus = String(caseDoc.preEngagement?.status || "").toLowerCase();
      const latestMessage = latestMessageByCaseId.get(String(caseDoc._id));

      if (["requested", "changes_requested"].includes(preEngagementStatus)) {
        reasons.push("a pre-engagement response");
      }
      if (pendingParalegalId || pendingInvites.length) {
        reasons.push("an invitation response");
      }
      if (
        (paralegalId || pendingParalegalId) &&
        latestMessage &&
        String(latestMessage.senderRole || "").toLowerCase() === "attorney"
      ) {
        reasons.push("a reply to your latest message");
      }

      if (!reasons.length) return null;
      return {
        caseId: String(caseDoc._id),
        title: String(caseDoc.title || "Untitled matter"),
        status: String(caseDoc.status || ""),
        deadline: asDate(caseDoc.deadline),
        reasons: uniqueStrings(reasons),
        incompleteTaskCount: null,
        taskResponsibilityState: "not_represented",
        latestMessageAt: asDate(latestMessage?.createdAt),
      };
    })
    .filter(Boolean);

  return {
    available: true,
    checkedCaseCount: cases.length,
    pendingCaseCount: items.length,
    totalPendingSignals: items.reduce((total, item) => total + item.reasons.length, 0),
    items,
    reason: items.length ? "pending_paralegal_activity_found" : "no_pending_paralegal_activity",
  };
}

function resolveWorkspaceGate(caseDoc, user) {
  if (!caseDoc) {
    return {
      available: null,
      reason: "Case context is missing.",
      blockers: ["no_case_context"],
      nextSteps: ["Tell me whether this is happening in one case or across all messages."],
    };
  }

  const blockers = [];
  const nextSteps = [];
  const normalizedStatus = normalizeCaseStatus(caseDoc.status);
  const role = String(user?.role || "").toLowerCase();
  const workspacePolicy = evaluateWorkspaceAccess({
    caseDoc,
    viewerId: normalizeId(user?._id || user?.id),
    viewerRole: role,
  });

  if (role === "paralegal" && caseDoc.paralegalAccessRevokedAt) {
    blockers.push("workspace_access_revoked");
    nextSteps.push("Send this to the team if you believe workspace access should still be available.");
    return {
      available: false,
      canUseWorkspace: false,
      reason: "Workspace access has been revoked for this case.",
      blockers,
      nextSteps,
      normalizedStatus,
    };
  }

  if (workspacePolicy.blockers.includes("hire_required")) {
    blockers.push("hire_required");
    nextSteps.push("Messaging and workspace access open after a paralegal is hired.");
    return {
      available: false,
      canUseWorkspace: false,
      reason: "Messaging is available after hire",
      blockers,
      nextSteps,
      normalizedStatus,
    };
  }

  if (workspacePolicy.blockers.includes("funding_required")) {
    blockers.push("funding_required");
    nextSteps.push("Workspace access opens once payment is secured and escrow is funded.");
    return {
      available: false,
      canUseWorkspace: false,
      reason: "Work begins once payment is secured.",
      blockers,
      nextSteps,
      normalizedStatus,
    };
  }

  if (workspacePolicy.blockers.includes("workspace_not_active")) {
    if (["completed", "closed", "disputed"].includes(normalizedStatus)) {
      blockers.push("workspace_closed");
      return {
        available: false,
        canUseWorkspace: false,
        reason: "Messaging is closed for this case.",
        blockers,
        nextSteps,
        normalizedStatus,
      };
    }
    blockers.push("workspace_not_active");
    nextSteps.push("Workspace access unlocks once the case is funded and in progress.");
    return {
      available: false,
      canUseWorkspace: false,
      reason: "Messaging unlocks once the case is funded and in progress.",
      blockers,
      nextSteps,
      normalizedStatus,
    };
  }

  if (caseDoc.readOnly && role !== "admin") {
    blockers.push("case_read_only");
    return {
      available: true,
      canUseWorkspace: true,
      reason: "Case is read-only",
      blockers,
      nextSteps,
      normalizedStatus,
    };
  }

  return {
    available: true,
    canUseWorkspace: true,
    reason: "",
    blockers,
    nextSteps,
    normalizedStatus,
  };
}

async function getWorkspaceAccessSnapshot(user = {}, pageContext = {}, caseSnapshot = null) {
  const snapshot = caseSnapshot || (await getCaseSnapshot(user, pageContext));
  if (!snapshot.caseDoc) {
    return {
      available: snapshot.accessible ? null : false,
      canUseWorkspace: false,
      reason: snapshot.reason === "access_denied" ? "Unauthorized case access" : "Case context is missing.",
      blockers: snapshot.blockers || [],
      nextSteps: snapshot.nextSteps || [],
    };
  }
  if (!snapshot.accessible) {
    return {
      available: false,
      canUseWorkspace: false,
      reason: "Unauthorized case access",
      blockers: uniqueStrings([...(snapshot.blockers || []), "case_access_denied"]),
      nextSteps: snapshot.nextSteps || [],
    };
  }
  return resolveWorkspaceGate(snapshot.caseDoc, user);
}

async function getMessagingSnapshot(user = {}, pageContext = {}, { caseSnapshot, workspaceSnapshot } = {}) {
  const snapshot = caseSnapshot || (await getCaseSnapshot(user, pageContext));
  const workspace = workspaceSnapshot || (await getWorkspaceAccessSnapshot(user, pageContext, snapshot));

  if (!snapshot.caseDoc) {
    return {
      available: false,
      canSend: false,
      reason:
        snapshot.reason === "case_not_found"
          ? "Case not found."
          : snapshot.clarificationPrompt || "Is this happening in a specific case or across all messages?",
      isBlocked: false,
      totalMessages: 0,
      lastMessageAt: null,
      inferredCase: false,
      clarificationNeeded: snapshot.clarificationNeeded === true || !snapshot.caseId,
      clarificationPrompt:
        snapshot.clarificationPrompt || "Is this happening in a specific case or across all messages?",
      blockers: snapshot.blockers || ["no_case_context"],
      nextSteps: snapshot.nextSteps || [],
    };
  }

  if (!snapshot.accessible) {
    return {
      available: false,
      canSend: false,
      reason: "Unauthorized case access",
      isBlocked: false,
      totalMessages: 0,
      lastMessageAt: null,
      blockers: uniqueStrings([...(snapshot.blockers || []), "case_access_denied"]),
      nextSteps: snapshot.nextSteps || [],
    };
  }

  const otherId = getOtherParticipantId(snapshot.caseDoc, user);
  const blocked =
    otherId && ["attorney", "paralegal"].includes(String(user?.role || "").toLowerCase())
      ? await isBlockedBetween(normalizeId(user?._id || user?.id), otherId)
      : false;

  if (blocked) {
    return {
      available: false,
      canSend: false,
      reason: BLOCKED_MESSAGE,
      isBlocked: true,
      totalMessages: 0,
      lastMessageAt: null,
      inferredCase: snapshot.inferred === true,
      clarificationNeeded: false,
      clarificationPrompt: "",
      blockers: uniqueStrings([...(workspace.blockers || []), "blocked_pair"]),
      nextSteps: workspace.nextSteps || [],
    };
  }

  const [totalMessages, lastMessage] = await Promise.all([
    Message.countDocuments({
      caseId: snapshot.caseId,
      deleted: { $ne: true },
    }),
    Message.findOne({
      caseId: snapshot.caseId,
      deleted: { $ne: true },
    })
      .sort({ createdAt: -1, _id: -1 })
      .select("createdAt text content type")
      .lean(),
  ]);

  return {
    available: workspace.available !== false,
    canSend: workspace.canUseWorkspace === true && workspace.reason !== "Case is read-only",
    reason: workspace.reason || "",
    isBlocked: false,
    totalMessages,
    lastMessageAt: asDate(lastMessage?.createdAt),
    lastMessagePreview: String(lastMessage?.text || lastMessage?.content || "").slice(0, 160),
    inferredCase: snapshot.inferred === true,
    clarificationNeeded: false,
    clarificationPrompt: "",
    blockers: uniqueStrings(workspace.blockers || []),
    nextSteps: uniqueStrings(workspace.nextSteps || []),
  };
}

async function findRecentRelevantCase(user = {}) {
  const role = String(user?.role || "").toLowerCase();
  const userId = normalizeId(user?._id || user?.id);
  if (!userId) return null;

  const query = role === "admin"
    ? {
        $or: [
          { paymentReleased: true },
          { paidOutAt: { $ne: null } },
          { payoutFinalizedAt: { $ne: null } },
          { status: "completed" },
        ],
      }
    : role === "attorney"
    ? {
        $and: [
          { $or: [{ attorney: userId }, { attorneyId: userId }] },
          {
            $or: [
              { paymentReleased: true },
              { paidOutAt: { $ne: null } },
              { payoutFinalizedAt: { $ne: null } },
              { status: "completed" },
            ],
          },
        ],
      }
    : {
        $and: [
          {
            $or: [
              { paralegal: userId },
              { paralegalId: userId },
              { withdrawnParalegalId: userId },
            ],
          },
          {
            $or: [
              { paymentReleased: true },
              { paidOutAt: { $ne: null } },
              { payoutFinalizedAt: { $ne: null } },
              { status: "completed" },
            ],
          },
        ],
      };

  return Case.findOne(query)
    .select(SUPPORT_CASE_FIELDS)
    .sort({ paidOutAt: -1, payoutFinalizedAt: -1, completedAt: -1, updatedAt: -1 })
    .lean();
}

async function getPayoutSnapshot(user = {}, pageContext = {}, { caseSnapshot, stripeSnapshot } = {}) {
  const role = String(user?.role || "").toLowerCase();
  const caseContext = caseSnapshot || (await getCaseSnapshot(user, pageContext));
  const stripeState = stripeSnapshot || (await getStripeConnectSnapshot(user));
  const relevantCaseDoc =
    caseContext?.caseDoc && caseContext.accessible ? caseContext.caseDoc : await findRecentRelevantCase(user);

  const recentPayout = ["paralegal", "admin"].includes(role)
    ? await Payout.findOne({
        ...(role === "admin" ? {} : { paralegalId: normalizeId(user?._id || user?.id) }),
      })
        .sort({ createdAt: -1, _id: -1 })
        .select("caseId amountPaid transferId stripeMode createdAt")
        .lean()
    : null;

  const blockers = [];
  const nextSteps = [];

  if (role === "paralegal") {
    blockers.push(...(stripeState.blockers || []));
    nextSteps.push(...(stripeState.nextSteps || []));
  }

  if (!relevantCaseDoc && !recentPayout) {
    return {
      role,
      relevantCaseId: "",
      relevantCaseTitle: "",
      hasRecentPayoutActivity: false,
      hasPayoutHistory: false,
      paymentReleased: false,
      paidOutAt: null,
      payoutFinalizedAt: null,
      payoutFinalizedType: "",
      escrowStatus: "",
      recentPayout: null,
      blockers: uniqueStrings(blockers),
      nextSteps: uniqueStrings(nextSteps),
    };
  }

  const relevantCase = relevantCaseDoc || null;
  if (relevantCase && !relevantCase.paymentReleased) {
    if (relevantCase.payoutFinalizedAt) {
      blockers.push("payout_not_released");
    } else {
      blockers.push("no_payment_release_record");
    }
  }

  return {
    role,
    relevantCaseId: relevantCase ? String(relevantCase._id) : String(recentPayout?.caseId || ""),
    relevantCaseTitle: String(relevantCase?.title || ""),
    hasRecentPayoutActivity: Boolean(relevantCase || recentPayout),
    hasPayoutHistory: Boolean(recentPayout),
    paymentReleased: relevantCase?.paymentReleased === true,
    paidOutAt: asDate(relevantCase?.paidOutAt),
    completedAt: asDate(relevantCase?.completedAt),
    payoutFinalizedAt: asDate(relevantCase?.payoutFinalizedAt),
    payoutFinalizedType: String(relevantCase?.payoutFinalizedType || ""),
    partialPayoutAmount: Number(relevantCase?.partialPayoutAmount || 0),
    escrowStatus: String(relevantCase?.escrowStatus || ""),
    recentPayout: recentPayout
      ? {
          caseId: String(recentPayout.caseId || ""),
          amountPaid: Number(recentPayout.amountPaid || 0),
          transferId: String(recentPayout.transferId || ""),
          stripeMode: String(recentPayout.stripeMode || ""),
          createdAt: asDate(recentPayout.createdAt),
        }
      : null,
    blockers: uniqueStrings(blockers),
    nextSteps: uniqueStrings(nextSteps),
  };
}

async function getSupportContextSnapshot({ user = {}, pageContext = {}, category = "" } = {}) {
  const normalizedPageContext = {
    ...pageContext,
    supportCategory: category,
    viewName: inferViewName(pageContext),
  };

  const caseSnapshot = await getCaseSnapshot(user, normalizedPageContext);
  const [stripeState, workspaceState, billingMethodState] = await Promise.all([
    getStripeConnectSnapshot(user),
    getWorkspaceAccessSnapshot(user, normalizedPageContext, caseSnapshot),
    getBillingMethodSnapshot(user, normalizedPageContext),
  ]);
  const [payoutState, messagingState, participantState] = await Promise.all([
    getPayoutSnapshot(user, normalizedPageContext, {
      caseSnapshot,
      stripeSnapshot: stripeState,
    }),
    getMessagingSnapshot(user, normalizedPageContext, {
      caseSnapshot,
      workspaceSnapshot: workspaceState,
    }),
    getCaseParticipantSnapshot(caseSnapshot),
  ]);

  const blockers = uniqueStrings([
    ...(stripeState.blockers || []),
    ...(payoutState.blockers || []),
    ...(caseSnapshot.blockers || []),
    ...(workspaceState.blockers || []),
    ...(messagingState.blockers || []),
  ]);
  const nextSteps = uniqueStrings([
    ...(stripeState.nextSteps || []),
    ...(payoutState.nextSteps || []),
    ...(caseSnapshot.nextSteps || []),
    ...(workspaceState.nextSteps || []),
    ...(messagingState.nextSteps || []),
  ]);

  return {
    category,
    pageContext: normalizedPageContext,
    supportFacts: {
      userRole: String(user?.role || "").toLowerCase() || "unknown",
      billingMethodState,
      participantState,
      stripeState,
      payoutState,
      caseState: {
        requestedCaseId: caseSnapshot.requestedCaseId,
        caseId: caseSnapshot.caseId,
        found: caseSnapshot.found,
        accessible: caseSnapshot.accessible,
        roleOnCase: caseSnapshot.roleOnCase,
        reason: caseSnapshot.reason,
        inferred: caseSnapshot.inferred === true,
        inferenceSource: caseSnapshot.inferenceSource || "",
        clarificationNeeded: caseSnapshot.clarificationNeeded === true,
        clarificationPrompt: caseSnapshot.clarificationPrompt || "",
        title: caseSnapshot.title,
        status: caseSnapshot.status,
        normalizedStatus: caseSnapshot.normalizedStatus,
        pausedReason: caseSnapshot.pausedReason,
        readOnly: caseSnapshot.readOnly,
        paralegalAccessRevokedAt: caseSnapshot.paralegalAccessRevokedAt,
        paymentReleased: caseSnapshot.paymentReleased,
        paidOutAt: caseSnapshot.paidOutAt,
        payoutFinalizedAt: caseSnapshot.payoutFinalizedAt,
        payoutFinalizedType: caseSnapshot.payoutFinalizedType,
        partialPayoutAmount: caseSnapshot.partialPayoutAmount,
        escrowStatus: caseSnapshot.escrowStatus,
        currency: caseSnapshot.currency,
        preEngagementStatus: caseSnapshot.preEngagementStatus,
      },
      workspaceState,
      messagingState,
      blockers,
      nextSteps,
    },
  };
}

module.exports = {
  getAttorneyPendingParalegalSnapshot,
  getBillingMethodSnapshot,
  getNextCaseDeadlineSnapshot,
  getCaseSnapshot,
  getCaseParticipantSnapshot,
  getMessagingSnapshot,
  getPayoutSnapshot,
  resolveSupportCaseEntity,
  getStripeConnectSnapshot,
  getSupportContextSnapshot,
  getWorkspaceAccessSnapshot,
};
