const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Job = require("../models/Job");
const Case = require("../models/Case");
const User = require("../models/User");
const { withActiveAccountWrite } = require("../utils/activeAccountWrite");
const auth = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const applicationsRouter = require("./applications");
const { cleanTitle, cleanText, cleanBudget } = require("../utils/sanitize");
const {
  MIN_MATTER_AMOUNT_CENTS,
  evaluateMatterPosting,
} = require("../services/attorneyWorkflowPolicy");
const { resolveExperienceRequirement } = require("../services/experienceRequirement");
const { protectMutations } = require("../utils/csrf");
const {
  addSubscriber: addMatterDiscoverySubscriber,
  publishMatterDiscoveryEvent,
} = require("../utils/matterDiscoveryEvents");
const createApplicationForJob = applicationsRouter?.createApplicationForJob;
const { openDiscoveryCaseFilter, readOpenListingPage, readRecommendedListingPage } = require("../services/openMatterDiscovery");
const PRACTICE_AREAS = [
  "administrative law",
  "antitrust law",
  "bankruptcy",
  "business law",
  "civil litigation",
  "commercial litigation",
  "contract law",
  "corporate law",
  "criminal defense",
  "employment law",
  "estate planning",
  "trusts & estates",
  "family law",
  "immigration",
  "intellectual property",
  "labor law",
  "personal injury",
  "real estate",
  "tax law",
  "technology",
];
const PRACTICE_AREA_LOOKUP = PRACTICE_AREAS.reduce((acc, name) => {
  acc[name.toLowerCase()] = name;
  return acc;
}, {});
const authenticatedGuards = [auth, requireApproved];

const mutatingGuards = [...authenticatedGuards, protectMutations];

// Live invalidation only. The stream never sends Matter content, so every
// client still re-fetches its own authorized browse and recommendation views.
router.get("/stream", ...authenticatedGuards, requireRole("paralegal"), (req, res) => {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  if (req.socket) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
  }
  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  const unsubscribe = addMatterDiscoverySubscriber(res);
  const heartbeat = setInterval(() => {
    try {
      res.write("event: ping\ndata: {}\n\n");
    } catch (err) {
      runtimeLogger.debug("[jobs] discovery stream heartbeat ended", err?.message || err);
    }
  }, 25_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("error", cleanup);
});

// Cross-process reconciliation token. Live SSE events provide immediate updates
// inside the current web process; this lightweight database fingerprint catches
// changes made by a scheduler or another web process without repeatedly loading
// or repainting the full Browse and recommendation projections.
router.get("/discovery-version", ...authenticatedGuards, requireRole("paralegal"), async (_req, res) => {
  try {
    const caseFilter = openDiscoveryCaseFilter();
    const [caseCount, latestCase, jobCount, latestJob] = await Promise.all([
      Case.countDocuments(caseFilter),
      Case.findOne(caseFilter).sort({ updatedAt: -1, _id: -1 }).select("_id updatedAt").lean(),
      Job.countDocuments({ status: "open" }),
      Job.findOne({ status: "open" }).sort({ createdAt: -1, _id: -1 }).select("_id createdAt").lean(),
    ]);
    const version = [
      caseCount,
      latestCase?.updatedAt ? new Date(latestCase.updatedAt).getTime() : 0,
      latestCase?._id || "",
      jobCount,
      latestJob?.createdAt ? new Date(latestJob.createdAt).getTime() : 0,
      latestJob?._id || "",
    ].join(":");
    res.set("Cache-Control", "private, no-store");
    return res.json({ version });
  } catch (err) {
    runtimeLogger.warn("[jobs] discovery version unavailable", err?.message || err);
    return res.status(503).json({ error: "Matter updates are temporarily unavailable." });
  }
});

