const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  decideApprovalWorkspaceItem,
  getApprovalWorkspaceItem,
  getApprovalWorkspaceOverview,
  listApprovalWorkspaceItems,
} = require("../services/approvals/workspaceService");
const {
  AUTONOMY_ACTION_TYPES,
  recordDecisionOutcome,
} = require("../services/ai/autonomyPreferenceService");

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

function buildActor(req) {
  return {
    actorType: "user",
    userId: req.user?._id || req.user?.id || null,
    label: req.user?.email || "Admin",
  };
}

function mapWorkKeyToAutonomyOutcome(workKey = "") {
  const [targetType] = String(workKey || "").split(":");
  if (targetType === "faq_candidate") {
    return { agentRole: "CCO", actionType: AUTONOMY_ACTION_TYPES.cco };
  }
  if (targetType === "marketing_draft_packet") {
    return { agentRole: "CMO", actionType: AUTONOMY_ACTION_TYPES.cmo };
  }
  if (targetType === "sales_draft_packet") {
    return { agentRole: "CSO", actionType: AUTONOMY_ACTION_TYPES.cso };
  }
  return null;
}

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const overview = await getApprovalWorkspaceOverview();
    res.json({ ok: true, ...overview });
  })
);

router.get(
  "/items",
  asyncHandler(async (req, res) => {
    const items = await listApprovalWorkspaceItems({
      pillar: req.query.pillar,
      itemType: req.query.itemType,
      status: req.query.status,
    });
    res.json({ ok: true, items });
  })
);

router.get(
  "/items/:workKey",
  asyncHandler(async (req, res) => {
    const item = await getApprovalWorkspaceItem(req.params.workKey);
    res.json({ ok: true, item });
  })
);

router.post(
  "/items/:workKey/approve",
  csrfProtection,
  asyncHandler(async (req, res) => {
    await decideApprovalWorkspaceItem({
      workKey: req.params.workKey,
      action: "approve",
      actor: buildActor(req),
      note: req.body?.note,
    });
    const autonomyOutcome = mapWorkKeyToAutonomyOutcome(req.params.workKey);
    if (autonomyOutcome) {
      await recordDecisionOutcome(autonomyOutcome.agentRole, autonomyOutcome.actionType, "approve");
    }
    const item = await getApprovalWorkspaceItem(req.params.workKey);
    res.json({ ok: true, item });
  })
);

router.post(
  "/items/:workKey/reject",
  csrfProtection,
  asyncHandler(async (req, res) => {
    await decideApprovalWorkspaceItem({
      workKey: req.params.workKey,
      action: "reject",
      actor: buildActor(req),
      note: req.body?.note,
    });
    const autonomyOutcome = mapWorkKeyToAutonomyOutcome(req.params.workKey);
    if (autonomyOutcome) {
      await recordDecisionOutcome(autonomyOutcome.agentRole, autonomyOutcome.actionType, "reject");
    }
    const item = await getApprovalWorkspaceItem(req.params.workKey);
    res.json({ ok: true, item });
  })
);

module.exports = router;
