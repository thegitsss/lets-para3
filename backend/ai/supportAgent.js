const mongoose = require("mongoose");
const { AI_MODELS, createJsonChatCompletion, getAiStatus, isAiEnabled } = require("./config");
const { createLogger } = require("../utils/logger");

const logger = createLogger("ai:support");

const SUPPORT_CATEGORIES = Object.freeze([
  "login",
  "password_reset",
  "profile_save",
  "profile_photo_upload",
  "dashboard_load",
  "case_posting",
  "messaging",
  "payment",
  "stripe_onboarding",
  "account_approval",
  "unknown",
]);

const URGENCY_LEVELS = Object.freeze(["high", "medium", "low"]);
const HIGH_PRIORITY_CATEGORIES = new Set(["login", "payment", "stripe_onboarding", "account_approval"]);

const CATEGORY_RULES = [
  {
    category: "password_reset",
    patterns: [
      /forgot password/i,
      /reset (?:my )?password/i,
      /password reset/i,
      /reset link/i,
      /password email/i,
    ],
  },
  {
    category: "login",
    patterns: [
      /can'?t log in/i,
      /cannot log in/i,
      /unable to log in/i,
      /unable to login/i,
      /login failed/i,
      /sign in failed/i,
      /locked out/i,
      /access denied/i,
      /invalid credentials/i,
    ],
  },
  {
    category: "profile_save",
    patterns: [
      /profile (?:won'?t|will not|doesn'?t) save/i,
      /unable to save (?:my )?profile/i,
      /save profile/i,
      /settings (?:won'?t|will not|doesn'?t) save/i,
      /profile changes/i,
      /profile update/i,
    ],
  },
  {
    category: "profile_photo_upload",
    patterns: [
      /profile photo/i,
      /headshot/i,
      /photo upload/i,
      /upload (?:my )?photo/i,
      /avatar/i,
      /jpeg|jpg|png/i,
    ],
  },
  {
    category: "dashboard_load",
    patterns: [
      /dashboard/i,
      /page (?:won'?t|will not|doesn'?t) load/i,
      /blank screen/i,
      /loading forever/i,
      /stuck loading/i,
      /unable to load/i,
    ],
  },
  {
    category: "case_posting",
    patterns: [
      /post (?:a )?case/i,
      /case posting/i,
      /unable to post/i,
      /job post/i,
      /hire/i,
      /applicants/i,
    ],
  },
  {
    category: "messaging",
    patterns: [
      /message/i,
      /chat/i,
      /thread/i,
      /conversation/i,
      /inbox/i,
      /send (?:a )?message/i,
    ],
  },
  {
    category: "payment",
    patterns: [
      /payment/i,
      /card/i,
      /checkout/i,
      /refund/i,
      /receipt/i,
      /billing/i,
      /charge/i,
      /paid/i,
      /payout/i,
      /escrow/i,
    ],
  },
  {
    category: "stripe_onboarding",
    patterns: [
      /stripe/i,
      /connect account/i,
      /onboard/i,
      /payout account/i,
      /bank account/i,
      /charges enabled/i,
      /payouts enabled/i,
    ],
  },
  {
    category: "account_approval",
    patterns: [
      /pending approval/i,
      /account approval/i,
      /approved yet/i,
      /application review/i,
      /verify my account/i,
      /waiting for approval/i,
    ],
  },
];

function normalizeMessageText(messageText) {
  return String(messageText || "").trim();
}

function getPublicBaseUrl() {
  return String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
}

function toPublicUrl(pathname) {
  const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const baseUrl = getPublicBaseUrl();
  return baseUrl ? `${baseUrl}${cleanPath}` : cleanPath;
}

function sanitizeCategory(category) {
  const safe = String(category || "").trim().toLowerCase();
  return SUPPORT_CATEGORIES.includes(safe) ? safe : "unknown";
}

function sanitizeUrgency(urgency) {
  const safe = String(urgency || "").trim().toLowerCase();
  return URGENCY_LEVELS.includes(safe) ? safe : "medium";
}

