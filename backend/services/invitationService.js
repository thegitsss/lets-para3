const { reportOperationalFailure } = require("../utils/operationalFailure");
const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("services:invitationService");
const Case = require("../models/Case");
const Application = require("../models/Application");
const Job = require("../models/Job");
const User = require("../models/User");
require("../models/MatterInvitationNotification");
const { withActiveAccountWrite, lockActiveAccounts } = require("../utils/activeAccountWrite");
const { withResumeReferenceWrite } = require("../utils/resumeReferenceWrite");
const {
  markApplicationNeedsReconciliation,
  syncApplicationMirror,
  syncApplicantsCount,
  syncEmbeddedApplication,
} = require("./applicationService");

const ACTIVE_INVITE_STATUSES = Object.freeze(["pending", "accepted"]);

function syncErrorMessage(err) {
  return String(err?.message || err || "Invitation synchronization failed").slice(0, 1000);
}

async function markInvitationSync(caseId, paralegalId, syncStatus, err = null, { session = null } = {}) {
  const now = new Date();
  await Case.updateOne(
    { _id: caseId, "invites.paralegalId": paralegalId },
    {
      $set: {
        "invites.$.syncStatus": syncStatus,
        "invites.$.syncedAt": syncStatus === "synced" ? now : null,
        "invites.$.syncError": syncStatus === "needs_reconciliation" ? syncErrorMessage(err) : "",
      },
    },
    ...(session ? [{ session }] : [])
  );
}

async function syncCanonicalInvitationApplication({
  caseId,
  paralegalId,
  status,
  paralegalProfile = {},
  respondedAt,
  session,
}) {
  const matter = await Case.findById(caseId).select("invites applicants status archived").session(session).lean();
  const confirmations=matter?.applicants?.find(item=>String(item.paralegalId)===String(paralegalId))?.requirementConfirmations||[];
  const currentInvite = matter?.invites?.find(invite => String(invite.paralegalId) === String(paralegalId));
  if (status === "submitted" && (currentInvite?.status !== "accepted" || matter?.archived || matter?.status === "closed")) return { synced: true, obsolete: true, applicationId: null };
  if (status === "submitted") {
    const owner = await User.findById(paralegalId).select("disabled deleted").session(session).lean();
    if (!owner || owner.disabled || owner.deleted) return { synced: true, obsolete: true, applicationId: null };
  }
  // This copies an already committed Case snapshot. Its Case write arbitrates
  // closure without locking the User résumé again during deferred mirroring.
  if (matter) await Case.collection.updateOne({ _id: matter._id }, { $inc: { __v: 1 } }, { session });
  const job = await Job.findOne({ caseId }).select("_id").session(session).lean();
  if (!job) {
    if (status === "submitted") {
      await syncEmbeddedApplication({
        caseId,
        paralegalId,
        coverLetter: "Accepted invitation",
        resumeURL: paralegalProfile.resumeURL || "",
        linkedInURL: paralegalProfile.linkedInURL || "",
        profileSnapshot: paralegalProfile.profileSnapshot || {},
        requirementConfirmations: confirmations,
        status,
        appliedAt: respondedAt,
        session,
      });
    } else if (status === "rejected") {
      await Case.updateOne(
        { _id: caseId, "applicants.paralegalId": paralegalId },
        { $set: { "applicants.$.status": "rejected" } },
        { session }
      );
    } else if (status === "withdrawn") {
      await Case.updateOne({ _id: caseId }, { $pull: { applicants: { paralegalId } } }, { session });
    }
    await markInvitationSync(caseId, paralegalId, "synced", null, { session });
    return { synced: true, applicationId: null };
  }

  let application = await Application.findOne({ jobId: job._id, paralegalId }).session(session);
  let createdApplication = false;
  if (!application && status === "submitted") {
    try {
      [application] = await Application.create([{
        jobId: job._id,
        paralegalId,
        coverLetter: "Accepted invitation",
        resumeURL: paralegalProfile.resumeURL || "",
        linkedInURL: paralegalProfile.linkedInURL || "",
        profileSnapshot: paralegalProfile.profileSnapshot || {},
        requirementConfirmations: confirmations,
        status,
        syncStatus: "pending",
        statusHistory: [{ to: status, reason: "invitation_accepted", at: respondedAt }],
      }], { session });
      createdApplication = true;
    } catch (err) {
      if (Number(err?.code) !== 11000) throw err;
      application = await Application.findOne({ jobId: job._id, paralegalId }).session(session);
      if (!application) throw err;
    }
  }
  if (application && !createdApplication) {
    const from = String(application.status || "");
    application.status = status;
    application.withdrawnAt = status === "withdrawn" ? respondedAt : null;
    application.syncStatus = "pending";
    application.syncedAt = null;
    application.syncError = "";
    if (status === "submitted") {
      application.resumeURL = paralegalProfile.resumeURL || application.resumeURL || "";
      application.linkedInURL = paralegalProfile.linkedInURL || application.linkedInURL || "";
      application.profileSnapshot = paralegalProfile.profileSnapshot || application.profileSnapshot || {};
      application.requirementConfirmations=confirmations;
    }
    if (from !== status) {
      application.statusHistory.push({
        from,
        to: status,
        reason:
          status === "submitted"
            ? "invitation_accepted"
            : status === "withdrawn"
              ? "accepted_invitation_revoked"
              : "invitation_declined",
        at: respondedAt,
      });
    }
    await application.save({ session });
  }

  if (application) {
    const mirror = await syncApplicationMirror({ application, caseId, session });
    if (!mirror?.synced) throw new Error(mirror?.error || "Application mirror synchronization failed");
  } else {
    if (status === "rejected") {
      await Case.updateOne(
        { _id: caseId, "applicants.paralegalId": paralegalId },
        { $set: { "applicants.$.status": "rejected" } },
        { session }
      );
    } else if (status === "withdrawn") {
      await Case.updateOne({ _id: caseId }, { $pull: { applicants: { paralegalId } } }, { session });
    }
    await syncApplicantsCount(job._id, { session });
  }
  await markInvitationSync(caseId, paralegalId, "synced", null, { session });
  return { synced: true, applicationId: application?._id || null };
}

