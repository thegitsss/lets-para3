const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const MarketingDraftPacket = require("../models/MarketingDraftPacket");
const { createBrief, getBriefById, listBriefs } = require("../services/marketing/briefService");
const { ensureDraftPacketForBrief } = require("../services/marketing/draftService");
const {
  createPublishingCycle,
  getPublishingCycleById,
  getPublishingOverview,
  listPublishingCycles,
  runScheduledCycleCreation,
  skipPublishingCycle,
} = require("../services/marketing/publishingCycleService");
const {
  getPublishingSettings,
  updatePublishingSettings,
} = require("../services/marketing/publishingSettingsService");
const {
  completeLinkedInOAuth,
  getChannelConnection,
  renderOAuthCallbackHtml,
  startLinkedInOAuth,
  upsertChannelConnection,
  validateLinkedInConnection,
} = require("../services/marketing/channelConnectionService");
const {
  getPacketPublishReadiness,
  getPacketPublishingContext,
} = require("../services/marketing/publishReadinessService");
const { publishPacketNow } = require("../services/marketing/publishService");
const { simulatePacketPublish } = require("../services/marketing/publishSimulationService");
const {
  getFounderDailyLog,
  prepareFounderDailyLog,
} = require("../services/marketing/founderDailyLogService");
const {
  approveMarketingPacket,
  getMarketingDiagnostics,
  getMarketingOverview,
  listMarketingApprovalTasks,
  rejectMarketingPacket,
} = require("../services/marketing/reviewService");
const { getJrCmoBriefing } = require("../services/marketing/jrCmoResearchService");

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

router.get(
  "/publishing/channel-connections/linkedin_company/oauth/callback",
  asyncHandler(async (req, res) => {
    const payload = await completeLinkedInOAuth({
      code: req.query.code,
      state: req.query.state,
      error: req.query.error,
      errorDescription: req.query.error_description,
    });
    res.status(payload.ok ? 200 : 400).type("html").send(renderOAuthCallbackHtml(payload));
  })
);

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const diagnostics = await getMarketingDiagnostics();
    res.json({ ok: true, diagnostics });
  })
);

router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const overview = await getMarketingOverview();
    res.json({ ok: true, ...overview });
  })
);

router.get(
  "/jr-cmo/library",
  asyncHandler(async (req, res) => {
    const forceRefresh = String(req.query.refresh || "1").trim() !== "0";
    const briefing = await getJrCmoBriefing({ forceRefresh });
    res.json({
      ok: true,
      library: {
        dayContext: briefing.dayContext || null,
        opportunities: briefing.opportunities || [],
        facts: briefing.facts || [],
        evaluation: briefing.evaluation || null,
        cadence: briefing.cadence || {},
        pendingReviewCount: briefing.pendingReviewCount || 0,
        signalMeta: briefing.signalMeta || {},
      },
    });
  })
);

router.get(
  "/founder-daily-log",
  asyncHandler(async (req, res) => {
    const forceRefresh = String(req.query.refresh || "0").trim() === "1";
    const result = forceRefresh
      ? await prepareFounderDailyLog({ now: new Date(), force: true, allowScheduledCycleCheck: false })
      : await getFounderDailyLog({ now: new Date(), refreshIfStale: true });
    res.json({ ok: true, ...result });
  })
);

router.post(
  "/founder-daily-log/refresh",
  csrfProtection,
  asyncHandler(async (_req, res) => {
    const result = await prepareFounderDailyLog({
      now: new Date(),
      force: true,
      allowScheduledCycleCheck: false,
    });
    res.json({ ok: true, ...result });
  })
);

router.get(
  "/briefs",
  asyncHandler(async (_req, res) => {
    const briefs = await listBriefs();
    res.json({ ok: true, briefs });
  })
);

router.post(
  "/briefs",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const brief = await createBrief(req.body || {}, req.user || {});
    res.status(201).json({ ok: true, brief });
  })
);

router.get(
  "/briefs/:id",
  asyncHandler(async (req, res) => {
    const brief = await getBriefById(req.params.id);
    if (!brief) return res.status(404).json({ error: "Marketing brief not found." });
    res.json({ ok: true, brief });
  })
);

router.post(
  "/briefs/:id/drafts",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const packet = await ensureDraftPacketForBrief({
      briefId: req.params.id,
      actor: buildActor(req),
    });
    res.status(201).json({ ok: true, packet });
  })
);

router.get(
  "/publishing/settings",
  asyncHandler(async (_req, res) => {
    const settings = await getPublishingSettings();
    res.json({ ok: true, settings });
  })
);

router.post(
  "/publishing/settings",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const settings = await updatePublishingSettings(req.body || {}, buildActor(req));
    res.json({ ok: true, settings });
  })
);