function clipText(value, max = 500) {
  const text = normalizeMessageText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function computeUrgency(category, messageText) {
  const text = normalizeMessageText(messageText).toLowerCase();
  const hasHighSignal =
    /urgent|asap|immediately|locked out|cannot access|can't access|unable to access|deadline today|court/i.test(
      messageText || ""
    ) || /security|unauthorized|fraud|hack/i.test(text);

  if (HIGH_PRIORITY_CATEGORIES.has(category) && (hasHighSignal || category !== "account_approval")) {
    return "high";
  }
  if (category === "dashboard_load" && hasHighSignal) return "high";
  if (["profile_save", "profile_photo_upload", "dashboard_load", "case_posting", "messaging"].includes(category)) {
    return hasHighSignal ? "high" : "medium";
  }
  return hasHighSignal ? "medium" : "low";
}

function classifyWithRules(messageText) {
  const normalized = normalizeMessageText(messageText);
  if (!normalized) {
    return {
      category: "unknown",
      urgency: "low",
      confidence: "low",
      provider: "rules",
      matchedKeywords: [],
    };
  }

  let bestMatch = null;

  CATEGORY_RULES.forEach((rule) => {
    const matches = rule.patterns.filter((pattern) => pattern.test(normalized));
    if (!matches.length) return;

    const score = matches.length;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        category: rule.category,
        score,
        matchedKeywords: matches.map((pattern) => pattern.toString()),
      };
    }
  });

  const category = bestMatch?.category || "unknown";
  const urgency = computeUrgency(category, normalized);
  const confidence = bestMatch ? (bestMatch.score > 1 ? "high" : "medium") : "low";

  return {
    category,
    urgency,
    confidence,
    provider: "rules",
    matchedKeywords: bestMatch?.matchedKeywords || [],
  };
}

function getCategoryGuidance(category, urgency) {
  const guidanceByCategory = {
    login: [
      `Try signing in again at ${toPublicUrl("/login.html")} and confirm the email address is entered exactly as registered.`,
      `If the password may be the issue, use ${toPublicUrl("/forgot-password.html")} to request a fresh reset link.`,
      "If you still cannot access the account, reply with the exact error message and the approximate time the issue occurred so it can be reviewed.",
    ],
    password_reset: [
      `Request a new reset link at ${toPublicUrl("/forgot-password.html")} and use the newest email only.`,
      "Check spam, junk, and promotions folders if the reset email does not appear right away.",
      "Reset links currently expire after 48 hours, so older links may no longer work.",
    ],
    profile_save: [
      `Open your settings again and re-save the profile after refreshing the page.`,
      "If a specific field is failing, remove unusual formatting or pasted rich text and try saving again.",
      "If the save still fails, reply with the section you were editing and any on-screen error you saw.",
    ],
    profile_photo_upload: [
      "Upload a JPEG or PNG profile photo and keep the file size modest before retrying.",
      "If you are editing an existing approved photo, save the update from your profile settings and confirm the upload completed before leaving the page.",
      "If the issue continues, reply with the file type, approximate file size, and whether the problem happened during upload or after submission.",
    ],
    dashboard_load: [
      "Refresh the dashboard, then sign out and back in if the page still appears blank or stuck loading.",
      "Try the same page in a private browser window to rule out a cached session issue.",
      "If the problem persists, reply with the exact dashboard page and the time it failed to load.",
    ],
    case_posting: [
      "Refresh the case form and confirm all required fields are completed before submitting again.",
      `If payment setup is involved, verify billing details from the attorney dashboard billing section at ${toPublicUrl("/dashboard-attorney.html#billing")}.`,
      "If the case still will not post, reply with the final step that failed and any error shown on screen.",
    ],
    messaging: [
      "Refresh the conversation and try sending the message again from the active case thread.",
      "If attachments are involved, retry without the attachment first to isolate whether the issue is upload-related.",
      "If messages still do not appear, reply with the case or thread context and the approximate send time.",
    ],
    payment: [
      `Review the billing area at ${toPublicUrl("/dashboard-attorney.html#billing")} and confirm the saved payment method is current.`,
      `You can also review the platform payment terms at ${toPublicUrl("/terms.html")} while the issue is being reviewed.`,
      "If you were charged or blocked at checkout, reply with the exact error and the last step reached so the payment flow can be reviewed.",
    ],
    stripe_onboarding: [
      `Open your payment settings and retry the Stripe Connect flow from ${toPublicUrl("/profile-settings.html")}.`,
      "If Stripe redirected back with an error, reply with the message you saw and whether bank or identity verification was the failing step.",
      `Payment and payout processing on LPC relies on Stripe, as described in ${toPublicUrl("/privacy.html")} and ${toPublicUrl("/terms.html")}.`,
    ],
    account_approval: [
      "New accounts can remain limited while review is pending.",
      "Please confirm your profile details, contact information, and any requested verification materials are complete.",
      "If you have already submitted everything, reply with the email tied to the account and the date the application was submitted.",
    ],
    unknown: [
      "Reply with the exact page, action, and error message involved so the issue can be routed correctly.",
      "Include screenshots or timestamps if available.",
      `If account or payment data is involved, avoid sending sensitive financial information and use the secure platform pages instead.`,
    ],
  };

  const steps = guidanceByCategory[category] || guidanceByCategory.unknown;
  const priorityLine =
    urgency === "high"
      ? "This looks time-sensitive, so it should be reviewed as a priority."
      : urgency === "medium"
      ? "This should be reviewed promptly."
      : "This can be reviewed in the normal support queue.";

  return { steps, priorityLine };
}