async function reconcileInvitationApplication(input) {
  const session = await Case.db.startSession();
  try {
    session.startTransaction();
    const result = await syncCanonicalInvitationApplication({ ...input, session });
    await session.commitTransaction();
    return result;
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.invitationService.transaction_abort"));
    await markInvitationSync(input.caseId, input.paralegalId, "needs_reconciliation", err).catch(
      logPromiseFailure(runtimeLogger, "[invitations] invitation reconciliation marker failed", {
        caseId: input.caseId,
      })
    );
    const job = await Job.findOne({ caseId: input.caseId }).select("_id").lean().catch((lookupError) => {
      runtimeLogger.error("[invitations] reconciliation Job lookup failed", {
        caseId: input.caseId,
        error: lookupError,
      });
      return null;
    });
    if (job) {
      const application = await Application.findOne({ jobId: job._id, paralegalId: input.paralegalId })
        .select("_id")
        .lean()
        .catch((lookupError) => {
          runtimeLogger.error("[invitations] reconciliation application lookup failed", {
            caseId: input.caseId,
            error: lookupError,
          });
          return null;
        });
      await markApplicationNeedsReconciliation(application?._id, err).catch(
        logPromiseFailure(runtimeLogger, "[invitations] application reconciliation marker failed", {
          caseId: input.caseId,
        })
      );
    }
    runtimeLogger.error("[invitations] canonical application synchronization deferred", input.caseId, err?.message || err);
    return { synced: false, error: syncErrorMessage(err) };
  }
  finally { await session.endSession(); }
}

function unassignedCaseFilter() {
  return {
    $and: [
      { $or: [{ paralegal: null }, { paralegal: { $exists: false } }] },
      { $or: [{ paralegalId: null }, { paralegalId: { $exists: false } }] },
    ],
  };
}

