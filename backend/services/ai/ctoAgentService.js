const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const AgentIssue = require("../../models/AgentIssue");
const CtoAgentRun = require("../../models/CtoAgentRun");
const { createJsonChatCompletion } = require("../../ai/config");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CTO_MODEL = process.env.OPENAI_CTO_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

const CATEGORY_ALIASES = Object.freeze({
  login: "login",
  password_reset: "login",
  login_access: "login",
  auth: "login",
  hire_flow: "hire_flow",
  profile_save: "profile_save",
  profile_photo_upload: "profile_save",
  dashboard_load: "dashboard_load",
  case_posting: "case_posting",
  messaging: "messaging",
  message_send: "message_send",
  payment: "payment",
  payment_action: "payment_action",
  stripe: "stripe_onboarding",
  stripe_onboarding: "stripe_onboarding",
  account_approval: "account_approval",
  admin_permissions: "admin_permissions",
  ui_interaction: "ui_interaction",
  unknown: "unknown",
});

const HIGH_RISK_CATEGORIES = new Set([
  "login",
  "payment",
  "payment_action",
  "stripe_onboarding",
  "messaging",
  "message_send",
  "account_approval",
  "admin_permissions",
]);

const ACTION_LABEL_PATTERNS = Object.freeze([
  { category: "hire_flow", patterns: [/confirm hire/i, /\bhire\b/i, /approve and continue/i] },
  { category: "profile_save", patterns: [/save profile/i, /save changes/i, /update profile/i] },
  { category: "message_send", patterns: [/send message/i, /\bsend\b/i, /reply/i] },
  { category: "payment_action", patterns: [/pay now/i, /fund case/i, /confirm payment/i, /checkout/i] },
  { category: "login", patterns: [/sign in/i, /log in/i, /reset password/i] },
]);

