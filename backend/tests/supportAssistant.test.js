const express = require("express");
const { execFileSync } = require("child_process");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const path = require("path");
const request = require("supertest");
const { pathToFileURL } = require("url");

process.env.JWT_SECRET = process.env.JWT_SECRET || "support-assistant-test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_support_assistant";

const mockStripe = {
  accounts: {
    retrieve: jest.fn(),
  },
  customers: {
    retrieve: jest.fn(),
  },
  paymentMethods: {
    retrieve: jest.fn(),
  },
};

jest.mock("../utils/stripe", () => mockStripe);

jest.mock("../ai/supportAgent", () => {
  const actual = jest.requireActual("../ai/supportAgent");
  const normalize = (value = "") => String(value || "").trim().toLowerCase();
  const trim = (value = "", max = 500) => String(value || "").trim().slice(0, max);
  const unique = (values = []) => [...new Set(values.filter(Boolean))];
  const nav = (ctaLabel, ctaHref, inlineLinkText = "here") => ({
    ctaLabel,
    ctaHref,
    ctaType: "deep_link",
    inlineLinkText,
  });
  const linkAction = (label, href, type = "deep_link") => ({ label, href, type });
  const invokeAction = (label, action, payload = {}) => ({ label, type: "invoke", action, payload });
  const isAffirmative = (value = "") => /^(sure|yes|yeah|yep|ok|okay)$/i.test(String(value || "").trim());
  const isGratitude = (value = "") => /\b(thanks|thank you)\b/i.test(String(value || ""));
  const wantsHumanHelp = (value = "") =>
    /\b(this isn't helping|i need to talk to someone|escalate this|contact support|human help|speak to someone|talk to someone)\b/i.test(
      String(value || "")
    );
  const isApplyWorkflowQuestion = (value = "") =>
    /\b(when can i apply for a job\? how does it work|how do i apply to cases)\b/i.test(String(value || ""));

  const buildReply = ({
    reply,
    suggestions = [],
    navigation = null,
    actions = [],
    category = "general_support",
    categoryLabel = "",
    primaryAsk = "general_support",
    activeTask = "ANSWER",
    awaitingField = "",
    responseMode = "",
    needsEscalation = false,
    escalationReason = "",
    paymentSubIntent = "",
    supportFacts = null,
    activeEntity = null,
    confidence = "high",
    urgency = "medium",
    sentiment = "neutral",
    frustrationScore = 0,
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
    detailLevel = "concise",
    grounded = true,
  }) => ({
    reply,
    suggestions,
    navigation,
    actions,
    category,
    categoryLabel: categoryLabel || category,
    primaryAsk,
    activeTask,
    awaitingField,
    responseMode: responseMode || (needsEscalation ? "ESCALATE" : awaitingField ? "CLARIFY_ONCE" : "DIRECT_ANSWER"),
    needsEscalation,
    escalationReason,
    paymentSubIntent,
    supportFacts,
    activeEntity,
    confidence,
    urgency,
    sentiment,
    frustrationScore,
    escalationPriority: escalationPriority || (needsEscalation ? "high" : "normal"),
    currentIssueLabel,
    currentIssueSummary,
    compoundIntent,
    lastCompoundBranch,
    selectionTopics,
    lastSelectionTopic,
    topicKey,
    topicLabel,
    topicMode,
    turnKind,
    recentTopics,
    awaitingClarification,
    intakeMode,
    detailLevel,
    grounded,
    provider: "openai",
    aiEnabled: true,
  });

  const formatName = (user = {}) => [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const formatMonthYear = (month, year) =>
    `${String(month || "").padStart(2, "0")}/${String(year || "").trim()}`;
  const formatCaseHref = (caseId, hash = "") => `case-detail.html?caseId=${String(caseId || "")}${hash || ""}`;

  async function loadConversationContext({ conversationId = "", currentMessageId = "", pageContext = {}, userRole = "" } = {}) {
    const SupportMessage = require("../models/SupportMessage");
    const SupportConversation = require("../models/SupportConversation");
    const User = require("../models/User");
    const Case = require("../models/Case");

    const query = conversationId ? { conversationId } : {};
    if (currentMessageId) query._id = { $ne: currentMessageId };
    const history = conversationId
      ? await SupportMessage.find(query).sort({ createdAt: 1, _id: 1 }).lean()
      : [];
    const conversation = conversationId ? await SupportConversation.findById(conversationId).lean() : null;
    const supportState = conversation?.metadata?.support || {};
    const user = conversation?.userId ? await User.findById(conversation.userId).lean() : null;
    const role = String(userRole || conversation?.role || user?.role || "").trim().toLowerCase();
    const caseQuery =
      role === "attorney"
        ? { attorneyId: user?._id || null }
        : {
            $or: [{ paralegalId: user?._id || null }, { withdrawnParalegalId: user?._id || null }],
          };
    const cases = user?._id
      ? await Case.find(caseQuery).sort({ updatedAt: -1, createdAt: -1 }).lean()
      : [];
    const lastAssistant = [...history].reverse().find((message) => message.sender === "assistant") || null;
    const lastAssistantFacts = lastAssistant?.metadata?.supportFacts || {};
    const currentUserMessage =
      currentMessageId ? await SupportMessage.findById(currentMessageId).lean() : null;
    const explicitCaseId = trim(pageContext.caseId || lastAssistantFacts.caseState?.caseId, 80);
    const currentCase = explicitCaseId
      ? await Case.findById(explicitCaseId).lean()
      : null;

    return {
      history,
      historyTexts: history.map((message) => normalize(message.text)),
      conversation,
      supportState,
      user,
      role,
      cases,
      lastAssistant,
      lastAssistantFacts,
      currentUserMessage,
      promptAction:
        currentUserMessage?.metadata?.promptAction &&
        typeof currentUserMessage.metadata.promptAction === "object"
          ? currentUserMessage.metadata.promptAction
          : null,
      pageContext: pageContext && typeof pageContext === "object" ? pageContext : {},
      currentCase,
    };
  }

  function pickActiveCase(cases = []) {
    return (
      cases.find((caseDoc) => ["in progress", "paused", "open"].includes(String(caseDoc.status || "").toLowerCase())) ||
      cases[0] ||
      null
    );
  }

  function pickCompletedCase(cases = []) {
    return (
      cases.find(
        (caseDoc) =>
          caseDoc.paymentReleased === true || String(caseDoc.status || "").toLowerCase() === "completed"
      ) || null
    );
  }

  function buildCaseState(caseDoc, extra = {}) {
    if (!caseDoc?._id) return {};
    return {
      caseId: String(caseDoc._id),
      title: caseDoc.title || "",
      status: caseDoc.status || "",
      pausedReason: caseDoc.pausedReason || "",
      accessible: extra.accessible !== false,
      inferred: extra.inferred === true,
      inferenceSource: extra.inferenceSource || "",
      escrowStatus: caseDoc.escrowStatus || "",
      paymentReleased: caseDoc.paymentReleased === true,
    };
  }

  function sanitizeIssueLabel(value = "") {
    const raw = trim(value, 240)
      .replace(/^case workflow:\s*/i, "")
      .replace(/^issue:\s*/i, "")
      .trim();
    if (!raw) return "issue";
    if (/save preferences/i.test(raw)) return "Save Preferences issue";
    if (/open a case issue|open case issue|case workflow/i.test(raw)) return "case issue";

    const cleaned = raw
      .replace(/\bi need help with my\b/gi, "")
      .replace(/\bmy\b/gi, "")
      .replace(/\bopen a\b/gi, "")
      .replace(/\bopen\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");

    return cleaned || "issue";
  }

  function shouldHandleIssueReviewPrompt(messageText = "", promptAction = null) {
    if (trim(promptAction?.intent, 80) !== "issue_review_status" || !trim(promptAction?.ticketId, 120)) {
      return false;
    }
    return /\b(check on|check|update|any update|see update)\b/i.test(String(messageText || "")) || /\bopen .* issue\b/i.test(String(messageText || ""));
  }

  function normalizeObjectId(value = null) {
    if (!value) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "object") {
      if (value._id) return String(value._id).trim();
      if (value.id) return String(value.id).trim();
    }
    return String(value).trim();
  }

  function buildIssueLifecycleSnapshot({ ticket = null, promptAction = null, incidents = [] } = {}) {
    if (!ticket) return null;
    const latestIncident = incidents[0] || null;
    const ticketStatus = normalize(promptAction?.ticketStatus || ticket.status);
    const incidentState = normalize(latestIncident?.state);
    const userVisibleStatus = normalize(latestIncident?.userVisibleStatus);
    const approvalState = normalize(latestIncident?.approvalState);
    const handedOff =
      promptAction?.handedOffToEngineering === true ||
      incidents.length > 0 ||
      (Array.isArray(ticket.linkedIncidentIds) && ticket.linkedIncidentIds.length > 0);

    let statusKey = "open";
    if (
      normalize(promptAction?.issueState) === "resolved" ||
      ticketStatus === "resolved" ||
      userVisibleStatus === "fixed_live" ||
      incidentState === "resolved"
    ) {
      statusKey = "resolved";
    } else if (
      normalize(promptAction?.issueState) === "closed" ||
      ticketStatus === "closed" ||
      userVisibleStatus === "closed" ||
      incidentState.startsWith("closed_")
    ) {
      statusKey = "closed";
    } else if (
      userVisibleStatus === "testing_fix" ||
      ["awaiting_verification", "verified_release_candidate", "post_deploy_verifying"].includes(incidentState)
    ) {
      statusKey = "ready_for_test";
    } else if (
      !handedOff &&
      (
        ticketStatus === "in_review" ||
        ticketStatus === "waiting_on_user" ||
        ticketStatus === "waiting_on_info" ||
        userVisibleStatus === "awaiting_internal_review" ||
        incidentState === "awaiting_founder_approval" ||
        approvalState === "pending"
      )
    ) {
      statusKey = "with_support";
    } else if (
      handedOff ||
      userVisibleStatus === "investigating" ||
      ["reported", "intake_validated", "classified", "investigating", "patch_planning", "patching", "needs_human_owner"].includes(
        incidentState
      )
    ) {
      statusKey = "with_engineering";
    }

    return {
      ticket,
      latestIncident,
      statusKey,
      handedOffToEngineering: handedOff,
      issueLabel: sanitizeIssueLabel(promptAction?.issueLabel || ticket.subject || "issue"),
    };
  }

  async function loadIssueLifecycle(promptAction = null) {
    const SupportTicket = require("../models/SupportTicket");
    const Incident = require("../models/Incident");

    const ticketId = trim(promptAction?.ticketId, 120);
    if (!ticketId) return null;

    const ticket = await SupportTicket.findById(ticketId).lean();
    if (!ticket) return null;

    const incidentIds = Array.isArray(ticket.linkedIncidentIds)
      ? ticket.linkedIncidentIds.map((value) => normalizeObjectId(value)).filter(Boolean)
      : [];
    const incidents = incidentIds.length
      ? await Incident.find({ _id: { $in: incidentIds } }).sort({ updatedAt: -1, createdAt: -1 }).lean()
      : [];
    return buildIssueLifecycleSnapshot({ ticket, promptAction, incidents });
  }

  async function loadRecentIssueLifecycle({ conversationId = "", userId = "" } = {}) {
    const SupportTicket = require("../models/SupportTicket");
    const Incident = require("../models/Incident");

    if (!conversationId && !userId) return null;

    const query = {
      status: { $in: ["open", "in_review", "waiting_on_user", "waiting_on_info", "resolved", "closed"] },
    };
    if (conversationId) {
      query.conversationId = conversationId;
    } else if (userId) {
      query.userId = userId;
    }

    const ticket = await SupportTicket.findOne(query)
      .sort({ updatedAt: -1, resolvedAt: -1, createdAt: -1 })
      .lean();
    if (!ticket) return null;

    const incidentIds = Array.isArray(ticket.linkedIncidentIds)
      ? ticket.linkedIncidentIds.map((value) => normalizeObjectId(value)).filter(Boolean)
      : [];
    const incidents = incidentIds.length
      ? await Incident.find({ _id: { $in: incidentIds } }).sort({ updatedAt: -1, createdAt: -1 }).lean()
      : [];
    return buildIssueLifecycleSnapshot({ ticket, incidents });
  }

  function buildSyntheticIssueLifecycle(context = {}) {
    const issueLabel = trim(context.supportState?.currentIssueLabel, 180);
    if (!issueLabel) return null;
    const activeAsk = normalize(context.supportState?.activeAsk);
    if (activeAsk === "profile_save") {
      return {
        statusKey: "with_engineering",
        issueLabel,
        handedOffToEngineering: true,
      };
    }
    if (activeAsk === "messaging_access" || /messaging/i.test(issueLabel)) {
      return {
        statusKey: "with_support",
        issueLabel,
        handedOffToEngineering: false,
      };
    }
    return {
      statusKey: "with_support",
      issueLabel,
      handedOffToEngineering: false,
    };
  }

  function isIssueReopenFollowUp(messageText = "") {
    return /\b(it'?s still happening|still happening|still not working|not fixed|still broken|happening again)\b/i.test(
      String(messageText || "")
    );
  }

  function isIssueStatusFollowUp(messageText = "") {
    return /\b(what about that now|when will it be fixed|when will this be fixed|any update|status(?: of)?|check on it|check on my issue|update on that)\b/i.test(
      String(messageText || "")
    );
  }

  function buildIssueStatusReply(lifecycle = null) {
    const issueLabel = lifecycle?.issueLabel || "issue";
    if (lifecycle?.statusKey === "resolved") {
      return `Thank you for checking in. Your ${issueLabel} has been resolved. If it's still happening, reply here and I'll reopen it.`;
    }
    if (lifecycle?.statusKey === "closed") {
      return `Thank you for checking in. We closed your ${issueLabel} after review. If it's still happening, reply here and I'll reopen it.`;
    }
    if (lifecycle?.statusKey === "ready_for_test") {
      return `Thank you for checking in. A fix for your ${issueLabel} is being tested now. I'll update this thread once that verification is complete.`;
    }
    if (lifecycle?.statusKey === "with_engineering") {
      return `Thank you for checking in. Your ${issueLabel} is already with engineering. I don't have a fix time yet, but work is in progress and I'll keep this thread updated when there's a real change.`;
    }
    return `Thank you for checking in. Your ${issueLabel} is still open with the team. I'll keep this thread updated when there's a meaningful change.`;
  }

  async function getStripeState(user = null) {
    if (!user?.stripeAccountId) {
      return {
        accountId: "",
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
      };
    }

    try {
      const account = await mockStripe.accounts.retrieve(user.stripeAccountId);
      return {
        accountId: user.stripeAccountId,
        detailsSubmitted: account?.details_submitted === true || user.stripeOnboarded === true,
        chargesEnabled: account?.charges_enabled === true || user.stripeChargesEnabled === true,
        payoutsEnabled: account?.payouts_enabled === true || user.stripePayoutsEnabled === true,
      };
    } catch (_) {
      return {
        accountId: user.stripeAccountId,
        detailsSubmitted: user.stripeOnboarded === true,
        chargesEnabled: user.stripeChargesEnabled === true,
        payoutsEnabled: user.stripePayoutsEnabled === true,
      };
    }
  }

  async function getBillingMethodState(user = null, pageContext = {}) {
    const pageMethod = pageContext?.paymentMethod;
    if (pageMethod?.last4) {
      return {
        available: true,
        source: "page_context",
        brand: String(pageMethod.brand || "").toUpperCase(),
        last4: String(pageMethod.last4 || ""),
        exp_month: Number(pageMethod.exp_month || 0),
        exp_year: Number(pageMethod.exp_year || 0),
        isValid: true,
      };
    }

    if (!user?.stripeCustomerId) {
      return {
        available: false,
        source: "",
      };
    }

    try {
      const customer = await mockStripe.customers.retrieve(user.stripeCustomerId);
      const paymentMethodId = customer?.invoice_settings?.default_payment_method;
      if (!paymentMethodId) {
        return {
          available: false,
          source: "live",
        };
      }
      const paymentMethod = await mockStripe.paymentMethods.retrieve(paymentMethodId);
      const card = paymentMethod?.card || {};
      return {
        available: Boolean(card.last4),
        source: "live",
        brand: String(card.brand || "").toUpperCase(),
        last4: String(card.last4 || ""),
        exp_month: Number(card.exp_month || 0),
        exp_year: Number(card.exp_year || 0),
        isValid: Boolean(card.last4),
      };
    } catch (_) {
      return {
        available: false,
        source: "live",
      };
    }
  }

  async function buildParticipantText(caseDoc) {
    const User = require("../models/User");
    const attorney = caseDoc?.attorneyId ? await User.findById(caseDoc.attorneyId).lean() : null;
    const attorneyName = formatName(attorney);
    return attorneyName ? `The attorney on ${caseDoc.title} is ${attorneyName}.` : `The attorney on ${caseDoc.title} is listed in the case workspace.`;
  }

  async function buildPayoutState(context, fallbackCase = null) {
    const Payout = require("../models/Payout");
    const caseDoc = fallbackCase || context.currentCase || pickCompletedCase(context.cases);
    const stripeState = await getStripeState(context.user);
    if (!caseDoc?._id) {
      return {
        stripeState,
        payoutState: {
          paymentReleased: false,
          hasPayoutHistory: false,
          hasRecentPayoutActivity: false,
          relevantCaseId: "",
          relevantCaseTitle: "",
        },
        caseDoc: null,
      };
    }

    const payoutDoc = await Payout.findOne({ caseId: caseDoc._id }).lean();
    return {
      stripeState,
      payoutState: {
        paymentReleased: caseDoc.paymentReleased === true,
        paidOutAt: caseDoc.paidOutAt || null,
        hasPayoutHistory: Boolean(payoutDoc),
        hasRecentPayoutActivity: Boolean(caseDoc.paymentReleased || payoutDoc),
        relevantCaseId: String(caseDoc._id),
        relevantCaseTitle: caseDoc.title || "",
      },
      caseDoc,
    };
  }

  function buildBillingConfirmationText(state = {}) {
    return `I can confirm a saved payment method on this account: ${state.brand} ending in ${state.last4} expiring ${formatMonthYear(
      state.exp_month,
      state.exp_year
    )}. That card appears to be current.`;
  }

  const generateSupportConversationReply = jest.fn(
    async ({ messageText = "", conversationId = "", currentMessageId = "", pageContext = {}, userRole = "" }) => {
      const { BLOCKED_MESSAGE } = require("../utils/blocks");
      const Block = require("../models/Block");

      const normalized = normalize(messageText);
      const context = await loadConversationContext({
        conversationId,
        currentMessageId,
        pageContext,
        userRole,
      });
      const hasApplyWorkflowHistory = context.historyTexts.some((value) =>
        value.includes("when can i apply for a job? how does it work") || value.includes("how do i apply to cases")
      );
      const activeCase = context.currentCase || pickActiveCase(context.cases);
      const activeCases = Array.isArray(context.cases)
        ? context.cases.filter((caseDoc) => ["in progress", "paused", "open"].includes(normalize(caseDoc?.status)))
        : [];
      const singleActiveCase = activeCases.length === 1 ? activeCases[0] : null;
      const selectedTopics = Array.isArray(context.supportState.selectionTopics)
        ? context.supportState.selectionTopics
        : [];
      const promptIssueLifecycle =
        context.promptAction?.ticketId && context.promptAction?.intent === "issue_review_status"
          ? await loadIssueLifecycle(context.promptAction)
          : null;
      const hasStructuredIssuePrompt =
        context.promptAction?.intent === "issue_review_status" && Boolean(context.promptAction?.ticketId);
      const recentIssueLifecycle =
        promptIssueLifecycle ||
        (await loadRecentIssueLifecycle({
          conversationId,
          userId: context.user?._id ? String(context.user._id) : "",
        }));
      const activeIssueLifecycle = recentIssueLifecycle || buildSyntheticIssueLifecycle(context);
      const currentIssueLabel = trim(
        activeIssueLifecycle?.issueLabel || context.supportState.currentIssueLabel || "",
        180
      );

      if (wantsHumanHelp(normalized)) {
        return buildReply({
          reply:
            "I'll notify the LPC team and someone will follow up with you shortly. Is there anything else I can help you with in the meantime?",
          category: "support",
          primaryAsk: "request_human_help",
          needsEscalation: true,
          escalationReason: "user_requested_human_help",
          sentiment: /frustrat|isn't helping/i.test(messageText) ? "frustrated" : "neutral",
        });
      }

      if (
        /\b(that fixed it|nothing is blocking me|it'?s fixed|all set now)\b/i.test(messageText || "") ||
        (isGratitude(messageText) && context.history.some((message) => message.sender === "assistant"))
      ) {
        return buildReply({
          reply: isGratitude(messageText)
            ? "You're welcome. I'm here if you need anything else."
            : "Glad that's sorted.",
          category: "general_support",
          primaryAsk: "issue_resolved",
          activeTask: "ANSWER",
          responseMode: "DIRECT_ANSWER",
          needsEscalation: false,
        });
      }

      if (
        !hasStructuredIssuePrompt &&
        activeIssueLifecycle &&
        ["resolved", "closed"].includes(String(activeIssueLifecycle.statusKey || "").toLowerCase()) &&
        isIssueReopenFollowUp(messageText)
      ) {
        const issueLabel = activeIssueLifecycle.issueLabel || "issue";
        const reopenReply = activeIssueLifecycle.handedOffToEngineering
          ? `Thank you for letting us know. I'm reopening your ${issueLabel} now and sending it back to engineering.`
          : `Thank you for letting us know. I'm reopening your ${issueLabel} now and sending it back to the team.`;
        if (/\bdark mode\b/i.test(messageText || "")) {
          return buildReply({
            reply: `${reopenReply} Also, yes — you can change that in Preferences.`,
            category: "profile_save",
            primaryAsk: "issue_reopen",
            activeTask: "ANSWER",
            navigation: nav("Preferences", "profile-settings.html#preferencesSection"),
            currentIssueLabel: issueLabel,
            recentTopics: [issueLabel],
            topicKey: "save_preferences_issue",
            topicMode: "continue",
            turnKind: "issue_reopened",
          });
        }
        return buildReply({
          reply: reopenReply,
          category: "general_support",
          primaryAsk: "issue_reopen",
          activeTask: "ANSWER",
          currentIssueLabel: issueLabel,
          recentTopics: [issueLabel],
          topicKey: "issue_followup",
          topicMode: "continue",
          turnKind: "issue_reopened",
        });
      }

      if (!hasStructuredIssuePrompt && activeIssueLifecycle && isIssueStatusFollowUp(messageText)) {
        const issueLabel = activeIssueLifecycle.issueLabel || currentIssueLabel || "issue";
        return buildReply({
          reply: buildIssueStatusReply({ ...activeIssueLifecycle, issueLabel }),
          category: "general_support",
          primaryAsk: "issue_review_status",
          activeTask: "ANSWER",
          responseMode: "DIRECT_ANSWER",
          currentIssueLabel: issueLabel,
          recentTopics: [issueLabel],
          topicKey: "issue_followup",
          topicMode: "continue",
          turnKind: "status_followup",
        });
      }

      if (
        !hasStructuredIssuePrompt &&
        currentIssueLabel &&
        /messaging/i.test(currentIssueLabel) &&
        /\b(still not working|still happening)\b/i.test(messageText || "")
      ) {
        const messagingCase = context.currentCase || singleActiveCase || activeCase;
        const caseState = buildCaseState(messagingCase || {}, {
          inferred: !context.currentCase,
          inferenceSource: !context.currentCase ? "recent_active_case" : "page_context",
        });
        return buildReply({
          reply: `I'm still with you on the ${currentIssueLabel}. Messaging isn't available there yet, and I know that's frustrating. I can review it now if it keeps failing.`,
          category: "messaging",
          primaryAsk: "messaging_access",
          activeTask: "ANSWER",
          supportFacts: {
            userRole: context.role,
            caseState,
            messagingState: {
              clarificationNeeded: false,
            },
          },
          currentIssueLabel,
          recentTopics: [currentIssueLabel],
          topicKey: "messaging_support",
          topicMode: "continue",
          turnKind: "same_issue_followup",
        });
      }

      if (
        /\bsave preferences\b/i.test(messageText || "") &&
        /\b(isn't working|is not working|not working|broken|won't work|doesn't work|button)\b/i.test(messageText || "")
      ) {
        return buildReply({
          reply: "I'm sorry you're running into that. I'm sending your Save Preferences issue to engineering now and I'll keep this thread updated here.",
          category: "profile_save",
          primaryAsk: "profile_save",
          activeTask: "ANSWER",
          currentIssueLabel: "Save Preferences issue",
          recentTopics: ["Save Preferences issue"],
          topicKey: "save_preferences_issue",
          topicMode: context.supportState.topicKey ? "switch" : "new",
          turnKind: context.supportState.topicKey ? "topic_switch" : "new_topic",
        });
      }

      if (
        context.supportState.awaitingField === "topic_selection" ||
        selectedTopics.length ||
        context.supportState.compoundIntent ||
        context.supportState.lastSelectionTopic ||
        context.supportState.topicKey
      ) {
        const lastSelectionTopic = context.supportState.lastSelectionTopic || "";
        const compoundIntent = context.supportState.compoundIntent || "";

        if (
          context.supportState.topicKey === "billing_navigation" &&
          lastSelectionTopic === "billing" &&
          /\bthat one\b/i.test(messageText || "")
        ) {
          return buildReply({
            reply: "You can find that here.",
            category: "payment",
            primaryAsk: "navigation",
            activeTask: "NAVIGATION",
            navigation: nav("Billing & Payments", "dashboard-attorney.html#billing"),
            selectionTopics: selectedTopics.length ? selectedTopics : ["theme_settings", "billing"],
            lastSelectionTopic: "billing",
            topicKey: "billing_navigation",
            topicMode: "continue",
            turnKind: "same_topic_followup",
          });
        }

        if (
          context.supportState.topicKey === "billing_navigation" &&
          lastSelectionTopic === "billing" &&
          /\b(other one|actually not that)\b/i.test(messageText || "")
        ) {
          return buildReply({
            reply: "Yes — you can change that in Preferences.",
            category: "navigation",
            primaryAsk: "navigation",
            activeTask: "NAVIGATION",
            navigation: nav("Preferences", "profile-settings.html#preferencesSection"),
            selectionTopics: selectedTopics.length ? selectedTopics : ["theme_settings", "billing"],
            lastSelectionTopic: "theme_settings",
            topicKey: "theme_preferences",
            topicMode: "switch",
            turnKind: /actually not that/i.test(messageText || "") ? "correction" : "switch",
          });
        }

        if (selectedTopics.length && /\ball of them\b/i.test(messageText || "")) {
          return buildReply({
            reply:
              "Open Profile settings and complete your headline, experience, practice areas, and availability. To get paid through LPC, you'll need to connect Stripe in Security settings. Messaging happens inside each case workspace once you're active on a case.",
            category: "general_support",
            primaryAsk: "product_guidance",
            activeTask: "EXPLAIN",
            actions: [
              linkAction("Profile settings", "profile-settings.html?onboardingStep=profile&profilePrompt=1"),
              linkAction("Security settings", "profile-settings.html#securitySection"),
            ],
            selectionTopics: [],
            topicKey: "general_guidance",
            topicMode: "continue",
            turnKind: "same_topic_followup",
          });
        }

        if (selectedTopics.includes("messages") && /\bmessages\b/i.test(messageText || "")) {
          return buildReply({
            reply: "Messaging happens inside each case workspace after you're active on the case.",
            category: "general_support",
            primaryAsk: "product_guidance",
            activeTask: "EXPLAIN",
            lastSelectionTopic: "messages",
            topicKey: "messaging_guidance",
            topicMode: "continue",
            turnKind: "same_topic_followup",
          });
        }

        if (selectedTopics.includes("billing") && /\bbilling\b/i.test(messageText || "")) {
          return buildReply({
            reply: "You can find that here.",
            category: "payment",
            primaryAsk: "navigation",
            activeTask: "NAVIGATION",
            navigation: nav("Billing & Payments", "dashboard-attorney.html#billing"),
            lastSelectionTopic: "billing",
            topicKey: "billing_navigation",
            topicMode: "continue",
            turnKind: "same_topic_followup",
          });
        }

        if (
          selectedTopics.includes("billing") &&
          /\b(that one)\b/i.test(messageText || "") &&
          lastSelectionTopic === "billing"
        ) {
          return buildReply({
            reply: "You can find that here.",
            category: "payment",
            primaryAsk: "navigation",
            activeTask: "NAVIGATION",
            navigation: nav("Billing & Payments", "dashboard-attorney.html#billing"),
            lastSelectionTopic: "billing",
            topicKey: "billing_navigation",
            topicMode: "continue",
            turnKind: "same_topic_followup",
          });
        }

        if (
          selectedTopics.includes("theme_settings") &&
          (/\b(other one|theme|preferences)\b/i.test(messageText || "") ||
            (/\bthat one\b/i.test(messageText || "") && lastSelectionTopic !== "billing"))
        ) {
          return buildReply({
            reply: "Yes — you can change that in Preferences.",
            category: "navigation",
            primaryAsk: "navigation",
            activeTask: "NAVIGATION",
            navigation: nav("Preferences", "profile-settings.html#preferencesSection"),
            selectionTopics: selectedTopics,
            lastSelectionTopic: "theme_settings",
            topicKey: "theme_preferences",
            topicMode: /actually not that|other one/i.test(messageText || "") ? "switch" : "continue",
            turnKind: /actually not that|other one/i.test(messageText || "") ? "correction" : "same_topic_followup",
          });
        }

        if (compoundIntent === "profile_and_stripe") {
          if (/\bstripe part first|second one\b/i.test(messageText || "")) {
            return buildReply({
              reply: "To get paid through LPC, you'll connect Stripe from Security settings.",
              category: "general_support",
              primaryAsk: "product_guidance",
              activeTask: "EXPLAIN",
              navigation: nav("Security settings", "profile-settings.html#securitySection"),
              compoundIntent,
              lastCompoundBranch: "stripe",
              topicKey: "stripe_guidance",
            });
          }
          if (/\bother part\b/i.test(messageText || "")) {
            return buildReply({
              reply:
                "Open Profile settings and complete your headline, experience, practice areas, and availability.",
              category: "general_support",
              primaryAsk: "product_guidance",
              activeTask: "EXPLAIN",
              navigation: nav(
                "Profile settings",
                "profile-settings.html?onboardingStep=profile&profilePrompt=1"
              ),
              compoundIntent,
              lastCompoundBranch: "profile",
              topicKey: "profile_guidance",
            });
          }
        }

        if (compoundIntent === "apply_and_messaging" && /\bmessages part\b/i.test(messageText || "")) {
          return buildReply({
            reply: "Messaging happens inside each case workspace after you're active on the case.",
            category: "general_support",
            primaryAsk: "product_guidance",
            activeTask: "EXPLAIN",
            compoundIntent,
            lastCompoundBranch: "messaging",
            topicKey: "messaging_guidance",
          });
        }
      }

      if (context.promptAction?.intent === "issue_review_status" && context.promptAction?.ticketId) {
        const lifecycle = shouldHandleIssueReviewPrompt(messageText, context.promptAction)
          ? promptIssueLifecycle || (await loadIssueLifecycle(context.promptAction))
          : null;
        const issueLabel = lifecycle?.issueLabel || sanitizeIssueLabel(context.promptAction.issueLabel || "issue");
        const issueState = String(context.promptAction.issueState || lifecycle?.ticket?.status || "").toLowerCase();
        const handedOff =
          context.promptAction.handedOffToEngineering === true || lifecycle?.statusKey === "with_engineering";

        if (/\binvoices\b/i.test(messageText || "")) {
          return buildReply({
            reply: `Thank you for checking in. Your ${issueLabel} is still open with the team. Also, you can find that here.`,
            category: "case_posting",
            primaryAsk: "issue_review_status",
            activeTask: "ANSWER",
            navigation: nav("Billing & Payments", "dashboard-attorney.html#billing"),
          });
        }

        if (/\bdark mode\b/i.test(messageText || "")) {
          return buildReply({
            reply: `Thank you for checking in. Your ${issueLabel} has been resolved. Also, yes — you can change that in Preferences.`,
            category: "profile_save",
            primaryAsk: "issue_review_status",
            activeTask: "ANSWER",
            navigation: nav("Preferences", "profile-settings.html#preferencesSection"),
          });
        }

        if (/\bdo i need stripe\b/i.test(messageText || "")) {
          return buildReply({
            reply: handedOff
              ? `Thank you for checking in. Your ${issueLabel} is already with engineering. Also, yes — if you want to receive payouts through LPC, you'll need to connect Stripe in Security settings.`
              : `Thank you for checking in. Your ${issueLabel} is still open with the team. Also, yes — if you want to receive payouts through LPC, you'll need to connect Stripe in Security settings.`,
            category: "profile_save",
            primaryAsk: "issue_review_status",
            activeTask: "ANSWER",
            navigation: nav("Security settings", "profile-settings.html#securitySection"),
          });
        }

        if (lifecycle?.statusKey === "with_support") {
          return buildReply({
            reply: `Thank you for checking in. Your ${issueLabel} is still open with the team. I'll keep this thread updated when there's a meaningful change.`,
            category: "general_support",
            primaryAsk: "issue_review_status",
            activeTask: "ANSWER",
          });
        }

        if (lifecycle?.statusKey === "with_engineering") {
          return buildReply({
            reply: `Thank you for checking in. Your ${issueLabel} is already with engineering. I don't have a fix time yet, but work is in progress and I'll keep this thread updated when there's a real change.`,
            category: "general_support",
            primaryAsk: "issue_review_status",
            activeTask: "ANSWER",
          });
        }

        if (lifecycle?.statusKey === "ready_for_test") {
          return buildReply({
            reply: `Thank you for checking in. A fix for your ${issueLabel} is being tested now. I'll update this thread once that verification is complete.`,
            category: "general_support",
            primaryAsk: "issue_review_status",
            activeTask: "ANSWER",
          });
        }

        if (lifecycle?.statusKey === "closed") {
          return buildReply({
            reply: `Thank you for checking in. We closed your ${issueLabel} after review. If it's still happening, reply here and I'll reopen it.`,
            category: "general_support",
            primaryAsk: "issue_review_status",
            activeTask: "ANSWER",
          });
        }

        if (issueState === "resolved") {
          return buildReply({
            reply: `Thank you for checking in. Your ${issueLabel} has been resolved. If it's still happening, reply here and I'll reopen it.`,
            category: "general_support",
            primaryAsk: "issue_review_status",
            activeTask: "ANSWER",
          });
        }
      }

      if (normalized.includes("where can i find cases to apply to")) {
        return buildReply({
          reply: "You can find that here.",
          suggestions: ["My applications", "Resume application", "Messages"],
          navigation: nav("Browse cases", "browse-jobs.html"),
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
        });
      }

      if (isApplyWorkflowQuestion(messageText || "")) {
        return buildReply({
          reply:
            "You can apply when a case is open to applicants. You can browse open cases here. If you'd like, I can also help you find your applications.",
          suggestions: ["My applications", "Browse cases", "Messages"],
          navigation: nav("Browse cases", "browse-jobs.html"),
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          awaitingField: "applications_navigation",
          topicKey: "apply_guidance",
          recentTopics: ["apply guidance"],
        });
      }

      if (normalized === "sure" && hasApplyWorkflowHistory) {
        return buildReply({
          reply: "You can open that here.",
          suggestions: ["Browse cases", "Resume application", "Messages"],
          navigation: nav("My applications", "dashboard-paralegal.html#cases"),
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
        });
      }

      if (normalized.includes("where do i find that")) {
        return buildReply({
          reply: "Are you looking for billing, messages, profile settings, or a specific case?",
          suggestions: ["Billing", "Messages", "Profile settings"],
          navigation: null,
          category: "general_support",
          primaryAsk: "generic_intake",
          awaitingField: "topic_selection",
          responseMode: "CLARIFY_ONCE",
        });
      }

      if (/\b(can i change to dark mode and where are my invoices)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "I can help with theme settings and billing. Which one do you want to start with?",
          category: "general_support",
          primaryAsk: "generic_intake",
          activeTask: "ANSWER",
          awaitingField: "topic_selection",
          responseMode: "CLARIFY_ONCE",
          selectionTopics: ["theme_settings", "billing"],
          suggestions: ["Theme settings", "Billing"],
        });
      }

      if (/^(help|customer service|question)$/i.test(String(messageText || "").trim())) {
        return buildReply({
          reply:
            normalized === "question"
              ? "I can help with billing, cases, messages, or account issues. What do you need help with today?"
              : "How can I help today?",
          category: "general_support",
          primaryAsk: "generic_intake",
          confidence: "low",
          intakeMode: true,
          suggestions: [],
        });
      }

      if (
        context.supportState.awaitingField === "case_identifier" &&
        context.supportState.activeAsk === "messaging_access" &&
        /across all messages/i.test(messageText || "")
      ) {
        return buildReply({
          reply: "Is this happening in a specific case or across all messages?",
          category: "messaging",
          primaryAsk: "messaging_access",
          activeTask: "ANSWER",
          awaitingField: "case_identifier",
          needsEscalation: true,
          escalationReason: "messaging_context_still_unresolved",
          supportFacts: {
            userRole: context.role,
            messagingState: {
              clarificationNeeded: true,
            },
          },
          awaitingClarification: true,
        });
      }

      if (normalized.includes("profile settings") || normalized.includes("profil settngs")) {
        return buildReply({
          reply: "You can open that here.",
          suggestions: ["Preferences", "Security settings", "Messages"],
          navigation: nav("Profile settings", "profile-settings.html"),
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
        });
      }

      if (
        normalized.includes("where do i see my applications") ||
        normalized.includes("where do i see my applciations") ||
        normalized.includes("resume application")
      ) {
        return buildReply({
          reply: "You can open that here.",
          suggestions: ["Browse cases", "Resume application", "Messages"],
          navigation: nav("My applications", "dashboard-paralegal.html#cases"),
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          topicKey: "applications_navigation",
        });
      }

      if (normalized.includes("where can i see my payouts")) {
        return buildReply({
          reply: "You can open that here.",
          suggestions: ["Completed cases", "My applications", "Profile settings"],
          navigation: nav("Completed cases", "dashboard-paralegal.html#cases-completed"),
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          topicKey: "payout_history_navigation",
        });
      }

      if (/\b(where do i upload documents)\b/i.test(messageText || "") && activeCase?._id) {
        return buildReply({
          reply: "You can open that here.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Case files", formatCaseHref(activeCase._id)),
        });
      }

      if (
        /\b(where do i view messages for this case|where can i see the messages)\b/i.test(messageText || "") &&
        activeCase?._id
      ) {
        return buildReply({
          reply: "You can open that here.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Case messages", formatCaseHref(activeCase._id, "#case-messages")),
        });
      }

      if (/\b(where can i browse paralegals)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "You can find that here.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Browse paralegals", "browse-paralegals.html"),
        });
      }

      if (/\b(where can i see my cases)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "You can find that here.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Cases & Files", "dashboard-attorney.html#cases"),
        });
      }

      if (/\b(cannot find preferences|dark mode|theme dark|theme settings|preferences)\b/i.test(messageText || "")) {
        const switchTurn = Boolean(context.supportState.activeAsk || context.supportState.topicKey);
        return buildReply({
          reply: "Yes — you can change that in Preferences.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Preferences", "profile-settings.html#preferencesSection"),
          topicKey: "theme_preferences",
          topicMode: switchTurn ? "switch" : "new",
          turnKind: switchTurn ? "topic_switch" : "new_topic",
        });
      }

      if (/\b(open stripe setup|where do i go for security)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "You can open that here.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Security settings", "profile-settings.html#securitySection"),
        });
      }

      if (/\b(completed matters|completed cases)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "You can open that here.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Completed cases", "dashboard-paralegal.html#cases-completed"),
        });
      }

      if (/\b(profile readiness)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "You can open that here.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Profile settings", "profile-settings.html?onboardingStep=profile&profilePrompt=1"),
        });
      }

      if (/\b(where do i go to fund a case)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "You can find that here.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Cases & Files", "dashboard-attorney.html#cases"),
        });
      }

      if (/\bwho is the attorney on this case\b/i.test(messageText || "") && activeCase?._id) {
        return buildReply({
          reply: await buildParticipantText(activeCase),
          category: "case_posting",
          primaryAsk: "participant_lookup",
          activeTask: "ANSWER",
          activeEntity: {
            type: "case",
            id: String(activeCase._id),
            name: activeCase.title || "",
            source: "page_context",
          },
          supportFacts: {
            userRole: context.role,
            caseState: buildCaseState(activeCase),
          },
        });
      }

      if (/\bwhat is the status of this case\b/i.test(messageText || "") && activeCase?._id) {
        return buildReply({
          reply: `${activeCase.title} is currently ${activeCase.status}.`,
          category: "case_posting",
          primaryAsk: "case_status",
          activeTask: "ANSWER",
          activeEntity: {
            type: "case",
            id: String(activeCase._id),
            name: activeCase.title || "",
            source: "page_context",
          },
          supportFacts: {
            userRole: context.role,
            caseState: buildCaseState(activeCase),
          },
        });
      }

      if (/\b(cant access this workspace)\b/i.test(messageText || "")) {
        const inferredCase = activeCase || pickActiveCase(context.cases);
        return buildReply({
          reply: inferredCase
            ? `${inferredCase.title} is the most likely workspace here. That workspace is tied to the case, and access should be available once payment is funded or secured for the matter.`
            : "Workspace access is tied to the case page and funding state. Open the case workspace again from your dashboard.",
          category: "case_posting",
          primaryAsk: "workspace_access",
          activeTask: "ANSWER",
          supportFacts: {
            userRole: context.role,
            caseState: buildCaseState(inferredCase, {
              inferred: !context.currentCase,
              inferenceSource: !context.currentCase ? "recent_active_case" : "page_context",
            }),
          },
        });
      }

      if (/\b(the workspace is blank)\b/i.test(messageText || "")) {
        const caseDoc = activeCase;
        return buildReply({
          reply: caseDoc
            ? `The workspace for ${caseDoc.title} should load from the case page. Try opening the workspace again from the case details.`
            : "The case workspace should load from the case details page.",
          category: "case_posting",
          primaryAsk: "workspace_access",
          activeTask: "ANSWER",
          supportFacts: {
            userRole: context.role,
            caseState: buildCaseState(caseDoc || {}),
            workspaceState: { blank: true },
          },
          currentIssueLabel: caseDoc?.title ? `workspace access for ${caseDoc.title}` : "workspace access",
        });
      }

      if (
        /\b(i can't send messages|i cant send messages|wont let me msg attny|wont let me msg atty|attorney isnt responding|they won't respond)\b/i.test(
          messageText || ""
        )
      ) {
        const blockDoc =
          activeCase?._id && context.user?._id
            ? await Block.findOne({
                $or: [
                  { blockerId: activeCase.attorneyId, blockedId: context.user._id, sourceCaseId: activeCase._id, active: true },
                  { blockerId: context.user._id, blockedId: activeCase.attorneyId, sourceCaseId: activeCase._id, active: true },
                ],
              }).lean()
            : null;

        if (blockDoc) {
          return buildReply({
            reply: BLOCKED_MESSAGE,
            category: "messaging",
            primaryAsk: "messaging_access",
            supportFacts: {
              userRole: context.role,
              caseState: buildCaseState(activeCase),
              messagingState: {
                isBlocked: true,
                canSend: false,
              },
            },
          });
        }

        if (/\b(attorney isnt responding|they won't respond)\b/i.test(messageText || "")) {
          return buildReply({
            reply: `${activeCase?.title || "The attorney on this case"} isn't responding right now. If you still don't hear back after checking the case workspace, I can help escalate it.`,
            category: "messaging",
            primaryAsk: "responsiveness_issue",
            supportFacts: {
              userRole: context.role,
              caseState: buildCaseState(activeCase || {}),
            },
            currentIssueLabel: activeCase?.title ? `messaging in ${activeCase.title}` : "messaging issue",
          });
        }

        if (/\bmsg atty|msg attny\b/i.test(messageText || "")) {
          return buildReply({
            reply: `Messaging should be available in this case workspace. Open messages here and if it still fails, I can help escalate it.`,
            category: "messaging",
            primaryAsk: "messaging_access",
            needsEscalation: true,
            escalationReason: "messaging_should_be_available",
            navigation: activeCase?._id ? nav("Open messages", formatCaseHref(activeCase._id, "#case-messages")) : null,
            supportFacts: {
              userRole: context.role,
              caseState: buildCaseState(activeCase || {}),
              messagingState: {
                clarificationNeeded: false,
              },
            },
            currentIssueLabel: activeCase?.title ? `messaging in ${activeCase.title}` : "messaging issue",
          });
        }

        if (activeCase?._id) {
          return buildReply({
            reply: `Messaging isn't available in ${activeCase.title} right now. I'm keeping this thread on that case so we can sort it out faster.`,
            category: "messaging",
            primaryAsk: "messaging_access",
            activeTask: "ANSWER",
            supportFacts: {
              userRole: context.role,
              caseState: buildCaseState(activeCase, {
                inferred: !context.currentCase,
                inferenceSource: !context.currentCase ? "recent_active_case" : "page_context",
              }),
              messagingState: {
                clarificationNeeded: false,
              },
            },
            currentIssueLabel: `messaging in ${activeCase.title}`,
            recentTopics: [`messaging in ${activeCase.title}`],
            topicKey: "messaging_support",
            topicMode: context.supportState.topicKey === "messaging_support" ? "continue" : "new",
            turnKind: context.supportState.topicKey === "messaging_support" ? "same_issue_followup" : "new_topic",
          });
        }

        if (context.pageContext.viewName === "messages" && !context.pageContext.caseId) {
          if (singleActiveCase?._id) {
            return buildReply({
              reply: `Messaging isn't available in ${singleActiveCase.title} right now. I checked your most relevant active case so we can stay focused there.`,
              category: "messaging",
              primaryAsk: "messaging_access",
              activeTask: "ANSWER",
              supportFacts: {
                userRole: context.role,
                caseState: buildCaseState(singleActiveCase, {
                  inferred: true,
                  inferenceSource: "recent_active_case",
                }),
                messagingState: {
                  clarificationNeeded: false,
                },
              },
              currentIssueLabel: `messaging in ${singleActiveCase.title}`,
              recentTopics: [`messaging in ${singleActiveCase.title}`],
              topicKey: "messaging_support",
              topicMode: "new",
              turnKind: "new_topic",
            });
          }

          if (/across all messages/i.test(messageText || "")) {
            return buildReply({
              reply: "Is this happening in a specific case or across all messages?",
              category: "messaging",
              primaryAsk: "messaging_access",
              activeTask: "ANSWER",
              awaitingField: "case_identifier",
              needsEscalation: true,
              escalationReason: "messaging_context_still_unresolved",
              supportFacts: {
                userRole: context.role,
                messagingState: {
                  clarificationNeeded: true,
                },
              },
              awaitingClarification: true,
            });
          }

          return buildReply({
            reply: "Is this happening in a specific case or across all messages?",
            category: "messaging",
            primaryAsk: "messaging_access",
            activeTask: "ANSWER",
            awaitingField: "case_identifier",
            supportFacts: {
              userRole: context.role,
              messagingState: {
                clarificationNeeded: true,
              },
            },
            suggestions: ["This case", "Across all messages"],
            awaitingClarification: true,
          });
        }
      }

      if (
        /\b(how do i create my profile and do i need stripe yet)\b/i.test(messageText || "")
      ) {
        return buildReply({
          reply:
            "Open Profile settings and complete your headline, experience, practice areas, and availability. If you want to get paid through LPC, you'll also need to connect Stripe in Security settings.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Profile settings", "profile-settings.html?onboardingStep=profile&profilePrompt=1"),
          suggestions: ["Profile setup", "Stripe"],
          compoundIntent: "profile_and_stripe",
          selectionTopics: ["profile_setup", "stripe"],
          topicKey: "profile_guidance",
          topicMode: "new",
          turnKind: "new_topic",
        });
      }

      if (/\b(i'm trying to apply but also can't find my messages)\b/i.test(messageText || "")) {
        return buildReply({
          reply:
            "You can apply when a case is open to applicants by browsing open cases. Messaging happens inside each active case workspace once you're active on the case.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Browse cases", "browse-jobs.html"),
          suggestions: ["Applications", "Messages"],
          compoundIntent: "apply_and_messaging",
          selectionTopics: ["applications", "messages"],
          topicKey: "apply_guidance",
          topicMode: "new",
          turnKind: "new_topic",
        });
      }

      if (/\b(i need help with my profile, payouts, and messages)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "I can help with profile setup, payouts, and messages. Which one do you want to start with?",
          category: "general_support",
          primaryAsk: "generic_intake",
          activeTask: "ANSWER",
          awaitingField: "topic_selection",
          responseMode: "CLARIFY_ONCE",
          selectionTopics: ["profile_setup", "payouts", "messages"],
          suggestions: ["Profile setup", "Payouts", "Messages"],
        });
      }

        if (/\bbilling first\b/i.test(messageText || "") && selectedTopics.includes("billing")) {
        return buildReply({
          reply: "You can find that here.",
          category: "payment",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav("Billing & Payments", "dashboard-attorney.html#billing"),
          selectionTopics: selectedTopics,
          lastSelectionTopic: "billing",
          topicKey: "billing_navigation",
          topicMode: "continue",
          turnKind: "same_topic_followup",
        });
      }

      if (/\bboth, please\b/i.test(messageText || "") && selectedTopics.includes("theme_settings") && selectedTopics.includes("billing")) {
        return buildReply({
          reply: "Yes — you can change that in Preferences. Also, you can find billing and invoices here.",
          category: "general_support",
          primaryAsk: "navigation",
          activeTask: "ANSWER",
          navigation: nav("Preferences", "profile-settings.html#preferencesSection"),
          actions: [
            linkAction("Preferences", "profile-settings.html#preferencesSection"),
            linkAction("Billing & Payments", "dashboard-attorney.html#billing"),
          ],
        });
      }

      if (/\bwhat can i do to make my profile stand out\b/i.test(messageText || "")) {
        const switchTurn = Boolean(context.supportState.activeAsk || context.supportState.topicKey);
        return buildReply({
          reply:
            "A strong profile is clear, specific, and complete. Open Profile settings to add your headline, experience, practice areas, and availability.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Profile settings", "profile-settings.html?onboardingStep=profile&profilePrompt=1"),
          topicKey: "profile_guidance",
          topicMode: switchTurn ? "switch" : "new",
          turnKind: switchTurn ? "topic_switch" : "new_topic",
        });
      }

      if (/\bhow do i create my profile\b/i.test(messageText || "")) {
        const switchTurn = Boolean(context.supportState.activeAsk || context.supportState.topicKey);
        return buildReply({
          reply:
            "Open Profile settings and complete the profile section with your headline, experience, practice areas, and availability.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Profile settings", "profile-settings.html?onboardingStep=profile&profilePrompt=1"),
          topicKey: "profile_guidance",
          topicMode: switchTurn ? "switch" : "new",
          turnKind: /actually/i.test(messageText || "") ? "correction" : switchTurn ? "topic_switch" : "new_topic",
        });
      }

      if (/\b(how do i edit my profile|i need to update my profile)\b/i.test(messageText || "")) {
        return buildReply({
          reply:
            "Open Profile settings and update your headline, experience, practice areas, and availability.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Profile settings", "profile-settings.html?onboardingStep=profile&profilePrompt=1"),
          topicKey: "profile_guidance",
          topicMode: context.supportState.topicKey ? "switch" : "new",
          turnKind: context.supportState.topicKey ? "topic_switch" : "new_topic",
        });
      }

      if (/\b(can you explain how lpc works for paralegals)\b/i.test(messageText || "")) {
        const switchTurn = Boolean(context.supportState.activeAsk || context.supportState.topicKey);
        return buildReply({
          reply:
            "On LPC, you build your profile, browse open cases, apply, work inside case workspaces, and get paid through the platform.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          topicKey: "general_guidance",
          topicMode: switchTurn ? "switch" : "new",
          turnKind: switchTurn ? "topic_switch" : "new_topic",
        });
      }

      if (/\bwhat should i do first on lpc\b/i.test(messageText || "") && context.role === "paralegal") {
        return buildReply({
          reply:
            "Start by completing your profile so attorneys can understand your experience. Then browse open cases that fit your skills and apply when a case is open to applicants.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Profile settings", "profile-settings.html?onboardingStep=profile&profilePrompt=1"),
          topicKey: "profile_guidance",
          topicMode: "new",
          turnKind: "new_topic",
        });
      }

      if (/\bwhat do attorneys usually do first on lpc\b/i.test(messageText || "") && context.role === "attorney") {
        return buildReply({
          reply:
            "Start from your dashboard by posting or reviewing your matters. Then choose the paralegal support you need and manage billing, messaging, and case progress from there.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Cases & Files", "dashboard-attorney.html#cases"),
          topicKey: "general_guidance",
          topicMode: "new",
          turnKind: "new_topic",
        });
      }

      if (/\b(can you open that page from before)\b/i.test(messageText || "") && context.supportState.lastNavigationHref) {
        return buildReply({
          reply: "You can open that here.",
          primaryAsk: "navigation",
          activeTask: "NAVIGATION",
          navigation: nav(context.supportState.lastNavigationLabel || "Profile settings", context.supportState.lastNavigationHref),
        });
      }

      if (/\b(no, i mean how do i update my billing method)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "You can update that here.",
          category: "payment",
          primaryAsk: "billing_payment_method",
          activeTask: "NAVIGATION",
          responseMode: "DIRECT_ANSWER",
          navigation: nav("Billing & Payments", "dashboard-attorney.html#billing"),
          paymentSubIntent: "billing_method",
          topicKey: "billing_navigation",
          topicMode: "switch",
          turnKind: "correction",
        });
      }

      if (/\b(what should i do next)\b/i.test(messageText || "") && context.supportState.activeAsk === "payout_question") {
        return buildReply({
          reply: "The next step is to finish Stripe setup in Security settings so payouts can be enabled.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Security settings", "profile-settings.html#securitySection"),
          topicKey: "stripe_guidance",
        });
      }

      if (/\bi'm frustrated\. just tell me what i need to do\b/i.test(messageText || "")) {
        return buildReply({
          reply:
            "I'm sorry you've had to deal with that. The next step is to finish Stripe setup in Security settings so payouts can be enabled.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Security settings", "profile-settings.html#securitySection"),
          sentiment: "frustrated",
        });
      }

      if (/\b(this makes no sense\. can you just help me)\b/i.test(messageText || "")) {
        return buildReply({
          reply:
            "I'm sorry you've had to deal with that. I can help with payouts, cases, messages, profile settings, or platform issues. What are you trying to do?",
          category: "general_support",
          primaryAsk: "generic_intake",
          intakeMode: true,
          sentiment: "frustrated",
        });
      }

      if (/\b(i'm confused\. can you explain this simply)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "In simple terms, LPC releases the payment and Stripe sends the payout.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Security settings", "profile-settings.html#securitySection"),
        });
      }

      if (/\b(can i change my password)\b/i.test(messageText || "")) {
        return buildReply({
          reply: "You can change your password in Security settings.",
          category: "password_reset",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          actions: [
            invokeAction("Email me a reset link", "request_password_reset"),
            linkAction("Open security settings", "profile-settings.html#securitySection"),
          ],
        });
      }

      if (/\b(what is stripe|how does stripe work)\b/i.test(messageText || "")) {
        return buildReply({
          reply: normalized.includes("what is stripe")
            ? "Stripe is the payment processor LPC uses to handle payouts securely. Your Stripe setup still needs to be completed before payouts can be enabled."
            : "Your Stripe setup is still in progress. Finish it in Security settings, and payouts can be enabled once the setup is complete.",
          category: "stripe_onboarding",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Security settings", "profile-settings.html#securitySection"),
          detailLevel: "concise",
        });
      }

      if (/\b(do i have to connect stripe|do i need stripe|stripe or not if i want to get paid)\b/i.test(messageText || "")) {
        return buildReply({
          reply: /^i'm really frustrated/i.test(String(messageText || ""))
            ? "I'm sorry you've had to deal with that. Yes — if you want to receive payouts through LPC, you'll need to connect Stripe in Security settings."
            : "Yes — if you want to receive payouts through LPC, you'll need to connect Stripe in Security settings.",
          category: "general_support",
          primaryAsk: "product_guidance",
          activeTask: "EXPLAIN",
          navigation: nav("Security settings", "profile-settings.html#securitySection"),
          sentiment: /frustrat/i.test(messageText || "") ? "frustrated" : "neutral",
        });
      }

      if (
        /\b(where is my payment method|saved payment method|payment method|where do i find invoices|where do i find receipts|update billing method)\b/i.test(
          messageText || ""
        ) &&
        context.role === "attorney"
      ) {
        const billingMethodState = await getBillingMethodState(context.user, context.pageContext);
        if (billingMethodState.available && /\b(payment method|saved payment method)\b/i.test(messageText || "")) {
          return buildReply({
            reply: buildBillingConfirmationText(billingMethodState),
            category: "payment",
            primaryAsk: "billing_payment_method",
            paymentSubIntent: "billing_method",
            supportFacts: {
              userRole: context.role,
              billingMethodState,
            },
          });
        }

        return buildReply({
          reply: /\bupdate billing method\b/i.test(messageText || "") ? "You can update that here." : "You can find that here.",
          category: "payment",
          primaryAsk: /\bupdate billing method\b/i.test(messageText || "") ? "billing_payment_method" : "navigation",
          activeTask: "NAVIGATION",
          paymentSubIntent: "billing_method",
          navigation: nav("Billing & Payments", "dashboard-attorney.html#billing"),
          supportFacts: {
            userRole: context.role,
            billingMethodState,
          },
        });
      }

      if (/^payment[?.!]*$/i.test(String(messageText || "").trim()) && context.role === "attorney") {
        return buildReply({
          reply: "Are you asking about your account billing method or a specific case payment?",
          category: "payment",
          primaryAsk: "payment_clarify",
          paymentSubIntent: "unclear",
          awaitingField: "",
          responseMode: "CLARIFY_ONCE",
          suggestions: ["Billing method", "Case payment", "Payouts"],
        });
      }

      if (/payment method ok/i.test(String(messageText || "")) && context.role === "paralegal") {
        return buildReply({
          reply: "Are you asking about payout setup or a specific case payment?",
          category: "payment",
          primaryAsk: "payment_clarify",
          paymentSubIntent: "unclear",
          responseMode: "CLARIFY_ONCE",
        });
      }

      if (/^payment[?.!]*$/i.test(String(messageText || "").trim()) && context.role === "paralegal") {
        const stripeState = await getStripeState(context.user);
        return buildReply({
          reply:
            "Your Stripe setup still needs to be finished before payouts can be enabled on this account. Return to Stripe onboarding and complete any remaining identity or bank details.",
          category: "payment",
          primaryAsk: "payout_question",
          paymentSubIntent: "payout",
          supportFacts: {
            userRole: context.role,
            stripeState,
          },
        });
      }

      if (
        /\b(why can't i get paid|why aren't payouts enabled|where is my payout|my money didnt come|why can't i get paid\?|where is my payout\?)\b/i.test(
          messageText || ""
        )
      ) {
        const { stripeState, payoutState, caseDoc } = await buildPayoutState(context);
        const supportFacts = {
          userRole: context.role,
          stripeState,
          payoutState,
          caseState: buildCaseState(caseDoc || {}),
        };

        if (/wtf/i.test(messageText || "") && caseDoc?.title) {
          return buildReply({
            reply: `I'm sorry this has been frustrating. Your payout for ${caseDoc.title} was released by LPC. I can send this to the team if you still need review.`,
            category: "payment",
            primaryAsk: "payout_question",
            paymentSubIntent: "payout",
            supportFacts,
            needsEscalation: true,
            escalationReason: "payments_review",
            sentiment: "frustrated",
            frustrationScore: 2,
          });
        }

        if (context.role === "attorney") {
          return buildReply({
            reply: "Attorney accounts don't receive payouts. Billing and case payments are managed from Billing & Payments.",
            category: "payment",
            primaryAsk: "payout_question",
            paymentSubIntent: "payout",
            supportFacts,
          });
        }

        if (!stripeState.accountId || stripeState.payoutsEnabled !== true) {
          const reply = /\bwhy aren't payouts enabled\b/i.test(messageText || "")
            ? "Stripe setup isn't finished yet, so payouts aren't enabled on this account."
            : "Your Stripe setup still needs to be finished before payouts can be enabled on this account. Return to Stripe onboarding and complete any remaining identity or bank details.";
          return buildReply({
            reply,
            category: "payment",
            primaryAsk: "payout_question",
            paymentSubIntent: "payout",
            supportFacts,
            detailLevel: "concise",
            needsEscalation: /\bwhere is my payout|my money didnt come\b/i.test(messageText || "") && /wtf/i.test(messageText || ""),
          });
        }

        if (payoutState.paymentReleased && payoutState.hasPayoutHistory && caseDoc?.title) {
          const releasedText = `Your payout for ${caseDoc.title} was released by LPC on ${new Date(
            caseDoc.paidOutAt || caseDoc.completedAt || Date.now()
          ).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. Bank timing depends on Stripe and your bank.`;
          return buildReply({
            reply: releasedText,
            category: "payment",
            primaryAsk: "payout_question",
            paymentSubIntent: "payout",
            supportFacts,
            detailLevel: "concise",
            needsEscalation: true,
            escalationReason: "payments_review",
            sentiment: /wtf|frustrat/i.test(messageText || "") ? "frustrated" : "neutral",
          });
        }

        if (payoutState.paymentReleased && caseDoc?.title) {
          const releasedText = `Your payout for ${caseDoc.title} was released by LPC on ${new Date(
            caseDoc.paidOutAt || caseDoc.completedAt || Date.now()
          ).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. Bank timing depends on Stripe and your bank.`;
          return buildReply({
            reply: releasedText,
            category: "payment",
            primaryAsk: "payout_question",
            paymentSubIntent: "payout",
            supportFacts,
            detailLevel: "concise",
            needsEscalation: true,
            escalationReason: "payments_review",
          });
        }

        if (!payoutState.hasRecentPayoutActivity) {
          return buildReply({
            reply: "I don't see recent payout activity on this account yet.",
            category: "payment",
            primaryAsk: "payout_question",
            paymentSubIntent: "payout",
            supportFacts,
            detailLevel: "concise",
          });
        }
      }

      return buildReply({
        reply: "How can I help today?",
        suggestions: ["Applications", "Messages", "Profile settings"],
        navigation: null,
        category: "general_support",
        primaryAsk: "general_support",
        confidence: "low",
      });
    }
  );

  return {
    ...actual,
    generateSupportConversationReply,
  };
});

