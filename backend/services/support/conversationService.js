const mongoose = require("mongoose");

const Incident = require("../../models/Incident");
const SupportConversation = require("../../models/SupportConversation");
const SupportMessage = require("../../models/SupportMessage");
const SupportTicket = require("../../models/SupportTicket");
const User = require("../../models/User");
const { generateSupportConversationReply } = require("../../ai/supportAgent");
const {
  maybeLogAutonomousIncidentRouting,
  maybeLogAutonomousTicketEscalation,
  maybeLogAutonomousTicketReopen,
} = require("../ai/ccoAutonomyService");
const { linkTicketToIncident, updateTicketStatus } = require("./ticketService");
const {
  getBillingMethodSnapshot,
  getCaseParticipantSnapshot,
  getCaseSnapshot,
  getMessagingSnapshot,
  getPayoutSnapshot,
  getStripeConnectSnapshot,
  getWorkspaceAccessSnapshot,
  resolveSupportCaseEntity,
} = require("./contextResolverService");
const { publishConversationEvent } = require("./liveUpdateService");
const { createIncidentFromSupportSignal } = require("../incidents/intakeService");
const { notifyFounderSupportEngineeringIssue } = require("../incidents/notificationService");
const { publishEventSafe } = require("../lpcEvents/publishEventService");
const { INCIDENT_TERMINAL_STATES } = require("../../utils/incidentConstants");
const {
  findMatchingActiveIncident,
  routeSupportSubmissionEvent,
  startEngineeringDiagnosisForIncident,
  shouldEscalateTicketToIncident,
} = require("../lpcEvents/supportRoutingService");
const { assertCcoAutonomyHarnessEnabled } = require("../../utils/ccoAutonomyHarnessAccess");

const SUPPORT_WELCOME_MESSAGE =
  "Hi — I can help with account questions, payouts, case activity, and platform issues.";
const MANUAL_REVIEW_SENTENCE = "Thanks for letting us know. I'm sending this to the team for review now.";
const ACTIVE_CONVERSATION_STATUSES = ["open", "escalated"];
const OPEN_TICKET_STATUSES = ["open", "in_review", "waiting_on_user", "waiting_on_info"];
const RESOLVED_TICKET_STATUSES = ["resolved", "closed"];
const SUPPORT_CONVERSATION_RETENTION_MS = 1000 * 60 * 60 * 24 * 183;
const SUPPORT_INACTIVITY_RESTART_MS = 1000 * 60 * 60 * 24;
const SUPPORT_RETENTION_PRUNE_INTERVAL_MS = 1000 * 60 * 60 * 6;
const MAX_SOURCE_PAGE_LENGTH = 500;
const MAX_CONTEXT_FIELD_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_REPLY_LENGTH = 12000;
const PROACTIVE_PROMPT_COOLDOWN_MS = 1000 * 60 * 60 * 4;
const RECENT_RESOLVED_PROMPT_WINDOW_MS = 1000 * 60 * 60 * 24 * 14;
const SUPPORT_DOMAIN_TOKENS = Object.freeze([
  "application",
  "applications",
  "apply",
  "browse",
  "case",
  "cases",
  "dashboard",
  "document",
  "documents",
  "file",
  "files",
  "invoice",
  "invoices",
  "matter",
  "matters",
  "message",
  "messages",
  "messaging",
  "paralegal",
  "attorney",
  "payment",
  "payments",
  "payout",
  "payouts",
  "preference",
  "preferences",
  "profile",
  "receipt",
  "receipts",
  "security",
  "setting",
  "settings",
  "stripe",
  "workspace",
]);
const SUPPORT_USER_FIELDS = [
  "_id",
  "email",
  "role",
  "status",
  "firstName",
  "lastName",
  "stripeCustomerId",
  "stripeAccountId",
  "stripeOnboarded",
  "stripeChargesEnabled",
  "stripePayoutsEnabled",
].join(" ");
let lastSupportRetentionPruneAt = 0;

function isSupportConversationInactive(conversation = {}, now = Date.now()) {
  const lastActivityAt = new Date(
    conversation?.lastMessageAt || conversation?.updatedAt || conversation?.createdAt || 0
  ).getTime();
  if (!lastActivityAt) return false;
  return now - lastActivityAt >= SUPPORT_INACTIVITY_RESTART_MS;
}

async function pruneExpiredSupportHistory({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastSupportRetentionPruneAt < SUPPORT_RETENTION_PRUNE_INTERVAL_MS) {
    return;
  }
  lastSupportRetentionPruneAt = now;
  const cutoff = new Date(now - SUPPORT_CONVERSATION_RETENTION_MS);
  const expiredConversations = await SupportConversation.find({
    lastMessageAt: { $lt: cutoff },
  })
    .select("_id")
    .lean();
  if (!expiredConversations.length) return;
  const conversationIds = expiredConversations
    .map((entry) => normalizeId(entry?._id))
    .filter((value) => mongoose.isValidObjectId(value));
  if (!conversationIds.length) return;
  await SupportMessage.deleteMany({ conversationId: { $in: conversationIds } });
  await SupportConversation.deleteMany({ _id: { $in: conversationIds } });
}

async function closeConversationForLifecycleReset(conversation, reason = "") {
  if (!conversation) return null;
  const closedAt = new Date();
  conversation.status = "closed";
  conversation.lastMessageAt = closedAt;
  conversation.metadata = {
    ...(conversation.metadata || {}),
    support: {
      ...(conversation.metadata?.support || {}),
      lifecycleClosedAt: closedAt,
      lifecycleClosedReason: trimString(reason, 80),
    },
  };
  await conversation.save();
  return conversation;
}

function trimString(value, max = MAX_CONTEXT_FIELD_LENGTH) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max).trim() : text;
}

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value._id) return String(value._id);
    if (value.id) return String(value.id);
  }
  return String(value);
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function sanitizePageContext(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const paymentMethod =
    value.paymentMethod && typeof value.paymentMethod === "object" && !Array.isArray(value.paymentMethod)
      ? {
          brand: trimString(value.paymentMethod.brand, 40),
          last4: trimString(value.paymentMethod.last4, 8),
          exp_month: Number(value.paymentMethod.exp_month || 0) || null,
          exp_year: Number(value.paymentMethod.exp_year || 0) || null,
          type: trimString(value.paymentMethod.type, 40),
        }
      : null;
  const next = {
    href: trimString(value.href),
    pathname: trimString(value.pathname, 280),
    search: trimString(value.search, 240),
    hash: trimString(value.hash, 160),
    title: trimString(value.title, 220),
    label: trimString(value.label || value.pageLabel, 180),
    viewName: trimString(value.viewName, 120),
    roleHint: trimString(value.roleHint, 80),
    caseId: trimString(value.caseId, 80),
    jobId: trimString(value.jobId, 80),
    applicationId: trimString(value.applicationId, 80),
    recentViewName: trimString(value.recentViewName, 120),
  };
  const normalized = Object.fromEntries(Object.entries(next).filter(([, entry]) => entry));
  const repeatViewCount = Number(value.repeatViewCount || 0) || 0;
  const supportOpenCount = Number(value.supportOpenCount || 0) || 0;
  if (paymentMethod && (paymentMethod.last4 || paymentMethod.brand || paymentMethod.exp_month || paymentMethod.exp_year)) {
    normalized.paymentMethod = paymentMethod;
  }
  if (repeatViewCount > 0) normalized.repeatViewCount = Math.min(repeatViewCount, 20);
  if (supportOpenCount > 0) normalized.supportOpenCount = Math.min(supportOpenCount, 20);
  return normalized;
}

function deriveSourcePage(pageContext = {}, fallback = "") {
  const pathname = trimString(pageContext.pathname, 280);
  const search = trimString(pageContext.search, 240);
  const hash = trimString(pageContext.hash, 160);
  if (pathname) {
    return trimString(`${pathname}${search || ""}${hash || ""}`, MAX_SOURCE_PAGE_LENGTH);
  }
  return trimString(
    fallback || pageContext.href || pageContext.label || pageContext.title || "",
    MAX_SOURCE_PAGE_LENGTH
  );
}

function resolveSurface(role = "") {
  const normalized = String(role || "").trim().toLowerCase();
  if (["attorney", "paralegal", "admin"].includes(normalized)) return normalized;
  return "manual";
}

function formatUserFirstName(user = {}) {
  return trimString(user.firstName, 80) || trimString(user.lastName, 80);
}

function parseDate(value) {
  if (!value) return null;
  const next = value instanceof Date ? value : new Date(value);
  return Number.isNaN(next.getTime()) ? null : next;
}

function levenshteinDistance(left = "", right = "") {
  const a = String(left || "");
  const b = String(right || "");
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, (_, index) => [index]);
  for (let column = 0; column <= b.length; column += 1) {
    matrix[0][column] = column;
  }

  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function normalizeSupportDomainTypos(value = "") {
  return String(value || "")
    .split(/\s+/)
    .map((rawToken) => {
      const token = String(rawToken || "");
      const core = token.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gi, "");
      const normalizedCore = core.toLowerCase();
      if (!normalizedCore || normalizedCore.length < 4 || SUPPORT_DOMAIN_TOKENS.includes(normalizedCore)) {
        return token;
      }

      let bestMatch = "";
      let bestDistance = Infinity;
      for (const candidate of SUPPORT_DOMAIN_TOKENS) {
        if (Math.abs(candidate.length - normalizedCore.length) > 2) continue;
        const threshold = candidate.length >= 8 ? 2 : 1;
        const distance = levenshteinDistance(normalizedCore, candidate);
        if (distance > threshold) continue;
        if (distance < bestDistance) {
          bestMatch = candidate;
          bestDistance = distance;
        }
      }

      return bestMatch ? token.replace(core, bestMatch) : token;
    })
    .join(" ");
}

function normalizeSupportUserText(value = "") {
  return normalizeSupportDomainTypos(
    String(value || "")
    .replace(/\bwtf\b/gi, "what the fuck")
    .replace(/\bidk\b/gi, "i don't know")
    .replace(/\bim\b/gi, "i'm")
    .replace(/\bive\b/gi, "i've")
    .replace(/\bdidnt\b/gi, "didn't")
    .replace(/\bdoesnt\b/gi, "doesn't")
    .replace(/\bwont\b/gi, "won't")
    .replace(/\bcant\b/gi, "can't")
    .replace(/\bisnt\b/gi, "isn't")
    .replace(/\bhasnt\b/gi, "hasn't")
    .replace(/\bhavent\b/gi, "haven't")
    .replace(/\battny\b/gi, "attorney")
    .replace(/\batty\b/gi, "attorney")
    .replace(/\bpara\b/gi, "paralegal")
    .replace(/\bmsgs\b/gi, "messages")
    .replace(/\bmsg\b/gi, "message")
    .replace(/\s+/g, " ")
    .trim()
  );
}

