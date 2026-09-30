const { reportOperationalFailure } = require("../utils/operationalFailure");
const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:applications");
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Application = require("../models/Application");
const accountApplications = require("../services/accountApplicationProjections");
const Job = require("../models/Job");
const Case = require("../models/Case");
const User = require("../models/User");
const auth = require("../utils/verifyToken");
const { cleanPlainText } = require("../utils/sanitize");
const { requireApproved, requireRole } = require("../utils/authz");
const { shapeParalegalSnapshot } = require("../utils/profileSnapshots");
const { captureResumeReference, withResumeReferenceWrite } = require("../utils/resumeReferenceWrite");
const { BLOCKED_MESSAGE, getBlockedUserIds, isBlockedBetween } = require("../utils/blocks");
const { evaluateApplicationEligibility } = require("../services/paralegalWorkflowPolicy");
const { createDevOnlyEmailSet } = require("../utils/devOnlyEmailSet");
const { hasStripeConnectBypass } = require("../utils/stripeConnectBypass");
const { resolveLivePayoutReadiness } = require("../services/paralegalReadinessService");
const { buildAuthenticatedProfilePhotoUrl } = require("../services/profilePhotoDelivery");
const { protectMutations } = require("../utils/csrf");
const { publishNotificationEvent } = require("../utils/notificationEvents");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const { notifyUser } = require("../utils/notifyUser");
require("../models/MatterApplicationNotification");
const {
  syncApplicationMirror,
} = require("../services/applicationService");
const {
  getHistoricalRecommendationExclusions,
} = require("../services/recommendationExclusionService");
const PROFILE_PHOTO_REQUIRED_MESSAGE = "Complete your profile before applying.";
const REAPPLY_BYPASS_EMAILS = createDevOnlyEmailSet(["samanthasider+0@gmail.com"]);
const authenticatedGuards = [auth, requireApproved];

function presentProfilePerson(person) {
  if (!person || typeof person !== "object") return person || null;
  const source = typeof person.toObject === "function" ? person.toObject() : person;
  const hasPhoto = Boolean(source.profileImage || source.avatarURL);
  const photoUrl = hasPhoto ? buildAuthenticatedProfilePhotoUrl(source) : "";
  return { ...source, profileImage: photoUrl, avatarURL: photoUrl };
}

const mutatingGuards = [...authenticatedGuards, protectMutations];

function sanitizeMessage(value, { max = 2000 } = {}) {
  if (typeof value !== "string") return "";
  return cleanPlainText(value.replace(/<[^>]*>/g, ""), { max: Math.max(1, max) });
}


async function ensureStripeOnboardedUser(userDoc) {
  const readiness = await resolveLivePayoutReadiness(userDoc || {});
  if (readiness.evidenceState === "verified" && !readiness.devBypass) {
    userDoc.stripeChargesEnabled = readiness.chargesEnabled;
    userDoc.stripePayoutsEnabled = readiness.payoutsEnabled;
    userDoc.stripeOnboarded = readiness.ready;
    await userDoc.save();
  }
  return readiness;
}


function applicationScope(caseDoc, job, capturedAt) {
  return {
    title: caseDoc?.title || job.title,
    description: caseDoc?.details || job.description,
    practiceArea: caseDoc?.practiceArea || job.practiceArea,
    state: caseDoc?.state || caseDoc?.locationState || job.state || job.locationState || "",
    caseId: String(caseDoc?._id || job.caseId || ""),
    totalAmount: caseDoc?.relistRequestedAt && Number.isFinite(caseDoc.remainingAmount)
      ? caseDoc.remainingAmount : caseDoc?.lockedTotalAmount ?? caseDoc?.totalAmount ?? Math.round(job.budget * 100),
    currency: caseDoc?.currency || "usd",
    deadlineDate: caseDoc?.deadlineDate || "",
    requirements: caseDoc?.requirements || job.requirements || [],
    tasks: (caseDoc?.tasks || []).filter((task) => !caseDoc.relistRequestedAt || !task.completed).map((task) => task.title),
    capturedAt,
  };
}

function applicationMatterChanged() {
  return Object.assign(new Error("This Matter changed. Review the current posting before applying again."), { status: 409, publicCode: "APPLICATION_MATTER_CHANGED" });
}

