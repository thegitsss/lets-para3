const mongoose = require("mongoose");

const Application = require("../../models/Application");
const Case = require("../../models/Case");
const CaseFile = require("../../models/CaseFile");
const Job = require("../../models/Job");
const Message = require("../../models/Message");
const Payout = require("../../models/Payout");
const User = require("../../models/User");

const SYNTHETIC_DOMAIN = "package6.invalid";
const SYNTHETIC_TITLE_PREFIX = "P6 Synthetic";

function objectId() {
  return new mongoose.Types.ObjectId();
}

function syntheticUser({ _id = objectId(), role, label, stripeCustomerId = null, payoutReady = false }) {
  return {
    _id,
    firstName: "P6",
    lastName: label,
    email: `${String(label).toLowerCase().replace(/[^a-z0-9]+/g, ".")}@${SYNTHETIC_DOMAIN}`,
    password: "synthetic-hash-not-used",
    role,
    status: "approved",
    approvedAt: new Date("2026-01-01T12:00:00.000Z"),
    emailVerified: true,
    stripeCustomerId,
    stripeAccountId: payoutReady ? `acct_p6_${String(_id).slice(-8)}` : null,
    stripeOnboarded: payoutReady,
    stripePayoutsEnabled: payoutReady,
    stripeChargesEnabled: payoutReady,
    lawFirm: role === "attorney" ? "Package 6 Synthetic Law" : "",
    state: "New York",
    timezone: "America/New_York",
    practiceAreas: role === "attorney" ? ["Civil Litigation"] : [],
    primaryPracticeArea: role === "attorney" ? "Civil Litigation" : "",
    bio: "Synthetic Package 6 integration fixture. This is not a customer record.",
    preferences: { theme: "mountain", fontSize: "md", hideProfile: false },
    notificationPrefs: { email: true, inApp: true, browser: false },
    onboarding: { attorneyProfileCompleted: role === "attorney" },
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-01T12:00:00.000Z"),
  };
}

function syntheticCase({
  _id = objectId(),
  attorneyId,
  title,
  status,
  paralegalId = null,
  now,
  ...overrides
}) {
  return {
    _id,
    attorney: attorneyId,
    attorneyId,
    paralegal: paralegalId,
    paralegalId,
    title: `${SYNTHETIC_TITLE_PREFIX} ${title}`,
    practiceArea: "Civil Litigation",
    details: "Synthetic matter used only for isolated Package 6 assistant verification.",
    state: "New York",
    locationState: "New York",
    status,
    currency: "usd",
    totalAmount: 0,
    feeAttorneyPct: 22,
    feeAttorneyAmount: 0,
    feeParalegalPct: 18,
    feeParalegalAmount: 0,
    applicants: [],
    invites: [],
    tasks: [],
    files: [],
    disputes: [],
    archived: false,
    readOnly: false,
    terminationStatus: "none",
    moderationStatus: "none",
    createdAt: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
    updatedAt: now,
    ...overrides,
  };
}

function assertSyntheticFixtureData(fixture) {
  const users = Object.values(fixture.users || {});
  const cases = Object.values(fixture.cases || {});
  if (!users.length || users.some((user) => !String(user.email || "").endsWith(`@${SYNTHETIC_DOMAIN}`))) {
    throw new Error("Package 6 fixture contains a non-synthetic user identity.");
  }
  if (!cases.length || cases.some((caseDoc) => !String(caseDoc.title || "").startsWith(SYNTHETIC_TITLE_PREFIX))) {
    throw new Error("Package 6 fixture contains a non-synthetic matter title.");
  }
  return true;
}