router.get(
  "/publishing/channel-connections/:channelKey",
  asyncHandler(async (req, res) => {
    const connection = await getChannelConnection(req.params.channelKey);
    res.json({ ok: true, connection });
  })
);

router.post(
  "/publishing/channel-connections/linkedin_company/oauth/start",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await startLinkedInOAuth({
      actor: buildActor(req),
      hints: req.body || {},
    });
    res.json({ ok: true, ...result });
  })
);

router.post(
  "/publishing/channel-connections/:channelKey",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const connection = await upsertChannelConnection({
      channelKey: req.params.channelKey,
      payload: req.body || {},
      actor: buildActor(req),
    });
    res.json({ ok: true, connection });
  })
);

router.post(
  "/publishing/channel-connections/linkedin_company/validate",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const connection = await validateLinkedInConnection({
      actor: buildActor(req),
      forceRevalidate: true,
    });
    res.json({ ok: true, connection });
  })
);

router.get(
  "/publishing/overview",
  asyncHandler(async (_req, res) => {
    const overview = await getPublishingOverview();
    res.json({ ok: true, ...overview });
  })
);

router.get(
  "/publishing/cycles",
  asyncHandler(async (req, res) => {
    const cycles = await listPublishingCycles({ limit: req.query.limit });
    res.json({ ok: true, cycles });
  })
);

router.get(
  "/publishing/cycles/:id",
  asyncHandler(async (req, res) => {
    const cycle = await getPublishingCycleById(req.params.id);
    if (!cycle) return res.status(404).json({ error: "Publishing cycle not found." });
    res.json({ ok: true, cycle });
  })
);

router.post(
  "/publishing/cycles",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await createPublishingCycle({
      triggerSource: "manual",
      actor: buildActor(req),
      cycleLabel: req.body?.cycleLabel,
      targetAudience: req.body?.targetAudience,
      objective: req.body?.objective,
      briefSummary: req.body?.briefSummary,
      updateFacts: req.body?.updateFacts,
      ctaPreference: req.body?.ctaPreference,
    });
    res.status(result.created ? 201 : 200).json({ ok: true, ...result });
  })
);

router.post(
  "/publishing/run-scheduled",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await runScheduledCycleCreation({
      actor: buildActor(req),
      now: req.body?.now || undefined,
    });
    res.json({ ok: true, ...result });
  })
);

router.post(
  "/publishing/cycles/:id/skip",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const cycle = await skipPublishingCycle({
      cycleId: req.params.id,
      actor: buildActor(req),
      reason: req.body?.reason,
    });
    res.json({ ok: true, cycle });
  })
);

router.get(
  "/draft-packets",
  asyncHandler(async (_req, res) => {
    const packets = await MarketingDraftPacket.find({})
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ ok: true, packets });
  })
);

router.get(
  "/draft-packets/:id",
  asyncHandler(async (req, res) => {
    try {
      const { packet } = await getPacketPublishingContext({ packetId: req.params.id });
      res.json({ ok: true, packet });
    } catch (err) {
      if (Number(err?.statusCode) === 404) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  })
);

router.post(
  "/draft-packets/:id/publish-readiness",
  csrfProtection,
  asyncHandler(async (req, res) => {
    try {
      const readiness = await getPacketPublishReadiness({ packetId: req.params.id });
      res.json({ ok: true, readiness });
    } catch (err) {
      if (Number(err?.statusCode) === 404) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  })
);

router.post(
  "/draft-packets/:id/publish-simulation",
  csrfProtection,
  asyncHandler(async (req, res) => {
    try {
      const simulation = await simulatePacketPublish({
        packetId: req.params.id,
        actor: buildActor(req),
      });
      res.json({ ok: true, simulation });
    } catch (err) {
      if (Number(err?.statusCode) === 404) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  })
);

router.post(
  "/draft-packets/:id/publish-now",
  csrfProtection,
  asyncHandler(async (req, res) => {
    try {
      const result = await publishPacketNow({
        packetId: req.params.id,
        actor: buildActor(req),
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(Number(err?.statusCode) || 500).json({
        error: err?.message || "Unable to publish packet.",
        intent: err?.intent || null,
        attempt: err?.attempt || null,
        readiness: err?.readiness || null,
      });
    }
  })
);

router.get(
  "/approvals",
  asyncHandler(async (_req, res) => {
    const approvals = await listMarketingApprovalTasks();
    res.json({ ok: true, approvals });
  })
);

router.post(
  "/draft-packets/:id/approve",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const packet = await approveMarketingPacket({
      packetId: req.params.id,
      actor: buildActor(req),
      note: req.body?.note,
    });
    res.json({ ok: true, packet });
  })
);

router.post(
  "/draft-packets/:id/reject",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const packet = await rejectMarketingPacket({
      packetId: req.params.id,
      actor: buildActor(req),
      note: req.body?.note,
    });
    res.json({ ok: true, packet });
  })
);

module.exports = router;
