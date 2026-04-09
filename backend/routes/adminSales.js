const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  createAccount,
  getAccountById,
  getSalesOverview,
  importPublicContactSignals,
  listAccounts,
} = require("../services/sales/accountService");
const { createInteraction, listInteractions } = require("../services/sales/interactionService");
const { generateAccountSnapshotPacket } = require("../services/sales/snapshotService");
const {
  generateOutreachDraftPacket,
  generateProspectAnswerPacket,
  getSalesDraftPacketById,
  listSalesDraftPackets,
} = require("../services/sales/outreachDraftService");
const { generateObjectionReviewPacket } = require("../services/sales/objectionAnalysisService");

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

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const overview = await getSalesOverview();
    res.json({ ok: true, ...overview });
  })
);

router.get(
  "/accounts",
  asyncHandler(async (req, res) => {
    const accounts = await listAccounts({ limit: req.query.limit });
    res.json({ ok: true, accounts });
  })
);

router.post(
  "/accounts",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const account = await createAccount(req.body || {});
    res.status(201).json({ ok: true, account });
  })
);

router.post(
  "/accounts/import-public-signals",
  csrfProtection,
  asyncHandler(async (_req, res) => {
    const accounts = await importPublicContactSignals();
    res.json({ ok: true, accounts });
  })
);

router.get(
  "/accounts/:id",
  asyncHandler(async (req, res) => {
    const account = await getAccountById(req.params.id);
    if (!account) return res.status(404).json({ error: "Sales account not found." });
    const interactions = await listInteractions(req.params.id, { limit: 20 });
    res.json({ ok: true, account, interactions });
  })
);

router.post(
  "/accounts/:id/interactions",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const interaction = await createInteraction(req.params.id, req.body || {});
    res.status(201).json({ ok: true, interaction });
  })
);

router.post(
  "/accounts/:id/account-snapshot",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const packet = await generateAccountSnapshotPacket({
      accountId: req.params.id,
      actor: buildActor(req),
    });
    res.status(201).json({ ok: true, packet });
  })
);

router.post(
  "/accounts/:id/outreach-draft",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const packet = await generateOutreachDraftPacket({
      accountId: req.params.id,
      actor: buildActor(req),
      outreachGoal: req.body?.outreachGoal,
    });
    res.status(201).json({ ok: true, packet });
  })
);

router.post(
  "/accounts/:id/objection-review",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const packet = await generateObjectionReviewPacket({
      accountId: req.params.id,
      actor: buildActor(req),
    });
    res.status(201).json({ ok: true, packet });
  })
);

router.post(
  "/accounts/:id/prospect-answer",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const packet = await generateProspectAnswerPacket({
      accountId: req.params.id,
      actor: buildActor(req),
      incomingQuestion: req.body?.incomingQuestion,
    });
    res.status(201).json({ ok: true, packet });
  })
);

router.get(
  "/draft-packets",
  asyncHandler(async (req, res) => {
    const packets = await listSalesDraftPackets({ limit: req.query.limit });
    res.json({ ok: true, packets });
  })
);

router.get(
  "/draft-packets/:id",
  asyncHandler(async (req, res) => {
    const packet = await getSalesDraftPacketById(req.params.id);
    if (!packet) return res.status(404).json({ error: "Sales draft packet not found." });
    res.json({ ok: true, packet });
  })
);

module.exports = router;