async function linkJobToCase(caseDoc, jobId, session = null) {
  if (!caseDoc?._id || !jobId) return;
  await Case.updateOne(
    {
      _id: caseDoc._id,
      $or: [{ jobId: null }, { jobId: { $exists: false } }, { jobId }],
    },
    { $set: { jobId } },
    ...(session ? [{ session }] : [])
  );
}

// POST /jobs — Attorney posts a job
router.post("/", ...mutatingGuards, requireRole("attorney"), async (req, res) => {
  try {
    const caseId = req.body?.caseId || null;
    let caseDoc = null;
    if (caseId) {
      if (!mongoose.isValidObjectId(caseId)) {
        return res.status(400).json({ error: "Invalid Matter ID" });
      }
      caseDoc = await Case.findById(caseId).select(
        "attorney attorneyId jobId state locationState experiencePreference minimumYearsExperience"
      );
      if (!caseDoc) {
        return res.status(404).json({ error: "Matter not found" });
      }
      const ownerId = String(caseDoc.attorneyId || caseDoc.attorney || "");
      if (!ownerId || ownerId !== String(req.user._id)) {
        return res.status(403).json({ error: "You are not the attorney for this Matter" });
      }
      if (caseDoc.jobId) {
        const existingById = await Job.findById(caseDoc.jobId);
        if (existingById) {
          return res.json(existingById);
        }
      }
      const existingByCase = await Job.findOne({ caseId });
      if (existingByCase) {
        return res.json(existingByCase);
      }
    }

    const attorneyProfile = await User.findById(req.user._id || req.user.id).select("state");
    const requestedState = cleanTitle(req.body.state || req.body.locationState || "", 200);
    const matterState = cleanTitle(caseDoc?.state || caseDoc?.locationState || "", 200);
    const attorneyState = cleanTitle(attorneyProfile?.state || "", 200);
    const resolvedState = matterState || requestedState || attorneyState;
    if (!resolvedState) {
      return res.status(400).json({ error: "Matter state is required to create a Matter." });
    }

    const title = cleanTitle(req.body.title, 150);
    if (!title || title.length < 5) {
      return res.status(400).json({ error: "Title must be at least 5 characters." });
    }

    const description = cleanText(req.body.description || "", { max: 5000 });
    if (!description || description.length < 50) {
      return res.status(400).json({ error: "Description must be at least 50 characters." });
    }

    const practiceAreaKey = cleanTitle(req.body.practiceArea || "", 120).toLowerCase();
    const practiceAreaValue = PRACTICE_AREA_LOOKUP[practiceAreaKey];
    if (!practiceAreaValue) {
      return res.status(400).json({ error: "Select a valid practice area." });
    }

    let budget;
    try {
      budget = cleanBudget(req.body.budget, { min: MIN_MATTER_AMOUNT_CENTS / 100, max: 30000 });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const postingPolicy = evaluateMatterPosting({
      title,
      details: description,
      practiceArea: practiceAreaValue,
      amountCents: Math.round(budget * 100),
      deadlineProvided: false,
      deadlineValid: true,
      attorneyStateRequired: true,
      attorneyState: resolvedState,
    });
    if (!postingPolicy.ready) {
      return res.status(400).json({ error: "This Matter is not ready to publish.", blockers: postingPolicy.blockers });
    }

    const requestedExperience = cleanText(
      req.body.experiencePreference || req.body.experience || "",
      { max: 200, allowNewlines: false }
    );
    const experienceRequirement = resolveExperienceRequirement(
      caseDoc || {},
      {
        experiencePreference: requestedExperience,
        minimumYearsExperience: req.body.minimumYearsExperience,
      }
    );
    const jobPayload = {
      caseId: caseDoc?._id || null,
      attorneyId: req.user._id,
      title,
      practiceArea: practiceAreaValue,
      description,
      budget: Math.round(budget),
      state: resolvedState,
      locationState: resolvedState,
      experiencePreference: experienceRequirement.preference,
      minimumYearsExperience: experienceRequirement.minimumYears,
    };

    let job = null;
    try {
      job = await withActiveAccountWrite([req.user._id || req.user.id], async session => {
        const [created] = await Job.create([jobPayload], { session });
        if (caseDoc) await linkJobToCase(caseDoc, created._id, session);
        return created;
      }, { ownerId: req.user._id || req.user.id, authVersion: req.auth?.payload?.av });
    } catch (err) {
      if (err?.code === 11000 && caseDoc?._id) {
        job = await Job.findOne({ caseId: caseDoc._id });
      } else {
        throw err;
      }
    }

    if (!job) {
      return res.status(409).json({ error: "A posting already exists for this Matter." });
    }

    publishMatterDiscoveryEvent("matter_published_refresh");
    res.json(job);
  } catch (err) {
    if (err.publicCode) return res.status(err.status).json({ code: err.publicCode, error: err.message });
    res.status(500).json({ error: "Server error" });
  }
});

// GET /jobs/open — paralegals browse every currently available Matter.
router.get("/open", ...authenticatedGuards, requireRole("paralegal"), async (req, res) => {
  try {
    const browse = req.query.view === "browse";
    const page = await readOpenListingPage(req.user._id || req.user.id, req.query, { browse });
    res.set("Cache-Control", "private, no-store");
    res.set("X-Total-Count", String(page.total));
    res.set("X-Page", String(page.page));
    res.set("X-Total-Pages", String(page.totalPages));
    return res.json(browse || req.query.view === "catalog" ? page : page.items);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : "Available Matters could not be loaded.", ...(err.publicCode ? { code: err.publicCode } : {}) });
  }
});

