const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Application = require("../models/Application");
const Job = require("../models/Job");
const Case = require("../models/Case");
const User = require("../models/User");
const auth = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { shapeParalegalSnapshot } = require("../utils/profileSnapshots");
const stripe = require("../utils/stripe");
const { BLOCKED_MESSAGE, getBlockedUserIds, isBlockedBetween } = require("../utils/blocks");

function sanitizeMessage(value, { min = 0, max = 2000 } = {}) {
  if (typeof value !== "string") return "";
  const stripped = value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!stripped) return "";
  return stripped.slice(0, Math.max(1, max));
}

async function ensureStripeOnboardedUser(userDoc) {
  if (!userDoc?.stripeAccountId) return false;
  if (userDoc.stripeOnboarded && userDoc.stripePayoutsEnabled) return true;
  try {
    const account = await stripe.accounts.retrieve(userDoc.stripeAccountId);
    const submitted = !!account?.details_submitted;
    const chargesEnabled = !!account?.charges_enabled;
    const payoutsEnabled = !!account?.payouts_enabled;
    userDoc.stripeChargesEnabled = chargesEnabled;
    userDoc.stripePayoutsEnabled = payoutsEnabled;
    userDoc.stripeOnboarded = submitted && payoutsEnabled;
    await userDoc.save();
    return userDoc.stripeOnboarded;
  } catch (err) {
    console.warn("[applications] stripe onboarding status check failed", err?.message || err);
  }
  return false;
}

async function getCaseApplicationsForAttorney(attorneyId, blockedSet = null) {
  const cases = await Case.find({
    attorneyId,
    "applicants.0": { $exists: true },
  })
    .select("title practiceArea totalAmount lockedTotalAmount currency applicants createdAt")
    .populate("applicants.paralegalId", "firstName lastName email role profileImage avatarURL")
    .lean();

  const entries = [];
  cases.forEach((caseDoc) => {
    const amountCents = Number.isFinite(caseDoc.lockedTotalAmount)
      ? caseDoc.lockedTotalAmount
      : caseDoc.totalAmount;
    const budget = typeof amountCents === "number" ? Math.round(amountCents / 100) : null;
    const caseId = String(caseDoc._id || "");
    const jobTitle = caseDoc.title || "Case";
    const practiceArea = caseDoc.practiceArea || "";
    const fallbackDate = caseDoc.createdAt || null;
    (caseDoc.applicants || []).forEach((applicant) => {
      const paralegal = applicant?.paralegalId || null;
      const paralegalId = paralegal?._id || applicant?.paralegalId || "";
      if (blockedSet && paralegalId && blockedSet.has(String(paralegalId))) {
        return;
      }
      entries.push({
        id: `case:${caseId}:${paralegalId || "unknown"}`,
        jobId: null,
        jobTitle,
        practiceArea,
        budget,
        caseId,
        paralegal,
        coverLetter: applicant?.note || applicant?.coverLetter || "",
        createdAt: applicant?.appliedAt || fallbackDate,
      });
    });
  });

  return entries;
}

