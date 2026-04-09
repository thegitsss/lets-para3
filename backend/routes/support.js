const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  createConversationMessage,
  escalateConversation,
  findConversationForUser,
  getOrCreateOpenConversation,
  listConversationMessages,
  restartConversation,
} = require("../services/support/conversationService");
const { subscribeToConversationEvents } = require("../services/support/liveUpdateService");

const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    },
  });
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

router.use(verifyToken, requireApproved, requireRole("admin", "attorney", "paralegal"));

router.get(
  "/conversation",
  asyncHandler(async (req, res) => {
    const conversation = await getOrCreateOpenConversation({
      user: req.user || {},
      ...readPageContext(req),
    });
    res.json({ ok: true, conversation });
  })
);

router.get(
  "/conversation/:id/events",
  asyncHandler(async (req, res) => {
    const conversation = await findConversationForUser(req.params.id, req.user._id);
    if (!conversation) {
      return res.status(404).json({ error: "Support conversation not found." });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const writeEvent = (payload = {}) => {
      res.write(`event: ${payload.type || "conversation.updated"}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    writeEvent({
      type: "conversation.ready",
      conversationId: String(conversation._id),
      at: new Date().toISOString(),
    });

    const unsubscribe = subscribeToConversationEvents(conversation._id, (payload) => {
      writeEvent(payload);
    });

    const keepAlive = setInterval(() => {
      res.write(": ping\n\n");
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
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
  "/conversation/:id/restart",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const payload = await restartConversation({
      conversationId: req.params.id,
      user: req.user || {},
      ...readPageContext(req),
    });
    if (!payload) {
      return res.status(404).json({ error: "Support conversation not found." });
    }
    res.status(201).json({ ok: true, ...payload });
  })
);

router.post(
  "/conversation/:id/escalate",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const payload = await escalateConversation({
      conversationId: req.params.id,
      user: req.user || {},
      messageId: req.body?.messageId,
      ...readPageContext(req),
    });
    if (!payload) {
      return res.status(404).json({ error: "Support conversation not found." });
    }
    res.status(201).json({ ok: true, ...payload });
  })
);

module.exports = router;
