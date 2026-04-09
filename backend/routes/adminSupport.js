const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  addSupportTicketNote,
  createSupportTicket,
  getSupportOverview,
  getSupportTicketById,
  listSupportTickets,
  regenerateResponsePacket,
  replyToSupportTicket,
  updateTicketStatus,
} = require("../services/support/ticketService");
const { generateFAQCandidates, listFAQCandidates } = require("../services/support/faqCandidateService");
const { listSupportInsights, refreshSupportInsights } = require("../services/support/patternDetectionService");

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

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const overview = await getSupportOverview();
    res.json({ ok: true, ...overview });
  })
);

router.get(
  "/tickets",
  asyncHandler(async (req, res) => {
    const rawIncludeHandedOff = String(req.query.includeHandedOff || "").trim().toLowerCase();
    const tickets = await listSupportTickets({
      status: req.query.status,
      urgency: req.query.urgency,
      role: req.query.role,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      sort: req.query.sort,
      limit: req.query.limit,
      includeHandedOff: rawIncludeHandedOff ? rawIncludeHandedOff === "true" : true,
    });
    res.json({ ok: true, tickets });
  })
);

router.post(
  "/tickets",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const ticket = await createSupportTicket(req.body || {}, req.user || {});
    res.status(201).json({ ok: true, ticket });
  })
);

router.get(
  "/tickets/:id",
  asyncHandler(async (req, res) => {
    const ticket = await getSupportTicketById(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Support ticket not found." });
    res.json({ ok: true, ticket });
  })
);

router.post(
  "/tickets/:id/response-packet",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const ticket = await regenerateResponsePacket({ ticketId: req.params.id });
    res.json({ ok: true, ticket });
  })
);

router.post(
  "/tickets/:id/status",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const ticket = await updateTicketStatus({
      ticketId: req.params.id,
      status: req.body?.status,
      resolutionSummary: req.body?.resolutionSummary,
      resolutionIsStable: req.body?.resolutionIsStable,
    });
    res.json({ ok: true, ticket });
  })
);

router.patch(
  "/tickets/:id/status",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const ticket = await updateTicketStatus({
      ticketId: req.params.id,
      status: req.body?.status,
      resolutionSummary: req.body?.resolutionSummary,
      resolutionIsStable: req.body?.resolutionIsStable,
    });
    res.json({ ok: true, ticket });
  })
);

router.post(
  "/tickets/:id/note",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const payload = await addSupportTicketNote({
      ticketId: req.params.id,
      adminUser: req.user || {},
      text: req.body?.text,
    });
    res.status(201).json({ ok: true, ...payload });
  })
);

router.post(
  "/tickets/:id/reply",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const payload = await replyToSupportTicket({
      ticketId: req.params.id,
      adminUser: req.user || {},
      text: req.body?.text,
      status: req.body?.status,
    });
    res.status(201).json({ ok: true, ...payload });
  })
);

router.get(
  "/faq-candidates",
  asyncHandler(async (req, res) => {
    const candidates = await listFAQCandidates({
      approvalState: req.query.approvalState,
      limit: req.query.limit,
    });
    res.json({ ok: true, candidates });
  })
);

router.post(
  "/faq-candidates/generate",
  csrfProtection,
  asyncHandler(async (_req, res) => {
    const candidates = await generateFAQCandidates();
    res.json({ ok: true, candidates });
  })
);

router.get(
  "/insights",
  asyncHandler(async (req, res) => {
    const insights = await listSupportInsights({ limit: req.query.limit });
    res.json({ ok: true, insights });
  })
);

router.post(
  "/insights/refresh",
  csrfProtection,
  asyncHandler(async (_req, res) => {
    const insights = await refreshSupportInsights();
    res.json({ ok: true, insights });
  })
);

module.exports = router;
