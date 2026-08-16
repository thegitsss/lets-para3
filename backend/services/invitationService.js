const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("services:invitationService");
const Case = require("../models/Case");
const Application = require("../models/Application");
const Job = require("../models/Job");
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

async function markInvitationSync(caseId, paralegalId, syncStatus, err = null) {
  const now = new Date();
  await Case.updateOne(
    { _id: caseId, "invites.paralegalId": paralegalId },
    {
      $set: {
        "invites.$.syncStatus": syncStatus,
        "invites.$.syncedAt": syncStatus === "synced" ? now : null,
        "invites.$.syncError": syncStatus === "needs_reconciliation" ? syncErrorMessage(err) : "",
      },
    }
  );
}

async function syncCanonicalInvitationApplication({
  caseId,
  paralegalId,
  status,
  paralegalProfile = {},
  respondedAt,
}) {
  const job = await Job.findOne({ caseId }).select("_id").lean();
  if (!job) {
    if (status === "submitted") {
      await syncEmbeddedApplication({
        caseId,
        paralegalId,
        coverLetter: "Accepted invitation",
        resumeURL: paralegalProfile.resumeURL || "",
        linkedInURL: paralegalProfile.linkedInURL || "",
        profileSnapshot: paralegalProfile.profileSnapshot || {},
        status,
        appliedAt: respondedAt,
      });
    } else if (status === "rejected") {
      await Case.updateOne(
        { _id: caseId, "applicants.paralegalId": paralegalId },
        { $set: { "applicants.$.status": "rejected" } }
      );
    } else if (status === "withdrawn") {
      await Case.updateOne({ _id: caseId }, { $pull: { applicants: { paralegalId } } });
    }
    await markInvitationSync(caseId, paralegalId, "synced");
    return { synced: true, applicationId: null };
  }

  let application = await Application.findOne({ jobId: job._id, paralegalId });
  let createdApplication = false;
  if (!application && status === "submitted") {
    try {
      application = await Application.create({
        jobId: job._id,
        paralegalId,
        coverLetter: "Accepted invitation",
        resumeURL: paralegalProfile.resumeURL || "",
        linkedInURL: paralegalProfile.linkedInURL || "",
        profileSnapshot: paralegalProfile.profileSnapshot || {},
        status,
        syncStatus: "pending",
        statusHistory: [{ to: status, reason: "invitation_accepted", at: respondedAt }],
      });
      createdApplication = true;
    } catch (err) {
      if (Number(err?.code) !== 11000) throw err;
      application = await Application.findOne({ jobId: job._id, paralegalId });
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
    await application.save();
  }

  if (application) {
    const mirror = await syncApplicationMirror({ application, caseId });
    if (!mirror?.synced) throw new Error(mirror?.error || "Application mirror synchronization failed");
  } else {
    if (status === "rejected") {
      await Case.updateOne(
        { _id: caseId, "applicants.paralegalId": paralegalId },
        { $set: { "applicants.$.status": "rejected" } }
      );
    } else if (status === "withdrawn") {
      await Case.updateOne({ _id: caseId }, { $pull: { applicants: { paralegalId } } });
    }
    await syncApplicantsCount(job._id);
  }
  await markInvitationSync(caseId, paralegalId, "synced");
  return { synced: true, applicationId: application?._id || null };
}

async function reconcileInvitationApplication(input) {
  try {
    return await syncCanonicalInvitationApplication(input);
  } catch (err) {
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
    .select("invites pendingParalegalId pendingParalegalInvitedAt")
    .lean();
  if (!caseDoc) return null;
  const pending = (Array.isArray(caseDoc.invites) ? caseDoc.invites : [])
    .filter((invite) => String(invite?.status || "").toLowerCase() === "pending")
    .sort((left, right) => {
      const leftTime = left?.invitedAt ? new Date(left.invitedAt).getTime() : 0;
      const rightTime = right?.invitedAt ? new Date(right.invitedAt).getTime() : 0;
      return leftTime - rightTime;
    })[0];
  await Case.updateOne(
    { _id: caseId },
    {
      $set: {
        pendingParalegalId: pending?.paralegalId || null,
        pendingParalegalInvitedAt: pending?.invitedAt || null,
      },
    }
  );
  return pending || null;
}

async function sendInvitation({ caseDoc, paralegalId, invitedAt = new Date() }) {
  const caseId = caseDoc?._id;
  if (!caseId || !paralegalId) return { sent: false, reason: "invalid_target" };
  const commonFilter = {
    _id: caseId,
    archived: { $ne: true },
    paymentReleased: { $ne: true },
    ...unassignedCaseFilter(),
  };
  const set = {
    pendingParalegalId: paralegalId,
    pendingParalegalInvitedAt: invitedAt,
  };
  if (caseDoc.lockedTotalAmount == null) {
    set.lockedTotalAmount = caseDoc.totalAmount;
    set.amountLockedAt = invitedAt;
  }

  let result = await Case.updateOne(
    {
      ...commonFilter,
      invites: {
        $elemMatch: {
          paralegalId,
          status: { $in: ["declined", "expired"] },
        },
      },
    },
    {
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
    }
  );

  if (!result.matchedCount) {
    result = await Case.updateOne(
      {
        ...commonFilter,
        invites: { $not: { $elemMatch: { paralegalId } } },
      },
      {
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
      }
    );
  }

  if (result.modifiedCount) return { sent: true, lockedNow: caseDoc.lockedTotalAmount == null };

  const latest = await Case.findById(caseId).select("paralegal paralegalId invites archived paymentReleased").lean();
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
}

async function respondToInvitation({
  caseId,
  paralegalId,
  decision,
  paralegalProfile,
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
  const result = await Case.updateOne(
    filter,
    {
      $set: set,
    },
    { arrayFilters: [{ "invite.paralegalId": paralegalId, "invite.status": "pending" }] }
  );
  if (!result.modifiedCount) {
    const latest = await Case.findById(caseId).select("paralegal paralegalId invites").lean();
    const existing = (latest?.invites || []).find(
      (invite) => String(invite?.paralegalId || "") === String(paralegalId)
    );
    const existingStatus = String(existing?.status || "").toLowerCase();
    if (existingStatus === status) {
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
  return { updated: true, idempotent: false, status, reconciliationPending: !sync.synced };
}

async function revokeAcceptedInvitation({ caseId, paralegalId, respondedAt = new Date() }) {
  const result = await Case.updateOne(
    {
      _id: caseId,
      ...unassignedCaseFilter(),
      invites: { $elemMatch: { paralegalId, status: "accepted" } },
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
    },
    { arrayFilters: [{ "invite.paralegalId": paralegalId, "invite.status": "accepted" }] }
  );
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
  return { revoked: true, idempotent: false, reconciliationPending: !sync.synced };
}

module.exports = {
  ACTIVE_INVITE_STATUSES,
  respondToInvitation,
  revokeAcceptedInvitation,
  sendInvitation,
  syncLegacyPendingInviteFields,
};