async function syncLegacyPendingInviteFields(caseId) {
  const caseDoc = await Case.findById(caseId)
    .select("invites pendingParalegalId pendingParalegalInvitedAt __v")
    .lean();
  if (!caseDoc) return null;
  const pending = (Array.isArray(caseDoc.invites) ? caseDoc.invites : [])
    .filter((invite) => String(invite?.status || "").toLowerCase() === "pending")
    .sort((left, right) => {
      const leftTime = left?.invitedAt ? new Date(left.invitedAt).getTime() : 0;
      const rightTime = right?.invitedAt ? new Date(right.invitedAt).getTime() : 0;
      return leftTime - rightTime;
    })[0];
  const version = caseDoc.__v ?? 0;
  const versionFilter = version === 0 ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] } : { __v: version };
  const result = await Case.updateOne(
    { _id: caseId, ...versionFilter },
    {
      $set: {
        pendingParalegalId: pending?.paralegalId || null,
        pendingParalegalInvitedAt: pending?.invitedAt || null,
      },
      $inc: { __v: 1 },
    }
  );
  if (!result.matchedCount) throw new Error("Invitations changed before the pending-invitation mirror could be synchronized");
  return pending || null;
}

async function sendInvitation({ caseDoc, paralegalId, invitedAt = new Date(), reviewed, ownerAliases, actorId, authVersion }) {
  const caseId = caseDoc?._id || reviewed?.facts?._id;
  if (!caseId || !paralegalId) return { sent: false, reason: "invalid_target" };
  const source = reviewed?.facts || caseDoc;
  // A compatibility route may have normalized its in-memory document already.
  // Check the recorded aliases before allowing that normalization to persist.
  const recordedOwner = ownerAliases || source;
  const primaryOwner = String(recordedOwner.attorney?._id || recordedOwner.attorney || "").toLowerCase();
  const aliasOwner = String(recordedOwner.attorneyId?._id || recordedOwner.attorneyId || "").toLowerCase();
  if (primaryOwner && aliasOwner && primaryOwner !== aliasOwner) return { sent: false, reason: "ownership_conflict" };
  const ownerId = actorId || reviewed?.dto?.ownerId || source.attorney?._id || source.attorney || source.attorneyId;
  return withActiveAccountWrite([ownerId, source.attorney?._id || source.attorney, source.attorneyId?._id || source.attorneyId, paralegalId], async session => {
  const retain = result => require("./matterInvitationNotifications").retainSent(result, { caseId, paralegalId, actorUserId: actorId || ownerId, invitedAt }, session);
  if(await require("../models/MatterRequirementDecision").exists({matterKey:String(caseId),paralegalId}).session(session))return {sent:false,reason:"profile_unavailable"};
  if (reviewed) return retain(await require("./matterInvitationActions").commit(reviewed, paralegalId, invitedAt, { session }));
  const policy = require("./attorneyWorkflowPolicy").evaluateInvitationEligibility({ caseDoc, ownerAuthorized: true, targetSelected: true, paralegalApproved: true, payoutSetupReady: true });
  if (!policy.ready || caseDoc.readOnly || caseDoc.hiringClaimToken || caseDoc.hiringClaimStatus) return { sent: false, reason: "matter_closed" };
  const version = caseDoc.get ? caseDoc.get("__v") : caseDoc.__v;
  if (version != null && (!Number.isSafeInteger(version) || version < 0)) return { sent: false, reason: "conflict" };
  const assignmentFilter = unassignedCaseFilter();
  const commonFilter = {
    _id: caseId,
    archived: { $ne: true },
    paymentReleased: { $ne: true },
    status: caseDoc.status,
    totalAmount: caseDoc.totalAmount,
    lockedTotalAmount: caseDoc.lockedTotalAmount ?? null,
    pausedReason: caseDoc.pausedReason ?? null,
    payoutFinalizedAt: caseDoc.payoutFinalizedAt ?? null,
    remainingAmount: caseDoc.remainingAmount ?? null,
    attorney: ownerAliases ? ownerAliases.attorney : caseDoc.attorney?._id || caseDoc.attorney,
    attorneyId: ownerAliases ? ownerAliases.attorneyId : caseDoc.attorneyId?._id || caseDoc.attorneyId,
    $and: [...assignmentFilter.$and,
      ...(version > 0 ? [{ __v: version }] : [{ $or: [{ __v: 0 }, { __v: { $exists: false } }] }]),
      { $or: [{ hiringClaimToken: null }, { hiringClaimToken: "" }] },
      { $or: [{ hiringClaimStatus: null }, { hiringClaimStatus: "" }] },
    ],
  };
  const set = {
    pendingParalegalId: paralegalId,
    pendingParalegalInvitedAt: invitedAt,
    updatedAt: new Date(),
    ...(ownerAliases ? { attorney: caseDoc.attorney?._id || caseDoc.attorney, attorneyId: caseDoc.attorneyId?._id || caseDoc.attorneyId } : {}),
  };
  if (caseDoc.lockedTotalAmount == null) {
    set.lockedTotalAmount = caseDoc.totalAmount;
    set.amountLockedAt = invitedAt;
  }

  let result = await Case.collection.updateOne(
    {
      ...commonFilter,
      invites: {
        $elemMatch: {
          paralegalId,
          status: { $in: ["declined", "expired"] },
          syncStatus: { $nin: ["pending", "needs_reconciliation"] },
        },
      },
    },
    {
      $inc: { __v: 1 },
      $set: {
        ...set,
        "invites.$[invite].status": "pending",
        "invites.$[invite].invitedAt": invitedAt,
        "invites.$[invite].respondedAt": null,
        "invites.$[invite].syncStatus": "synced",
        "invites.$[invite].syncedAt": invitedAt,
        "invites.$[invite].syncError": "",
      },
    },
    {
      arrayFilters: [
        { "invite.paralegalId": paralegalId, "invite.status": { $in: ["declined", "expired"] } },
      ],
      session,
    }
  );

  if (!result.matchedCount) {
    result = await Case.collection.updateOne(
      {
        ...commonFilter,
        invites: { $not: { $elemMatch: { paralegalId } } },
      },
      {
        $inc: { __v: 1 },
        $set: set,
        $push: {
          invites: {
            paralegalId,
            status: "pending",
            invitedAt,
            respondedAt: null,
            syncStatus: "synced",
            syncedAt: invitedAt,
            syncError: "",
          },
        },
      },
      { session }
    );
  }

  if (result.modifiedCount) return retain({ sent: true, lockedNow: caseDoc.lockedTotalAmount == null });

  const latest = await Case.findById(caseId).select("paralegal paralegalId invites archived paymentReleased").session(session).lean();
  const existing = (latest?.invites || []).find(
    (invite) => String(invite?.paralegalId || "") === String(paralegalId)
  );
  return {
    sent: false,
    reason:
      latest?.paralegal || latest?.paralegalId
        ? "already_assigned"
        : latest?.archived || latest?.paymentReleased
          ? "matter_closed"
          : ACTIVE_INVITE_STATUSES.includes(String(existing?.status || "").toLowerCase())
            ? `already_${String(existing.status).toLowerCase()}`
            : "conflict",
  };
  }, { ownerId, authVersion });
}