async function createApplicationForJob(jobId, user, coverLetter, requirementAnswers = []) {
  if (!mongoose.isValidObjectId(jobId)) {
    const err = new Error("Invalid Matter posting ID");
    err.status = 400;
    throw err;
  }
  if (!user || String(user.status || "").toLowerCase() !== "approved") {
    const err = new Error("Account pending approval");
    err.status = 403;
    throw err;
  }
  if (!user || String(user.role).toLowerCase() !== "paralegal") {
    const err = new Error("Only paralegals may apply to Matter postings");
    err.status = 403;
    throw err;
  }

  const job = await Job.findById(jobId);
  if (!job) {
    const err = new Error("Matter posting not found");
    err.status = 404;
    throw err;
  }
  const attorneyId = job.attorneyId?._id || job.attorneyId || null;
  const partiesBlocked = Boolean(attorneyId && (await isBlockedBetween(user._id, attorneyId)));
  if (partiesBlocked) {
    const err = new Error(BLOCKED_MESSAGE);
    err.status = 403;
    throw err;
  }
  if (job.status !== "open") {
    const err = new Error("Applications are closed for this Matter");
    err.status = 400;
    throw err;
  }
  const requestEmail = String(user?.email || "").toLowerCase().trim();
  const allowReapply = REAPPLY_BYPASS_EMAILS.has(requestEmail);
  let caseDoc = null;
  if (job.caseId) {
    caseDoc = await Case.findById(job.caseId).select(
      "status archived paralegal paralegalId totalAmount lockedTotalAmount remainingAmount amountLockedAt title details practiceArea state locationState deadlineDate tasks requirements currency attorney attorneyId relistRequestedAt payoutFinalizedAt"
    );
    if (!caseDoc) {
      const err = new Error("Matter not found");
      err.status = 404;
      throw err;
    }
    if (caseDoc.archived) {
      const err = new Error("This Matter is not accepting applications");
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
      const err = new Error("Applications are closed for this Matter");
      err.status = 400;
      throw err;
    }
  }

  const existingApplication = await Application.findOne({ jobId, paralegalId: user._id });
  const existingIsActive =
    existingApplication && String(existingApplication.status || "").toLowerCase() !== "withdrawn";
  if (existingIsActive && !allowReapply) {
    const err = new Error("You have already applied to this Matter");
    err.status = 400;
    throw err;
  }

  const note = sanitizeMessage(coverLetter, { max: 2000 });
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
  const resumeReference = captureResumeReference(applicant);
  if (!applicant.profileImage && !applicant.avatarURL) {
    const err = new Error(PROFILE_PHOTO_REQUIRED_MESSAGE);
    err.status = 403;
    throw err;
  }
  const applicantEmail = String(applicant.email || user?.email || "").toLowerCase().trim();
  const bypassStripe = hasStripeConnectBypass(applicantEmail);
  if (!bypassStripe) {
    if (!applicant.stripeAccountId) {
      const err = new Error("Connect Stripe before applying to Matters.");
      err.status = 403;
      throw err;
    }
    const refreshed = await ensureStripeOnboardedUser(applicant);
    if (!refreshed.ready) {
      const err = new Error(
        refreshed.evidenceState === "temporarily_unavailable"
          ? "Stripe payout status is temporarily unavailable. Try again before applying."
          : "Complete Stripe onboarding before applying to Matters."
      );
      err.status = 403;
      throw err;
    }
  }

  const applicationPolicy = evaluateApplicationEligibility({
    user: {
      role: user.role,
      status: user.status,
      profileImage: applicant.profileImage,
      avatarURL: applicant.avatarURL,
      stripeAccountId: applicant.stripeAccountId,
      stripeOnboarded: applicant.stripeOnboarded,
      stripeChargesEnabled: applicant.stripeChargesEnabled,
      stripePayoutsEnabled: applicant.stripePayoutsEnabled,
    },
    caseDoc,
    job,
    partiesBlocked,
    duplicateApplication: Boolean(existingIsActive && !allowReapply),
    devBypass: bypassStripe,
  });
  if (!applicationPolicy.ready) {
    const err = new Error("This application is not ready to submit.");
    err.status = 400;
    err.blockers = applicationPolicy.blockers;
    throw err;
  }

  const requirementConfirmations = await require("../services/matterRequirements").assertRequirements(job, caseDoc, user._id, requirementAnswers);
  let application = null;
  const scopeSnapshot = applicationScope(caseDoc, job, new Date());
  const dispatches = [];
  try {
    application = await withResumeReferenceWrite(resumeReference, async (session) => {
      // Bind the retained application, amount lock and recipient obligations to
      // the same current posting. The later mirror repair remains independent.
      const currentJob = await Job.findById(job._id).session(session);
      const currentCase = caseDoc ? await Case.findById(caseDoc._id).session(session) : null;
      const sameId = (left, right) => String(left || '').toLowerCase() === String(right || '').toLowerCase();
      if (!currentJob || currentJob.status !== 'open' || !sameId(currentJob.attorneyId, attorneyId) || !sameId(currentJob.caseId, job.caseId)) throw applicationMatterChanged();
      if (caseDoc) {
        const identity = require('../utils/caseParticipantIdentity').caseParticipantIdentity(currentCase || {}, attorneyId);
        const relisted = currentCase?.status === 'paused' && currentCase.relistRequestedAt && currentCase.payoutFinalizedAt;
        if (!currentCase || currentCase.archived || currentCase.paralegal || currentCase.paralegalId || !identity.isAttorney || identity.identityConflict || currentCase.status !== 'open' && !relisted) throw applicationMatterChanged();
      }
      await require("../services/matterRequirements").assertRequirements(currentJob, currentCase, user._id, requirementAnswers, session);
      const fingerprint = require('../services/matterDraftRevision').fingerprint;
      if (fingerprint(applicationScope(currentCase, currentJob, scopeSnapshot.capturedAt)) !== fingerprint(scopeSnapshot)) throw applicationMatterChanged();
      const available = await Job.collection.updateOne({ _id: currentJob._id, status: currentJob.status }, { $inc: { __v: 1 } }, { session });
      if (!available.matchedCount) throw applicationMatterChanged();
      const lockedNow = Boolean(currentCase && currentCase.lockedTotalAmount == null);
      if (currentCase) {
        const matterWrite = await Case.collection.updateOne({ _id: currentCase._id }, {
          $inc: { __v: 1 },
          ...(lockedNow ? { $set: { lockedTotalAmount: currentCase.totalAmount, amountLockedAt: new Date() } } : {}),
        }, { session });
        if (matterWrite.matchedCount !== 1) throw applicationMatterChanged();
      }
      let recorded;
      if (existingApplication) {
        const previousStatus = String(existingApplication.status || "submitted");
        existingApplication.coverLetter = note;
        existingApplication.resumeURL = applicant.resumeURL || "";
        existingApplication.linkedInURL = applicant.linkedInURL || "";
        existingApplication.profileSnapshot = shapeParalegalSnapshot(applicant);
        existingApplication.scopeSnapshot = scopeSnapshot;
        existingApplication.requirementConfirmations = requirementConfirmations;
        existingApplication.status = "submitted";
        existingApplication.withdrawnAt = null;
        existingApplication.syncStatus = "pending";
        existingApplication.syncedAt = null;
        existingApplication.syncError = "";
        existingApplication.statusHistory.push({
          from: previousStatus,
          to: "submitted",
          reason: "reapplied",
          actorId: user._id,
          at: new Date(),
        });
        recorded = await existingApplication.save({ session });
      } else {
        const [created] = await Application.create([{
          jobId,
          paralegalId: user._id,
          coverLetter: note,
          resumeURL: applicant.resumeURL || "",
          linkedInURL: applicant.linkedInURL || "",
          profileSnapshot: shapeParalegalSnapshot(applicant),
          scopeSnapshot, requirementConfirmations,
          statusHistory: [{ to: "submitted", reason: "applied", actorId: user._id }],
        }], { session });
        recorded = created;
      }
      if (attorneyId) {
        const payload = {
          jobId: job._id, caseId: caseDoc?._id || job.caseId || null,
          title: caseDoc?.title || job.title || "Matter application",
          caseTitle: caseDoc?.title || job.title || "Matter application",
          paralegalName: `${applicant.firstName || ""} ${applicant.lastName || ""}`.trim() || "Paralegal",
          paralegalId: user._id,
        };
        try {
          if (lockedNow) {
            const dispatch = await notifyUser(attorneyId, "case_budget_locked", {
              caseId: payload.caseId, caseTitle: payload.caseTitle,
              link: `case-detail.html?caseId=${encodeURIComponent(payload.caseId)}`,
            }, { actorUserId: user._id, session, deferDispatch: true });
            if (typeof dispatch !== 'function') throw new Error('Application notification recipient could not be verified.');
            dispatches.push(dispatch);
          }
          const dispatch = await notifyUser(attorneyId, "application_submitted", payload, {
            actorUserId: user._id, session, deferDispatch: true,
            applicationSubmission: { applicationId: recorded._id },
          });
          if (typeof dispatch !== 'function') throw new Error('Application notification recipient could not be verified.');
          dispatches.push(dispatch);
        } catch (cause) {
          throw Object.assign(new Error("Your application could not be saved. Try again."), { status: 503, publicCode: "APPLICATION_SUBMISSION_UNAVAILABLE", cause });
        }
      }
      return recorded;
    });
  } catch (err) {
    if (err?.code === 11000) {
      const duplicate = new Error("You have already applied to this Matter");
      duplicate.status = 400;
      throw duplicate;
    }
    throw err;
  }
  await syncApplicationMirror({ application, caseId: caseDoc?._id || null });
  if (caseDoc?._id) {
    publishCaseProjectionRefresh(caseDoc, "application_submitted_refresh", {
      additionalUserIds: [user._id],
      caseEvent: "case",
    });
  }

  for (const dispatch of dispatches) {
    await dispatch().catch(reportOperationalFailure("routes.applications.notice_dispatch"));
  }

  publishNotificationEvent(user._id, "notifications", {
    at: new Date().toISOString(),
    type: "application_submitted_refresh",
  });

  return application;
}

