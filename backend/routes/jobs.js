const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Job = require("../models/Job");
const Application = require("../models/Application");
const Case = require("../models/Case");
const User = require("../models/User");
const auth = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const applicationsRouter = require("./applications");
const { cleanTitle, cleanText, cleanBudget } = require("../utils/sanitize");
const { getBlockedUserIds } = require("../utils/blocks");
const stripe = require("../utils/stripe");
const createApplicationForJob = applicationsRouter?.createApplicationForJob;
const STRIPE_PAYMENT_METHOD_BYPASS_EMAILS = new Set([
  "samanthasider+attorney@gmail.com",
  "samanthasider+56@gmail.com",
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);
const PRACTICE_AREAS = [
  "administrative law",
  "bankruptcy",
  "business law",
  "civil litigation",
  "commercial litigation",
  "contract law",
  "corporate law",
  "criminal defense",
  "employment law",
  "estate planning",
  "family law",
  "immigration",
  "intellectual property",
  "labor law",
  "personal injury",
  "real estate",
  "tax law",
  "technology",
  "trusts & estates",
];
const PRACTICE_AREA_LOOKUP = PRACTICE_AREAS.reduce((acc, name) => {
  acc[name.toLowerCase()] = name;
  return acc;
}, {});

async function attorneyHasPaymentMethod(attorneyId) {
  if (!attorneyId) return false;
  try {
    const attorney = await User.findById(attorneyId).select("email stripeCustomerId");
    const attorneyEmail = String(attorney?.email || "").toLowerCase().trim();
    if (STRIPE_PAYMENT_METHOD_BYPASS_EMAILS.has(attorneyEmail)) return true;
    if (!attorney?.stripeCustomerId) return false;
    const customer = await stripe.customers.retrieve(attorney.stripeCustomerId);
    return Boolean(customer?.invoice_settings?.default_payment_method);
  } catch (err) {
    console.warn("[jobs] Unable to verify attorney payment method", err?.message || err);
    return false;
  }
}

// POST /jobs — Attorney posts a job
router.post("/", auth, requireApproved, requireRole("attorney"), async (req, res) => {
  try {
    const hasPaymentMethod = await attorneyHasPaymentMethod(req.user._id || req.user.id);
    if (!hasPaymentMethod) {
      return res
        .status(403)
        .json({ error: "Connect Stripe and add a payment method before posting a job." });
    }
    const caseId = req.body?.caseId || null;
    let caseDoc = null;
    if (caseId) {
      if (!mongoose.isValidObjectId(caseId)) {
        return res.status(400).json({ error: "Invalid case id" });
      }
      caseDoc = await Case.findById(caseId).select("attorney attorneyId jobId");
      if (!caseDoc) {
        return res.status(404).json({ error: "Case not found" });
      }
      const ownerId = String(caseDoc.attorneyId || caseDoc.attorney || "");
      if (!ownerId || ownerId !== String(req.user._id)) {
        return res.status(403).json({ error: "You are not the attorney for this case" });
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
    const attorneyState = String(attorneyProfile?.state || "").trim().toUpperCase();
    if (!attorneyState) {
      return res.status(400).json({ error: "Attorney profile state is required to post a job." });
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
      budget = cleanBudget(req.body.budget, { min: 400, max: 30000 });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const job = await Job.create({
      caseId: caseDoc?._id || null,
      attorneyId: req.user._id,
      title,
      practiceArea: practiceAreaValue,
      description,
      budget: Math.round(budget),
      state: attorneyState,
      locationState: attorneyState,
    });

    if (caseDoc && !caseDoc.jobId) {
      caseDoc.jobId = job._id;
      await caseDoc.save();
    }

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    profileImage: doc.profileImage || doc.avatarURL || "",
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

function shapeListing({ job = null, caseDoc = null }) {
  const totalAmount = typeof caseDoc?.totalAmount === "number" ? caseDoc.totalAmount : null;
  const lockedTotalAmount = typeof caseDoc?.lockedTotalAmount === "number" ? caseDoc.lockedTotalAmount : null;
  const amountForCase = lockedTotalAmount != null ? lockedTotalAmount : totalAmount;
  const budgetFromCase = amountForCase != null ? Math.round(amountForCase / 100) : null;
  const attorneySource = job?.attorneyId || caseDoc?.attorney || null;
  const normalizedAttorneyId =
    normalizeId(job?.attorneyId) || normalizeId(caseDoc?.attorneyId) || normalizeId(caseDoc?.attorney);
  const jobState = job?.state || job?.locationState || "";
  const caseState = caseDoc?.state || caseDoc?.locationState || "";
  const resolvedState = jobState || caseState;

  return {
    id: caseDoc?._id || job?.caseId || job?._id,
    _id: caseDoc?._id || job?._id,
    caseId: caseDoc?._id || job?.caseId || null,
    jobId: job?._id || caseDoc?.jobId || null,
    title: job?.title || caseDoc?.title || "Untitled Case",
    practiceArea: job?.practiceArea || caseDoc?.practiceArea || "",
    briefSummary: caseDoc?.briefSummary || "",
    shortDescription: job?.shortDescription || caseDoc?.briefSummary || "",
    description: job?.description || caseDoc?.details || "",
    totalAmount,
    lockedTotalAmount,
    budget: typeof job?.budget === "number" ? job.budget : budgetFromCase,
    currency: caseDoc?.currency || "usd",
    state: resolvedState,
    locationState: job?.locationState || job?.state || caseDoc?.locationState || caseDoc?.state || "",
    createdAt: job?.createdAt || caseDoc?.createdAt || new Date(),
    attorneyId: normalizedAttorneyId,
    attorney: buildAttorneyPreview(attorneySource),
    applicantsCount: Array.isArray(caseDoc?.applicants) ? caseDoc.applicants.length : job?.applicantsCount || 0,
    status: caseDoc?.status || job?.status || "open",
    contextCaseId: caseDoc?._id || job?.caseId || null,
    tasks: Array.isArray(caseDoc?.tasks) ? caseDoc.tasks : [],
  };
}

// GET /jobs/open — paralegals view available jobs
router.get("/open", auth, requireApproved, requireRole("paralegal"), async (req, res) => {
  try {
    const blockedIds = await getBlockedUserIds(req.user.id);
    const jobFilter = { status: "open" };
    const caseFilter = {
      archived: { $ne: true },
      status: "open",
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
        .populate({
          path: "attorneyId",
          select: "firstName lastName lawFirm firmName profileImage avatarURL",
        })
        .lean(),
      Case.find(caseFilter)
        .select("title practiceArea details briefSummary totalAmount lockedTotalAmount currency state locationState status applicants attorney attorneyId jobId createdAt tasks")
        .populate({
          path: "attorney",
          select: "firstName lastName lawFirm firmName profileImage avatarURL",
        })
        .lean(),
    ]);

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
      orphanJobs.push(shapeListing({ job, caseDoc: null }));
    });

    const shapedCases = [];
    cases.forEach((caseDoc) => {
      const key = String(caseDoc._id);
      const job = jobByCaseId.get(key) || null;
      if (job) jobByCaseId.delete(key);
      if (!job) return;
      shapedCases.push(shapeListing({ job, caseDoc }));
    });

    const items = [...shapedCases, ...orphanJobs];
    if (items.length) {
      const jobIds = items.map((item) => item.jobId).filter(Boolean);
      if (jobIds.length) {
        const apps = await Application.find({
          paralegalId: req.user._id || req.user.id,
          jobId: { $in: jobIds },
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
    res.status(500).json({ error: err.message });
  }
});

// GET /jobs/my — attorney views their posted jobs
router.get("/my", auth, requireApproved, requireRole("attorney"), async (req, res) => {
  try {
    const jobs = await Job.find({ attorneyId: req.user._id });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /jobs/:jobId/apply — paralegal applies
router.post("/:jobId/apply", auth, requireApproved, requireRole("paralegal"), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// POST /jobs/:jobId/hire/:paralegalId — disabled to avoid hiring without funded escrow
router.post("/:jobId/hire/:paralegalId", auth, requireRole(["attorney"]), async (_req, res) => {
  return res.status(410).json({
    error: "Direct job-to-paralegal hire is disabled. Use the case hire + funding flow to ensure the case is funded.",
  });
});

module.exports = router;