async function respondToInvitation({
  caseId,
  legacyInvitation = null,
  actorId,
  authVersion,
  paralegalId,
  decision,
  paralegalProfile,
  resumeReference,
  requirementAnswers,
  lockedTotalAmount,
  amountLockedAt,
  respondedAt = new Date(),
}) {
  const status = decision === "accept" ? "accepted" : "declined";
  const filter = {
    _id: caseId,
    archived: { $ne: true },
    paymentReleased: { $ne: true },
    invites: { $elemMatch: { paralegalId, status: "pending" } },
    ...(status === "accepted" ? unassignedCaseFilter() : {}),
  };
  if (status === "accepted") filter.$and.push(
    { $or: [{ hiringClaimToken: null }, { hiringClaimToken: "" }] },
    { $or: [{ hiringClaimStatus: null }, { hiringClaimStatus: "" }] }
  );
  const set = {
    "invites.$[invite].status": status,
    "invites.$[invite].respondedAt": respondedAt,
    "invites.$[invite].syncStatus": "pending",
    "invites.$[invite].syncedAt": null,
    "invites.$[invite].syncError": "",
  };
  if (status === "accepted" && Number.isFinite(Number(lockedTotalAmount))) {
    set.lockedTotalAmount = Math.max(0, Math.round(Number(lockedTotalAmount)));
    set.amountLockedAt = amountLockedAt || respondedAt;
  }
  const updateInvitation = (session = null) => legacyInvitation
    ? require("./legacyInvitationResponse").commit(legacyInvitation, { paralegalId, status, respondedAt, lockedTotalAmount, amountLockedAt, session })
    : Case.updateOne(
    filter,
    {
      $set: set,
      $inc: { __v: 1 },
    },
    { arrayFilters: [{ "invite.paralegalId": paralegalId, "invite.status": "pending" }], ...(session ? { session } : {}) }
  );
  let result;
  let dispatch;
  const retainResponse = session => require("./matterInvitationNotifications").retainResponse({
    caseId, paralegalId, actorUserId: actorId || paralegalId, kind: status,
  }, session);
  if (status === "accepted") {
    const retainedProfile = (matter) => {
      const applicant = (matter?.applicants || []).find(item => String(item?.paralegalId || "") === String(paralegalId));
      return applicant ? { resumeURL: applicant.resumeURL || "", linkedInURL: applicant.linkedInURL || "", profileSnapshot: applicant.profileSnapshot || {} } : null;
    };
    const latest = await Case.findById(caseId).select("invites applicants").lean();
    const existing = (latest?.invites || []).find(invite => String(invite?.paralegalId || "") === String(paralegalId));
    // A completed retry needs no fresh profile snapshot or User mutation.
    if (existing?.status === status && existing.syncStatus === "synced") {
      return { updated: false, idempotent: true, status, reconciliationPending: false };
    }
    const existingProfile = existing?.status === status ? retainedProfile(latest) : null;
    if (existingProfile) {
      // Repair from the accepted snapshot, not a later edit of the User profile.
      paralegalProfile = existingProfile;
      result = { modifiedCount: 0 };
    } else result = await withResumeReferenceWrite(resumeReference, async (session) => {
      if (legacyInvitation) await lockActiveAccounts([actorId || paralegalId, paralegalId], session, { ownerId: actorId || paralegalId, authVersion });
      const requirementMatter=await Case.findById(caseId).session(session);
      const requirementJob=await Job.findOne({caseId}).session(session);
      const confirmations=await require('./matterRequirements').assertRequirements(requirementJob||{caseId,_id:caseId},requirementMatter,paralegalId,requirementAnswers,session);
      const changed = await updateInvitation(session);
      let retainSnapshot = Boolean(changed.modifiedCount);
      if (!retainSnapshot) {
        const current = await Case.findById(caseId).select("invites applicants hiringClaimToken hiringClaimStatus").session(session).lean();
        const invite = (current?.invites || []).find(item => String(item?.paralegalId || "") === String(paralegalId));
        retainSnapshot = invite?.status === status && invite.syncStatus !== "synced" && !current.hiringClaimToken && !current.hiringClaimStatus;
        const retained = retainSnapshot ? retainedProfile(current) : null;
        if (retained) { paralegalProfile = retained; retainSnapshot = false; }
      }
      if (retainSnapshot) {
        // Acceptance and its first retained résumé reference commit together.
        // Later canonical reconciliation copies this retained evidence, so
        // replacement cleanup cannot delete its source between the two writes.
        const retained = await syncEmbeddedApplication({
          caseId, paralegalId, coverLetter: "Accepted invitation",
          resumeURL: paralegalProfile?.resumeURL || "",
          linkedInURL: paralegalProfile?.linkedInURL || "",
          profileSnapshot: paralegalProfile?.profileSnapshot || {},
          requirementConfirmations: confirmations,
          status: "submitted", appliedAt: respondedAt, session,
        });
        if (!retained?.matchedCount) throw new Error("Unable to retain the invitation application snapshot");
      }
      if (changed.modifiedCount) dispatch = await retainResponse(session);
      return changed;
    });
  } else {
    result = await withActiveAccountWrite(legacyInvitation ? [actorId || paralegalId, paralegalId] : [], async session => {
      const changed = await updateInvitation(session);
      if (changed.modifiedCount) dispatch = await retainResponse(session);
      return changed;
    }, { ownerId: actorId || paralegalId, authVersion });
  }
  if (!result.modifiedCount) {
    const latest = await Case.findById(caseId).select("paralegal paralegalId invites hiringClaimToken hiringClaimStatus").lean();
    const existing = (latest?.invites || []).find(
      (invite) => String(invite?.paralegalId || "") === String(paralegalId)
    );
    const existingStatus = String(existing?.status || "").toLowerCase();
    if (existingStatus === status) {
      if (existing.syncStatus === "synced") return { updated: false, idempotent: true, status, reconciliationPending: false };
      if (latest.hiringClaimToken || latest.hiringClaimStatus) return { updated: false, reason: "hiring", status: existingStatus };
      const sync = await reconcileInvitationApplication({
        caseId,
        paralegalId,
        status: status === "accepted" ? "submitted" : "rejected",
        paralegalProfile,
        respondedAt: existing?.respondedAt || respondedAt,
      });
      await syncLegacyPendingInviteFields(caseId).catch(
        logPromiseFailure(runtimeLogger, "[invitations] legacy invite mirror synchronization failed", { caseId })
      );
      return { updated: false, idempotent: true, status, reconciliationPending: !sync.synced };
    }
    return {
      updated: false,
      reason: latest?.paralegal || latest?.paralegalId ? "already_assigned" : "not_pending",
      status: existingStatus,
    };
  }

  const sync = await reconcileInvitationApplication({
    caseId,
    paralegalId,
    status: status === "accepted" ? "submitted" : "rejected",
    paralegalProfile,
    respondedAt,
  });
  await syncLegacyPendingInviteFields(caseId).catch((err) => {
    runtimeLogger.error("[invitations] legacy pending mirror deferred", caseId, err?.message || err);
  });
  return { updated: true, idempotent: false, status, reconciliationPending: !sync.synced, dispatch };
}