// GET /applications/recommendation-exclusions — durable application-history
// identities used only by Home Recommended Matters. Retained Case.applicants
// evidence closes compatibility gaps when a canonical Application is missing.
router.get(
  "/recommendation-exclusions",
  ...authenticatedGuards,
  requireRole("paralegal"),
  async (req, res) => {
    try {
      const exclusions = await getHistoricalRecommendationExclusions(req.user._id || req.user.id);
      res.set("Cache-Control", "private, no-store");
      return res.json(exclusions);
    } catch (err) {
      runtimeLogger.error("[applications] recommendation exclusions error", err);
      return res.status(500).json({ error: "Unable to load recommendation history." });
    }
  }
);

// GET /applications/my — paralegal views jobs they've applied to
router.get("/my", ...authenticatedGuards, requireRole("paralegal"), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const result = await accountApplications.readOwn(req);
    return res.json(result.rows);
  } catch (err) {
    if (String(err.publicCode || '').startsWith('APPLICATION_')) return res.status(err.status || 503).json({ error: err.message, code: err.publicCode });
    runtimeLogger.error('[applications] my error', err);
    return res.status(500).json({ error: 'Unable to load applications.' });
  }
});

// Embedded historical applications have no canonical Application ID.
router.post('/earlier/:caseId/revoke', ...mutatingGuards, requireRole('paralegal'), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    return res.json(await require('../services/earlierApplicationWithdrawal').withdraw(req));
  } catch (err) {
    if (err.publicCode) return res.status(err.status || 409).json({ code: err.publicCode, error: err.message });
    runtimeLogger.error('[applications] earlier withdrawal error', err);
    return res.status(500).json({ error: 'Unable to withdraw this application.' });
  }
});

