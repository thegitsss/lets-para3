const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  createSupportActionRateLimiter,
} = require("../services/support/supportActionRateLimit");
const {
  createConversationMessage,
  escalateConversation,
  findConversationForUser,
  getOrCreateOpenConversation,
  getConversationRequestOutcome,
  listConversationMessages,
  recordConversationMessageFeedback,
  restartConversation,
} = require("../services/support/conversationService");
const { subscribeToConversationEvents } = require("../services/support/liveUpdateService");
const { csrfProtection } = require("../utils/csrf");
const { requireSupportAccount } = require("../utils/supportAccountBoundary");
const { createSupportStreamAccess, attachSupportConversationStream } = require("../utils/supportStreamAccess");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// This middleware runs once per user-submitted write action. Everything after
// the boundary—tools, model retries, validation, repair, fallback, and
// telemetry—executes inside that single counted request.
const supportWriteLimiter = createSupportActionRateLimiter();

function readPageContext(req) {
  const bodyContext =
    req.body?.pageContext && typeof req.body.pageContext === "object" && !Array.isArray(req.body.pageContext)
      ? req.body.pageContext
      : {};
  const queryContext = {
    pathname: req.query.pathname,
    search: req.query.search,
    hash: req.query.hash,
    title: req.query.pageTitle,
    href: req.query.href,
    label: req.query.pageLabel,
    viewName: req.query.viewName,
    roleHint: req.query.roleHint,
    caseId: req.query.caseId,
    jobId: req.query.jobId,
    applicationId: req.query.applicationId,
    repeatViewCount: req.query.repeatViewCount,
    supportOpenCount: req.query.supportOpenCount,
    recentViewName: req.query.recentViewName,
  };
  return {
    sourcePage: req.body?.sourcePage || req.query.sourcePage || "",
    pageContext: {
      ...queryContext,
      ...bodyContext,
    },
  };
}

router.use(verifyToken, requireApproved, requireRole("admin", "attorney", "paralegal"), requireSupportAccount);

router.get(
  "/conversation",
  asyncHandler(async (req, res) => {
    const conversation = await getOrCreateOpenConversation({
      user: req.user || {},
      ...readPageContext(req),
    });
    const recoveryRequest = await require('../services/support/mutationService').activeRecovery({ user: req.user, conversationId: conversation.id });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, conversation, ...(recoveryRequest ? { recoveryRequest } : {}) });
  })
);

router.get(
  "/conversation/:id/events",
  asyncHandler(async (req, res) => {
    const conversation = await findConversationForUser(req.params.id, req.user._id);
    if (!conversation) {
      return res.status(404).json({ error: "Support conversation not found." });
    }

    const access = createSupportStreamAccess(req);
    const ownerId = String(req.user._id);
    attachSupportConversationStream({
      req, res, conversationId: conversation._id,
      subscribe: subscribeToConversationEvents,
      expiresAt: access.expiresAt,
      async verifyAccess() {
        if (!await findConversationForUser(conversation._id, ownerId)) return false;
        return access.verify();
      },
    });
  })
);

router.get(
  "/conversation/:id/messages",
  asyncHandler(async (req, res) => {
    const payload = await listConversationMessages({
      conversationId: req.params.id,
      userId: req.user._id,
    });
    if (!payload) {
      return res.status(404).json({ error: "Support conversation not found." });
    }
    res.json({ ok: true, ...payload });
  })
);

router.post(
  "/conversation/:id/messages",
  supportWriteLimiter,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) {
      return res.status(400).json({ error: "Support message text is required." });
    }

    const payload = await createConversationMessage({
      conversationId: req.params.id,
      user: req.user || {},
      text,
      requestId: req.body?.requestId,
      authSessionId: req.authSessionId,
      promptAction: req.body?.promptAction,
      ...readPageContext(req),
    });
    if (!payload) {
      return res.status(404).json({ error: "Support conversation not found." });
    }
    res.status(201).json({ ok: true, ...payload });
  })
);

router.post(
  "/conversation/:id/messages/:messageId/feedback",
  supportWriteLimiter,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const rating = String(req.body?.rating || "").trim().toLowerCase();
    if (!["helpful", "unhelpful"].includes(rating)) {
      return res.status(400).json({ error: "Feedback rating must be helpful or unhelpful." });
    }
    const message = await recordConversationMessageFeedback({
      conversationId: req.params.id,
      messageId: req.params.messageId,
      userId: req.user._id,
      rating,
      note: req.body?.note,
    });
    if (!message) {
      return res.status(404).json({ error: "Assistant message not found." });
    }
    res.json({ ok: true, message });
  })
);

router.post(
  "/conversation/:id/restart",
  supportWriteLimiter,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const payload = await restartConversation({
      conversationId: req.params.id,
      user: req.user || {},
      requestId: req.body?.requestId,
      authSessionId: req.authSessionId,
      ...readPageContext(req),
    });
    if (!payload) {
      return res.status(404).json({ error: "Support conversation not found." });
    }
    res.status(201).json({ ok: true, ...payload });
  })
);

router.get(
  "/conversation/:id/requests/:requestId",
  asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const payload = await getConversationRequestOutcome({
      conversationId: req.params.id, userId: req.user._id, requestId: req.params.requestId,
    });
    if (!payload) return res.status(404).json({ error: "Assistant request outcome is not available.", code: "SUPPORT_REQUEST_UNKNOWN" });
    res.json({ ok: true, ...payload });
  })
);

router.post(
  "/conversation/:id/escalate",
  supportWriteLimiter,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const payload = await escalateConversation({
      conversationId: req.params.id,
      user: req.user || {},
      messageId: req.body?.messageId,
      authSessionId: req.authSessionId,
      ...readPageContext(req),
    });
    if (!payload) {
      return res.status(404).json({ error: "Support conversation not found." });
    }
    res.status(201).json({ ok: true, ...payload });
  })
);

router.use((error, _req, res, next) => {
  if (!String(error?.publicCode || "").startsWith("SUPPORT_") && error?.code !== "ACCOUNT_CHANGED") return next(error);
  res.setHeader("Cache-Control", "no-store");
  res.status(error.statusCode || 500).json({ error: error.message, code: error.publicCode, ...(error.request ? { request: error.request } : {}) });
});

module.exports = router;