const ACTION_PHRASE_PATTERNS = Object.freeze([
  { category: "hire_flow", patterns: [/confirm hire/i, /\bhire\b/i, /fund case immediately/i] },
  { category: "profile_save", patterns: [/save (?:my )?profile/i, /save changes/i, /profile (?:won'?t|will not|doesn'?t) save/i] },
  { category: "message_send", patterns: [/send (?:a )?message/i, /can'?t send messages?/i, /reply won'?t send/i] },
  { category: "payment_action", patterns: [/fund case/i, /payment button/i, /checkout/i, /complete payment/i] },
  { category: "login", patterns: [/can'?t log in/i, /cannot log in/i, /session expired/i] },
]);

const DASHBOARD_LOAD_PATTERNS = Object.freeze([
  /dashboard blank/i,
  /blank dashboard/i,
  /blank screen/i,
  /white screen/i,
  /dashboard (?:won'?t|doesn'?t|will not) load/i,
  /loading forever/i,
  /stuck loading/i,
  /page is blank/i,
]);

const CATEGORY_PATTERNS = [
  {
    category: "login",
    patterns: [
      /can'?t log in/i,
      /cannot log in/i,
      /unable to log in/i,
      /unable to login/i,
      /\blogin\b/i,
      /\bsign in\b/i,
      /password reset/i,
      /reset link/i,
      /session/i,
      /access denied/i,
      /unauthorized/i,
    ],
  },
  {
    category: "profile_save",
    patterns: [
      /save (?:my )?profile/i,
      /profile (?:won'?t|doesn'?t|will not) save/i,
      /can'?t save/i,
      /cannot save/i,
      /profile update/i,
      /settings (?:won'?t|doesn'?t|will not) save/i,
      /upload(?:ing)? (?:my )?(?:profile )?photo/i,
    ],
  },
  {
    category: "dashboard_load",
    patterns: [
      ...DASHBOARD_LOAD_PATTERNS,
    ],
  },
  {
    category: "hire_flow",
    patterns: [
      /confirm hire/i,
      /\bhire\b/i,
      /fund case immediately/i,
      /approve and continue/i,
      /unable to finalize hire/i,
    ],
  },
  {
    category: "case_posting",
    patterns: [
      /post (?:a )?case/i,
      /case posting/i,
      /create case/i,
      /submit case/i,
      /job post/i,
      /application/i,
      /hire flow/i,
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
    category: "message_send",
    patterns: [
      /send (?:a )?message/i,
      /message won'?t send/i,
      /reply won'?t send/i,
      /can'?t send messages?/i,
      /cannot send messages?/i,
    ],
  },
  {
    category: "payment",
    patterns: [
      /payment/i,
      /checkout/i,
      /billing/i,
      /refund/i,
      /charge/i,
      /escrow/i,
      /payout/i,
      /withdrawal/i,
      /stripe/i,
    ],
  },
  {
    category: "payment_action",
    patterns: [
      /pay now/i,
      /fund case/i,
      /confirm payment/i,
      /payment button/i,
      /checkout button/i,
    ],
  },
  {
    category: "stripe_onboarding",
    patterns: [
      /stripe connect/i,
      /connect account/i,
      /charges enabled/i,
      /payouts enabled/i,
      /bank account/i,
      /onboard/i,
    ],
  },
  {
    category: "account_approval",
    patterns: [
      /approval/i,
      /approved/i,
      /pending approval/i,
      /verify my account/i,
      /admin permissions/i,
      /permission/i,
      /role mismatch/i,
    ],
  },
  {
    category: "ui_interaction",
    patterns: [
      /button/i,
      /click/i,
      /tap/i,
      /nothing happens/i,
      /not working/i,
      /doesn'?t work/i,
      /won'?t work/i,
    ],
  },
];

const PAGE_FILE_MAP = Object.freeze({
  "/login.html": [
    "frontend/login.html",
    "frontend/assets/scripts/login.js",
    "frontend/assets/scripts/auth.js",
    "backend/routes/auth.js",
    "backend/utils/verifyToken.js",
  ],
  "/profile-attorney.html": [
    "frontend/profile-attorney.html",
    "frontend/assets/scripts/profile-attorney.js",
    "frontend/assets/scripts/profile.js",
    "backend/routes/users.js",
    "backend/routes/account.js",
    "backend/routes/uploads.js",
  ],
  "/profile-paralegal.html": [
    "frontend/profile-paralegal.html",
    "frontend/assets/scripts/profile-paralegal.js",
    "frontend/assets/scripts/profile.js",
    "backend/routes/users.js",
    "backend/routes/account.js",
    "backend/routes/uploads.js",
  ],
  "/profile-settings.html": [
    "frontend/profile-settings.html",
    "frontend/assets/scripts/profile-settings.js",
    "frontend/assets/scripts/profile.js",
    "backend/routes/account.js",
    "backend/routes/users.js",
  ],
  "/dashboard-attorney.html": [
    "frontend/dashboard-attorney.html",
    "frontend/assets/scripts/attorney-dashboard.js",
    "backend/routes/attorneyDashboard.js",
    "backend/routes/auth.js",
  ],
  "/dashboard-paralegal.html": [
    "frontend/dashboard-paralegal.html",
    "frontend/assets/scripts/paralegal-dashboard.js",
    "backend/routes/paralegalDashboard.js",
    "backend/routes/auth.js",
  ],
  "/create-case.html": [
    "frontend/create-case.html",
    "frontend/assets/scripts/create-case-nav.js",
    "backend/routes/cases.js",
    "backend/routes/caseDrafts.js",
  ],
  "/create-case-step2.html": [
    "frontend/create-case-step2.html",
    "frontend/assets/scripts/create-case-nav.js",
    "backend/routes/cases.js",
    "backend/routes/caseDrafts.js",
  ],
  "/create-case-step5.html": [
    "frontend/create-case-step5.html",
    "frontend/assets/scripts/create-case-nav.js",
    "backend/routes/cases.js",
    "backend/routes/caseDrafts.js",
  ],
  "/case-detail.html": [
    "frontend/case-detail.html",
    "frontend/assets/scripts/case-detail.js",
    "frontend/assets/scripts/views/case-detail.js",
    "backend/routes/cases.js",
    "backend/routes/messages.js",
  ],
  "/case-applications.html": [
    "frontend/case-applications.html",
    "frontend/assets/scripts/case-applications.js",
    "backend/routes/cases.js",
    "backend/routes/applications.js",
  ],
  "/admin-dashboard.html": [
    "frontend/admin-dashboard.html",
    "frontend/assets/scripts/admin-dashboard.js",
    "frontend/assets/scripts/admin.js",
    "backend/routes/admin.js",
    "backend/routes/adminApprovals.js",
  ],
});

const CATEGORY_FILE_MAP = Object.freeze({
  login: {
    backendAreasToCheck: [
      "Auth route handling and session creation",
      "JWT verification and role gating",
      "Two-factor and approval-state checks",
    ],
    frontendAreasToCheck: [
      "Login form submission and disabled-state handling",
      "Client auth bootstrap and redirect logic",
    ],
    files: [
      "frontend/login.html",
      "frontend/assets/scripts/login.js",
      "frontend/assets/scripts/auth.js",
      "backend/routes/auth.js",
      "backend/utils/verifyToken.js",
    ],
  },
  hire_flow: {
    backendAreasToCheck: [
      "Case hire route and attorney authorization checks",
      "Funding and payment prerequisites inside the hire flow",
      "Hire state persistence and post-hire status updates",
    ],
    frontendAreasToCheck: [
      "Hire button click handler and modal binding",
      "Confirm-hire modal state and disabled-state logic",
      "Silent frontend exceptions before the hire API call",
    ],
    files: [
      "frontend/assets/scripts/attorney-tabs.js",
      "frontend/assets/scripts/views/case-detail.js",
      "frontend/case-detail.html",
      "frontend/dashboard-attorney.html",
      "backend/routes/cases.js",
      "backend/routes/payments.js",
      "backend/models/Case.js",
    ],
  },
  profile_save: {
    backendAreasToCheck: [
      "Profile update route validation and persistence",
      "Upload validation for profile assets",
      "Account/session checks before save",
    ],
    frontendAreasToCheck: [
      "Profile form submit handlers",
      "Client-side validation and payload shaping",
      "Disabled button or upload-state handling",
    ],
    files: [
      "frontend/profile-attorney.html",
      "frontend/profile-paralegal.html",
      "frontend/profile-settings.html",
      "frontend/assets/scripts/profile-attorney.js",
      "frontend/assets/scripts/profile-paralegal.js",
      "frontend/assets/scripts/profile-settings.js",
      "frontend/assets/scripts/profile.js",
      "backend/routes/users.js",
      "backend/routes/account.js",
      "backend/routes/uploads.js",
    ],
  },
  dashboard_load: {
    backendAreasToCheck: [
      "Dashboard data routes and auth checks",
      "Role-based query guards",
    ],
    frontendAreasToCheck: [
      "Dashboard bootstrapping fetches",
      "Render path after failed API load",
      "Client auth redirect logic",
    ],
    files: [
      "frontend/dashboard-attorney.html",
      "frontend/dashboard-paralegal.html",
      "frontend/assets/scripts/attorney-dashboard.js",
      "frontend/assets/scripts/paralegal-dashboard.js",
      "backend/routes/attorneyDashboard.js",
      "backend/routes/paralegalDashboard.js",
      "backend/routes/auth.js",
    ],
  },
  case_posting: {
    backendAreasToCheck: [
      "Case creation and draft route validation",
      "Role and funding prerequisites",
      "Case persistence and follow-up mutations",
    ],
    frontendAreasToCheck: [
      "Create-case navigation and step submission",
      "Client payload shape and step gating",
    ],
    files: [
      "frontend/create-case.html",
      "frontend/create-case-step2.html",
      "frontend/create-case-step5.html",
      "frontend/assets/scripts/create-case-nav.js",
      "backend/routes/cases.js",
      "backend/routes/caseDrafts.js",
      "backend/models/Case.js",
    ],
  },
  messaging: {
    backendAreasToCheck: [
      "Message send route and permissions",
      "Thread lookup and case access checks",
      "Message persistence and notification side effects",
    ],
    frontendAreasToCheck: [
      "Chat/thread bootstrapping",
      "Send-message handler and optimistic UI state",
    ],
    files: [
      "frontend/case-detail.html",
      "frontend/assets/scripts/views/chat.js",
      "frontend/assets/scripts/case-detail.js",
      "backend/routes/messages.js",
      "backend/routes/chat.js",
      "backend/models/Message.js",
    ],
  },
  message_send: {
    backendAreasToCheck: [
      "Message send route and permissions",
      "Thread lookup and case access checks",
      "Message persistence and notification side effects",
    ],
    frontendAreasToCheck: [
      "Send-message click handler and composer submit logic",
      "Disabled-state or silent validation branch before send",
      "Thread state refresh after send",
    ],
    files: [
      "frontend/assets/scripts/views/chat.js",
      "frontend/assets/scripts/case-detail.js",
      "frontend/case-detail.html",
      "backend/routes/messages.js",
      "backend/routes/chat.js",
      "backend/models/Message.js",
    ],
  },
  payment: {
    backendAreasToCheck: [
      "Payment route validation and state transitions",
      "Stripe webhook state sync",
      "Escrow, payout, or withdrawal side effects",
    ],
    frontendAreasToCheck: [
      "Payment submit flow and client error handling",
      "Stripe connect helper usage",
    ],
    files: [
      "frontend/assets/scripts/payments.js",
      "frontend/assets/scripts/utils/stripe-connect.js",
      "backend/routes/payments.js",
      "backend/routes/stripe.js",
      "backend/routes/paymentsWebhook.js",
    ],
  },
  payment_action: {
    backendAreasToCheck: [
      "Payment action route validation and authorization",
      "Funding prerequisites and money-state transitions",
      "Stripe request/response handling around the exact action",
    ],
    frontendAreasToCheck: [
      "Payment CTA click handler and disabled-state logic",
      "Client-side request payload and error handling",
    ],
    files: [
      "frontend/assets/scripts/payments.js",
      "frontend/assets/scripts/utils/stripe-connect.js",
      "backend/routes/payments.js",
      "backend/routes/stripe.js",
      "backend/routes/paymentsWebhook.js",
    ],
  },
  stripe_onboarding: {
    backendAreasToCheck: [
      "Stripe Connect account-link generation",
      "Stripe account state refresh and requirement checks",
      "Webhook synchronization with LPC status flags",
    ],
    frontendAreasToCheck: [
      "Stripe connect CTA wiring and redirect handling",
      "Founder-facing blocked-state messaging",
    ],
    files: [
      "frontend/assets/scripts/payments.js",
      "frontend/assets/scripts/utils/stripe-connect.js",
      "backend/routes/stripe.js",
      "backend/routes/payments.js",
      "backend/routes/paymentsWebhook.js",
    ],
  },
  account_approval: {
    backendAreasToCheck: [
      "Approval-state guards and admin permission enforcement",
      "Role transitions and visibility checks",
    ],
    frontendAreasToCheck: [
      "Approval-state messaging on gated pages",
      "Dashboard bootstrap behavior when approval is pending",
    ],
    files: [
      "frontend/admin-dashboard.html",
      "frontend/assets/scripts/admin-dashboard.js",
      "backend/routes/admin.js",
      "backend/routes/adminApprovals.js",
      "backend/routes/auth.js",
      "backend/routes/users.js",
    ],
  },
  admin_permissions: {
    backendAreasToCheck: [
      "Admin route role enforcement",
      "Approval and access guard middleware",
    ],
    frontendAreasToCheck: [
      "Admin surface boot logic after access denial",
    ],
    files: [
      "frontend/admin-dashboard.html",
      "frontend/assets/scripts/admin-dashboard.js",
      "backend/routes/admin.js",
      "backend/routes/adminApprovals.js",
      "backend/routes/adminKnowledge.js",
      "backend/routes/adminMarketing.js",
      "backend/routes/adminSupport.js",
      "backend/utils/verifyToken.js",
    ],
  },
  ui_interaction: {
    backendAreasToCheck: [
      "Route availability for the intended action",
      "CSRF/auth blockers behind the clicked action",
    ],
    frontendAreasToCheck: [
      "Event binding on the page script",
      "Disabled-state logic or missing click handler",
      "Runtime JS errors before the handler attaches",
    ],
    files: [
      "frontend/assets/scripts/login.js",
      "frontend/assets/scripts/profile.js",
      "frontend/assets/scripts/create-case-nav.js",
      "frontend/assets/scripts/case-detail.js",
      "frontend/assets/scripts/admin-dashboard.js",
    ],
  },
  unknown: {
    backendAreasToCheck: ["Related route validation and auth guards"],
    frontendAreasToCheck: ["Page bootstrap and event-binding path"],
    files: [],
  },
});

function compactText(value = "", max = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function uniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => compactText(value, 4000)).filter(Boolean)));
}

