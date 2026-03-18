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
const STRIPE_PAYMENT_METHOD_BYPASS_EMAILS = new Set([
  "samanthasider+attorney@gmail.com",
  "samanthasider+56@gmail.com",
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);
const PROFILE_PHOTO_REQUIRED_MESSAGE = "Complete your profile before applying.";
const REAPPLY_BYPASS_EMAILS = new Set(["samanthasider+0@gmail.com"]);
const ACTIVE_APPLICATION_FILTER = { status: { $nin: ["accepted", "rejected"] } };
const authenticatedGuards = [auth, requireApproved];
const INVITE_STATUSES = new Set(["pending", "accepted", "declined", "expired"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const noop = (_req, _res, next) => next();
const csrf = require("csurf");
const csrfMiddleware = csrf({
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  },
});
const protectMutations = (req, res, next) => {
  const requireCsrf = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
  if (!requireCsrf) return noop(req, res, next);
  const method = String(req.method || "").toUpperCase();
  if (SAFE_METHODS.has(method)) return next();
  return csrfMiddleware(req, res, next);
};

const mutatingGuards = [...authenticatedGuards, protectMutations];

function sanitizeMessage(value, { min = 0, max = 2000 } = {}) {
  if (typeof value !== "string") return "";
  const stripped = value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!stripped) return "";
  return stripped.slice(0, Math.max(1, max));
}

function normalizeInviteStatus(value) {
  const key = String(value || "").toLowerCase();
  return INVITE_STATUSES.has(key) ? key : "pending";
}

function normalizeInviteParalegalId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return String(value._id || value.id || value.userId || "");
  }
  return String(value);
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
    console.warn("[applications] Unable to verify attorney payment method", err?.message || err);
    return false;
  }
}

async function syncApplicantsCount(jobId) {
  if (!mongoose.isValidObjectId(jobId)) return 0;
  const count = await Application.countDocuments({
    jobId,
    ...ACTIVE_APPLICATION_FILTER,
  });
  await Job.findByIdAndUpdate(jobId, { $set: { applicantsCount: count } });
  return count;
}

