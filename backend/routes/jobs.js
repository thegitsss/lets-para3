const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Job = require("../models/Job");
const Application = require("../models/Application");
const Case = require("../models/Case");
const User = require("../models/User");
const { buildAuthenticatedProfilePhotoUrl } = require("../services/profilePhotoDelivery");
const auth = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const applicationsRouter = require("./applications");
const { cleanTitle, cleanText, cleanBudget } = require("../utils/sanitize");
const { getBlockedUserIds } = require("../utils/blocks");
const {
  MIN_MATTER_AMOUNT_CENTS,
  evaluateMatterPosting,
} = require("../services/attorneyWorkflowPolicy");
const { resolveMatterDeadlineDate } = require("../utils/businessDate");
const { protectMutations } = require("../utils/csrf");
const createApplicationForJob = applicationsRouter?.createApplicationForJob;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
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

async function linkJobToCase(caseDoc, jobId) {
  if (!caseDoc?._id || !jobId) return;
  await Case.updateOne(
    {
      _id: caseDoc._id,
      $or: [{ jobId: null }, { jobId: { $exists: false } }, { jobId }],
    },
    { $set: { jobId } }
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
      { max: 200 }
    );
    const experienceRequirement = resolveExperienceRequirement(
      {
        experiencePreference: requestedExperience,
        minimumYearsExperience: req.body.minimumYearsExperience,
      },
      caseDoc
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
      job = await Job.create(jobPayload);
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

    if (caseDoc) {
      await linkJobToCase(caseDoc, job._id);
    }

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

function buildAttorneyPreview(doc) {
  if (!doc || typeof doc !== "object") return null;
  const normalizedId = normalizeId(doc);
  return {
    _id: normalizedId,
    firstName: doc.firstName || "",
    lastName: doc.lastName || "",
    lawFirm: doc.lawFirm || doc.firmName || "",
    profileImage:
      doc.profileImage || doc.avatarURL
        ? buildAuthenticatedProfilePhotoUrl(doc)
        : "",
  };
}

function normalizeId(source) {
  if (!source) return null;
  if (typeof source === "string") return source;
  if (typeof source === "object") {
    if (source._id) return source._id;
    if (typeof source.toString === "function") return source.toString();
    return null;
  }
  return source;
}

function resolveExperienceRequirement(job = null, caseDoc = null) {
  const preference = String(
    caseDoc?.experiencePreference || job?.experiencePreference || ""
  ).trim();
  const explicit = Number(
    caseDoc?.minimumYearsExperience ?? job?.minimumYearsExperience
  );
  if (Number.isFinite(explicit) && explicit > 0) {
    return { preference, minimumYears: Math.min(80, explicit) };
  }
  const experienceText = preference
    ? preference.match(/\d+(?:\.\d+)?/)
    : String(caseDoc?.briefSummary || "").match(/Experience:\s*(\d+(?:\.\d+)?)/i);
  const parsed = experienceText ? Number(experienceText[1]) : 0;
  return {
    preference,
    minimumYears: Number.isFinite(parsed) ? Math.min(80, Math.max(0, parsed)) : 0,
  };
}

function shapeListing({ job = null, caseDoc = null }) {
  const autoRelistTypes = new Set(["zero_auto", "partial_attorney", "expired_zero", "admin"]);
  const autoRelistFallback =
    !caseDoc?.relistRequestedAt &&
    caseDoc?.payoutFinalizedAt &&
    autoRelistTypes.has(String(caseDoc?.payoutFinalizedType || ""));
  const totalAmount = typeof caseDoc?.totalAmount === "number" ? caseDoc.totalAmount : null;
  const lockedTotalAmount = typeof caseDoc?.lockedTotalAmount === "number" ? caseDoc.lockedTotalAmount : null;
  const remainingAmount = typeof caseDoc?.remainingAmount === "number" ? caseDoc.remainingAmount : null;
  const amountForCase =
    remainingAmount != null ? remainingAmount : lockedTotalAmount != null ? lockedTotalAmount : totalAmount;
  const budgetFromCase = amountForCase != null ? Math.round(amountForCase / 100) : null;
  const attorneySource = job?.attorneyId || caseDoc?.attorney || null;
  const normalizedAttorneyId =
    normalizeId(job?.attorneyId) || normalizeId(caseDoc?.attorneyId) || normalizeId(caseDoc?.attorney);
  const jobState = job?.state || job?.locationState || "";
  const caseState = caseDoc?.state || caseDoc?.locationState || "";
  const resolvedState = caseState || jobState;
  const experienceRequirement = resolveExperienceRequirement(job, caseDoc);

  return {
    id: caseDoc?._id || job?.caseId || job?._id,
    _id: caseDoc?._id || job?._id,
    caseId: caseDoc?._id || job?.caseId || null,
    jobId: job?._id || caseDoc?.jobId || null,
    title: job?.title || caseDoc?.title || "Untitled Matter",
    practiceArea: job?.practiceArea || caseDoc?.practiceArea || "",
    briefSummary: caseDoc?.briefSummary || "",
    shortDescription: job?.shortDescription || caseDoc?.briefSummary || "",
    description: job?.description || caseDoc?.details || "",
    totalAmount,
    lockedTotalAmount,
    remainingAmount,
    budget: typeof job?.budget === "number" ? job.budget : budgetFromCase,
    currency: caseDoc?.currency || "usd",
    state: resolvedState,
    locationState: caseDoc?.locationState || caseDoc?.state || job?.locationState || job?.state || "",
    experiencePreference: experienceRequirement.preference,
    minimumYearsExperience: experienceRequirement.minimumYears,
    createdAt: job?.createdAt || caseDoc?.createdAt || new Date(),
    deadlineDate: resolveMatterDeadlineDate(caseDoc),
    deadline: resolveMatterDeadlineDate(caseDoc) || null,
    attorneyId: normalizedAttorneyId,
    attorney: buildAttorneyPreview(attorneySource),
    applicantsCount: job
      ? Math.max(0, Number(job.applicantsCount || 0))
      : Array.isArray(caseDoc?.applicants)
        ? caseDoc.applicants.filter(
            (entry) => String(entry?.status || "pending").toLowerCase() === "pending"
          ).length
        : 0,
    status: caseDoc?.status || job?.status || "open",
    contextCaseId: caseDoc?._id || job?.caseId || null,
    tasks: Array.isArray(caseDoc?.tasks) ? caseDoc.tasks : [],
    relistRequestedAt: caseDoc?.relistRequestedAt || (autoRelistFallback ? caseDoc.payoutFinalizedAt : null),
  };
}

// GET /jobs/open — paralegals view available jobs
router.get("/open", ...authenticatedGuards, requireRole("paralegal"), async (req, res) => {
  try {
    const limit = clamp(parseInt(req.query.limit, 10) || 200, 1, 500);
    const blockedIds = await getBlockedUserIds(req.user.id);
    const autoRelistTypes = ["zero_auto", "partial_attorney", "expired_zero", "admin"];
    const jobFilter = { status: "open" };
    const caseFilter = {
      archived: { $ne: true },
      $or: [
        { status: "open" },
        {
          status: "paused",
          payoutFinalizedAt: { $ne: null },
          $or: [
            { relistRequestedAt: { $ne: null } },
            { payoutFinalizedType: { $in: autoRelistTypes } },
          ],
        },
      ],
      paralegal: null,
      paralegalId: null,
    };
    if (blockedIds.length) {
      jobFilter.attorneyId = { $nin: blockedIds };
      caseFilter.attorney = { $nin: blockedIds };
      caseFilter.attorneyId = { $nin: blockedIds };
    }

    const [jobs, cases] = await Promise.all([
      Job.find(jobFilter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate({
          path: "attorneyId",
          select: "firstName lastName lawFirm firmName profileImage avatarURL",
        })
        .lean(),
      Case.find(caseFilter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .select("title practiceArea details briefSummary experiencePreference minimumYearsExperience totalAmount lockedTotalAmount remainingAmount currency state locationState status applicants attorney attorneyId jobId createdAt deadline deadlineDate tasks relistRequestedAt payoutFinalizedAt payoutFinalizedType")
        .populate({
          path: "attorney",
          select: "firstName lastName lawFirm firmName profileImage avatarURL",
        })
        .lean(),
    ]);

    const jobIds = jobs.map((job) => String(job?._id || "")).filter(Boolean);
    const jobCaseLinks = jobIds.length
      ? await Case.find({ jobId: { $in: jobIds } })
          .select("jobId status archived relistRequestedAt payoutFinalizedAt")
          .lean()
      : [];
    const linkedJobEligibility = new Map();
    jobCaseLinks.forEach((doc) => {
      const jobId = String(doc.jobId || "");
      if (!jobId) return;
      const status = String(doc.status || "").toLowerCase();
      const autoRelistEligible =
        status === "paused" &&
        doc.payoutFinalizedAt &&
        autoRelistTypes.includes(String(doc.payoutFinalizedType || ""));
      const eligible =
        doc.archived !== true &&
        (status === "open" ||
          (status === "paused" && doc.relistRequestedAt && doc.payoutFinalizedAt) ||
          autoRelistEligible);
      linkedJobEligibility.set(jobId, eligible);
    });

    const activeCaseIds = new Set(cases.map((doc) => String(doc._id)));
    const jobByCaseId = new Map();
    const orphanJobs = [];
    jobs.forEach((job) => {
      const caseKey = job.caseId ? String(job.caseId) : null;
      if (caseKey) {
        if (activeCaseIds.has(caseKey)) {
          if (!jobByCaseId.has(caseKey)) {
            jobByCaseId.set(caseKey, job);
          }
        }
        return;
      }
      const jobId = String(job?._id || "");
      if (jobId && linkedJobEligibility.has(jobId) && !linkedJobEligibility.get(jobId)) {
        return;
      }
      orphanJobs.push(shapeListing({ job, caseDoc: null }));
    });

    const shapedCases = [];
    cases.forEach((caseDoc) => {
      const key = String(caseDoc._id);
      const job = jobByCaseId.get(key) || null;
      if (job) jobByCaseId.delete(key);
      if (!job) {
        const fallbackCase = { ...caseDoc, jobId: null };
        shapedCases.push(shapeListing({ job: null, caseDoc: fallbackCase }));
        return;
      }
      shapedCases.push(shapeListing({ job, caseDoc }));
    });

    const items = [...shapedCases, ...orphanJobs];
    if (items.length > limit) {
      items.length = limit;
    }
    if (items.length) {
      const jobIds = items.map((item) => item.jobId).filter(Boolean);
      if (jobIds.length) {
        const apps = await Application.find({
          paralegalId: req.user._id || req.user.id,
          jobId: { $in: jobIds },
          status: { $ne: "withdrawn" },
        })
          .select("jobId createdAt")
          .lean();
        const appliedMap = new Map(apps.map((app) => [String(app.jobId), app.createdAt]));
        items.forEach((item) => {
          const appliedAt = appliedMap.get(String(item.jobId || ""));
          if (appliedAt) item.appliedAt = appliedAt;
        });
      }
    }

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
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

// POST /jobs/:jobId/apply — paralegal applies
router.post("/:jobId/apply", ...mutatingGuards, requireRole("paralegal"), async (req, res) => {
  try {
    if (!createApplicationForJob) {
      return res.status(500).json({ error: "Applications service unavailable" });
    }
    const application = await createApplicationForJob(req.params.jobId, req.user, req.body?.coverLetter || "");
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