async function revokeAcceptedInvitation({ caseId, paralegalId, actorId = paralegalId, authVersion, respondedAt = new Date() }) {
  const eligibility = unassignedCaseFilter();
  eligibility.$and.push(
    { $or: [{ hiringClaimToken: null }, { hiringClaimToken: "" }] },
    { $or: [{ hiringClaimStatus: null }, { hiringClaimStatus: "" }] }
  );
  let dispatch;
  const result = await withActiveAccountWrite([actorId, paralegalId], async session => {
  const changed = await Case.updateOne(
    {
      _id: caseId,
      ...eligibility,
      paymentReleased: { $ne: true },
      escrowStatus: { $ne: "funded" },
      invites: { $elemMatch: { paralegalId, status: "accepted", syncStatus: { $nin: ["pending", "needs_reconciliation"] } } },
    },
    {
      $set: {
        "invites.$[invite].status": "declined",
        "invites.$[invite].respondedAt": respondedAt,
        "invites.$[invite].syncStatus": "pending",
        "invites.$[invite].syncedAt": null,
        "invites.$[invite].syncError": "",
      },
      $pull: { applicants: { paralegalId } },
      $addToSet: { withdrawnApplicantIds: paralegalId },
      $inc: { __v: 1 },
    },
    { arrayFilters: [{ "invite.paralegalId": paralegalId, "invite.status": "accepted" }], session }
  );
  if (changed.modifiedCount) dispatch = await require("./matterInvitationNotifications").retainResponse({
    caseId, paralegalId, actorUserId: actorId, kind: "revoked",
  }, session);
  return changed;
  }, { ownerId: actorId, authVersion });
  if (!result.modifiedCount) {
    const latest = await Case.findById(caseId).select("paralegal paralegalId invites applicants").lean();
    const existing = (latest?.invites || []).find(
      (invite) => String(invite?.paralegalId || "") === String(paralegalId)
    );
    const stillApplicant = (latest?.applicants || []).some(
      (applicant) => String(applicant?.paralegalId || "") === String(paralegalId)
    );
    if (String(existing?.status || "").toLowerCase() === "declined" && !stillApplicant) {
      const sync = await reconcileInvitationApplication({
        caseId,
        paralegalId,
        status: "withdrawn",
        respondedAt: existing?.respondedAt || respondedAt,
      });
      return {
        revoked: false,
        idempotent: true,
        reconciliationPending: !sync.synced,
      };
    }
    return {
      revoked: false,
      reason: latest?.paralegal || latest?.paralegalId ? "already_assigned" : "not_accepted",
    };
  }
  const sync = await reconcileInvitationApplication({
    caseId,
    paralegalId,
    status: "withdrawn",
    respondedAt,
  });
  await syncLegacyPendingInviteFields(caseId).catch(
    logPromiseFailure(runtimeLogger, "[invitations] legacy invite mirror synchronization failed", { caseId })
  );
  return { revoked: true, idempotent: false, reconciliationPending: !sync.synced, dispatch };
}

module.exports = {
  ACTIVE_INVITE_STATUSES,
  respondToInvitation,
  revokeAcceptedInvitation,
  sendInvitation,
  syncLegacyPendingInviteFields,
};