function fileExists(relativePath = "") {
  if (!relativePath) return false;
  return fs.existsSync(path.join(REPO_ROOT, relativePath));
}

function existingPaths(paths = []) {
  return uniqueStrings(paths).filter((item) => fileExists(item));
}

function normalizeCategory(category = "") {
  const safe = String(category || "").trim().toLowerCase().replace(/\s+/g, "_");
  return CATEGORY_ALIASES[safe] || "unknown";
}

function normalizeUrgency(urgency = "") {
  const safe = String(urgency || "").trim().toLowerCase();
  return ["critical", "high", "medium", "low"].includes(safe) ? safe : "medium";
}

function normalizeIssueText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\bwon?t\b/gi, "won't")
    .trim();
}

function dbReady() {
  return mongoose.connection.readyState === 1;
}

async function loadIssueRecord(issueId = "") {
  const id = String(issueId || "").trim();
  if (!id) return null;
  if (!dbReady()) return null;
  if (!mongoose.isValidObjectId(id)) {
    const error = new Error("Invalid AgentIssue id.");
    error.statusCode = 400;
    throw error;
  }
  const issue = await AgentIssue.findById(id).lean();
  if (!issue) {
    const error = new Error("AgentIssue not found.");
    error.statusCode = 404;
    throw error;
  }
  return issue;
}