async function getCaseApplicationsForAttorney(attorneyId, blockedSet = null) {
  const attorneyKey = String(attorneyId || "");
  const ownershipFilters = [];
  if (attorneyId) {
    ownershipFilters.push({ attorneyId }, { attorney: attorneyId });
  }
  const cases = await Case.find({
    ...(ownershipFilters.length ? { $or: ownershipFilters } : {}),
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
      const status = String(applicant?.status || "pending").toLowerCase();
      if (status !== "pending") return;
      const paralegal = applicant?.paralegalId || null;
      const paralegalId = paralegal?._id || applicant?.paralegalId || "";
      if (blockedSet && paralegalId && blockedSet.has(String(paralegalId))) {
        return;
      }
      const starred =
        !!attorneyKey &&
        Array.isArray(applicant?.starredBy) &&
        applicant.starredBy.some((id) => String(id) === attorneyKey);
      entries.push({
        id: `case:${caseId}:${paralegalId || "unknown"}`,
        jobId: null,
        jobTitle,
        practiceArea,
        budget,
        caseId,
        paralegal,
        coverLetter: applicant?.note || applicant?.coverLetter || "",
        starred,
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
  const attorneyReady = await attorneyHasPaymentMethod(attorneyId);
  if (!attorneyReady) {
    const err = new Error("This attorney must connect Stripe before applications can be submitted.");
    err.status = 403;
    throw err;
  }
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
  const requestEmail = String(user?.email || "").toLowerCase().trim();
  const allowReapply = REAPPLY_BYPASS_EMAILS.has(requestEmail);
  let caseDoc = null;
  if (job.caseId) {
    caseDoc = await Case.findById(job.caseId).select(
      "status archived paralegal paralegalId totalAmount lockedTotalAmount amountLockedAt title attorney attorneyId relistRequestedAt payoutFinalizedAt"
    );
    if (!caseDoc) {
      const err = new Error("Case not found");
      err.status = 404;
      throw err;
    }
    if (caseDoc.archived) {
      const err = new Error("This case is not accepting applications");
      err.status = 400;
      throw err;
    }
    if (caseDoc.paralegal || caseDoc.paralegalId) {
      const err = new Error("A paralegal has already been hired");
      err.status = 400;
      throw err;
    }
    const statusKey = String(caseDoc.status || "").toLowerCase();
    const relisted = statusKey === "paused" && caseDoc.relistRequestedAt && caseDoc.payoutFinalizedAt;
    if (statusKey !== "open" && !relisted) {
      const err = new Error("Applications are closed for this case");
      err.status = 400;
      throw err;
    }
  }

  const existingCount = await Application.countDocuments({ jobId, paralegalId: user._id });
  if (existingCount && !allowReapply) {
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
    "firstName lastName email role stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled resumeURL linkedInURL availability availabilityDetails location languages specialties yearsExperience bio profileImage avatarURL"
  );
  if (!applicant) {
    const err = new Error("Unable to load your profile details.");
    err.status = 404;
    throw err;
  }
  if (!applicant.profileImage && !applicant.avatarURL) {
    const err = new Error(PROFILE_PHOTO_REQUIRED_MESSAGE);
    err.status = 403;
    throw err;
  }
  const stripeBypassEmails = new Set(["samanthasider+11@gmail.com", "samanthasider+56@gmail.com"]);
  const applicantEmail = String(applicant.email || user?.email || "").toLowerCase().trim();
  const bypassStripe = stripeBypassEmails.has(applicantEmail);
  if (!bypassStripe) {
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
  }

  if (allowReapply && existingCount) {
    await Application.deleteMany({ jobId, paralegalId: user._id });
    await syncApplicantsCount(jobId);
  }

  let application = null;
  try {
    application = await Application.create({
      jobId,
      paralegalId: user._id,
      coverLetter: note,
      resumeURL: applicant.resumeURL || "",
      linkedInURL: applicant.linkedInURL || "",
      profileSnapshot: shapeParalegalSnapshot(applicant),
    });
  } catch (err) {
    if (err?.code === 11000) {
      const duplicate = new Error("You have already applied to this job");
      duplicate.status = 400;
      throw duplicate;
    }
    throw err;
  }
  await syncApplicantsCount(jobId);
  const lockedNow = !!caseDoc && caseDoc.lockedTotalAmount == null;
  if (caseDoc && lockedNow) {
    caseDoc.lockedTotalAmount = caseDoc.totalAmount;
    caseDoc.amountLockedAt = caseDoc.amountLockedAt || new Date();
    await caseDoc.save();
  }

  // Notify the attorney who posted the job
  try {
    const attorneyId =
      job.attorneyId && job.attorneyId._id
        ? job.attorneyId._id
        : job.attorneyId || null;
    if (attorneyId) {
      const paralegalName =
        `${applicant.firstName || ""} ${applicant.lastName || ""}`.trim() || "Paralegal";
      if (lockedNow) {
        const caseTitle = caseDoc?.title || job.title || "Case";
        const caseLink = caseDoc?._id ? `case-detail.html?caseId=${encodeURIComponent(caseDoc._id)}` : "";
        await require("../utils/notifyUser").notifyUser(
          attorneyId,
          "case_budget_locked",
          {
            caseId: caseDoc?._id || job.caseId || null,
            caseTitle,
            link: caseLink,
          },
          { actorUserId: user._id }
        );
      }
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
router.get("/my", ...authenticatedGuards, requireRole("paralegal"), async (req, res) => {
  try {
    const apps = await Application.find({ paralegalId: req.user._id })
      .populate({
        path: "jobId",
        populate: {
          path: "attorneyId",
          select: "firstName lastName name",
        },
      })
      .lean();
    const visible = apps.filter((app) => app?.jobId && typeof app.jobId === "object");
    const caseIds = visible
      .map((app) => app?.jobId?.caseId)
      .filter((value) => mongoose.isValidObjectId(value));
    const invitedCases = await Case.find({
      archived: { $ne: true },
      applicants: { $elemMatch: { paralegalId: req.user._id } },
    })
      .select(
        "_id title practiceArea details briefSummary totalAmount lockedTotalAmount currency status createdAt jobId attorney attorneyId paralegal paralegalId applicants preEngagement invites"
      )
      .populate("attorney", "firstName lastName name")
      .populate("attorneyId", "firstName lastName name")
      .lean();
    const combinedCaseIds = [
      ...caseIds,
      ...invitedCases.map((doc) => doc?._id).filter((value) => mongoose.isValidObjectId(value)),
    ];
    const caseDocs = combinedCaseIds.length
      ? await Case.find({ _id: { $in: combinedCaseIds } })
          .select("_id preEngagement paymentReleased escrowStatus")
          .lean()
      : [];
    const casesById = new Map(caseDocs.map((doc) => [String(doc._id), doc]));
    const viewerId = String(req.user._id || "");
    const payload = visible.map((app) => {
      const job = app.jobId && typeof app.jobId === "object" ? app.jobId : null;
      const caseId = job?.caseId ? String(job.caseId) : "";
      const caseDoc = caseId ? casesById.get(caseId) : null;
      const pre = caseDoc?.preEngagement || null;
      const attorneyName =
        job?.attorneyId?.name ||
        [job?.attorneyId?.firstName, job?.attorneyId?.lastName].filter(Boolean).join(" ").trim() ||
        "";
      const matchesRequestedParalegal =
        !!pre?.requestedParalegalId &&
        String(pre.requestedParalegalId) === viewerId &&
        ["requested", "submitted", "changes_requested"].includes(String(pre.status || "").toLowerCase());
      return {
        ...app,
        caseId: caseId || null,
        casePaymentReleased: caseDoc?.paymentReleased === true,
        caseEscrowStatus: caseDoc?.escrowStatus || null,
        preEngagement: matchesRequestedParalegal
          ? {
              status: String(pre.status || "requested").toLowerCase(),
              requestedParalegalId: String(pre.requestedParalegalId),
              confidentialityAgreementRequired: !!pre.confidentialityAgreementRequired,
              conflictsCheckRequired: !!pre.conflictsCheckRequired,
              conflictsDetails: pre.conflictsDetails || "",
              confidentialityDocument: pre.confidentialityDocument || null,
              paralegalConfidentialityDocument: pre.paralegalConfidentialityDocument || null,
              requestedAt: pre.requestedAt || null,
              requestedBy: pre.requestedBy ? String(pre.requestedBy) : null,
              requestedByName: attorneyName || null,
              confidentialityAcknowledged: !!pre.confidentialityAcknowledged,
              confidentialityAcknowledgedAt: pre.confidentialityAcknowledgedAt || null,
              conflictsResponseType: pre.conflictsResponseType || "",
              conflictsDisclosureText: pre.conflictsDisclosureText || "",
              submittedAt: pre.submittedAt || null,
              submittedBy: pre.submittedBy ? String(pre.submittedBy) : null,
              reviewedAt: pre.reviewedAt || null,
              reviewedBy: pre.reviewedBy ? String(pre.reviewedBy) : null,
            }
          : null,
      };
    });
    const visibleCaseIdSet = new Set(
      visible
        .map((app) => {
          const job = app?.jobId && typeof app.jobId === "object" ? app.jobId : null;
          return String(job?.caseId || "");
        })
        .filter(Boolean)
    );
    const inviteEntries = invitedCases
      .map((caseDoc) => {
        const caseId = String(caseDoc?._id || "");
        if (!caseId || visibleCaseIdSet.has(caseId)) return null;
        if (caseDoc?.paralegal || caseDoc?.paralegalId) return null;
        const applicantEntry = Array.isArray(caseDoc?.applicants)
          ? caseDoc.applicants.find((entry) => String(entry?.paralegalId || "") === viewerId)
          : null;
        if (!applicantEntry) return null;
        const relatedInvite = Array.isArray(caseDoc?.invites)
          ? caseDoc.invites.find(
              (invite) =>
                normalizeInviteParalegalId(invite?.paralegalId) === viewerId &&
                normalizeInviteStatus(invite?.status) === "accepted"
            )
          : null;
        if (!relatedInvite) return null;
        const pre = caseDocs.length ? casesById.get(caseId)?.preEngagement || caseDoc?.preEngagement || null : caseDoc?.preEngagement || null;
        const attorneyName =
          caseDoc?.attorney?.name ||
          caseDoc?.attorneyId?.name ||
          [caseDoc?.attorney?.firstName, caseDoc?.attorney?.lastName].filter(Boolean).join(" ").trim() ||
          [caseDoc?.attorneyId?.firstName, caseDoc?.attorneyId?.lastName].filter(Boolean).join(" ").trim() ||
          "";
        const matchesRequestedParalegal =
          !!pre?.requestedParalegalId &&
          String(pre.requestedParalegalId) === viewerId &&
          ["requested", "submitted", "changes_requested"].includes(String(pre.status || "").toLowerCase());
        const amountCents = Number.isFinite(caseDoc?.lockedTotalAmount) ? caseDoc.lockedTotalAmount : caseDoc?.totalAmount;
        const budget = typeof amountCents === "number" ? Math.round(amountCents / 100) : null;
        return {
          id: "",
          _id: "",
          status: String(applicantEntry?.status || "pending").toLowerCase(),
          createdAt: applicantEntry?.appliedAt || relatedInvite?.respondedAt || relatedInvite?.invitedAt || caseDoc?.createdAt || null,
          updatedAt: caseDoc?.updatedAt || null,
          coverLetter: applicantEntry?.note || "Accepted invitation",
          caseId,
          casePaymentReleased: caseDoc?.paymentReleased === true,
          caseEscrowStatus: caseDoc?.escrowStatus || null,
          applicationSource: "invite_accept",
          jobId: {
            _id: caseDoc?.jobId ? String(caseDoc.jobId) : caseId,
            id: caseDoc?.jobId ? String(caseDoc.jobId) : caseId,
            caseId,
            title: caseDoc?.title || "Case",
            practiceArea: caseDoc?.practiceArea || "",
            description: caseDoc?.details || caseDoc?.briefSummary || "",
            budget,
            status: String(caseDoc?.status || "open").toLowerCase(),
            attorneyId: caseDoc?.attorneyId || caseDoc?.attorney || null,
          },
          preEngagement: matchesRequestedParalegal
            ? {
                status: String(pre.status || "requested").toLowerCase(),
                requestedParalegalId: String(pre.requestedParalegalId),
                confidentialityAgreementRequired: !!pre.confidentialityAgreementRequired,
                conflictsCheckRequired: !!pre.conflictsCheckRequired,
                conflictsDetails: pre.conflictsDetails || "",
                confidentialityDocument: pre.confidentialityDocument || null,
                paralegalConfidentialityDocument: pre.paralegalConfidentialityDocument || null,
                requestedAt: pre.requestedAt || null,
                requestedBy: pre.requestedBy ? String(pre.requestedBy) : null,
                requestedByName: attorneyName || null,
                confidentialityAcknowledged: !!pre.confidentialityAcknowledged,
                confidentialityAcknowledgedAt: pre.confidentialityAcknowledgedAt || null,
                conflictsResponseType: pre.conflictsResponseType || "",
                conflictsDisclosureText: pre.conflictsDisclosureText || "",
                submittedAt: pre.submittedAt || null,
                submittedBy: pre.submittedBy ? String(pre.submittedBy) : null,
                reviewedAt: pre.reviewedAt || null,
                reviewedBy: pre.reviewedBy ? String(pre.reviewedBy) : null,
              }
            : null,
        };
      })
      .filter(Boolean);
    res.json([...payload, ...inviteEntries]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /applications/:applicationId/revoke — paralegal revokes their application
router.post(
  "/:applicationId/revoke",
  ...mutatingGuards,
  requireRole("paralegal"),
  async (req, res) => {
    try {
      const applicationId = req.params.applicationId;
      if (!mongoose.isValidObjectId(applicationId)) {
        return res.status(400).json({ error: "Invalid application id." });
      }
      const application = await Application.findOne({
        _id: applicationId,
        paralegalId: req.user._id,
      });
      if (!application) {
        return res.status(404).json({ error: "Application not found." });
      }
      let caseDoc = null;
      if (application.jobId && mongoose.isValidObjectId(application.jobId)) {
        const job = await Job.findById(application.jobId).select("caseId");
        if (job?.caseId && mongoose.isValidObjectId(job.caseId)) {
          caseDoc = await Case.findById(job.caseId).select("paymentReleased escrowStatus applicants");
        }
      }
      const funded =
        caseDoc?.paymentReleased === true ||
        String(caseDoc?.escrowStatus || "").toLowerCase() === "funded";
      if (String(application.status || "").toLowerCase() === "accepted" && funded) {
        return res.status(400).json({ error: "Accepted applications cannot be revoked after funding." });
      }

      const jobId = application.jobId;
      await application.deleteOne();
      if (caseDoc && Array.isArray(caseDoc.applicants)) {
        await Case.updateOne(
          { _id: caseDoc._id },
          { $pull: { applicants: { paralegalId: req.user._id } } }
        );
      }
      if (jobId) {
        await syncApplicantsCount(jobId);
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("[applications] revoke error", err);
      return res.status(500).json({ error: "Unable to revoke application." });
    }
  }
);

// GET /applications/for-job/:jobId — attorney views applicants
router.get("/for-job/:jobId", ...authenticatedGuards, requireRole("admin", "attorney"), async (req, res) => {
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
router.get("/my-postings", ...authenticatedGuards, requireRole("attorney"), async (req, res) => {
  try {
    const jobs = await Job.find({ attorneyId: req.user._id }).select("_id title practiceArea budget caseId");
    const blockedIds = await getBlockedUserIds(req.user._id || req.user.id);
    const blockedSet = blockedIds.length ? new Set(blockedIds.map((id) => String(id))) : null;
    const caseApps = await getCaseApplicationsForAttorney(req.user._id, blockedSet);
    if (!jobs.length && !caseApps.length) return res.json([]);
    const jobIds = jobs.map((j) => j._id);
    const jobById = new Map(jobs.map((j) => [String(j._id), j]));
    const appFilter = { jobId: { $in: jobIds }, status: { $nin: ["accepted", "rejected"] } };
    if (blockedIds.length) {
      appFilter.paralegalId = { $nin: blockedIds };
    }
    const apps = await Application.find(appFilter)
      .populate("paralegalId", "firstName lastName email role profileImage avatarURL")
      .sort({ createdAt: -1 })
      .lean();
    const shaped = apps.map((app) => {
      const job = jobById.get(String(app.jobId?._id || app.jobId)) || {};
      const starred =
        Array.isArray(app.starredBy) &&
        app.starredBy.some((id) => String(id) === String(req.user._id || req.user.id));
      return {
        id: String(app._id),
        jobId: app.jobId?._id || app.jobId || null,
        jobTitle: job.title || "Job",
        practiceArea: job.practiceArea || "",
        budget: job.budget || null,
        caseId: job.caseId ? String(job.caseId._id || job.caseId) : null,
        paralegal: app.paralegalId || null,
        coverLetter: app.coverLetter || "",
        starred,
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