function buildFallbackReply({ category, urgency }) {
  const safeCategory = sanitizeCategory(category);
  const safeUrgency = sanitizeUrgency(urgency);
  const { steps, priorityLine } = getCategoryGuidance(safeCategory, safeUrgency);

  return [
    "Thank you for reaching out. I’m sorry you ran into this issue on Let’s-ParaConnect.",
    priorityLine,
    "",
    "Recommended next steps:",
    `1. ${steps[0]}`,
    `2. ${steps[1]}`,
    `3. ${steps[2]}`,
    "",
    "If the issue continues after those steps, please reply with the exact error message, the page involved, and the approximate time it happened so it can be investigated further.",
  ].join("\n");
}

function buildFallbackInternalSummary({ category, urgency, messageText, userEmail }) {
  const safeCategory = sanitizeCategory(category);
  const safeUrgency = sanitizeUrgency(urgency);
  const emailText = userEmail ? `User: ${String(userEmail).trim().toLowerCase()}. ` : "";
  const actionHints = {
    login: "Review auth/login attempts, account lock state, and token/session flow.",
    password_reset: "Verify password reset request flow, email delivery, and token expiry handling.",
    profile_save: "Check profile update validation and persistence on the relevant profile route.",
    profile_photo_upload: "Check profile photo upload validation, file type/size, and S3 upload status.",
    dashboard_load: "Check dashboard API responses and any auth/session failures tied to page load.",
    case_posting: "Review case creation flow, validation, and payment gating if applicable.",
    messaging: "Check message thread access, send flow, and any attachment-related failures.",
    payment: "Review billing, checkout, payment intent, and receipt-related logs without promising any refund outcome.",
    stripe_onboarding: "Review Stripe Connect account status, onboarding callbacks, and payout readiness.",
    account_approval: "Review account status, verification completeness, and approval queue state.",
    unknown: "Review message details and route to the correct owner after confirming the affected surface area.",
  };

  return [
    `[${safeUrgency.toUpperCase()}] ${safeCategory} support issue.`,
    emailText.trim(),
    `Reported message: ${clipText(messageText, 600)}`,
    `Suggested internal follow-up: ${actionHints[safeCategory] || actionHints.unknown}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function isSafeReplyDraft(replyDraft) {
  const text = normalizeMessageText(replyDraft);
  if (!text) return false;

  return ![
    /we (?:fixed|resolved|corrected) (?:the issue|this)/i,
    /refund (?:has been|will be) (?:issued|processed|sent)/i,
    /a human (?:has )?(?:reviewed|approved)/i,
    /your account (?:has been|was) (?:updated|changed|approved|restored)/i,
    /legal advice/i,
  ].some((pattern) => pattern.test(text));
}

async function generateAiSupportArtifacts({ messageText, userEmail }) {
  const safeMessage = normalizeMessageText(messageText);
  if (!safeMessage) {
    return null;
  }

  const rulesResult = classifyWithRules(safeMessage);
  const systemPrompt = [
    "You are an internal support triage assistant for Let’s-ParaConnect (LPC).",
    "Return only JSON.",
    `Valid categories: ${SUPPORT_CATEGORIES.join(", ")}.`,
    `Valid urgency values: ${URGENCY_LEVELS.join(", ")}.`,
    "Be conservative and safe.",
    "Never promise a fix, refund, legal result, account change, or human review that did not happen.",
    "Never give legal advice.",
    "Reply drafts must sound calm, polished, and professional.",
    "Reply drafts must include practical next steps.",
    "Escalate login, payment, onboarding, and access issues to high priority when appropriate.",
    "Internal summary should be concise and actionable for the platform owner.",
  ].join(" ");

  const userPrompt = JSON.stringify({
    task: "Classify the issue, assign urgency, draft a safe first response, and draft an internal summary.",
    knownProductContext: {
      loginPage: toPublicUrl("/login.html"),
      forgotPasswordPage: toPublicUrl("/forgot-password.html"),
      profileSettingsPage: toPublicUrl("/profile-settings.html"),
      attorneyBillingPage: toPublicUrl("/dashboard-attorney.html#billing"),
      termsPage: toPublicUrl("/terms.html"),
      privacyPage: toPublicUrl("/privacy.html"),
    },
    conservativeFallback: rulesResult,
    userEmail: userEmail || "",
    messageText: safeMessage,
    outputSchema: {
      category: "one valid category",
      urgency: "one valid urgency",
      replyDraft: "string",
      internalSummary: "string",
    },
  });

  try {
    const aiResult = await createJsonChatCompletion({
      model: AI_MODELS.support,
      systemPrompt,
      userPrompt,
      temperature: 0.1,
    });

    const category = sanitizeCategory(aiResult.category);
    const urgency = sanitizeUrgency(aiResult.urgency);
    const replyDraft = normalizeMessageText(aiResult.replyDraft);
    const internalSummary = normalizeMessageText(aiResult.internalSummary);

    if (!replyDraft || !internalSummary || !isSafeReplyDraft(replyDraft)) {
      return null;
    }

    return {
      category,
      urgency,
      replyDraft,
      internalSummary,
      provider: "openai",
      aiEnabled: true,
    };
  } catch (err) {
    logger.warn("AI support generation failed; falling back to rules.", err?.message || err);
    return null;
  }
}

async function classifySupportIssue(messageText) {
  const safeMessage = normalizeMessageText(messageText);
  const rulesResult = classifyWithRules(safeMessage);

  if (!safeMessage) {
    return {
      ok: false,
      category: "unknown",
      urgency: "low",
      confidence: "low",
      provider: "fallback",
      aiEnabled: isAiEnabled(),
      reason: "message_missing",
    };
  }

  const aiArtifacts = isAiEnabled()
    ? await generateAiSupportArtifacts({ messageText: safeMessage })
    : null;

  if (aiArtifacts) {
    const safeCategory =
      rulesResult.category !== "unknown" && aiArtifacts.category === "unknown"
        ? rulesResult.category
        : aiArtifacts.category;
    const safeUrgency =
      HIGH_PRIORITY_CATEGORIES.has(safeCategory) || rulesResult.urgency === "high"
        ? "high"
        : aiArtifacts.urgency;

    return {
      ok: true,
      category: safeCategory,
      urgency: safeUrgency,
      confidence: rulesResult.confidence === "high" ? "high" : "medium",
      provider: "openai",
      aiEnabled: true,
      fallbackCategory: rulesResult.category,
      matchedKeywords: rulesResult.matchedKeywords,
    };
  }

  return {
    ok: true,
    ...rulesResult,
    aiEnabled: isAiEnabled(),
  };
}

async function generateSupportReply({ category, urgency, messageText }) {
  const safeCategory = sanitizeCategory(category);
  const safeUrgency = sanitizeUrgency(urgency || computeUrgency(safeCategory, messageText));

  if (isAiEnabled()) {
    const aiArtifacts = await generateAiSupportArtifacts({
      messageText,
      userEmail: "",
    });
    if (aiArtifacts?.replyDraft) {
      return {
        ok: true,
        category: aiArtifacts.category || safeCategory,
        urgency: aiArtifacts.urgency || safeUrgency,
        replyDraft: aiArtifacts.replyDraft,
        provider: aiArtifacts.provider,
        aiEnabled: true,
      };
    }
  }

  return {
    ok: true,
    category: safeCategory,
    urgency: safeUrgency,
    replyDraft: buildFallbackReply({ category: safeCategory, urgency: safeUrgency, messageText }),
    provider: "fallback",
    aiEnabled: false,
  };
}

async function buildInternalIssueSummary({ category, urgency, messageText, userEmail }) {
  const safeCategory = sanitizeCategory(category);
  const safeUrgency = sanitizeUrgency(urgency || computeUrgency(safeCategory, messageText));

  if (isAiEnabled()) {
    const aiArtifacts = await generateAiSupportArtifacts({
      messageText,
      userEmail,
    });
    if (aiArtifacts?.internalSummary) {
      return {
        ok: true,
        category: aiArtifacts.category || safeCategory,
        urgency: aiArtifacts.urgency || safeUrgency,
        internalSummary: aiArtifacts.internalSummary,
        provider: aiArtifacts.provider,
        aiEnabled: true,
      };
    }
  }

  return {
    ok: true,
    category: safeCategory,
    urgency: safeUrgency,
    internalSummary: buildFallbackInternalSummary({
      category: safeCategory,
      urgency: safeUrgency,
      messageText,
      userEmail,
    }),
    provider: "fallback",
    aiEnabled: false,
  };
}

function getAgentIssueModel() {
  try {
    return require("../models/AgentIssue");
  } catch (_) {
    return null;
  }
}

async function saveSupportIssueRecord({
  userEmail,
  category,
  urgency,
  originalMessage,
  replyDraft,
  internalSummary,
  source = "manual",
  metadata = {},
}) {
  const AgentIssue = getAgentIssueModel();
  if (!AgentIssue || mongoose.connection.readyState !== 1) {
    return {
      ok: false,
      saved: false,
      reason: "database_unavailable",
    };
  }

  try {
    const issue = await AgentIssue.create({
      userEmail: userEmail || "",
      category: sanitizeCategory(category),
      urgency: sanitizeUrgency(urgency),
      originalMessage: normalizeMessageText(originalMessage),
      replyDraft: replyDraft || "",
      internalSummary: internalSummary || "",
      source,
      metadata,
    });

    return {
      ok: true,
      saved: true,
      issueId: String(issue._id),
    };
  } catch (err) {
    logger.warn("Unable to save support issue record.", err?.message || err);
    return {
      ok: false,
      saved: false,
      reason: "save_failed",
    };
  }
}

async function triageSupportIssue({ messageText, userEmail = "", source = "manual", saveToDb = false } = {}) {
  const classification = await classifySupportIssue(messageText);
  const category = sanitizeCategory(classification.category);
  const urgency = sanitizeUrgency(classification.urgency);

  const [replyResult, summaryResult] = await Promise.all([
    generateSupportReply({ category, urgency, messageText }),
    buildInternalIssueSummary({ category, urgency, messageText, userEmail }),
  ]);

  const payload = {
    ok: Boolean(classification.ok),
    category,
    urgency,
    replyDraft: replyResult.replyDraft,
    internalSummary: summaryResult.internalSummary,
    provider: classification.provider || "fallback",
    aiEnabled: getAiStatus().enabled,
    saved: false,
  };

  if (saveToDb) {
    const saveResult = await saveSupportIssueRecord({
      userEmail,
      category,
      urgency,
      originalMessage: messageText,
      replyDraft: payload.replyDraft,
      internalSummary: payload.internalSummary,
      source,
      metadata: {
        classificationProvider: classification.provider || "fallback",
        confidence: classification.confidence || "unknown",
      },
    });
    payload.saved = Boolean(saveResult.saved);
    if (saveResult.issueId) payload.issueId = saveResult.issueId;
    if (saveResult.reason && !saveResult.saved) payload.saveReason = saveResult.reason;
  }

  return payload;
}

module.exports = {
  SUPPORT_CATEGORIES,
  URGENCY_LEVELS,
  buildInternalIssueSummary,
  classifySupportIssue,
  generateSupportReply,
  saveSupportIssueRecord,
  triageSupportIssue,
};