async function createApplicationForJob(jobId, user, coverLetter) {
  if (!mongoose.isValidObjectId(jobId)) {
    const err = new Error("Invalid job id");
    err.status = 400;
    throw err;
  }
  if (!user || String(user.status || "").toLowerCase() !== "approved") {
    const err = new Error("Account pending approval");
    err.status = 403;
    throw err;
  }
  if (!user || String(user.role).toLowerCase() !== "paralegal") {
    const err = new Error("Only paralegals may apply to jobs");
    err.status = 403;
    throw err;
  }

  const job = await Job.findById(jobId);
  if (!job) {
    const err = new Error("Job not found");
    err.status = 404;
    throw err;
  }
  const attorneyId = job.attorneyId?._id || job.attorneyId || null;
  if (attorneyId && (await isBlockedBetween(user._id, attorneyId))) {
    const err = new Error(BLOCKED_MESSAGE);
    err.status = 403;
    throw err;
  }
  if (job.status !== "open") {
    const err = new Error("Applications are closed for this job");
    err.status = 400;
    throw err;
  }

  const existing = await Application.findOne({ jobId, paralegalId: user._id });
  if (existing) {
    const err = new Error("You have already applied to this job");
    err.status = 400;
    throw err;
  }

  const note = sanitizeMessage(coverLetter, { min: 20, max: 2000 });
  if (note.length < 20) {
    const err = new Error("Cover letter must be at least 20 characters.");
    err.status = 400;
    throw err;
  }

  const applicant = await User.findById(user._id).select(
    "firstName lastName role stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled resumeURL linkedInURL availability availabilityDetails location languages specialties yearsExperience bio profileImage avatarURL"
  );
  if (!applicant) {
    const err = new Error("Unable to load your profile details.");
    err.status = 404;
    throw err;
  }
  if (!applicant.stripeAccountId) {
    const err = new Error("Connect Stripe before applying to jobs.");
    err.status = 403;
    throw err;
  }
  if (!applicant.stripeOnboarded || !applicant.stripePayoutsEnabled) {
    const refreshed = await ensureStripeOnboardedUser(applicant);
    if (!refreshed) {
      const err = new Error("Complete Stripe onboarding before applying to jobs.");
      err.status = 403;
      throw err;
    }
  }

  const application = await Application.create({
    jobId,
    paralegalId: user._id,
    coverLetter: note,
    resumeURL: applicant.resumeURL || "",
    linkedInURL: applicant.linkedInURL || "",
    profileSnapshot: shapeParalegalSnapshot(applicant),
  });
  await Job.findByIdAndUpdate(jobId, { $inc: { applicantsCount: 1 } });

  // Notify the attorney who posted the job
  try {
    const attorneyId =
      job.attorneyId && job.attorneyId._id
        ? job.attorneyId._id
        : job.attorneyId || null;
    if (attorneyId) {
      const paralegalName =
        `${applicant.firstName || ""} ${applicant.lastName || ""}`.trim() || "Paralegal";
      await require("../utils/notifyUser").notifyUser(attorneyId, "application_submitted", {
        jobId: job._id,
        caseId: job.caseId || null,
        title: job.title || "Job application",
        caseTitle: job.title || "Job application",
        paralegalName,
        paralegalId: user._id,
      });
    }
  } catch (err) {
    console.warn("[applications] Failed to notify attorney of application", err?.message || err);
  }

  return application;
}

// GET /applications/my — paralegal views jobs they've applied to
router.get("/my", auth, requireApproved, requireRole("paralegal"), async (req, res) => {
  try {
    const apps = await Application.find({ paralegalId: req.user._id })
      .populate("jobId");

    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /applications/for-job/:jobId — attorney views applicants
router.get("/for-job/:jobId", auth, requireApproved, requireRole("admin", "attorney"), async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const isOwner = job.attorneyId && String(job.attorneyId) === String(req.user._id);
    if (req.user.role !== "admin" && !isOwner) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const blockedIds =
      req.user.role === "attorney" ? await getBlockedUserIds(req.user._id || req.user.id) : [];
    const appFilter = { jobId: req.params.jobId };
    if (blockedIds.length) {
      appFilter.paralegalId = { $nin: blockedIds };
    }
    const apps = await Application.find(appFilter).populate(
      "paralegalId",
      "firstName lastName email role"
    );

    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /applications/my-postings — attorney sees applications to their jobs
router.get("/my-postings", auth, requireApproved, requireRole("attorney"), async (req, res) => {
  try {
    const jobs = await Job.find({ attorneyId: req.user._id }).select("_id title practiceArea budget caseId");
    const blockedIds = await getBlockedUserIds(req.user._id || req.user.id);
    const blockedSet = blockedIds.length ? new Set(blockedIds.map((id) => String(id))) : null;
    const caseApps = await getCaseApplicationsForAttorney(req.user._id, blockedSet);
    if (!jobs.length && !caseApps.length) return res.json([]);
    const jobIds = jobs.map((j) => j._id);
    const jobById = new Map(jobs.map((j) => [String(j._id), j]));
    const appFilter = { jobId: { $in: jobIds } };
    if (blockedIds.length) {
      appFilter.paralegalId = { $nin: blockedIds };
    }
    const apps = await Application.find(appFilter)
      .populate("paralegalId", "firstName lastName email role profileImage avatarURL")
      .sort({ createdAt: -1 })
      .lean();
    const shaped = apps.map((app) => {
      const job = jobById.get(String(app.jobId?._id || app.jobId)) || {};
      return {
        id: String(app._id),
        jobId: app.jobId?._id || app.jobId || null,
        jobTitle: job.title || "Job",
        practiceArea: job.practiceArea || "",
        budget: job.budget || null,
        caseId: job.caseId || null,
        paralegal: app.paralegalId || null,
        coverLetter: app.coverLetter || "",
        createdAt: app.createdAt,
      };
    });
    const combined = [...caseApps, ...shaped].sort((a, b) => {
      const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
    res.json(combined);
  } catch (err) {
    console.error("[applications] my-postings error", err);
    res.status(500).json({ error: "Unable to load applications." });
  }
});

router.createApplicationForJob = createApplicationForJob;

module.exports = router;
