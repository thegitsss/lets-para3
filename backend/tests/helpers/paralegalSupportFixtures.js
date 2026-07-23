const mongoose = require("mongoose");

const Application = require("../../models/Application");
const Case = require("../../models/Case");
const CaseFile = require("../../models/CaseFile");
const Job = require("../../models/Job");
const Message = require("../../models/Message");
const Payout = require("../../models/Payout");
const Task = require("../../models/Task");
const User = require("../../models/User");

const SYNTHETIC_DOMAIN = "package6.paralegal.invalid";
const SYNTHETIC_TITLE_PREFIX = "P6 Paralegal Synthetic";

function objectId() {
  return new mongoose.Types.ObjectId();
}

function syntheticUser({ _id = objectId(), role, label, payoutReady = false }) {
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
    termsAccepted: true,
    stripeAccountId: payoutReady ? `acct_p6_paralegal_${String(_id).slice(-8)}` : null,
    stripeOnboarded: payoutReady,
    stripePayoutsEnabled: payoutReady,
    stripeChargesEnabled: payoutReady,
    state: "New York",
    location: "New York",
    availability: "Available",
    specialties: role === "paralegal" ? ["Civil Litigation"] : [],
    skills: role === "paralegal" ? ["Discovery"] : [],
    yearsExperience: role === "paralegal" ? 7 : null,
    bio: "Synthetic Package 6 paralegal assistant fixture. This is not a customer record.",
    resumeURL: role === "paralegal" ? "/synthetic/package6/resume.pdf" : "",
    preferences: { theme: "mountain", fontSize: "md", hideProfile: false },
    notificationPrefs: { email: true, inApp: true, browser: false },
    onboarding: {
      paralegalWelcomeDismissed: true,
      paralegalTourCompleted: true,
      paralegalProfileTourCompleted: true,
    },
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    updatedAt: new Date("2026-07-20T12:00:00.000Z"),
  };
}

function syntheticCase({
  _id = objectId(),
  attorneyId,
  title,
  status,
  paralegalId = null,
  updatedAt,
  ...overrides
}) {
  return {
    _id,
    attorney: attorneyId,
    attorneyId,
    attorneyNameSnapshot: "P6 Synthetic Attorney",
    paralegal: paralegalId,
    paralegalId,
    title: `${SYNTHETIC_TITLE_PREFIX} ${title}`,
    practiceArea: "Civil Litigation",
    details: "Synthetic matter used only for isolated Package 6 paralegal assistant verification.",
    state: "New York",
    locationState: "New York",
    status,
    currency: "usd",
    totalAmount: 0,
    lockedTotalAmount: 0,
    feeParalegalPct: 18,
    feeParalegalAmount: 0,
    applicants: [],
    invites: [],
    tasks: [],
    files: [],
    disputes: [],
    archived: false,
    readOnly: false,
    moderationStatus: "none",
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    updatedAt,
    ...overrides,
  };
}

function assertSyntheticFixtureData(fixture) {
  const users = Object.values(fixture.users || {});
  const cases = Object.values(fixture.cases || {});
  if (!users.length || users.some((user) => !String(user.email || "").endsWith(`@${SYNTHETIC_DOMAIN}`))) {
    throw new Error("Package 6 paralegal fixture contains a non-synthetic user identity.");
  }
  if (!cases.length || cases.some((caseDoc) => !String(caseDoc.title || "").startsWith(SYNTHETIC_TITLE_PREFIX))) {
    throw new Error("Package 6 paralegal fixture contains a non-synthetic matter title.");
  }
  return true;
}

