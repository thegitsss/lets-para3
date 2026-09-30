const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
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

const { listInbox, inboxSummary } = require("../services/support/adminInboxService");
const SupportTicket = require("../models/SupportTicket");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const mongoose = require("mongoose");
const { triageFilter, triageRevision } = require("../services/support/triageRevision");
const { SUPPORT_TICKET_STATUSES } = require("../services/support/constants");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get("/inbox", asyncHandler(async (req, res) => {
  const allowed = new Set(["source", "status", "q", "assignment", "followUp", "includeTests", "page", "limit"]);
  if (Object.entries(req.query).some(([key, value]) => !allowed.has(key) || typeof value !== "string")) {
    return res.status(400).json({ error: "Choose valid inquiry filters." });
  }
  const { source, status, q, assignment, followUp, includeTests, page, limit } = req.query;
  if (source !== undefined && !["all", "email", "contact", "human"].includes(source) ||
      status !== undefined && !["active", "all", "resolved", ...SUPPORT_TICKET_STATUSES].includes(status) ||
      q !== undefined && q.length > 200 ||
      assignment !== undefined && !["mine", "unassigned", ""].includes(assignment) ||
      followUp !== undefined && !["overdue", ""].includes(followUp) ||
      includeTests !== undefined && !["true", "false"].includes(includeTests) ||
      page !== undefined && !/^[1-9]\d{0,5}$/.test(page) ||
      limit !== undefined && !/^[1-9]\d{0,2}$/.test(limit)) {
    return res.status(400).json({ error: "Choose valid inquiry filters." });
  }
  return res.json({ ok: true, ...await listInbox({ source, status, q, assignment, followUp, includeTests, page, limit, operatorId: req.user.id || req.user._id }) });
}));
router.get("/inbox-summary", asyncHandler(async (_req, res) => res.json({ ok: true, ...await inboxSummary() })));
router.get("/operators", asyncHandler(async (_req,res) => {
  const operators=await User.find({role:"admin",status:"approved",disabled:{$ne:true},deleted:{$ne:true}}).select("firstName lastName email").sort({firstName:1}).lean();
  res.json({operators});
}));
router.patch("/tickets/:id/triage", csrfProtection, asyncHandler(async(req,res) => {
  const {assignedTo=null,followUpAt=null,nextAction=""}=req.body || {};
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({error:"Invalid inquiry ID."});
  if(typeof nextAction!=="string"||nextAction.length>600)return res.status(400).json({error:"Keep the next action under 600 characters."});
  if(assignedTo&&(!mongoose.isValidObjectId(assignedTo)||!await User.exists({_id:assignedTo,role:"admin",status:"approved",disabled:{$ne:true},deleted:{$ne:true}})))return res.status(400).json({error:"Choose an active admin as the owner."});
  const due=followUpAt?new Date(followUpAt):null;
  if(due&&!Number.isFinite(due.getTime()))return res.status(400).json({error:"Enter a valid follow-up date."});
  if (!/^[a-f0-9]{64}$/.test(req.body.revision || '')) return res.status(428).json({error:"Refresh this inquiry before saving your follow-up."});
  const reviewed = await SupportTicket.findById(req.params.id).lean();
  if (!reviewed) return res.status(404).json({error:"Inquiry not found."});
  const conflict = () => res.status(409).json({error:"This inquiry changed. Refresh it before saving your follow-up.",code:"INQUIRY_CHANGED"});
  if (triageRevision(reviewed) !== req.body.revision) return conflict();
  const before=await SupportTicket.findOneAndUpdate({_id:reviewed._id,...triageFilter(reviewed)},{$set:{assignedTo:assignedTo||null,followUpAt:due,nextAction:nextAction.trim()}},{returnDocument:"before",runValidators:true});
  if(!before)return conflict();
  await AuditLog.logFromReq(req,"admin.support.triage_updated",{targetType:"other",targetId:before._id,meta:{before:{assignedTo:before.assignedTo,followUpAt:before.followUpAt,nextAction:before.nextAction},after:{assignedTo,followUpAt:due,nextAction:nextAction.trim()}}});
  res.json({ok:true,ticket:await getSupportTicketById(before._id)});
}));

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
    const ticket = await createSupportTicket(req.body || {});
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
      requestId: req.body?.requestId,
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

router.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const proposed = Number(error.statusCode || error.status);
  const status = proposed >= 400 && proposed < 600 ? proposed : 500;
  res.status(status).json({ error: status < 500 ? error.message : 'Support workspace is temporarily unavailable. Please try again.' });
});
module.exports = router;