// POST /applications/:applicationId/revoke — paralegal revokes their application
router.post(
  "/:applicationId/revoke",
  ...mutatingGuards,
  requireRole("paralegal"),
  async (req, res) => {
    const withdrawal = require('../services/applicationWithdrawalInterlock');
    let mirrorRemoved = false, withdrawalApplicationId = null;
    try {
      const applicationId = req.params.applicationId;
      if (!mongoose.isValidObjectId(applicationId)) {
        return res.status(400).json({ error: "Invalid application id." });
      }
      const source = await withdrawal.read(req, applicationId);
      if (!source) {
        return res.status(404).json({ error: "Application not found." });
      }
      const { application, job, caseDoc } = source;
      withdrawalApplicationId = application._id;
      if (String(application.status || "").toLowerCase() === "withdrawn") {
        if (application.syncStatus !== 'synced') {
          try {
            await withdrawal.syncCount(application.jobId);
            await withdrawal.markSynced(application);
          } catch (error) {
            await withdrawal.markNeedsReconciliation(application._id, error, application);
            runtimeLogger.error("[applications] withdrawal replay reconciliation deferred", application._id, error);
          }
        }
        return res.json({ success: true, alreadyRevoked: true });
      }
      if (String(application.status || "").toLowerCase() === "rejected") {
        return res.status(409).json({
          error: "This application has already been rejected. Refresh to view its current status.",
          code: "APPLICATION_CONFLICT",
        });
      }
      const funded =
        caseDoc?.paymentReleased === true ||
        String(caseDoc?.escrowStatus || "").toLowerCase() === "funded";
      if (String(application.status || "").toLowerCase() === "accepted" && funded) {
        return res.status(400).json({ error: "Accepted applications cannot be revoked after funding." });
      }

      if (caseDoc) {
        await withdrawal.removeMirror(req, application, job, caseDoc);
        mirrorRemoved = true;
      }
      const recorded = await withdrawal.record(req, source);
      const revokedApplication = recorded.application;
      try {
        await withdrawal.syncCount(revokedApplication.jobId);
        await withdrawal.markSynced(revokedApplication);
      } catch (syncErr) {
        await withdrawal.markNeedsReconciliation(revokedApplication._id, syncErr, revokedApplication);
        runtimeLogger.error("[applications] revoke mirror synchronization deferred", revokedApplication._id, syncErr);
      }
      if (recorded.alreadyRevoked) return res.json({ success: true, alreadyRevoked: true });

      if (caseDoc?._id) {
        publishCaseProjectionRefresh(caseDoc, "application_withdrawn_refresh", {
          additionalUserIds: [req.user._id],
          caseEvent: "case",
        });
      }

      publishNotificationEvent(req.user._id, "notifications", {
        at: new Date().toISOString(),
        type: "application_withdrawn_refresh",
      });

      await recorded.dispatch().catch(error => {
        runtimeLogger.warn("[applications] Withdrawal notification dispatch failed", error?.message);
      });

      return res.json({ success: true });
    } catch (err) {
      if (mirrorRemoved && withdrawalApplicationId) await withdrawal.markNeedsReconciliation(withdrawalApplicationId, err).catch(error => runtimeLogger.error("[applications] withdrawal reconciliation marker failed", error));
      if (err.publicCode) return res.status(err.status || 409).json({ code: err.publicCode, error: err.message });
      runtimeLogger.error("[applications] revoke error", err);
      return res.status(500).json({ error: "Unable to revoke application." });
    }
  }
);