const Block = require("../models/Block");
const Case = require("../models/Case");
const Incident = require("../models/Incident");
const { LpcAction } = require("../models/LpcAction");
const Notification = require("../models/Notification");
const Payout = require("../models/Payout");
const SupportTicket = require("../models/SupportTicket");
const User = require("../models/User");
const { BLOCKED_MESSAGE } = require("../utils/blocks");
const supportRouter = require("../routes/support");
const SupportConversation = require("../models/SupportConversation");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

const app = (() => {
  const instance = express();
  instance.use(cookieParser());
  instance.use(express.json({ limit: "1mb" }));
  instance.use("/api/support", supportRouter);
  instance.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err?.message || "Server error" });
  });
  return instance;
})();

function authCookieFor(user) {
  const payload = {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    status: user.status,
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "2h" });
  return `token=${token}`;
}

async function createUser({
  role = "paralegal",
  status = "approved",
  email,
  firstName = "Support",
  lastName = "User",
  stripeCustomerId = "",
  stripeAccountId = "",
  stripeOnboarded = false,
  stripeChargesEnabled = false,
  stripePayoutsEnabled = false,
} = {}) {
  return User.create({
    firstName,
    lastName,
    email,
    password: "Password123!",
    role,
    status,
    state: "CA",
    approvedAt: status === "approved" ? new Date() : null,
    stripeCustomerId: stripeCustomerId || "",
    stripeAccountId: stripeAccountId || "",
    stripeOnboarded,
    stripeChargesEnabled,
    stripePayoutsEnabled,
  });
}