async function seedAttorneySupportFixtures() {
  const now = new Date("2026-07-22T16:00:00.000Z");
  const ids = {
    owner: objectId(),
    emptyAttorney: objectId(),
    oneAttorney: objectId(),
    otherAttorney: objectId(),
    assignedParalegal: objectId(),
    applicantParalegal: objectId(),
    invitedParalegal: objectId(),
  };
  const users = {
    owner: syntheticUser({ _id: ids.owner, role: "attorney", label: "Owner", stripeCustomerId: "cus_p6_saved" }),
    emptyAttorney: syntheticUser({ _id: ids.emptyAttorney, role: "attorney", label: "Empty", stripeCustomerId: null }),
    oneAttorney: syntheticUser({ _id: ids.oneAttorney, role: "attorney", label: "One", stripeCustomerId: "cus_p6_none" }),
    otherAttorney: syntheticUser({ _id: ids.otherAttorney, role: "attorney", label: "Other", stripeCustomerId: "cus_p6_other" }),
    assignedParalegal: syntheticUser({
      _id: ids.assignedParalegal,
      role: "paralegal",
      label: "Assigned",
      payoutReady: true,
    }),
    applicantParalegal: syntheticUser({ _id: ids.applicantParalegal, role: "paralegal", label: "Applicant" }),
    invitedParalegal: syntheticUser({
      _id: ids.invitedParalegal,
      role: "paralegal",
      label: "Invited",
      payoutReady: true,
    }),
  };

  const caseIds = {
    open: objectId(),
    active: objectId(),
    paused: objectId(),
    completed: objectId(),
    disputed: objectId(),
    archived: objectId(),
    purged: objectId(),
    one: objectId(),
    inaccessible: objectId(),
  };
  const jobId = objectId();
  const cases = {
    open: syntheticCase({
      _id: caseIds.open,
      attorneyId: ids.owner,
      title: "Open Intake Matter",
      status: "open",
      now: new Date(now.getTime() - 6 * 60 * 60 * 1000),
      jobId,
      pendingParalegalId: ids.invitedParalegal,
      pendingParalegalInvitedAt: new Date("2026-07-20T14:00:00.000Z"),
      applicants: [{ paralegalId: ids.applicantParalegal, status: "pending", appliedAt: new Date("2026-07-21T14:00:00.000Z") }],
      invites: [{ paralegalId: ids.invitedParalegal, status: "pending", invitedAt: new Date("2026-07-20T14:00:00.000Z") }],
      preEngagement: {
        status: "submitted",
        requestedParalegalId: ids.invitedParalegal,
        confidentialityAgreementRequired: true,
        conflictsCheckRequired: true,
        conflictsDetails: "Synthetic conflict-check scope.",
        confidentialityDocument: { key: "p6/confidentiality.pdf", name: "Synthetic confidentiality.pdf", mimeType: "application/pdf", size: 42, uploadedAt: new Date("2026-07-20T15:00:00.000Z") },
        requestedAt: new Date("2026-07-20T14:30:00.000Z"),
        requestedBy: ids.owner,
        submittedAt: new Date("2026-07-21T12:00:00.000Z"),
        submittedBy: ids.invitedParalegal,
      },
    }),
    active: syntheticCase({
      _id: caseIds.active,
      attorneyId: ids.owner,
      title: "Active Discovery Matter",
      status: "in progress",
      paralegalId: ids.assignedParalegal,
      now: new Date(now.getTime() - 60 * 60 * 1000),
      deadline: new Date("2026-08-15T21:00:00.000Z"),
      hiredAt: new Date("2026-06-15T15:00:00.000Z"),
      tasksLocked: true,
      tasks: [
        { title: "Draft chronology", completed: false, createdAt: new Date("2026-06-16T12:00:00.000Z") },
        { title: "Index discovery", completed: true, createdAt: new Date("2026-06-16T13:00:00.000Z") },
      ],
      files: [{ filename: "legacy-index.pdf", original: "Synthetic legacy index.pdf", uploadedBy: ids.assignedParalegal, uploadedByRole: "paralegal", status: "approved", version: 1, approvedAt: new Date("2026-07-18T12:00:00.000Z"), createdAt: new Date("2026-07-17T12:00:00.000Z") }],
      totalAmount: 250000,
      lockedTotalAmount: 250000,
      amountLockedAt: new Date("2026-06-15T15:00:00.000Z"),
      feeAttorneyAmount: 55000,
      feeParalegalAmount: 45000,
      escrowIntentId: "pi_p6_active",
      paymentIntentId: "pi_p6_active",
      escrowStatus: "funded",
    }),
    paused: syntheticCase({
      _id: caseIds.paused,
      attorneyId: ids.owner,
      title: "Paused Withdrawal Matter",
      status: "paused",
      now: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      pausedReason: "paralegal_withdrew",
      pausedAt: new Date("2026-07-19T12:00:00.000Z"),
      withdrawnParalegalId: ids.assignedParalegal,
      payoutFinalizedAt: new Date("2026-07-20T12:00:00.000Z"),
      payoutFinalizedType: "partial_attorney",
      partialPayoutAmount: 30000,
      remainingAmount: 70000,
      relistPending: true,
      relistRequestedAt: new Date("2026-07-21T12:00:00.000Z"),
      totalAmount: 100000,
      lockedTotalAmount: 100000,
      feeAttorneyAmount: 22000,
      feeParalegalAmount: 5400,
    }),
    completed: syntheticCase({
      _id: caseIds.completed,
      attorneyId: ids.owner,
      title: "Completed Payout Matter",
      status: "completed",
      paralegalId: ids.assignedParalegal,
      now: new Date(now.getTime() - 3 * 60 * 60 * 1000),
      completedAt: new Date("2026-07-15T12:00:00.000Z"),
      totalAmount: 100000,
      lockedTotalAmount: 100000,
      amountLockedAt: new Date("2026-06-01T12:00:00.000Z"),
      feeAttorneyAmount: 22000,
      feeParalegalAmount: 18000,
      paymentIntentId: "pi_p6_completed",
      escrowIntentId: "pi_p6_completed",
      escrowStatus: "released",
      paymentReleased: true,
      paidOutAt: new Date("2026-07-16T12:00:00.000Z"),
    }),
    disputed: syntheticCase({
      _id: caseIds.disputed,
      attorneyId: ids.owner,
      title: "Disputed Settlement Matter",
      status: "disputed",
      paralegalId: ids.assignedParalegal,
      now: new Date(now.getTime() - 4 * 60 * 60 * 1000),
      disputes: [{ disputeId: "p6-dispute-1", message: "Synthetic fee dispute.", amountRequestedCents: 50000, raisedBy: ids.owner, status: "resolved", createdAt: new Date("2026-07-10T12:00:00.000Z"), updatedAt: new Date("2026-07-18T12:00:00.000Z") }],
      disputeSettlement: { action: "release_partial", grossAmount: 50000, feeAttorneyAmount: 11000, feeParalegalAmount: 9000, feeAttorneyPct: 22, feeParalegalPct: 18, payoutAmount: 41000, refundAmount: 50000, resolvedAt: new Date("2026-07-18T12:00:00.000Z"), disputeId: "p6-dispute-1" },
      terminationStatus: "resolved",
      terminationReason: "Synthetic scope ended.",
      terminationRequestedAt: new Date("2026-07-10T12:00:00.000Z"),
      terminationRequestedBy: ids.owner,
      terminatedAt: new Date("2026-07-18T12:00:00.000Z"),
      totalAmount: 100000,
      lockedTotalAmount: 100000,
      feeAttorneyAmount: 22000,
      feeParalegalAmount: 18000,
    }),
    archived: syntheticCase({
      _id: caseIds.archived,
      attorneyId: ids.owner,
      title: "Closed Archive Matter",
      status: "closed",
      paralegalId: ids.assignedParalegal,
      now: new Date(now.getTime() - 5 * 60 * 60 * 1000),
      completedAt: new Date("2026-05-01T12:00:00.000Z"),
      archived: true,
      readOnly: true,
      downloadUrl: ["/synthetic/package6/archive.zip"],
      archiveZipKey: "p6/archive/closed.zip",
      archiveReadyAt: new Date("2026-05-02T12:00:00.000Z"),
      archiveDownloadedAt: new Date("2026-05-03T12:00:00.000Z"),
      purgeScheduledFor: new Date("2026-11-01T12:00:00.000Z"),
    }),
    purged: syntheticCase({
      _id: caseIds.purged,
      attorneyId: ids.owner,
      title: "Closed Purged Matter",
      status: "closed",
      now: new Date(now.getTime() - 7 * 60 * 60 * 1000),
      completedAt: new Date("2025-01-01T12:00:00.000Z"),
      archived: true,
      readOnly: true,
      purgeScheduledFor: new Date("2026-01-01T12:00:00.000Z"),
      purgedAt: new Date("2026-01-02T12:00:00.000Z"),
    }),
    one: syntheticCase({
      _id: caseIds.one,
      attorneyId: ids.oneAttorney,
      title: "Single Matter",
      status: "open",
      now: new Date(now.getTime() - 8 * 60 * 60 * 1000),
    }),
    inaccessible: syntheticCase({
      _id: caseIds.inaccessible,
      attorneyId: ids.otherAttorney,
      title: "Other Attorney Confidential Matter",
      status: "in progress",
      paralegalId: ids.assignedParalegal,
      now: new Date(now.getTime() - 30 * 60 * 1000),
      details: "Synthetic inaccessible record that must never influence the owner fixture.",
      totalAmount: 999999,
      lockedTotalAmount: 999999,
      feeAttorneyAmount: 219999,
      feeParalegalAmount: 179999,
    }),
  };

  const fixture = { now, ids, caseIds, jobId, users, cases };
  assertSyntheticFixtureData(fixture);

  await User.collection.insertMany(Object.values(users));
  await Case.collection.insertMany(Object.values(cases));
  await Job.collection.insertOne({
    _id: jobId,
    caseId: caseIds.open,
    attorneyId: ids.owner,
    title: cases.open.title,
    practiceArea: "Civil Litigation",
    description: "Synthetic Package 6 job.",
    budget: 125000,
    status: "open",
    applicantsCount: 1,
    createdAt: new Date("2026-07-19T12:00:00.000Z"),
  });
  await Application.collection.insertOne({
    _id: objectId(),
    jobId,
    paralegalId: ids.applicantParalegal,
    coverLetter: "Synthetic Package 6 application.",
    status: "submitted",
    createdAt: new Date("2026-07-21T14:00:00.000Z"),
  });
  await CaseFile.collection.insertOne({
    _id: objectId(),
    caseId: caseIds.active,
    userId: ids.assignedParalegal,
    originalName: "Synthetic discovery response.pdf",
    storageKey: "p6/files/discovery-response.pdf",
    mimeType: "application/pdf",
    size: 2048,
    uploadedByRole: "paralegal",
    status: "attorney_revision",
    version: 2,
    revisionNotes: "Synthetic revision request.",
    revisionRequestedAt: new Date("2026-07-20T12:00:00.000Z"),
    createdAt: new Date("2026-07-19T12:00:00.000Z"),
  });
  await Message.collection.insertMany([
    {
      _id: objectId(),
      caseId: caseIds.active,
      senderId: ids.owner,
      senderRole: "attorney",
      type: "text",
      text: "Synthetic instruction from attorney.",
      readBy: [ids.assignedParalegal],
      createdAt: new Date("2026-07-20T10:00:00.000Z"),
      updatedAt: new Date("2026-07-20T10:00:00.000Z"),
    },
    {
      _id: objectId(),
      caseId: caseIds.active,
      senderId: ids.assignedParalegal,
      senderRole: "paralegal",
      type: "text",
      text: "Synthetic deliverable is ready for review.",
      readBy: [],
      createdAt: new Date("2026-07-21T10:00:00.000Z"),
      updatedAt: new Date("2026-07-21T10:00:00.000Z"),
    },
  ]);
  await Payout.collection.insertOne({
    _id: objectId(),
    paralegalId: ids.assignedParalegal,
    caseId: caseIds.completed,
    amountPaid: 82000,
    transferId: "tr_p6_completed",
    stripeMode: "test",
    createdAt: new Date("2026-07-16T12:00:00.000Z"),
  });

  return fixture;
}

module.exports = {
  SYNTHETIC_DOMAIN,
  SYNTHETIC_TITLE_PREFIX,
  assertSyntheticFixtureData,
  seedAttorneySupportFixtures,
};