// GET /applications/for-job/:jobId — attorney views applicants
router.get("/for-job/:jobId", ...authenticatedGuards, requireRole("admin", "attorney"), async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Matter posting not found" });

    const isOwner = job.attorneyId && String(job.attorneyId) === String(req.user._id);
    if (req.user.role !== "admin" && !isOwner) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const blockedIds =
      req.user.role === "attorney" ? await getBlockedUserIds(req.user._id || req.user.id) : [];
    const appFilter = { jobId: req.params.jobId, status: { $ne: "withdrawn" } };
    if (blockedIds.length) {
      appFilter.paralegalId = { $nin: blockedIds };
    }
    const apps = await Application.find(appFilter).populate(
      "paralegalId",
      "firstName lastName email role profileImage avatarURL"
    );

    res.json(apps.map((application) => {
      const item = application.toObject();
      const paralegal = presentProfilePerson(item.paralegalId);
      return {
        ...item,
        paralegalId: paralegal,
        profileSnapshot: {
          ...(item.profileSnapshot || {}),
          profileImage: paralegal?.profileImage || "",
        },
      };
    }));
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET /applications/my-postings — attorney sees applications to their jobs
router.get("/my-postings", ...authenticatedGuards, requireRole("attorney"), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const result = await accountApplications.readReceived(req);
    return res.json(result.rows);
  } catch (err) {
    if (String(err.publicCode || '').startsWith('APPLICATION_')) return res.status(err.status || 503).json({ error: err.message, code: err.publicCode });
    runtimeLogger.error('[applications] my-postings error', err);
    return res.status(500).json({ error: 'Unable to load applications.' });
  }
});

router.createApplicationForJob = createApplicationForJob;

module.exports = router;