// GET /jobs/recommended — authoritative personalized recommendation projection.
// Browse remains intentionally broader; application history is a permanent
// recommendation exclusion regardless of the application's current status.
router.get("/recommended", ...authenticatedGuards, requireRole("paralegal"), async (req, res) => {
  try {
    const projection = await readRecommendedListingPage(req.user._id || req.user.id, req.query);
    res.set("Cache-Control", "private, no-store");
    return res.json(projection);
  } catch (err) {
    runtimeLogger.error("[jobs] recommendation projection error", err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : "Unable to load recommendations.", ...(err.publicCode ? { code: err.publicCode } : {}) });
  }
});

// GET /jobs/my — attorney views their posted jobs
router.get("/my", ...authenticatedGuards, requireRole("attorney"), async (req, res) => {
  try {
    const jobs = await Job.find({ attorneyId: req.user._id });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/:jobId/requirements/decline", ...mutatingGuards, requireRole("paralegal"), async (req, res) => {
  try { res.json(await require('../services/matterRequirements').declineRequirements({jobId:req.params.jobId,userId:req.user._id||req.user.id,authVersion:req.authVersion,requirements:req.body.requirements,confirmed:req.body.confirmed})); }
  catch(error){res.status(error.status||503).json({error:error.status?error.message:'The decision could not be confirmed. Try again.'});}
});

// POST /jobs/:jobId/apply — paralegal applies
router.post("/:jobId/apply", ...mutatingGuards, requireRole("paralegal"), async (req, res) => {
  try {
    if (!createApplicationForJob) {
      return res.status(500).json({ error: "Applications service unavailable" });
    }
    const application = await createApplicationForJob(req.params.jobId, req.user, req.body?.coverLetter || "", req.body?.requirementAnswers);
    res.status(201).json(application);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    res.status(500).json({ error: "Server error" });
  }
});

// POST /jobs/:jobId/hire/:paralegalId — disabled to avoid hiring without confirmed Matter funding
router.post("/:jobId/hire/:paralegalId", auth, protectMutations, requireRole(["attorney"]), async (_req, res) => {
  return res.status(410).json({
    error: "Direct posting-to-paralegal hire is disabled. Use the Matter hire and funding flow to ensure the Matter is funded.",
  });
});

module.exports = router;