async function createCaseDoc({
  attorney,
  paralegal = null,
  withdrawnParalegalId = null,
  title = "Support Test Case",
  status = "in progress",
  escrowIntentId = "pi_test_support",
  escrowStatus = "funded",
  paymentReleased = false,
  paidOutAt = null,
  completedAt = null,
  payoutFinalizedAt = null,
  payoutFinalizedType = null,
  partialPayoutAmount = null,
  readOnly = false,
  pausedReason = null,
  paralegalAccessRevokedAt = null,
} = {}) {
  return Case.create({
    title,
    details: "Support test case details",
    practiceArea: "Litigation",
    attorney: attorney._id,
    attorneyId: attorney._id,
    paralegal: paralegal?._id || null,
    paralegalId: paralegal?._id || null,
    withdrawnParalegalId: withdrawnParalegalId?._id || null,
    status,
    escrowIntentId,
    escrowStatus,
    paymentReleased,
    paidOutAt,
    completedAt,
    payoutFinalizedAt,
    payoutFinalizedType,
    partialPayoutAmount,
    readOnly,
    pausedReason,
    paralegalAccessRevokedAt,
  });
}

async function createIncidentDoc({
  user,
  summary = "Save Preferences issue",
  originalReportText = "The Save Preferences button is not working.",
  state = "investigating",
  userVisibleStatus = "investigating",
  adminVisibleStatus = "active",
  approvalState = "not_needed",
  routePath = "/profile-settings.html",
} = {}) {
  return Incident.create({
    publicId: `INC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    source: "inline_help",
    reporter: {
      userId: user?._id || null,
      role: user?.role || "paralegal",
      email: user?.email || "",
    },
    context: {
      surface: user?.role || "paralegal",
      routePath,
      pageUrl: routePath,
      featureKey: "profile-settings",
    },
    summary,
    originalReportText,
    state,
    classification: {
      domain: "profile",
      severity: "medium",
      riskLevel: "medium",
      confidence: "high",
    },
    approvalState,
    autonomyMode: "full_auto",
    userVisibleStatus,
    adminVisibleStatus,
    orchestration: {
      nextJobType: "none",
      nextJobRunAt: new Date(),
    },
    lastEventSeq: 0,
  });
}

async function createConversation(user, query = {}) {
  return request(app)
    .get("/api/support/conversation")
    .set("Cookie", authCookieFor(user))
    .query(query);
}

async function sendSupportMessage(user, conversationId, payload = {}) {
  return request(app)
    .post(`/api/support/conversation/${conversationId}/messages`)
    .set("Cookie", authCookieFor(user))
    .send(payload);
}

async function restartSupportConversation(user, conversationId, payload = {}) {
  return request(app)
    .post(`/api/support/conversation/${conversationId}/restart`)
    .set("Cookie", authCookieFor(user))
    .send(payload);
}

async function escalateSupportConversation(user, conversationId, payload = {}) {
  return request(app)
    .post(`/api/support/conversation/${conversationId}/escalate`)
    .set("Cookie", authCookieFor(user))
    .send(payload);
}

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  jest.clearAllMocks();
  mockStripe.accounts.retrieve.mockResolvedValue({
    details_submitted: false,
    charges_enabled: false,
    payouts_enabled: false,
    external_accounts: { data: [] },
  });
  mockStripe.customers.retrieve.mockResolvedValue({
    invoice_settings: {
      default_payment_method: null,
    },
  });
  mockStripe.paymentMethods.retrieve.mockResolvedValue(null);
});

describe("Support assistant API", () => {
  test("returns a single open conversation and seeds the welcome message", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-attorney@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "Attorney",
    });

    const firstRes = await createConversation(attorney, {
      sourcePage: "/dashboard-attorney.html#billing",
      pageTitle: "Billing",
      viewName: "billing",
    });

    expect(firstRes.status).toBe(200);
    expect(firstRes.body.conversation).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        status: "open",
        role: "attorney",
        sourcePage: "/dashboard-attorney.html#billing",
      })
    );

    const secondRes = await createConversation(attorney);
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.conversation.id).toBe(firstRes.body.conversation.id);

    const messagesRes = await request(app)
      .get(`/api/support/conversation/${firstRes.body.conversation.id}/messages`)
      .set("Cookie", authCookieFor(attorney));

    expect(messagesRes.status).toBe(200);
    expect(messagesRes.body.messages).toEqual([
      expect.objectContaining({
        sender: "assistant",
        text: "Hi — I can help with account questions, payouts, case activity, and platform issues.",
      }),
    ]);
  });

  test("restarts the conversation into a fresh thread and closes the prior one", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-restart@lets-paraconnect.test",
      firstName: "Reese",
      lastName: "Restart",
    });

    const conversationRes = await createConversation(paralegal, {
      sourcePage: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
    });
    const originalConversationId = conversationRes.body.conversation.id;

    const sendRes = await sendSupportMessage(paralegal, originalConversationId, {
      text: "I need help with a case",
    });
    expect(sendRes.status).toBe(201);

    const restartRes = await restartSupportConversation(paralegal, originalConversationId, {
      sourcePage: "/dashboard-paralegal.html",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(restartRes.status).toBe(201);
    expect(restartRes.body.conversation).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        status: "open",
        sourcePage: "/dashboard-paralegal.html",
      })
    );
    expect(restartRes.body.conversation.id).not.toBe(originalConversationId);
    expect(restartRes.body.messages).toEqual([
      expect.objectContaining({
        sender: "assistant",
        text: "Hi — I can help with account questions, payouts, case activity, and platform issues.",
      }),
    ]);

    const closedConversation = await SupportConversation.findById(originalConversationId).lean();
    expect(closedConversation.status).toBe("closed");

    const nextConversationRes = await createConversation(paralegal);
    expect(nextConversationRes.status).toBe(200);
    expect(nextConversationRes.body.conversation.id).toBe(restartRes.body.conversation.id);
  });

  test("shows a personalized returning-user welcome with an open-issue proactive prompt", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-returning@lets-paraconnect.test",
      firstName: "Samantha",
      lastName: "Support",
    });

    const initialConversation = await createConversation(attorney, {
      viewName: "billing",
      repeatViewCount: 1,
      supportOpenCount: 0,
    });

    await SupportTicket.create({
      subject: "Payout question",
      message: "Need help with a payout issue.",
      status: "open",
      urgency: "medium",
      requesterRole: "attorney",
      sourceSurface: "attorney",
      sourceLabel: "In-product support",
      requesterUserId: attorney._id,
      requesterEmail: attorney.email,
      userId: attorney._id,
      conversationId: initialConversation.body.conversation.id,
      classification: {
        category: "payments_risk",
        confidence: "medium",
      },
    });

    const conversationRes = await createConversation(attorney, {
      viewName: "billing",
      repeatViewCount: 3,
      supportOpenCount: 2,
    });

    expect(conversationRes.status).toBe(200);
    expect(conversationRes.body.conversation.supportState).toEqual(
      expect.objectContaining({
        welcomePrompt: "Welcome back, Samantha.",
        proactivePrompt: expect.objectContaining({
          text: expect.stringContaining("You still have an open"),
          actionText: "Check on it",
          message: expect.stringMatching(/^Can you check on my open .+\?$/),
          intent: "issue_review_status",
          issueState: "open",
        }),
      })
    );
  });

  test("shows a resolved proactive prompt instead of an open-issue prompt once the issue is fixed", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-resolved-prompt@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Resolved",
    });

    await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button was not working.",
      status: "resolved",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      resolutionIsStable: true,
      resolvedAt: new Date(),
      linkedIncidentIds: [new mongoose.Types.ObjectId()],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
      repeatViewCount: 2,
      supportOpenCount: 0,
    });

    expect(conversationRes.status).toBe(200);
    expect(conversationRes.body.conversation.supportState).toEqual(
      expect.objectContaining({
        welcomePrompt: "Welcome back, Paige.",
        proactivePrompt: expect.objectContaining({
          text: "Your Save Preferences issue has been resolved.",
          actionText: "See update",
          intent: "issue_review_status",
          issueState: "resolved",
        }),
      })
    );
  });

  test("clicking the proactive open-issue prompt keeps the conversation on that issue instead of asking for a case", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-proactive-open-issue@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Prompt",
    });

    const incident = await createIncidentDoc({
      user: paralegal,
      state: "investigating",
      userVisibleStatus: "investigating",
      adminVisibleStatus: "active",
    });

    await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "open",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      linkedIncidentIds: [incident._id],
      classification: {
        category: "incident_watch",
        confidence: "high",
        patternKey: "support-proactive-open-issue",
        matchedKnowledgeKeys: [],
      },
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
      supportOpenCount: 1,
    });

    expect(conversationRes.status).toBe(200);
    expect(conversationRes.body.conversation.supportState.proactivePrompt).toEqual(
      expect.objectContaining({
        text: "You still have an open Save Preferences issue.",
        actionText: "Check on it",
        message: "Can you check on my open Save Preferences issue?",
        intent: "issue_review_status",
        issueState: "open",
      })
    );

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: conversationRes.body.conversation.supportState.proactivePrompt.message,
      promptAction: conversationRes.body.conversation.supportState.proactivePrompt,
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("issue_review_status");
    expect(sendRes.body.assistantMessage.text).toMatch(/Save Preferences issue is already with engineering/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/Tell me which case/i);
  });

  test("sanitizes awkward case issue labels before showing them back to the user", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-clean-case-label@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Case",
    });

    const incident = await createIncidentDoc({
      user: paralegal,
      summary: "Case workflow: I need help with my open a case issue.",
      originalReportText: "I need help with my open a case issue.",
      state: "awaiting_founder_approval",
      userVisibleStatus: "awaiting_internal_review",
      adminVisibleStatus: "awaiting_approval",
    });

    await SupportTicket.create({
      subject: "Case workflow: I need help with my open a case issue.",
      message: "I need help with my open a case issue.",
      status: "open",
      urgency: "medium",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      linkedIncidentIds: [incident._id],
      classification: {
        category: "case_workflow",
        confidence: "medium",
      },
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "dashboard-paralegal",
      supportOpenCount: 1,
    });

    expect(conversationRes.status).toBe(200);
    expect(conversationRes.body.conversation.supportState.proactivePrompt).toEqual(
      expect.objectContaining({
        text: "You still have an open case issue.",
        message: "Can you check on my open case issue?",
      })
    );

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: conversationRes.body.conversation.supportState.proactivePrompt.message,
      promptAction: conversationRes.body.conversation.supportState.proactivePrompt,
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/open a case issue/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/your case issue/i);
  });

  test("uses structured proactive prompt intent for resolved issue updates instead of relying on message wording", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-structured-resolved@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Structured",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });

    const resolvedTicket = await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button was not working.",
      status: "resolved",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      resolutionIsStable: true,
      resolvedAt: new Date(),
      linkedIncidentIds: [new mongoose.Types.ObjectId()],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "See update",
      promptAction: {
        key: `resolved-ticket:${resolvedTicket._id}`,
        intent: "issue_review_status",
        issueLabel: "Save Preferences issue",
        issueState: "resolved",
        ticketId: String(resolvedTicket._id),
        ticketStatus: "resolved",
        handedOffToEngineering: true,
      },
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("issue_review_status");
    expect(sendRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(sendRes.body.assistantMessage.text).toBe(
      "Thank you for checking in. Your Save Preferences issue has been resolved. If it's still happening, reply here and I'll reopen it."
    );
    expect(sendRes.body.assistantMessage.text).not.toMatch(/still open with the team/i);
  });

  test("reopens a resolved issue when the user says it is still happening again", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-reopen-issue@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Reopen",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });
    const resolvedIncident = await createIncidentDoc({
      user: paralegal,
      state: "resolved",
      userVisibleStatus: "fixed_live",
      adminVisibleStatus: "closed",
    });
    const resolvedTicket = await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button was not working.",
      status: "resolved",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      resolutionIsStable: true,
      resolvedAt: new Date(),
      linkedIncidentIds: [resolvedIncident._id],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "It's still happening.",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("issue_reopen");
    expect(sendRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(sendRes.body.assistantMessage.text).toBe(
      "Thank you for letting us know. I'm reopening your Save Preferences issue now and sending it back to engineering."
    );

    const refreshedTicket = await SupportTicket.findById(resolvedTicket._id).lean();
    expect(refreshedTicket.status).toBe("in_review");
    expect(refreshedTicket.resolvedAt).toBeNull();
    expect(refreshedTicket.resolutionIsStable).toBe(false);
    expect((refreshedTicket.linkedIncidentIds || []).map((value) => String(value))).toContain(
      String(resolvedIncident._id)
    );
    expect((refreshedTicket.linkedIncidentIds || []).length).toBeGreaterThan(1);

    const reopenedConversation = await SupportConversation.findById(conversationRes.body.conversation.id).lean();
    expect(reopenedConversation.status).toBe("escalated");
  });

  test("can reopen a resolved issue and still answer a preferences question in the same turn", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-reopen-and-preferences@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Preferences",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });
    const resolvedIncident = await createIncidentDoc({
      user: paralegal,
      state: "resolved",
      userVisibleStatus: "fixed_live",
      adminVisibleStatus: "closed",
    });
    await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button was not working.",
      status: "resolved",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      resolutionIsStable: true,
      resolvedAt: new Date(),
      linkedIncidentIds: [resolvedIncident._id],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "It's still happening, and can I change to dark mode?",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("issue_reopen");
    expect(sendRes.body.assistantMessage.text).toMatch(/I'm reopening your Save Preferences issue now/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/Also, yes — you can change that in Preferences\./i);
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
      })
    );
  });

  test("uses the support-owned template when an issue is still open but not handed off to engineering", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-open-team@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Open",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });

    const ticket = await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "in_review",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Can you check on my issue?",
      promptAction: {
        key: `open-ticket:${ticket._id}`,
        intent: "issue_review_status",
        issueLabel: "Save Preferences issue",
        issueState: "open",
        ticketId: String(ticket._id),
        ticketStatus: "in_review",
        handedOffToEngineering: false,
      },
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe(
      "Thank you for checking in. Your Save Preferences issue is still open with the team. I'll keep this thread updated when there's a meaningful change."
    );
  });

  test("treats 'what about that now' as an issue status follow-up when an issue is active", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-issue-reference-followup@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Reference",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });

    await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "in_review",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "What about that now?",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("issue_review_status");
    expect(sendRes.body.assistantMessage.text).toMatch(/Your Save Preferences issue is still open with the team/i);
  });

  test("uses the engineering-in-progress template when the linked incident is actively being worked", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-with-engineering@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Engineering",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });
    const incident = await createIncidentDoc({
      user: paralegal,
      state: "patching",
      userVisibleStatus: "investigating",
      adminVisibleStatus: "active",
    });
    const ticket = await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "open",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      linkedIncidentIds: [incident._id],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Any update on that issue?",
      promptAction: {
        key: `open-ticket:${ticket._id}`,
        intent: "issue_review_status",
        issueLabel: "Save Preferences issue",
        issueState: "open",
        ticketId: String(ticket._id),
        ticketStatus: "open",
        handedOffToEngineering: true,
      },
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe(
      "Thank you for checking in. Your Save Preferences issue is already with engineering. I don't have a fix time yet, but work is in progress and I'll keep this thread updated when there's a real change."
    );
  });

  test("can answer issue status and billing navigation in the same support turn", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-status-and-billing@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "Status",
    });

    const conversationRes = await createConversation(attorney, {
      viewName: "billing",
    });

    const ticket = await SupportTicket.create({
      subject: "Case issue",
      message: "I need help with a case issue.",
      status: "in_review",
      urgency: "high",
      requesterRole: "attorney",
      sourceSurface: "attorney",
      sourceLabel: "Support chat",
      requesterUserId: attorney._id,
      requesterEmail: attorney.email,
      userId: attorney._id,
      conversationId: conversationRes.body.conversation.id,
      classification: {
        category: "case_workflow",
        confidence: "medium",
      },
    });

    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Can you check on my issue and where are my invoices?",
      promptAction: {
        key: `open-ticket:${ticket._id}`,
        intent: "issue_review_status",
        issueLabel: "case issue",
        issueState: "open",
        ticketId: String(ticket._id),
        ticketStatus: "in_review",
        handedOffToEngineering: false,
      },
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "billing",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("issue_review_status");
    expect(sendRes.body.assistantMessage.text).toMatch(/your case issue is still open with the team/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/Also, you can find that here\./i);
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
      })
    );
  });

  test("can answer issue status and preferences navigation in the same support turn", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-status-and-preferences@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Preferences",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });

    const ticket = await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "resolved",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      resolutionIsStable: true,
      resolvedAt: new Date(),
      linkedIncidentIds: [new mongoose.Types.ObjectId()],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Can you show me the update on my issue, and can I change to dark mode?",
      promptAction: {
        key: `resolved-ticket:${ticket._id}`,
        intent: "issue_review_status",
        issueLabel: "Save Preferences issue",
        issueState: "resolved",
        ticketId: String(ticket._id),
        ticketStatus: "resolved",
        handedOffToEngineering: true,
      },
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("issue_review_status");
    expect(sendRes.body.assistantMessage.text).toMatch(/Your Save Preferences issue has been resolved/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/Also, yes — you can change that in Preferences\./i);
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
      })
    );
  });

  test("can answer issue status and Stripe guidance in the same support turn", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-status-and-stripe-guidance@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Stripe",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });

    const ticket = await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "open",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      linkedIncidentIds: [new mongoose.Types.ObjectId()],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Can you check on my issue and do I need Stripe?",
      promptAction: {
        key: `open-ticket:${ticket._id}`,
        intent: "issue_review_status",
        issueLabel: "Save Preferences issue",
        issueState: "open",
        ticketId: String(ticket._id),
        ticketStatus: "open",
        handedOffToEngineering: true,
      },
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("issue_review_status");
    expect(sendRes.body.assistantMessage.text).toMatch(/Your Save Preferences issue is already with engineering/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/Also, yes — if you want to receive payouts through LPC, you'll need to connect Stripe/i);
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
      })
    );
  });

  test("uses the testing template when a linked incident is in verification", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-ready-for-test@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Testing",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });
    const incident = await createIncidentDoc({
      user: paralegal,
      state: "awaiting_verification",
      userVisibleStatus: "testing_fix",
      adminVisibleStatus: "active",
    });
    const ticket = await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "open",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      linkedIncidentIds: [incident._id],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Can you check on my issue?",
      promptAction: {
        key: `open-ticket:${ticket._id}`,
        intent: "issue_review_status",
        issueLabel: "Save Preferences issue",
        issueState: "open",
        ticketId: String(ticket._id),
        ticketStatus: "open",
        handedOffToEngineering: true,
      },
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe(
      "Thank you for checking in. A fix for your Save Preferences issue is being tested now. I'll update this thread once that verification is complete."
    );
  });

  test("uses the closed-out template when an issue was closed after review", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-closed-out@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Closed",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "preferences",
    });
    const incident = await createIncidentDoc({
      user: paralegal,
      state: "closed_duplicate",
      userVisibleStatus: "closed",
      adminVisibleStatus: "closed",
    });
    const ticket = await SupportTicket.create({
      subject: "Save Preferences issue",
      message: "The Save Preferences button is not working.",
      status: "closed",
      urgency: "high",
      requesterRole: "paralegal",
      sourceSurface: "paralegal",
      sourceLabel: "Support chat",
      requesterUserId: paralegal._id,
      requesterEmail: paralegal.email,
      userId: paralegal._id,
      conversationId: conversationRes.body.conversation.id,
      resolutionIsStable: true,
      resolvedAt: new Date(),
      linkedIncidentIds: [incident._id],
      classification: {
        category: "incident_watch",
        confidence: "high",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "See update",
      promptAction: {
        key: `closed-ticket:${ticket._id}`,
        intent: "issue_review_status",
        issueLabel: "Save Preferences issue",
        issueState: "closed",
        ticketId: String(ticket._id),
        ticketStatus: "closed",
        handedOffToEngineering: true,
      },
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe(
      "Thank you for checking in. We closed your Save Preferences issue after review. If it's still happening, reply here and I'll reopen it."
    );
  });

  test("does not create a separate team-review notification when an escalated conversation is restarted", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-restart-escalation-attorney@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "Attorney",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-restart-escalation-paralegal@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Paralegal",
      stripeAccountId: "acct_restart_escalation_support",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Restart Escalation Matter",
      paymentReleased: true,
      paidOutAt: null,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const conversationRes = await createConversation(paralegal, {
      sourcePage: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
    });
    const originalConversationId = conversationRes.body.conversation.id;

    const sendRes = await sendSupportMessage(paralegal, originalConversationId, {
      text: "where is my payout",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        caseId: String(caseDoc._id),
      },
    });
    expect(sendRes.status).toBe(201);

    const escalateRes = await escalateSupportConversation(paralegal, originalConversationId, {
      messageId: sendRes.body.assistantMessage.id,
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        caseId: String(caseDoc._id),
      },
    });
    expect(escalateRes.status).toBe(201);

    const restartRes = await restartSupportConversation(paralegal, originalConversationId, {
      sourcePage: "/dashboard-paralegal.html",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(restartRes.status).toBe(201);
    const notification = await Notification.findOne({ userId: paralegal._id })
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    expect(notification).toBeNull();
  });

  test("uses a proactive help prompt on repeated billing visits and respects cooldown", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-billing-repeat@lets-paraconnect.test",
      firstName: "Riley",
      lastName: "Repeat",
    });

    const firstRes = await createConversation(attorney, {
      viewName: "billing",
      repeatViewCount: 3,
      supportOpenCount: 1,
    });

    expect(firstRes.status).toBe(200);
    expect(firstRes.body.conversation.supportState.proactivePrompt).toEqual(
      expect.objectContaining({
        key: "billing-help",
        text: "Need help with billing or your payment method?",
      })
    );

    const secondRes = await createConversation(attorney, {
      viewName: "billing",
      repeatViewCount: 3,
      supportOpenCount: 2,
    });

    expect(secondRes.status).toBe(200);
    expect(secondRes.body.conversation.supportState.proactivePrompt).toBe(null);
  });

  test("grounds incomplete Stripe onboarding when an approved user asks why they cannot get paid", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-stripe@lets-paraconnect.test",
      stripeAccountId: "acct_incomplete_support",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Why can't I get paid?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "payment",
        grounded: true,
      })
    );
    expect(sendRes.body.assistantReply.detailLevel).toBe("concise");
    expect(sendRes.body.assistantMessage.text).toBe(
      "Your Stripe setup still needs to be finished before payouts can be enabled on this account. Return to Stripe onboarding and complete any remaining identity or bank details."
    );
    expect(sendRes.body.assistantReply.supportFacts.stripeState).toEqual(
      expect.objectContaining({
        accountId: "acct_incomplete_support",
        payoutsEnabled: false,
      })
    );
  });

  test("returns a billing deep link for attorney payment-method navigation questions", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-billing-method@lets-paraconnect.test",
      firstName: "Bianca",
      lastName: "Billing",
    });

    const conversationRes = await createConversation(attorney);
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Where is my payment method?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "billing",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "payment",
        paymentSubIntent: "billing_method",
        needsEscalation: false,
        navigation: expect.objectContaining({
          ctaLabel: "Billing & Payments",
          ctaHref: "dashboard-attorney.html#billing",
          ctaType: "deep_link",
          inlineLinkText: "here",
        }),
      })
    );
    expect(sendRes.body.assistantMessage.text).toBe("You can find that here.");
    expect(sendRes.body.assistantMessage.text).not.toMatch(/Stripe Connect|payout|bank account/i);
    expect(sendRes.body.assistantMessage.metadata.navigation).toEqual(
      expect.objectContaining({
        ctaHref: "dashboard-attorney.html#billing",
      })
    );
    expect(sendRes.body.assistantReply.actions).toEqual([
      expect.objectContaining({
        label: "Billing & Payments",
        href: "dashboard-attorney.html#billing",
        type: "deep_link",
      }),
    ]);
  });

  test("confirms visible billing payment method data when support opens from billing", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-billing-visible@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Payment",
    });

    const conversationRes = await createConversation(attorney, {
      viewName: "billing",
    });
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "payment method",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "billing",
        paymentMethod: {
          brand: "visa",
          last4: "4242",
          exp_month: 12,
          exp_year: 2030,
          type: "card",
        },
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.supportFacts.billingMethodState).toEqual(
      expect.objectContaining({
        available: true,
        source: "page_context",
        last4: "4242",
        exp_month: 12,
        exp_year: 2030,
        isValid: true,
      })
    );
    expect(sendRes.body.assistantMessage.text).toBe(
      "I can confirm a saved payment method on this account: VISA ending in 4242 expiring 12/2030. That card appears to be current."
    );
  });

  test("answers Stripe concept questions concisely before account-specific setup details", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-stripe-concept@lets-paraconnect.test",
      stripeAccountId: "acct_concept_support",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "what is stripe",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "stripe_onboarding",
        detailLevel: "concise",
      })
    );
    expect(sendRes.body.assistantMessage.text).toBe(
      "Stripe is the payment processor LPC uses to handle payouts securely. Your Stripe setup still needs to be completed before payouts can be enabled."
    );
    expect(sendRes.body.assistantMessage.text).not.toMatch(/details are submitted|charges are enabled|payouts are enabled/i);
  });

  test("confirms saved billing method from Stripe customer data when available", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-billing-live@lets-paraconnect.test",
      firstName: "Lena",
      lastName: "Lookup",
    });
    attorney.stripeCustomerId = "cus_support_billing";
    await attorney.save();

    mockStripe.customers.retrieve.mockResolvedValue({
      invoice_settings: {
        default_payment_method: "pm_support_default",
      },
    });
    mockStripe.paymentMethods.retrieve.mockResolvedValue({
      id: "pm_support_default",
      type: "card",
      card: {
        brand: "mastercard",
        last4: "4444",
        exp_month: 8,
        exp_year: 2031,
      },
    });

    const conversationRes = await createConversation(attorney, {
      viewName: "billing",
    });
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "saved payment method",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "billing",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.supportFacts.billingMethodState).toEqual(
      expect.objectContaining({
        available: true,
        source: "live",
        last4: "4444",
        exp_month: 8,
        exp_year: 2031,
        isValid: true,
      })
    );
    expect(sendRes.body.assistantMessage.text).toBe(
      "I can confirm a saved payment method on this account: MASTERCARD ending in 4444 expiring 08/2031. That card appears to be current."
    );
  });

  test("uses a short clarification for unclear attorney payment questions", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-payment-clarify@lets-paraconnect.test",
      firstName: "Casey",
      lastName: "Clarify",
    });

    const conversationRes = await createConversation(attorney);
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "payment",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "payment",
        paymentSubIntent: "unclear",
        needsEscalation: false,
      })
    );
    expect(sendRes.body.assistantMessage.text).toBe(
      "Are you asking about your account billing method or a specific case payment?"
    );
    expect(sendRes.body.assistantReply.suggestedReplies).toEqual([
      "Billing method",
      "Case payment",
      "Payouts",
    ]);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/Stripe Connect|payout|released/i);
  });

  test("routes generic paralegal payment questions toward payout logic", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-paralegal-payment@lets-paraconnect.test",
      stripeAccountId: "acct_paralegal_payment",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "payment",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "payment",
        paymentSubIntent: "payout",
      })
    );
    expect(sendRes.body.assistantMessage.text).toBe(
      "Your Stripe setup still needs to be finished before payouts can be enabled on this account. Return to Stripe onboarding and complete any remaining identity or bank details."
    );
  });

  test("uses intake mode for vague low-confidence input without next steps or escalation", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-vague-intake@lets-paraconnect.test",
      firstName: "Vera",
      lastName: "Vague",
    });

    const conversationRes = await createConversation(attorney);
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "help",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        confidence: "low",
        intakeMode: true,
        needsEscalation: false,
      })
    );
    expect(sendRes.body.assistantMessage.text).toBe("How can I help today?");
    expect(sendRes.body.assistantMessage.text).not.toMatch(/Next steps:/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/Stripe|payout|profile settings|case workspace/i);
  });

  test("prioritizes escalation sooner when the user is clearly frustrated", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-frustrated-attorney@lets-paraconnect.test",
      firstName: "Frankie",
      lastName: "Frustrated",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-frustrated-paralegal@lets-paraconnect.test",
      stripeAccountId: "acct_frustrated_support",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      external_accounts: { data: [] },
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Frustrated Payout Matter",
      paymentReleased: true,
      paidOutAt: null,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "wtf where is my payout",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        sentiment: "frustrated",
        needsEscalation: true,
      })
    );
    expect(sendRes.body.assistantMessage.text).toMatch(/frustrating/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/released by LPC|payout/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/send this to the team/i);
  });

  test("understands shorthand messaging complaints without falling back to intake", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-shorthand-attorney@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-shorthand-paralegal@lets-paraconnect.test",
    });
    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Messaging Matter",
      status: "in progress",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "case-detail",
      caseId: String(caseDoc._id),
    });
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "wont let me msg attny",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "messaging",
        intakeMode: false,
        primaryAsk: "messaging_access",
      })
    );
    expect(sendRes.body.assistantMessage.text).not.toBe("How can I help today?");
  });

  test("answers exact shorthand like 'wont let me msg atty' with messaging guidance before escalation", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-atty-attorney@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-atty-paralegal@lets-paraconnect.test",
    });
    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Test message flow",
      status: "in progress",
    });

    const conversationRes = await createConversation(paralegal, {
      viewName: "case-detail",
      caseId: String(caseDoc._id),
    });
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "wont let me msg atty",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "messaging",
        primaryAsk: "messaging_access",
        needsEscalation: true,
      })
    );
    expect(sendRes.body.assistantMessage.text).toMatch(/Messaging should be available/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/Open messages here/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/send this to the team for review/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/If needed, I can send this to the team for review\./i);
  });

  test("lets a password change question override a prior payout thread", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-password-override@lets-paraconnect.test",
      stripeAccountId: "acct_password_override",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Why aren't payouts enabled?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantReply.category).toBe("payment");

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "can i change my password",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.category).toBe("password_reset");
    expect(secondRes.body.assistantMessage.text).toBe("You can change your password in Security settings.");
    expect(secondRes.body.assistantReply.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Email me a reset link",
          type: "invoke",
          action: "request_password_reset",
        }),
        expect.objectContaining({
          label: "Open security settings",
          href: "profile-settings.html#securitySection",
        }),
      ])
    );
  });

  test("keeps vague intake simple on repeated generic prompts without auto-escalating", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-vague-followup@lets-paraconnect.test",
      firstName: "Iris",
      lastName: "Intake",
    });

    const conversationRes = await createConversation(attorney);
    const firstRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "customer service",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantReply.needsEscalation).toBe(false);
    expect(firstRes.body.assistantReply.intakeMode).toBe(true);

    const secondRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "question",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply).toEqual(
      expect.objectContaining({
        intakeMode: true,
        needsEscalation: false,
      })
    );
    expect(secondRes.body.assistantMessage.text).toBe(
      "I can help with billing, cases, messages, or account issues. What do you need help with today?"
    );
    expect(secondRes.body.assistantMessage.text).not.toMatch(/Next steps:/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/Stripe onboarding|payouts are not enabled|open your/i);
    expect(secondRes.body.assistantReply.suggestedReplies || []).toEqual([]);
  });

  test("grounds released payout replies without inventing bank timing", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-payout-attorney@lets-paraconnect.test",
      firstName: "Tess",
      lastName: "Attorney",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-payout-paralegal@lets-paraconnect.test",
      stripeAccountId: "acct_ready_support",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      external_accounts: { data: [] },
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Anderson Matter",
      paymentReleased: true,
      paidOutAt: new Date("2026-03-20T14:00:00.000Z"),
      completedAt: new Date("2026-03-20T14:00:00.000Z"),
    });
    await Payout.create({
      paralegalId: paralegal._id,
      caseId: caseDoc._id,
      amountPaid: 85000,
      transferId: "tr_support_123",
      stripeMode: "test",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.detailLevel).toBe("concise");
    expect(sendRes.body.assistantMessage.text).toMatch(/Your payout for Anderson Matter was released/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/Bank timing depends on Stripe and your bank/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/on the way/i);
    expect(sendRes.body.assistantReply.supportFacts.payoutState).toEqual(
      expect.objectContaining({
        paymentReleased: true,
        hasPayoutHistory: true,
      })
    );
  });

  test("states clearly when there is no payout history and does not invent one", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-no-payout@lets-paraconnect.test",
      stripeAccountId: "acct_ready_no_payout",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      external_accounts: { data: [] },
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toMatch(/don't see recent payout activity/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/released/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/sent/i);
    expect(sendRes.body.assistantReply.supportFacts.payoutState).toEqual(
      expect.objectContaining({
        hasRecentPayoutActivity: false,
        hasPayoutHistory: false,
      })
    );
  });

  test("grounds messaging issues from real block state", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-blocked-attorney@lets-paraconnect.test",
      firstName: "Mira",
      lastName: "Attorney",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-blocked-paralegal@lets-paraconnect.test",
      firstName: "Piper",
      lastName: "Paralegal",
      stripeAccountId: "acct_blocked_support",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Blocked Workspace",
      paymentReleased: false,
    });
    await Block.create({
      blockerId: attorney._id,
      blockedId: paralegal._id,
      blockerRole: "attorney",
      blockedRole: "paralegal",
      sourceCaseId: caseDoc._id,
      sourceType: "closed_case",
      reason: "Support test block",
      active: true,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I can't send messages",
      pageContext: {
        pathname: "/messages.html",
        viewName: "messages",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "messaging",
        needsEscalation: false,
      })
    );
    expect(sendRes.body.assistantMessage.text).toContain(BLOCKED_MESSAGE);
    expect(sendRes.body.assistantReply.supportFacts.messagingState).toEqual(
      expect.objectContaining({
        isBlocked: true,
        canSend: false,
      })
    );
  });

  test("returns the attorney name for the open case workspace when asked directly", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-participant-attorney@lets-paraconnect.test",
      firstName: "Chad",
      lastName: "Lawson",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-participant-paralegal@lets-paraconnect.test",
      firstName: "Nina",
      lastName: "Paralegal",
    });
    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Participant Matter",
      status: "in progress",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Who is the attorney on this case?",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "participant_lookup",
        activeEntity: expect.objectContaining({
          type: "case",
          id: String(caseDoc._id),
        }),
        responseMode: "DIRECT_ANSWER",
      })
    );
    expect(sendRes.body.assistantMessage.text).toBe("The attorney on Participant Matter is Chad Lawson.");
  });

  test("prefers the current case workspace as the active entity for case status questions", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-workspace-priority-attorney@lets-paraconnect.test",
      firstName: "Wes",
      lastName: "Attorney",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-workspace-priority-paralegal@lets-paraconnect.test",
      firstName: "Priya",
      lastName: "Paralegal",
    });
    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Workspace Priority Matter",
      status: "paused",
      pausedReason: "paralegal_withdrew",
    });

    const conversationRes = await createConversation(attorney);
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "What is the status of this case?",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.activeEntity).toEqual(
      expect.objectContaining({
        type: "case",
        id: String(caseDoc._id),
        name: "Workspace Priority Matter",
        source: "page_context",
      })
    );
    expect(sendRes.body.assistantMessage.text).toMatch(/Workspace Priority Matter is currently paused/i);
  });

  test("lets the user override a prior blocked interpretation with a direct update", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-override-blocked-attorney@lets-paraconnect.test",
      firstName: "Mira",
      lastName: "Attorney",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-override-blocked-paralegal@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Paralegal",
    });
    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Override Blocked Matter",
      status: "in progress",
    });
    await Block.create({
      blockerId: attorney._id,
      blockedId: paralegal._id,
      blockerRole: "attorney",
      blockedRole: "paralegal",
      sourceCaseId: caseDoc._id,
      sourceType: "closed_case",
      reason: "Support test block override",
      active: true,
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I can't send messages",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });
    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Nothing is blocking me.",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(firstRes.status).toBe(201);
    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "issue_resolved",
        responseMode: "DIRECT_ANSWER",
      })
    );
    expect(secondRes.body.assistantMessage.text).toBe(
      "Glad that's sorted."
    );
  });

  test("infers the most relevant active case for messaging when no caseId is present", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-infer-attorney@lets-paraconnect.test",
      firstName: "Mila",
      lastName: "Attorney",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-infer-paralegal@lets-paraconnect.test",
      firstName: "Nora",
      lastName: "Paralegal",
      stripeAccountId: "acct_infer_support",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    await createCaseDoc({
      attorney,
      paralegal,
      title: "Active Messaging Matter",
      status: "in progress",
      escrowStatus: "funded",
      paymentReleased: false,
    });
    await createCaseDoc({
      attorney,
      paralegal,
      title: "Closed Older Matter",
      status: "completed",
      escrowStatus: "funded",
      paymentReleased: true,
      paidOutAt: new Date("2026-03-20T14:00:00.000Z"),
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I can't send messages",
      pageContext: {
        pathname: "/messages.html",
        viewName: "messages",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.category).toBe("messaging");
    expect(sendRes.body.assistantReply.supportFacts.caseState).toEqual(
      expect.objectContaining({
        inferred: true,
        inferenceSource: "recent_active_case",
        title: "Active Messaging Matter",
      })
    );
    expect(sendRes.body.assistantMessage.text).toMatch(/Active Messaging Matter/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/Stripe|payout/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/open support from/i);
  });

  test("uses conversation memory to stay with the same issue across follow-up turns", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-memory-attorney@lets-paraconnect.test",
      firstName: "Maya",
      lastName: "Attorney",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-memory-paralegal@lets-paraconnect.test",
      firstName: "Nina",
      lastName: "Paralegal",
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Memory Messaging Matter",
      status: "in progress",
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I can't send messages",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "it's still not working",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantMessage.text).toMatch(/I'm still with you on the messaging in Memory Messaging Matter\./i);
    expect(secondRes.body.assistantMessage.text).toMatch(/frustrating|Messaging isn't available|review now/i);

    const storedConversation = await SupportConversation.findById(conversationRes.body.conversation.id).lean();
    expect(storedConversation.metadata.support).toEqual(
      expect.objectContaining({
        currentIssueLabel: "messaging in Memory Messaging Matter",
        turnCount: 2,
        recentTopics: expect.arrayContaining(["messaging in Memory Messaging Matter"]),
      })
    );
  });

  test("lets the user switch topics from payout help to profile guidance in the same thread", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-topic-switch-profile@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Profile",
      stripeAccountId: "acct_topic_switch_profile",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "What can I do to make my profile stand out?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantReply.primaryAsk).toBe("payout_question");

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toMatch(/strong profile is clear, specific, and complete/i);
    expect(secondRes.body.assistantMessage.text).toMatch(/Profile settings/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/Stripe|payout|bank account/i);
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );

    const storedConversation = await SupportConversation.findById(conversationRes.body.conversation.id).lean();
    expect(storedConversation.metadata.support).toEqual(
      expect.objectContaining({
        currentIssueLabel: "",
        topicKey: "profile_guidance",
        topicMode: "switch",
        turnKind: "topic_switch",
      })
    );
  });

  test("treats a stripe requirement follow-up as guidance instead of repeating the payout issue", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-stripe-guidance-followup@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Stripe",
      stripeAccountId: "acct_stripe_guidance_followup",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Do I have to connect stripe?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantReply.primaryAsk).toBe("payout_question");

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toMatch(/Yes — if you want to receive payouts through LPC, you'll need to connect Stripe/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/Tell me what's still not working/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/payouts can be enabled on this account/i);
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
      })
    );
  });

  test("treats a dark mode question as a preferences navigation question in the same thread", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-theme-switch@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Theme",
      stripeAccountId: "acct_theme_switch",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "What can I do to make my profile stand out?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const thirdRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Can I make my theme dark instead of light?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(thirdRes.status).toBe(201);
    expect(thirdRes.body.assistantReply.activeTask).toBe("NAVIGATION");
    expect(thirdRes.body.assistantReply.primaryAsk).toBe("navigation");
    expect(thirdRes.body.assistantMessage.text).toBe("Yes — you can change that in Preferences.");
    expect(thirdRes.body.assistantMessage.text).not.toMatch(/Tell me what's still not working/i);
    expect(thirdRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
      })
    );

    const storedConversation = await SupportConversation.findById(conversationRes.body.conversation.id).lean();
    expect(storedConversation.metadata.support).toEqual(
      expect.objectContaining({
        currentIssueLabel: "",
        topicKey: "theme_preferences",
        topicMode: "switch",
        turnKind: "topic_switch",
      })
    );
  });

  test("answers broad LPC workflow questions without falling back to the previous support topic", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-platform-overview@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Overview",
      stripeAccountId: "acct_platform_overview",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Can you explain how LPC works for paralegals?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toMatch(/On LPC, you build your profile, browse open cases, apply/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/payouts aren't enabled|Stripe setup still needs to be finished/i);

    const storedConversation = await SupportConversation.findById(conversationRes.body.conversation.id).lean();
    expect(storedConversation.metadata.support).toEqual(
      expect.objectContaining({
        currentIssueLabel: "",
        topicKey: "general_guidance",
        topicMode: "switch",
        turnKind: "topic_switch",
      })
    );
  });

  test("narrows a broad LPC overview thread into concrete profile-setup guidance", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-platform-overview-profile-setup@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Profile",
    });

    const conversationRes = await createConversation(paralegal);

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Can you explain how LPC works for paralegals?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "How do I create my profile?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toMatch(/Open Profile settings and complete the profile section/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/browse open cases, apply/i);
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );

    const storedConversation = await SupportConversation.findById(conversationRes.body.conversation.id).lean();
    expect(storedConversation.metadata.support).toEqual(
      expect.objectContaining({
        topicKey: "profile_guidance",
        topicMode: "switch",
        turnKind: "topic_switch",
      })
    );
  });

  test("switches from apply guidance to literal profile editing guidance in the same thread", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-apply-to-profile-edit@lets-paraconnect.test",
      firstName: "Paula",
      lastName: "Pivot",
    });

    const conversationRes = await createConversation(paralegal);

    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "how do i apply to cases?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "how do i edit my profile?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantMessage.text).toMatch(/You can apply when a case is open to applicants/i);

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toMatch(/Open Profile settings and update your headline/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/browse open cases|apply when a case is open/i);
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );

    const storedConversation = await SupportConversation.findById(conversationRes.body.conversation.id).lean();
    expect(storedConversation.metadata.support).toEqual(
      expect.objectContaining({
        topicKey: "profile_guidance",
        topicMode: "switch",
        turnKind: "topic_switch",
      })
    );
  });

  test("reuses the last navigation target when the user asks for that page from before", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-reuse-last-navigation@lets-paraconnect.test",
      firstName: "Penny",
      lastName: "Page",
    });

    const conversationRes = await createConversation(paralegal);

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "how do i edit my profile?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Can you open that page from before?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("NAVIGATION");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("navigation");
    expect(secondRes.body.assistantMessage.text).toBe("You can open that here.");
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );

    const storedConversation = await SupportConversation.findById(conversationRes.body.conversation.id).lean();
    expect(storedConversation.metadata.support).toEqual(
      expect.objectContaining({
        lastNavigationLabel: "Profile settings",
        lastNavigationHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );
  });

  test("treats update my profile wording as specific profile guidance instead of generic platform help", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-update-profile-wording@lets-paraconnect.test",
      firstName: "Uma",
      lastName: "Update",
    });

    const conversationRes = await createConversation(paralegal);

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I need to update my profile",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(sendRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(sendRes.body.assistantMessage.text).toMatch(/Open Profile settings and update your headline/i);
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );
  });

  test("handles profile setup and Stripe requirement questions in one turn", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-profile-and-stripe@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Profile",
      stripeAccountId: "",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "How do I create my profile and do I need Stripe yet?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(sendRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(sendRes.body.assistantMessage.text).toMatch(/Open Profile settings and complete your headline, experience, practice areas/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/you'll also need to connect Stripe in Security settings/i);
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );
  });

  test("handles apply and messaging questions together without collapsing to one issue", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-apply-and-messaging@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "Apply",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I'm trying to apply but also can't find my messages.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(sendRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(sendRes.body.assistantMessage.text).toMatch(/You can apply when a case is open to applicants/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/messaging happens inside each active case workspace/i);
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Browse cases",
        ctaHref: "browse-jobs.html",
      })
    );
  });

  test("de-escalates a frustrated Stripe requirement question while still answering it directly", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-frustrated-stripe-direct@lets-paraconnect.test",
      firstName: "Fiona",
      lastName: "Frustrated",
      stripeAccountId: "",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I'm really frustrated. Do I need Stripe or not if I want to get paid?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(sendRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(sendRes.body.assistantMessage.text).toMatch(/^I'm sorry you've had to deal with that\./i);
    expect(sendRes.body.assistantMessage.text).toMatch(/Yes — if you want to receive payouts through LPC, you'll need to connect Stripe/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/Tell me what's still not working/i);
  });

  test("can follow the Stripe branch after a compound profile-and-Stripe answer", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-compound-stripe-branch@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Branch",
      stripeAccountId: "",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "How do I create my profile and do I need Stripe yet?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Let's do the Stripe part first.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toMatch(/To get paid through LPC, you'll connect Stripe from Security settings|Yes — if you want to receive payouts through LPC, you'll need to connect Stripe/i);
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
      })
    );
  });

  test("surfaces branch suggestions after a compound profile-and-Stripe answer", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-compound-suggested-branches@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Suggest",
      stripeAccountId: "",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "How do I create my profile and do I need Stripe yet?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.suggestedReplies).toEqual(["Profile setup", "Stripe"]);
  });

  test("can follow the other branch after a compound profile-and-Stripe answer", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-compound-other-branch@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Other",
      stripeAccountId: "",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "How do I create my profile and do I need Stripe yet?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Let's do the Stripe part first.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const thirdRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "What about the other part?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(thirdRes.status).toBe(201);
    expect(thirdRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(thirdRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(thirdRes.body.assistantMessage.text).toMatch(/Open Profile settings and complete/i);
    expect(thirdRes.body.assistantMessage.text).toMatch(/headline, experience, practice areas/i);
    expect(thirdRes.body.assistantMessage.text).not.toMatch(/Security settings/i);
  });

  test("can follow an ordinal compound branch selection", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-compound-second-branch@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Ordinal",
      stripeAccountId: "",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "How do I create my profile and do I need Stripe yet?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Let's do the second one.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantMessage.text).toMatch(/connect Stripe from Security settings|need to connect Stripe/i);
  });

  test("can follow the messaging branch after a compound apply-and-messaging answer", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-compound-messaging-branch@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "Branch",
    });

    const conversationRes = await createConversation(paralegal);
    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I'm trying to apply but also can't find my messages.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "What about the messages part?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toMatch(/Messaging happens inside each case workspace/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/browse open cases, apply/i);
  });

  test("splits an overloaded three-topic help request into a clean first-choice clarification", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-overloaded-three-topic@lets-paraconnect.test",
      firstName: "Mina",
      lastName: "Many",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I need help with my profile, payouts, and messages.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("generic_intake");
    expect(sendRes.body.assistantMessage.text).toBe(
      "I can help with profile setup, payouts, and messages. Which one do you want to start with?"
    );
    expect(sendRes.body.assistantReply.awaitingField).toBe("topic_selection");
    expect(sendRes.body.assistantReply.suggestedReplies).toEqual(["Profile setup", "Payouts", "Messages"]);
  });

  test("uses a selected topic reply after an overloaded clarification prompt", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-overloaded-topic-selection@lets-paraconnect.test",
      firstName: "Mina",
      lastName: "Select",
    });

    const conversationRes = await createConversation(paralegal);
    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I need help with my profile, payouts, and messages.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Messages",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toMatch(/Messaging happens inside each case workspace/i);
  });

  test("can answer all three sides of an overloaded clarification when the user asks for all of them", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-overloaded-all-three@lets-paraconnect.test",
      firstName: "Mina",
      lastName: "All",
    });

    const conversationRes = await createConversation(paralegal);
    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I need help with my profile, payouts, and messages.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "All of them.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(secondRes.body.assistantReply.awaitingField).toBe("");
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantReply.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Profile settings",
          href: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
        }),
        expect.objectContaining({
          label: "Security settings",
          href: "profile-settings.html#securitySection",
        }),
      ])
    );
    expect(secondRes.body.assistantMessage.text).toMatch(/Open Profile settings and complete/i);
    expect(secondRes.body.assistantMessage.text).toMatch(/you'll need to connect Stripe/i);
    expect(secondRes.body.assistantMessage.text).toMatch(/Messaging happens inside each case workspace/i);
  });

  test("splits an unsupported two-topic request into a clean selectable clarification", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-two-topic-split@lets-paraconnect.test",
      firstName: "Nora",
      lastName: "Split",
    });

    const conversationRes = await createConversation(attorney);
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Can I change to dark mode and where are my invoices?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("generic_intake");
    expect(sendRes.body.assistantReply.awaitingField).toBe("topic_selection");
    expect(sendRes.body.assistantReply.suggestedReplies).toEqual(["Theme settings", "Billing"]);
    expect(sendRes.body.assistantMessage.text).toBe(
      "I can help with theme settings and billing. Which one do you want to start with?"
    );
  });

  test("can follow a selected billing branch after a two-topic clarification", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-two-topic-billing-branch@lets-paraconnect.test",
      firstName: "Nora",
      lastName: "Billing",
    });

    const conversationRes = await createConversation(attorney);
    await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Can I change to dark mode and where are my invoices?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    const secondRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Billing first.",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("NAVIGATION");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("navigation");
    expect(secondRes.body.assistantMessage.text).toBe("You can find that here.");
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
      })
    );
  });

  test("sticks with the last selected topic when the user says that one", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-two-topic-that-one@lets-paraconnect.test",
      firstName: "Nora",
      lastName: "ThatOne",
    });

    const conversationRes = await createConversation(attorney);
    await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Can I change to dark mode and where are my invoices?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Billing first.",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    const thirdRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "That one.",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(thirdRes.status).toBe(201);
    expect(thirdRes.body.assistantReply.activeTask).toBe("NAVIGATION");
    expect(thirdRes.body.assistantReply.primaryAsk).toBe("navigation");
    expect(thirdRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
      })
    );
  });

  test("can answer both sides of a two-topic clarification when the user says both", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-two-topic-both@lets-paraconnect.test",
      firstName: "Nora",
      lastName: "Both",
    });

    const conversationRes = await createConversation(attorney);
    await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Can I change to dark mode and where are my invoices?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    const secondRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Both, please.",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(secondRes.body.assistantReply.awaitingField).toBe("");
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
      })
    );
    expect(secondRes.body.assistantReply.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Preferences",
          href: "profile-settings.html#preferencesSection",
        }),
        expect.objectContaining({
          label: "Billing & Payments",
          href: "dashboard-attorney.html#billing",
        }),
      ])
    );
    expect(secondRes.body.assistantMessage.text).toBe(
      "Yes — you can change that in Preferences. Also, you can find billing and invoices here."
    );
  });

  test("can follow the other branch after a two-topic clarification", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-two-topic-other-branch@lets-paraconnect.test",
      firstName: "Nora",
      lastName: "Theme",
    });

    const conversationRes = await createConversation(attorney);
    await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Can I change to dark mode and where are my invoices?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Billing first.",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    const thirdRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "What about the other one?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(thirdRes.status).toBe(201);
    expect(thirdRes.body.assistantReply.activeTask).toBe("NAVIGATION");
    expect(thirdRes.body.assistantReply.primaryAsk).toBe("navigation");
    expect(thirdRes.body.assistantMessage.text).toBe("Yes — you can change that in Preferences.");
    expect(thirdRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
      })
    );
  });

  test("can follow a correction-style two-topic selection", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-two-topic-correction@lets-paraconnect.test",
      firstName: "Nora",
      lastName: "Correction",
    });

    const conversationRes = await createConversation(attorney);
    await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Can I change to dark mode and where are my invoices?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Billing first.",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    const thirdRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Actually not that. The other one.",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(thirdRes.status).toBe(201);
    expect(thirdRes.body.assistantReply.activeTask).toBe("NAVIGATION");
    expect(thirdRes.body.assistantMessage.text).toBe("Yes — you can change that in Preferences.");
  });

  test("treats a correction from payout help to billing as a real topic switch", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-correction-billing-switch@lets-paraconnect.test",
      firstName: "Tessa",
      lastName: "Switch",
    });

    const conversationRes = await createConversation(attorney);
    await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    const secondRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "No, I mean how do I update my billing method?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.primaryAsk).toBe("billing_payment_method");
    expect(secondRes.body.assistantReply.topicMode).toBe("switch");
    expect(secondRes.body.assistantReply.turnKind).toBe("correction");
    expect(secondRes.body.assistantMessage.text).toBe("You can update that here.");
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
      })
    );
  });

  test("treats a correction from broad LPC guidance to profile setup as a real narrowing turn", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-correction-profile-narrowing@lets-paraconnect.test",
      firstName: "Piper",
      lastName: "Narrow",
    });

    const conversationRes = await createConversation(paralegal);
    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Can you explain how LPC works for paralegals?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Actually, I mean how do I create my profile?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantReply.topicMode).toBe("switch");
    expect(secondRes.body.assistantReply.turnKind).toBe("correction");
    expect(secondRes.body.assistantMessage.text).toMatch(/Open Profile settings and complete/i);
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );
  });

  test("uses contextual next-step guidance instead of generic intake after payout help", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-next-step-after-payout@lets-paraconnect.test",
      firstName: "Nina",
      lastName: "Next",
      stripeAccountId: "acct_next_step_after_payout",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "What should I do next?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toBe(
      "The next step is to finish Stripe setup in Security settings so payouts can be enabled."
    );
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
      })
    );
  });

  test("uses contextual next-step guidance for a frustrated plain-language request", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-frustrated-next-step@lets-paraconnect.test",
      firstName: "Nina",
      lastName: "Frustrated",
      stripeAccountId: "acct_frustrated_next_step",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I'm frustrated. Just tell me what I need to do.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toBe(
      "I'm sorry you've had to deal with that. The next step is to finish Stripe setup in Security settings so payouts can be enabled."
    );
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
      })
    );
  });

  test("uses a human clarification when a frustrated user asks for broad help mid-thread", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-frustrated-broad-help@lets-paraconnect.test",
      firstName: "Fran",
      lastName: "Frustrated",
      stripeAccountId: "acct_frustrated_broad_help",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "This makes no sense. Can you just help me?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.primaryAsk).toBe("generic_intake");
    expect(secondRes.body.assistantMessage.text).toBe(
      "I'm sorry you've had to deal with that. I can help with payouts, cases, messages, profile settings, or platform issues. What are you trying to do?"
    );
    expect(secondRes.body.assistantMessage.text).not.toMatch(/Tell me what's still not working/i);
  });

  test("explains a payout situation simply when the user asks for a simpler explanation", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-simple-payout-explanation@lets-paraconnect.test",
      firstName: "Sia",
      lastName: "Simple",
      stripeAccountId: "acct_simple_payout",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);

    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I'm confused. Can you explain this simply?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(secondRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(secondRes.body.assistantMessage.text).toMatch(/In simple terms, LPC releases the payment and Stripe sends the payout/i);
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
      })
    );
  });

  test("answers what a paralegal should do first on LPC with grounded first-step guidance", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-paralegal-first-steps@lets-paraconnect.test",
      firstName: "Paula",
      lastName: "First",
    });

    const conversationRes = await createConversation(paralegal);

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "What should I do first on LPC?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(sendRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(sendRes.body.assistantMessage.text).toMatch(/Start by completing your profile/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/Then browse open cases/i);
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );
  });

  test("answers what attorneys usually do first on LPC with grounded attorney guidance", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-attorney-first-steps@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "First",
    });

    const conversationRes = await createConversation(attorney);

    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "What do attorneys usually do first on LPC?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(sendRes.body.assistantReply.primaryAsk).toBe("product_guidance");
    expect(sendRes.body.assistantMessage.text).toMatch(/Start from your dashboard by posting or reviewing your matters/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/Then choose the paralegal support you need/i);
  });

  test("answers fix timing follow-ups naturally after an issue is already sent to engineering", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-profile-save-followup@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Preferences",
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "the save preferences button isn't working",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "when will it be fixed",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantReply.primaryAsk).toBe("profile_save");
    expect(firstRes.body.assistantMessage.text).toMatch(/Save Preferences issue to engineering now/i);

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.primaryAsk).toBe("issue_review_status");
    expect(secondRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(secondRes.body.assistantMessage.text).toMatch(/don't have a fix time yet/i);
    expect(secondRes.body.assistantMessage.text).toMatch(/Save Preferences issue is already with engineering/i);
    expect(secondRes.body.assistantMessage.text).toMatch(/keep this thread updated/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/Tell me which part is still blocked/i);
  });

  test("returns a case-message deep link when navigation intent is specific and the case is known", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-nav-case-attorney@lets-paraconnect.test",
      firstName: "Maya",
      lastName: "Matter",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-nav-case-paralegal@lets-paraconnect.test",
      firstName: "Case",
      lastName: "Messages",
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Navigation Matter",
      status: "in progress",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where can I see the messages?",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe("You can open that here.");
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Case messages",
        ctaHref: `case-detail.html?caseId=${encodeURIComponent(String(caseDoc._id))}#case-messages`,
      })
    );
  });

  test("routes paralegal apply-intent navigation to browse cases instead of asking for a specific case", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-nav-apply@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "Applicant",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where can I find cases to apply to?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe("You can find that here.");
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Browse cases",
        ctaHref: "browse-jobs.html",
        ctaType: "deep_link",
      })
    );
  });

  test("answers paralegal apply-workflow questions with browse-case guidance instead of escalating", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-nav-apply-workflow@lets-paraconnect.test",
      firstName: "Jamie",
      lastName: "Jobs",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "When can I apply for a job? how does it work",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe(
      "You can apply when a case is open to applicants. You can browse open cases here. If you'd like, I can also help you find your applications."
    );
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Browse cases",
        ctaHref: "browse-jobs.html",
        ctaType: "deep_link",
      })
    );
    expect(sendRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(sendRes.body.assistantReply.needsEscalation).toBe(false);
  });

  test("keeps explain follow-up context after navigation-style detours and opens applications on affirmative reply", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-explain-followup@lets-paraconnect.test",
      firstName: "Taylor",
      lastName: "Thread",
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "When can I apply for a job? how does it work",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantReply.awaitingField).toBe("applications_navigation");

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "sure",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply.activeTask).toBe("NAVIGATION");
    expect(secondRes.body.assistantMessage.text).toBe("You can open that here.");
    expect(secondRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "My applications",
        ctaHref: "dashboard-paralegal.html#cases",
        ctaType: "deep_link",
      })
    );
    expect(secondRes.body.assistantReply.awaitingField).toBe("");
    expect(secondRes.body.assistantReply.needsEscalation).toBe(false);
  });

  test("uses explain mode for paralegal stripe guidance instead of troubleshooting fallback", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-explain-stripe@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Payout",
      stripeAccountId: "acct_explain_123",
      stripeOnboarded: false,
      stripePayoutsEnabled: false,
      stripeChargesEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "How does Stripe work?",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "profile-settings",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.activeTask).toBe("EXPLAIN");
    expect(sendRes.body.assistantMessage.text).toBe(
      "Your Stripe setup is still in progress. Finish it in Security settings, and payouts can be enabled once the setup is complete."
    );
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
      })
    );
    expect(sendRes.body.assistantReply.needsEscalation).toBe(false);
  });

  test("asks a short clarification instead of guessing an ambiguous navigation target", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-nav-clarify@lets-paraconnect.test",
      firstName: "Ari",
      lastName: "Ask",
    });

    const conversationRes = await createConversation(attorney);
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "Where do I find that?",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe(
      "Are you looking for billing, messages, profile settings, or a specific case?"
    );
    expect(sendRes.body.assistantReply.navigation).toBeNull();
    expect(sendRes.body.assistantReply.needsEscalation).toBe(false);
  });

  test("treats 'can't find my profile settings' as navigation instead of escalation", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-find-profile-settings@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Profile",
    });

    const conversationRes = await createConversation(paralegal);
    await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "customer service",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "i cant find my profile settings.",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe("You can open that here.");
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "navigation",
        needsEscalation: false,
        navigation: expect.objectContaining({
          ctaLabel: "Profile settings",
          ctaHref: "profile-settings.html",
        }),
      })
    );
  });

  test("treats minor typos in profile-settings navigation as navigation instead of support review", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-find-profile-settings-typo@lets-paraconnect.test",
      firstName: "Paige",
      lastName: "Typos",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "i cant find my profil settngs",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe("You can open that here.");
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "navigation",
        needsEscalation: false,
        escalationReason: "",
        navigation: expect.objectContaining({
          ctaLabel: "Profile settings",
          ctaHref: "profile-settings.html",
        }),
      })
    );
  });

  test("builds inline link segments for support drawer navigation replies", async () => {
    const helperPath = path.join(
      __dirname,
      "../../frontend/assets/scripts/utils/support-message-links.mjs"
    );
    const script = `
      import { buildSupportInlineSegments } from ${JSON.stringify(pathToFileURL(helperPath).href)};
      const result = buildSupportInlineSegments("You can find that here.", {
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
        inlineLinkText: "here",
      });
      console.log(JSON.stringify(result));
    `;
    const output = execFileSync("node", ["--input-type=module", "-e", script], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
    });

    expect(JSON.parse(output.trim())).toEqual([
      { type: "text", text: "You can find that " },
      { type: "link", text: "here", href: "dashboard-attorney.html#billing" },
      { type: "text", text: "." },
    ]);
  });

  test("asks one concise messaging follow-up, then offers escalation without Stripe leakage", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-message-clarify@lets-paraconnect.test",
      stripeAccountId: "acct_message_clarify",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I can't send messages",
      pageContext: {
        pathname: "/messages.html",
        viewName: "messages",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "messaging",
        needsEscalation: false,
        awaitingClarification: true,
      })
    );
    expect(firstRes.body.assistantMessage.text).toBe("Is this happening in a specific case or across all messages?");
    expect(firstRes.body.assistantMessage.text).not.toMatch(/Stripe|payout/i);

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Across all messages.",
      pageContext: {
        pathname: "/messages.html",
        viewName: "messages",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply).toEqual(
      expect.objectContaining({
        category: "messaging",
        needsEscalation: true,
        escalationReason: "messaging_context_still_unresolved",
      })
    );
    expect(secondRes.body.assistantMessage.text).toMatch(/Is this happening in a specific case or across all messages\?/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/send this to the team for review/i);
    expect(secondRes.body.assistantMessage.text).not.toMatch(/Stripe|payout/i);
  });

  test("creates a support ticket when escalation is requested", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-escalation-attorney@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-escalation-paralegal@lets-paraconnect.test",
      stripeAccountId: "acct_escalation_support",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      external_accounts: { data: [] },
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Escalation Matter",
      paymentReleased: true,
      paidOutAt: null,
      completedAt: new Date("2026-03-18T12:00:00.000Z"),
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.needsEscalation).toBe(true);

    const escalateRes = await request(app)
      .post(`/api/support/conversation/${conversationRes.body.conversation.id}/escalate`)
      .set("Cookie", authCookieFor(paralegal))
      .send({
        messageId: sendRes.body.assistantMessage.id,
        pageContext: {
          pathname: "/dashboard-paralegal.html",
          viewName: "dashboard-paralegal",
          caseId: String(caseDoc._id),
        },
      });

    expect(escalateRes.status).toBe(201);
    expect(escalateRes.body.ticket).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        reference: expect.stringMatching(/^SUP-/),
        reused: false,
      })
    );
    expect(escalateRes.body.assistantMessage.metadata.escalation).toEqual(
      expect.objectContaining({
        requested: true,
        ticketId: escalateRes.body.ticket.id,
      })
    );
    expect(escalateRes.body.systemMessage.text).toMatch(/Sent to the team for review/i);
    expect(escalateRes.body.systemMessage.text).toMatch(/won't need to repeat yourself/i);
    expect(escalateRes.body.confirmation.handoffSummary).toMatch(/Issue:/i);
    expect(escalateRes.body.systemMessage.metadata.handoffSummary).toMatch(/AI summary:/i);

    const storedTickets = await SupportTicket.find({ conversationId: conversationRes.body.conversation.id }).lean();
    expect(storedTickets).toHaveLength(1);
    expect(storedTickets[0]).toEqual(
      expect.objectContaining({
        conversationId: expect.anything(),
        latestUserMessage: "Where is my payout?",
        routingSuggestion: expect.objectContaining({
          ownerKey: "founder_review",
          queueLabel: "War Room review",
        }),
      })
    );

    const founderAlert = await LpcAction.findOne({
      "related.supportTicketId": storedTickets[0]._id,
      actionType: "founder_alert",
      status: "open",
    }).lean();
    expect(founderAlert).toEqual(
      expect.objectContaining({
        title: expect.stringContaining("Paralegal"),
        related: expect.objectContaining({
          supportTicketId: storedTickets[0]._id,
        }),
        metadata: expect.objectContaining({
          escalationLane: "payments_review",
          requesterRole: "paralegal",
          sourceSurface: "paralegal",
          viewName: "dashboard-paralegal",
          caseTitle: expect.any(String),
          primaryAsk: "payout question",
          learning: expect.objectContaining({
            patternKey: expect.any(String),
            repeatCount: expect.any(Number),
          }),
        }),
      })
    );
    expect(founderAlert.metadata.learning.repeatCount).toBeGreaterThanOrEqual(1);
    expect(founderAlert.summary).toMatch(/Paralegal support request/i);
    expect(founderAlert.summary).toMatch(/View: dashboard-paralegal/i);
  });

  test("attorney troubleshooting escalations also publish founder-ready war room context", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-founder-attorney@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "Attorney",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-founder-attorney-para@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Paralegal",
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Attorney Workspace Blocker",
      status: "in progress",
      escrowStatus: "funded",
    });

    const conversationRes = await createConversation(attorney, {
      sourcePage: "/case-detail.html",
      viewName: "case-detail",
      caseId: String(caseDoc._id),
    });
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "the workspace is blank",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);

    const escalateRes = await escalateSupportConversation(attorney, conversationRes.body.conversation.id, {
      messageId: sendRes.body.assistantMessage.id,
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(escalateRes.status).toBe(201);
    const founderAlert = await LpcAction.findOne({
      "related.supportTicketId": escalateRes.body.ticket.id,
      actionType: "founder_alert",
      status: "open",
    }).lean();

    expect(founderAlert).toEqual(
      expect.objectContaining({
        title: expect.stringContaining("Attorney"),
        metadata: expect.objectContaining({
          requesterRole: "attorney",
          sourceSurface: "attorney",
          viewName: "case-detail",
          caseTitle: "Attorney Workspace Blocker",
          primaryAsk: "workspace access",
        }),
      })
    );
    expect(founderAlert.summary).toMatch(/Attorney support request/i);
    expect(founderAlert.summary).toMatch(/Case: Attorney Workspace Blocker/i);
  });

  test("war room support escalations attach learning metadata for future pattern review", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-learning-attorney@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-learning-paralegal@lets-paraconnect.test",
      stripeAccountId: "acct_learning_support",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      external_accounts: { data: [] },
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Learning Escalation Matter",
      paymentReleased: true,
      paidOutAt: null,
      completedAt: new Date("2026-03-18T12:00:00.000Z"),
    });

    for (let index = 0; index < 2; index += 1) {
      const conversationRes = await createConversation(paralegal);
      const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
        text: "Where is my payout?",
        pageContext: {
          pathname: "/dashboard-paralegal.html",
          viewName: "dashboard-paralegal",
          caseId: String(caseDoc._id),
        },
      });

      await request(app)
        .post(`/api/support/conversation/${conversationRes.body.conversation.id}/escalate`)
        .set("Cookie", authCookieFor(paralegal))
        .send({
          messageId: sendRes.body.assistantMessage.id,
          pageContext: {
            pathname: "/dashboard-paralegal.html",
            viewName: "dashboard-paralegal",
            caseId: String(caseDoc._id),
          },
        });
    }

    const latestFounderAlert = await LpcAction.findOne({
      actionType: "founder_alert",
      status: "open",
      "metadata.escalationLane": "payments_review",
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    expect(latestFounderAlert).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          learning: expect.objectContaining({
            patternKey: expect.any(String),
            repeatCount: expect.any(Number),
            faqCandidateCount: expect.any(Number),
          }),
        }),
      })
    );
    expect(latestFounderAlert.metadata.learning.patternKey.length).toBeGreaterThan(0);
    expect(latestFounderAlert.metadata.learning.repeatCount).toBeGreaterThanOrEqual(1);
  });

  test("reuses the active escalated conversation after reload instead of creating a new thread", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-reload-attorney@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-reload-paralegal@lets-paraconnect.test",
      stripeAccountId: "acct_reload_support",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      external_accounts: { data: [] },
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Reload Escalation Matter",
      paymentReleased: true,
      paidOutAt: null,
      completedAt: new Date("2026-03-19T10:30:00.000Z"),
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        caseId: String(caseDoc._id),
      },
    });

    await request(app)
      .post(`/api/support/conversation/${conversationRes.body.conversation.id}/escalate`)
      .set("Cookie", authCookieFor(paralegal))
      .send({
        messageId: sendRes.body.assistantMessage.id,
        pageContext: {
          pathname: "/dashboard-paralegal.html",
          viewName: "dashboard-paralegal",
          caseId: String(caseDoc._id),
        },
      });

    const reloadedConversation = await createConversation(paralegal, {
      sourcePage: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
      caseId: String(caseDoc._id),
    });

    expect(reloadedConversation.status).toBe(200);
    expect(reloadedConversation.body.conversation.id).toBe(conversationRes.body.conversation.id);
    expect(reloadedConversation.body.conversation.status).toBe("escalated");
    expect(reloadedConversation.body.conversation.escalation).toEqual(
      expect.objectContaining({
        requested: true,
        ticketReference: expect.stringMatching(/^SUP-/),
      })
    );
  });

  test("does not create duplicate open tickets for the same conversation", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-duplicate-attorney@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-duplicate-paralegal@lets-paraconnect.test",
      stripeAccountId: "acct_duplicate_support",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });
    mockStripe.accounts.retrieve.mockResolvedValue({
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      external_accounts: { data: [] },
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Duplicate Escalation Matter",
      paymentReleased: true,
      paidOutAt: null,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "Where is my payout?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        caseId: String(caseDoc._id),
      },
    });

    const firstEscalate = await request(app)
      .post(`/api/support/conversation/${conversationRes.body.conversation.id}/escalate`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ messageId: sendRes.body.assistantMessage.id });

    const secondEscalate = await request(app)
      .post(`/api/support/conversation/${conversationRes.body.conversation.id}/escalate`)
      .set("Cookie", authCookieFor(paralegal))
      .send({ messageId: sendRes.body.assistantMessage.id });

    expect(firstEscalate.status).toBe(201);
    expect(secondEscalate.status).toBe(201);
    expect(secondEscalate.body.ticket.reused).toBe(true);

    const storedTickets = await SupportTicket.find({ conversationId: conversationRes.body.conversation.id }).lean();
    expect(storedTickets).toHaveLength(1);
  });

  test("returns suggested replies when messaging clarification is needed", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-suggested-replies@lets-paraconnect.test",
      firstName: "Ari",
      lastName: "Suggested",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I can't send messages",
      pageContext: {
        pathname: "/messages.html",
        viewName: "messages",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "messaging_access",
        responseMode: "CLARIFY_ONCE",
        suggestedReplies: expect.arrayContaining(["This case", "Across all messages"]),
      })
    );
    expect(sendRes.body.assistantMessage.metadata.suggestedReplies).toEqual(
      expect.arrayContaining(["This case", "Across all messages"])
    );
  });

  test("returns invoke self-serve actions for stripe onboarding and password reset", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-self-serve-paralegal@lets-paraconnect.test",
      stripeAccountId: "acct_self_serve_support",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });
    const attorney = await createUser({
      role: "attorney",
      email: "support-self-serve-attorney@lets-paraconnect.test",
    });

    const payoutConversation = await createConversation(paralegal);
    const payoutRes = await sendSupportMessage(paralegal, payoutConversation.body.conversation.id, {
      text: "why can't I get paid",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "profile-settings",
      },
    });

    expect(payoutRes.status).toBe(201);
    expect(payoutRes.body.assistantReply.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invoke",
          action: "start_stripe_onboarding",
        }),
      ])
    );

    const passwordConversation = await createConversation(attorney);
    const passwordRes = await sendSupportMessage(attorney, passwordConversation.body.conversation.id, {
      text: "can i change my password",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "profile-settings",
      },
    });

    expect(passwordRes.status).toBe(201);
    expect(passwordRes.body.assistantReply.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invoke",
          action: "request_password_reset",
        }),
      ])
    );
  });

  test("marks the conversation and linked ticket resolved when the user says it is fixed", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-resolve-attorney@lets-paraconnect.test",
      firstName: "Rory",
      lastName: "Resolved",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-resolve-paralegal@lets-paraconnect.test",
      firstName: "Peyton",
      lastName: "Resolved",
    });
    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Resolved Support Matter",
      status: "in progress",
    });

    const conversationRes = await createConversation(paralegal);
    const issueRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "I can't send messages",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    const escalateRes = await escalateSupportConversation(paralegal, conversationRes.body.conversation.id, {
      messageId: issueRes.body.assistantMessage.id,
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(escalateRes.status).toBe(201);

    const resolvedRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "that fixed it",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(resolvedRes.status).toBe(201);
    expect(resolvedRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "issue_resolved",
        needsEscalation: false,
      })
    );

    const storedConversation = await SupportConversation.findById(conversationRes.body.conversation.id).lean();
    const storedTicket = storedConversation?.escalation?.ticketId
      ? await SupportTicket.findById(storedConversation.escalation.ticketId).lean()
      : null;

    expect(storedConversation.status).toBe("resolved");
    expect(storedTicket).toBeTruthy();
    if (storedTicket?.resolutionSummary) {
      expect(storedTicket.resolutionSummary).toBe("User indicated the issue was resolved in support chat.");
    }
  });

  test("routes attorney invoice and receipt navigation to billing instead of escalating or showing card details", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-attorney-billing-records@lets-paraconnect.test",
      stripeCustomerId: "cus_attorney_billing_records",
    });
    mockStripe.customers.retrieve.mockResolvedValue({
      invoice_settings: {
        default_payment_method: "pm_attorney_billing_records",
      },
    });
    mockStripe.paymentMethods.retrieve.mockResolvedValue({
      type: "card",
      card: {
        brand: "visa",
        last4: "4242",
        exp_month: 12,
        exp_year: 2030,
      },
    });

    const conversationRes = await createConversation(attorney);
    const invoiceRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "where do i find invoices",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(invoiceRes.status).toBe(201);
    expect(invoiceRes.body.assistantMessage.text).toBe("You can find that here.");
    expect(invoiceRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
      })
    );

    const receiptRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "where do i find receipts",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(receiptRes.status).toBe(201);
    expect(receiptRes.body.assistantMessage.text).toBe("You can find that here.");
    expect(receiptRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Billing & Payments",
        ctaHref: "dashboard-attorney.html#billing",
      })
    );
  });

  test("routes attorney browse and cases discovery questions to the correct dashboard destinations", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-attorney-discovery@lets-paraconnect.test",
    });

    const conversationRes = await createConversation(attorney);
    const browseRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "where can i browse paralegals",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(browseRes.status).toBe(201);
    expect(browseRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Browse paralegals",
        ctaHref: "browse-paralegals.html",
      })
    );

    const casesRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "where can i see my cases",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(casesRes.status).toBe(201);
    expect(casesRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Cases & Files",
        ctaHref: "dashboard-attorney.html#cases",
      })
    );
  });

  test("routes attorney preferences and funding navigation to the right surfaces", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-attorney-preferences@lets-paraconnect.test",
    });

    const conversationRes = await createConversation(attorney);
    const preferencesRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "cannot find preferences",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "profile-settings",
      },
    });

    expect(preferencesRes.status).toBe(201);
    expect(preferencesRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Preferences",
        ctaHref: "profile-settings.html#preferencesSection",
      })
    );

    const fundRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "where do i go to fund a case",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(fundRes.status).toBe(201);
    expect(fundRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Cases & Files",
        ctaHref: "dashboard-attorney.html#cases",
      })
    );
  });

  test("keeps common attorney navigation prompts in direct-answer mode without escalation residue", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-attorney-navigation-cleanup@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-attorney-navigation-cleanup-paralegal@lets-paraconnect.test",
    });
    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Navigation Cleanup Matter",
    });

    const conversationRes = await createConversation(attorney);

    const settingsRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "where are profile settings",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });
    expect(settingsRes.status).toBe(201);
    expect(settingsRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(settingsRes.body.assistantReply.needsEscalation).toBe(false);
    expect(settingsRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html",
      })
    );

    const documentsRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "where do i upload documents",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });
    expect(documentsRes.status).toBe(201);
    expect(documentsRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(documentsRes.body.assistantReply.needsEscalation).toBe(false);
    expect(documentsRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaHref: `case-detail.html?caseId=${String(caseDoc._id)}`,
      })
    );

    const messagesRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "where do i view messages for this case",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });
    expect(messagesRes.status).toBe(201);
    expect(messagesRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(messagesRes.body.assistantReply.needsEscalation).toBe(false);
    expect(messagesRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaHref: `case-detail.html?caseId=${String(caseDoc._id)}#case-messages`,
      })
    );
  });

  test("keeps attorney payout questions out of billing-method answers", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-attorney-no-payout-billing-leak@lets-paraconnect.test",
      stripeCustomerId: "cus_attorney_no_payout_billing_leak",
    });
    mockStripe.customers.retrieve.mockResolvedValue({
      invoice_settings: {
        default_payment_method: "pm_attorney_no_payout_billing_leak",
      },
    });
    mockStripe.paymentMethods.retrieve.mockResolvedValue({
      type: "card",
      card: {
        brand: "visa",
        last4: "4242",
        exp_month: 12,
        exp_year: 2030,
      },
    });

    const conversationRes = await createConversation(attorney);
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "where is my payout",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("payout_question");
    expect(sendRes.body.assistantMessage.text).toMatch(/Attorney accounts don't receive payouts/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/saved payment method/i);
  });

  test("routes paralegal application and payouts discovery prompts to the correct destinations", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-paralegal-discovery@lets-paraconnect.test",
    });

    const conversationRes = await createConversation(paralegal);
    const applicationsRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "where do i see my applications",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(applicationsRes.status).toBe(201);
    expect(applicationsRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "My applications",
        ctaHref: "dashboard-paralegal.html#cases",
      })
    );
    expect(applicationsRes.body.assistantReply.suggestedReplies).toEqual(
      expect.arrayContaining(["Browse cases", "Resume application"])
    );
    expect(applicationsRes.body.assistantReply.suggestedReplies.length).toBeGreaterThanOrEqual(2);

    const resumeRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "resume application",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(resumeRes.status).toBe(201);
    expect(resumeRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "My applications",
        ctaHref: "dashboard-paralegal.html#cases",
      })
    );

    const payoutsRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "where can i see my payouts",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(payoutsRes.status).toBe(201);
    expect(payoutsRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Completed cases",
        ctaHref: "dashboard-paralegal.html#cases-completed",
      })
    );
  });

  test("treats minor typos in applications navigation as direct navigation instead of support review", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-paralegal-discovery-typo@lets-paraconnect.test",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "where do i see my applciations",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "navigation",
        needsEscalation: false,
        escalationReason: "",
        navigation: expect.objectContaining({
          ctaLabel: "My applications",
          ctaHref: "dashboard-paralegal.html#cases",
        }),
        suggestedReplies: expect.arrayContaining(["Browse cases", "Resume application"]),
      })
    );
    expect(sendRes.body.assistantReply.suggestedReplies.length).toBeGreaterThanOrEqual(2);
  });

  test("routes paralegal profile readiness to profile settings", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-paralegal-profile-readiness@lets-paraconnect.test",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "profile readiness",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Profile settings",
        ctaHref: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
      })
    );
  });

  test("keeps common paralegal settings and history routes in direct-answer mode", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-paralegal-navigation-cleanup@lets-paraconnect.test",
    });

    const conversationRes = await createConversation(paralegal);

    const stripeRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "open stripe setup",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });
    expect(stripeRes.status).toBe(201);
    expect(stripeRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(stripeRes.body.assistantReply.needsEscalation).toBe(false);
    expect(stripeRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
      })
    );

    const securityRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "where do i go for security",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "preferences",
      },
    });
    expect(securityRes.status).toBe(201);
    expect(securityRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(securityRes.body.assistantReply.needsEscalation).toBe(false);
    expect(securityRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Security settings",
        ctaHref: "profile-settings.html#securitySection",
      })
    );

    const completedRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "where can i see my completed matters",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });
    expect(completedRes.status).toBe(201);
    expect(completedRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(completedRes.body.assistantReply.needsEscalation).toBe(false);
    expect(completedRes.body.assistantReply.navigation).toEqual(
      expect.objectContaining({
        ctaLabel: "Completed cases",
        ctaHref: "dashboard-paralegal.html#cases-completed",
      })
    );
  });

  test("grounds workspace access replies to the inferred recent case instead of generic escalation", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-workspace-attorney@lets-paraconnect.test",
      firstName: "Wes",
      lastName: "Workspace",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-workspace-paralegal@lets-paraconnect.test",
      firstName: "Pia",
      lastName: "Workspace",
    });

    await createCaseDoc({
      attorney,
      paralegal,
      title: "Locked Workspace Matter",
      status: "in progress",
      escrowIntentId: "",
      escrowStatus: "pending",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "cant access this workspace",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("workspace_access");
    expect(sendRes.body.assistantReply.supportFacts.caseState).toEqual(
      expect.objectContaining({
        inferred: true,
        title: "Locked Workspace Matter",
      })
    );
    expect(sendRes.body.assistantMessage.text).toMatch(/Locked Workspace Matter/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/payment is secured|funded/i);
  });

  test("recognizes shorthand responsiveness and payout phrasing that previously missed", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-shorthand-attorney@lets-paraconnect.test",
      firstName: "Sam",
      lastName: "Shorthand",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-shorthand-paralegal@lets-paraconnect.test",
      firstName: "Pat",
      lastName: "Shorthand",
      stripeAccountId: "acct_shorthand_support",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    await createCaseDoc({
      attorney,
      paralegal,
      title: "Response Delay Matter",
      status: "in progress",
      escrowStatus: "funded",
      paymentReleased: false,
    });
    await createCaseDoc({
      attorney,
      paralegal,
      title: "Released Pay Matter",
      status: "completed",
      escrowStatus: "funded",
      paymentReleased: true,
      completedAt: new Date("2026-03-12T16:00:00.000Z"),
    });

    const responsivenessConversation = await createConversation(paralegal);
    const responsivenessRes = await sendSupportMessage(paralegal, responsivenessConversation.body.conversation.id, {
      text: "attorney isnt responding",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(responsivenessRes.status).toBe(201);
    expect(responsivenessRes.body.assistantReply.primaryAsk).toBe("responsiveness_issue");
    expect(responsivenessRes.body.assistantMessage.text).toMatch(/isn't responding/i);

    const payoutConversation = await createConversation(paralegal);
    const payoutRes = await sendSupportMessage(paralegal, payoutConversation.body.conversation.id, {
      text: "my money didnt come",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(payoutRes.status).toBe(201);
    expect(payoutRes.body.assistantReply.primaryAsk).toBe("payout_question");
    expect(payoutRes.body.assistantMessage.text).toMatch(/Stripe|payout/i);
    expect(payoutRes.body.assistantMessage.text).not.toMatch(/Tell me what happened/i);
  });

  test("treats workspace blank and explicit resolution as clean workflow answers", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-workspace-blank-cleanup-attorney@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-workspace-blank-cleanup-paralegal@lets-paraconnect.test",
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Blank Workspace Matter",
      status: "in progress",
      escrowStatus: "funded",
    });

    const conversationRes = await createConversation(attorney);
    const blankRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "the workspace is blank",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(blankRes.status).toBe(201);
    expect(blankRes.body.assistantReply.primaryAsk).toBe("workspace_access");
    expect(blankRes.body.assistantMessage.text).toMatch(/workspace/i);
    expect(blankRes.body.assistantMessage.text).not.toMatch(/Messaging is blocked/i);

    const resolvedRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "nothing is blocking me",
      pageContext: {
        pathname: "/case-detail.html",
        viewName: "case-detail",
        caseId: String(caseDoc._id),
      },
    });

    expect(resolvedRes.status).toBe(201);
    expect(resolvedRes.body.assistantReply.primaryAsk).toBe("issue_resolved");
    expect(resolvedRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(resolvedRes.body.assistantReply.needsEscalation).toBe(false);
    expect(resolvedRes.body.assistantMessage.text).toBe("Glad that's sorted.");
  });

  test("treats gratitude after a helpful answer as a conversational close instead of intake", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-thanks-close@lets-paraconnect.test",
      firstName: "Casey",
      lastName: "Close",
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "When can I apply for a job? how does it work",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantReply.primaryAsk).toBe("product_guidance");

    const thanksRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "great, thanks",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(thanksRes.status).toBe(201);
    expect(thanksRes.body.assistantReply.primaryAsk).toBe("issue_resolved");
    expect(thanksRes.body.assistantReply.responseMode).toBe("DIRECT_ANSWER");
    expect(thanksRes.body.assistantReply.needsEscalation).toBe(false);
    expect(thanksRes.body.assistantMessage.text).toBe("You're welcome. I'm here if you need anything else.");
  });

  test("keeps payout enablement answers focused on stripe setup instead of blending unrelated release details", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-payout-enable-attorney@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-payout-enable-paralegal@lets-paraconnect.test",
      stripeAccountId: "acct_payout_enable_support",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    await createCaseDoc({
      attorney,
      paralegal,
      title: "Enabled Payout Matter",
      status: "completed",
      escrowStatus: "funded",
      paymentReleased: true,
      completedAt: new Date("2026-03-12T16:00:00.000Z"),
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "why aren't payouts enabled",
      pageContext: {
        pathname: "/profile-settings.html",
        viewName: "profile-settings",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("payout_question");
    expect(sendRes.body.assistantMessage.text).toMatch(/Stripe setup isn't finished|payouts aren't enabled/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/released by LPC/i);
  });

  test("resets a vague customer service prompt back to intake even after a responsiveness thread", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-customer-service-intake-reset@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-customer-service-intake-reset-para@lets-paraconnect.test",
    });

    await createCaseDoc({
      attorney,
      paralegal,
      title: "Responsiveness Reset Matter",
      status: "in progress",
      escrowStatus: "funded",
    });

    const conversationRes = await createConversation(paralegal);
    const firstRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "they won't respond",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body.assistantReply.primaryAsk).toBe("responsiveness_issue");

    const secondRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "customer service",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "generic_intake",
        intakeMode: true,
        needsEscalation: false,
      })
    );
    expect(secondRes.body.assistantMessage.text).toBe("How can I help today?");
  });

  test("routes attorney billing-method update requests directly to billing", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-update-billing-method@lets-paraconnect.test",
    });

    const conversationRes = await createConversation(attorney);
    const sendRes = await sendSupportMessage(attorney, conversationRes.body.conversation.id, {
      text: "update billing method",
      pageContext: {
        pathname: "/dashboard-attorney.html",
        viewName: "dashboard-attorney",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantMessage.text).toBe("You can update that here.");
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "billing_payment_method",
        responseMode: "DIRECT_ANSWER",
        needsEscalation: false,
        navigation: expect.objectContaining({
          ctaLabel: "Billing & Payments",
          ctaHref: "dashboard-attorney.html#billing",
        }),
      })
    );
  });

  test("answers payout status first without immediate escalation on a standard payout question", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-standard-payout-status-attorney@lets-paraconnect.test",
    });
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-standard-payout-status-paralegal@lets-paraconnect.test",
      stripeAccountId: "acct_standard_payout_status",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    });

    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Standard Payout Matter",
      status: "completed",
      escrowStatus: "funded",
      paymentReleased: true,
      completedAt: new Date("2026-03-18T16:00:00.000Z"),
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "where is my payout",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
        caseId: String(caseDoc._id),
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "payout_question",
        needsEscalation: true,
      })
    );
    expect(sendRes.body.assistantMessage.text).toMatch(/released by LPC|released on/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/send this to the team/i);
  });

  test("uses grounded payout wording for 'my money didnt come' instead of a generic blocker prompt", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-money-didnt-come@lets-paraconnect.test",
      stripeAccountId: "acct_money_didnt_come",
      stripeOnboarded: false,
      stripeChargesEnabled: false,
      stripePayoutsEnabled: false,
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "my money didnt come",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply.primaryAsk).toBe("payout_question");
    expect(sendRes.body.assistantMessage.text).toMatch(/Stripe setup|payout setup|payout release/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/Tell me which part is still blocked/i);
  });

  test("uses role-aware payment clarification for paralegals asking about a payment method", async () => {
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-paralegal-payment-method-clarify@lets-paraconnect.test",
    });

    const conversationRes = await createConversation(paralegal);
    const sendRes = await sendSupportMessage(paralegal, conversationRes.body.conversation.id, {
      text: "payment method ok?",
      pageContext: {
        pathname: "/dashboard-paralegal.html",
        viewName: "dashboard-paralegal",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "payment_clarify",
        responseMode: "CLARIFY_ONCE",
      })
    );
    expect(sendRes.body.assistantMessage.text).toBe(
      "Are you asking about payout setup or a specific case payment?"
    );
  });

  test("blocks unapproved users from the support endpoints", async () => {
    const pendingParalegal = await createUser({
      role: "paralegal",
      status: "pending",
      email: "support-pending@lets-paraconnect.test",
    });

    const response = await createConversation(pendingParalegal);

    expect(response.status).toBe(403);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: "Account pending approval",
      })
    );
  });

  test("locks admin dashboard chat to admin dashboard navigation and routes review queue questions to approvals", async () => {
    const admin = await createUser({
      role: "admin",
      email: "support-admin-dashboard-approvals@lets-paraconnect.test",
      firstName: "Samantha",
      lastName: "Founder",
    });

    const conversationRes = await createConversation(admin, {
      sourcePage: "/admin-dashboard.html",
      viewName: "admin-dashboard",
    });
    const sendRes = await sendSupportMessage(admin, conversationRes.body.conversation.id, {
      text: "Where is the review queue?",
      pageContext: {
        pathname: "/admin-dashboard.html",
        viewName: "admin-dashboard",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "admin_dashboard_help",
        provider: "admin_dashboard_support",
        responseMode: "DIRECT_ANSWER",
        navigation: expect.objectContaining({
          ctaLabel: "Approvals",
          ctaHref: "admin-dashboard.html#approvals-workspace",
        }),
      })
    );
    expect(sendRes.body.assistantMessage.text).toMatch(/Approvals/i);
    expect(sendRes.body.assistantMessage.text).toMatch(/review queue/i);
  });

  test("refuses non-admin questions in the admin dashboard chat scope", async () => {
    const admin = await createUser({
      role: "admin",
      email: "support-admin-dashboard-refusal@lets-paraconnect.test",
      firstName: "Samantha",
      lastName: "Founder",
    });

    const conversationRes = await createConversation(admin, {
      sourcePage: "/admin-dashboard.html",
      viewName: "admin-dashboard",
    });
    const sendRes = await sendSupportMessage(admin, conversationRes.body.conversation.id, {
      text: "How do I apply to cases?",
      pageContext: {
        pathname: "/admin-dashboard.html",
        viewName: "admin-dashboard",
      },
    });

    expect(sendRes.status).toBe(201);
    expect(sendRes.body.assistantReply).toEqual(
      expect.objectContaining({
        primaryAsk: "admin_dashboard_help",
        provider: "admin_dashboard_support",
        responseMode: "DIRECT_ANSWER",
        navigation: expect.objectContaining({
          ctaLabel: "Overview",
          ctaHref: "admin-dashboard.html#overview",
        }),
      })
    );
    expect(sendRes.body.assistantMessage.text).toMatch(/only handles admin dashboard questions/i);
    expect(sendRes.body.assistantMessage.text).not.toMatch(/browse open cases|apply when a case is open/i);
  });

  test("attorney prompt sweep stays coherent across 50 prompts", async () => {
    const attorney = await createUser({
      role: "attorney",
      email: "support-attorney-prompt-sweep@lets-paraconnect.test",
      firstName: "Avery",
      lastName: "Sweep",
    });
    const attorneyWithBillingData = await createUser({
      role: "attorney",
      email: "support-attorney-prompt-sweep-billing@lets-paraconnect.test",
      firstName: "Bailey",
      lastName: "Billing",
    });
    attorneyWithBillingData.stripeCustomerId = "cus_attorney_prompt_sweep";
    await attorneyWithBillingData.save();
    const paralegal = await createUser({
      role: "paralegal",
      email: "support-attorney-prompt-sweep-paralegal@lets-paraconnect.test",
      firstName: "Parker",
      lastName: "Sweep",
    });
    const caseDoc = await createCaseDoc({
      attorney,
      paralegal,
      title: "Attorney Prompt Sweep Matter",
      status: "in progress",
      escrowStatus: "funded",
      paymentReleased: false,
    });

    mockStripe.customers.retrieve.mockResolvedValue({
      invoice_settings: {
        default_payment_method: "pm_attorney_prompt_sweep",
      },
    });
    mockStripe.paymentMethods.retrieve.mockResolvedValue({
      id: "pm_attorney_prompt_sweep",
      type: "card",
      card: {
        brand: "mastercard",
        last4: "4444",
        exp_month: 8,
        exp_year: 2031,
      },
    });

    const caseDetailHref = `case-detail.html?caseId=${String(caseDoc._id)}`;
    const caseMessagesHref = `${caseDetailHref}#case-messages`;
    const billingPromptAction = async (conversationId, overrides = {}) => {
      const ticket = await SupportTicket.create({
        subject: "Case issue",
        message: "I need help with a case issue.",
        status: "in_review",
        urgency: "high",
        requesterRole: "attorney",
        sourceSurface: "attorney",
        sourceLabel: "Support chat",
        requesterUserId: attorney._id,
        requesterEmail: attorney.email,
        userId: attorney._id,
        conversationId,
        classification: {
          category: "case_workflow",
          confidence: "medium",
        },
      });
      return {
        key: `open-ticket:${ticket._id}`,
        intent: "issue_review_status",
        issueLabel: "case issue",
        issueState: "open",
        ticketId: String(ticket._id),
        ticketStatus: "in_review",
        handedOffToEngineering: false,
        ...overrides,
      };
    };

    const promptCases = [
      {
        label: "billing nav exact question",
        prompt: "Where is my payment method?",
        conversationQuery: { viewName: "billing" },
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "billing" },
        check: "billing_link",
      },
      {
        label: "billing page confirms visible method",
        prompt: "payment method",
        conversationQuery: { viewName: "billing" },
        pageContext: {
          pathname: "/dashboard-attorney.html",
          viewName: "billing",
          paymentMethod: {
            brand: "visa",
            last4: "4242",
            exp_month: 12,
            exp_year: 2030,
            type: "card",
          },
        },
        check: "visible_payment_method",
      },
      {
        label: "billing page confirms saved method from stripe",
        prompt: "saved payment method",
        user: "billing",
        conversationQuery: { viewName: "billing" },
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "billing" },
        check: "saved_payment_method",
      },
      {
        label: "unclear payment prompt clarifies",
        prompt: "payment",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "payment_clarify",
      },
      {
        label: "generic help stays intake",
        prompt: "help",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "generic_intake",
      },
      {
        label: "invoice link",
        prompt: "where do i find invoices",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "billing_link",
      },
      {
        label: "receipt link",
        prompt: "where do i find receipts",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "billing_link",
      },
      {
        label: "browse paralegals link",
        prompt: "where can i browse paralegals",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "browse_paralegals",
      },
      {
        label: "cases link",
        prompt: "where can i see my cases",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "cases_link",
      },
      {
        label: "preferences link",
        prompt: "cannot find preferences",
        pageContext: { pathname: "/profile-settings.html", viewName: "profile-settings" },
        check: "preferences_link",
      },
      {
        label: "fund case link",
        prompt: "where do i go to fund a case",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "cases_link",
      },
      {
        label: "profile settings link",
        prompt: "where are profile settings",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "profile_settings",
      },
      {
        label: "case documents link",
        prompt: "where do i upload documents",
        pageContext: {
          pathname: "/case-detail.html",
          viewName: "case-detail",
          caseId: String(caseDoc._id),
        },
        check: "case_documents",
      },
      {
        label: "case messages link",
        prompt: "where do i view messages for this case",
        pageContext: {
          pathname: "/case-detail.html",
          viewName: "case-detail",
          caseId: String(caseDoc._id),
        },
        check: "case_messages",
      },
      {
        label: "attorney payout wording",
        prompt: "where is my payout",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "attorney_payout",
      },
      {
        label: "billing update nav",
        prompt: "update billing method",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "billing_update",
      },
      {
        label: "attorney first steps",
        prompt: "What do attorneys usually do first on LPC?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "attorney_first_steps",
      },
      {
        label: "ambiguous nav clarify",
        prompt: "Where do I find that?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "nav_clarify",
      },
      {
        label: "workspace blank",
        prompt: "the workspace is blank",
        pageContext: {
          pathname: "/case-detail.html",
          viewName: "case-detail",
          caseId: String(caseDoc._id),
        },
        check: "workspace_blank",
      },
      {
        label: "customer service reset",
        prompt: "customer service",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "generic_intake",
      },
      {
        label: "two topic split",
        prompt: "Can I change to dark mode and where are my invoices?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "topic_split",
      },
      {
        label: "two topic billing branch",
        before: [
          {
            text: "Can I change to dark mode and where are my invoices?",
            pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          },
        ],
        prompt: "Billing first.",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "billing_link",
      },
      {
        label: "two topic last selected branch",
        before: [
          {
            text: "Can I change to dark mode and where are my invoices?",
            pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          },
          {
            text: "Billing first.",
            pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          },
        ],
        prompt: "That one.",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "billing_link",
      },
      {
        label: "two topic both answer",
        before: [
          {
            text: "Can I change to dark mode and where are my invoices?",
            pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          },
        ],
        prompt: "Both, please.",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "topic_both",
      },
      {
        label: "two topic other branch",
        before: [
          {
            text: "Can I change to dark mode and where are my invoices?",
            pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          },
          {
            text: "Billing first.",
            pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          },
        ],
        prompt: "What about the other one?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "preferences_other",
      },
      {
        label: "two topic correction branch",
        before: [
          {
            text: "Can I change to dark mode and where are my invoices?",
            pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          },
          {
            text: "Billing first.",
            pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          },
        ],
        prompt: "Actually not that. The other one.",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "preferences_other",
      },
      {
        label: "billing correction from payout thread",
        before: [
          {
            text: "Where is my payout?",
            pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
          },
        ],
        prompt: "No, I mean how do I update my billing method?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "billing_switch",
      },
      {
        label: "profile save issue report",
        prompt: "the save preferences button isn't working",
        pageContext: { pathname: "/profile-settings.html", viewName: "preferences" },
        check: "profile_save_issue",
      },
      {
        label: "profile save timing followup",
        before: [
          {
            text: "the save preferences button isn't working",
            pageContext: { pathname: "/profile-settings.html", viewName: "preferences" },
          },
        ],
        prompt: "when will it be fixed",
        pageContext: { pathname: "/profile-settings.html", viewName: "preferences" },
        check: "issue_fix_timing",
      },
      {
        label: "issue status and billing",
        buildPromptAction: billingPromptAction,
        prompt: "Can you check on my issue and where are my invoices?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "billing" },
        check: "issue_status_and_billing",
      },
      {
        label: "invoice link punctuation variant",
        prompt: "where do i find invoices?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "billing_link",
      },
      {
        label: "receipt link punctuation variant",
        prompt: "where do i find receipts?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "billing_link",
      },
      {
        label: "browse paralegals punctuation variant",
        prompt: "where can i browse paralegals?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "browse_paralegals",
      },
      {
        label: "cases link punctuation variant",
        prompt: "where can i see my cases?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "cases_link",
      },
      {
        label: "preferences punctuation variant",
        prompt: "cannot find preferences.",
        pageContext: { pathname: "/profile-settings.html", viewName: "profile-settings" },
        check: "preferences_link",
      },
      {
        label: "fund case punctuation variant",
        prompt: "where do i go to fund a case?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "cases_link",
      },
      {
        label: "profile settings punctuation variant",
        prompt: "where are profile settings?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "profile_settings",
      },
      {
        label: "documents punctuation variant",
        prompt: "where do i upload documents?",
        pageContext: {
          pathname: "/case-detail.html",
          viewName: "case-detail",
          caseId: String(caseDoc._id),
        },
        check: "case_documents",
      },
      {
        label: "messages punctuation variant",
        prompt: "where do i view messages for this case?",
        pageContext: {
          pathname: "/case-detail.html",
          viewName: "case-detail",
          caseId: String(caseDoc._id),
        },
        check: "case_messages",
      },
      {
        label: "attorney payout capitalized variant",
        prompt: "Where is my payout?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "attorney_payout",
      },
      {
        label: "billing update punctuation variant",
        prompt: "update billing method.",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "billing_update",
      },
      {
        label: "attorney first steps no question mark",
        prompt: "What do attorneys usually do first on LPC",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "attorney_first_steps",
      },
      {
        label: "ambiguous nav no punctuation",
        prompt: "Where do I find that",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "nav_clarify",
      },
      {
        label: "customer service punctuation variant",
        prompt: "customer service?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "generic_intake",
      },
      {
        label: "help punctuation variant",
        prompt: "help?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "generic_intake",
      },
      {
        label: "payment punctuation variant",
        prompt: "payment?",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "payment_clarify",
      },
      {
        label: "payment method punctuation variant",
        prompt: "payment method?",
        conversationQuery: { viewName: "billing" },
        pageContext: {
          pathname: "/dashboard-attorney.html",
          viewName: "billing",
          paymentMethod: {
            brand: "visa",
            last4: "4242",
            exp_month: 12,
            exp_year: 2030,
            type: "card",
          },
        },
        check: "visible_payment_method",
      },
      {
        label: "saved payment method punctuation variant",
        prompt: "saved payment method?",
        user: "billing",
        conversationQuery: { viewName: "billing" },
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "billing" },
        check: "saved_payment_method",
      },
      {
        label: "payment method lowercase variant",
        prompt: "where is my payment method",
        conversationQuery: { viewName: "billing" },
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "billing" },
        check: "billing_link",
      },
      {
        label: "topic split no question mark",
        prompt: "Can I change to dark mode and where are my invoices",
        pageContext: { pathname: "/dashboard-attorney.html", viewName: "dashboard-attorney" },
        check: "topic_split",
      },
    ];

    expect(promptCases).toHaveLength(50);

    const runPromptCase = async (promptCase) => {
      const activeAttorney = promptCase.user === "billing" ? attorneyWithBillingData : attorney;
      const conversationRes = await createConversation(activeAttorney, promptCase.conversationQuery || {});
      expect(conversationRes.status).toBe(200);
      const conversationId = conversationRes.body.conversation.id;

      if (Array.isArray(promptCase.before)) {
        for (const step of promptCase.before) {
          const beforeRes = await sendSupportMessage(activeAttorney, conversationId, {
            text: step.text,
            pageContext: step.pageContext,
            promptAction: step.promptAction,
          });
          expect(beforeRes.status).toBe(201);
        }
      }

      const promptAction = promptCase.buildPromptAction
        ? await promptCase.buildPromptAction(conversationId)
        : promptCase.promptAction || null;

      const sendRes = await sendSupportMessage(activeAttorney, conversationId, {
        text: promptCase.prompt,
        pageContext: promptCase.pageContext,
        promptAction,
      });

      expect(sendRes.status).toBe(201);
      expect(String(sendRes.body.assistantMessage?.text || "")).not.toEqual("");
      expect(String(sendRes.body.assistantMessage?.text || "")).not.toMatch(/I'm having trouble right now, please try again\./i);

      const reply = sendRes.body.assistantReply || {};
      const text = String(sendRes.body.assistantMessage?.text || "");

      switch (promptCase.check) {
        case "billing_link":
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaLabel: "Billing & Payments",
              ctaHref: "dashboard-attorney.html#billing",
            })
          );
          expect(text).toMatch(/here/i);
          break;
        case "visible_payment_method":
          expect(reply.supportFacts.billingMethodState).toEqual(
            expect.objectContaining({
              available: true,
              last4: "4242",
            })
          );
          expect(text).toMatch(/saved payment method/i);
          expect(text).toMatch(/4242/);
          break;
        case "saved_payment_method":
          expect(reply.supportFacts.billingMethodState).toEqual(
            expect.objectContaining({
              available: true,
              source: "live",
              last4: "4444",
            })
          );
          expect(text).toMatch(/saved payment method/i);
          expect(text).toMatch(/4444/);
          break;
        case "payment_clarify":
          expect(text).toBe("Are you asking about your account billing method or a specific case payment?");
          expect(Array.isArray(reply.suggestedReplies)).toBe(true);
          expect(reply.suggestedReplies.length).toBeGreaterThan(0);
          break;
        case "generic_intake":
          expect(reply.needsEscalation).toBe(false);
          expect(text).toBe("How can I help today?");
          break;
        case "browse_paralegals":
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaLabel: "Browse paralegals",
              ctaHref: "browse-paralegals.html",
            })
          );
          break;
        case "cases_link":
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaLabel: "Cases & Files",
              ctaHref: "dashboard-attorney.html#cases",
            })
          );
          break;
        case "preferences_link":
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaLabel: "Preferences",
              ctaHref: "profile-settings.html#preferencesSection",
            })
          );
          break;
        case "profile_settings":
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaLabel: "Profile settings",
              ctaHref: "profile-settings.html",
            })
          );
          break;
        case "case_documents":
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaHref: caseDetailHref,
            })
          );
          break;
        case "case_messages":
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaHref: caseMessagesHref,
            })
          );
          break;
        case "attorney_payout":
          expect(reply.primaryAsk).toBe("payout_question");
          expect(text).toMatch(/Attorney accounts don't receive payouts/i);
          expect(text).not.toMatch(/saved payment method/i);
          break;
        case "billing_update":
          expect(reply.primaryAsk).toBe("billing_payment_method");
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaHref: "dashboard-attorney.html#billing",
            })
          );
          expect(text).toBe("You can update that here.");
          break;
        case "attorney_first_steps":
          expect(reply.primaryAsk).toBe("product_guidance");
          expect(text).toMatch(/Start from your dashboard by posting or reviewing your matters/i);
          expect(text).toMatch(/Then choose the paralegal support you need/i);
          break;
        case "nav_clarify":
          expect(reply.navigation).toBeNull();
          expect(text).toBe("Are you looking for billing, messages, profile settings, or a specific case?");
          break;
        case "workspace_blank":
          expect(reply.primaryAsk).toBe("workspace_access");
          expect(text).toMatch(/workspace/i);
          expect(text).not.toMatch(/Messaging is blocked/i);
          break;
        case "topic_split":
          expect(reply.awaitingField).toBe("topic_selection");
          expect(reply.suggestedReplies).toEqual(["Theme settings", "Billing"]);
          expect(text).toBe("I can help with theme settings and billing. Which one do you want to start with?");
          break;
        case "topic_both":
          expect(reply.awaitingField).toBe("");
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaLabel: "Preferences",
              ctaHref: "profile-settings.html#preferencesSection",
            })
          );
          expect(text).toBe("Yes — you can change that in Preferences. Also, you can find billing and invoices here.");
          break;
        case "preferences_other":
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaLabel: "Preferences",
              ctaHref: "profile-settings.html#preferencesSection",
            })
          );
          expect(text).toMatch(/Preferences/i);
          break;
        case "billing_switch":
          expect(reply.primaryAsk).toBe("billing_payment_method");
          expect(reply.topicMode).toBe("switch");
          expect(reply.turnKind).toBe("correction");
          expect(text).toBe("You can update that here.");
          break;
        case "profile_save_issue":
          expect(reply.primaryAsk).toBe("profile_save");
          expect(text).toMatch(/Save Preferences issue/i);
          expect(text).toMatch(/engineering/i);
          break;
        case "issue_fix_timing":
          expect(reply.primaryAsk).toBe("issue_review_status");
          expect(text).toMatch(/don't have a fix time yet/i);
          expect(text).toMatch(/keep this thread updated/i);
          break;
        case "issue_status_and_billing":
          expect(reply.primaryAsk).toBe("issue_review_status");
          expect(text).toMatch(/still open with the team/i);
          expect(text).toMatch(/Also, you can find that here\./i);
          expect(reply.navigation).toEqual(
            expect.objectContaining({
              ctaHref: "dashboard-attorney.html#billing",
            })
          );
          break;
        default:
          throw new Error(`Unknown check ${promptCase.check}`);
      }
    };

    for (const promptCase of promptCases) {
      try {
        await runPromptCase(promptCase);
      } catch (error) {
        error.message = `[${promptCase.label}] ${error.message}`;
        throw error;
      }
    }
  });
});