function cleanSupportIssueLabelText(value = "", category = "") {
  let text = trimString(value, 180);
  if (!text) return "";

  text = normalizeSupportUserText(text)
    .replace(/^(case workflow|payments|messaging|profile updates|payout setup|general support)\s*:\s*/i, "")
    .replace(/^can you (please )?check on my open /i, "")
    .replace(/^can you (please )?check on my /i, "")
    .replace(/^can you (please )?check on /i, "")
    .replace(/^i still need help with my open /i, "")
    .replace(/^i still need help with my /i, "")
    .replace(/^i need help with my open /i, "")
    .replace(/^i need help with my /i, "")
    .replace(/^i need help with /i, "")
    .replace(/^help with my open /i, "")
    .replace(/^help with my /i, "")
    .replace(/^help with /i, "")
    .replace(/^my open /i, "")
    .replace(/^my /i, "")
    .replace(/^open /i, "")
    .replace(/[?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const normalizedCategory = String(category || "").trim().toLowerCase();
  if (!text) return "";
  if (/^a case issue$/i.test(text)) text = "case issue";
  if (/\bsave preferences\b/i.test(text)) return "Save Preferences issue";
  if (normalizedCategory === "profile_save") return "Save Preferences issue";
  if (normalizedCategory === "messaging") return /\bmessage/i.test(text) ? text : "messaging issue";
  if (normalizedCategory === "case_posting") {
    if (
      /^a case issue$/i.test(text) ||
      /^case issue$/i.test(text) ||
      /^case workflow$/i.test(text) ||
      /\bopen a case issue\b/i.test(text) ||
      /\bcase issue\b/i.test(text)
    ) {
      return "case issue";
    }
    if (/\bcase\b|\bmatter\b/i.test(text) && text.split(" ").length <= 6) {
      return "case issue";
    }
  }
  if (normalizedCategory === "payment") return /\bpayout\b/i.test(text) ? "payout issue" : "payment issue";
  return text;
}

function detectFrustrationSignals(text = "") {
  const normalized = String(text || "");
  const lowered = normalized.toLowerCase();
  let score = 0;
  if (/\b(wtf|ridiculous|frustrated|annoyed|angry|furious|this makes no sense)\b/i.test(normalized)) score += 3;
  if (/\b(why is this|still broken|still not working|come on)\b/i.test(normalized)) score += 2;
  if (/!{2,}/.test(normalized)) score += 1;
  if (/\b(asap|right now|immediately)\b/i.test(normalized)) score += 1;
  const sentiment = score >= 3 ? "frustrated" : score >= 1 ? "concerned" : "neutral";
  const escalationPriority = score >= 3 ? "high" : score >= 1 ? "normal" : "normal";
  return {
    sentiment,
    frustrationScore: score,
    escalationPriority,
    needsAcknowledgement: score >= 2,
  };
}

function getConversationContext({ sourcePage = "", pageContext = {} } = {}) {
  const normalizedPageContext = sanitizePageContext(pageContext);
  const normalizedSourcePage = deriveSourcePage(normalizedPageContext, sourcePage);
  return {
    pageContext: normalizedPageContext,
    sourcePage: normalizedSourcePage,
  };
}

function buildConversationUpdate({ user = {}, sourcePage = "", pageContext = {} } = {}) {
  const update = {
    role: String(user.role || "unknown").toLowerCase() || "unknown",
    sourceSurface: resolveSurface(user.role),
  };
  if (sourcePage) update.sourcePage = sourcePage;
  if (Object.keys(pageContext).length) update.pageContext = pageContext;
  return update;
}

async function ensureWelcomeMessage(conversationId) {
  if (!conversationId) return;
  const now = new Date();
  const seededConversation = await SupportConversation.findOneAndUpdate(
    { _id: conversationId, welcomeSentAt: null },
    { $set: { welcomeSentAt: now, lastMessageAt: now } },
    { new: true }
  ).lean();
  if (!seededConversation) return;

  await SupportMessage.create({
    conversationId,
    sender: "assistant",
    text: SUPPORT_WELCOME_MESSAGE,
    metadata: {
      kind: "welcome",
      category: "general",
      categoryLabel: "General support",
      grounded: true,
    },
  });
}

function buildRouting(category = "", urgency = "medium") {
  const priority = urgency === "high" ? "high" : "normal";

  if (category === "payment" || category === "stripe_onboarding") {
    return {
      ownerKey: "payments",
      priority: "high",
      queueLabel: "Payments review",
    };
  }
  if (category === "account_approval") {
    return {
      ownerKey: "admissions",
      priority,
      queueLabel: "Verification review",
    };
  }
  if (category === "login" || category === "password_reset") {
    return {
      ownerKey: "support_ops",
      priority,
      queueLabel: "Account access",
    };
  }
  if (category === "case_posting" || category === "messaging" || category === "dashboard_load") {
    return {
      ownerKey: "support_ops",
      priority,
      queueLabel: "Workflow support",
    };
  }
  return {
    ownerKey: "support_ops",
    priority,
    queueLabel: "General support",
  };
}

function formatCategoryLabel(category = "") {
  const labels = {
    login: "Login",
    password_reset: "Password reset",
    profile_save: "Profile updates",
    profile_photo_upload: "Profile photo",
    dashboard_load: "Dashboard",
    case_posting: "Case workflow",
    messaging: "Messaging",
    payment: "Payments",
    stripe_onboarding: "Payout setup",
    account_approval: "Verification",
    product_guidance: "Product guidance",
    unknown: "General support",
  };
  return labels[category] || "General support";
}

function formatSupportTicketReference(ticketId = "") {
  const id = String(ticketId || "").trim();
  if (!id) return "";
  return `SUP-${id.slice(-6).toUpperCase()}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMoneyCents(value, currency = "USD") {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: String(currency || "USD").toUpperCase(),
  }).format(amount / 100);
}

function normalizeReplyText(value = "") {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function enforceSupportReplyBrevity(reply = "", { category = "", paymentSubIntent = "", detailLevel = "" } = {}) {
  const normalizedReply = normalizeReplyText(reply);
  if (!normalizedReply) return "";
  const normalizedDetailLevel = String(detailLevel || "").trim().toLowerCase();

  let compact = normalizedReply
    .replace(/\s*If you have any specific concerns[^.!?]*[.!?]\s*$/i, "")
    .replace(/\s*Please let me know[^.!?]*[.!?]\s*$/i, "")
    .trim();

  if (normalizedDetailLevel === "expanded") {
    return compact;
  }

  return compact;
}

function stripRedundantNavigationCopy(reply = "", navigation = null) {
  const normalizedReply = normalizeReplyText(reply);
  const label = trimString(navigation?.ctaLabel, 120);
  if (!normalizedReply || !label) return normalizedReply;

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return normalizeReplyText(
    normalizedReply
      .replace(new RegExp(`\\s*Go to ${escapedLabel}\\.?\\s*$`, "i"), "")
      .replace(new RegExp(`\\s*Open ${escapedLabel}\\.?\\s*$`, "i"), "")
  );
}

function addReviewSentence(text = "", needsEscalation = false) {
  if (!needsEscalation) return text;
  if (
    text.includes(MANUAL_REVIEW_SENTENCE) ||
    /\bi['’]m sending this to the team for review\b/i.test(text) ||
    /\bi can send this to the team(?: now)? for review\b/i.test(text) ||
    /\bthe team can review\b/i.test(text)
  ) {
    return text;
  }
  return `${text} ${MANUAL_REVIEW_SENTENCE}`.trim();
}

function stripEscalationConfirmationCopy(text = "") {
  let next = String(text || "");
  if (!next) return "";

  const patterns = [
    /\s*Thanks for letting us know\.\s*I['’]m sending this to the team for review now\.?/gi,
    /\s*If you've already followed up and still haven't heard back,\s*I['’]m sending this to the team for review now\.?/gi,
    /\s*I['’]m sending this to the team for review now\.?/gi,
    /\s*the team can review the thread\.?/gi,
  ];
  patterns.forEach((pattern) => {
    next = next.replace(pattern, "");
  });

  next = next
    .replace(/\s+,/g, ",")
    .replace(/,\s*$/g, ".")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();

  return next || "I've captured the issue details.";
}

function formatCaseTitle(facts = {}) {
  return facts.caseState?.title || facts.payoutState?.relevantCaseTitle || "this case";
}

function hasPatternMatch(text = "", patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

const ADMIN_DASHBOARD_SUPPORT_RULES = Object.freeze([
  {
    key: "overview",
    label: "Overview",
    href: "admin-dashboard.html#overview",
    summary: "Use Overview as your start-here board. It shows what needs attention and links you into the right admin workspace.",
    patterns: [/\boverview\b/i, /\bstart here\b/i, /\bwhere should i start\b/i, /\bwhat should i look at first\b/i],
  },
  {
    key: "approvals",
    label: "Approvals",
    href: "admin-dashboard.html#approvals-workspace",
    summary: "Use Approvals for the review queue and explicit approve or reject decisions.",
    patterns: [/\bapprovals?\b/i, /\breview queue\b/i, /\bpending approvals?\b/i],
  },
  {
    key: "ai-control-room",
    label: "AI Control Room",
    href: "admin-dashboard.html#ai-control-room",
    summary: "Use AI Control Room for the high-level cross-functional summary. It is a monitoring surface, not the main decision queue.",
    patterns: [/\bai control room\b/i, /\bcontrol room\b/i],
  },
  {
    key: "engineering",
    label: "Engineering",
    href: "admin-dashboard.html#engineering",
    summary: "Use Engineering for incident-linked work, CTO context, and engineering review items.",
    patterns: [/\bengineering\b/i, /\bincidents?\b/i, /\bcto\b/i],
  },
  {
    key: "knowledge-studio",
    label: "Knowledge Studio",
    href: "admin-dashboard.html#knowledge-studio",
    summary: "Use Knowledge Studio for governed knowledge records, source sync, and approved memory review.",
    patterns: [/\bknowledge studio\b/i, /\bknowledge\b/i, /\bsources?\b/i],
  },
  {
    key: "marketing-drafts",
    label: "Marketing Drafts",
    href: "admin-dashboard.html#marketing-drafts",
    summary: "Use Marketing Drafts for the founder log, publishing cycle, marketing packets, and ready-to-post work.",
    patterns: [/\bmarketing\b/i, /\bdrafts?\b/i, /\bpublishing\b/i, /\blinkedin\b/i],
  },
  {
    key: "support-ops",
    label: "Support Ops",
    href: "admin-dashboard.html#support-ops",
    summary: "Use Support Ops for the support ticket queue, ticket detail, internal notes, and team replies.",
    patterns: [/\bsupport ops\b/i, /\bsupport queue\b/i, /\bsupport tickets?\b/i, /\bticket queue\b/i],
  },
  {
    key: "sales-workspace",
    label: "Sales Workspace",
    href: "admin-dashboard.html#sales-workspace",
    summary: "Use Sales Workspace for account records, interactions, and sales packet generation.",
    patterns: [/\bsales\b/i, /\boutreach\b/i, /\baccounts?\b/i, /\bprospects?\b/i],
  },
  {
    key: "user-management",
    label: "User Management",
    href: "admin-dashboard.html#user-management",
    summary: "Use User Management for admissions, approved users, bulk outreach, and photo reviews.",
    patterns: [/\buser management\b/i, /\busers?\b/i, /\badmissions?\b/i, /\bphoto reviews?\b/i, /\bprofile photos?\b/i],
  },
  {
    key: "finance",
    label: "Finance",
    href: "admin-dashboard.html#finance",
    summary: "Use Finance for Stripe operations, disputes, revenue, accounting, and payout-related admin work.",
    patterns: [/\bfinance\b/i, /\bstripe\b/i, /\bdisputes?\b/i, /\brevenue\b/i, /\baccounting\b/i, /\bpayouts?\b/i],
  },
  {
    key: "posts",
    label: "Attorney Posts",
    href: "admin-dashboard.html#posts",
    summary: "Use Attorney Posts to moderate attorney-created marketplace posts.",
    patterns: [/\battorney posts?\b/i, /\bposts?\b/i, /\bpost moderation\b/i],
  },
  {
    key: "activity-logs",
    label: "Activity Logs",
    href: "admin-dashboard.html#activity-logs",
    summary: "Use Activity Logs for audit visibility and exports.",
    patterns: [/\bactivity logs?\b/i, /\baudit logs?\b/i, /\blogs?\b/i],
  },
  {
    key: "settings",
    label: "Settings",
    href: "admin-dashboard.html#settings",
    summary: "Use Settings for platform controls and your admin preferences.",
    patterns: [/\bsettings\b/i, /\bpreferences?\b/i, /\btheme\b/i, /\bplatform controls?\b/i],
  },
]);

function hasNavigationLead(text = "") {
  return hasPatternMatch(text, [
    /\bwhere are\b/i,
    /\bwhere do i find\b/i,
    /\bwhere can i find\b/i,
    /\bi can'?t find\b/i,
    /\bi cant find\b/i,
    /\bcannot find\b/i,
    /\blooking for\b/i,
    /\btrying to find\b/i,
    /\bwhere is\b/i,
    /\bwhere can i\b/i,
    /\bwhere do i go\b/i,
    /\bwhere can i see\b/i,
    /\bwhere do i see\b/i,
    /\bwhere do i upload\b/i,
    /\bwhere do i view\b/i,
    /\bhow do i get to\b/i,
    /\bhow do i get back to\b/i,
    /\bhow can i get to\b/i,
    /\bhow do i open\b/i,
    /\bhow can i open\b/i,
    /\bcan i see\b/i,
    /\b(update|change|manage) (?:my )?(billing|payment method|billing method|card)\b/i,
    /\bopen stripe setup\b/i,
    /\bopen security settings\b/i,
    /\bopen profile settings\b/i,
    /\b(dark mode|light mode|theme|appearance)\b/i,
    /\b(change|switch|use|make).*(dark mode|light mode|theme|appearance)\b/i,
    /\bresume application\b/i,
    /\bprofile readiness\b/i,
  ]);
}

function hasExplainLead(text = "") {
  return hasPatternMatch(text, [
    /\bhow does(?:\s+[a-z0-9'_-]+){0,4}\s+work\b/i,
    /\bhow does (?:lpc|let'?s para connect|lets paraconnect|the platform)\b.*\bworks?\b/i,
    /\bcan you explain how\b.*\b(?:lpc|let'?s para connect|lets paraconnect|the platform)\b.*\bworks?\b/i,
    /\bwhen can i\b/i,
    /\bhow do i\b(?!\s+(?:get to|get back to|open|view|see)\b)/i,
    /\b(edit|update|change|manage)\s+(?:my\s+)?profile\b/i,
    /\b(edit|update|change|manage)\s+(?:my\s+)?(headline|bio|summary|experience|skills?)\b/i,
    /\bhelp me understand\b/i,
    /\bwalk me through\b/i,
    /\bcan you explain (?:this|that|it) simply\b/i,
    /\bwhat should i do first\b/i,
    /\bwhere should i start\b/i,
    /\bwhat do (?:attorneys|paralegals) usually do first\b/i,
    /\bhow should i use (?:lpc|let'?s para connect|lets paraconnect|the platform)\b/i,
    /\bdo i have to connect stripe\b/i,
    /\bdo i need to connect stripe\b/i,
    /\bdo i have to set up stripe\b/i,
    /\bdo i need stripe\b/i,
    /\bhow do payouts work\b/i,
    /\bhow does messaging work\b/i,
    /\bhow do messages work\b/i,
    /\bhow does the case workspace work\b/i,
    /\bhow do cases work\b/i,
    /\bwhat should i do next\b/i,
    /\bwhat'?s next\b/i,
    /\bnext step\b/i,
    /\bwhat can i do to make my profile stand out\b/i,
    /\bhow can i make my profile stand out\b/i,
    /\bhow do i make my profile stand out\b/i,
    /\bhow can i improve my profile\b/i,
    /\bwhat should i put on my profile\b/i,
    /\bwhat happens\b/i,
    /\bwhat do i do next\b/i,
    /\bwhat do i need to do(?: next| now)?\b/i,
    /\bjust tell me what (?:i|we) (?:need|have) to do(?: next| now)?\b/i,
    /\btell me what (?:i|we) (?:need|have) to do(?: next| now)?\b/i,
    /\bcan i apply\b/i,
    /\bhow can i apply\b/i,
  ]);
}

function isAffirmativeSupportReply(text = "") {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ");
  return [
    "yes",
    "yeah",
    "yep",
    "sure",
    "ok",
    "okay",
    "please",
    "please do",
    "that works",
    "that would help",
    "show me",
  ].includes(normalized);
}

function isGratitudeClosure(text = "", previousState = {}) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return false;
  const gratitude =
    /\b(thanks|thank you|thank u|appreciate it|appreciated|perfect thanks|great thanks|awesome thanks)\b/i.test(
      normalized
    ) || ["thanks", "thank you", "thank u", "great thanks", "awesome thanks"].includes(normalized);
  if (!gratitude) return false;
  const activeAsk = String(previousState.activeAsk || "").toLowerCase();
  return activeAsk && activeAsk !== "generic_intake";
}

function isNextStepQuestion(text = "") {
  return [
    /\bwhat do i do next\b/i,
    /\bwhat should i do next\b/i,
    /\bwhat do i need to do(?: next| now)?\b/i,
    /\bjust tell me what (?:i|we) (?:need|have) to do(?: next| now)?\b/i,
    /\btell me what (?:i|we) (?:need|have) to do(?: next| now)?\b/i,
    /\bwhat'?s next\b/i,
    /\bnext step\b/i,
  ].some((pattern) => pattern.test(String(text || "")));
}

function isFirstStepQuestion(text = "") {
  return [
    /\bwhat should i do first\b/i,
    /\bwhere should i start\b/i,
    /\bhow should i start\b/i,
    /\bwhat do (?:attorneys|paralegals) usually do first\b/i,
    /\bhow should i use (?:lpc|let'?s para connect|lets paraconnect|the platform)\b/i,
  ].some((pattern) => pattern.test(String(text || "")));
}

function isSimpleExplainQuestion(text = "") {
  return [
    /\bcan you explain (?:this|that|it) simply\b/i,
    /\bexplain (?:this|that|it) simply\b/i,
    /\bhelp me understand\b/i,
    /\bwalk me through\b/i,
    /\bcan you walk me through\b/i,
    /\bi'?m confused\b/i,
    /\bim confused\b/i,
    /\bthis makes no sense\b/i,
  ].some((pattern) => pattern.test(String(text || "")));
}

function isPlatformOverviewQuestion(text = "") {
  return [
    /\bhow does (?:lpc|let'?s para connect|lets paraconnect|the platform)\b.*\bworks?\b/i,
    /\bcan you explain how\b.*\b(?:lpc|let'?s para connect|lets paraconnect|the platform)\b.*\bworks?\b/i,
    /\bwalk me through how\b.*\b(?:lpc|let'?s para connect|lets paraconnect|the platform)\b.*\bworks?\b/i,
    /\bhow should i use (?:lpc|let'?s para connect|lets paraconnect|the platform)\b/i,
    /\bhow do cases work\b/i,
    /\bhow does the case workspace work\b/i,
    /\bhow do payouts work\b/i,
    /\bhow does messaging work\b/i,
    /\bhow do messages work\b/i,
  ].some((pattern) => pattern.test(String(text || "")));
}

function isProfileSetupQuestion(text = "") {
  return [
    /\bhow do i create my profile\b/i,
    /\bhow do i set up my profile\b/i,
    /\bhow do i edit my profile\b/i,
    /\bhow do i update my profile\b/i,
    /\bhow do i change my profile\b/i,
    /\bhow do i manage my profile\b/i,
    /\bhow do i make my profile\b/i,
    /\bhow do i complete my profile\b/i,
    /\bhow do i fill out my profile\b/i,
    /\bfinish my profile\b/i,
    /\bcomplete my profile\b/i,
    /\bset up my profile\b/i,
    /\bcreate my profile\b/i,
    /\bbuild my profile\b/i,
    /\bedit my profile\b/i,
    /\bupdate my profile\b/i,
    /\bchange my profile\b/i,
    /\bmanage my profile\b/i,
    /\b(edit|update|change|manage)\s+(?:my\s+)?(headline|bio|summary|experience|skills?)\b/i,
    /\bprofile setup\b/i,
  ].some((pattern) => pattern.test(String(text || "")));
}

function isStripeRequirementQuestion(text = "") {
  return [
    /\bdo i have to connect stripe\b/i,
    /\bdo i need to connect stripe\b/i,
    /\bdo i have to set up stripe\b/i,
    /\bdo i need stripe\b/i,
    /\bdo i need to set up stripe\b/i,
  ].some((pattern) => pattern.test(String(text || "")));
}

function isApplyWorkflowQuestion(text = "") {
  return [
    /\bwhen can i apply\b/i,
    /\bhow can i apply\b/i,
    /\bhow do i apply\b/i,
    /\btrying to apply\b/i,
    /\bapply\b.*\b(job|jobs|case|cases|matter|matters)\b/i,
  ].some((pattern) => pattern.test(String(text || "")));
}

const SUPPORT_TOPIC_SELECTORS = [
  {
    key: "profile_setup",
    label: "Profile setup",
    patterns: [
      /\b(profile|headline|bio|summary|experience|skills?)\b/i,
      /\b(profile setup|create my profile|set up my profile|complete my profile|build my profile|edit my profile|update my profile|change my profile|manage my profile)\b/i,
    ],
  },
  {
    key: "payouts",
    label: "Payouts",
    patterns: [/\b(payouts?|paid|get paid|stripe|bank account|security settings)\b/i],
  },
  {
    key: "messages",
    label: "Messages",
    patterns: [/\b(messages?|chat|thread|inbox)\b/i],
  },
  {
    key: "applications",
    label: "Applications",
    patterns: [/\b(apply|application|applications|browse cases|open cases)\b/i],
  },
  {
    key: "cases",
    label: "Cases",
    patterns: [/\b(case|cases|workspace|matter|matters)\b/i],
  },
  {
    key: "billing",
    label: "Billing",
    patterns: [/\b(billing|payment method|billing method|card|invoice|receipt|invoices|receipts)\b/i],
  },
  {
    key: "theme_preferences",
    label: "Theme settings",
    patterns: [/\b(dark mode|light mode|theme|appearance)\b/i],
  },
];

function getPatternMatchIndex(text = "", pattern = null) {
  if (!text || !pattern) return -1;
  try {
    const safeFlags = String(pattern.flags || "").replace(/g/g, "");
    const safePattern = new RegExp(pattern.source, safeFlags);
    const match = String(text).match(safePattern);
    return match && Number.isInteger(match.index) ? match.index : -1;
  } catch {
    return -1;
  }
}

function detectSupportTopics(text = "") {
  const normalized = String(text || "");
  if (!normalized) return [];

  return SUPPORT_TOPIC_SELECTORS
    .map((definition) => {
      const indexes = definition.patterns
        .map((pattern) => getPatternMatchIndex(normalized, pattern))
        .filter((index) => index >= 0);
      return {
        key: definition.key,
        index: indexes.length ? Math.min(...indexes) : -1,
      };
    })
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.key);
}

function formatTopicSelectionLabel(key = "") {
  const normalized = String(key || "").trim().toLowerCase();
  const match = SUPPORT_TOPIC_SELECTORS.find((definition) => definition.key === normalized);
  return match?.label || normalized.replace(/_/g, " ");
}

function formatNaturalList(items = []) {
  const values = [...new Set((Array.isArray(items) ? items : []).map((item) => trimString(item, 120)).filter(Boolean))];
  if (!values.length) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function hasCorrectionLead(text = "") {
  return /\b(actually|no[, ]|nope|not that|i meant|i mean|specifically|rather)\b/i.test(String(text || ""));
}

function hasIssueReopenSignal(text = "") {
  return /\b(still happening|still not working|still broken|same issue|it came back|came back|happening again|broken again|not fixed|returned|back again)\b/i.test(
    String(text || "")
  );
}

function isResolvedIssueState({
  conversationState = {},
  issueLifecycle = null,
  promptAction = null,
} = {}) {
  const lifecycleStatus = trimString(issueLifecycle?.statusKey, 80).toLowerCase();
  const promptIssueState = trimString(promptAction?.issueState, 40).toLowerCase();
  const promptTicketStatus = trimString(promptAction?.ticketStatus, 80).toLowerCase();
  const proactiveIssueState = trimString(conversationState.proactiveIssueState, 40).toLowerCase();
  const proactiveTicketStatus = trimString(conversationState.proactiveTicketStatus, 80).toLowerCase();

  return (
    ["resolved", "closed"].includes(lifecycleStatus) ||
    ["resolved", "closed"].includes(promptIssueState) ||
    RESOLVED_TICKET_STATUSES.includes(promptTicketStatus) ||
    ["resolved", "closed"].includes(proactiveIssueState) ||
    RESOLVED_TICKET_STATUSES.includes(proactiveTicketStatus)
  );
}

function hasCurrentIssueStatusReference(text = "", conversationState = {}, issueLifecycle = null) {
  const issueLabel =
    trimString(conversationState.currentIssueLabel, 180) ||
    trimString(conversationState.proactiveIssueLabel, 180) ||
    trimString(issueLifecycle?.issueLabel, 180);
  if (!issueLabel) return false;

  return [
    /\bwhat about (?:that|this|it)(?: now)?\b/i,
    /\bhow about (?:that|this|it)(?: now)?\b/i,
    /\bis (?:that|this|it) fixed yet\b/i,
    /\bstatus on (?:that|this|it)\b/i,
    /\bupdate on (?:that|this|it)\b/i,
    /\bwhat'?s happening with (?:that|this|it)\b/i,
  ].some((pattern) => pattern.test(String(text || "")));
}

function hasPreviousNavigationReference(text = "", previousState = {}) {
  const lastNavigationHref = trimString(previousState.lastNavigationHref, 500);
  if (!lastNavigationHref) return false;

  return [
    /\b(open|show|take|bring|get)\s+(?:me\s+)?(?:back\s+)?(?:to\s+)?(?:that|this|it|there)\b/i,
    /\b(open|show)\s+(?:that|this|the)\s+(?:page|screen|link)\b/i,
    /\b(?:that|this|the)\s+(?:page|screen|link)\s+(?:from before|again)\b/i,
    /\btake me there\b/i,
    /\bgo back there\b/i,
    /\bshow me that again\b/i,
    /\bopen that page from before\b/i,
  ].some((pattern) => pattern.test(String(text || "")));
}

function getTopicSelectionOptions(conversationState = {}) {
  return Array.isArray(conversationState.selectionTopics)
    ? conversationState.selectionTopics.map((value) => trimString(value, 80).toLowerCase()).filter(Boolean).slice(0, 3)
    : [];
}

function resolveOptionByOrdinal(text = "", options = [], lastSelection = "") {
  const normalized = String(text || "").trim().toLowerCase();
  const normalizedOptions = (Array.isArray(options) ? options : []).map((option) => String(option || "").trim().toLowerCase()).filter(Boolean);
  const currentSelection = String(lastSelection || "").trim().toLowerCase();
  if (!normalized) return "";
  if (
    currentSelection &&
    /\b(that one|that part|that topic|that question|that option|that one please)\b/i.test(normalized)
  ) {
    return currentSelection;
  }
  if (!normalizedOptions.length) return "";

  if (/\b(first|first one|first part)\b/i.test(normalized)) return normalizedOptions[0] || "";
  if (/\b(second|second one|second part)\b/i.test(normalized)) return normalizedOptions[1] || "";
  if (/\b(third|third one|third part)\b/i.test(normalized)) return normalizedOptions[2] || "";
  if (/\b(last one|last part)\b/i.test(normalized)) return normalizedOptions[normalizedOptions.length - 1] || "";
  if (/\b(other one|other part|other question|not that one|not that part|actually the other one|actually not that)\b/i.test(normalized)) {
    return normalizedOptions.find((option) => option && option !== currentSelection) || "";
  }

  return "";
}

function isAllTopicSelection(text = "", options = []) {
  const normalized = String(text || "").trim().toLowerCase();
  const normalizedOptions = Array.isArray(options)
    ? options.map((option) => String(option || "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (!normalized || normalizedOptions.length < 2) return false;
  return /\b(both|both of them|all of them|all those|all of those|everything|both please)\b/i.test(normalized);
}

function buildCompoundSuggestedReplies(explainIntent = "") {
  const normalized = String(explainIntent || "").trim().toLowerCase();
  if (normalized === "profile_and_stripe") return ["Profile setup", "Stripe"];
  if (normalized === "payout_and_stripe") return ["Payouts", "Stripe"];
  if (normalized === "apply_and_messaging") return ["My applications", "Messages"];
  if (normalized === "platform_overview_and_next_step") return ["How LPC works", "Next step"];
  return [];
}

function detectCompoundExplainIntent(text = "", role = "") {
  const normalized = String(text || "");
  const normalizedRole = String(role || "").toLowerCase();

  const asksProfileSetup = normalizedRole === "paralegal" && isProfileSetupQuestion(normalized);
  const asksProfileGuidance =
    normalizedRole === "paralegal" &&
    /\b(profile|headline|bio|summary|experience|skills?)\b/i.test(normalized) &&
    /\b(stand out|improve|better|stronger|complete|polish|best|help)\b/i.test(normalized);
  const asksStripeRequirement = normalizedRole === "paralegal" && isStripeRequirementQuestion(normalized);
  const asksApplyWorkflow = normalizedRole === "paralegal" && isApplyWorkflowQuestion(normalized);
  const asksMessaging = /\b(messages?|chat|thread|inbox)\b/i.test(normalized);
  const asksPayoutStatus =
    normalizedRole === "paralegal" &&
    /\b(where is my payout|when do i get paid|why can'?t i get paid|why aren't payouts enabled|where are my payouts?)\b/i.test(
      normalized
    );

  if ((asksProfileSetup || asksProfileGuidance) && asksStripeRequirement) {
    return "profile_and_stripe";
  }
  if (asksPayoutStatus && asksStripeRequirement) {
    return "payout_and_stripe";
  }
  if (asksApplyWorkflow && asksMessaging) {
    return "apply_and_messaging";
  }
  if (isPlatformOverviewQuestion(normalized) && isNextStepQuestion(normalized)) {
    return "platform_overview_and_next_step";
  }
  return "";
}

function detectSplitSupportRequest(text = "", role = "") {
  const normalized = String(text || "");
  const detectedTopics = detectSupportTopics(normalized);
  const connectorsPresent = /\b(and|also|plus|as well|another thing|another question|while|but also|on top of that)\b/i.test(
    normalized
  );

  if (detectCompoundExplainIntent(normalized, role)) return [];
  if (detectedTopics.length >= 3) return detectedTopics.slice(0, 3);
  if (detectedTopics.length >= 2 && connectorsPresent) return detectedTopics.slice(0, 3);
  return [];
}

function detectExplainIntentOverride(text = "", role = "", conversationState = {}) {
  const normalized = String(text || "");
  const normalizedRole = String(role || "").toLowerCase();
  const compoundIntent = trimString(conversationState.compoundIntent, 120).toLowerCase();
  const topicSelection = resolveTopicSelection(normalized, conversationState);
  const compoundBranchSelection = detectCompoundBranchSelection(normalized, conversationState);

  if (!normalized || normalizedRole !== "paralegal") return "";

  if (compoundBranchSelection) return compoundBranchSelection;

  if (String(conversationState.awaitingField || "").toLowerCase() === "topic_selection") {
    if (topicSelection === "profile_setup") return "profile_setup";
    if (topicSelection === "payouts") return "stripe";
    if (topicSelection === "messages") return "messaging_workflow";
    if (topicSelection === "applications") return "apply";
  }

  if (compoundIntent === "profile_and_stripe") {
    if (isStripeRequirementQuestion(normalized) || /\b(stripe|security settings|payouts?)\b/i.test(normalized)) {
      return "stripe";
    }
    if (isProfileSetupQuestion(normalized) || /\b(profile|headline|bio|experience|skills?)\b/i.test(normalized)) {
      return "profile_setup";
    }
  }

  if (compoundIntent === "apply_and_messaging") {
    if (/\b(messages?|chat|thread|inbox)\b/i.test(normalized)) {
      return "messaging_workflow";
    }
    if (isApplyWorkflowQuestion(normalized) || /\b(applications?|browse cases|open cases)\b/i.test(normalized)) {
      return "apply";
    }
  }

  if (compoundIntent === "payout_and_stripe") {
    if (isStripeRequirementQuestion(normalized) || /\b(stripe|security settings)\b/i.test(normalized)) {
      return "stripe";
    }
    if (/\b(payout|paid|get paid|bank)\b/i.test(normalized)) {
      return "payout_and_stripe";
    }
  }

  if (compoundIntent === "platform_overview_and_next_step" && isNextStepQuestion(normalized)) {
    return "platform_overview_and_next_step";
  }

  return "";
}

function detectOverloadedSupportRequest(text = "") {
  const normalized = String(text || "");
  if (!normalized) return false;
  return detectSupportTopics(normalized).length >= 3 && /\b(help|question|issue|problem|trying to|need)\b/i.test(normalized);
}

function describeDetectedSupportTopics(text = "") {
  return detectSupportTopics(text)
    .map((topicKey) => formatTopicSelectionLabel(topicKey).toLowerCase())
    .slice(0, 3);
}

function resolveTopicSelection(text = "", optionsOrState = []) {
  const normalized = String(text || "").trim().toLowerCase();
  const optionKeys = Array.isArray(optionsOrState)
    ? optionsOrState.map((value) => trimString(value, 80).toLowerCase()).filter(Boolean)
    : getTopicSelectionOptions(optionsOrState);
  const lastSelection = Array.isArray(optionsOrState)
    ? ""
    : trimString(
        optionsOrState.lastSelectionTopic || optionsOrState.lastCompoundBranch || optionsOrState.topicKey,
        120
      ).toLowerCase();
  if (!normalized) return "";

  const detectedTopics = detectSupportTopics(normalized);
  if (!optionKeys.length && detectedTopics.length) {
    return detectedTopics[0];
  }

  if (optionKeys.length && detectedTopics.length) {
    const matchedOption = detectedTopics.find((topicKey) => optionKeys.includes(topicKey));
    if (matchedOption) return matchedOption;
  }

  const ordinalOption = resolveOptionByOrdinal(normalized, optionKeys, lastSelection);
  if (ordinalOption) return ordinalOption;

  return "";
}

function getCompoundBranchOptions(compoundIntent = "") {
  const normalized = String(compoundIntent || "").trim().toLowerCase();
  if (normalized === "profile_and_stripe") return ["profile_setup", "stripe"];
  if (normalized === "apply_and_messaging") return ["apply", "messaging_workflow"];
  if (normalized === "payout_and_stripe") return ["payout_and_stripe", "stripe"];
  if (normalized === "platform_overview_and_next_step") return ["platform_overview", "platform_overview_and_next_step"];
  return [];
}

function isOtherPartSelection(text = "") {
  return /\b(other part|other one|other question|what about the other|and the other part)\b/i.test(String(text || ""));
}

function normalizeCompoundBranchSelection(selection = "", compoundIntent = "") {
  const normalizedSelection = String(selection || "").trim().toLowerCase();
  const normalizedCompoundIntent = String(compoundIntent || "").trim().toLowerCase();

  if (normalizedCompoundIntent === "profile_and_stripe") {
    if (normalizedSelection === "profile_setup") return "profile_setup";
    if (["payouts", "stripe"].includes(normalizedSelection)) return "stripe";
  }
  if (normalizedCompoundIntent === "apply_and_messaging") {
    if (normalizedSelection === "applications") return "apply";
    if (normalizedSelection === "messages") return "messaging_workflow";
  }
  if (normalizedCompoundIntent === "payout_and_stripe") {
    if (normalizedSelection === "payouts") return "payout_and_stripe";
    if (normalizedSelection === "stripe") return "stripe";
  }
  if (normalizedCompoundIntent === "platform_overview_and_next_step") {
    if (normalizedSelection === "applications" || isNextStepQuestion(selection)) return "platform_overview_and_next_step";
  }
  return "";
}

function detectCompoundBranchSelection(text = "", conversationState = {}) {
  const compoundIntent = trimString(conversationState.compoundIntent, 120).toLowerCase();
  if (!compoundIntent) return "";

  const topicSelection = resolveTopicSelection(text);
  const mappedSelection = normalizeCompoundBranchSelection(topicSelection, compoundIntent);
  if (mappedSelection) return mappedSelection;

  if (compoundIntent === "profile_and_stripe" && isProfileSetupQuestion(text)) return "profile_setup";
  if (compoundIntent === "profile_and_stripe" && isStripeRequirementQuestion(text)) return "stripe";
  if (compoundIntent === "apply_and_messaging" && isApplyWorkflowQuestion(text)) return "apply";
  if (compoundIntent === "apply_and_messaging" && /\b(messages?|chat|thread|inbox)\b/i.test(String(text || ""))) {
    return "messaging_workflow";
  }

  const ordinalSelection = resolveOptionByOrdinal(
    text,
    getCompoundBranchOptions(compoundIntent),
    trimString(conversationState.lastCompoundBranch, 120).toLowerCase()
  );
  if (ordinalSelection) return ordinalSelection;

  if (isOtherPartSelection(text)) {
    const options = getCompoundBranchOptions(compoundIntent);
    const lastBranch = trimString(conversationState.lastCompoundBranch, 120).toLowerCase();
    const other = options.find((option) => option && option !== lastBranch);
    return other || "";
  }

  return "";
}

function buildNavigationPayload({
  ctaLabel = "",
  ctaHref = "",
  ctaType = "inline_link",
  inlineLinkText = "here",
} = {}) {
  if (!ctaLabel || !ctaHref) return null;
  return {
    ctaLabel,
    ctaHref,
    ctaType,
    inlineLinkText: inlineLinkText || "here",
  };
}

function buildActionPayload({ label = "", href = "", type = "deep_link" } = {}) {
  const nextLabel = trimString(label, 120);
  const nextHref = trimString(href, 500);
  const nextType = trimString(type, 80) || "deep_link";
  if (!nextLabel || !nextHref) return null;
  return {
    label: nextLabel,
    href: nextHref,
    type: nextType,
  };
}

function buildInvokeActionPayload({ label = "", action = "", payload = {} } = {}) {
  const nextLabel = trimString(label, 120);
  const nextAction = trimString(action, 120);
  if (!nextLabel || !nextAction) return null;
  return {
    label: nextLabel,
    type: "invoke",
    action: nextAction,
    payload: payload && typeof payload === "object" ? payload : {},
  };
}

function buildNavigationReplyText(action = "find", inlineLinkText = "here") {
  const linkText = inlineLinkText || "here";
  if (action === "update") {
    return `You can update that ${linkText}.`;
  }
  if (action === "open") {
    return `You can open that ${linkText}.`;
  }
  return `You can find that ${linkText}.`;
}

function isAdminDashboardSupportScope({ user = {}, pageContext = {}, sourcePage = "" } = {}) {
  const role = String(user?.role || pageContext?.roleHint || "").trim().toLowerCase();
  if (role !== "admin") return false;
  const viewName = String(pageContext?.viewName || "").trim().toLowerCase();
  const pathname = String(pageContext?.pathname || sourcePage || "").trim().toLowerCase();
  const href = String(pageContext?.href || "").trim().toLowerCase();
  return [viewName, pathname, href].some((value) => value.includes("admin-dashboard"));
}

function buildAdminDashboardSupportReply({ text = "" } = {}) {
  const normalized = String(text || "").trim().toLowerCase();
  const matchedRule = ADMIN_DASHBOARD_SUPPORT_RULES.find((rule) => hasPatternMatch(normalized, rule.patterns));

  if (matchedRule) {
    return buildLlmAssistantPayload({
      reply: `${matchedRule.summary} You can open it here.`,
      navigation: buildNavigationPayload({
        ctaLabel: matchedRule.label,
        ctaHref: matchedRule.href,
        ctaType: "deep_link",
      }),
      actions: [buildActionPayload({ label: `Open ${matchedRule.label}`, href: matchedRule.href })].filter(Boolean),
      suggestions: ["Overview", "Approvals", "Support Ops"],
      provider: "admin_dashboard_support",
      category: "unknown",
      categoryLabel: "Admin Dashboard",
      primaryAsk: "admin_dashboard_help",
      activeTask: "NAVIGATE",
      responseMode: "DIRECT_ANSWER",
      confidence: "high",
      urgency: "low",
      grounded: true,
      detailLevel: "concise",
      supportFacts: {
        userRole: "admin",
        workspace: "admin_dashboard",
        section: matchedRule.key,
      },
    });
  }

  return buildLlmAssistantPayload({
    reply:
      "This chat only handles admin dashboard questions. Ask about tabs, queues, settings, or where to do a task inside the admin dashboard.",
    navigation: buildNavigationPayload({
      ctaLabel: "Overview",
      ctaHref: "admin-dashboard.html#overview",
      ctaType: "deep_link",
    }),
    actions: [buildActionPayload({ label: "Open Overview", href: "admin-dashboard.html#overview" })].filter(Boolean),
    suggestions: ["Overview", "Approvals", "Finance"],
    provider: "admin_dashboard_support",
    category: "unknown",
    categoryLabel: "Admin Dashboard",
    primaryAsk: "admin_dashboard_help",
    activeTask: "ANSWER",
    responseMode: "DIRECT_ANSWER",
    confidence: "high",
    urgency: "low",
    grounded: true,
    detailLevel: "concise",
    supportFacts: {
      userRole: "admin",
      workspace: "admin_dashboard",
    },
  });
}

function buildSelfServiceActions({
  category = "",
  primaryAsk = "",
  paymentSubIntent = "",
  navigation = null,
  supportFacts = {},
  pageContext = {},
  needsEscalation = false,
} = {}) {
  if (navigation?.ctaHref && navigation?.ctaLabel) {
    return [buildActionPayload({ label: navigation.ctaLabel, href: navigation.ctaHref, type: "deep_link" })].filter(Boolean);
  }

  if (category === "payment" && paymentSubIntent === "billing_method") {
    return [buildActionPayload({ label: "Open Billing", href: "dashboard-attorney.html#billing" })].filter(Boolean);
  }
  if (
    (category === "payment" && paymentSubIntent === "payout") ||
    category === "stripe_onboarding"
  ) {
    const actions = [
      buildInvokeActionPayload({
        label: "Restart Stripe onboarding",
        action: "start_stripe_onboarding",
      }),
      buildActionPayload({ label: "Open Stripe setup", href: "profile-settings.html#securitySection" }),
    ].filter(Boolean);
    return actions;
  }
  if (category === "messaging" && supportFacts.caseState?.caseId) {
    return [
      buildActionPayload({
        label: "Open messages",
        href: buildCaseHref(supportFacts.caseState.caseId, "#case-messages"),
      }),
    ].filter(Boolean);
  }
  if (category === "profile_save") {
    if (needsEscalation) return [];
    return [buildActionPayload({ label: "Open preferences", href: "profile-settings.html#preferencesSection" })].filter(Boolean);
  }
  if (
    ["case_posting", "unknown"].includes(category) &&
    ["help_with_case", "case_status", "participant_lookup", "workspace_access"].includes(primaryAsk) &&
    supportFacts.caseState?.caseId
  ) {
    return [
      buildActionPayload({
        label: "Open case",
        href: buildCaseHref(supportFacts.caseState.caseId),
      }),
    ].filter(Boolean);
  }
  if (category === "payment" && primaryAsk === "case_payment" && supportFacts.caseState?.caseId) {
    return [
      buildActionPayload({
        label: "Open case",
        href: buildCaseHref(supportFacts.caseState.caseId),
      }),
    ].filter(Boolean);
  }
  if (["password_reset", "login"].includes(category)) {
    return [
      buildInvokeActionPayload({
        label: "Email me a reset link",
        action: "request_password_reset",
      }),
      buildActionPayload({ label: "Open security settings", href: "profile-settings.html#securitySection" }),
    ].filter(Boolean);
  }
  if (
    pageContext.applicationId &&
    supportFacts.caseState?.caseId &&
    String(supportFacts.userRole || "").toLowerCase() === "paralegal"
  ) {
    return [
      buildActionPayload({
        label: "Resume application",
        href: buildCaseHref(supportFacts.caseState.caseId),
        type: "resume_application",
      }),
    ].filter(Boolean);
  }
  return [];
}

function buildSuggestedReplies({
  primaryAsk = "",
  awaitingField = "",
  paymentSubIntent = "",
  supportFacts = {},
  conversationState = {},
  selectionTopics = [],
  navigation = null,
} = {}) {
  if (awaitingField === "topic_selection") {
    const topicOptions = Array.isArray(selectionTopics) && selectionTopics.length
      ? selectionTopics
      : getTopicSelectionOptions(conversationState);
    const labels = topicOptions.map((topicKey) => formatTopicSelectionLabel(topicKey)).filter(Boolean);
    return labels.length ? labels : ["Profile setup", "Payouts", "Messages"];
  }
  if (primaryAsk === "product_guidance") {
    const branchReplies = buildCompoundSuggestedReplies(supportFacts.explainIntent);
    if (branchReplies.length) return branchReplies;
  }
  if (primaryAsk === "payment_clarify" || paymentSubIntent === "unclear") {
    return ["Billing method", "Case payment", "Payouts"];
  }
  if (primaryAsk === "messaging_access" && (awaitingField === "case_identifier" || supportFacts.messagingState?.clarificationNeeded)) {
    return ["This case", "Across all messages"];
  }
  return [];
}

function buildHandoffSummary({
  latestUserMessage = "",
  assistantReply = "",
  categoryLabel = "",
} = {}) {
  const issue = trimString(latestUserMessage, 260);
  const summary = trimString(assistantReply, 360);
  if (!issue && !summary) return "";
  const prefix = categoryLabel ? `${categoryLabel}: ` : "";
  const parts = [];
  if (issue) parts.push(`Issue: ${issue}`);
  if (summary) parts.push(`AI summary: ${summary}`);
  return trimString(`${prefix}${parts.join(" ")}`, 800);
}

function buildCaseHref(caseId = "", hash = "") {
  const normalizedCaseId = trimString(caseId, 80);
  if (!normalizedCaseId) return "";
  const base = `case-detail.html?caseId=${encodeURIComponent(normalizedCaseId)}`;
  return hash ? `${base}${hash}` : base;
}

function getPrimaryTask(message = "", previousState = {}) {
  const normalized = String(message || "").trim();
  const lowered = normalized.toLowerCase();
  const topicSelection = resolveTopicSelection(normalized, previousState);

  if (!normalized) return "UNKNOWN";
  if (hasPreviousNavigationReference(normalized, previousState)) {
    return "NAVIGATION";
  }
  if (detectOverloadedSupportRequest(normalized)) {
    return "UNKNOWN";
  }
  if (
    String(previousState.awaiting || "").toLowerCase() === "case" ||
    String(previousState.awaitingField || "").toLowerCase() === "case_identifier"
  ) {
    return String(previousState.activeTask || "").toUpperCase() || "FACT_LOOKUP";
  }
  if (
    String(previousState.awaitingField || "").toLowerCase() === "applications_navigation" &&
    isAffirmativeSupportReply(normalized)
  ) {
    return "NAVIGATION";
  }
  if (
    (String(previousState.awaitingField || "").toLowerCase() === "topic_selection" ||
      getTopicSelectionOptions(previousState).length) &&
    topicSelection
  ) {
    if (["profile_setup", "payouts", "messages", "applications"].includes(topicSelection)) {
      return "EXPLAIN";
    }
    if (["cases", "billing", "theme_preferences"].includes(topicSelection)) {
      return "NAVIGATION";
    }
  }
  if (isGratitudeClosure(normalized, previousState)) {
    return "UNKNOWN";
  }
  if (/\b(nothing is blocking me|never mind|all good|it'?s working now|resolved now|figured it out|that fixed it|fixed now|solved it)\b/i.test(normalized)) {
    return "UNKNOWN";
  }
  if (
    [
      "help",
      "support",
      "question",
      "customer service",
      "customer support",
      "need support",
      "need assistance",
    ].includes(lowered.replace(/[^a-z0-9]+/g, " ").trim())
  ) {
    return "UNKNOWN";
  }
  if (/\b(talk to someone|talk to a person|human help|send to the team|contact support|team review)\b/i.test(normalized)) {
    return "ESCALATION";
  }
  if (/\b(won'?t respond|not responding|isn'?t responding|waiting on them|ignoring|hasn'?t replied|hasn'?t answered|what do i do)\b/i.test(normalized)) {
    return "HUMAN_ISSUE";
  }
  if (
    isStripeConceptQuestion(normalized) ||
    /\b(do i have to|do i need to)\s+(connect|set up).*\bstripe\b/i.test(normalized) ||
    /\bdo i need stripe\b/i.test(normalized)
  ) {
    return "EXPLAIN";
  }
  if (
    /\b(where is my payout|when do i get paid|my money didn'?t come|my money did not come|why can'?t i get paid|why aren't payouts enabled)\b/i.test(
      normalized
    )
  ) {
    return "TROUBLESHOOT";
  }
  if (
    /\b(open stripe setup|where do i go for stripe|where do i go for security|where are profile settings|where do i see my applications|where can i see my payouts|where can i see my completed matters)\b/i.test(
      normalized
    )
  ) {
    return "NAVIGATION";
  }
  if (/\b(view|see|find|open)\b.*\b(my )?applications?\b/i.test(normalized)) {
    return "NAVIGATION";
  }
  if (/\b(can i change my password|change my password|update my password|password reset|reset my password)\b/i.test(normalized)) {
    return "TROUBLESHOOT";
  }
  if (hasNavigationLead(lowered)) {
    return "NAVIGATION";
  }
  if (hasExplainLead(lowered)) {
    return "EXPLAIN";
  }
  if (/\b(who|what(?:'s| is)? the status|status|who is|who's|what is stripe|what's stripe)\b/i.test(normalized)) {
    return "FACT_LOOKUP";
  }
  if (
    /\b(payment method|billing method|saved payment|saved card|card on file|credit card|debit card|card declined|declined card|declined|billing|receipts?|invoices?|payment|payout|stripe|bank account|get paid)\b/i.test(
      normalized
    )
  ) {
    return "TROUBLESHOOT";
  }
  if (/\b(can'?t|cannot|not working|won'?t|failed|error|blank|stuck|broken|blocked)\b/i.test(normalized)) {
    return "TROUBLESHOOT";
  }
  return "UNKNOWN";
}

function detectFactLookupIntent(message = "") {
  const normalized = String(message || "");
  if (/\bwho(?:'s| is)?\b.*\b(attorney|paralegal)\b/i.test(normalized)) return "participant";
  if (/\b(status|paused|relisted|archived)\b/i.test(normalized)) return "status";
  if (/\b(what is stripe|what's stripe|what does stripe do|why stripe)\b/i.test(normalized)) return "stripe";
  return "general";
}

function detectTroubleshootIntent(message = "", role = "") {
  const normalized = String(message || "");
  const roleLc = String(role || "").toLowerCase();
  if (/\b(password|reset link|log in|login|sign in|security)\b/i.test(normalized)) return "account_access";
  if (
    /\b(profile|preferences?|settings|account settings)\b/i.test(normalized) &&
    /\b(save|button|not working|won'?t|will not|doesn'?t|failed|error|broken|blocked)\b/i.test(normalized)
  ) {
    return "profile_save";
  }
  if (/\b(message|messages|chat|thread|inbox|msg)\b/i.test(normalized)) return "messaging";
  if (/\b(workspace|case page|case workspace)\b/i.test(normalized)) return "workspace";
  if (/\b(payment method|billing method|saved card|card declined|receipts?|invoices?)\b/i.test(normalized)) {
    return roleLc === "attorney" ? "billing" : "payment_ambiguous";
  }
  if (/\b(payout|stripe|bank account|get paid|my money didn'?t come|my money did not come)\b/i.test(normalized)) {
    return "payout";
  }
  if (/\b(charge|checkout|escrow|fund(?:ing)?|transaction|case payment)\b/i.test(normalized)) {
    return roleLc === "attorney" ? "billing" : "case_payment";
  }
  if (/\bpayment\b/i.test(normalized)) {
    return roleLc === "attorney" ? "payment_ambiguous" : "payout";
  }
  return "general";
}

async function getActiveEntity(message = "", pageContext = {}, previousState = {}, options = {}) {
  const task = String(options.task || "").toUpperCase();
  const taskNeedsCase = ["FACT_LOOKUP", "TROUBLESHOOT", "HUMAN_ISSUE"].includes(task);
  if (!taskNeedsCase) return null;

  const resolved = await resolveSupportCaseEntity({
    user: options.user || {},
    message,
    pageContext,
    previousState,
    task,
  });

  if (options.captureResolution && typeof options.captureResolution === "object") {
    options.captureResolution.caseId = resolved?.caseId || null;
    options.captureResolution.source = resolved?.source || "";
    options.captureResolution.caseDoc = resolved?.caseDoc || null;
  }

  return resolved?.caseId || null;
}

async function fetchTaskFacts({
  task = "UNKNOWN",
  message = "",
  analysis = {},
  user = {},
  pageContext = {},
  previousState = {},
  activeEntity = null,
  activeEntitySource = "",
  compoundExplainIntent = "",
} = {}) {
  const role = String(user.role || "").toLowerCase();
  const factLookupIntent = detectFactLookupIntent(message);
  const troubleshootIntent = detectTroubleshootIntent(message, role);
  const effectivePageContext = {
    ...pageContext,
    ...(activeEntity ? { caseId: activeEntity } : {}),
  };

  if (task === "NAVIGATION") {
    const needsCaseNavigationContext =
      Boolean(activeEntity) ||
      /\b(case|workspace|matter|messages?|chat|documents?|files?|upload|share)\b/i.test(String(message || ""));
    return {
      userRole: role,
      caseState: needsCaseNavigationContext ? await getCaseSnapshot(user, effectivePageContext) : {},
      navigationOnly: true,
      factLookupIntent,
      troubleshootIntent,
    };
  }

  if (task === "FACT_LOOKUP") {
    if (factLookupIntent === "stripe") {
      return {
        userRole: role,
        stripeState: role === "paralegal" ? await getStripeConnectSnapshot(user) : {},
        factLookupIntent,
      };
    }

    const caseState = await getCaseSnapshot(user, effectivePageContext);
    const facts = {
      userRole: role,
      caseState: caseState ? {
        requestedCaseId: caseState.requestedCaseId,
        caseId: caseState.caseId,
        found: caseState.found,
        accessible: caseState.accessible,
        roleOnCase: caseState.roleOnCase,
        reason: caseState.reason,
        inferred: caseState.inferred === true,
        inferenceSource: caseState.inferenceSource || "",
        title: caseState.title,
        status: caseState.status,
        normalizedStatus: caseState.normalizedStatus,
        pausedReason: caseState.pausedReason,
        readOnly: caseState.readOnly,
        paymentReleased: caseState.paymentReleased,
      } : {},
      factLookupIntent,
    };
    if (facts.caseState.caseId && activeEntitySource && !["page_context", "memory", "case_name_match"].includes(activeEntitySource)) {
      facts.caseState.inferred = true;
      facts.caseState.inferenceSource = activeEntitySource;
    }
    if (factLookupIntent === "participant" && caseState?.caseId) {
      facts.participantState = await getCaseParticipantSnapshot(caseState);
    }
    return facts;
  }

  if (task === "EXPLAIN") {
    const facts = {
      userRole: role,
      explainIntent: "general",
      onboardingState: {
        viewName: String(pageContext.viewName || "").toLowerCase(),
      },
    };
    const previousTopicKey = trimString(previousState.topicKey, 120).toLowerCase();

    if (compoundExplainIntent === "profile_setup") {
      facts.explainIntent = "profile_setup";
      return facts;
    }

    if (compoundExplainIntent === "stripe") {
      facts.stripeState = await getStripeConnectSnapshot(user);
      facts.explainIntent = "stripe";
      return facts;
    }

    if (compoundExplainIntent === "messaging_workflow") {
      facts.explainIntent = "messaging_workflow";
      return facts;
    }

    if (compoundExplainIntent === "apply") {
      facts.explainIntent = "apply";
      return facts;
    }

    if (compoundExplainIntent === "profile_and_stripe") {
      facts.stripeState = await getStripeConnectSnapshot(user);
      facts.explainIntent = "profile_and_stripe";
      return facts;
    }

    if (compoundExplainIntent === "payout_and_stripe") {
      const stripeState = await getStripeConnectSnapshot(user);
      facts.stripeState = stripeState;
      facts.payoutState = await getPayoutSnapshot(user, pageContext, {
        stripeSnapshot: stripeState,
      });
      facts.explainIntent = "payout_and_stripe";
      return facts;
    }

    if (compoundExplainIntent === "apply_and_messaging") {
      facts.explainIntent = "apply_and_messaging";
      return facts;
    }

    if (compoundExplainIntent === "platform_overview_and_next_step") {
      facts.explainIntent = "platform_overview_and_next_step";
      return facts;
    }

    if (isFirstStepQuestion(message)) {
      facts.explainIntent = role === "attorney" ? "attorney_first_steps" : "paralegal_first_steps";
      return facts;
    }

    if (isSimpleExplainQuestion(message)) {
      if (previousTopicKey === "profile_guidance") {
        facts.explainIntent = "profile_simple";
        return facts;
      }
      if (["payout_support", "stripe_guidance"].includes(previousTopicKey)) {
        facts.stripeState = await getStripeConnectSnapshot(user);
        facts.explainIntent = "stripe_simple";
        return facts;
      }
      if (previousTopicKey === "messaging_support") {
        facts.explainIntent = "messaging_simple";
        return facts;
      }
      facts.explainIntent = role === "attorney" ? "attorney_workflow_simple" : "paralegal_workflow_simple";
      return facts;
    }

    if (role === "paralegal" && isProfileSetupQuestion(message)) {
      facts.explainIntent = "profile_setup";
      return facts;
    }

    if (isPlatformOverviewQuestion(message)) {
      if (role === "paralegal" && /\b(profile|headline|bio|summary|experience|skills?)\b/i.test(String(message || ""))) {
        facts.explainIntent = "profile";
        return facts;
      }
      if (role === "paralegal" && /\bmessage|messages|chat|thread|inbox\b/i.test(String(message || ""))) {
        facts.explainIntent = "messaging_workflow";
        return facts;
      }
      if (role === "paralegal" && /\bcase|cases|workspace|matter|matters|apply|application\b/i.test(String(message || ""))) {
        facts.explainIntent = "paralegal_workflow";
        return facts;
      }
      if (role === "attorney" && /\bcase|cases|workspace|matter|fund|billing|payment\b/i.test(String(message || ""))) {
        facts.explainIntent = "attorney_workflow";
        return facts;
      }
      facts.explainIntent = "platform_overview";
      return facts;
    }

    if (role === "paralegal" && /\b(stripe|payout|bank account|get paid)\b/i.test(String(message || ""))) {
      facts.stripeState = await getStripeConnectSnapshot(user);
      facts.explainIntent = "stripe";
      return facts;
    }

    if (role === "paralegal" && /\b(apply|job|jobs|case|cases|matter|matters)\b/i.test(String(message || ""))) {
      facts.explainIntent = "apply";
      return facts;
    }

    if (
      role === "paralegal" &&
      /\b(profile|headline|bio|summary|experience|skills?)\b/i.test(String(message || "")) &&
      /\b(stand out|improve|better|stronger|complete|polish|best|help)\b/i.test(String(message || ""))
    ) {
      facts.explainIntent = "profile";
      return facts;
    }

    if (role === "attorney" && /\b(case|cases|workspace|matter|fund|billing|payment)\b/i.test(String(message || ""))) {
      facts.explainIntent = "attorney_workflow";
      return facts;
    }

    return facts;
  }

  if (task === "TROUBLESHOOT") {
    if (troubleshootIntent === "account_access") {
      return {
        userRole: role,
        troubleshootIntent,
      };
    }
    if (troubleshootIntent === "billing") {
      return {
        userRole: role,
        billingMethodState: await getBillingMethodSnapshot(user, effectivePageContext),
        troubleshootIntent,
      };
    }
    if (troubleshootIntent === "payout") {
      const stripeState = await getStripeConnectSnapshot(user);
      const caseState = activeEntity ? await getCaseSnapshot(user, effectivePageContext) : {};
      return {
        userRole: role,
        caseState:
          caseState?.caseId && activeEntitySource && !["page_context", "memory", "case_name_match"].includes(activeEntitySource)
            ? { ...caseState, inferred: true, inferenceSource: activeEntitySource }
            : caseState,
        stripeState,
        payoutState: await getPayoutSnapshot(user, effectivePageContext, {
          stripeSnapshot: stripeState,
          caseSnapshot: caseState,
        }),
        troubleshootIntent,
      };
    }
    if (troubleshootIntent === "case_payment") {
      const caseState = await getCaseSnapshot(user, effectivePageContext);
      return {
        userRole: role,
        caseState:
          caseState?.caseId && activeEntitySource && !["page_context", "memory", "case_name_match"].includes(activeEntitySource)
            ? { ...caseState, inferred: true, inferenceSource: activeEntitySource }
            : caseState,
        payoutState: await getPayoutSnapshot(user, effectivePageContext, { caseSnapshot: caseState }),
        troubleshootIntent,
      };
    }
    if (["messaging", "workspace", "general", "payment_ambiguous"].includes(troubleshootIntent)) {
      const caseState = await getCaseSnapshot(user, {
        ...effectivePageContext,
        supportCategory: troubleshootIntent === "messaging" ? "messaging" : "workspace_access",
      });
      const workspaceState = await getWorkspaceAccessSnapshot(user, effectivePageContext, caseState);
      const facts = {
        userRole: role,
        caseState:
          caseState?.caseId && activeEntitySource && !["page_context", "memory", "case_name_match"].includes(activeEntitySource)
            ? { ...caseState, inferred: true, inferenceSource: activeEntitySource }
            : caseState,
        workspaceState,
        troubleshootIntent,
      };
      if (troubleshootIntent === "messaging") {
        facts.messagingState = await getMessagingSnapshot(user, effectivePageContext, {
          caseSnapshot: caseState,
          workspaceSnapshot: workspaceState,
        });
      }
      return facts;
    }
  }

  if (task === "HUMAN_ISSUE") {
    const caseState = activeEntity
      ? await getCaseSnapshot(user, effectivePageContext)
      : { caseId: "", title: "", found: false, accessible: false };
    const participantState = caseState?.caseId ? await getCaseParticipantSnapshot(caseState) : {};
    return {
      userRole: role,
      caseState:
        caseState?.caseId && activeEntitySource && !["page_context", "memory", "case_name_match"].includes(activeEntitySource)
          ? { ...caseState, inferred: true, inferenceSource: activeEntitySource }
          : caseState,
      participantState,
      humanIssue: "responsiveness",
    };
  }

  return {
    userRole: role,
    unknown: true,
  };
}

function chooseTaskResponseType({
  task = "UNKNOWN",
  message = "",
  previousState = {},
  activeEntity = null,
  facts = {},
} = {}) {
  if (task === "ESCALATION") return "ESCALATE";
  if (task === "HUMAN_ISSUE") {
    if (previousState.escalationShown === true || /\b(still|again|nothing|yet|same)\b/i.test(String(message || ""))) {
      return "ESCALATE";
    }
    return "ANSWER";
  }
  if (task === "NAVIGATION") {
    const navigation = resolveNavigationTarget({
      text: message,
      pageContext: {},
      supportFacts: facts,
      previousState,
    });
    return navigation.mode === "resolved" ? "ANSWER" : "ASK";
  }
  if (task === "EXPLAIN") {
    return "ANSWER";
  }
  if (task === "FACT_LOOKUP") {
    if (detectFactLookupIntent(message) !== "stripe" && !activeEntity) return "ASK";
    return "ANSWER";
  }
  if (task === "TROUBLESHOOT") {
    const troubleshootIntent = detectTroubleshootIntent(message, facts.userRole || "");
    if (["messaging", "workspace", "case_payment"].includes(troubleshootIntent) && !activeEntity) {
      return "ASK";
    }
    return "ANSWER";
  }
  return "ASK";
}

function resolveNavigationTarget({ text = "", pageContext = {}, supportFacts = {}, previousState = {} } = {}) {
  const normalized = String(text || "").trim().toLowerCase();
  const continuingApplicationsFollowUp =
    String(previousState.awaitingField || "").toLowerCase() === "applications_navigation" &&
    isAffirmativeSupportReply(normalized);
  const role = String(supportFacts.userRole || pageContext.roleHint || "").trim().toLowerCase();
  const caseState = supportFacts.caseState || {};
  const caseId = trimString(caseState.caseId || pageContext.caseId, 80);
  const caseAccessible = Boolean(caseId && caseState.accessible !== false);
  const asksToUpdate = hasPatternMatch(normalized, [/\b(update|change|edit|manage|set up|setup|connect)\b/i]);
  const asksToOpen = asksToUpdate || hasPatternMatch(normalized, [/\b(open|see|view|go to|get to|access)\b/i]);
  const genericReference = hasPatternMatch(normalized, [/\b(that|it|this|there)\b/i]);
  const selectedTopicOption = resolveTopicSelection(normalized, previousState);
  const explicitTopicSelection =
    String(previousState.awaitingField || "").toLowerCase() === "topic_selection" ||
    getTopicSelectionOptions(previousState).length > 0;
  if (!normalized || (!hasNavigationLead(normalized) && !continuingApplicationsFollowUp && !selectedTopicOption)) {
    if (hasPreviousNavigationReference(normalized, previousState)) {
      return {
        mode: "resolved",
        reply: buildNavigationReplyText("open"),
        navigation: buildNavigationPayload({
          ctaLabel: trimString(previousState.lastNavigationLabel, 120) || "That page",
          ctaHref: trimString(previousState.lastNavigationHref, 500),
          ctaType: "deep_link",
        }),
      };
    }
    return { mode: "none", navigation: null, reply: "" };
  }

  if (hasPreviousNavigationReference(normalized, previousState)) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("open"),
      navigation: buildNavigationPayload({
        ctaLabel: trimString(previousState.lastNavigationLabel, 120) || "That page",
        ctaHref: trimString(previousState.lastNavigationHref, 500),
        ctaType: "deep_link",
      }),
    };
  }

  if (explicitTopicSelection && selectedTopicOption === "billing" && role === "attorney") {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText(asksToUpdate ? "update" : "find"),
      navigation: buildNavigationPayload({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
        ctaType: "deep_link",
      }),
    };
  }

  if (explicitTopicSelection && selectedTopicOption === "theme_preferences") {
    return {
      mode: "resolved",
      reply: "Yes — you can change that in Preferences.",
      navigation: buildNavigationPayload({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
        ctaType: "deep_link",
      }),
    };
  }

  if (explicitTopicSelection && selectedTopicOption === "applications" && role === "paralegal") {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("open"),
      navigation: buildNavigationPayload({
        ctaLabel: "My applications",
        ctaHref: "dashboard-paralegal.html#cases",
        ctaType: "deep_link",
      }),
    };
  }

  if (explicitTopicSelection && ["profile_setup", "payouts", "messages", "applications"].includes(selectedTopicOption)) {
    return { mode: "none", navigation: null, reply: "" };
  }

  if (
    role === "attorney" &&
    hasPatternMatch(normalized, [/\b(invoices?|receipts?)\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("find"),
      navigation: buildNavigationPayload({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    hasPatternMatch(normalized, [/\b(security|security settings|password reset|reset password)\b/i]) &&
    !hasPatternMatch(normalized, [/\bpayment security\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText(asksToUpdate ? "update" : "open"),
      navigation: buildNavigationPayload({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    hasPatternMatch(normalized, [/\bpreferences?\b/i]) &&
    !hasPatternMatch(normalized, [/\bnotification preferences?\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText(asksToUpdate ? "update" : "open"),
      navigation: buildNavigationPayload({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    hasPatternMatch(normalized, [/\b(dark mode|light mode|theme|appearance)\b/i])
  ) {
    return {
      mode: "resolved",
      reply: "Yes — you can change that in Preferences.",
      navigation: buildNavigationPayload({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "paralegal" &&
    hasPatternMatch(normalized, [/\b(profile readiness|profile ready|account readiness)\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("open"),
      navigation: buildNavigationPayload({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "paralegal" &&
    hasPatternMatch(normalized, [/\b(cases?|jobs?|matters?)\b/i]) &&
    hasPatternMatch(normalized, [/\bapply\b/i, /\bbrowse\b/i])
  ) {
    const applyWorkflowQuestion = hasPatternMatch(normalized, [
      /\bwhen can i apply\b/i,
      /\bhow does it work\b/i,
      /\bhow do(?:es)? (?:that|it) work\b/i,
      /\bhow (?:can|do) i apply\b/i,
    ]);
    return {
      mode: "resolved",
      reply: applyWorkflowQuestion
        ? "You can apply when a case is open to applicants. You can browse open cases here."
        : buildNavigationReplyText("find"),
      navigation: buildNavigationPayload({
        ctaLabel: "Browse cases",
        ctaHref: "browse-jobs.html",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "admin" && hasPatternMatch(normalized, [/\bsupport (?:queue|tickets|ops)\b/i, /\bticket queue\b/i])) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("open"),
      navigation: buildNavigationPayload({
        ctaLabel: "Support queue",
        ctaHref: "admin-dashboard.html#support-ops",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "attorney" &&
    hasPatternMatch(normalized, [/\bbrowse\b/i, /\bfind\b/i, /\bsee\b/i]) &&
    hasPatternMatch(normalized, [/\bparalegals?\b/i, /\blawyers?\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("find"),
      navigation: buildNavigationPayload({
        ctaLabel: "Browse paralegals",
        ctaHref: "browse-paralegals.html",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "paralegal" &&
    hasPatternMatch(normalized, [/\b(applications?|resume application)\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("open"),
      navigation: buildNavigationPayload({
        ctaLabel: "My applications",
        ctaHref: "dashboard-paralegal.html#cases",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "paralegal" && continuingApplicationsFollowUp) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("open"),
      navigation: buildNavigationPayload({
        ctaLabel: "My applications",
        ctaHref: "dashboard-paralegal.html#cases",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "paralegal" &&
    hasPatternMatch(normalized, [/\b(my payouts|payout history|payouts history|see my payouts)\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("find"),
      navigation: buildNavigationPayload({
        ctaLabel: "Completed cases",
        ctaHref: "dashboard-paralegal.html#cases-completed",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "paralegal" &&
    hasPatternMatch(normalized, [/\b(completed matters|completed cases|finished matters|closed matters)\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("find"),
      navigation: buildNavigationPayload({
        ctaLabel: "Completed cases",
        ctaHref: "dashboard-paralegal.html#cases-completed",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    hasPatternMatch(normalized, [
      /\b(profile settings|account settings|settings page)\b/i,
      /\bprofile\b/i,
    ]) &&
    !hasPatternMatch(normalized, [/\bprofile photo\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText(asksToUpdate ? "update" : "open"),
      navigation: buildNavigationPayload({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "attorney" &&
    hasPatternMatch(normalized, [/\b(my cases|cases & files|case list|all cases)\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("open"),
      navigation: buildNavigationPayload({
        ctaLabel: "Cases & Files",
        ctaHref: "dashboard-attorney.html#cases",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "attorney" &&
    hasPatternMatch(normalized, [/\bfund(?:ing)?\b/i, /\bpay for\b/i]) &&
    hasPatternMatch(normalized, [/\bcase\b/i, /\bmatter\b/i])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("open"),
      navigation: buildNavigationPayload({
        ctaLabel: "Cases & Files",
        ctaHref: "dashboard-attorney.html#cases",
        ctaType: "deep_link",
      }),
    };
  }

  if (hasPatternMatch(normalized, [/\b(upload|share)\b/i, /\b(documents?|files?)\b/i])) {
    if (caseAccessible) {
      return {
        mode: "resolved",
        reply: buildNavigationReplyText("open"),
        navigation: buildNavigationPayload({
          ctaLabel: caseState.title || "Case workspace",
          ctaHref: buildCaseHref(caseId),
          ctaType: "deep_link",
        }),
      };
    }
    return {
      mode: "resolved",
      reply: buildNavigationReplyText("open"),
      navigation: buildNavigationPayload({
        ctaLabel: role === "attorney" ? "Cases & Files" : "Cases and Applications",
        ctaHref: role === "attorney" ? "dashboard-attorney.html#cases" : "dashboard-paralegal.html#cases",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "attorney" &&
    hasPatternMatch(normalized, [
      /\bbilling\b/i,
      /\bfunds(?:\s*&\s*payments|\s+and\s+payments)?\b/i,
      /\bpayment method\b/i,
      /\bbilling method\b/i,
      /\bsaved card\b/i,
      /\bcard on file\b/i,
    ])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText(asksToUpdate ? "update" : "find"),
      navigation: buildNavigationPayload({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
        ctaType: "deep_link",
      }),
    };
  }

  if (
    role === "paralegal" &&
    hasPatternMatch(normalized, [
      /\bstripe onboarding\b/i,
      /\bopen stripe setup\b/i,
      /\bconnect stripe\b/i,
      /\bpayout settings?\b/i,
      /\bpayout setup\b/i,
      /\bpayout account\b/i,
      /\bbank account\b/i,
      /\breceive payouts?\b/i,
      /\bsecurity\b/i,
      /\bbilling\b/i,
    ])
  ) {
    return {
      mode: "resolved",
      reply: buildNavigationReplyText(asksToUpdate ? "update" : "open"),
      navigation: buildNavigationPayload({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
        ctaType: "deep_link",
      }),
    };
  }

  if (hasPatternMatch(normalized, [/\b(messages?|chat|conversation)\b/i])) {
    if (caseAccessible) {
      return {
        mode: "resolved",
        reply: buildNavigationReplyText("open"),
        navigation: buildNavigationPayload({
          ctaLabel: "Case messages",
          ctaHref: buildCaseHref(caseId, "#case-messages"),
          ctaType: "deep_link",
        }),
      };
    }
    return {
      mode: "clarify",
      navigation: null,
      reply: "Is this for a specific case?",
    };
  }

  if (hasPatternMatch(normalized, [/\b(case|workspace|matter)\b/i])) {
    if (caseAccessible) {
      return {
        mode: "resolved",
        reply: buildNavigationReplyText("open"),
        navigation: buildNavigationPayload({
          ctaLabel: caseState.title || "Case workspace",
          ctaHref: buildCaseHref(caseId),
          ctaType: "deep_link",
        }),
      };
    }
    return {
      mode: "clarify",
      navigation: null,
      reply: "Which case are you trying to open?",
    };
  }

  if (hasPatternMatch(normalized, [/\bsupport\b/i, /\bhelp\b/i])) {
    if (genericReference) {
      return {
        mode: "clarify",
        navigation: null,
        reply: "Are you looking for billing, messages, profile settings, or a specific case?",
      };
    }
    return {
      mode: "resolved",
      navigation: null,
      reply: "You're already here.",
    };
  }

  if (genericReference) {
    return {
      mode: "clarify",
      navigation: null,
      reply: "Are you looking for billing, messages, profile settings, or a specific case?",
    };
  }

  return {
    mode: "none",
    navigation: null,
    reply: "",
  };
}

function detectPaymentSubIntent({ text = "", analysis = {}, supportFacts = {}, pageContext = {} } = {}) {
  const normalized = String(text || "").trim().toLowerCase();
  const role = String(supportFacts.userRole || "").toLowerCase();
  const hasCaseContext = Boolean(pageContext.caseId || supportFacts.caseState?.caseId);
  const hasBillingMethodData = Boolean(
    supportFacts.billingMethodState?.available || pageContext.paymentMethod?.last4 || pageContext.paymentMethod?.brand
  );
  const onBillingView = String(pageContext.viewName || "").toLowerCase() === "billing";

  const payoutPatterns = [
    /\bpayout\b/i,
    /\bget paid\b/i,
    /\bpaid yet\b/i,
    /\bstripe\b/i,
    /\bconnect account\b/i,
    /\bbank account\b/i,
    /\bpayouts enabled\b/i,
    /\bonboarding\b/i,
    /\bwhere is my payout\b/i,
    /\bwhy can'?t i get paid\b/i,
    /\bmy money didn'?t come\b/i,
    /\bmy money did not come\b/i,
    /\bwhere are my payouts?\b/i,
  ];
  const billingPatterns = [
    /\bpayment method\b/i,
    /\bbilling method\b/i,
    /\bsaved payment\b/i,
    /\bsaved card\b/i,
    /\bcard on file\b/i,
    /\bcredit card\b/i,
    /\bdebit card\b/i,
    /\bcard declined\b/i,
    /\bdeclined card\b/i,
    /\bdeclined\b/i,
    /\bupdate (?:my )?card\b/i,
    /\bupdate (?:my )?billing\b/i,
    /\bupdate (?:my )?billing method\b/i,
    /\bupdate (?:my )?payment method\b/i,
    /\bmanage (?:my )?billing\b/i,
  ];
  const billingRecordPatterns = [/\breceipts?\b/i, /\binvoices?\b/i];
  const casePaymentPatterns = [
    /\bescrow\b/i,
    /\bpayment release\b/i,
    /\btransaction\b/i,
    /\bcheckout\b/i,
    /\bcharged\b/i,
    /\bcharge\b/i,
    /\bcase payment\b/i,
    /\bfund(?:ing)? (?:a |this |my )?case\b/i,
  ];
  const hasPaymentSignal =
    payoutPatterns.some((pattern) => pattern.test(normalized)) ||
    billingPatterns.some((pattern) => pattern.test(normalized)) ||
    billingRecordPatterns.some((pattern) => pattern.test(normalized)) ||
    casePaymentPatterns.some((pattern) => pattern.test(normalized)) ||
    /\bpayment\b/i.test(normalized);

  if (!hasPaymentSignal) {
    return "none";
  }

  if (String(analysis.category || "").toLowerCase() === "stripe_onboarding") {
    return "payout";
  }
  if ((onBillingView || hasBillingMethodData) && role === "attorney" && (
    billingPatterns.some((pattern) => pattern.test(normalized)) ||
    billingRecordPatterns.some((pattern) => pattern.test(normalized)) ||
    /\bbilling\b/i.test(normalized)
  )) {
    return "billing_method";
  }
  if (payoutPatterns.some((pattern) => pattern.test(normalized))) {
    return "payout";
  }
  if (billingRecordPatterns.some((pattern) => pattern.test(normalized))) {
    return role === "attorney" ? "billing_method" : "case_payment";
  }
  if (billingPatterns.some((pattern) => pattern.test(normalized))) {
    return role === "attorney" ? "billing_method" : "unclear";
  }
  if (casePaymentPatterns.some((pattern) => pattern.test(normalized)) || hasCaseContext) {
    return "case_payment";
  }
  if (role === "paralegal" && /\bpayment\b/i.test(normalized)) {
    return "payout";
  }
  if (role === "attorney" && /\bpayment\b/i.test(normalized)) {
    return "unclear";
  }
  return "unclear";
}

function mapPrimaryAskToCategory(primaryAsk = "", fallbackCategory = "unknown") {
  const ask = String(primaryAsk || "").trim().toLowerCase();
  if (["billing_payment_method", "payment_clarify", "payout_question", "case_payment"].includes(ask)) return "payment";
  if (ask === "stripe_onboarding") return "stripe_onboarding";
  if (["participant_lookup", "case_status", "help_with_case", "workspace_access"].includes(ask)) return "case_posting";
  if (ask === "messaging_access") return "messaging";
  if (ask === "profile_save") return "profile_save";
  if (ask === "password_reset") return "password_reset";
  if (ask === "responsiveness_issue") return "interaction_responsiveness_issue";
  if (ask === "product_guidance") return "unknown";
  if (ask === "request_human_help") return "unknown";
  return String(fallbackCategory || "unknown").trim().toLowerCase() || "unknown";
}

function inferParticipantRoleRequested(text = "") {
  if (/\battorney\b/i.test(String(text || ""))) return "attorney";
  if (/\bparalegal\b/i.test(String(text || ""))) return "paralegal";
  return "";
}

function buildActiveEntity({ type = "", id = "", name = "", source = "" } = {}) {
  return {
    type: trimString(type, 80),
    id: trimString(id, 120),
    name: trimString(name, 240),
    source: trimString(source, 120),
  };
}

function detectPrimaryAsk({
  text = "",
  analysis = {},
  supportFacts = {},
  pageContext = {},
  conversationState = {},
  issueLifecycle = null,
  paymentSubIntent = "",
  task = "",
  promptAction = null,
} = {}) {
  const normalized = String(text || "").trim();
  const lowered = normalized.toLowerCase();
  const compact = lowered.replace(/[^a-z0-9]+/g, " ").trim();
  const activeAsk = String(conversationState.activeAsk || "").trim().toLowerCase();
  const strongNewAsk = shouldTreatAsStrongNewAsk(normalized, activeAsk);
  const vagueSupportInput = isVagueSupportInput(normalized);
  const normalizedCategory = String(analysis.category || "").toLowerCase();

  if (isGratitudeClosure(normalized, conversationState)) {
    return "issue_resolved";
  }
  if (/\b(nothing is blocking me|never mind|all good|it'?s working now|resolved now|figured it out|that fixed it|fixed now|solved it)\b/i.test(normalized)) {
    return "issue_resolved";
  }
  if (
    hasIssueReopenSignal(normalized) &&
    isResolvedIssueState({
      conversationState,
      issueLifecycle,
      promptAction,
    })
  ) {
    return "issue_reopen";
  }
  if (trimString(promptAction?.intent, 80) === "issue_review_status") {
    return "issue_review_status";
  }
  if (
    (conversationState.escalationSent === true || trimString(conversationState.currentIssueLabel, 180)) &&
    /\b(when will (it|this) be (fixed|resolved)|when(?:'s| is) it going to be fixed|how long (will|does) (it|this) take|eta|timeline|any update|is there (an|any) update|what(?:'s| is) the update|when can i expect|when will i hear back|when will it be done)\b/i.test(
      normalized
    )
  ) {
    return "issue_review_status";
  }
  if (
    trimString(conversationState.proactiveIssueLabel, 180) &&
    /\b(check on|check in on|status of|update on|my open .* issue|open support issue)\b/i.test(normalized)
  ) {
    return "issue_review_status";
  }
  if (hasCurrentIssueStatusReference(normalized, conversationState, issueLifecycle)) {
    return "issue_review_status";
  }
  if (/\bmy money didn'?t come\b/i.test(normalized)) {
    return "payout_question";
  }
  if (
    [
      "help",
      "support",
      "question",
      "customer service",
      "customer support",
      "need support",
      "need assistance",
    ].includes(compact)
  ) {
    return "generic_intake";
  }
  if (compact === "payment") {
    return String(supportFacts.userRole || "").toLowerCase() === "attorney"
      ? "payment_clarify"
      : "payout_question";
  }
  if (detectSplitSupportRequest(normalized, supportFacts.userRole || "").length) {
    return "generic_intake";
  }
  if (detectOverloadedSupportRequest(normalized)) {
    return "generic_intake";
  }
  if (task === "ESCALATION") {
    return "request_human_help";
  }
  if (task === "HUMAN_ISSUE") {
    return "responsiveness_issue";
  }
  if (task === "NAVIGATION") {
    if (paymentSubIntent === "billing_method") {
      return "billing_payment_method";
    }
    return "navigation";
  }
  if (task === "EXPLAIN") {
    return "product_guidance";
  }
  if (
    /\bapply\b/i.test(normalized) &&
    /\b(job|jobs|case|cases|matter|matters)\b/i.test(normalized)
  ) {
    return "navigation";
  }
  if (task === "FACT_LOOKUP") {
    const lookupIntent = detectFactLookupIntent(normalized);
    if (lookupIntent === "participant") return "participant_lookup";
    if (lookupIntent === "status") return "case_status";
    if (lookupIntent === "stripe") return "stripe_onboarding";
    return "help_with_case";
  }
  if (task === "TROUBLESHOOT") {
    const troubleshootIntent = detectTroubleshootIntent(normalized, supportFacts.userRole || "");
    if (troubleshootIntent === "account_access") return "password_reset";
    if (troubleshootIntent === "profile_save") return "profile_save";
    if (troubleshootIntent === "billing") return "billing_payment_method";
    if (troubleshootIntent === "payout") {
      return String(analysis.category || "").toLowerCase() === "stripe_onboarding"
        ? "stripe_onboarding"
        : "payout_question";
    }
    if (troubleshootIntent === "case_payment") return "case_payment";
    if (troubleshootIntent === "workspace") return "workspace_access";
    if (troubleshootIntent === "messaging") return "messaging_access";
    if (troubleshootIntent === "payment_ambiguous") return "payment_clarify";
  }
  if (vagueSupportInput && paymentSubIntent === "none" && normalizedCategory === "unknown" && !hasNavigationLead(lowered)) {
    if (conversationState.awaitingField) {
      return activeAsk || String(analysis.category || "unknown").toLowerCase() || "unknown";
    }
    return "generic_intake";
  }
  if (
    /\b(workspace|case page|case workspace)\b/i.test(normalized) &&
    /\b(blank|empty|won'?t load|wont load|not loading|isn'?t loading|isnt loading)\b/i.test(normalized)
  ) {
    return "workspace_access";
  }
  if (/\b(can'?t access|cannot access|locked out of)\b/i.test(normalized) && /\b(workspace|case|matter)\b/i.test(normalized)) {
    return "workspace_access";
  }
  if (/\bwho(?:'s| is)?\b.*\b(attorney|paralegal)\b/i.test(normalized)) {
    return "participant_lookup";
  }
  if (
    String(analysis.category || "").toLowerCase() === "interaction_responsiveness_issue" ||
    /\b(won'?t respond|not responding|isn'?t responding|hasn'?t replied|hasn'?t answered|waiting on them|ignoring|haven'?t heard back|he hasn'?t answered|she hasn'?t answered)\b/i.test(
      normalized
    )
  ) {
    return "responsiveness_issue";
  }
  if (/\b(status|paused|relisted|archived)\b/i.test(normalized) && /\b(case|matter|workspace|this case)\b/i.test(normalized)) {
    return "case_status";
  }
  if (paymentSubIntent === "billing_method") {
    return "billing_payment_method";
  }
  if (paymentSubIntent === "case_payment") {
    return "case_payment";
  }
  if (paymentSubIntent === "unclear") {
    return "payment_clarify";
  }
  if (paymentSubIntent === "payout") {
    return String(analysis.category || "").toLowerCase() === "stripe_onboarding"
      ? "stripe_onboarding"
      : "payout_question";
  }
  if (hasNavigationLead(lowered)) {
    return "navigation";
  }
  if (
    String(analysis.category || "").toLowerCase() === "messaging" ||
    /\b(can'?t send messages?|chat not working|messages? not working|can'?t message|cannot message)\b/i.test(normalized)
  ) {
    return "messaging_access";
  }
  if (
    /\b(human|person|team|someone)\b/i.test(normalized) &&
    /\b(help|review|respond|contact|support)\b/i.test(normalized)
  ) {
    return "request_human_help";
  }
  if (
    String(analysis.category || "").toLowerCase() === "case_posting" ||
    /\b(help with (?:a|my) case|help with this case|case help)\b/i.test(normalized)
  ) {
    return "help_with_case";
  }
  if (/\b(profile readiness|profile ready|account readiness)\b/i.test(normalized)) {
    return "navigation";
  }
  if (strongNewAsk) {
    if (normalizedCategory === "unknown" || !normalizedCategory) {
      return "generic_intake";
    }
    return String(analysis.category || "unknown").toLowerCase() || "unknown";
  }
  return activeAsk || String(analysis.category || "unknown").toLowerCase() || "unknown";
}

function resolveActiveEntity({
  primaryAsk = "",
  pageContext = {},
  supportFacts = {},
  conversationState = {},
  resolvedCaseId = "",
  resolvedCaseSource = "",
} = {}) {
  const caseState = supportFacts.caseState || {};
  const billingMethodState = supportFacts.billingMethodState || {};
  const caseEntityPreferred = [
    "participant_lookup",
    "case_status",
    "help_with_case",
    "workspace_access",
    "messaging_access",
    "responsiveness_issue",
    "case_payment",
  ].includes(primaryAsk);

  if (caseEntityPreferred) {
    if (resolvedCaseId) {
      return {
        entity: buildActiveEntity({
          type: "case",
          id: resolvedCaseId,
          name: supportFacts.caseState?.title || "",
          source: resolvedCaseSource || "resolved_case",
        }),
        awaitingField: "",
      };
    }
    if (caseState.caseId) {
      return {
        entity: buildActiveEntity({
          type: "case",
          id: caseState.caseId,
          name: caseState.title,
          source: pageContext.caseId ? "page_context" : caseState.inferred ? "inferred_case" : "case_snapshot",
        }),
        awaitingField: "",
      };
    }
    if (conversationState.activeEntity?.type === "case" && conversationState.activeEntity?.id) {
      return {
        entity: buildActiveEntity(conversationState.activeEntity),
        awaitingField: "",
      };
    }
    return {
      entity: buildActiveEntity({ type: "case" }),
      awaitingField: "case_identifier",
    };
  }

  if (primaryAsk === "billing_payment_method") {
    return {
      entity: buildActiveEntity({
        type: "billing_account",
        id: supportFacts.billingMethodState?.available ? "billing_method" : "",
        name: billingMethodState.available ? "Saved payment method" : "",
        source: String(pageContext.viewName || "").toLowerCase() === "billing" ? "billing_view" : "account",
      }),
      awaitingField: "",
    };
  }

  if (primaryAsk === "payment_clarify") {
    return {
      entity: buildActiveEntity({
        type: "payment",
        source: "payment_question",
      }),
      awaitingField: "",
    };
  }

  if (["payout_question", "stripe_onboarding"].includes(primaryAsk)) {
    return {
      entity: buildActiveEntity({
        type: "payout_account",
        id: supportFacts.stripeState?.accountId || supportFacts.payoutState?.relevantCaseId || "",
        name: supportFacts.payoutState?.relevantCaseTitle || "",
        source: supportFacts.stripeState?.accountId ? "stripe_account" : "recent_payout_context",
      }),
      awaitingField: "",
    };
  }

  return {
    entity: buildActiveEntity(conversationState.activeEntity || {}),
    awaitingField: "",
  };
}

function selectRelevantSupportFacts(primaryAsk = "", supportFacts = {}) {
  if (primaryAsk === "participant_lookup") {
    return {
      userRole: supportFacts.userRole,
      caseState: supportFacts.caseState,
      participantState: supportFacts.participantState,
    };
  }
  if (["case_status", "help_with_case"].includes(primaryAsk)) {
    return {
      userRole: supportFacts.userRole,
      caseState: supportFacts.caseState,
      workspaceState: supportFacts.workspaceState,
    };
  }
  if (primaryAsk === "workspace_access") {
    return {
      userRole: supportFacts.userRole,
      caseState: supportFacts.caseState,
      workspaceState: supportFacts.workspaceState,
    };
  }
  if (primaryAsk === "navigation") {
    return {
      userRole: supportFacts.userRole,
      caseState: supportFacts.caseState,
      participantState: supportFacts.participantState,
      billingMethodState: supportFacts.billingMethodState,
    };
  }
  if (primaryAsk === "product_guidance") {
    return {
      userRole: supportFacts.userRole,
      explainIntent: supportFacts.explainIntent,
      onboardingState: supportFacts.onboardingState,
      stripeState: supportFacts.stripeState,
    };
  }
  if (["billing_payment_method", "payment_clarify"].includes(primaryAsk)) {
    return {
      userRole: supportFacts.userRole,
      billingMethodState: supportFacts.billingMethodState,
    };
  }
  if (primaryAsk === "case_payment") {
    return {
      userRole: supportFacts.userRole,
      caseState: supportFacts.caseState,
      workspaceState: supportFacts.workspaceState,
      payoutState: supportFacts.payoutState,
    };
  }
  if (["payout_question", "stripe_onboarding"].includes(primaryAsk)) {
    return {
      userRole: supportFacts.userRole,
      stripeState: supportFacts.stripeState,
      payoutState: supportFacts.payoutState,
      caseState: supportFacts.caseState,
    };
  }
  if (primaryAsk === "messaging_access") {
    return {
      userRole: supportFacts.userRole,
      caseState: supportFacts.caseState,
      workspaceState: supportFacts.workspaceState,
      messagingState: supportFacts.messagingState,
    };
  }
  if (primaryAsk === "responsiveness_issue") {
    return {
      userRole: supportFacts.userRole,
      caseState: supportFacts.caseState,
      participantState: supportFacts.participantState,
    };
  }
  return {
    userRole: supportFacts.userRole,
  };
}

function chooseResponseMode({
  primaryAsk = "",
  activeEntity = {},
  navigation = {},
  conversationState = {},
  text = "",
  frustration = {},
  escalation = {},
} = {}) {
  if (primaryAsk === "issue_resolved") return "DIRECT_ANSWER";
  if (primaryAsk === "issue_reopen") return "DIRECT_ANSWER";
  if (primaryAsk === "issue_review_status") return "DIRECT_ANSWER";
  if (navigation.mode === "resolved") return "DIRECT_ANSWER";
  if (primaryAsk === "request_human_help") return "ESCALATE";
  if (primaryAsk === "payment_clarify") return "CLARIFY_ONCE";
  if (primaryAsk === "case_payment" && activeEntity.awaitingField) return "CLARIFY_ONCE";
  if (navigation.mode === "clarify" || activeEntity.awaitingField) return "CLARIFY_ONCE";
  if (primaryAsk === "generic_intake") return "CLARIFY_ONCE";
  if (
    primaryAsk === "responsiveness_issue" &&
    (conversationState.escalationOffered === true || /\b(still|again|nothing|yet|same)\b/i.test(String(text || "")))
  ) {
    return "ESCALATE";
  }
  if (escalation.needsEscalation && conversationState.escalationOffered === true) {
    return "ESCALATE";
  }
  return "DIRECT_ANSWER";
}

function orchestrateSupportTurn({
  text = "",
  analysis = {},
  pageContext = {},
  supportFacts = {},
  conversationState = {},
  issueLifecycle = null,
  frustration = {},
  task = "",
  resolvedCaseId = "",
  resolvedCaseSource = "",
  promptAction = null,
} = {}) {
  const resolvedTask = String(task || getPrimaryTask(text, conversationState)).toUpperCase();
  const paymentSubIntent =
    ["HUMAN_ISSUE", "ESCALATION"].includes(resolvedTask)
      ? "none"
      : detectPaymentSubIntent({ text, analysis, supportFacts, pageContext });
  const primaryAsk = detectPrimaryAsk({
    text,
    analysis,
    supportFacts,
    pageContext,
    conversationState,
    issueLifecycle,
    paymentSubIntent,
    task: resolvedTask,
    promptAction,
  });
  const normalizedCategory = mapPrimaryAskToCategory(primaryAsk, analysis.category);
  const shouldDeferToTopicSelection =
    primaryAsk === "generic_intake" &&
    (detectSplitSupportRequest(text, supportFacts.userRole || "").length || detectOverloadedSupportRequest(text));
  const navigation = shouldDeferToTopicSelection
    ? { mode: "none", navigation: null, reply: "" }
    : resolveNavigationTarget({
        text,
        pageContext: {
          ...pageContext,
          supportCategory: normalizedCategory,
        },
        supportFacts,
        previousState: conversationState,
      });
  const entityResolution = resolveActiveEntity({
    primaryAsk,
    pageContext,
    supportFacts,
    conversationState,
    resolvedCaseId,
    resolvedCaseSource,
  });
  const relevantFacts = selectRelevantSupportFacts(primaryAsk, supportFacts);
  const draftEscalation = deriveEscalation({
    category: normalizedCategory,
    facts: relevantFacts,
    confidence: deriveConfidence(normalizedCategory, supportFacts),
    options: { paymentSubIntent },
  });
  const responseMode = chooseResponseMode({
    primaryAsk,
    activeEntity: entityResolution,
    navigation,
    conversationState,
    text,
    frustration,
    escalation: draftEscalation,
  });

  return {
    task: resolvedTask,
    primaryAsk,
    category: normalizedCategory,
    paymentSubIntent,
    activeEntity: entityResolution.entity,
    awaitingField: entityResolution.awaitingField,
    responseMode,
    navigation,
    relevantFacts,
  };
}

function buildBillingMethodReply(facts = {}) {
  const billingMethodState = facts.billingMethodState || {};
  if (billingMethodState.available) {
    const brand = billingMethodState.brand ? String(billingMethodState.brand).toUpperCase() : "Card";
    const last4 = billingMethodState.last4 ? ` ending in ${billingMethodState.last4}` : "";
    const expiry = billingMethodState.exp_month && billingMethodState.exp_year
      ? ` expiring ${String(billingMethodState.exp_month).padStart(2, "0")}/${billingMethodState.exp_year}`
      : "";
    const validityLine =
      billingMethodState.isExpired === true
        ? " That card appears to be expired."
        : billingMethodState.isValid === true
        ? " That card appears to be current."
        : "";
    return `I can confirm a saved payment method on this account: ${brand}${last4}${expiry}.${validityLine}`.trim();
  }
  return "I can't confirm your saved payment method from current platform data yet. Are you asking about your account billing method or a specific case payment?";
}

function buildPaymentClarificationReply(facts = {}) {
  const role = String(facts.userRole || "").toLowerCase();
  if (role === "paralegal") {
    return "Are you asking about payout setup or a specific case payment?";
  }
  return "Are you asking about your account billing method or a specific case payment?";
}

function buildCasePaymentReply(facts = {}) {
  const { caseState = {} } = facts;
  if (!caseState.caseId) {
    return "Which case is this payment issue about?";
  }
  const caseTitle = formatCaseTitle(facts);
  if (caseState.paymentReleased) {
    return `Payment for ${caseTitle} has been released by LPC. Bank timing depends on Stripe and your bank.`;
  }
  if (caseState.escrowStatus) {
    return `For ${caseTitle}, LPC currently shows escrow as ${String(caseState.escrowStatus || "").replace(/_/g, " ")}.`;
  }
  return `I can see ${caseTitle}, but I can't confirm the case payment status yet.`;
}

function buildWorkspaceAccessReply(facts = {}) {
  const { caseState = {}, workspaceState = {} } = facts;

  if (!caseState.caseId) {
    return "Which case workspace are you trying to open?";
  }

  if (!caseState.found || !caseState.accessible) {
    return "It looks like you don't currently have access to that workspace.";
  }

  const qualifier = caseState.inferred ? `I checked ${caseState.title || "your most recent case"}. ` : "";
  if (workspaceState.reason === "Case is read-only") {
    return `${qualifier}That workspace is available, but it's read-only right now.`;
  }
  if (workspaceState.reason) {
    return `${qualifier}${workspaceState.reason}`;
  }
  return `${qualifier}That workspace should be available. Open it here, and if it still won't load, reply here and I'll send it to the team.`;
}

function isStripeConceptQuestion(text = "") {
  return [
    /\bwhat is stripe\b/i,
    /\bwhat's stripe\b/i,
    /\bwhat does stripe do\b/i,
    /\bwhy stripe\b/i,
  ].some((pattern) => pattern.test(text));
}

function inferDetailLevel(text = "") {
  return /\b(more detail|more details|details|exactly|specifics|which step)\b/i.test(String(text || ""))
    ? "expanded"
    : "concise";
}

function selectPrimaryNextAction(category = "", supportFacts = {}, options = {}) {
  const paymentSubIntent = String(options.paymentSubIntent || "").trim().toLowerCase();
  if (category === "stripe_onboarding" && isStripeConceptQuestion(options.text)) {
    return "";
  }
  if (category === "payment" && paymentSubIntent === "payout") {
    return supportFacts.stripeState?.nextSteps?.[0] || "";
  }
  if (category === "stripe_onboarding") {
    return supportFacts.stripeState?.nextSteps?.[0] || "";
  }
  if (category === "messaging") {
    return supportFacts.messagingState?.nextSteps?.[0] || supportFacts.caseState?.nextSteps?.[0] || "";
  }
  if (category === "case_posting") {
    return supportFacts.caseState?.nextSteps?.[0] || "";
  }
  return "";
}

function replyAlreadyContainsAction(reply = "") {
  return /\b(finish|set up|open|tell me|reply with|check|use|try|return to)\b/i.test(String(reply || ""));
}

function simplifyResponseLanguage(text = "") {
  return normalizeReplyText(
    String(text || "")
      .replace(/\bfrom current platform data alone\b/gi, "")
      .replace(/\bfrom current platform data\b/gi, "")
      .replace(/\bcurrent page context\b/gi, "this page")
      .replace(/\s{2,}/g, " ")
  );
}

function lowercaseSentenceLead(text = "") {
  const value = String(text || "").trim();
  if (!value) return "";
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

function appendSecondarySupportReply(primaryReply = "", secondaryReply = "") {
  const first = trimString(primaryReply, MAX_REPLY_LENGTH);
  const second = trimString(secondaryReply, MAX_REPLY_LENGTH);
  if (!first) return second;
  if (!second) return first;
  if (normalizeForComparison(first) === normalizeForComparison(second)) return first;
  return normalizeReplyText(`${first} Also, ${lowercaseSentenceLead(second)}`);
}

function shapeSupportResponse({
  category = "",
  text = "",
  groundedReply = "",
  supportFacts = {},
  nextSteps = [],
  escalation = {},
  intakeMode = false,
  awaitingClarification = false,
  options = {},
} = {}) {
  const detailLevel = inferDetailLevel(text);
  const reply = simplifyResponseLanguage(groundedReply);

  return {
    text: trimString(reply, MAX_REPLY_LENGTH),
    detailLevel,
  };
}

function buildParticipantReply(facts = {}, options = {}) {
  const caseState = facts.caseState || {};
  const participantState = facts.participantState || {};
  const requestedRole = inferParticipantRoleRequested(options.text);

  if (!caseState.caseId) {
    return "Which case are you asking about?";
  }
  if (!caseState.found || !caseState.accessible) {
    return "I can't confirm that case from here yet.";
  }
  if (!requestedRole) {
    return "Are you asking about the attorney or the paralegal on that case?";
  }

  const participant = participantState[requestedRole] || {};
  const roleLabel = requestedRole === "attorney" ? "attorney" : "paralegal";
  if (participant.name) {
    return `The ${roleLabel} on ${caseState.title || "this case"} is ${participant.name}.`;
  }
  if (participant.present) {
    return `I can confirm a ${roleLabel} is assigned on ${caseState.title || "this case"}, but I can't show the name yet.`;
  }
  return `I don't see a ${roleLabel} assigned on ${caseState.title || "this case"} yet.`;
}

function buildCaseStatusReply(facts = {}) {
  const caseState = facts.caseState || {};
  if (!caseState.caseId) {
    return "Which case are you asking about?";
  }
  if (!caseState.found || !caseState.accessible) {
    return "I can't confirm that case from here yet.";
  }

  const statusLabel = caseState.normalizedStatus || caseState.status || "unknown";
  if (caseState.pausedReason) {
    return `${caseState.title || "This case"} is currently ${statusLabel}. It's paused for ${String(caseState.pausedReason).replace(/_/g, " ")}.`;
  }
  return `${caseState.title || "This case"} is currently ${statusLabel}.`;
}

function buildResolvedReply(options = {}) {
  if (/\b(thanks|thank you|thank u|appreciate it)\b/i.test(String(options.text || ""))) {
    return "You're welcome. I'm here if you need anything else.";
  }
  return "Glad that's sorted.";
}

function buildEscalationReply(primaryAsk = "") {
  if (primaryAsk === "request_human_help") {
    return "Thanks for letting us know. I'm sending this to the team for review now.";
  }
  if (primaryAsk === "responsiveness_issue") {
    return "If you've already followed up and still haven't heard back, I'm sending this to the team for review now.";
  }
  return "Thanks for letting us know. I'm sending this to the team for review now.";
}

function resolveIssueConversationLabel({ conversationState = {}, issueLifecycle = null } = {}) {
  return trimString(
    conversationState.currentIssueLabel || conversationState.proactiveIssueLabel || issueLifecycle?.issueLabel,
    180
  );
}

function buildIssueReviewStatusReply({ conversationState = {}, issueLifecycle = null } = {}) {
  const issueLabel = resolveIssueConversationLabel({ conversationState, issueLifecycle });
  const issueText = issueLabel ? `your ${issueLabel}` : "your issue";
  const issueTextSentence = issueText.charAt(0).toUpperCase() + issueText.slice(1);
  const lifecycleStatus = trimString(issueLifecycle?.statusKey, 80).toLowerCase();
  const issueState = trimString(conversationState.proactiveIssueState, 40).toLowerCase();
  const ticketStatus = trimString(conversationState.proactiveTicketStatus, 80).toLowerCase();
  if (lifecycleStatus === "needs_more_info") {
    return `Thank you for checking in. We still need a little more detail on ${issueText} to keep this moving. Reply here with what you're seeing and I'll keep it in the same thread.`;
  }
  if (lifecycleStatus === "ready_for_test") {
    return `Thank you for checking in. A fix for ${issueText} is being tested now. I'll update this thread once that verification is complete.`;
  }
  if (lifecycleStatus === "final_review") {
    return `Thank you for checking in. A fix for ${issueText} is under final review now. I'll update this thread as soon as that review is complete.`;
  }
  if (issueState === "closed" || ticketStatus === "closed" || lifecycleStatus === "closed") {
    return `Thank you for checking in. We closed ${issueText} after review. If it's still happening, reply here and I'll reopen it.`;
  }
  if (issueState === "resolved" || RESOLVED_TICKET_STATUSES.includes(ticketStatus)) {
    return `Thank you for checking in. ${issueTextSentence} has been resolved. If it's still happening, reply here and I'll reopen it.`;
  }
  if (lifecycleStatus === "resolved") {
    return `Thank you for checking in. ${issueTextSentence} has been resolved. If it's still happening, reply here and I'll reopen it.`;
  }
  if (lifecycleStatus === "with_engineering") {
    return `Thank you for checking in. ${issueTextSentence} is already with engineering. I don't have a fix time yet, but work is in progress and I'll keep this thread updated when there's a real change.`;
  }
  if (conversationState.escalationSent === true || conversationState.proactiveHandedOffToEngineering === true) {
    return `Thank you for checking in. ${issueTextSentence} is already with engineering. I don't have a fix time yet, but I'll keep this thread updated when there's a real change.`;
  }
  return `Thank you for checking in. ${issueTextSentence} is still open with the team. I'll keep this thread updated when there's a meaningful change.`;
}

function buildIssueReopenReply({ conversationState = {}, issueLifecycle = null } = {}) {
  const issueLabel = resolveIssueConversationLabel({ conversationState, issueLifecycle });
  const issueText = issueLabel ? `your ${issueLabel}` : "that issue";
  const returnTarget =
    issueLifecycle?.handedOffToEngineering === true ||
    conversationState.proactiveHandedOffToEngineering === true ||
    conversationState.escalationSent === true
      ? "engineering"
      : "the team";
  return `Thank you for letting us know. I'm reopening ${issueText} now and sending it back to ${returnTarget}.`;
}

function buildIssueStatusSecondaryGuidance({
  text = "",
  supportFacts = {},
  pageContext = {},
  conversationState = {},
} = {}) {
  const normalized = String(text || "");
  const role = String(supportFacts.userRole || "").toLowerCase();
  if (!normalized || !hasExplainLead(normalized)) return null;

  let explainIntent = "";
  if (role === "paralegal" && isProfileSetupQuestion(normalized)) {
    explainIntent = "profile_setup";
  } else if (role === "paralegal" && isStripeRequirementQuestion(normalized)) {
    explainIntent = "stripe";
  } else if (
    role === "paralegal" &&
    /\b(profile|headline|bio|summary|experience|skills?)\b/i.test(normalized) &&
    /\b(stand out|improve|better|stronger|complete|polish|best|help)\b/i.test(normalized)
  ) {
    explainIntent = "profile";
  } else if (role === "paralegal" && isApplyWorkflowQuestion(normalized)) {
    explainIntent = "apply";
  } else if (role === "paralegal" && /\b(messages?|chat|thread|inbox)\b/i.test(normalized)) {
    explainIntent = "messaging_workflow";
  } else if (role === "attorney" && /\b(case|cases|workspace|matter|fund|billing|payment)\b/i.test(normalized)) {
    explainIntent = "attorney_workflow";
  }

  if (!explainIntent) return null;

  return buildExplainReply(
    {
      ...supportFacts,
      explainIntent,
    },
    {
      text,
      pageContext,
      conversationState,
    }
  );
}

function buildTopicSelectionResponse({
  topicKey = "",
  supportFacts = {},
  pageContext = {},
  conversationState = {},
} = {}) {
  const normalizedTopicKey = trimString(topicKey, 80).toLowerCase();
  if (!normalizedTopicKey) return null;

  if (normalizedTopicKey === "billing") {
    return {
      reply: "You can find billing and invoices here.",
      navigation: buildNavigationPayload({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
        ctaType: "deep_link",
      }),
    };
  }

  if (normalizedTopicKey === "theme_preferences") {
    return {
      reply: "Yes — you can change that in Preferences.",
      navigation: buildNavigationPayload({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
        ctaType: "deep_link",
      }),
    };
  }

  if (normalizedTopicKey === "profile_setup") {
    return buildExplainReply(
      {
        ...supportFacts,
        explainIntent: "profile_setup",
      },
      {
        text: "How do I create my profile?",
        pageContext,
        conversationState,
      }
    );
  }

  if (normalizedTopicKey === "payouts") {
    return buildExplainReply(
      {
        ...supportFacts,
        explainIntent: "stripe",
      },
      {
        text: "Do I need Stripe?",
        pageContext,
        conversationState,
      }
    );
  }

  if (normalizedTopicKey === "messages") {
    return buildExplainReply(
      {
        ...supportFacts,
        explainIntent: "messaging_workflow",
      },
      {
        text: "How does messaging work?",
        pageContext,
        conversationState,
      }
    );
  }

  if (normalizedTopicKey === "applications") {
    return buildExplainReply(
      {
        ...supportFacts,
        explainIntent: "apply",
      },
      {
        text: "How do I apply?",
        pageContext,
        conversationState,
      }
    );
  }

  return null;
}

function buildCombinedTopicSelectionReply({
  text = "",
  selectionTopics = [],
  supportFacts = {},
  pageContext = {},
  conversationState = {},
} = {}) {
  const normalizedTopics = Array.isArray(selectionTopics)
    ? selectionTopics.map((value) => trimString(value, 80).toLowerCase()).filter(Boolean)
    : [];
  if (normalizedTopics.length < 2 || normalizedTopics.length > 3) return null;
  if (!isAllTopicSelection(text, normalizedTopics)) return null;

  const responses = normalizedTopics
    .map((topicKey) =>
      buildTopicSelectionResponse({
        topicKey,
        supportFacts,
        pageContext,
        conversationState,
      })
    )
    .filter((response) => response?.reply);

  if (responses.length !== normalizedTopics.length) return null;

  const reply = responses.reduce((combined, response) => appendSecondarySupportReply(combined, response.reply), "");
  const actions = responses
    .map((response) =>
      response?.navigation?.ctaLabel && response?.navigation?.ctaHref
        ? buildActionPayload({
            label: response.navigation.ctaLabel,
            href: response.navigation.ctaHref,
            type: "deep_link",
          })
        : null
    )
    .filter(Boolean)
    .filter((action, index, items) => items.findIndex((item) => item.href === action.href) === index);
  const explainOnly = normalizedTopics.every((topicKey) =>
    ["profile_setup", "payouts", "messages", "applications"].includes(topicKey)
  );
  const navigationOnly = normalizedTopics.every((topicKey) =>
    ["billing", "theme_preferences"].includes(topicKey)
  );

  return {
    reply,
    navigation: responses[0].navigation || null,
    actions,
    primaryAsk: explainOnly ? "product_guidance" : navigationOnly ? "navigation" : "generic_intake",
    activeTask: explainOnly ? "EXPLAIN" : navigationOnly ? "NAVIGATION" : "UNKNOWN",
  };
}

function buildResponsivenessReply(facts = {}) {
  const caseState = facts.caseState || {};
  const participantState = facts.participantState || {};
  const otherParticipant =
    caseState.roleOnCase === "attorney" ? participantState.paralegal : participantState.attorney;
  const otherLabel = otherParticipant?.name || "they";
  const qualifier = caseState.title ? ` on ${caseState.title}` : "";
  return `Got it — if ${otherLabel === "they" ? otherLabel : otherLabel} isn't responding${qualifier}, they may not have seen the message yet or could be offline. I'm sending this to the team for review now.`;
}

function buildPayoutReply(facts = {}, options = {}) {
  const { userRole, stripeState = {}, payoutState = {}, caseState = {} } = facts;
  const normalizedText = String(options.text || "").toLowerCase();
  const isStatusQuestion = /\b(where is my payout|when do i get paid|my money didn'?t come|my money did not come|where are my payouts?)\b/i.test(
    normalizedText
  );

  if (userRole === "attorney") {
    return "Attorney accounts don't receive payouts on LPC. If this is about a case payment, tell me which case.";
  }

  if (options.paymentSubIntent === "payout" && /\b(enabled|enable|onboarding|setup|account)\b/i.test(String(options.text || ""))) {
    if (!stripeState.accountId) {
      return "Your Stripe payout setup hasn't been started yet, so payouts aren't enabled on this account.";
    }
    if (!stripeState.detailsSubmitted || !stripeState.payoutsEnabled) {
      return "Your Stripe setup still needs to be finished before payouts can be enabled on this account.";
    }
  }

  const caseTitle = formatCaseTitle(facts);
  if (payoutState.paymentReleased && payoutState.paidOutAt) {
    return `Your payout for ${caseTitle} was released on ${formatDate(payoutState.paidOutAt)}. Bank timing depends on Stripe and your bank.`;
  }

  if (payoutState.paymentReleased) {
    const releaseDate = payoutState.completedAt ? ` on ${formatDate(payoutState.completedAt)}` : "";
    return `Your payout for ${caseTitle} was released by LPC${releaseDate}. Bank timing depends on Stripe and your bank.`;
  }

  if (payoutState.payoutFinalizedAt && !payoutState.paymentReleased) {
    return `A payout was finalized for ${caseTitle} on ${formatDate(payoutState.payoutFinalizedAt)}, but I can't verify that funds were sent yet.`;
  }

  if (userRole === "paralegal" && (!stripeState.accountId || !stripeState.payoutsEnabled || !stripeState.detailsSubmitted)) {
    if (!stripeState.accountId) {
      return "Your Stripe payout setup hasn't been started yet, so payouts aren't enabled on this account.";
    }
    return "Your Stripe setup still needs to be finished before payouts can be enabled on this account.";
  }

  if (!payoutState.hasRecentPayoutActivity) {
    if (!stripeState.accountId) {
      return "Your Stripe payout setup hasn't been started yet, so I don't see a payout release on this account yet.";
    }
    if (!stripeState.detailsSubmitted || !stripeState.payoutsEnabled) {
      return "Your Stripe setup still needs to be finished before payouts can be enabled on this account.";
    }
    if (isStatusQuestion) {
      return "I don't see recent payout activity on this account yet.";
    }
    return "I don't see recent payout activity on this account.";
  }

  return `I don't see a payout release for ${caseTitle} yet.`;
}

function buildStripeReply(facts = {}, options = {}) {
  const { userRole, stripeState = {}, payoutState = {} } = facts;
  const conceptQuestion = isStripeConceptQuestion(options.text);

  if (conceptQuestion) {
    const base =
      userRole === "attorney"
        ? "Stripe is the payment processor LPC uses to handle billing and payments securely."
        : "Stripe is the payment processor LPC uses to handle payouts securely.";
    if (userRole === "attorney") {
      return base;
    }
    if (!stripeState.accountId) {
      return `${base} Your Stripe setup hasn't been started yet.`;
    }
    if (!stripeState.detailsSubmitted || !stripeState.payoutsEnabled || !stripeState.onboardingComplete) {
      return `${base} Your Stripe setup still needs to be completed before payouts can be enabled.`;
    }
    return `${base} Your Stripe setup looks complete.`;
  }

  if (userRole === "attorney") {
    return "Stripe handles secure billing and payment processing on LPC. If this is about a specific case payment, tell me which case.";
  }

  if (!stripeState.accountId) {
    return "Your Stripe payout setup hasn't been started yet.";
  }

  if (!stripeState.detailsSubmitted || !stripeState.payoutsEnabled || !stripeState.onboardingComplete) {
    return "Your Stripe setup still needs to be finished before payouts can be enabled on this account.";
  }

  if (payoutState.paymentReleased) {
    return "Your Stripe setup looks ready for payouts.";
  }

  return "Your Stripe setup looks ready for payouts.";
}

function buildMessagingReply(facts = {}) {
  const { caseState = {}, workspaceState = {}, messagingState = {} } = facts;

  if (!caseState.caseId) {
    return (
      messagingState.clarificationPrompt || "Is this happening in a specific case or across all messages?"
    );
  }

  if (!caseState.found) {
    return "I couldn't match that to a case yet.";
  }

  if (!caseState.accessible) {
    const qualifier = caseState.inferred ? `I checked ${caseState.title || "your most recent case"}. ` : "";
    return `${qualifier}It looks like you don't currently have access to that workspace.`;
  }

  if (messagingState.isBlocked) {
    const qualifier = caseState.inferred ? `I checked ${caseState.title || "your most recent case"}. ` : "";
    return `${qualifier}Messaging is blocked for this workspace. ${messagingState.reason}`;
  }

  if (workspaceState.reason === "Case is read-only") {
    const qualifier = caseState.inferred ? `I checked ${caseState.title || "your most recent case"}. ` : "";
    return `${qualifier}This case is read-only right now, so new messages are disabled.`;
  }

  if (!messagingState.canSend) {
    const qualifier = caseState.inferred ? `I checked ${caseState.title || "your most recent case"}. ` : "";
    return `${qualifier}${messagingState.reason || "Messaging isn't available in that workspace right now."}`;
  }

  const qualifier = caseState.inferred ? `I checked ${caseState.title || "your most recent case"}. ` : "";
  return `${qualifier}Messaging should be available in that workspace. Open messages here.`;
}

function buildCaseReply(facts = {}) {
  const { caseState = {}, workspaceState = {} } = facts;

  if (!caseState.caseId) {
    return "Tell me which case you're asking about.";
  }
  if (!caseState.found) {
    return "I couldn't match that to a case yet.";
  }
  if (!caseState.accessible) {
    return "It looks like you don't currently have access to that case.";
  }

  const statusLabel = caseState.normalizedStatus || caseState.status || "unknown";
  const parts = [`I can confirm ${caseState.title || "this case"} is currently ${statusLabel}.`];
  if (caseState.pausedReason) {
    parts.push(`The case is paused for ${String(caseState.pausedReason).replace(/_/g, " ")}.`);
  }
  if (workspaceState.reason && workspaceState.reason !== "Case is read-only") {
    parts.push(workspaceState.reason);
  }
  if (workspaceState.reason === "Case is read-only") {
    parts.push("The workspace is read-only right now.");
  }
  return parts.join(" ").trim();
}

function buildApprovalReply() {
  return "Your account is already approved. Tell me what you need help with.";
}

function buildContextualNextStepReply(facts = {}, options = {}) {
  const role = String(facts.userRole || "").toLowerCase();
  const conversationState = options.conversationState || {};
  const topicKey = trimString(conversationState.topicKey, 120).toLowerCase();
  const caseState = facts.caseState || {};
  const stripeState = facts.stripeState || {};
  const payoutState = facts.payoutState || {};

  if (topicKey === "profile_guidance") {
    return {
      reply: "The next step is to update your Profile settings so your experience and strengths are clear.",
      navigation: buildNavigationPayload({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
        ctaType: "deep_link",
      }),
    };
  }

  if (topicKey === "payout_support" || facts.explainIntent === "stripe") {
    if (!stripeState.accountId || !stripeState.onboardingComplete || !stripeState.payoutsEnabled) {
      return {
        reply: "The next step is to finish Stripe setup in Security settings so payouts can be enabled.",
        navigation: buildNavigationPayload({
          ctaLabel: "Security settings",
          ctaHref: "profile-settings.html#securitySection",
          ctaType: "deep_link",
        }),
      };
    }
    if (payoutState.paymentReleased) {
      return {
        reply: "The next step is to give Stripe and your bank time to finish the payout transfer.",
        navigation: null,
      };
    }
  }

  if (topicKey === "messaging_support" && caseState.caseId) {
    return {
      reply: "The next step is to open the case messages so you can check that thread directly.",
      navigation: buildNavigationPayload({
        ctaLabel: "Case messages",
        ctaHref: buildCaseHref(caseState.caseId, "#case-messages"),
        ctaType: "deep_link",
      }),
    };
  }

  if (topicKey === "case_support" && caseState.caseId) {
    return {
      reply: `The next step is to open ${caseState.title || "that case"} and work from the case workspace.`,
      navigation: buildNavigationPayload({
        ctaLabel: caseState.title || "Case workspace",
        ctaHref: buildCaseHref(caseState.caseId),
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "paralegal") {
    return {
      reply: "Tell me whether you need help with your profile, a case, messaging, or payouts, and I'll point you to the right next step.",
      navigation: null,
    };
  }

  if (role === "attorney") {
    return {
      reply: "Tell me whether you need help with billing, a case, messaging, or finding a paralegal, and I'll point you to the right next step.",
      navigation: null,
    };
  }

  return {
    reply: "Tell me what you're trying to do next, and I'll point you in the right direction.",
    navigation: null,
  };
}

function buildExplainReply(facts = {}, options = {}) {
  const role = String(facts.userRole || "").toLowerCase();
  const text = String(options.text || "").toLowerCase();

  if (role === "paralegal" && /\b(can i|how do i|where do i)\s+(change|update|edit).*\bemail\b/i.test(text)) {
    return {
      reply: "Yes. You can update your email directly in Profile settings.",
      navigation: buildNavigationPayload({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "paralegal" && /\b(make|set|turn).*\b(profile).*\b(private|hidden)\b|\bhide my profile\b|\bprofile private\b/i.test(text)) {
    return {
      reply: "Yes. You can hide your profile in Preferences by turning on Hide profile.",
      navigation: buildNavigationPayload({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "paralegal" && facts.explainIntent === "profile_and_stripe") {
    const stripeState = facts.stripeState || {};
    const stripeLine =
      !stripeState.accountId || !stripeState.onboardingComplete || !stripeState.payoutsEnabled
        ? "If you want to receive payouts through LPC, you'll also need to connect Stripe in Security settings."
        : "Your Stripe setup already looks ready for payouts.";
    return {
      reply:
        `Open Profile settings and complete your headline, experience, practice areas, and the kind of work you support. ${stripeLine}`.trim(),
      navigation: buildNavigationPayload({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "paralegal" && facts.explainIntent === "payout_and_stripe") {
    const stripeState = facts.stripeState || {};
    if (!stripeState.accountId || !stripeState.onboardingComplete || !stripeState.payoutsEnabled) {
      return {
        reply:
          "Yes — if you want to receive payouts through LPC, you'll need Stripe. Right now that setup still needs to be finished in Security settings before payouts can be enabled.",
        navigation: buildNavigationPayload({
          ctaLabel: "Security settings",
          ctaHref: "profile-settings.html#securitySection",
          ctaType: "deep_link",
        }),
      };
    }
    return {
      reply:
        "Yes — Stripe is required for payouts on LPC, and your setup looks ready. Once LPC releases payment, Stripe handles the payout to your connected account.",
      navigation: buildNavigationPayload({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "paralegal" && facts.explainIntent === "apply_and_messaging") {
    return {
      reply:
        "You can apply when a case is open to applicants, and messaging happens inside each active case workspace. Start by browsing open cases, and if you mean an existing case conversation, tell me which case so I can point you to that thread.",
      navigation: buildNavigationPayload({
        ctaLabel: "Browse cases",
        ctaHref: "browse-jobs.html",
        ctaType: "deep_link",
      }),
    };
  }

  if (facts.explainIntent === "platform_overview_and_next_step") {
    return buildContextualNextStepReply(facts, options);
  }

  if (role === "paralegal" && facts.explainIntent === "apply") {
    return {
      reply: "You can apply when a case is open to applicants. You can browse open cases here. If you'd like, I can also help you find your applications.",
      navigation: buildNavigationPayload({
        ctaLabel: "Browse cases",
        ctaHref: "browse-jobs.html",
        ctaType: "deep_link",
      }),
      awaitingField: "applications_navigation",
    };
  }

  if (role === "paralegal" && facts.explainIntent === "profile") {
    return {
      reply:
        "A strong profile is clear, specific, and complete. Add your experience, the kinds of matters you support, and enough detail for attorneys to trust what you do best. You can update that in Profile settings.",
      navigation: buildNavigationPayload({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "paralegal" && facts.explainIntent === "profile_setup") {
    const editingExistingProfile =
      /\b(edit|update|change|manage)\s+(?:my\s+)?profile\b/i.test(text) ||
      /\b(edit|update|change|manage)\s+(?:my\s+)?(headline|bio|summary|experience|skills?)\b/i.test(text);
    return {
      reply:
        editingExistingProfile
          ? "Open Profile settings and update your headline, experience, practice areas, and the kind of work you support. The clearer and more specific that section is, the easier it is for attorneys to trust your profile."
          : "Open Profile settings and complete the profile section with your headline, experience, practice areas, and the kind of work you support. The stronger and more specific that section is, the easier it is for attorneys to trust your profile.",
      navigation: buildNavigationPayload({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "paralegal" && facts.explainIntent === "stripe") {
    const stripeState = facts.stripeState || {};
    const asksIfStripeIsRequired =
      /\b(do i have to|do i need to)\s+(connect|set up).*\bstripe\b/i.test(text) ||
      /\bdo i need stripe\b/i.test(text);

    if (asksIfStripeIsRequired) {
      return {
        reply:
          "Yes — if you want to receive payouts through LPC, you'll need to connect Stripe in Security settings.",
        navigation: buildNavigationPayload({
          ctaLabel: "Security settings",
          ctaHref: "profile-settings.html#securitySection",
          ctaType: "deep_link",
        }),
      };
    }

    if (!stripeState.accountId) {
      return {
        reply: "To get paid through LPC, you'll connect Stripe from Security settings. Once that's set up, Stripe handles your payouts.",
        navigation: buildNavigationPayload({
          ctaLabel: "Security settings",
          ctaHref: "profile-settings.html#securitySection",
          ctaType: "deep_link",
        }),
      };
    }
    if (!stripeState.onboardingComplete || !stripeState.payoutsEnabled) {
      return {
        reply: "Your Stripe setup is still in progress. Finish it in Security settings, and payouts can be enabled once the setup is complete.",
        navigation: buildNavigationPayload({
          ctaLabel: "Security settings",
          ctaHref: "profile-settings.html#securitySection",
          ctaType: "deep_link",
        }),
      };
    }
    return {
      reply: "Your Stripe setup looks complete. Once a payment is released on LPC, Stripe handles the payout to your connected account.",
      navigation: null,
    };
  }

  if (role === "attorney" && facts.explainIntent === "attorney_workflow") {
    return {
      reply: "You manage cases from your dashboard, then work with your paralegal in the case workspace once a matter is active. If you'd like, I can point you to the right page next.",
      navigation: null,
    };
  }

  if (role === "paralegal" && facts.explainIntent === "messaging_workflow") {
    return {
      reply: "Messaging happens inside each case workspace. Once you're on an active matter, open the case and use the messages area to talk with the attorney in that thread.",
      navigation: null,
    };
  }

  if (role === "paralegal" && facts.explainIntent === "profile_simple") {
    return {
      reply:
        "In simple terms, your profile should clearly show what you do, the kinds of matters you support, and why an attorney should trust your work. You can update that in Profile settings.",
      navigation: buildNavigationPayload({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "paralegal" && facts.explainIntent === "stripe_simple") {
    const stripeState = facts.stripeState || {};
    if (!stripeState.accountId || !stripeState.onboardingComplete || !stripeState.payoutsEnabled) {
      return {
        reply:
          "In simple terms, LPC releases the payment and Stripe sends the payout to your connected account. Right now your Stripe setup still needs to be finished before payouts can be enabled.",
        navigation: buildNavigationPayload({
          ctaLabel: "Security settings",
          ctaHref: "profile-settings.html#securitySection",
          ctaType: "deep_link",
        }),
      };
    }
    return {
      reply:
        "In simple terms, LPC releases the payment and Stripe sends the payout to your connected account once everything is ready.",
      navigation: null,
    };
  }

  if (role === "paralegal" && facts.explainIntent === "messaging_simple") {
    return {
      reply: "In simple terms, messages live inside each case workspace. Open the case and use the messages section there.",
      navigation: null,
    };
  }

  if (role === "paralegal" && facts.explainIntent === "paralegal_workflow") {
    return {
      reply: "On LPC, you complete your profile, browse open cases, apply to the ones that fit, and then work inside the case workspace once you're engaged on a matter.",
      navigation: null,
    };
  }

  if (role === "paralegal" && facts.explainIntent === "paralegal_workflow_simple") {
    return {
      reply:
        "In simple terms, you complete your profile, apply to open cases that fit your skills, and then work with the attorney inside the case workspace once you're engaged on a matter.",
      navigation: null,
    };
  }

  if (role === "paralegal" && facts.explainIntent === "paralegal_first_steps") {
    return {
      reply:
        "Start by completing your profile so attorneys can understand your experience. Then browse open cases that fit your skills and apply when a case is open to applicants.",
      navigation: buildNavigationPayload({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
        ctaType: "deep_link",
      }),
    };
  }

  if (role === "attorney" && facts.explainIntent === "attorney_first_steps") {
    return {
      reply:
        "Start from your dashboard by posting or reviewing your matters. Then choose the paralegal support you need and work together in the case workspace once the matter is active.",
      navigation: null,
    };
  }

  if (role === "attorney" && facts.explainIntent === "attorney_workflow_simple") {
    return {
      reply:
        "In simple terms, you manage matters from your dashboard, choose the paralegal support you need, and then work together inside the case workspace once the matter is active.",
      navigation: null,
    };
  }

  if (facts.explainIntent === "platform_overview") {
    return {
      reply:
        role === "paralegal"
          ? "On LPC, you build your profile, browse open cases, apply when a matter is open to applicants, and then collaborate inside the case workspace once you're engaged. Payouts run through Stripe after payment is released."
          : "On LPC, you manage matters from your dashboard, choose the paralegal support you need, and then collaborate inside the case workspace once a matter is active. Billing stays on the attorney side, and there is no subscription model.",
      navigation: null,
    };
  }

  if (isNextStepQuestion(text)) {
    return buildContextualNextStepReply(facts, options);
  }

  return {
    reply:
      role === "paralegal"
        ? "You can browse open cases, apply when a case is open to applicants, and use the workspace once you're engaged on a matter. If you'd like, I can point you to the next step."
        : "You can post and manage cases from your dashboard, then work in the case workspace once a matter is active. If you'd like, I can point you to the next step.",
    navigation: null,
  };
}

function tokenizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function isVagueSupportInput(text = "") {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return true;

  const compact = normalized.replace(/[^a-z0-9]+/g, " ").trim();
  const tokenCount = tokenizeText(normalized).length;
  const genericPatterns = [
    /^(hi|hello|hey|yo)$/i,
    /^(help|support|question|customer service)$/i,
    /^(need help|can you help|help me|i need help)$/i,
    /^(i have a question|have a question|got a question)$/i,
    /^(customer support|need support|need assistance)$/i,
    /^(issue|problem|something is wrong)$/i,
  ];

  if (genericPatterns.some((pattern) => pattern.test(compact))) {
    return true;
  }

  return tokenCount <= 3 && compact.length <= 28;
}

function buildIntakeReply({ followUpAttempted = false } = {}) {
  if (followUpAttempted) {
    return "I can help with billing, cases, messages, or account issues. What do you need help with today?";
  }
  return "How can I help today?";
}

function shouldUseIntakeMode({ analysis = {}, supportFacts = {}, text = "" } = {}) {
  const category = String(analysis.category || "unknown").toLowerCase();
  const classifierConfidence = String(analysis.confidence || "low").toLowerCase();
  const vagueInput = isVagueSupportInput(text);
  const noClearCategoryMatch = category === "unknown" || classifierConfidence === "low";
  const hasGroundedSignals =
    Boolean(supportFacts.caseState?.caseId) ||
    Boolean(supportFacts.stripeState?.accountId) ||
    Boolean(supportFacts.payoutState?.hasRecentPayoutActivity) ||
    Boolean(supportFacts.messagingState?.totalMessages);

  if (!noClearCategoryMatch) return false;
  if (vagueInput) return true;
  if (category === "unknown" && classifierConfidence === "low" && !hasGroundedSignals) return true;
  return false;
}

function buildGenericReply({ analysis = {}, facts = {}, pageContext = {} } = {}) {
  const category = String(analysis.category || "").toLowerCase();
  if (category === "password_reset") {
    return "You can change your password in Security settings.";
  }
  if (category === "login") {
    return "You can manage account access from Security settings.";
  }
  if (category === "profile_save") {
    return "Thank you for letting us know. I’m sorry you ran into that. I’m sending the Save Preferences issue to engineering now.";
  }
  if (category === "unknown" && String(pageContext.viewName || "").toLowerCase() === "case-detail") {
    return "Open that workspace here. If it still looks wrong, tell me what you see and I'll take a closer look.";
  }
  return "Tell me what happened, and I’ll take a closer look.";
}

function getCategoryScopedNextSteps(category = "", supportFacts = {}, options = {}) {
  const normalizedCategory = String(category || "").trim().toLowerCase();
  const paymentSubIntent = String(options.paymentSubIntent || "").trim().toLowerCase();

  if (normalizedCategory === "messaging") {
    return uniqueStrings([
      ...(supportFacts.messagingState?.nextSteps || []),
      ...(supportFacts.workspaceState?.nextSteps || []),
      ...(supportFacts.caseState?.nextSteps || []),
    ]);
  }

  if (normalizedCategory === "case_posting") {
    return uniqueStrings([
      ...(supportFacts.caseState?.nextSteps || []),
      ...(supportFacts.workspaceState?.nextSteps || []),
    ]);
  }

  if (normalizedCategory === "payment") {
    if (paymentSubIntent === "billing_method" || paymentSubIntent === "unclear") {
      return [];
    }
    if (paymentSubIntent === "case_payment") {
      return uniqueStrings([
        ...(supportFacts.caseState?.nextSteps || []),
        ...(supportFacts.workspaceState?.nextSteps || []),
      ]);
    }
    return uniqueStrings([
      ...(supportFacts.payoutState?.nextSteps || []),
      ...(supportFacts.stripeState?.nextSteps || []),
    ]);
  }

  if (normalizedCategory === "stripe_onboarding") {
    return uniqueStrings([...(supportFacts.stripeState?.nextSteps || [])]);
  }

  return uniqueStrings(supportFacts.nextSteps || []);
}

function deriveConfidence(category = "", facts = {}) {
  const hasCase = Boolean(facts.caseState?.caseId);
  const hasStripe = Boolean(facts.stripeState?.accountId);
  const payoutActivity = Boolean(facts.payoutState?.hasRecentPayoutActivity);
  const messagingCount = Number(facts.messagingState?.totalMessages || 0) > 0;
  const explainIntent = String(facts.explainIntent || "").toLowerCase();

  if (category === "payment" && (payoutActivity || hasStripe)) return "high";
  if (category === "stripe_onboarding" && hasStripe) return "high";
  if ((category === "messaging" || category === "case_posting") && hasCase) return "high";
  if (category === "account_approval") return "high";
  if (explainIntent) return "high";
  if (hasCase || hasStripe || messagingCount) return "medium";
  return "low";
}

function deriveEscalation({ category = "", facts = {}, confidence = "medium", options = {} } = {}) {
  const stripeState = facts.stripeState || {};
  const payoutState = facts.payoutState || {};
  const caseState = facts.caseState || {};
  const workspaceState = facts.workspaceState || {};
  const messagingState = facts.messagingState || {};
  const paymentSubIntent = String(options.paymentSubIntent || "").trim().toLowerCase();
  const primaryAsk = String(options.primaryAsk || "").trim().toLowerCase();
  const frustrationScore = Number(options.frustrationScore || 0) || 0;
  const escalationAlreadyOffered = options.escalationOffered === true;
  const followUpAttempted = options.followUpAttempted === true;
  const normalizedText = String(options.text || "").toLowerCase();

  if (primaryAsk === "product_guidance") {
    return { needsEscalation: false, escalationReason: "" };
  }

  if (category === "payment") {
    if (paymentSubIntent === "billing_method" || paymentSubIntent === "unclear") {
      return { needsEscalation: false, escalationReason: "" };
    }
    if (paymentSubIntent === "case_payment" && !caseState.caseId) {
      return { needsEscalation: false, escalationReason: "" };
    }
    if (payoutState.paymentReleased && !payoutState.paidOutAt) {
      return {
        needsEscalation: true,
        escalationReason: "payment_released_bank_timing_unconfirmed",
      };
    }
    if (payoutState.payoutFinalizedAt && !payoutState.paymentReleased) {
      return {
        needsEscalation: true,
        escalationReason: "payout_finalized_without_release_record",
      };
    }
    return { needsEscalation: false, escalationReason: "" };
  }

  if (category === "stripe_onboarding") {
    if (stripeState.accountId && stripeState.payoutsEnabled && stripeState.detailsSubmitted) {
      return {
        needsEscalation: true,
        escalationReason: "stripe_ready_but_user_reports_blocker",
      };
    }
    return { needsEscalation: false, escalationReason: "" };
  }

  if (category === "messaging") {
    if (messagingState.clarificationNeeded && (messagingState.followUpAttempted || followUpAttempted)) {
      return { needsEscalation: true, escalationReason: "messaging_context_still_unresolved" };
    }
    if (messagingState.clarificationNeeded) {
      return { needsEscalation: false, escalationReason: "" };
    }
    if (!caseState.caseId || !caseState.accessible) {
      return { needsEscalation: true, escalationReason: "workspace_access_needs_review" };
    }
    if (messagingState.canSend && !messagingState.isBlocked) {
      return { needsEscalation: true, escalationReason: "messaging_should_be_available" };
    }
    return { needsEscalation: false, escalationReason: "" };
  }

  if (category === "case_posting") {
    if (!caseState.caseId || !caseState.accessible) {
      return { needsEscalation: true, escalationReason: "case_context_missing_or_denied" };
    }
    if (options.primaryAsk === "navigation") {
      return { needsEscalation: false, escalationReason: "" };
    }
    if (workspaceState.reason) {
      return { needsEscalation: true, escalationReason: "case_requires_review" };
    }
    return { needsEscalation: false, escalationReason: "" };
  }

  if (category === "interaction_responsiveness_issue" || primaryAsk === "responsiveness_issue") {
    if (escalationAlreadyOffered || frustrationScore >= 2 || /\b(still|again|nothing|yet|same)\b/i.test(normalizedText)) {
      return { needsEscalation: true, escalationReason: "interaction_responsiveness_review" };
    }
    return { needsEscalation: false, escalationReason: "" };
  }

  if (["login", "password_reset"].includes(category)) {
    return { needsEscalation: false, escalationReason: "" };
  }

  if (["dashboard_load", "profile_save", "profile_photo_upload", "unknown"].includes(category)) {
    if (options.primaryAsk === "navigation") {
      return { needsEscalation: false, escalationReason: "" };
    }
    return {
      needsEscalation: confidence === "low" || confidence === "medium",
      escalationReason: confidence === "high" ? "" : "support_review_recommended",
    };
  }

  return { needsEscalation: false, escalationReason: "" };
}

function normalizeForComparison(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeSupportIssueLabel({
  primaryAsk = "",
  category = "",
  supportFacts = {},
  activeEntity = null,
} = {}) {
  const caseTitle = trimString(supportFacts.caseState?.title || activeEntity?.name || "", 140);
  const ask = String(primaryAsk || "").trim().toLowerCase();
  const normalizedCategory = String(category || "").trim().toLowerCase();

  if (ask === "messaging_access") return caseTitle ? `messaging in ${caseTitle}` : "messaging issue";
  if (ask === "workspace_access") return caseTitle ? `workspace access in ${caseTitle}` : "workspace issue";
  if (ask === "participant_lookup") return caseTitle ? `participant details for ${caseTitle}` : "participant question";
  if (ask === "case_status") return caseTitle ? `status of ${caseTitle}` : "case status question";
  if (ask === "help_with_case") return caseTitle ? `case help for ${caseTitle}` : "case question";
  if (ask === "billing_payment_method") return "billing method question";
  if (ask === "payment_clarify") return "payment question";
  if (ask === "case_payment") return caseTitle ? `case payment for ${caseTitle}` : "case payment issue";
  if (ask === "payout_question") return caseTitle ? `payout for ${caseTitle}` : "payout issue";
  if (ask === "stripe_onboarding") return "Stripe payout setup";
  if (ask === "profile_save") return "Save Preferences issue";
  if (ask === "password_reset") return "password reset";
  if (ask === "request_human_help") return "support review request";
  if (ask === "issue_reopen") return "";
  if (ask === "issue_review_status") return "";
  if (ask === "responsiveness_issue") return caseTitle ? `response issue in ${caseTitle}` : "response issue";
  if (ask === "navigation" || ask === "product_guidance" || ask === "generic_intake" || ask === "issue_resolved") return "";

  if (normalizedCategory && normalizedCategory !== "unknown") {
    if (normalizedCategory === "case_posting") return "case issue";
    if (normalizedCategory === "payment") return "payment issue";
    if (normalizedCategory === "stripe_onboarding") return "payout setup";
    if (normalizedCategory === "profile_save") return "Save Preferences issue";
    return `${formatCategoryLabel(normalizedCategory).toLowerCase()} issue`;
  }
  return "";
}

function buildConversationIssueSummary({
  issueLabel = "",
  text = "",
  supportFacts = {},
} = {}) {
  const userText = trimString(text, 220);
  const caseTitle = trimString(supportFacts.caseState?.title || "", 140);
  const parts = [];
  if (issueLabel) parts.push(issueLabel);
  if (caseTitle && !issueLabel.toLowerCase().includes(caseTitle.toLowerCase())) parts.push(caseTitle);
  if (userText) parts.push(userText);
  return trimString(parts.join(" — "), 320);
}

const NON_ISSUE_SUPPORT_ASKS = new Set(["navigation", "product_guidance", "generic_intake", "issue_resolved"]);
const COMPOUND_EXPLAIN_INTENTS = new Set([
  "profile_and_stripe",
  "payout_and_stripe",
  "apply_and_messaging",
  "platform_overview_and_next_step",
]);

function formatSupportTopicLabel(topicKey = "") {
  const key = trimString(topicKey, 120).toLowerCase();
  const labels = {
    payout_support: "payout support",
    stripe_guidance: "Stripe guidance",
    profile_guidance: "profile guidance",
    theme_preferences: "theme preferences",
    settings_navigation: "settings navigation",
    case_navigation: "case navigation",
    billing_support: "billing support",
    messaging_support: "messaging support",
    case_support: "case support",
    issue_status: "issue status",
    support_review: "support review",
    general_guidance: "general guidance",
    general_support: "general support",
  };
  return labels[key] || key.replace(/_/g, " ");
}

function deriveSupportTopicKey({
  text = "",
  primaryAsk = "",
  category = "",
  paymentSubIntent = "",
  supportFacts = {},
  conversationState = {},
} = {}) {
  const normalized = String(text || "").trim().toLowerCase();
  const ask = String(primaryAsk || "").trim().toLowerCase();
  const normalizedCategory = String(category || "").trim().toLowerCase();
  const explainIntent = String(supportFacts.explainIntent || "").trim().toLowerCase();
  const selectedTopicOption = resolveTopicSelection(normalized, conversationState);

  if (ask === "issue_review_status" || ask === "issue_reopen") {
    return trimString(conversationState.topicKey, 120) || "issue_status";
  }
  if (selectedTopicOption === "theme_preferences") return "theme_preferences";
  if (selectedTopicOption === "billing") return "billing_support";
  if (selectedTopicOption === "cases") return "case_navigation";
  if (selectedTopicOption === "messages") return "messaging_support";
  if (selectedTopicOption === "applications") return "general_guidance";
  if (selectedTopicOption === "profile_setup") return "profile_guidance";
  if (selectedTopicOption === "payouts") return "payout_support";
  if (/\b(dark mode|light mode|theme|appearance)\b/i.test(normalized)) return "theme_preferences";
  if (
    /\b(profile|headline|bio|summary|experience|skills?)\b/i.test(normalized) &&
    (/\b(stand out|improve|better|stronger|complete|polish|best)\b/i.test(normalized) ||
      isProfileSetupQuestion(normalized))
  ) {
    return "profile_guidance";
  }
  if (
    isStripeConceptQuestion(normalized) ||
    /\b(do i have to|do i need to)\s+(connect|set up).*\bstripe\b/i.test(normalized) ||
    /\bdo i need stripe\b/i.test(normalized)
  ) {
    return "stripe_guidance";
  }
  if (ask === "navigation") {
    if (/\b(profile settings|preferences?|security|dark mode|light mode|theme|appearance)\b/i.test(normalized)) {
      return "settings_navigation";
    }
    if (/\b(case|workspace|messages?|documents?|files?|applications?|browse)\b/i.test(normalized)) {
      return "case_navigation";
    }
  }
  if (ask === "product_guidance") {
    if (explainIntent === "stripe") return "stripe_guidance";
    if (["profile", "profile_setup", "profile_and_stripe"].includes(explainIntent)) return "profile_guidance";
    if (explainIntent === "payout_and_stripe") return "stripe_guidance";
    if (explainIntent === "apply_and_messaging") return "general_guidance";
    return "general_guidance";
  }
  if (["payout_question", "stripe_onboarding"].includes(ask) || paymentSubIntent === "payout") return "payout_support";
  if (["billing_payment_method", "payment_clarify"].includes(ask) || paymentSubIntent === "billing_method") {
    return "billing_support";
  }
  if (ask === "messaging_access" || normalizedCategory === "messaging") return "messaging_support";
  if (["case_status", "help_with_case", "workspace_access", "participant_lookup", "case_payment"].includes(ask)) {
    return "case_support";
  }
  if (ask === "request_human_help" || ask === "responsiveness_issue") return "support_review";
  if (ask === "generic_intake") return "general_support";
  return trimString(conversationState.topicKey, 120);
}

function planSupportConversationTurn({
  text = "",
  primaryAsk = "",
  category = "",
  paymentSubIntent = "",
  supportFacts = {},
  conversationState = {},
} = {}) {
  const previousTopicKey = trimString(conversationState.topicKey, 120);
  const correctionLead = hasCorrectionLead(text);
  const topicKey = deriveSupportTopicKey({
    text,
    primaryAsk,
    category,
    paymentSubIntent,
    supportFacts,
    conversationState,
  });

  let turnKind = "new_topic";
  if (primaryAsk === "issue_review_status") {
    turnKind = "status_followup";
  } else if (primaryAsk === "issue_reopen") {
    turnKind = "issue_reopened";
  } else if (primaryAsk === "issue_resolved") {
    turnKind = "resolution";
  } else if (correctionLead && topicKey) {
    turnKind = "correction";
  } else if (topicKey && previousTopicKey && topicKey === previousTopicKey) {
    turnKind = NON_ISSUE_SUPPORT_ASKS.has(String(primaryAsk || "").trim().toLowerCase())
      ? "same_topic_followup"
      : "same_issue_followup";
  } else if (topicKey && previousTopicKey && topicKey !== previousTopicKey) {
    turnKind = "topic_switch";
  } else if (topicKey) {
    turnKind = "new_topic";
  }

  const shouldRetainIssueContext =
    !NON_ISSUE_SUPPORT_ASKS.has(String(primaryAsk || "").trim().toLowerCase()) &&
    ["same_issue_followup", "status_followup", "issue_reopened"].includes(turnKind);

  return {
    topicKey,
    topicLabel: formatSupportTopicLabel(topicKey),
    topicMode: ["topic_switch", "correction"].includes(turnKind) ? "switch" : topicKey && previousTopicKey === topicKey ? "continue" : "new",
    turnKind,
    shouldRetainIssueContext,
  };
}

function buildConversationTopicTrail(previousTopics = [], nextLabel = "") {
  const trail = [nextLabel, ...(Array.isArray(previousTopics) ? previousTopics : [])]
    .map((value) => trimString(value, 180))
    .filter(Boolean);
  return [...new Set(trail)].slice(0, 3);
}

function shouldReferenceCurrentIssue({ text = "", conversationState = {}, primaryAsk = "" } = {}) {
  const issueLabel = trimString(conversationState.currentIssueLabel, 180);
  if (!issueLabel) return false;
  if (String(primaryAsk || "").trim().toLowerCase() === "issue_resolved") return false;
  if (String(primaryAsk || "").trim().toLowerCase() === "issue_reopen") return false;
  if (String(primaryAsk || "").trim().toLowerCase() === "issue_review_status") return false;

  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(still|same|again|yet)\b/i.test(normalized)) return true;
  if (/\b(it|that|this)\b/i.test(normalized) && String(conversationState.activeAsk || "").trim().toLowerCase() === String(primaryAsk || "").trim().toLowerCase()) {
    return true;
  }
  return false;
}

function buildCurrentIssueLead({ text = "", conversationState = {} } = {}) {
  const issueLabel = trimString(conversationState.currentIssueLabel, 180);
  if (!issueLabel) return "";
  const normalized = String(text || "").trim().toLowerCase();
  if (/\b(still|same|again|yet)\b/i.test(normalized)) {
    return `I'm still with you on the ${issueLabel}.`;
  }
  return `Staying with the ${issueLabel},`;
}

function applyConversationMemoryTone({
  reply = "",
  text = "",
  conversationState = {},
  primaryAsk = "",
  conversationPlan = {},
} = {}) {
  const nextReply = trimString(reply, MAX_REPLY_LENGTH);
  if (!nextReply) return "";
  if (conversationPlan.shouldRetainIssueContext !== true) return nextReply;
  if (!shouldReferenceCurrentIssue({ text, conversationState, primaryAsk })) return nextReply;
  if (/^(i('|’)m still with you|staying with the)\b/i.test(nextReply)) return nextReply;

  const lead = buildCurrentIssueLead({ text, conversationState });
  if (!lead) return nextReply;
  return normalizeReplyText(`${lead} ${nextReply}`.trim());
}

function normalizeSupportEntity(entity = {}) {
  return {
    type: trimString(entity?.type, 80),
    id: trimString(entity?.id, 120),
    name: trimString(entity?.name, 240),
    source: trimString(entity?.source, 120),
  };
}

function sanitizeProactivePrompt(prompt = {}) {
  if (!prompt || typeof prompt !== "object") return null;
  const key = trimString(prompt.key, 120);
  const text = trimString(prompt.text, 320);
  const actionText = trimString(prompt.actionText, 120);
  const message = trimString(prompt.message, 320);
  if (!key || !text || !message) return null;
  return {
    key,
    text,
    actionText,
    message,
    intent: trimString(prompt.intent, 80),
    issueLabel: trimString(prompt.issueLabel, 180),
    issueState: trimString(prompt.issueState, 40),
    ticketId: trimString(prompt.ticketId, 120),
    ticketStatus: trimString(prompt.ticketStatus, 80),
    handedOffToEngineering: prompt.handedOffToEngineering === true,
  };
}

function sanitizePromptAction(action = {}) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const key = trimString(action.key, 120);
  const intent = trimString(action.intent, 80);
  const issueLabel = trimString(action.issueLabel, 180);
  const issueState = trimString(action.issueState, 40);
  const ticketId = trimString(action.ticketId, 120);
  const ticketStatus = trimString(action.ticketStatus, 80);
  if (!key && !intent && !issueLabel && !ticketId) return null;
  return {
    key,
    intent,
    issueLabel,
    issueState,
    ticketId,
    ticketStatus,
    handedOffToEngineering: action.handedOffToEngineering === true,
  };
}

function buildOpenTicketIssueLabel(ticket = {}) {
  const category = String(ticket.supportCategory || ticket.classification?.category || "").trim().toLowerCase();
  const subject = cleanSupportIssueLabelText(ticket.subject, category);

  if (subject && !/^support (ticket|issue)$/i.test(subject)) {
    return subject;
  }
  if (["payment", "stripe_onboarding", "payments_risk", "fees"].includes(category)) return "payout issue";
  if (category === "messaging") return "messaging issue";
  if (["case_posting", "case_workflow", "job_application"].includes(category)) return "case issue";
  if (category === "profile_save") return "Save Preferences issue";
  return "support issue";
}

function getConversationPolicyState(conversation = {}) {
  const support = conversation?.metadata?.support || {};
  return {
    activeTask: trimString(support.activeTask, 40) || trimString(support.activeAsk, 120),
    activeAsk: trimString(support.activeAsk, 120),
    activeIntent: trimString(support.activeIntent, 120),
    intentConfidence: trimString(support.intentConfidence, 40),
    activeEntity: normalizeSupportEntity(support.activeEntity || {}),
    awaiting: trimString(support.awaiting, 40) || trimString(support.awaitingField, 80),
    awaitingField: trimString(support.awaitingField, 80),
    lastResponseType: trimString(support.lastResponseType, 40) || trimString(support.lastResponseMode, 40),
    lastResponseMode: trimString(support.lastResponseMode, 40),
    lastAssistantReply: trimString(support.lastAssistantReply, 2000),
    escalationShown: support.escalationShown === true || support.escalationOffered === true,
    escalationOffered: support.escalationOffered === true,
    escalationSent: support.escalationSent === true,
    sentiment: trimString(support.sentiment, 40) || "neutral",
    frustrationScore: Number(support.frustrationScore || 0) || 0,
    escalationPriority: trimString(support.escalationPriority, 40) || "normal",
    currentIssueLabel: trimString(support.currentIssueLabel, 180),
    currentIssueSummary: trimString(support.currentIssueSummary, 320),
    compoundIntent: trimString(support.compoundIntent, 120),
    lastCompoundBranch: trimString(support.lastCompoundBranch, 120),
    selectionTopics: Array.isArray(support.selectionTopics)
      ? support.selectionTopics.map((value) => trimString(value, 80).toLowerCase()).filter(Boolean).slice(0, 3)
      : [],
    lastSelectionTopic: trimString(support.lastSelectionTopic, 80),
    topicKey: trimString(support.topicKey, 120),
    topicLabel: trimString(support.topicLabel, 180),
    topicMode: trimString(support.topicMode, 40),
    turnKind: trimString(support.turnKind, 60),
    recentTopics: Array.isArray(support.recentTopics)
      ? support.recentTopics.map((value) => trimString(value, 180)).filter(Boolean).slice(0, 3)
      : [],
    lastNavigationLabel: trimString(support.lastNavigationLabel, 120),
    lastNavigationHref: trimString(support.lastNavigationHref, 500),
    turnCount: Number(support.turnCount || 0) || 0,
    welcomePrompt: trimString(support.welcomePrompt, 320),
    proactivePrompt: sanitizeProactivePrompt(support.proactivePrompt || null),
    lastProactivePromptKey: trimString(support.lastProactivePromptKey, 120),
    lastProactivePromptAt: support.lastProactivePromptAt || null,
    proactiveIssueLabel: trimString(support.proactiveIssueLabel, 180),
    proactiveIssueState: trimString(support.proactiveIssueState, 40),
    proactiveTicketId: trimString(support.proactiveTicketId, 120),
    proactiveTicketStatus: trimString(support.proactiveTicketStatus, 80),
    proactiveHandedOffToEngineering: support.proactiveHandedOffToEngineering === true,
  };
}

function deriveIssueLifecycleSnapshot(ticket = null) {
  if (!ticket) return null;
  const linkedIncidents = Array.isArray(ticket.linkedIncidentIds) ? ticket.linkedIncidentIds.filter(Boolean) : [];
  const sortedIncidents = linkedIncidents
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left?.updatedAt || left?.createdAt || 0).getTime();
      const rightTime = new Date(right?.updatedAt || right?.createdAt || 0).getTime();
      return rightTime - leftTime;
    });
  const ticketStatus = trimString(ticket.status, 80).toLowerCase();
  const latestActiveIncident =
    sortedIncidents.find(
      (incident) => !INCIDENT_TERMINAL_STATES.includes(trimString(incident?.state, 80).toLowerCase())
    ) || null;
  const latestIncident =
    RESOLVED_TICKET_STATUSES.includes(ticketStatus)
      ? sortedIncidents[0] || null
      : latestActiveIncident || sortedIncidents[0] || null;
  const incidentState = trimString(latestIncident?.state, 80).toLowerCase();
  const userVisibleStatus = trimString(latestIncident?.userVisibleStatus, 80).toLowerCase();
  const approvalState = trimString(latestIncident?.approvalState, 80).toLowerCase();

  let statusKey = "open";
  if (userVisibleStatus === "fixed_live" || incidentState === "resolved" || ticketStatus === "resolved") {
    statusKey = "resolved";
  } else if (userVisibleStatus === "closed" || incidentState.startsWith("closed_") || ticketStatus === "closed") {
    statusKey = "closed";
  } else if (
    ticketStatus === "waiting_on_user" ||
    ticketStatus === "waiting_on_info" ||
    userVisibleStatus === "needs_more_info"
  ) {
    statusKey = "needs_more_info";
  } else if (
    userVisibleStatus === "testing_fix" ||
    ["awaiting_verification", "verified_release_candidate", "post_deploy_verifying"].includes(incidentState)
  ) {
    statusKey = "ready_for_test";
  } else if (
    userVisibleStatus === "awaiting_internal_review" ||
    incidentState === "awaiting_founder_approval" ||
    approvalState === "pending"
  ) {
    statusKey = "final_review";
  } else if (
    linkedIncidents.length > 0 ||
    userVisibleStatus === "received" ||
    userVisibleStatus === "investigating" ||
    ["reported", "intake_validated", "classified", "investigating", "patch_planning", "patching", "needs_human_owner"].includes(
      incidentState
    )
  ) {
    statusKey = "with_engineering";
  }

  return {
    statusKey,
    ticketId: normalizeId(ticket._id || ticket.id),
    issueLabel: buildOpenTicketIssueLabel(ticket),
    ticketStatus,
    incidentId: normalizeId(latestIncident?._id || latestIncident?.id),
    incidentPublicId: trimString(latestIncident?.publicId, 80),
    incidentState,
    userVisibleStatus,
    approvalState,
    handedOffToEngineering: linkedIncidents.length > 0,
  };
}

async function loadConversationIssueLifecycle({
  conversationId = "",
  userId = "",
  preferredTicketId = "",
} = {}) {
  const queryByTicketId =
    preferredTicketId && mongoose.isValidObjectId(preferredTicketId)
      ? {
          _id: preferredTicketId,
          userId,
        }
      : null;

  const baseQuery = {
    userId,
  };
  if (conversationId && mongoose.isValidObjectId(conversationId)) {
    baseQuery.conversationId = conversationId;
  }

  const ticketQuery =
    queryByTicketId ||
    {
      ...baseQuery,
      status: { $in: [...OPEN_TICKET_STATUSES, ...RESOLVED_TICKET_STATUSES] },
    };

  const ticket = await SupportTicket.findOne(ticketQuery)
    .populate("linkedIncidentIds", "publicId state summary userVisibleStatus approvalState updatedAt createdAt")
    .sort({ updatedAt: -1, createdAt: -1 });

  return deriveIssueLifecycleSnapshot(ticket);
}

function shouldTreatAsStrongNewAsk(text = "", activeAsk = "") {
  const normalized = String(text || "").trim();
  const currentAsk = String(activeAsk || "").trim().toLowerCase();
  if (!normalized || !currentAsk) return false;
  if (
    hasCorrectionLead(normalized) &&
    (
      hasNavigationLead(normalized) ||
      hasExplainLead(normalized) ||
      detectSupportTopics(normalized).length ||
      isOtherPartSelection(normalized)
    )
  ) {
    return true;
  }
  if (/\b(nothing is blocking me|never mind|all good|it'?s working now|resolved now|figured it out|that fixed it|fixed now|solved it)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(where|find|open|go to|see)\b/i.test(normalized) && currentAsk !== "navigation") {
    return true;
  }
  if (/\b(who(?:'s| is)?|attorney|paralegal)\b/i.test(normalized) && currentAsk !== "participant_lookup") {
    return true;
  }
  if (/\b(not responding|won'?t respond|hasn'?t replied|waiting on them|ignoring|haven'?t heard back)\b/i.test(normalized)) {
    return currentAsk !== "responsiveness_issue";
  }
  if (/\b(isn'?t responding|not answering|not replying)\b/i.test(normalized)) {
    return currentAsk !== "responsiveness_issue";
  }
  if (/\b(message|chat|thread|inbox)\b/i.test(normalized)) {
    return !["messaging_access", "responsiveness_issue"].includes(currentAsk);
  }
  if (/\b(workspace)\b/i.test(normalized) && /\b(access|open|load|enter)\b/i.test(normalized)) {
    return currentAsk !== "workspace_access";
  }
  if (/\b(payment method|billing|receipt|invoice)\b/i.test(normalized)) {
    return currentAsk !== "billing_payment_method";
  }
  if (/\b(payout|stripe|get paid|bank account|my money didn'?t come)\b/i.test(normalized)) {
    return !["payout_question", "stripe_onboarding"].includes(currentAsk);
  }
  if (/\b(password|security settings|reset link|log in|login|sign in)\b/i.test(normalized)) {
    return !["password_reset", "login"].includes(currentAsk);
  }
  if (
    /\b(profile|headline|bio|summary|experience|skills?)\b/i.test(normalized) &&
    /\b(stand out|improve|better|stronger|complete|polish|best)\b/i.test(normalized)
  ) {
    return currentAsk !== "product_guidance";
  }
  if (
    /\b(can you just help me|help me understand|customer service|customer support|need support|need assistance)\b/i.test(
      normalized
    )
  ) {
    return currentAsk !== "generic_intake";
  }
  return false;
}

function buildFrustrationAcknowledgement(frustration = {}) {
  if (frustration.frustrationScore >= 3) return "I'm sorry you've had to deal with that.";
  if (frustration.frustrationScore >= 2) return "I know that's frustrating.";
  return "";
}

function buildConversationalClarificationReply({
  orchestration = {},
  frustration = {},
  conversationPlan = {},
  text = "",
} = {}) {
  const primaryAsk = String(orchestration.primaryAsk || "").toLowerCase();
  const topicKey = String(conversationPlan.topicKey || "").toLowerCase();
  const splitTopics = detectSplitSupportRequest(text, orchestration.relevantFacts?.userRole || "");
  const detectedTopics = splitTopics.length ? splitTopics.map((topic) => formatTopicSelectionLabel(topic).toLowerCase()) : describeDetectedSupportTopics(text);
  const empatheticLead =
    frustration.frustrationScore >= 3
      ? "I'm sorry you've had to deal with that. "
      : frustration.frustrationScore >= 2
      ? "I know that's frustrating. "
      : "";

  if ((splitTopics.length || detectOverloadedSupportRequest(text)) && detectedTopics.length) {
    return `${empatheticLead}I can help with ${formatNaturalList(detectedTopics)}. Which one do you want to start with?`.trim();
  }

  if (primaryAsk === "generic_intake" || topicKey === "general_support") {
    return `${empatheticLead}I can help with payouts, cases, messages, profile settings, or platform issues. What are you trying to do?`.trim();
  }

  if (topicKey === "general_guidance" || primaryAsk === "product_guidance") {
    return `${empatheticLead}Tell me what you're trying to do, and I'll point you in the right direction.`.trim();
  }

  if (primaryAsk === "navigation") {
    return `${empatheticLead}Tell me what page or area you're looking for, and I'll point you there.`.trim();
  }

  return `${empatheticLead}Tell me what you're trying to do and what happened, and I'll take it from there.`.trim();
}

function deriveSupportSnapshotCategoryHint(text = "", analysisCategory = "") {
  const normalized = String(text || "").trim().toLowerCase();
  const category = String(analysisCategory || "").trim().toLowerCase();

  if (category && category !== "unknown") return category;
  if (/\b(can'?t access|cannot access|locked out of)\b/i.test(normalized) && /\b(workspace|case|matter)\b/i.test(normalized)) {
    return "case_posting";
  }
  if (/\b(upload|share)\b/i.test(normalized) && /\b(documents?|files?)\b/i.test(normalized)) {
    return "case_posting";
  }
  if (/\b(messages?|chat|thread|msg)\b/i.test(normalized)) {
    return "messaging";
  }
  return category || "unknown";
}

async function buildWelcomeSupportState({ user = {}, conversation = {}, pageContext = {} } = {}) {
  const supportMeta = conversation?.metadata?.support || {};
  const supportOpenCount = Number(pageContext.supportOpenCount || 0) || 0;
  const repeatViewCount = Number(pageContext.repeatViewCount || 0) || 0;
  const viewName = String(pageContext.viewName || "").trim().toLowerCase();
  const role = String(user.role || "").trim().toLowerCase();
  const firstName = formatUserFirstName(user);
  const recentOpenTicket = await SupportTicket.findOne({
    userId: user._id,
    status: { $in: OPEN_TICKET_STATUSES },
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
  const recentResolvedTicket = !recentOpenTicket
    ? await SupportTicket.findOne({
        userId: user._id,
        status: { $in: RESOLVED_TICKET_STATUSES },
        resolutionIsStable: true,
        resolvedAt: { $gte: new Date(Date.now() - RECENT_RESOLVED_PROMPT_WINDOW_MS) },
      })
        .sort({ resolvedAt: -1, updatedAt: -1, createdAt: -1 })
        .lean()
    : null;
  const lastPromptAt = parseDate(supportMeta.lastProactivePromptAt);
  const cooldownActive =
    lastPromptAt && Date.now() - lastPromptAt.getTime() < PROACTIVE_PROMPT_COOLDOWN_MS;

  let welcomePrompt = "";
  if (firstName && (supportOpenCount > 1 || recentOpenTicket || recentResolvedTicket || conversation?.welcomeSentAt)) {
    welcomePrompt = `Welcome back, ${firstName}.`;
  }

  let proactivePrompt = null;
  if (!cooldownActive) {
    if (recentOpenTicket) {
      const issueLabel = buildOpenTicketIssueLabel(recentOpenTicket);
      const handedOffToEngineering = Array.isArray(recentOpenTicket.linkedIncidentIds) && recentOpenTicket.linkedIncidentIds.length > 0;
      proactivePrompt = {
        key: `open-ticket:${String(recentOpenTicket._id)}`,
        text: `You still have an open ${issueLabel}.`,
        actionText: "Check on it",
        message: `Can you check on my open ${issueLabel}?`,
        intent: "issue_review_status",
        issueLabel,
        issueState: "open",
        ticketId: String(recentOpenTicket._id),
        ticketStatus: recentOpenTicket.status || "open",
        handedOffToEngineering,
      };
    } else if (recentResolvedTicket) {
      const issueLabel = buildOpenTicketIssueLabel(recentResolvedTicket);
      proactivePrompt = {
        key: `resolved-ticket:${String(recentResolvedTicket._id)}`,
        text: `Your ${issueLabel} has been resolved.`,
        actionText: "See update",
        message: `Can you show me the update on my resolved ${issueLabel}?`,
        intent: "issue_review_status",
        issueLabel,
        issueState: "resolved",
        ticketId: String(recentResolvedTicket._id),
        ticketStatus: recentResolvedTicket.status || "resolved",
        handedOffToEngineering:
          Array.isArray(recentResolvedTicket.linkedIncidentIds) && recentResolvedTicket.linkedIncidentIds.length > 0,
      };
    } else if (viewName === "billing" && role === "attorney" && repeatViewCount >= 2) {
      proactivePrompt = {
        key: "billing-help",
        text: "Need help with billing or your payment method?",
        actionText: "Get billing help",
        message: "I need help with billing.",
      };
    } else if (viewName === "profile-settings" && role === "paralegal" && repeatViewCount >= 2) {
      proactivePrompt = {
        key: "stripe-setup-help",
        text: "Need help finishing Stripe setup?",
        actionText: "Get payout help",
        message: "I need help finishing Stripe setup.",
      };
    } else if (viewName === "case-detail" && pageContext.caseId && repeatViewCount >= 2) {
      proactivePrompt = {
        key: `case-help:${trimString(pageContext.caseId, 80)}`,
        text: "Need help with this case?",
        actionText: "Get case help",
        message: "I need help with this case.",
      };
    } else if (viewName === "dashboard-attorney" && role === "attorney" && supportOpenCount >= 2) {
      proactivePrompt = {
        key: "attorney-dashboard-help",
        text: "Need help finding a paralegal or funding a case?",
        actionText: "Get help",
        message: "I need help with a case.",
      };
    } else if (viewName === "dashboard-paralegal" && role === "paralegal" && supportOpenCount >= 2) {
      proactivePrompt = {
        key: "paralegal-dashboard-help",
        text: "Need help with payouts, messaging, or a case workspace?",
        actionText: "Get help",
        message: "I need help with a case.",
      };
    }
  }

  return {
    welcomePrompt,
    proactivePrompt,
  };
}

function responsePolicy({
  text = "",
  orchestration = {},
  conversationState = {},
  lastAssistantMessage = null,
  candidateReply = "",
  frustration = {},
  escalation = {},
  conversationPlan = {},
} = {}) {
  const lastReply = normalizeForComparison(lastAssistantMessage?.text || conversationState.lastAssistantReply || "");
  const nextReply = normalizeForComparison(candidateReply);
  const repeated = Boolean(lastReply && nextReply && lastReply === nextReply);
  let responseMode = String(orchestration.responseMode || "DIRECT_ANSWER").toUpperCase();
  let reply = candidateReply;
  const frustrationAcknowledgement = buildFrustrationAcknowledgement(frustration);

  if (frustration.needsAcknowledgement && frustrationAcknowledgement && !repeated) {
    const normalizedAcknowledgement = normalizeForComparison(frustrationAcknowledgement);
    if (!nextReply.startsWith(normalizedAcknowledgement)) {
      reply = `${frustrationAcknowledgement} ${reply}`.trim();
    }
  }

  if (
    responseMode === "CLARIFY_ONCE" &&
    orchestration.primaryAsk === "generic_intake" &&
    (
      frustration.needsAcknowledgement ||
      trimString(conversationState.activeAsk, 120) ||
      detectOverloadedSupportRequest(text) ||
      detectSplitSupportRequest(text, orchestration.relevantFacts?.userRole || "").length
    )
  ) {
    reply = buildConversationalClarificationReply({
      orchestration,
      frustration,
      conversationPlan,
      text,
    });
  }

  if (repeated) {
    if (["topic_switch", "correction", "new_topic", "same_topic_followup"].includes(String(conversationPlan.turnKind || ""))) {
      return {
        responseMode,
        reply: candidateReply,
        repeated,
        maxSentences: 4,
      };
    }
    if (orchestration.primaryAsk === "navigation" || /^you can (find|open|update) that here\.?$/i.test(String(candidateReply || "").trim())) {
      return {
        responseMode,
        reply: candidateReply,
        repeated,
        maxSentences: 2,
      };
    }
    if (responseMode === "DIRECT_ANSWER" && orchestration.primaryAsk === "responsiveness_issue") {
      responseMode = "ESCALATE";
      reply =
        conversationState.escalationOffered === true
          ? "If they still haven't replied, the team can review the thread."
          : buildEscalationReply("responsiveness_issue");
    } else if (responseMode === "DIRECT_ANSWER" && orchestration.awaitingField) {
      responseMode = "CLARIFY_ONCE";
      reply = orchestration.awaitingField === "case_identifier"
        ? "Which case are you asking about?"
        : "Tell me a little more about what you're trying to do.";
    } else if (responseMode === "CLARIFY_ONCE" && orchestration.primaryAsk === "generic_intake") {
      reply = buildConversationalClarificationReply({
        orchestration,
        frustration,
        conversationPlan,
        text,
      });
    } else if (orchestration.primaryAsk === "payment_clarify") {
      reply = buildPaymentClarificationReply(orchestration.relevantFacts || {});
    } else {
      responseMode = "CLARIFY_ONCE";
      reply = buildConversationalClarificationReply({
        orchestration,
        frustration,
        conversationPlan,
        text,
      });
    }
  }

  return {
    responseMode,
    reply,
    repeated,
    maxSentences: 4,
  };
}

function buildAssistantSummary({ category = "", reply = "", facts = {}, pageContext = {} } = {}) {
  const parts = [`Category: ${formatCategoryLabel(category)}.`];
  if (pageContext.primaryAsk) {
    parts.push(`Primary ask: ${String(pageContext.primaryAsk).replace(/_/g, " ")}.`);
  }
  if (pageContext.responseMode) {
    parts.push(`Response mode: ${String(pageContext.responseMode).replace(/_/g, " ")}.`);
  }
  if (pageContext.paymentSubIntent) {
    parts.push(`Payment intent: ${String(pageContext.paymentSubIntent).replace(/_/g, " ")}.`);
  }
  if (pageContext.viewName || pageContext.pathname) {
    parts.push(`Surface: ${pageContext.viewName || pageContext.pathname}.`);
  }
  if (facts.caseState?.caseId) {
    parts.push(
      `Case: ${facts.caseState.title || facts.caseState.caseId}${facts.caseState.inferred ? " (inferred)" : ""}.`
    );
  }
  if (facts.stripeState?.accountId) {
    parts.push(
      `Stripe: detailsSubmitted=${facts.stripeState.detailsSubmitted === true}, payoutsEnabled=${facts.stripeState.payoutsEnabled === true}.`
    );
  }
  if (facts.payoutState?.paymentReleased) {
    parts.push(`LPC payment released${facts.payoutState.paidOutAt ? ` on ${formatDate(facts.payoutState.paidOutAt)}` : ""}.`);
  }
  if (facts.messagingState?.reason) {
    parts.push(`Messaging: ${facts.messagingState.reason}.`);
  }
  if (pageContext.navigation?.ctaHref) {
    parts.push(`Navigation: ${pageContext.navigation.ctaHref}.`);
  }
  if (facts.blockers?.length) {
    parts.push(`Blockers: ${facts.blockers.join(", ")}.`);
  }
  parts.push(`Reply: ${trimString(reply, 1200)}`);
  return parts.join(" ").trim();
}

function buildGroundedReply({ analysis = {}, facts = {}, pageContext = {}, options = {}, orchestration = {} } = {}) {
  const category = String(orchestration.category || analysis.category || "unknown").toLowerCase();
  const primaryAsk = String(orchestration.primaryAsk || "").trim().toLowerCase();
  const paymentSubIntent = String(options.paymentSubIntent || "").trim().toLowerCase();
  const stripeConceptQuestion = isStripeConceptQuestion(options.text);

  if (orchestration.responseMode === "ESCALATE") {
    return buildEscalationReply(primaryAsk);
  }
  if (primaryAsk === "issue_resolved") {
    return buildResolvedReply({ text: options.text });
  }
  if (primaryAsk === "issue_reopen") {
    return buildIssueReopenReply({
      conversationState: options.conversationState,
      issueLifecycle: options.issueLifecycle || null,
    });
  }
  if (primaryAsk === "issue_review_status") {
    return buildIssueReviewStatusReply({
      conversationState: options.conversationState,
      issueLifecycle: options.issueLifecycle || null,
    });
  }
  if (primaryAsk === "participant_lookup") {
    return buildParticipantReply(facts, options);
  }
  if (primaryAsk === "case_status") {
    return buildCaseStatusReply(facts);
  }
  if (primaryAsk === "workspace_access") {
    return buildWorkspaceAccessReply(facts);
  }
  if (primaryAsk === "payment_clarify") {
    return buildPaymentClarificationReply(facts);
  }
  if (primaryAsk === "case_payment") {
    return buildCasePaymentReply(facts);
  }
  if (primaryAsk === "product_guidance") {
    return buildExplainReply(facts, {
      text: options.text,
      pageContext,
      conversationState: options.conversationState,
    }).reply;
  }
  if (primaryAsk === "generic_intake") {
    return buildIntakeReply({ followUpAttempted: options.followUpAttempted === true });
  }
  if (primaryAsk === "responsiveness_issue") {
    return buildResponsivenessReply(facts);
  }

  if (stripeConceptQuestion && ["payment", "stripe_onboarding"].includes(category)) {
    return buildStripeReply(facts, { text: options.text });
  }

  if (category === "payment") {
    if (paymentSubIntent === "billing_method") return buildBillingMethodReply(facts);
    if (paymentSubIntent === "case_payment") return buildCasePaymentReply(facts);
    if (paymentSubIntent === "unclear") return buildPaymentClarificationReply(facts);
    return buildPayoutReply(facts, options);
  }
  if (category === "stripe_onboarding") return buildStripeReply(facts);
  if (category === "messaging") return buildMessagingReply(facts);
  if (category === "case_posting") return buildCaseReply(facts);
  if (category === "account_approval") return buildApprovalReply(facts);

  return buildGenericReply({ analysis, facts, pageContext });
}

function buildTaskAnswer({
  task = "UNKNOWN",
  message = "",
  facts = {},
  pageContext = {},
  analysis = {},
  previousState = {},
} = {}) {
  if (task === "NAVIGATION") {
    return resolveNavigationTarget({ text: message, pageContext, supportFacts: facts, previousState });
  }

  if (task === "FACT_LOOKUP") {
    const lookupIntent = detectFactLookupIntent(message);
    if (lookupIntent === "participant") {
      return { reply: buildParticipantReply(facts, { text: message }), navigation: null };
    }
    if (lookupIntent === "status") {
      return { reply: buildCaseStatusReply(facts), navigation: null };
    }
    if (lookupIntent === "stripe") {
      return { reply: buildStripeReply(facts, { text: message }), navigation: null };
    }
    return { reply: buildCaseReply(facts), navigation: null };
  }

  if (task === "EXPLAIN") {
    return buildExplainReply(facts, {
      text: message,
      pageContext,
      conversationState: previousState,
    });
  }

  if (task === "TROUBLESHOOT") {
    const troubleshootIntent = detectTroubleshootIntent(message, facts.userRole || "");
    if (troubleshootIntent === "account_access") {
      return {
        reply: String(analysis.category || "").toLowerCase() === "password_reset"
          ? "You can change your password in Security settings."
          : "You can manage account access from Security settings.",
        navigation: null,
      };
    }
    if (troubleshootIntent === "billing") {
      return { reply: buildBillingMethodReply(facts), navigation: null };
    }
    if (troubleshootIntent === "payout") {
      return { reply: buildPayoutReply(facts, { text: message, paymentSubIntent: "payout" }), navigation: null };
    }
    if (troubleshootIntent === "case_payment") {
      return { reply: buildCasePaymentReply(facts), navigation: null };
    }
    if (troubleshootIntent === "messaging") {
      return { reply: buildMessagingReply(facts), navigation: null };
    }
    if (troubleshootIntent === "workspace") {
      return { reply: buildWorkspaceAccessReply(facts), navigation: null };
    }
    if (troubleshootIntent === "payment_ambiguous") {
      return { reply: buildPaymentClarificationReply(facts), navigation: null };
    }
    return { reply: buildGenericReply({ analysis, facts, pageContext }), navigation: null };
  }

  if (task === "HUMAN_ISSUE") {
    const escalationShown = previousState.escalationShown === true || previousState.escalationOffered === true;
    if (escalationShown || /\b(still|again|nothing|yet|same)\b/i.test(String(message || ""))) {
      return {
        reply: "If they still haven't replied, I'm sending this to the team for review now.",
        navigation: null,
      };
    }
    return {
      reply: buildResponsivenessReply(facts),
      navigation: null,
    };
  }

  if (task === "ESCALATION") {
    return {
      reply: buildEscalationReply("request_human_help"),
      navigation: null,
    };
  }

  return {
    reply: buildIntakeReply({ followUpAttempted: previousState.lastResponseType === "ASK" }),
    navigation: null,
  };
}

function buildTaskDrivenReplyPayload({
  text = "",
  analysis = {},
  pageContext = {},
  facts = {},
  previousState = {},
  task = "UNKNOWN",
  activeEntity = null,
  frustration = {},
} = {}) {
  const responseType = chooseTaskResponseType({
    task,
    message: text,
    previousState,
    activeEntity,
    facts,
  });
  const answer = buildTaskAnswer({
    task,
    message: text,
    facts,
    pageContext,
    analysis,
    previousState,
  });

  let reply = "";
  let awaiting = null;
  let navigation = answer.navigation || null;
  if (responseType === "ASK") {
    if (task === "NAVIGATION" && answer.reply) {
      reply = answer.reply;
    } else if (task === "FACT_LOOKUP" || task === "TROUBLESHOOT") {
      awaiting = "case";
      reply = "Which case is this about?";
    } else {
      reply = buildIntakeReply({ followUpAttempted: previousState.lastResponseType === "ASK" });
    }
  } else if (responseType === "ESCALATE") {
    reply = answer.reply || buildEscalationReply("request_human_help");
  } else {
    if (task === "NAVIGATION" && answer.mode === "resolved") {
      reply = answer.reply;
      navigation = answer.navigation || null;
    } else {
      reply = answer.reply;
    }
  }

  reply = simplifyResponseLanguage(trimString(reply, MAX_REPLY_LENGTH));
  const policy = responsePolicy({
    text,
    orchestration: {
      primaryAsk: task,
      responseMode: responseType,
      awaitingField: awaiting || "",
    },
    conversationState: previousState,
    lastAssistantMessage: null,
    candidateReply: reply,
    frustration,
    escalation: {
      needsEscalation: responseType === "ESCALATE",
      escalationReason:
        task === "HUMAN_ISSUE"
          ? "interaction_responsiveness_review"
          : responseType === "ESCALATE"
          ? "support_review_recommended"
          : "",
    },
  });

  const showEscalationCard =
    responseType === "ESCALATE" &&
    previousState.escalationSent !== true &&
    previousState.escalationShown !== true;
  const category = mapPrimaryAskToCategory(
    task === "FACT_LOOKUP"
      ? detectFactLookupIntent(text) === "participant"
        ? "participant_lookup"
        : detectFactLookupIntent(text) === "status"
        ? "case_status"
        : detectFactLookupIntent(text) === "stripe"
        ? "stripe_onboarding"
        : "help_with_case"
      : task === "NAVIGATION"
      ? "navigation"
      : task === "EXPLAIN"
      ? "product_guidance"
      : task === "HUMAN_ISSUE"
      ? "responsiveness_issue"
      : task === "TROUBLESHOOT"
      ? detectTroubleshootIntent(text, facts.userRole || "") === "billing"
        ? "billing_payment_method"
        : detectTroubleshootIntent(text, facts.userRole || "") === "payout"
        ? "payout_question"
        : detectTroubleshootIntent(text, facts.userRole || "") === "case_payment"
        ? "case_payment"
        : detectTroubleshootIntent(text, facts.userRole || "") === "workspace"
        ? "workspace_access"
        : detectTroubleshootIntent(text, facts.userRole || "") === "messaging"
        ? "messaging_access"
        : "generic_intake"
      : task === "ESCALATION"
      ? "request_human_help"
      : "generic_intake",
    analysis.category
  );
  const actions = buildSelfServiceActions({
    category,
    primaryAsk: category,
    paymentSubIntent:
      category === "payment"
        ? detectTroubleshootIntent(text, facts.userRole || "") === "billing"
          ? "billing_method"
          : detectTroubleshootIntent(text, facts.userRole || "") === "case_payment"
          ? "case_payment"
          : detectTroubleshootIntent(text, facts.userRole || "") === "payout"
          ? "payout"
          : "none"
        : "none",
    navigation,
    supportFacts: facts,
    pageContext,
  });
  const suggestedReplies =
    responseType === "ASK" && awaiting === "case"
      ? ["This case", "Across all messages"]
      : [];

  return {
    text: policy.reply,
    payload: {
      category,
      categoryLabel: formatCategoryLabel(category),
      urgency: String(analysis.urgency || "medium").toLowerCase(),
      confidence: activeEntity || ["NAVIGATION", "EXPLAIN"].includes(task) ? "high" : "medium",
      provider: analysis.provider || "rules",
      aiEnabled: analysis.aiEnabled === true,
      grounded: true,
      pageContext: {
        ...pageContext,
        ...(navigation ? { navigation } : {}),
      },
      supportFacts: facts,
      primaryAsk: category,
      activeTask: task,
      activeEntity: activeEntity
        ? { type: "case", id: activeEntity, source: pageContext.caseId ? "page_context" : "resolved" }
        : null,
      awaitingField: awaiting || "",
      awaiting: awaiting || null,
      navigation,
      actions,
      suggestedReplies,
      manualReviewSuggested: showEscalationCard,
      needsEscalation: showEscalationCard,
      escalationReason:
        task === "HUMAN_ISSUE"
          ? "interaction_responsiveness_review"
          : responseType === "ESCALATE"
          ? "support_review_recommended"
          : "",
      awaitingClarification: responseType === "ASK",
      intakeMode: task === "UNKNOWN",
      detailLevel: "concise",
      routing: buildRouting(category, String(analysis.urgency || "medium").toLowerCase()),
      responseMode: responseType,
      responseType,
      sentiment: frustration.sentiment,
      frustrationScore: frustration.frustrationScore,
      escalationPriority: frustration.escalationPriority,
      escalation: {
        available: showEscalationCard,
        requested: false,
        ticketId: "",
        ticketReference: "",
        reason:
          task === "HUMAN_ISSUE"
            ? "interaction_responsiveness_review"
            : responseType === "ESCALATE"
            ? "support_review_recommended"
            : "",
        requestedAt: null,
      },
    },
    internalSummary: buildAssistantSummary({
      category,
      reply: policy.reply,
      facts,
      pageContext: {
        ...pageContext,
        primaryAsk: task,
        responseMode: responseType,
        ...(navigation ? { navigation } : {}),
      },
    }),
  };
}

function buildReplyPayload({ analysis = {}, pageContext = {}, supportFacts = {}, text = "", conversationContext = {} } = {}) {
  const conversationState = conversationContext.supportState || {};
  const frustration = conversationContext.frustration || detectFrustrationSignals(text);
  const previousSelectionTopics = getTopicSelectionOptions(conversationState);
  const effectiveSupportFacts =
    supportFacts?.caseState?.caseId &&
    conversationContext.resolvedCaseSource &&
    !["page_context", "memory", "case_name_match"].includes(String(conversationContext.resolvedCaseSource || ""))
      ? {
          ...supportFacts,
          caseState: {
            ...supportFacts.caseState,
            inferred: true,
            inferenceSource: String(conversationContext.resolvedCaseSource || ""),
          },
        }
      : supportFacts;

  const orchestration = orchestrateSupportTurn({
    text,
    analysis,
    pageContext,
    supportFacts: effectiveSupportFacts,
    conversationState,
    issueLifecycle: conversationContext.issueLifecycle || null,
    frustration,
    task: conversationContext.task || conversationState.activeTask || "",
    resolvedCaseId: conversationContext.resolvedCaseId || "",
    resolvedCaseSource: conversationContext.resolvedCaseSource || "",
    promptAction: conversationContext.promptAction || null,
  });

  if (
    !pageContext.caseId &&
    ["messaging_access", "workspace_access"].includes(String(orchestration.primaryAsk || "").toLowerCase()) &&
    orchestration.relevantFacts?.caseState?.caseId &&
    orchestration.relevantFacts.caseState.inferred !== true
  ) {
    orchestration.relevantFacts.caseState = {
      ...orchestration.relevantFacts.caseState,
      inferred: true,
      inferenceSource:
        orchestration.relevantFacts.caseState.inferenceSource ||
        String(conversationContext.resolvedCaseSource || "") ||
        "recent_active_case",
    };
  }

  const category = String(orchestration.category || analysis.category || "unknown").toLowerCase();
  const urgency = String(analysis.urgency || "medium").toLowerCase();
  let navigation = orchestration.navigation;
  const paymentSubIntent = orchestration.paymentSubIntent;
  const routing = buildRouting(category, urgency);
  const explainAnswer =
    orchestration.primaryAsk === "product_guidance"
      ? buildExplainReply(orchestration.relevantFacts, {
          text,
          pageContext,
          conversationState,
        })
      : null;
  const issueStatusSecondaryGuidance =
    ["issue_review_status", "issue_reopen"].includes(String(orchestration.primaryAsk || "").trim().toLowerCase())
      ? buildIssueStatusSecondaryGuidance({
          text,
          supportFacts: orchestration.relevantFacts,
          pageContext,
          conversationState,
        })
      : null;

  if (orchestration.primaryAsk === "product_guidance" && (!navigation || navigation.mode === "none") && explainAnswer?.navigation) {
    navigation = {
      mode: "resolved",
      reply: explainAnswer.reply,
      navigation: explainAnswer.navigation,
    };
  }
  if (
    ["issue_review_status", "issue_reopen"].includes(String(orchestration.primaryAsk || "").trim().toLowerCase()) &&
    (!navigation || navigation.mode === "none") &&
    issueStatusSecondaryGuidance?.navigation
  ) {
    navigation = {
      mode: "resolved",
      reply: issueStatusSecondaryGuidance.reply,
      navigation: issueStatusSecondaryGuidance.navigation,
    };
  }

  const navigationHandled = navigation.mode === "resolved" || navigation.mode === "clarify";
  const confidence = navigationHandled
    ? navigation.mode === "resolved"
      ? "high"
      : "medium"
    : deriveConfidence(category, supportFacts);
  const intakeMode =
    orchestration.responseMode === "CLARIFY_ONCE" && orchestration.primaryAsk === "generic_intake";
  const intakeFollowUpAttempted = conversationContext.awaitingIntakeDetails === true;
  const escalation = orchestration.primaryAsk === "issue_resolved" || navigationHandled || intakeMode
    ? {
        needsEscalation: false,
        escalationReason: "",
      }
    : orchestration.responseMode === "ESCALATE"
    ? {
        needsEscalation: true,
        escalationReason:
          orchestration.primaryAsk === "responsiveness_issue"
            ? "interaction_responsiveness_review"
            : "support_review_recommended",
      }
    : deriveEscalation({
        category,
        facts: orchestration.relevantFacts,
        confidence,
        options: {
          paymentSubIntent,
          primaryAsk: orchestration.primaryAsk,
          frustrationScore: frustration.frustrationScore,
          escalationOffered: conversationState.escalationOffered === true,
          followUpAttempted: conversationContext.awaitingMessagingClarification === true,
          text,
        },
      });

  const baseGroundedReply = intakeMode
    ? buildIntakeReply({ followUpAttempted: intakeFollowUpAttempted })
    : buildGroundedReply({
        analysis: { ...analysis, category },
        facts: orchestration.relevantFacts,
        pageContext: {
          ...pageContext,
          ...(navigation.navigation ? { navigation: navigation.navigation } : {}),
          ...(paymentSubIntent ? { paymentSubIntent } : {}),
        },
        options: {
          paymentSubIntent,
          text,
          followUpAttempted: intakeFollowUpAttempted,
          conversationState,
          issueLifecycle: conversationContext.issueLifecycle || null,
        },
        orchestration,
      });

  const groundedReply = ["issue_review_status", "issue_reopen"].includes(
    String(orchestration.primaryAsk || "").trim().toLowerCase()
  )
    ? navigation.mode === "resolved"
      ? appendSecondarySupportReply(baseGroundedReply, navigation.reply)
      : issueStatusSecondaryGuidance?.reply
      ? appendSecondarySupportReply(baseGroundedReply, issueStatusSecondaryGuidance.reply)
      : baseGroundedReply
    : navigationHandled
    ? navigation.reply
    : baseGroundedReply;

  const splitTopicOptions = Array.isArray(conversationContext.splitTopicOptions)
    ? conversationContext.splitTopicOptions.map((value) => trimString(value, 80).toLowerCase()).filter(Boolean).slice(0, 3)
    : [];
  const selectedTopicOption = resolveTopicSelection(text, {
    selectionTopics: previousSelectionTopics,
    lastSelectionTopic: conversationState.lastSelectionTopic,
    topicKey: conversationState.topicKey,
  });
  const persistedSelectionTopics =
    splitTopicOptions.length
      ? splitTopicOptions
      : previousSelectionTopics.length &&
        (selectedTopicOption || String(conversationState.awaitingField || "").toLowerCase() === "topic_selection")
      ? previousSelectionTopics
      : [];
  const persistedLastSelectionTopic =
    splitTopicOptions.length
      ? ""
      : selectedTopicOption || (persistedSelectionTopics.length ? trimString(conversationState.lastSelectionTopic, 80) : "");
  const persistedAwaitingField =
    splitTopicOptions.length
      ? "topic_selection"
      : explainAnswer?.awaitingField || orchestration.awaitingField || "";
  const awaitingClarification = navigation.mode === "clarify" || Boolean(persistedAwaitingField);

  const shaped = shapeSupportResponse({
    category,
    text,
    groundedReply,
    supportFacts: orchestration.relevantFacts,
    nextSteps: [],
    escalation,
    intakeMode,
    awaitingClarification,
    options: {
      paymentSubIntent,
      text,
      frustrationScore: frustration.frustrationScore,
      primaryAsk: orchestration.primaryAsk,
    },
  });

  const conversationPlan = planSupportConversationTurn({
    text,
    primaryAsk: orchestration.primaryAsk,
    category,
    paymentSubIntent,
    supportFacts: orchestration.relevantFacts,
    conversationState,
  });
  const derivedIssueLabel = summarizeSupportIssueLabel({
    primaryAsk: orchestration.primaryAsk,
    category,
    supportFacts: orchestration.relevantFacts,
    activeEntity: orchestration.activeEntity,
  });
  const currentIssueLabel = derivedIssueLabel
    ? derivedIssueLabel
    : conversationPlan.shouldRetainIssueContext || orchestration.primaryAsk === "issue_reopen"
    ? resolveIssueConversationLabel({
        conversationState,
        issueLifecycle: conversationContext.issueLifecycle || null,
      })
    : "";
  const currentIssueSummary = currentIssueLabel
    ? buildConversationIssueSummary({
        issueLabel: currentIssueLabel,
        text,
        supportFacts: orchestration.relevantFacts,
      })
    : "";
  const compoundIntent =
    COMPOUND_EXPLAIN_INTENTS.has(String(orchestration.relevantFacts?.explainIntent || "").toLowerCase())
      ? trimString(orchestration.relevantFacts.explainIntent, 120)
      : orchestration.primaryAsk === "product_guidance"
      ? trimString(conversationState.compoundIntent, 120)
      : "";
  const lastCompoundBranch =
    compoundIntent && !COMPOUND_EXPLAIN_INTENTS.has(String(orchestration.relevantFacts?.explainIntent || "").toLowerCase())
      ? trimString(orchestration.relevantFacts?.explainIntent, 120) || trimString(conversationState.lastCompoundBranch, 120)
      : compoundIntent
      ? ""
      : "";
  const recentTopics = buildConversationTopicTrail(
    conversationState.recentTopics,
    currentIssueLabel || conversationPlan.topicLabel
  );
  const resolvedNavigationPayload = navigation.navigation;
  const lastNavigationLabel = resolvedNavigationPayload?.ctaLabel
    ? trimString(resolvedNavigationPayload.ctaLabel, 120)
    : trimString(conversationState.lastNavigationLabel, 120);
  const lastNavigationHref = resolvedNavigationPayload?.ctaHref
    ? trimString(resolvedNavigationPayload.ctaHref, 500)
    : trimString(conversationState.lastNavigationHref, 500);
  const reply = trimString(shaped.text, MAX_REPLY_LENGTH);
  const showEscalationCard =
    escalation.needsEscalation === true &&
    conversationState.escalationSent !== true &&
    !(
      orchestration.primaryAsk === "responsiveness_issue" &&
      conversationState.escalationOffered === true
    );
  const actions = buildSelfServiceActions({
    category,
    primaryAsk: orchestration.primaryAsk,
    paymentSubIntent,
    navigation: navigation.navigation,
    supportFacts: orchestration.relevantFacts,
    pageContext,
    needsEscalation: showEscalationCard,
  });
  const suggestedReplies = buildSuggestedReplies({
    primaryAsk: orchestration.primaryAsk,
    awaitingField: persistedAwaitingField,
    paymentSubIntent,
    supportFacts: orchestration.relevantFacts,
    conversationState,
    selectionTopics: persistedSelectionTopics,
    navigation: navigation.navigation,
  });

  return {
    text: reply,
    payload: {
      category,
      categoryLabel: formatCategoryLabel(category),
      urgency,
      confidence,
      provider: analysis.provider || "fallback",
      aiEnabled: analysis.aiEnabled === true,
      grounded: true,
      pageContext: {
        ...pageContext,
        ...(navigation.navigation ? { navigation: navigation.navigation } : {}),
        ...(paymentSubIntent ? { paymentSubIntent } : {}),
      },
      supportFacts: orchestration.relevantFacts,
      primaryAsk: orchestration.primaryAsk,
      activeTask: orchestration.task || "",
      activeEntity: orchestration.activeEntity,
      awaiting: persistedAwaitingField === "case_identifier" ? "case" : persistedAwaitingField || null,
      awaitingField: persistedAwaitingField,
      paymentSubIntent,
      navigation: navigation.navigation,
      actions,
      suggestedReplies,
      manualReviewSuggested: showEscalationCard,
      needsEscalation: showEscalationCard,
      escalationReason: escalation.escalationReason,
      awaitingClarification,
      intakeMode,
      detailLevel: shaped.detailLevel,
      routing,
      responseMode: orchestration.responseMode || "DIRECT_ANSWER",
      sentiment: frustration.sentiment,
      frustrationScore: frustration.frustrationScore,
      escalationPriority: frustration.escalationPriority,
      currentIssueLabel,
      currentIssueSummary,
      compoundIntent,
      lastCompoundBranch,
      selectionTopics: persistedSelectionTopics,
      lastSelectionTopic: persistedLastSelectionTopic,
      topicKey: conversationPlan.topicKey,
      topicLabel: conversationPlan.topicLabel,
      topicMode: conversationPlan.topicMode,
      turnKind: conversationPlan.turnKind,
      recentTopics,
      lastNavigationLabel,
      lastNavigationHref,
      turnCount: Number(conversationState.turnCount || 0) + 1,
      escalation: {
        available: showEscalationCard,
        requested: false,
        ticketId: "",
        ticketReference: "",
        reason: escalation.escalationReason,
        requestedAt: null,
      },
    },
    internalSummary: buildAssistantSummary({
      category,
      reply,
      facts: orchestration.relevantFacts,
      pageContext: {
        ...pageContext,
        ...(navigation.navigation ? { navigation: navigation.navigation } : {}),
        ...(paymentSubIntent ? { paymentSubIntent } : {}),
        primaryAsk: orchestration.primaryAsk,
        responseMode: orchestration.responseMode || "DIRECT_ANSWER",
      },
    }),
  };
}

function serializeConversation(conversation = {}) {
  const supportState = getConversationPolicyState(conversation);
  const supportMetadata = conversation.metadata?.support || {};
  return {
    id: String(conversation._id || conversation.id || ""),
    userId: String(conversation.userId || ""),
    role: conversation.role || "unknown",
    status: conversation.status || "open",
    sourceSurface: conversation.sourceSurface || "manual",
    sourcePage: conversation.sourcePage || "",
    pageContext: conversation.pageContext || {},
    escalation: {
      requested: conversation.escalation?.requested === true,
      requestedAt: conversation.escalation?.requestedAt || null,
      ticketId: conversation.escalation?.ticketId ? String(conversation.escalation.ticketId) : "",
      ticketReference: conversation.escalation?.ticketId
        ? formatSupportTicketReference(conversation.escalation.ticketId)
        : "",
      note: conversation.escalation?.note || "",
      engineeringReviewStarted:
        conversation.escalation?.engineeringReviewStarted === true || supportMetadata.engineeringReviewStarted === true,
      engineeringReviewStartedAt:
        conversation.escalation?.engineeringReviewStartedAt || supportMetadata.engineeringReviewStartedAt || null,
      diagnosisRunId: conversation.escalation?.diagnosisRunId || supportMetadata.diagnosisRunId || "",
      engineeringExecutionStarted:
        conversation.escalation?.engineeringExecutionStarted === true || supportMetadata.engineeringExecutionStarted === true,
      engineeringExecutionStartedAt:
        conversation.escalation?.engineeringExecutionStartedAt || supportMetadata.engineeringExecutionStartedAt || null,
      executionRunId: conversation.escalation?.executionRunId || supportMetadata.executionRunId || "",
      executionStatus: conversation.escalation?.executionStatus || supportMetadata.executionStatus || "",
    },
    supportState,
    lastMessageAt: conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt || null,
    createdAt: conversation.createdAt || null,
    updatedAt: conversation.updatedAt || null,
  };
}

function serializeMessage(message = {}) {
  return {
    id: String(message._id || message.id || ""),
    conversationId: String(message.conversationId || ""),
    sender: message.sender || "assistant",
    text: message.text || "",
    sourcePage: message.sourcePage || "",
    pageContext: message.pageContext || {},
    metadata: {
      kind: message.metadata?.kind || "",
      source: message.metadata?.source || "",
      teamLabel: message.metadata?.teamLabel || "",
      adminId: message.metadata?.adminId ? String(message.metadata.adminId) : "",
      adminName: message.metadata?.adminName || "",
      ticketId: message.metadata?.ticketId ? String(message.metadata.ticketId) : "",
      ticketReference: message.metadata?.ticketReference || "",
      ticketStatus: message.metadata?.ticketStatus || "",
      category: message.metadata?.category || "",
      categoryLabel: message.metadata?.categoryLabel || "",
      urgency: message.metadata?.urgency || "",
      confidence: message.metadata?.confidence || "",
      provider: message.metadata?.provider || "",
      grounded: message.metadata?.grounded === true,
      manualReviewSuggested: message.metadata?.manualReviewSuggested === true,
      needsEscalation: message.metadata?.needsEscalation === true,
      escalationReason: message.metadata?.escalationReason || "",
      routing: message.metadata?.routing || null,
      navigation: message.metadata?.navigation || null,
      actions: Array.isArray(message.metadata?.actions) ? message.metadata.actions : [],
      suggestedReplies: Array.isArray(message.metadata?.suggestedReplies)
        ? message.metadata.suggestedReplies
        : [],
      handoffSummary: message.metadata?.handoffSummary || "",
      supportFacts: message.metadata?.supportFacts || null,
      primaryAsk: message.metadata?.primaryAsk || "",
      activeEntity: message.metadata?.activeEntity || null,
      awaitingField: message.metadata?.awaitingField || "",
      responseMode: message.metadata?.responseMode || "",
      escalation: message.metadata?.escalation || null,
    },
    createdAt: message.createdAt || null,
    updatedAt: message.updatedAt || null,
  };
}

async function findConversationForUser(conversationId, userId) {
  if (!conversationId || !mongoose.Types.ObjectId.isValid(conversationId)) return null;
  return SupportConversation.findOne({
    _id: conversationId,
    userId,
  });
}

async function loadSupportUser(user = {}) {
  const userId = normalizeId(user._id || user.id);
  if (!userId || !mongoose.isValidObjectId(userId)) return null;
  return User.findById(userId).select(SUPPORT_USER_FIELDS).lean();
}

async function getLatestAssistantMessageForConversation(conversationId) {
  if (!conversationId) return null;
  return SupportMessage.findOne({
    conversationId,
    sender: "assistant",
  })
    .sort({ createdAt: -1, _id: -1 })
    .lean();
}

function buildSupportFallbackPayload() {
  return {
    text: "I'm having trouble right now, please try again.",
    payload: {
      category: "general_support",
      categoryLabel: "Support",
      urgency: "medium",
      confidence: "low",
      provider: "fallback",
      manualReviewSuggested: false,
      needsEscalation: false,
      escalationReason: "",
      routing: null,
      navigation: null,
      actions: [],
      suggestedReplies: [],
      grounded: true,
      supportFacts: null,
      primaryAsk: "general_support",
      activeTask: "ANSWER",
      activeEntity: null,
      awaiting: null,
      awaitingField: "",
      responseMode: "DIRECT_ANSWER",
      escalation: {
        available: false,
        requested: false,
        ticketId: "",
        ticketReference: "",
        reason: "",
        requestedAt: null,
      },
      sentiment: "neutral",
      frustrationScore: 0,
      escalationPriority: "normal",
      currentIssueLabel: "",
      currentIssueSummary: "",
      compoundIntent: "",
      lastCompoundBranch: "",
      selectionTopics: [],
      lastSelectionTopic: "",
      topicKey: "",
      topicLabel: "",
      topicMode: "",
      turnKind: "",
      recentTopics: [],
      lastNavigationLabel: "",
      lastNavigationHref: "",
      turnCount: 1,
      awaitingClarification: false,
      intakeMode: false,
      detailLevel: "concise",
      aiEnabled: false,
    },
    internalSummary: "OpenAI support reply failed.",
  };
}

function hasMeaningfulSupportFactValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value).some((entry) => hasMeaningfulSupportFactValue(entry));
  return false;
}

function mergeSupportFacts(...sources) {
  return sources.reduce((merged, source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return merged;
    }

    for (const [key, value] of Object.entries(source)) {
      if (!hasMeaningfulSupportFactValue(value)) continue;

      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        merged[key] &&
        typeof merged[key] === "object" &&
        !Array.isArray(merged[key])
      ) {
        merged[key] = mergeSupportFacts(merged[key], value);
      } else {
        merged[key] = value;
      }
    }

    return merged;
  }, {});
}

async function resolveEscalationSupportFacts({
  user = {},
  latestUserMessage = "",
  pageContext = {},
  supportFacts = {},
} = {}) {
  const role = String(user?.role || "").trim().toLowerCase();
  const normalizedText = normalizeSupportUserText(latestUserMessage);
  const effectivePageContext = sanitizePageContext(pageContext);
  const resolvedFacts = mergeSupportFacts({ userRole: role }, supportFacts);

  const shouldLoadCaseState =
    !resolvedFacts.caseState &&
    (Boolean(effectivePageContext.caseId) ||
      /\b(case|cases|matter|matters|workspace|messages?|chat|thread|documents?|files?|billing|fund|payment|payout)\b/i.test(
        normalizedText
      ));
  if (shouldLoadCaseState) {
    const caseState = await getCaseSnapshot(user, effectivePageContext);
    if (hasMeaningfulSupportFactValue(caseState)) {
      resolvedFacts.caseState = caseState;
    }
  }

  if (
    !resolvedFacts.billingMethodState &&
    role === "attorney" &&
    /\b(payment method|billing method|saved card|card|invoice|receipt|billing)\b/i.test(normalizedText)
  ) {
    const billingMethodState = await getBillingMethodSnapshot(user, effectivePageContext);
    if (hasMeaningfulSupportFactValue(billingMethodState)) {
      resolvedFacts.billingMethodState = billingMethodState;
    }
  }

  if (
    !resolvedFacts.stripeState &&
    role === "paralegal" &&
    /\b(payout|stripe|bank account|get paid|payment)\b/i.test(normalizedText)
  ) {
    const stripeState = await getStripeConnectSnapshot(user);
    if (hasMeaningfulSupportFactValue(stripeState)) {
      resolvedFacts.stripeState = stripeState;
    }
  }

  if (!resolvedFacts.payoutState && /\b(payout|stripe|bank account|get paid|my money|payment)\b/i.test(normalizedText)) {
    const payoutState = await getPayoutSnapshot(user, effectivePageContext, {
      caseSnapshot: resolvedFacts.caseState,
      stripeSnapshot: resolvedFacts.stripeState,
    });
    if (hasMeaningfulSupportFactValue(payoutState)) {
      resolvedFacts.payoutState = payoutState;
    }
  }

  if (!resolvedFacts.workspaceState && /\b(workspace|blank|access)\b/i.test(normalizedText)) {
    const workspaceState = await getWorkspaceAccessSnapshot(user, effectivePageContext, resolvedFacts.caseState);
    if (hasMeaningfulSupportFactValue(workspaceState)) {
      resolvedFacts.workspaceState = workspaceState;
    }
  }

  if (!resolvedFacts.messagingState && /\b(message|messages|chat|thread|inbox|msg)\b/i.test(normalizedText)) {
    const messagingState = await getMessagingSnapshot(user, effectivePageContext, {
      caseSnapshot: resolvedFacts.caseState,
      workspaceSnapshot: resolvedFacts.workspaceState,
    });
    if (hasMeaningfulSupportFactValue(messagingState)) {
      resolvedFacts.messagingState = messagingState;
    }
  }

  if (
    !resolvedFacts.participantState &&
    resolvedFacts.caseState?.caseId &&
    /\b(attorney|paralegal|respond|response|participant)\b/i.test(normalizedText)
  ) {
    const participantState = await getCaseParticipantSnapshot(resolvedFacts.caseState);
    if (hasMeaningfulSupportFactValue(participantState)) {
      resolvedFacts.participantState = participantState;
    }
  }

  return resolvedFacts;
}

function sanitizeActionLikePayload(action = {}) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return null;
  const type = trimString(action.type, 80).toLowerCase() || "deep_link";
  const label = trimString(action.label || action.text, 120);
  if (!label) return null;
  if (type === "invoke") {
    const invokeAction = trimString(action.action, 120);
    if (!invokeAction) return null;
    return buildInvokeActionPayload({
      label,
      action: invokeAction,
      payload: action.payload && typeof action.payload === "object" && !Array.isArray(action.payload) ? action.payload : {},
    });
  }
  return buildActionPayload({
    label,
    href: trimString(action.href || action.ctaHref, 500),
    type,
  });
}

function buildLlmAssistantPayload({
  reply = "",
  suggestions = [],
  navigation = null,
  provider = "openai",
  turnCount = 1,
  category = "",
  categoryLabel = "",
  confidence = "",
  urgency = "",
  manualReviewSuggested = false,
  needsEscalation = false,
  escalationReason = "",
  routing = null,
  actions = [],
  grounded = true,
  supportFacts = null,
  primaryAsk = "",
  activeTask = "",
  activeEntity = null,
  awaitingField = "",
  responseMode = "",
  sentiment = "",
  frustrationScore = null,
  escalationPriority = "",
  currentIssueLabel = "",
  currentIssueSummary = "",
  compoundIntent = "",
  lastCompoundBranch = "",
  selectionTopics = [],
  lastSelectionTopic = "",
  topicKey = "",
  topicLabel = "",
  topicMode = "",
  turnKind = "",
  recentTopics = [],
  awaitingClarification = false,
  intakeMode = false,
  detailLevel = "",
  paymentSubIntent = "",
} = {}) {
  const brevityAdjustedReply = enforceSupportReplyBrevity(reply, {
    category,
    paymentSubIntent,
    detailLevel,
  });
  const safeReply = trimString(brevityAdjustedReply, MAX_REPLY_LENGTH) || "I'm having trouble right now, please try again.";
  const safeSuggestions = Array.isArray(suggestions)
    ? [...new Set(suggestions.map((value) => trimString(value, 80)).filter(Boolean))].slice(0, 3)
    : [];
  const safeNavigation =
    navigation?.ctaHref && navigation?.ctaLabel
      ? {
          ctaLabel: trimString(navigation.ctaLabel, 120),
          ctaHref: trimString(navigation.ctaHref, 500),
          ctaType: trimString(navigation.ctaType, 80) || "deep_link",
          inlineLinkText: trimString(navigation.inlineLinkText, 40) || "here",
        }
      : null;
  const navigationAdjustedReply = stripRedundantNavigationCopy(safeReply, safeNavigation);
  const resolvedPrimaryAsk = trimString(primaryAsk, 80) || (safeNavigation ? "navigation" : "general_support");
  const resolvedActiveTask =
    trimString(activeTask, 80) || (resolvedPrimaryAsk === "product_guidance" ? "EXPLAIN" : "ANSWER");
  const resolvedAwaitingField = trimString(awaitingField, 120);
  const resolvedCategory =
    trimString(category, 120) ||
    mapPrimaryAskToCategory(resolvedPrimaryAsk, safeNavigation ? "unknown" : "general_support");
  const resolvedCategoryLabel = trimString(categoryLabel, 120) || formatCategoryLabel(resolvedCategory);
  const safeSupportFacts =
    supportFacts && typeof supportFacts === "object" && !Array.isArray(supportFacts) ? supportFacts : {};
  const safeActiveEntity =
    activeEntity && typeof activeEntity === "object" && !Array.isArray(activeEntity)
      ? normalizeSupportEntity(activeEntity)
      : null;
  const resolvedPaymentSubIntent = trimString(paymentSubIntent, 80).toLowerCase();
  const resolvedNeedsEscalation = needsEscalation === true;
  const providedActions = Array.isArray(actions)
    ? actions.map((value) => sanitizeActionLikePayload(value)).filter(Boolean)
    : [];
  const fallbackActions =
    providedActions.length > 0
      ? providedActions
      : buildSelfServiceActions({
          category: resolvedCategory,
          primaryAsk: resolvedPrimaryAsk,
          paymentSubIntent: resolvedPaymentSubIntent,
          navigation: safeNavigation,
          supportFacts: safeSupportFacts,
          needsEscalation: resolvedNeedsEscalation,
        });
  const safeActions = fallbackActions.slice(0, 4);
  const fallbackSuggestions =
    safeSuggestions.length > 0
      ? safeSuggestions
      : buildSuggestedReplies({
          primaryAsk: resolvedPrimaryAsk,
          awaitingField: resolvedAwaitingField,
          paymentSubIntent: resolvedPaymentSubIntent,
          supportFacts: safeSupportFacts,
          selectionTopics,
          navigation: safeNavigation,
        });
  const resolvedResponseMode =
    trimString(responseMode, 80).toUpperCase() ||
    (resolvedNeedsEscalation ? "ESCALATE" : resolvedAwaitingField ? "CLARIFY_ONCE" : "DIRECT_ANSWER");
  const resolvedSentiment = trimString(sentiment, 40).toLowerCase() || "neutral";
  const resolvedFrustrationScore =
    Number.isFinite(Number(frustrationScore)) && frustrationScore !== null ? Number(frustrationScore) : 0;
  const resolvedEscalationPriority =
    trimString(escalationPriority, 40).toLowerCase() ||
    (resolvedNeedsEscalation ? "high" : "normal");
  const safeSelectionTopics = Array.isArray(selectionTopics)
    ? selectionTopics.map((value) => trimString(value, 80).toLowerCase()).filter(Boolean).slice(0, 3)
    : [];
  const safeRecentTopics = Array.isArray(recentTopics)
    ? recentTopics.map((value) => trimString(value, 180)).filter(Boolean).slice(0, 3)
    : [];
  const safeAwaitingClarification = awaitingClarification === true || resolvedResponseMode === "CLARIFY_ONCE";
  const safeIntakeMode = intakeMode === true;
  const resolvedDetailLevel = trimString(detailLevel, 40).toLowerCase() || "concise";
  const resolvedGrounded = grounded !== false;

  return {
    text: navigationAdjustedReply,
    payload: {
      category: resolvedCategory,
      categoryLabel: resolvedCategoryLabel,
      urgency: trimString(urgency, 40).toLowerCase() || "medium",
      confidence: trimString(confidence, 40).toLowerCase() || "high",
      provider,
      manualReviewSuggested: manualReviewSuggested === true,
      needsEscalation: resolvedNeedsEscalation,
      escalationReason: trimString(escalationReason, 160),
      routing: routing && typeof routing === "object" ? routing : null,
      navigation: safeNavigation,
      actions: safeActions,
      suggestedReplies: fallbackSuggestions,
      grounded: resolvedGrounded,
      supportFacts: Object.keys(safeSupportFacts).length ? safeSupportFacts : null,
      primaryAsk: resolvedPrimaryAsk,
      activeTask: resolvedActiveTask,
      paymentSubIntent: resolvedPaymentSubIntent,
      activeEntity: safeActiveEntity,
      awaiting: resolvedAwaitingField || null,
      awaitingField: resolvedAwaitingField,
      responseMode: resolvedResponseMode,
      escalation: {
        available: resolvedNeedsEscalation,
        requested: false,
        ticketId: "",
        ticketReference: "",
        reason: trimString(escalationReason, 160),
        requestedAt: null,
      },
      sentiment: resolvedSentiment,
      frustrationScore: resolvedFrustrationScore,
      escalationPriority: resolvedEscalationPriority,
      currentIssueLabel: trimString(currentIssueLabel, 180),
      currentIssueSummary: trimString(currentIssueSummary, 320),
      compoundIntent: trimString(compoundIntent, 120),
      lastCompoundBranch: trimString(lastCompoundBranch, 120),
      selectionTopics: safeSelectionTopics,
      lastSelectionTopic: trimString(lastSelectionTopic, 80),
      topicKey: trimString(topicKey, 120),
      topicLabel: trimString(topicLabel, 180),
      topicMode: trimString(topicMode, 40),
      turnKind: trimString(turnKind, 60),
      recentTopics: safeRecentTopics,
      lastNavigationLabel: safeNavigation?.ctaLabel || "",
      lastNavigationHref: safeNavigation?.ctaHref || "",
      turnCount,
      awaitingClarification: safeAwaitingClarification,
      intakeMode: safeIntakeMode,
      detailLevel: resolvedDetailLevel,
      aiEnabled: provider === "openai",
    },
    internalSummary: navigationAdjustedReply,
  };
}

async function buildAssistantReply({
  user = {},
  text = "",
  pageContext = {},
  conversationContext = {},
  assistantReplyOverride = null,
} = {}) {
  if (assistantReplyOverride && typeof assistantReplyOverride === "object") {
    assertCcoAutonomyHarnessEnabled();
    return buildLlmAssistantPayload({
      ...assistantReplyOverride,
      provider: assistantReplyOverride.provider || "cco_autonomy_harness",
      turnCount: Number(conversationContext.supportState?.turnCount || 0) + 1,
      grounded: assistantReplyOverride.grounded !== false,
    });
  }

  const supportUser = await loadSupportUser(user);
  if (!supportUser) {
    throw new Error("Support user not found.");
  }
  const llmReply = await generateSupportConversationReply({
    messageText: trimString(text, MAX_MESSAGE_LENGTH),
    userRole: supportUser.role || "",
    conversationId: conversationContext.conversationId || "",
    currentMessageId: conversationContext.currentMessageId || "",
    pageContext,
  });
  if (!llmReply?.reply) {
    return buildSupportFallbackPayload();
  }

  return buildLlmAssistantPayload({
    reply: llmReply.reply,
    suggestions: llmReply.suggestions,
    navigation: llmReply.navigation,
    actions: llmReply.actions,
    provider: llmReply.provider || "openai",
    turnCount: Number(conversationContext.supportState?.turnCount || 0) + 1,
    category: llmReply.category,
    categoryLabel: llmReply.categoryLabel,
    confidence: llmReply.confidence,
    urgency: llmReply.urgency,
    needsEscalation: llmReply.needsEscalation === true,
    escalationReason: llmReply.escalationReason,
    paymentSubIntent: llmReply.paymentSubIntent,
    supportFacts: llmReply.supportFacts,
    primaryAsk: llmReply.primaryAsk,
    activeTask: llmReply.activeTask,
    activeEntity: llmReply.activeEntity,
    awaitingField: llmReply.awaitingField,
    responseMode: llmReply.responseMode,
    sentiment: llmReply.sentiment,
    frustrationScore: llmReply.frustrationScore,
    escalationPriority: llmReply.escalationPriority,
    currentIssueLabel: llmReply.currentIssueLabel,
    currentIssueSummary: llmReply.currentIssueSummary,
    compoundIntent: llmReply.compoundIntent,
    lastCompoundBranch: llmReply.lastCompoundBranch,
    selectionTopics: llmReply.selectionTopics,
    lastSelectionTopic: llmReply.lastSelectionTopic,
    topicKey: llmReply.topicKey,
    topicLabel: llmReply.topicLabel,
    topicMode: llmReply.topicMode,
    turnKind: llmReply.turnKind,
    recentTopics: llmReply.recentTopics,
    awaitingClarification: llmReply.awaitingClarification === true,
    intakeMode: llmReply.intakeMode === true,
    detailLevel: llmReply.detailLevel,
    grounded: llmReply.grounded !== false,
  });
}

async function createOrReuseOpenConversationDocument({ user = {}, update = {} } = {}) {
  let conversation = null;
  try {
    conversation = await SupportConversation.findOneAndUpdate(
      { userId: user._id, status: "open" },
      {
        $setOnInsert: {
          userId: user._id,
          status: "open",
          lastMessageAt: new Date(),
        },
        $set: update,
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    conversation = await SupportConversation.findOne({
      userId: user._id,
      status: "open",
    });
  }
  return conversation;
}

async function getOrCreateOpenConversation({ user = {}, sourcePage = "", pageContext = {} } = {}) {
  await pruneExpiredSupportHistory();
  const supportUser = (await loadSupportUser(user)) || user;
  const context = getConversationContext({ sourcePage, pageContext });
  const update = buildConversationUpdate({
    user: supportUser,
    sourcePage: context.sourcePage,
    pageContext: context.pageContext,
  });

  let conversation = await SupportConversation.findOne({
    userId: user._id,
    status: { $in: ACTIVE_CONVERSATION_STATUSES },
  }).sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 });

  if (conversation && isSupportConversationInactive(conversation)) {
    await closeConversationForLifecycleReset(conversation, "inactive_timeout");
    conversation = null;
  }

  if (conversation) {
    conversation.role = update.role;
    conversation.sourceSurface = update.sourceSurface;
    if (context.sourcePage) conversation.sourcePage = context.sourcePage;
    if (Object.keys(context.pageContext).length) conversation.pageContext = context.pageContext;
    await conversation.save();
  } else {
    conversation = await createOrReuseOpenConversationDocument({ user, update });
  }

  if (!conversation) {
    throw new Error("Unable to create support conversation.");
  }

  await ensureWelcomeMessage(conversation._id);
  const welcomeSupportState = await buildWelcomeSupportState({
    user: supportUser,
    conversation,
    pageContext: context.pageContext,
  });
  conversation.metadata = {
    ...(conversation.metadata || {}),
    support: {
      ...(conversation.metadata?.support || {}),
      welcomePrompt: welcomeSupportState.welcomePrompt || "",
      proactivePrompt: welcomeSupportState.proactivePrompt || null,
      ...(welcomeSupportState.proactivePrompt
        ? {
            lastProactivePromptKey: welcomeSupportState.proactivePrompt.key,
            lastProactivePromptAt: new Date(),
            proactiveIssueLabel: welcomeSupportState.proactivePrompt.issueLabel || "",
            proactiveIssueState: welcomeSupportState.proactivePrompt.issueState || "",
            proactiveTicketId: welcomeSupportState.proactivePrompt.ticketId || "",
            proactiveTicketStatus: welcomeSupportState.proactivePrompt.ticketStatus || "",
            proactiveHandedOffToEngineering: welcomeSupportState.proactivePrompt.handedOffToEngineering === true,
          }
        : {}),
    },
  };
  await conversation.save();
  const hydratedConversation = await SupportConversation.findById(conversation._id).lean();
  return serializeConversation(hydratedConversation || conversation);
}

async function listConversationMessages({ conversationId, userId } = {}) {
  const conversation = await findConversationForUser(conversationId, userId);
  if (!conversation) return null;

  const messages = await SupportMessage.find({ conversationId })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  return {
    conversation: serializeConversation(conversation.toObject ? conversation.toObject() : conversation),
    messages: messages.map(serializeMessage),
  };
}

async function syncEscalatedTicketFromConversation({
  conversationId,
  latestUserMessage = "",
  assistantReply = null,
  user = {},
  sourcePage = "",
  pageContext = {},
} = {}) {
  const ticket = await SupportTicket.findOne({
    conversationId,
    status: { $in: OPEN_TICKET_STATUSES },
  }).sort({ updatedAt: -1, createdAt: -1 });

  if (!ticket || !assistantReply?.payload) return null;

  const currentStatus = String(ticket.status || "").toLowerCase();
  if (currentStatus === "waiting_on_user" || currentStatus === "waiting_on_info") {
    ticket.status = "in_review";
  }
  const resolvedSupportFacts = await resolveEscalationSupportFacts({
    user,
    latestUserMessage,
    pageContext,
    supportFacts: assistantReply.payload.supportFacts || {},
  });
  ticket.latestUserMessage = trimString(latestUserMessage, 12000);
  ticket.assistantSummary = assistantReply.internalSummary || ticket.assistantSummary || "";
  ticket.supportFactsSnapshot = mergeSupportFacts(ticket.supportFactsSnapshot || {}, resolvedSupportFacts);
  ticket.pageContext = Object.keys(pageContext || {}).length ? pageContext : ticket.pageContext || {};
  ticket.routePath = sourcePage || ticket.routePath || "";
  ticket.escalationReason = assistantReply.payload.escalationReason || ticket.escalationReason || "";
  if (assistantReply.payload.urgency) {
    ticket.urgency = assistantReply.payload.urgency;
  }
  await ticket.save();
  return ticket;
}

async function reopenConversationIssue({
  conversation = null,
  user = {},
  userMessage = null,
  assistantMessage = null,
  assistantReply = null,
  context = {},
  update = {},
  promptAction = null,
} = {}) {
  if (!conversation || !assistantReply?.payload) return null;

  const preferredTicketId =
    trimString(promptAction?.ticketId, 120) ||
    trimString(conversation.metadata?.support?.proactiveTicketId, 120) ||
    normalizeId(conversation.escalation?.ticketId);

  const query =
    preferredTicketId && mongoose.isValidObjectId(preferredTicketId)
      ? {
          _id: preferredTicketId,
          userId: user._id || conversation.userId || null,
        }
      : {
          conversationId: conversation._id,
          userId: user._id || conversation.userId || null,
          status: { $in: RESOLVED_TICKET_STATUSES },
        };

  let ticketDoc = await SupportTicket.findOne(query).sort({ resolvedAt: -1, updatedAt: -1, createdAt: -1 });
  if (!ticketDoc) return null;
  const ticketBeforeReopen = ticketDoc.toObject ? ticketDoc.toObject() : ticketDoc;

  await updateTicketStatus({
    ticketId: ticketDoc._id,
    status: (ticketDoc.linkedIncidentIds || []).length ? "in_review" : "open",
    resolutionSummary: "Issue reopened from support chat after the user reported it is still happening.",
    resolutionIsStable: false,
  });

  ticketDoc = await SupportTicket.findById(ticketDoc._id);
  if (!ticketDoc) return null;

  ticketDoc.latestUserMessage = trimString(userMessage?.text || "", 12000);
  ticketDoc.assistantSummary = assistantReply.internalSummary || ticketDoc.assistantSummary || "";
  ticketDoc.supportFactsSnapshot = mergeSupportFacts(
    ticketDoc.supportFactsSnapshot || {},
    await resolveEscalationSupportFacts({
      user,
      latestUserMessage: userMessage?.text || "",
      pageContext: context.pageContext || {},
      supportFacts: assistantReply.payload.supportFacts || {},
    })
  );
  ticketDoc.pageContext = Object.keys(context.pageContext || {}).length ? context.pageContext : ticketDoc.pageContext || {};
  ticketDoc.routePath = context.sourcePage || ticketDoc.routePath || "";
  ticketDoc.escalationReason = assistantReply.payload.escalationReason || ticketDoc.escalationReason || "support_issue_reopened";
  if (assistantReply.payload.urgency) {
    ticketDoc.urgency = assistantReply.payload.urgency;
  }
  await ticketDoc.save();
  await maybeLogAutonomousTicketReopen({
    ticketBefore: ticketBeforeReopen,
    ticketAfter: ticketDoc.toObject ? ticketDoc.toObject() : ticketDoc,
    userMessageText: userMessage?.text || "",
    assistantReply,
    promptAction,
    conversation,
  });

  const submission = await buildConversationEscalationPayload({
    conversation,
    user,
    userMessage,
    assistantMessage,
    context,
  });
  const shouldEscalate = shouldEscalateTicketToIncident(ticketDoc.toObject(), submission);
  let diagnosisKickoff = null;
  let linkedIncident = null;
  const ticketBeforeIncidentRouting = ticketDoc.toObject ? ticketDoc.toObject() : ticketDoc;

  if (shouldEscalate.shouldEscalate) {
    const linked = await findMatchingActiveIncident({
      ticket: ticketDoc.toObject(),
      submission,
    });
    const existingIncidentIds = new Set((ticketDoc.linkedIncidentIds || []).map((value) => normalizeId(value)).filter(Boolean));

    if (linked.incident?._id) {
      if (!existingIncidentIds.has(String(linked.incident._id))) {
        await linkTicketToIncident({
          ticketId: ticketDoc._id,
          incidentId: linked.incident._id,
        });
      }
      diagnosisKickoff = await startEngineeringDiagnosisForIncident(linked.incident);
      linkedIncident = linked.incident;
      await notifyFounderSupportEngineeringIssue({
        incident: linked.incident,
        ticket: {
          id: normalizeId(ticketDoc._id),
          reference: formatSupportTicketReference(ticketDoc._id),
        },
        diagnosisKickoff,
        linkedToExisting: true,
      });
    } else {
      linkedIncident = await createIncidentFromSupportSignal({
        submission: {
          ...submission,
          summary: submission.subject || submission.message,
          description: submission.message,
        },
      });
      await linkTicketToIncident({
        ticketId: ticketDoc._id,
        incidentId: linkedIncident._id,
      });
      diagnosisKickoff = await startEngineeringDiagnosisForIncident(linkedIncident);
      await notifyFounderSupportEngineeringIssue({
        incident: linkedIncident,
        ticket: {
          id: normalizeId(ticketDoc._id),
          reference: formatSupportTicketReference(ticketDoc._id),
        },
        diagnosisKickoff,
        linkedToExisting: false,
      });
    }

    ticketDoc = await SupportTicket.findById(ticketDoc._id);
    if (!ticketDoc) return null;
    await maybeLogAutonomousIncidentRouting({
      ticketBefore: ticketBeforeIncidentRouting,
      ticketAfter: ticketDoc.toObject ? ticketDoc.toObject() : ticketDoc,
      submission,
      routingDecision: shouldEscalate,
      incident: linkedIncident,
    });
  }

  conversation.role = update.role || conversation.role;
  conversation.sourceSurface = update.sourceSurface || conversation.sourceSurface;
  if (context.sourcePage) conversation.sourcePage = context.sourcePage;
  if (Object.keys(context.pageContext || {}).length) conversation.pageContext = context.pageContext;
  conversation.status = (ticketDoc.linkedIncidentIds || []).length ? "escalated" : "open";
  conversation.lastMessageAt = assistantMessage?.createdAt || new Date();
  conversation.escalation = {
    ...(conversation.escalation || {}),
    requested: (ticketDoc.linkedIncidentIds || []).length > 0 || conversation.escalation?.requested === true,
    requestedAt: conversation.escalation?.requestedAt || assistantMessage?.createdAt || new Date(),
    ticketId: ticketDoc._id,
    note:
      (ticketDoc.linkedIncidentIds || []).length > 0
        ? "Issue reopened from support chat and returned to engineering."
        : "Issue reopened from support chat.",
    engineeringReviewStarted:
      (ticketDoc.linkedIncidentIds || []).length > 0 ||
      diagnosisKickoff?.ok === true ||
      diagnosisKickoff?.executionStarted === true ||
      conversation.escalation?.engineeringReviewStarted === true,
    engineeringReviewStartedAt:
      (ticketDoc.linkedIncidentIds || []).length > 0 || diagnosisKickoff?.ok === true
        ? assistantMessage?.createdAt || new Date()
        : conversation.escalation?.engineeringReviewStartedAt || null,
    diagnosisRunId: diagnosisKickoff?.runId || conversation.escalation?.diagnosisRunId || "",
    engineeringExecutionStarted:
      (ticketDoc.linkedIncidentIds || []).length > 0 ||
      diagnosisKickoff?.executionStarted === true ||
      conversation.escalation?.engineeringExecutionStarted === true,
    engineeringExecutionStartedAt:
      (ticketDoc.linkedIncidentIds || []).length > 0 || diagnosisKickoff?.executionStarted === true
        ? assistantMessage?.createdAt || new Date()
        : conversation.escalation?.engineeringExecutionStartedAt || null,
    executionRunId: diagnosisKickoff?.executionRunId || conversation.escalation?.executionRunId || "",
    executionStatus: diagnosisKickoff?.executionStatus || conversation.escalation?.executionStatus || "",
  };
  conversation.metadata = {
    ...(conversation.metadata || {}),
    support: {
      ...(conversation.metadata?.support || {}),
      escalationOffered: true,
      escalationSent:
        (ticketDoc.linkedIncidentIds || []).length > 0 || conversation.metadata?.support?.escalationSent === true,
      proactiveIssueState: "open",
      proactiveTicketId: normalizeId(ticketDoc._id),
      proactiveTicketStatus: trimString(ticketDoc.status, 80),
      proactiveHandedOffToEngineering: (ticketDoc.linkedIncidentIds || []).length > 0,
      engineeringReviewStarted:
        (ticketDoc.linkedIncidentIds || []).length > 0 ||
        diagnosisKickoff?.ok === true ||
        diagnosisKickoff?.executionStarted === true ||
        conversation.metadata?.support?.engineeringReviewStarted === true,
      engineeringReviewStartedAt:
        (ticketDoc.linkedIncidentIds || []).length > 0 || diagnosisKickoff?.ok === true
          ? assistantMessage?.createdAt || new Date()
          : conversation.metadata?.support?.engineeringReviewStartedAt || null,
      diagnosisRunId: diagnosisKickoff?.runId || conversation.metadata?.support?.diagnosisRunId || "",
      engineeringExecutionStarted:
        (ticketDoc.linkedIncidentIds || []).length > 0 ||
        diagnosisKickoff?.executionStarted === true ||
        conversation.metadata?.support?.engineeringExecutionStarted === true,
      engineeringExecutionStartedAt:
        (ticketDoc.linkedIncidentIds || []).length > 0 || diagnosisKickoff?.executionStarted === true
          ? assistantMessage?.createdAt || new Date()
          : conversation.metadata?.support?.engineeringExecutionStartedAt || null,
      executionRunId: diagnosisKickoff?.executionRunId || conversation.metadata?.support?.executionRunId || "",
      executionStatus: diagnosisKickoff?.executionStatus || conversation.metadata?.support?.executionStatus || "",
    },
  };
  await conversation.save();
  publishConversationEvent(conversation._id, {
    type: "conversation.updated",
    reason: "conversation.issue_reopened",
  });

  const updatedAssistantMessage =
    (ticketDoc.linkedIncidentIds || []).length > 0
      ? await updateAssistantEscalationMetadata({
          assistantMessage,
          ticketId: ticketDoc._id,
          ticketReference: formatSupportTicketReference(ticketDoc._id),
          requestedAt: assistantMessage?.createdAt || new Date(),
        })
      : assistantMessage;

  return {
    conversation,
    ticketDoc,
    diagnosisKickoff,
    incident: linkedIncident,
    assistantMessage: updatedAssistantMessage,
  };
}

async function createConversationMessage({
  conversationId,
  user = {},
  text = "",
  sourcePage = "",
  pageContext = {},
  promptAction = null,
  assistantReplyOverride = null,
} = {}) {
  const normalizedText = trimString(text, MAX_MESSAGE_LENGTH);
  if (!normalizedText) {
    throw new Error("Support message text is required.");
  }

  const conversation = await findConversationForUser(conversationId, user._id);
  if (!conversation) return null;

  const context = getConversationContext({ sourcePage, pageContext });
  const update = buildConversationUpdate({
    user,
    sourcePage: context.sourcePage,
    pageContext: context.pageContext,
  });
  const supportState = getConversationPolicyState(conversation);
  const normalizedPromptAction = sanitizePromptAction(promptAction);
  const effectiveSupportState = normalizedPromptAction
    ? {
        ...supportState,
        proactiveIssueLabel: normalizedPromptAction.issueLabel || supportState.proactiveIssueLabel,
        proactiveIssueState: normalizedPromptAction.issueState || supportState.proactiveIssueState,
        proactiveTicketId: normalizedPromptAction.ticketId || supportState.proactiveTicketId,
        proactiveTicketStatus: normalizedPromptAction.ticketStatus || supportState.proactiveTicketStatus,
        proactiveHandedOffToEngineering:
          normalizedPromptAction.handedOffToEngineering === true || supportState.proactiveHandedOffToEngineering === true,
      }
    : supportState;
  const lastAssistantMessage = await getLatestAssistantMessageForConversation(conversation._id);
  const frustration = detectFrustrationSignals(normalizedText);

  const userMessage = await SupportMessage.create({
    conversationId: conversation._id,
    sender: "user",
    text: normalizedText,
    sourcePage: context.sourcePage,
    pageContext: context.pageContext,
    metadata: {
      kind: "user_message",
      promptAction: normalizedPromptAction,
    },
  });

  const assistantReply = isAdminDashboardSupportScope({
    user,
    pageContext: context.pageContext,
    sourcePage: context.sourcePage,
  })
    ? buildAdminDashboardSupportReply({
        text: normalizedText,
      })
    : await buildAssistantReply({
        user,
        text: normalizedText,
        pageContext: context.pageContext,
        assistantReplyOverride,
        conversationContext: {
          supportState: effectiveSupportState,
          conversationId: normalizeId(conversation._id),
          currentMessageId: normalizeId(userMessage._id),
          ticketId: normalizeId(conversation.escalation?.ticketId),
          lastAssistantMessage,
          awaitingMessagingClarification:
            conversation.metadata?.support?.awaitingMessagingClarification === true,
          awaitingIntakeDetails: conversation.metadata?.support?.awaitingIntakeDetails === true,
          frustration,
          promptAction: normalizedPromptAction,
        },
      });

  const assistantMessage = await SupportMessage.create({
    conversationId: conversation._id,
    sender: "assistant",
    text: assistantReply.text,
    sourcePage: context.sourcePage,
    pageContext: context.pageContext,
    metadata: {
      kind: "assistant_reply",
      category: assistantReply.payload.category,
      categoryLabel: assistantReply.payload.categoryLabel,
      urgency: assistantReply.payload.urgency,
      confidence: assistantReply.payload.confidence,
      provider: assistantReply.payload.provider,
      manualReviewSuggested: assistantReply.payload.manualReviewSuggested,
      needsEscalation: assistantReply.payload.needsEscalation,
      escalationReason: assistantReply.payload.escalationReason,
      routing: assistantReply.payload.routing,
      navigation: assistantReply.payload.navigation,
      actions: assistantReply.payload.actions || [],
      suggestedReplies: assistantReply.payload.suggestedReplies || [],
      internalSummary: assistantReply.internalSummary,
      grounded: assistantReply.payload.grounded,
      supportFacts: assistantReply.payload.supportFacts,
      primaryAsk: assistantReply.payload.primaryAsk || "",
      activeEntity: assistantReply.payload.activeEntity || null,
      awaitingField: assistantReply.payload.awaitingField || "",
      responseMode: assistantReply.payload.responseMode || "",
      escalation: assistantReply.payload.escalation,
    },
  });

  conversation.role = update.role;
  conversation.sourceSurface = update.sourceSurface;
  if (context.sourcePage) conversation.sourcePage = context.sourcePage;
  if (Object.keys(context.pageContext).length) conversation.pageContext = context.pageContext;
  conversation.lastCategory = assistantReply.payload.category;
  conversation.lastMessageAt = assistantMessage.createdAt || new Date();
  if (assistantReply.payload.primaryAsk === "issue_resolved") {
    conversation.status = "resolved";
  } else if (["resolved", "closed"].includes(String(conversation.status || "").toLowerCase())) {
    conversation.status = conversation.escalation?.requested ? "escalated" : "open";
  }
  conversation.metadata = {
    ...(conversation.metadata || {}),
    support: {
      ...(conversation.metadata?.support || {}),
      activeTask: assistantReply.payload.activeTask || "",
      activeAsk: assistantReply.payload.primaryAsk || "",
      activeIntent: assistantReply.payload.category || "",
      intentConfidence: assistantReply.payload.confidence || "",
      activeEntity: assistantReply.payload.activeEntity || null,
      awaiting: assistantReply.payload.awaiting || null,
      awaitingField: assistantReply.payload.awaitingField || "",
      lastResponseType: assistantReply.payload.responseType || assistantReply.payload.responseMode || "",
      lastResponseMode: assistantReply.payload.responseMode || "",
      lastAssistantReply: assistantReply.text || "",
      escalationShown:
        supportState.escalationShown === true || assistantReply.payload.escalation?.available === true,
      escalationOffered:
        supportState.escalationOffered === true || assistantReply.payload.escalation?.available === true,
      escalationSent: supportState.escalationSent === true,
      sentiment: assistantReply.payload.sentiment || frustration.sentiment,
      frustrationScore: assistantReply.payload.frustrationScore ?? frustration.frustrationScore,
      escalationPriority: assistantReply.payload.escalationPriority || frustration.escalationPriority,
      currentIssueLabel: assistantReply.payload.currentIssueLabel || "",
      currentIssueSummary: assistantReply.payload.currentIssueSummary || "",
      compoundIntent: assistantReply.payload.compoundIntent || "",
      lastCompoundBranch: assistantReply.payload.lastCompoundBranch || "",
      selectionTopics: Array.isArray(assistantReply.payload.selectionTopics)
        ? assistantReply.payload.selectionTopics
        : [],
      lastSelectionTopic: assistantReply.payload.lastSelectionTopic || "",
      topicKey: assistantReply.payload.topicKey || "",
      topicLabel: assistantReply.payload.topicLabel || "",
      topicMode: assistantReply.payload.topicMode || "",
      turnKind: assistantReply.payload.turnKind || "",
      recentTopics: Array.isArray(assistantReply.payload.recentTopics)
        ? assistantReply.payload.recentTopics
        : supportState.recentTopics || [],
      lastNavigationLabel: assistantReply.payload.lastNavigationLabel || supportState.lastNavigationLabel || "",
      lastNavigationHref: assistantReply.payload.lastNavigationHref || supportState.lastNavigationHref || "",
      turnCount: assistantReply.payload.turnCount || Number(supportState.turnCount || 0) + 1,
      awaitingMessagingClarification: assistantReply.payload.awaitingClarification === true,
      lastMessagingClarificationAt: assistantReply.payload.awaitingClarification === true ? new Date() : null,
      awaitingIntakeDetails:
        assistantReply.payload.intakeMode === true && assistantReply.payload.needsEscalation !== true,
      lastIntakePromptAt:
        assistantReply.payload.intakeMode === true && assistantReply.payload.needsEscalation !== true
          ? new Date()
          : null,
      proactiveIssueState:
        assistantReply.payload.primaryAsk === "issue_reopen" ? "open" : supportState.proactiveIssueState || "",
      proactiveTicketStatus:
        assistantReply.payload.primaryAsk === "issue_reopen"
          ? "in_review"
          : supportState.proactiveTicketStatus || "",
      welcomePrompt: "",
      proactivePrompt: null,
    },
  };
  await conversation.save();
  const existingTicket = await SupportTicket.findOne({
    conversationId: conversation._id,
    status: { $in: OPEN_TICKET_STATUSES },
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  let syncedTicket = null;
  let updatedConversation = conversation;
  let updatedAssistantMessage = assistantMessage;
  let systemMessage = null;

  if (assistantReply.payload.primaryAsk === "issue_reopen") {
    const reopenResult = await reopenConversationIssue({
      conversation,
      user,
      userMessage,
      assistantMessage,
      assistantReply,
      context,
      update,
      promptAction: normalizedPromptAction,
    });
    syncedTicket = reopenResult?.ticketDoc || null;
    updatedConversation = reopenResult?.conversation || conversation;
    updatedAssistantMessage = reopenResult?.assistantMessage || assistantMessage;
  } else if (
    assistantReply.payload.needsEscalation === true &&
    String(assistantReply.payload.primaryAsk || "").trim().toLowerCase() === "request_human_help"
  ) {
    try {
      const escalationResult = await ensureConversationEscalated({
        conversation,
        user,
        userMessage,
        assistantMessage,
        context,
        update,
        existingTicket,
        eventSuffix: normalizeId(assistantMessage._id),
        allowAutonomousLogging: true,
      });
      updatedConversation = escalationResult.conversation || conversation;
      updatedAssistantMessage = escalationResult.assistantMessage || assistantMessage;
      systemMessage = escalationResult.systemMessage || null;
      syncedTicket = escalationResult.ticketDoc || null;
    } catch (error) {
      console.error("Auto-escalation failed for support conversation", error);
      syncedTicket = await syncEscalatedTicketFromConversation({
        conversationId: conversation._id,
        latestUserMessage: normalizedText,
        assistantReply,
        user,
        sourcePage: context.sourcePage,
        pageContext: context.pageContext,
      });
    }
  } else {
    syncedTicket = await syncEscalatedTicketFromConversation({
      conversationId: conversation._id,
      latestUserMessage: normalizedText,
      assistantReply,
      user,
      sourcePage: context.sourcePage,
      pageContext: context.pageContext,
    });
  }

  if (assistantReply.payload.primaryAsk === "issue_resolved" && syncedTicket?._id) {
    const ticketDoc = await SupportTicket.findById(syncedTicket._id);
    if (ticketDoc) {
      ticketDoc.status = "resolved";
      ticketDoc.resolvedAt = new Date();
      ticketDoc.resolutionSummary = "User indicated the issue was resolved in support chat.";
      ticketDoc.resolutionIsStable = false;
      await ticketDoc.save();
    }
  }
  publishConversationEvent(conversation._id, {
    type: "conversation.updated",
    reason: "message.created",
  });

  return {
    conversation: serializeConversation(
      updatedConversation?.toObject ? updatedConversation.toObject() : updatedConversation
    ),
    userMessage: serializeMessage(userMessage.toObject ? userMessage.toObject() : userMessage),
    assistantMessage: serializeMessage(
      updatedAssistantMessage?.toObject ? updatedAssistantMessage.toObject() : updatedAssistantMessage
    ),
    systemMessage: systemMessage
      ? serializeMessage(systemMessage.toObject ? systemMessage.toObject() : systemMessage)
      : null,
    assistantReply: assistantReply.payload,
  };
}

function buildEscalationMessageText(ticketReference = "", handoffSummary = "") {
  const base = ticketReference
    ? `Sent to the team for review. Reference: ${ticketReference}.`
    : "Sent to the team for review.";
  if (!handoffSummary) {
    return `${base} I've shared a summary so you won't need to repeat yourself.`;
  }
  return `${base} I've shared a summary with the team so you won't need to repeat yourself.`;
}

async function notifySupportEscalationOnce({
  userId = null,
  userRole = "",
  sourcePage = "",
  caseTitle = "",
  ticketId = "",
  ticketReference = "",
} = {}) {
  return null;
}

function buildTicketSubject(categoryLabel = "", latestUserMessage = "") {
  const normalizedCategoryLabel = normalizeForComparison(categoryLabel);
  let category = "";
  if (normalizedCategoryLabel === "case workflow") category = "case_posting";
  if (normalizedCategoryLabel === "payments") category = "payment";
  if (normalizedCategoryLabel === "messaging") category = "messaging";
  if (normalizedCategoryLabel === "profile updates") category = "profile_save";
  if (normalizedCategoryLabel === "payout setup") category = "stripe_onboarding";

  const cleaned = cleanSupportIssueLabelText(latestUserMessage || "", category);
  if (cleaned) {
    if (category === "case_posting") return "Case issue";
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  if (category === "case_posting") return "Case issue";
  if (category === "profile_save") return "Save Preferences issue";
  if (category === "messaging") return "Messaging issue";
  if (category === "payment") return "Payment issue";
  return trimString(categoryLabel || "Support request", 140);
}

async function buildConversationEscalationPayload({
  conversation = {},
  user = {},
  userMessage = null,
  assistantMessage = null,
  context = {},
} = {}) {
  const resolvedSupportFacts = await resolveEscalationSupportFacts({
    user,
    latestUserMessage: userMessage?.text || "",
    pageContext: context.pageContext || {},
    supportFacts: assistantMessage?.metadata?.supportFacts || {},
  });

  return {
    requesterRole: user.role || conversation.role || "unknown",
    requesterUserId: user._id || conversation.userId || null,
    requesterEmail: user.email || "",
    requesterName: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "",
    sourceSurface: resolveSurface(user.role || conversation.role),
    sourceLabel: "In-product support",
    conversationId: conversation._id || null,
    routePath: context.sourcePage || "",
    pageUrl: context.pageContext?.href || "",
    featureKey: context.pageContext?.viewName || context.pageContext?.label || "",
    caseId: mongoose.isValidObjectId(context.pageContext?.caseId || "") ? context.pageContext.caseId : null,
    jobId: mongoose.isValidObjectId(context.pageContext?.jobId || "") ? context.pageContext.jobId : null,
    applicationId: mongoose.isValidObjectId(context.pageContext?.applicationId || "")
      ? context.pageContext.applicationId
      : null,
    subject: buildTicketSubject(
      assistantMessage?.metadata?.categoryLabel || formatCategoryLabel(assistantMessage?.metadata?.category),
      userMessage?.text || ""
    ),
    message: buildTicketMessage({
      latestUserMessage: userMessage?.text || "",
      assistantSummary: assistantMessage?.metadata?.internalSummary || assistantMessage?.text || "",
      pageContext: context.pageContext,
      supportFacts: resolvedSupportFacts,
    }),
    latestUserMessage: userMessage?.text || "",
    assistantSummary: assistantMessage?.metadata?.internalSummary || assistantMessage?.text || "",
    supportFactsSnapshot: resolvedSupportFacts,
    escalationReason: assistantMessage?.metadata?.escalationReason || "",
    supportCategory: assistantMessage?.metadata?.category || "",
    ticketConfidence: assistantMessage?.metadata?.confidence || "medium",
    contextSnapshot: {
      sourcePage: context.sourcePage || "",
      latestSupportCategory: assistantMessage?.metadata?.category || "",
      supportConfidence: assistantMessage?.metadata?.confidence || "medium",
      supportEscalationReason: assistantMessage?.metadata?.escalationReason || "",
    },
  };
}

function buildConversationSupportRoutingEvent({
  conversation = {},
  user = {},
  assistantMessage = null,
  submission = {},
  context = {},
} = {}) {
  const userId = normalizeId(user._id || conversation.userId);
  const ticketEntityId =
    `support-conversation:${normalizeId(conversation._id)}:${normalizeId(assistantMessage?._id)}` || `support-conversation:${Date.now()}`;

  return {
    actor: {
      actorType: "user",
      userId: userId || null,
      role: submission.requesterRole || user.role || conversation.role || "",
      email: submission.requesterEmail || user.email || "",
      label: submission.requesterName || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "Support User",
    },
    subject: {
      entityType: "support_submission",
      entityId: ticketEntityId,
    },
    related: {
      userId: userId || null,
      conversationId: normalizeId(conversation._id) || null,
      caseId: submission.caseId || null,
      jobId: submission.jobId || null,
      applicationId: submission.applicationId || null,
    },
    source: {
      surface: submission.sourceSurface || resolveSurface(user.role || conversation.role),
      route: context.sourcePage || "",
      service: "support",
      producer: "service",
    },
    facts: {
      summary: submission.latestUserMessage || submission.message || submission.subject || "In-product support escalation",
      after: {
        role: submission.requesterRole || user.role || conversation.role || "",
        email: submission.requesterEmail || user.email || "",
        name: submission.requesterName || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "",
        subject: submission.subject || "Support request",
        message: submission.message || "",
        sourceLabel: submission.sourceLabel || "In-product support",
        routePath: submission.routePath || "",
        pageUrl: submission.pageUrl || "",
        featureKey: submission.featureKey || "",
      },
    },
  };
}

async function publishSupportTicketEscalatedEvent({
  ticket = {},
  user = {},
  userMessage = null,
  assistantMessage = null,
  context = {},
  handoffSummary = "",
  suffix = "",
} = {}) {
  const ticketId = normalizeId(ticket._id || ticket.id);
  if (!ticketId) return;

  const ticketReference = formatSupportTicketReference(ticketId);
  await publishEventSafe({
    eventType: "support.ticket.escalated",
    eventFamily: "support",
    idempotencyKey: `support-ticket:${ticketId}:escalated${suffix ? `:${suffix}` : ""}`,
    correlationId: `support-ticket:${ticketId}`,
    actor: {
      actorType: "user",
      userId: user._id || null,
      role: user.role || "",
      email: user.email || "",
      label: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "Support User",
    },
    subject: {
      entityType: "support_ticket",
      entityId: ticketId,
      publicId: ticketReference,
    },
    related: {
      userId: user._id || null,
      caseId: mongoose.isValidObjectId(context.pageContext?.caseId || "") ? context.pageContext.caseId : null,
      jobId: mongoose.isValidObjectId(context.pageContext?.jobId || "") ? context.pageContext.jobId : null,
      applicationId: mongoose.isValidObjectId(context.pageContext?.applicationId || "")
        ? context.pageContext.applicationId
        : null,
      supportTicketId: ticketId,
    },
    source: {
      surface: resolveSurface(user.role),
      route: context.sourcePage || "",
      service: "support",
      producer: "service",
    },
    facts: {
      summary: handoffSummary,
      after: {
        ticketReference,
        status: ticket.status || "open",
        routingOwner: ticket.routingSuggestion?.ownerKey || "founder_review",
        category: assistantMessage?.metadata?.category || "",
        patternKey: ticket.classification?.patternKey || "",
        escalationReason: assistantMessage?.metadata?.escalationReason || "",
        latestUserMessage: userMessage?.text || "",
        requesterRole: user.role || "",
        requesterName: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "Support User",
        sourceSurface: resolveSurface(user.role),
        sourcePage: context.sourcePage || "",
        viewName: context.pageContext?.viewName || "",
        caseTitle:
          assistantMessage?.metadata?.supportFacts?.caseState?.title ||
          ticket.supportFactsSnapshot?.caseState?.title ||
          "",
        primaryAsk: assistantMessage?.metadata?.primaryAsk || "",
      },
    },
    signals: {
      confidence: assistantMessage?.metadata?.confidence || "medium",
      priority: "high",
      moneyRisk: assistantMessage?.metadata?.category === "payment",
      authRisk: ["login", "password_reset"].includes(String(assistantMessage?.metadata?.category || "")),
      caseProgressRisk: ["messaging", "case_posting"].includes(String(assistantMessage?.metadata?.category || "")),
      publicFacing: true,
      founderVisible: true,
    },
  });
}

async function ensureConversationEscalated({
  conversation,
  user = {},
  userMessage = null,
  assistantMessage = null,
  context = {},
  update = {},
  existingTicket = null,
  existingHandoffSummary = "",
  eventSuffix = "",
  allowAutonomousLogging = false,
} = {}) {
  if (!conversation || !assistantMessage) {
    throw new Error("Conversation escalation requires a conversation and assistant message.");
  }

  const requestedAt = new Date();
  const handoffSummary =
    existingHandoffSummary ||
    buildHandoffSummary({
      latestUserMessage: userMessage?.text || "",
      assistantReply: assistantMessage.metadata?.internalSummary || assistantMessage.text || "",
      categoryLabel: assistantMessage.metadata?.categoryLabel || formatCategoryLabel(assistantMessage.metadata?.category),
    });
  const submission = await buildConversationEscalationPayload({
    conversation,
    user,
    userMessage,
    assistantMessage,
    context,
  });

  let ticketDoc = existingTicket ? await SupportTicket.findById(existingTicket._id || existingTicket.id) : null;
  const ticketBeforeEscalation = ticketDoc?.toObject ? ticketDoc.toObject() : ticketDoc || null;
  let systemMessage = null;
  let diagnosisKickoff = null;

  if (!ticketDoc) {
    const routingResult = await routeSupportSubmissionEvent(
      buildConversationSupportRoutingEvent({
        conversation,
        user,
        assistantMessage,
        submission,
        context,
      })
    );
    const ticketId = normalizeId(routingResult?.ticket?._id || routingResult?.ticket?.id);
    if (ticketId) {
      ticketDoc = await SupportTicket.findById(ticketId);
    }
    diagnosisKickoff = routingResult?.diagnosisKickoff || null;
  } else {
    const currentStatus = String(ticketDoc.status || "").toLowerCase();
    if (currentStatus === "waiting_on_user" || currentStatus === "waiting_on_info") {
      ticketDoc.status = "in_review";
    }
    ticketDoc.latestUserMessage = submission.latestUserMessage || ticketDoc.latestUserMessage || "";
    ticketDoc.assistantSummary = submission.assistantSummary || ticketDoc.assistantSummary || "";
    ticketDoc.supportFactsSnapshot = submission.supportFactsSnapshot || ticketDoc.supportFactsSnapshot || {};
    ticketDoc.pageContext = context.pageContext || ticketDoc.pageContext || {};
    ticketDoc.routePath = context.sourcePage || ticketDoc.routePath || "";
    ticketDoc.escalationReason = submission.escalationReason || ticketDoc.escalationReason || "";
    ticketDoc.routingSuggestion = {
      ...(ticketDoc.routingSuggestion || {}),
      ownerKey: "founder_review",
      priority: "high",
      queueLabel: "War Room review",
      reason: "In-product support escalations should be reviewed from the War Room.",
    };

    const shouldEscalate = shouldEscalateTicketToIncident(ticketDoc.toObject(), submission);
    await ticketDoc.save();
    const ticketBeforeIncidentRouting = ticketDoc.toObject ? ticketDoc.toObject() : ticketDoc;
    const linkedIds = new Set((ticketDoc.linkedIncidentIds || []).map((value) => normalizeId(value)).filter(Boolean));
    if (shouldEscalate.shouldEscalate && !linkedIds.size) {
      let linkedIncident = null;
      const linked = await findMatchingActiveIncident({
        ticket: ticketDoc.toObject(),
        submission,
      });
      if (linked.incident?._id) {
        await linkTicketToIncident({
          ticketId: ticketDoc._id,
          incidentId: linked.incident._id,
        });
        linkedIncident = linked.incident;
        diagnosisKickoff = await startEngineeringDiagnosisForIncident(linked.incident);
      } else {
        linkedIncident = await createIncidentFromSupportSignal({
          submission: {
            ...submission,
            summary: submission.subject || submission.message,
            description: submission.message,
          },
        });
        await linkTicketToIncident({
          ticketId: ticketDoc._id,
          incidentId: linkedIncident._id,
        });
        diagnosisKickoff = await startEngineeringDiagnosisForIncident(linkedIncident);
      }
      ticketDoc = await SupportTicket.findById(ticketDoc._id);
      await maybeLogAutonomousIncidentRouting({
        ticketBefore: ticketBeforeIncidentRouting,
        ticketAfter: ticketDoc?.toObject ? ticketDoc.toObject() : ticketDoc,
        submission,
        routingDecision: shouldEscalate,
        incident: linkedIncident,
      });
    } else if ((ticketDoc.linkedIncidentIds || []).length) {
      diagnosisKickoff = await startEngineeringDiagnosisForIncident({
        _id: normalizeId(ticketDoc.linkedIncidentIds[0]),
      });
    }
  }

  if (!ticketDoc) {
    throw new Error("Unable to create or update the support escalation ticket.");
  }

  ticketDoc.latestUserMessage = submission.latestUserMessage || ticketDoc.latestUserMessage || "";
  ticketDoc.assistantSummary = submission.assistantSummary || ticketDoc.assistantSummary || "";
  ticketDoc.supportFactsSnapshot = submission.supportFactsSnapshot || ticketDoc.supportFactsSnapshot || {};
  ticketDoc.pageContext = context.pageContext || ticketDoc.pageContext || {};
  ticketDoc.routePath = context.sourcePage || ticketDoc.routePath || "";
  ticketDoc.escalationReason = submission.escalationReason || ticketDoc.escalationReason || "";
  ticketDoc.routingSuggestion = {
    ...(ticketDoc.routingSuggestion || {}),
    ownerKey: "founder_review",
    priority: "high",
    queueLabel: "War Room review",
    reason: "In-product support escalations should be reviewed from the War Room.",
  };
  await ticketDoc.save();
  if (allowAutonomousLogging) {
    await maybeLogAutonomousTicketEscalation({
      ticketBefore: ticketBeforeEscalation,
      ticketAfter: ticketDoc.toObject ? ticketDoc.toObject() : ticketDoc,
      userMessageText: userMessage?.text || "",
      assistantReply: {
        payload: {
          primaryAsk: "request_human_help",
          needsEscalation: true,
        },
      },
      conversation,
      existingTicket: ticketBeforeEscalation,
    });
  }

  const ticketId = normalizeId(ticketDoc._id);
  const ticketReference = formatSupportTicketReference(ticketId);
  const caseTitle =
    assistantMessage?.metadata?.supportFacts?.caseState?.title ||
    ticketDoc.supportFactsSnapshot?.caseState?.title ||
    ticketDoc.supportFactsSnapshot?.payoutState?.relevantCaseTitle ||
    "";

  if (conversation.escalation?.requested !== true) {
    systemMessage = await SupportMessage.create({
      conversationId: conversation._id,
      sender: "system",
      text: buildEscalationMessageText(ticketReference, handoffSummary),
      sourcePage: context.sourcePage,
      pageContext: context.pageContext,
      metadata: {
        kind: "support_escalation",
        ticketId,
        ticketReference,
        handoffSummary,
      },
    });

    await notifySupportEscalationOnce({
      userId: user._id,
      userRole: user.role || "",
      sourcePage: context.sourcePage || "",
      caseTitle,
      ticketId,
      ticketReference,
    });
  }

  const updatedAssistantMessage = await updateAssistantEscalationMetadata({
    assistantMessage,
    ticketId,
    ticketReference,
    requestedAt,
  });

  conversation.role = update.role;
  conversation.sourceSurface = update.sourceSurface;
  if (context.sourcePage) conversation.sourcePage = context.sourcePage;
  if (Object.keys(context.pageContext).length) conversation.pageContext = context.pageContext;
  conversation.escalation = {
    requested: true,
    requestedAt,
    ticketId: ticketId || null,
    note: buildEscalationMessageText(ticketReference, handoffSummary),
    engineeringReviewStarted: true,
    engineeringReviewStartedAt:
      requestedAt,
    diagnosisRunId: diagnosisKickoff?.runId || "",
    engineeringExecutionStarted: true,
    engineeringExecutionStartedAt: requestedAt,
    executionRunId: diagnosisKickoff?.executionRunId || "",
    executionStatus: diagnosisKickoff?.executionStatus || "",
  };
  conversation.status = "escalated";
  conversation.lastMessageAt = systemMessage?.createdAt || requestedAt;
  conversation.metadata = {
    ...(conversation.metadata || {}),
    support: {
      ...(conversation.metadata?.support || {}),
      escalationOffered: true,
      escalationSent: true,
      engineeringReviewStarted: true,
      engineeringReviewStartedAt:
        requestedAt,
      diagnosisRunId: diagnosisKickoff?.runId || "",
      engineeringExecutionStarted: true,
      engineeringExecutionStartedAt: requestedAt,
      executionRunId: diagnosisKickoff?.executionRunId || "",
      executionStatus: diagnosisKickoff?.executionStatus || "",
    },
  };
  await conversation.save();
  publishConversationEvent(conversation._id, {
    type: "conversation.updated",
    reason: "conversation.escalated",
  });

  await publishSupportTicketEscalatedEvent({
    ticket: ticketDoc.toObject ? ticketDoc.toObject() : ticketDoc,
    user,
    userMessage,
    assistantMessage: updatedAssistantMessage,
    context,
    handoffSummary,
    suffix: eventSuffix,
  });

  return {
    conversation,
    assistantMessage: updatedAssistantMessage,
    systemMessage,
    ticketDoc,
    diagnosisKickoff,
    ticketId,
    ticketReference,
    handoffSummary,
    reused: Boolean(existingTicket),
  };
}

function buildTicketMessage({ latestUserMessage = "", assistantSummary = "", pageContext = {}, supportFacts = {} } = {}) {
  const lines = [
    `User message: ${latestUserMessage || "Not available."}`,
    assistantSummary ? `Assistant summary: ${assistantSummary}` : "",
    pageContext.viewName || pageContext.pathname
      ? `Page context: ${pageContext.viewName || pageContext.pathname}`
      : "",
    supportFacts.caseState?.caseId
      ? `Case: ${supportFacts.caseState.title || supportFacts.caseState.caseId}`
      : "",
    supportFacts.blockers?.length ? `Blockers: ${supportFacts.blockers.join(", ")}` : "",
    supportFacts.nextSteps?.length ? `Suggested next steps: ${supportFacts.nextSteps.join(" | ")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

async function updateAssistantEscalationMetadata({
  assistantMessage,
  ticketId,
  ticketReference,
  requestedAt,
}) {
  if (!assistantMessage) return null;
  assistantMessage.metadata = {
    ...(assistantMessage.metadata || {}),
    needsEscalation: true,
    escalation: {
      ...(assistantMessage.metadata?.escalation || {}),
      available: true,
      requested: true,
      ticketId: String(ticketId || ""),
      ticketReference: ticketReference || "",
      requestedAt,
      reason: assistantMessage.metadata?.escalationReason || assistantMessage.metadata?.escalation?.reason || "",
    },
  };
  assistantMessage.text = stripEscalationConfirmationCopy(assistantMessage.text);
  await assistantMessage.save();
  return assistantMessage;
}

async function findLatestConversationMessages(conversationId, messageId = "") {
  const query = { conversationId };
  const assistantMessage =
    messageId && mongoose.isValidObjectId(messageId)
      ? await SupportMessage.findOne({
          ...query,
          _id: messageId,
          sender: "assistant",
        })
      : await SupportMessage.findOne({
          ...query,
          sender: "assistant",
        }).sort({ createdAt: -1, _id: -1 });

  const userMessage = await SupportMessage.findOne({
    ...query,
    sender: "user",
  }).sort({ createdAt: -1, _id: -1 });

  return { assistantMessage, userMessage };
}

async function escalateConversation({
  conversationId,
  user = {},
  messageId = "",
  sourcePage = "",
  pageContext = {},
} = {}) {
  const conversation = await findConversationForUser(conversationId, user._id);
  if (!conversation) return null;

  const context = getConversationContext({
    sourcePage: sourcePage || conversation.sourcePage,
    pageContext: Object.keys(pageContext || {}).length ? pageContext : conversation.pageContext,
  });
  const update = buildConversationUpdate({
    user,
    sourcePage: context.sourcePage,
    pageContext: context.pageContext,
  });

  const { assistantMessage, userMessage } = await findLatestConversationMessages(conversation._id, messageId);
  if (!assistantMessage) {
    throw new Error("No assistant reply is available to escalate.");
  }

  const existingTicket = await SupportTicket.findOne({
    conversationId: conversation._id,
    status: { $in: OPEN_TICKET_STATUSES },
  })
    .sort({ updatedAt: -1, createdAt: -1 });

  const handoffSummary = buildHandoffSummary({
    latestUserMessage: userMessage?.text || "",
    assistantReply: assistantMessage.metadata?.internalSummary || assistantMessage.text || "",
    categoryLabel: assistantMessage.metadata?.categoryLabel || formatCategoryLabel(assistantMessage.metadata?.category),
  });
  const escalationResult = await ensureConversationEscalated({
    conversation,
    user,
    userMessage,
    assistantMessage,
    context,
    update,
    existingTicket,
    existingHandoffSummary: handoffSummary,
  });

  return {
    conversation: serializeConversation(
      escalationResult.conversation?.toObject ? escalationResult.conversation.toObject() : escalationResult.conversation
    ),
    assistantMessage: serializeMessage(
      escalationResult.assistantMessage?.toObject
        ? escalationResult.assistantMessage.toObject()
        : escalationResult.assistantMessage
    ),
    systemMessage: escalationResult.systemMessage
      ? serializeMessage(
          escalationResult.systemMessage.toObject
            ? escalationResult.systemMessage.toObject()
            : escalationResult.systemMessage
        )
      : {
          id: "",
          conversationId: normalizeId(conversation._id),
          sender: "system",
          text: buildEscalationMessageText(escalationResult.ticketReference, escalationResult.handoffSummary),
          sourcePage: context.sourcePage || "",
          pageContext: context.pageContext || {},
          metadata: {
            kind: "support_escalation",
            ticketId: escalationResult.ticketId,
            ticketReference: escalationResult.ticketReference,
            handoffSummary: escalationResult.handoffSummary,
          },
          createdAt: null,
          updatedAt: null,
        },
    ticket: {
      id: escalationResult.ticketId,
      reference: escalationResult.ticketReference,
      status: escalationResult.ticketDoc?.status || "open",
      reused: escalationResult.reused === true,
    },
    confirmation: {
      message: buildEscalationMessageText(escalationResult.ticketReference, escalationResult.handoffSummary),
      handoffSummary: escalationResult.handoffSummary,
    },
  };
}

async function restartConversation({
  conversationId,
  user = {},
  sourcePage = "",
  pageContext = {},
} = {}) {
  const currentConversation = await findConversationForUser(conversationId, user._id);
  if (!currentConversation) return null;

  const context = getConversationContext({
    sourcePage: sourcePage || currentConversation.sourcePage,
    pageContext: Object.keys(pageContext || {}).length ? pageContext : currentConversation.pageContext,
  });
  const update = buildConversationUpdate({
    user,
    sourcePage: context.sourcePage,
    pageContext: context.pageContext,
  });
  const restartedAt = new Date();

  currentConversation.status = "closed";
  currentConversation.lastMessageAt = restartedAt;
  currentConversation.metadata = {
    ...(currentConversation.metadata || {}),
    support: {
      ...(currentConversation.metadata?.support || {}),
      restartedAt,
      restartedByUser: true,
    },
  };
  await currentConversation.save();

  const nextConversation = await SupportConversation.create({
    userId: user._id,
    status: "open",
    role: update.role,
    sourceSurface: update.sourceSurface,
    sourcePage: context.sourcePage,
    pageContext: context.pageContext,
    lastMessageAt: restartedAt,
    metadata: {
      support: {
        restartedFromConversationId: currentConversation._id,
        restartedAt,
        activeTask: "",
        activeAsk: "",
        activeIntent: "",
        intentConfidence: "",
        activeEntity: null,
        awaiting: null,
        awaitingField: "",
        lastResponseType: "",
        lastResponseMode: "",
        lastAssistantReply: "",
        escalationShown: false,
        escalationOffered: false,
        escalationSent: false,
        awaitingMessagingClarification: false,
        lastMessagingClarificationAt: null,
        awaitingIntakeDetails: false,
        lastIntakePromptAt: null,
      },
    },
  });

  currentConversation.metadata = {
    ...(currentConversation.metadata || {}),
    support: {
      ...(currentConversation.metadata?.support || {}),
      restartedToConversationId: nextConversation._id,
    },
  };
  await currentConversation.save();

  await ensureWelcomeMessage(nextConversation._id);
  publishConversationEvent(currentConversation._id, {
    type: "conversation.updated",
    reason: "conversation.restarted",
  });
  publishConversationEvent(nextConversation._id, {
    type: "conversation.updated",
    reason: "conversation.restarted",
  });

  const [hydratedConversation, messageDocs] = await Promise.all([
    SupportConversation.findById(nextConversation._id).lean(),
    SupportMessage.find({ conversationId: nextConversation._id })
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
  ]);

  return {
    conversation: serializeConversation(hydratedConversation || nextConversation),
    messages: messageDocs.map(serializeMessage),
    previousConversationId: normalizeId(currentConversation._id),
  };
}

module.exports = {
  SUPPORT_WELCOME_MESSAGE,
  createConversationMessage,
  escalateConversation,
  findConversationForUser,
  getOrCreateOpenConversation,
  listConversationMessages,
  restartConversation,
};