async function seedParalegalSupportFixtures() {
  const now = new Date("2026-07-23T16:00:00.000Z");
  const ids = {
    owner: objectId(),
    emptyParalegal: objectId(),
    otherParalegal: objectId(),
    attorney: objectId(),
    otherAttorney: objectId(),
  };
  const users = {
    owner: syntheticUser({ _id: ids.owner, role: "paralegal", label: "Owner", payoutReady: true }),
    emptyParalegal: syntheticUser({ _id: ids.emptyParalegal, role: "paralegal", label: "Empty" }),
    otherParalegal: syntheticUser({ _id: ids.otherParalegal, role: "paralegal", label: "Other", payoutReady: true }),
    attorney: syntheticUser({ _id: ids.attorney, role: "attorney", label: "Attorney" }),
    otherAttorney: syntheticUser({ _id: ids.otherAttorney, role: "attorney", label: "Other Attorney" }),
  };

  const caseIds = {
    assigned: objectId(),
    invited: objectId(),
    applied: objectId(),
    rejected: objectId(),
    completed: objectId(),
    withdrawn: objectId(),
    disputed: objectId(),
    archived: objectId(),
    inaccessible: objectId(),
  };
  const jobIds = { applied: objectId(), rejected: objectId() };
  const cases = {
    assigned: syntheticCase({
      _id: caseIds.assigned,
      attorneyId: ids.attorney,
      title: "Assigned Discovery Matter",
      status: "in progress",
      paralegalId: ids.owner,
      updatedAt: new Date("2026-07-23T15:00:00.000Z"),
      deadline: new Date("2026-08-15T21:00:00.000Z"),
      hiredAt: new Date("2026-07-01T12:00:00.000Z"),
      totalAmount: 250000,
      lockedTotalAmount: 250000,
      feeParalegalAmount: 45000,
      tasksLocked: true,
      tasks: [
        { title: "Draft chronology", completed: false, createdAt: new Date("2026-07-02T12:00:00.000Z") },
        { title: "Index production", completed: true, createdAt: new Date("2026-07-02T13:00:00.000Z") },
      ],
      escrowIntentId: "pi_p6_paralegal_assigned",
      escrowStatus: "funded",
    }),
    invited: syntheticCase({
      _id: caseIds.invited,
      attorneyId: ids.attorney,
      title: "Pending Invitation Matter",
      status: "open",
      updatedAt: new Date("2026-07-23T14:00:00.000Z"),
      pendingParalegalId: ids.owner,
      pendingParalegalInvitedAt: new Date("2026-07-22T12:00:00.000Z"),
      invites: [{
        paralegalId: ids.owner,
        status: "pending",
        invitedAt: new Date("2026-07-22T12:00:00.000Z"),
      }],
      preEngagement: {
        status: "requested",
        requestedParalegalId: ids.owner,
        confidentialityAgreementRequired: true,
        conflictsCheckRequired: true,
        requestedAt: new Date("2026-07-22T12:30:00.000Z"),
        requestedBy: ids.attorney,
      },
    }),
    applied: syntheticCase({
      _id: caseIds.applied,
      attorneyId: ids.attorney,
      title: "Submitted Application Matter",
      status: "open",
      updatedAt: new Date("2026-07-23T13:00:00.000Z"),
      jobId: jobIds.applied,
      applicants: [{
        paralegalId: ids.owner,
        status: "submitted",
        appliedAt: new Date("2026-07-21T12:00:00.000Z"),
      }],
    }),
    rejected: syntheticCase({
      _id: caseIds.rejected,
      attorneyId: ids.attorney,
      title: "Rejected Application Matter",
      status: "open",
      updatedAt: new Date("2026-07-23T12:00:00.000Z"),
      jobId: jobIds.rejected,
      applicants: [{
        paralegalId: ids.owner,
        status: "rejected",
        appliedAt: new Date("2026-07-10T12:00:00.000Z"),
      }],
    }),
    completed: syntheticCase({
      _id: caseIds.completed,
      attorneyId: ids.attorney,
      title: "Completed Payout Matter",
      status: "completed",
      paralegalId: ids.owner,
      updatedAt: new Date("2026-07-23T11:00:00.000Z"),
      completedAt: new Date("2026-07-15T12:00:00.000Z"),
      totalAmount: 100000,
      lockedTotalAmount: 100000,
      feeParalegalAmount: 18000,
      paymentReleased: true,
      paidOutAt: new Date("2026-07-16T12:00:00.000Z"),
      payoutFinalizedAt: new Date("2026-07-16T12:00:00.000Z"),
      payoutFinalizedType: "full",
      escrowStatus: "released",
    }),
    withdrawn: syntheticCase({
      _id: caseIds.withdrawn,
      attorneyId: ids.attorney,
      title: "Withdrawn Matter",
      status: "paused",
      updatedAt: new Date("2026-07-23T10:00:00.000Z"),
      withdrawnParalegalId: ids.owner,
      pausedReason: "paralegal_withdrew",
      pausedAt: new Date("2026-07-18T12:00:00.000Z"),
      paralegalAccessRevokedAt: new Date("2026-07-18T12:00:00.000Z"),
      payoutFinalizedAt: new Date("2026-07-19T12:00:00.000Z"),
      payoutFinalizedType: "partial_paralegal",
      partialPayoutAmount: 30000,
      remainingAmount: 70000,
      totalAmount: 100000,
      lockedTotalAmount: 100000,
    }),
    disputed: syntheticCase({
      _id: caseIds.disputed,
      attorneyId: ids.attorney,
      title: "Disputed Matter",
      status: "disputed",
      paralegalId: ids.owner,
      updatedAt: new Date("2026-07-23T09:00:00.000Z"),
      totalAmount: 120000,
      lockedTotalAmount: 120000,
      feeParalegalAmount: 21600,
      disputes: [{
        disputeId: "p6-paralegal-dispute",
        message: "Synthetic scope dispute.",
        amountRequestedCents: 50000,
        raisedBy: ids.owner,
        status: "open",
        createdAt: new Date("2026-07-20T12:00:00.000Z"),
      }],
      moderationStatus: "pending_review",
    }),
    archived: syntheticCase({
      _id: caseIds.archived,
      attorneyId: ids.attorney,
      title: "Archived Matter",
      status: "closed",
      paralegalId: ids.owner,
      updatedAt: new Date("2026-07-23T08:00:00.000Z"),
      completedAt: new Date("2026-05-01T12:00:00.000Z"),
      archived: true,
      readOnly: true,
      archiveReadyAt: new Date("2026-05-02T12:00:00.000Z"),
      purgeScheduledFor: new Date("2026-11-01T12:00:00.000Z"),
    }),
    inaccessible: syntheticCase({
      _id: caseIds.inaccessible,
      attorneyId: ids.otherAttorney,
      title: "Inaccessible Confidential Matter",
      status: "in progress",
      paralegalId: ids.otherParalegal,
      updatedAt: new Date("2026-07-23T15:30:00.000Z"),
      totalAmount: 999999,
      lockedTotalAmount: 999999,
      feeParalegalAmount: 179999,
    }),
  };

  const fixture = { now, ids, caseIds, jobIds, users, cases };
  assertSyntheticFixtureData(fixture);

  await User.collection.insertMany(Object.values(users));
  await Case.collection.insertMany(Object.values(cases));
  await Job.collection.insertMany([
    {
      _id: jobIds.applied,
      caseId: caseIds.applied,
      attorneyId: ids.attorney,
      title: cases.applied.title,
      practiceArea: "Civil Litigation",
      description: "Synthetic submitted application job.",
      budget: 90000,
      status: "open",
      createdAt: new Date("2026-07-20T12:00:00.000Z"),
    },
    {
      _id: jobIds.rejected,
      caseId: caseIds.rejected,
      attorneyId: ids.attorney,
      title: cases.rejected.title,
      practiceArea: "Civil Litigation",
      description: "Synthetic rejected application job.",
      budget: 80000,
      status: "open",
      createdAt: new Date("2026-07-09T12:00:00.000Z"),
    },
  ]);
  await Application.collection.insertMany([
    {
      _id: objectId(),
      jobId: jobIds.applied,
      paralegalId: ids.owner,
      coverLetter: "Synthetic Package 6 submitted application.",
      status: "submitted",
      createdAt: new Date("2026-07-21T12:00:00.000Z"),
    },
    {
      _id: objectId(),
      jobId: jobIds.rejected,
      paralegalId: ids.owner,
      coverLetter: "Synthetic Package 6 rejected application.",
      status: "rejected",
      createdAt: new Date("2026-07-10T12:00:00.000Z"),
    },
  ]);
  await Task.collection.insertMany([
    {
      _id: objectId(),
      caseId: caseIds.assigned,
      paralegalId: ids.owner,
      title: "Prepare witness index",
      description: "Synthetic assigned task.",
      dueDate: new Date("2026-08-10T21:00:00.000Z"),
      status: "in progress",
      createdAt: new Date("2026-07-03T12:00:00.000Z"),
    },
    {
      _id: objectId(),
      caseId: caseIds.withdrawn,
      paralegalId: ids.owner,
      title: "Pre-withdrawal task",
      description: "Synthetic task visible before access cutoff.",
      status: "review",
      createdAt: new Date("2026-07-17T12:00:00.000Z"),
    },
    {
      _id: objectId(),
      caseId: caseIds.withdrawn,
      paralegalId: ids.owner,
      title: "Post-withdrawal hidden task",
      description: "Synthetic task created after access cutoff.",
      status: "todo",
      createdAt: new Date("2026-07-20T12:00:00.000Z"),
    },
  ]);
  await CaseFile.collection.insertMany([
    {
      _id: objectId(),
      caseId: caseIds.assigned,
      userId: ids.owner,
      originalName: "Synthetic chronology.pdf",
      storageKey: "p6/paralegal/chronology.pdf",
      mimeType: "application/pdf",
      size: 2048,
      uploadedByRole: "paralegal",
      status: "attorney_revision",
      version: 2,
      revisionNotes: "Synthetic revision requested.",
      revisionRequestedAt: new Date("2026-07-20T12:00:00.000Z"),
      createdAt: new Date("2026-07-19T12:00:00.000Z"),
    },
    {
      _id: objectId(),
      caseId: caseIds.withdrawn,
      userId: ids.owner,
      originalName: "Synthetic pre-withdrawal file.pdf",
      storageKey: "p6/paralegal/pre-withdrawal.pdf",
      mimeType: "application/pdf",
      size: 1024,
      uploadedByRole: "paralegal",
      status: "approved",
      version: 1,
      approvedAt: new Date("2026-07-17T12:00:00.000Z"),
      createdAt: new Date("2026-07-17T12:00:00.000Z"),
    },
    {
      _id: objectId(),
      caseId: caseIds.withdrawn,
      userId: ids.attorney,
      originalName: "Synthetic post-withdrawal hidden file.pdf",
      storageKey: "p6/paralegal/post-withdrawal.pdf",
      mimeType: "application/pdf",
      size: 4096,
      uploadedByRole: "attorney",
      status: "pending_review",
      version: 1,
      createdAt: new Date("2026-07-20T12:00:00.000Z"),
    },
  ]);
  await Message.collection.insertMany([
    {
      _id: objectId(),
      caseId: caseIds.assigned,
      senderId: ids.owner,
      senderRole: "paralegal",
      type: "text",
      text: "Synthetic deliverable is ready.",
      readBy: [ids.owner],
      createdAt: new Date("2026-07-22T10:00:00.000Z"),
      updatedAt: new Date("2026-07-22T10:00:00.000Z"),
    },
    {
      _id: objectId(),
      caseId: caseIds.assigned,
      senderId: ids.attorney,
      senderRole: "attorney",
      type: "text",
      text: "Synthetic revision request.",
      readBy: [],
      createdAt: new Date("2026-07-23T10:00:00.000Z"),
      updatedAt: new Date("2026-07-23T10:00:00.000Z"),
    },
  ]);
  await Payout.collection.insertOne({
    _id: objectId(),
    paralegalId: ids.owner,
    caseId: caseIds.completed,
    amountPaid: 82000,
    transferId: "tr_p6_paralegal_completed",
    stripeMode: "test",
    createdAt: new Date("2026-07-16T12:00:00.000Z"),
  });

  return fixture;
}

module.exports = {
  SYNTHETIC_DOMAIN,
  SYNTHETIC_TITLE_PREFIX,
  assertSyntheticFixtureData,
  seedParalegalSupportFixtures,
};