function inferCategoryFromText(text = "") {
  const message = normalizeIssueText(text);
  for (const rule of CATEGORY_PATTERNS) {
    if (rule.patterns.some((pattern) => pattern.test(message))) {
      return rule.category;
    }
  }
  return "unknown";
}

function matchesAny(text = "", patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function detectActionCategory({ buttonLabel = "", originalMessage = "", internalSummary = "" } = {}) {
  const labelText = normalizeIssueText(buttonLabel);
  const combinedText = normalizeIssueText(`${originalMessage} ${internalSummary}`);

  if (labelText) {
    for (const rule of ACTION_LABEL_PATTERNS) {
      if (matchesAny(labelText, rule.patterns)) return rule.category;
    }
  }

  for (const rule of ACTION_PHRASE_PATTERNS) {
    if (matchesAny(combinedText, rule.patterns)) return rule.category;
  }

  return "";
}

function detectPageCategory({ page = "", originalMessage = "", internalSummary = "" } = {}) {
  const pagePath = String(page || "").trim();
  const combinedText = normalizeIssueText(`${originalMessage} ${internalSummary}`);

  if (matchesAny(combinedText, DASHBOARD_LOAD_PATTERNS)) return "dashboard_load";
  if (/dashboard/i.test(pagePath) && matchesAny(combinedText, [/blank/i, /white screen/i, /won'?t load/i, /stuck loading/i])) {
    return "dashboard_load";
  }
  if (/profile/i.test(pagePath)) return "profile_save";
  if (/case-detail|case-applications/i.test(pagePath)) return "hire_flow";
  if (/login/i.test(pagePath)) return "login";
  return "";
}

function inferTechnicalSeverity({ category = "", urgency = "medium", messageText = "", metadata = {} } = {}) {
  const normalizedCategory = normalizeCategory(category);
  const normalizedUrgency = normalizeUrgency(urgency);
  const text = `${normalizeIssueText(messageText)} ${JSON.stringify(metadata || {})}`.toLowerCase();

  if (normalizedUrgency === "critical") return "critical";
  if (
    HIGH_RISK_CATEGORIES.has(normalizedCategory) &&
    (normalizedUrgency === "high" || /blank|down|cannot|can't|blocked|payment|stripe|auth|permission/.test(text))
  ) {
    return "high";
  }
  if (normalizedUrgency === "high") return HIGH_RISK_CATEGORIES.has(normalizedCategory) ? "high" : "medium";
  if (normalizedCategory === "dashboard_load" && /blank|white screen|load/.test(text)) return "high";
  if (normalizedCategory === "hire_flow" || normalizedCategory === "message_send") return "medium";
  if (normalizedCategory === "ui_interaction") return "medium";
  return normalizedUrgency === "low" ? "low" : "medium";
}

function pageContextPaths(page = "") {
  const safe = String(page || "").trim();
  if (!safe) return [];
  const pathname = safe.startsWith("/") ? safe : `/${safe}`;
  return PAGE_FILE_MAP[pathname] || [];
}

function issueSignals({ category = "", messageText = "", metadata = {} } = {}) {
  const text = `${normalizeIssueText(messageText)} ${JSON.stringify(metadata || {})}`.toLowerCase();
  return {
    mentionsButton: /\bbutton\b|\bclick\b|\bnothing happens\b/.test(text),
    mentionsBlankPage: /\bblank\b|\bwhite screen\b|\bwon't load\b|\bstuck loading\b/.test(text),
    mentionsSave: /\bsave\b|\bupdate\b/.test(text),
    mentionsSession: /\bsession\b|\blogin\b|\bauth\b|\bunauthorized\b|\baccess denied\b/.test(text),
    mentionsStripe: /\bstripe\b|\bconnect\b|\bcharges enabled\b|\bpayouts enabled\b/.test(text),
    mentionsMessaging: /\bmessage\b|\bchat\b|\bthread\b|\binbox\b/.test(text),
    category: normalizeCategory(category),
  };
}

function buildLikelyRootCauses({ category = "", messageText = "", metadata = {} } = {}) {
  const normalizedCategory = normalizeCategory(category);
  const signals = issueSignals({ category: normalizedCategory, messageText, metadata });
  const roots = [];

  if (normalizedCategory === "login") {
    roots.push(
      "Likely auth/session gate failure rather than a confirmed credential problem.",
      "Possible mismatch between login success and the follow-on role or approval-state redirect.",
      "Possible token, cookie, or two-factor branch leaving the client in an unauthenticated state."
    );
  }
  if (normalizedCategory === "profile_save") {
    roots.push(
      "Likely client-side validation or disabled-submit-state issue on the profile form.",
      "Possible backend validation or upload rule rejection during profile persistence.",
      "Possible expired session or auth guard blocking the save request."
    );
  }
  if (normalizedCategory === "dashboard_load") {
    roots.push(
      "Likely dashboard bootstrap fetch failure or auth-protected API returning an unexpected response.",
      "Possible client render exception after an empty or malformed payload.",
      "Possible role mismatch causing the wrong dashboard path to load."
    );
  }
  if (normalizedCategory === "hire_flow") {
    roots.push(
      "Likely missing or broken hire-button click handler before the confirm flow completes.",
      "Possible confirm-hire modal binding or state transition failure before the API call fires.",
      "Possible auth, attorney-ownership, or funding guard blocking the hire request.",
      "Possible silent frontend exception during the hire modal or confirm action."
    );
  }
  if (normalizedCategory === "case_posting") {
    roots.push(
      "Likely case-create step validation mismatch between frontend payload and backend requirements.",
      "Possible route-level guard blocking the case submission due to role or funding prerequisites.",
      "Possible regression in multi-step case navigation state."
    );
  }
  if (normalizedCategory === "messaging") {
    roots.push(
      "Likely permissions or case-access check blocking message send or thread load.",
      "Possible send-message handler failure in the case-detail or chat client script.",
      "Possible server-side thread lookup or persistence error."
    );
  }
  if (normalizedCategory === "message_send") {
    roots.push(
      "Likely send-button click handler or composer submit branch failing before the API request.",
      "Possible permissions or thread-access check blocking the send action.",
      "Possible silent client exception or disabled-state branch preventing submission."
    );
  }
  if (normalizedCategory === "payment") {
    roots.push(
      "Likely payment-state mismatch or Stripe-related backend failure in payout, escrow, or checkout logic.",
      "Possible webhook synchronization gap leaving LPC state stale after Stripe changes.",
      "Possible permissions or case-status guard blocking the money workflow."
    );
  }
  if (normalizedCategory === "payment_action") {
    roots.push(
      "Likely payment CTA click handler or request payload mismatch on the exact payment action.",
      "Possible backend authorization, validation, or funding prerequisite blocking the action.",
      "Possible Stripe-related API failure or stale payment state after the action is triggered."
    );
  }
  if (normalizedCategory === "stripe_onboarding") {
    roots.push(
      "Likely Stripe Connect onboarding state mismatch rather than a confirmed Stripe platform outage.",
      "Possible failure generating or refreshing the account-link flow.",
      "Possible stale requirements or webhook sync leaving the UI blocked."
    );
  }
  if (normalizedCategory === "account_approval" || normalizedCategory === "admin_permissions") {
    roots.push(
      "Likely approval-state or role-guard mismatch in admin-protected routes.",
      "Possible user-status transition not propagating cleanly to access checks.",
      "Possible frontend surface showing an action the backend still blocks."
    );
  }
  if (normalizedCategory === "ui_interaction" || signals.mentionsButton) {
    roots.push(
      "Likely missing or broken click handler on the relevant page script.",
      "Possible disabled-state, overlay, or validation branch preventing the intended action from firing.",
      "Possible runtime JavaScript error before the interaction handler attaches."
    );
  }
  if (!roots.length) {
    roots.push(
      "Likely mismatch between the frontend interaction path and the backend route or validation logic.",
      "Possible auth or state gate blocking the intended action.",
      "Possible recent regression in the page-specific client script."
    );
  }
  return uniqueStrings(roots).slice(0, 5);
}

function buildAreaMapping({ category = "", metadata = {}, messageText = "" } = {}) {
  const normalizedCategory = normalizeCategory(category);
  const categoryMap = CATEGORY_FILE_MAP[normalizedCategory] || CATEGORY_FILE_MAP.unknown;
  const pageFiles = pageContextPaths(metadata?.page || metadata?.routePath || metadata?.pagePath || "");
  const filesToInspect = existingPaths([...categoryMap.files, ...pageFiles]);
  const backendAreasToCheck = uniqueStrings(categoryMap.backendAreasToCheck || []);
  const frontendAreasToCheck = uniqueStrings(categoryMap.frontendAreasToCheck || []);
  const likelyAffectedAreas = uniqueStrings([
    ...backendAreasToCheck,
    ...frontendAreasToCheck,
    metadata?.page ? `Page context: ${metadata.page}` : "",
    metadata?.buttonLabel ? `User-reported interaction: ${metadata.buttonLabel}` : "",
    metadata?.role ? `Role path: ${metadata.role}` : "",
  ]).filter((value) => value !== "unknown");

  return {
    filesToInspect,
    backendAreasToCheck,
    frontendAreasToCheck,
    likelyAffectedAreas,
  };
}

function buildRecommendedFixStrategy({ category = "", filesToInspect = [], metadata = {} } = {}) {
  const normalizedCategory = normalizeCategory(category);
  const page = metadata?.page ? ` on ${metadata.page}` : "";
  const firstFiles = filesToInspect.slice(0, 4).join(", ");

  if (normalizedCategory === "login") {
    return `Start by reproducing the login path${page} with the reported role and checking whether the client submits successfully but the auth/session flow breaks on redirect. Inspect the auth route, token/cookie handling, and any approval-state or two-factor gates before changing client messaging. Use the page script only after confirming whether the backend response and session state are coherent. Relevant files: ${firstFiles || "auth and login files"} .`;
  }
  if (normalizedCategory === "profile_save") {
    return `Reproduce the reported save flow${page} with the same role, then inspect whether the submit handler, validation branch, or upload step prevents the request from reaching the backend. If the request is sent, inspect backend validation and auth/session behavior before changing UI state. Keep the fix narrow: restore one clean save path and add regression coverage around the exact form flow. Relevant files: ${firstFiles || "profile save files"} .`;
  }
  if (normalizedCategory === "dashboard_load") {
    return `Reproduce the dashboard bootstrap${page} and inspect the first failed API call or client exception before changing render logic. Confirm whether the user role, approval state, or auth token causes the wrong dashboard path or an empty payload. Keep the fix focused on the failing bootstrap branch and add a regression check for the same role and page. Relevant files: ${firstFiles || "dashboard files"} .`;
  }
  if (normalizedCategory === "hire_flow") {
    return `Reproduce the hire confirmation path${page} with the reported role and inspect whether the hire button, confirm-hire modal, or final API call breaks first. Confirm whether the failure is a missing click binding, a disabled-state/modal-state bug, or a backend attorney/funding guard on the hire route. Keep the fix narrow to the hire-confirm path and add regression coverage around both the modal flow and the hire request. Relevant files: ${firstFiles || "hire flow files"} .`;
  }
  if (normalizedCategory === "stripe_onboarding" || normalizedCategory === "payment") {
    return `Treat this as a high-risk money path. Reproduce with a safe test account, inspect the Stripe/connect route behavior, and confirm whether the failure is in link generation, requirements sync, webhook state, or LPC-side gating. Do not widen the fix into unrelated payments logic. Add regression checks around the same money flow before considering deployment. Relevant files: ${firstFiles || "payments files"} .`;
  }
  if (normalizedCategory === "messaging") {
    return `Reproduce the messaging flow${page} using the reported role and case context, then inspect thread load and send-message behavior end to end. Confirm permissions, case access, and message persistence before changing client-side UI assumptions. Keep the patch narrow to the failing send or load path and add regression checks for both participants. Relevant files: ${firstFiles || "messaging files"} .`;
  }
  if (normalizedCategory === "message_send") {
    return `Reproduce the exact send-message action${page} and inspect whether the button click, composer submit branch, or message API call fails first. Confirm permissions and thread access before changing UI assumptions, and keep the patch scoped to the send action rather than the broader messaging surface. Add regression checks for both thread load and successful send. Relevant files: ${firstFiles || "message send files"} .`;
  }
  if (normalizedCategory === "payment_action") {
    return `Treat this as a focused payment-action issue${page}. Reproduce the exact CTA flow, inspect the button click and client payload, then confirm whether the backend route or Stripe action is rejecting the request. Do not widen the patch into broader billing logic. Add regression coverage for the same money action before any deploy recommendation. Relevant files: ${firstFiles || "payment action files"} .`;
  }
  if (normalizedCategory === "case_posting") {
    return `Reproduce the case-posting path${page} step by step and identify whether the failure is in client validation, multi-step state, or backend route validation. Confirm any role or funding prerequisite gates before changing the form flow. Keep the fix scoped to the failing step and add a regression check for the same create-case path. Relevant files: ${firstFiles || "case posting files"} .`;
  }
  return `Reproduce the reported issue${page} and inspect the page-specific client script together with the most likely backend route or validation guard. Confirm whether the interaction fails before the request, during route handling, or after a partial success. Keep the patch narrow, grounded in the first failing path, and add regression coverage around the same surface. Relevant files: ${firstFiles || "page and route files"} .`;
}

function buildTestPlan({ category = "", metadata = {}, urgency = "medium" } = {}) {
  const normalizedCategory = normalizeCategory(category);
  const role = metadata?.role ? ` as a ${metadata.role}` : "";
  const page = metadata?.page || metadata?.routePath || "the reported surface";
  const plan = [
    `Reproduce the issue on ${page}${role} using the same visible flow the user described.`,
    "Capture whether the failure occurs before the network request, at the API layer, or after a partial success response.",
  ];

  if (normalizedCategory === "login") {
    plan.push(
      "Verify successful login creates the expected session and redirects to the correct role-specific dashboard.",
      "Regression check password-reset and approval-gated login branches without changing unrelated auth flows."
    );
  } else if (normalizedCategory === "profile_save") {
    plan.push(
      "Verify the relevant profile form saves successfully and persisted values re-render after reload.",
      "Regression check upload-related validation and save behavior for the same role."
    );
  } else if (normalizedCategory === "dashboard_load") {
    plan.push(
      "Verify the dashboard renders with real data and no blank state or console error after refresh.",
      "Regression check the alternate role dashboard still boots correctly."
    );
  } else if (normalizedCategory === "hire_flow") {
    plan.push(
      "Verify the hire CTA opens and advances through the confirm-hire flow without a silent failure.",
      "Regression check the final hire request succeeds or fails with a truthful guard message instead of doing nothing."
    );
  } else if (normalizedCategory === "stripe_onboarding" || normalizedCategory === "payment") {
    plan.push(
      "Use a safe test Stripe path to verify the same onboarding or payment state completes without introducing duplicate charges or state drift.",
      "Regression check the surrounding money path remains approval-first and does not mutate unrelated records."
    );
  } else if (normalizedCategory === "messaging") {
    plan.push(
      "Verify both thread load and message send succeed for the intended case participants.",
      "Regression check another existing conversation still renders and sends normally."
    );
  } else if (normalizedCategory === "message_send") {
    plan.push(
      "Verify the send-message CTA actually submits and the message appears in the thread.",
      "Regression check thread load and an adjacent existing conversation still work normally."
    );
  } else if (normalizedCategory === "payment_action") {
    plan.push(
      "Verify the exact payment action completes or surfaces a truthful guarded error without duplicating money movement.",
      "Regression check the surrounding payment flow remains unchanged."
    );
  } else if (normalizedCategory === "case_posting") {
    plan.push(
      "Verify the affected create-case step submits successfully and the created case appears in the expected dashboard list.",
      "Regression check the adjacent step navigation and validation still behave correctly."
    );
  } else {
    plan.push(
      "Verify the reported action works after the patch and that the primary button or interaction is no longer blocked.",
      "Regression check the same page for console errors and for one adjacent action on the same surface."
    );
  }

  if (normalizeUrgency(urgency) === "high") {
    plan.push("Confirm logs and monitoring stay quiet for the same path after the patch is applied.");
  }

  return uniqueStrings(plan).slice(0, 6);
}

function buildDeploymentRisk({ category = "", technicalSeverity = "medium" } = {}) {
  const normalizedCategory = normalizeCategory(category);
  if (HIGH_RISK_CATEGORIES.has(normalizedCategory)) {
    return "High: this touches an auth, money, permissions, messaging, or approval-sensitive path and must be reviewed before any deploy.";
  }
  if (technicalSeverity === "high" || technicalSeverity === "critical") {
    return "Medium to high: the issue appears user-visible enough that the patch should be reviewed with focused regression checks before deployment.";
  }
  return "Medium: still approval-first in this phase, but the likely patch surface appears narrower than an auth or money path.";
}

function buildDiagnosisSummary({ category = "", technicalSeverity = "", messageText = "", metadata = {} } = {}) {
  const normalizedCategory = normalizeCategory(category);
  const page = metadata?.page ? ` on ${metadata.page}` : "";
  const role = metadata?.role ? ` for the ${metadata.role} flow` : "";
  const issueText = compactText(messageText, 240);

  if (normalizedCategory === "ui_interaction") {
    return `The reported issue looks like a likely frontend interaction failure${page}${role}, not a confirmed backend outage. The first check should be whether the intended click handler, disabled-state branch, or API call path is failing before or after the user action. User report: "${issueText}".`;
  }
  if (normalizedCategory === "hire_flow") {
    return `This incident looks like a likely hire-flow action failure${page}${role}, not a confirmed dashboard-wide outage. The first diagnosis pass should check whether the hire button, confirm-hire modal, or final hire API call is breaking before the attorney can complete the action. User report: "${issueText}".`;
  }
  if (normalizedCategory === "message_send") {
    return `This incident looks like a likely message-send action failure${page}${role}, not a confirmed full messaging outage. The first diagnosis pass should check whether the send CTA, composer submit branch, or message API request is failing first. User report: "${issueText}".`;
  }
  if (normalizedCategory === "payment_action") {
    return `This incident looks like a likely payment-action failure${page}${role}. That is still an inference, not a confirmed Stripe or backend outage. The first diagnosis pass should inspect the exact CTA flow, the request payload, and the backend guard or Stripe response tied to that action. User report: "${issueText}".`;
  }
  return `This incident is most likely a ${normalizedCategory.replace(/_/g, " ")} problem${page}${role}. That is still an inference, not a confirmed root cause. The first diagnosis pass should trace the failing user flow, identify the first broken request or render branch, and then inspect the page-specific script and backend route that own that path. User report: "${issueText}".`;
}

function buildCodexPatchPrompt({
  category = "",
  technicalSeverity = "",
  diagnosisSummary = "",
  filesToInspect = [],
  recommendedFixStrategy = "",
  testPlan = [],
  metadata = {},
  notes = [],
} = {}) {
  const page = metadata?.page || metadata?.routePath || "reported surface";
  const role = metadata?.role || "reported user role";
  return [
    "Investigate and patch a narrow LPC production issue.",
    "",
    `Issue category: ${category}`,
    `Technical severity: ${technicalSeverity}`,
    `Reported surface: ${page}`,
    `Role: ${role}`,
    "",
    `Diagnosis summary: ${diagnosisSummary}`,
    "",
    `Inspect these files first: ${filesToInspect.join(", ") || "Use the mapped LPC files from the diagnosis packet."}`,
    "",
    `Fix strategy: ${recommendedFixStrategy}`,
    "",
    "Constraints:",
    "- Keep the fix narrow and production-minded.",
    "- Do not refactor unrelated code.",
    "- Do not change visual design unless the bug requires it.",
    "- Do not auto-deploy or add destructive data changes.",
    "- Treat inferred causes as hypotheses until confirmed in code.",
    "",
    "Required tests:",
    ...testPlan.map((item) => `- ${item}`),
    "",
    "Safety notes:",
    ...notes.map((item) => `- ${item}`),
  ].join("\n");
}

async function maybeEnrichWithAi({ issue = {}, heuristic = {} } = {}) {
  try {
    const response = await createJsonChatCompletion({
      model: CTO_MODEL,
      temperature: 0.1,
      systemPrompt:
        "You are a conservative internal CTO agent for a production web app. Return JSON only. Do not claim certainty. Distinguish likely cause from confirmed cause. Do not recommend auto-deploy. Keep advice specific to the supplied code areas.",
      userPrompt: JSON.stringify(
        {
          issue: {
            category: issue.category,
            urgency: issue.urgency,
            originalMessage: issue.originalMessage,
            internalSummary: issue.internalSummary,
            metadata: issue.metadata,
          },
          heuristic,
          request: {
            fields: [
              "diagnosisSummary",
              "likelyRootCauses",
              "recommendedFixStrategy",
              "testPlan",
              "notes",
            ],
          },
        },
        null,
        2
      ),
    });

    return {
      diagnosisSummary: compactText(response?.diagnosisSummary || "", 3500),
      likelyRootCauses: uniqueStrings(response?.likelyRootCauses || []).slice(0, 5),
      recommendedFixStrategy: compactText(response?.recommendedFixStrategy || "", 7000),
      testPlan: uniqueStrings(response?.testPlan || []).slice(0, 6),
      notes: uniqueStrings(response?.notes || []).slice(0, 6),
    };
  } catch (_) {
    return null;
  }
}

function normalizeIssuePacket({ issue = null, issueId = "", payload = {} } = {}) {
  const source = issue || payload || {};
  const originalMessage = normalizeIssueText(source.originalMessage || source.message || source.description || "");
  const internalSummary = compactText(source.internalSummary || source.summary || "", 1000);
  const explicitCategory = normalizeCategory(source.category);
  const actionCategory = detectActionCategory({
    buttonLabel: source.metadata?.buttonLabel || "",
    originalMessage,
    internalSummary,
  });
  const pageCategory = detectPageCategory({
    page: source.metadata?.page || source.metadata?.routePath || source.metadata?.pagePath || "",
    originalMessage,
    internalSummary,
  });
  const genericCategory = inferCategoryFromText(`${originalMessage} ${internalSummary}`);
  const inferredCategory = explicitCategory !== "unknown"
    ? explicitCategory
    : actionCategory || pageCategory || genericCategory;

  return {
    issueId: issue?._id ? String(issue._id) : String(issueId || source.issueId || "").trim(),
    category: inferredCategory,
    urgency: normalizeUrgency(source.urgency),
    originalMessage,
    internalSummary,
    userEmail: String(source.userEmail || "").trim().toLowerCase(),
    metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {},
    source: String(source.source || (issue ? "agent_issue" : "direct_payload") || "").trim(),
    status: String(source.status || "").trim(),
  };
}

async function persistRun({ result = {}, issueSnapshot = null, metadata = {} } = {}) {
  if (!dbReady()) {
    return { run: null, saved: false, reason: "Mongo unavailable" };
  }
  try {
    const created = await CtoAgentRun.create({
      issueId: result.issueId || null,
      category: result.category,
      urgency: result.urgency,
      technicalSeverity: result.technicalSeverity,
      diagnosisSummary: result.diagnosisSummary,
      likelyRootCauses: result.likelyRootCauses,
      likelyAffectedAreas: result.likelyAffectedAreas,
      filesToInspect: result.filesToInspect,
      backendAreasToCheck: result.backendAreasToCheck,
      frontendAreasToCheck: result.frontendAreasToCheck,
      recommendedFixStrategy: result.recommendedFixStrategy,
      codexPatchPrompt: result.codexPatchPrompt,
      testPlan: result.testPlan,
      deploymentRisk: result.deploymentRisk,
      approvalRequired: result.approvalRequired,
      canAutoDeploy: result.canAutoDeploy,
      notifyUserWhenResolved: result.notifyUserWhenResolved,
      notes: result.notes,
      sourceIssueSnapshot: issueSnapshot || {},
      metadata,
      generatedAt: result.generatedAt,
    });
    return { run: created, saved: true, reason: "" };
  } catch (err) {
    return { run: null, saved: false, reason: compactText(err?.message || "Persistence failed.", 240) };
  }
}

async function runCtoDiagnosis(input = {}) {
  const saveRun = input.saveRun === true;
  let issue = null;

  if (input.issueId) {
    issue = await loadIssueRecord(input.issueId);
  }

  const normalized = normalizeIssuePacket({
    issue,
    issueId: input.issueId,
    payload: issue ? issue : input,
  });

  if (!normalized.originalMessage && !normalized.internalSummary) {
    return {
      ok: false,
      statusCode: 400,
      error: "An issueId or issue summary/originalMessage is required.",
      issueId: normalized.issueId || "",
      runId: null,
      generatedAt: new Date().toISOString(),
    };
  }

  const technicalSeverity = inferTechnicalSeverity({
    category: normalized.category,
    urgency: normalized.urgency,
    messageText: `${normalized.originalMessage} ${normalized.internalSummary}`,
    metadata: normalized.metadata,
  });
  const areaMap = buildAreaMapping({
    category: normalized.category,
    metadata: normalized.metadata,
    messageText: normalized.originalMessage,
  });
  const baseNotes = uniqueStrings([
    "This packet is a first-pass technical diagnosis, not a confirmed root-cause report.",
    HIGH_RISK_CATEGORIES.has(normalized.category)
      ? "This touches a high-risk LPC area and should be treated as approval-required before deployment."
      : "Deployment still requires approval in this phase, even for lower-risk fixes.",
    dbReady() ? "" : "MongoDB is not connected, so the CTO run cannot be persisted in this process.",
    input.issueId && !issue ? "The requested AgentIssue could not be loaded, so the diagnosis used only direct payload fields." : "",
    "Auto-deploy is disabled for the CTO agent in this phase.",
  ]);

  const heuristic = {
    diagnosisSummary: buildDiagnosisSummary({
      category: normalized.category,
      technicalSeverity,
      messageText: normalized.internalSummary || normalized.originalMessage,
      metadata: normalized.metadata,
    }),
    likelyRootCauses: buildLikelyRootCauses({
      category: normalized.category,
      messageText: `${normalized.originalMessage} ${normalized.internalSummary}`,
      metadata: normalized.metadata,
    }),
    likelyAffectedAreas: areaMap.likelyAffectedAreas,
    filesToInspect: areaMap.filesToInspect,
    backendAreasToCheck: areaMap.backendAreasToCheck,
    frontendAreasToCheck: areaMap.frontendAreasToCheck,
    recommendedFixStrategy: buildRecommendedFixStrategy({
      category: normalized.category,
      filesToInspect: areaMap.filesToInspect,
      metadata: normalized.metadata,
    }),
    testPlan: buildTestPlan({
      category: normalized.category,
      metadata: normalized.metadata,
      urgency: normalized.urgency,
    }),
    deploymentRisk: buildDeploymentRisk({
      category: normalized.category,
      technicalSeverity,
    }),
    notes: baseNotes,
  };

  const aiEnrichment = await maybeEnrichWithAi({ issue: normalized, heuristic });
  const merged = {
    ...heuristic,
    diagnosisSummary: aiEnrichment?.diagnosisSummary || heuristic.diagnosisSummary,
    likelyRootCauses: uniqueStrings([...(aiEnrichment?.likelyRootCauses || []), ...heuristic.likelyRootCauses]).slice(0, 5),
    recommendedFixStrategy: aiEnrichment?.recommendedFixStrategy || heuristic.recommendedFixStrategy,
    testPlan: uniqueStrings([...(aiEnrichment?.testPlan || []), ...heuristic.testPlan]).slice(0, 6),
    notes: uniqueStrings([...(heuristic.notes || []), ...(aiEnrichment?.notes || []), aiEnrichment ? "AI enrichment was applied conservatively on top of repo-grounded heuristics." : "AI enrichment was not used; heuristic diagnosis only."]),
  };

  const generatedAt = new Date().toISOString();
  const result = {
    ok: true,
    issueId: normalized.issueId || "",
    runId: null,
    saved: false,
    saveSkippedReason: saveRun ? "Persistence pending" : "",
    category: normalized.category,
    urgency: normalized.urgency,
    technicalSeverity,
    diagnosisSummary: merged.diagnosisSummary,
    likelyRootCauses: merged.likelyRootCauses,
    likelyAffectedAreas: merged.likelyAffectedAreas,
    filesToInspect: merged.filesToInspect,
    backendAreasToCheck: merged.backendAreasToCheck,
    frontendAreasToCheck: merged.frontendAreasToCheck,
    recommendedFixStrategy: merged.recommendedFixStrategy,
    codexPatchPrompt: "",
    readyToApply: false,
    testPlan: merged.testPlan,
    deploymentRisk: merged.deploymentRisk,
    approvalRequired: true,
    canAutoDeploy: false,
    notifyUserWhenResolved: Boolean(normalized.userEmail),
    notes: merged.notes,
    generatedAt,
  };

  result.codexPatchPrompt = buildCodexPatchPrompt({
    category: result.category,
    technicalSeverity: result.technicalSeverity,
    diagnosisSummary: result.diagnosisSummary,
    filesToInspect: result.filesToInspect,
    recommendedFixStrategy: result.recommendedFixStrategy,
    testPlan: result.testPlan,
    metadata: normalized.metadata,
    notes: result.notes,
  });
  result.readyToApply = Boolean(result.codexPatchPrompt);

  if (saveRun) {
    const persistence = await persistRun({
      result,
      issueSnapshot: issue || normalized,
      metadata: {
        source: normalized.source,
        status: normalized.status,
        userEmail: normalized.userEmail,
        metadata: normalized.metadata,
      },
    });
    result.saved = persistence.saved === true;
    result.saveSkippedReason = persistence.saved === true ? "" : persistence.reason || "Persistence skipped.";
    if (persistence.run?._id) {
      result.runId = String(persistence.run._id);
    } else {
      result.notes = uniqueStrings([...result.notes, `Run persistence was requested but skipped: ${result.saveSkippedReason}`]);
    }
  } else {
    result.saveSkippedReason = "saveRun was false";
  }

  return result;
}

module.exports = {
  normalizeIssuePacket,
  runCtoDiagnosis,
};
