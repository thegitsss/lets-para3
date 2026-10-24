const jwt = require("jsonwebtoken");
const User = require("../../models/User");
const Case = require("../../models/Case");
const Job = require("../../models/Job");
const Application = require("../../models/Application");
const Message = require("../../models/Message");
const CaseFile = require("../../models/CaseFile");
const Notification = require("../../models/Notification");

const PHASE2_CLOCK = Object.freeze({
  draft: new Date("2026-09-01T14:00:00.000Z"),
  published: new Date("2026-09-01T14:05:00.000Z"),
  applied: new Date("2026-09-01T14:10:00.000Z"),
  hired: new Date("2026-09-01T15:00:00.000Z"),
  completed: new Date("2026-09-02T18:00:00.000Z"),
});

const PHASE3_BROWSER_CLIENTS = Object.freeze({
  primaryTab: "phase3-paralegal-tab-a",
  sameUserTab: "phase3-paralegal-tab-b",
  separateContext: "phase3-paralegal-device-b",
  attorneyTab: "phase3-attorney-tab",
  adminTab: "phase3-admin-tab",
});

function createPhase3DeferredResponse(label = "phase3-delayed-response") {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { label, promise, resolve, reject };
}

function authCookieFor(user) {
  const token = jwt.sign(
    {
      id: String(user._id),
      role: user.role,
      email: user.email,
      status: user.status,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
  return `token=${token}`;
}

async function createPhase2Actors() {
  const [attorney, paralegal, otherParalegal, admin] = await User.create([
    {
      firstName: "Phase Two",
      lastName: "Attorney",
      email: "phase2.attorney@lets-paraconnect.test",
      password: "Password123!",
      role: "attorney",
      status: "approved",
      state: "CA",
    },
    {
      firstName: "Phase Two",
      lastName: "Paralegal",
      email: "phase2.paralegal@lets-paraconnect.test",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stateExperience: ["CA"],
      practiceAreas: ["Immigration"],
      yearsExperience: 8,
      profileImage: "https://assets.test/phase2-paralegal.jpg",
      stripeAccountId: "acct_phase2_paralegal",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    {
      firstName: "Phase Two",
      lastName: "Alternate",
      email: "phase2.alternate@lets-paraconnect.test",
      password: "Password123!",
      role: "paralegal",
      status: "approved",
      state: "CA",
      stateExperience: ["CA"],
      practiceAreas: ["Immigration"],
      yearsExperience: 8,
      profileImage: "https://assets.test/phase2-alternate.jpg",
      stripeAccountId: "acct_phase2_alternate",
      stripeOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
    {
      firstName: "Phase Two",
      lastName: "Admin",
      email: "phase2.admin@lets-paraconnect.test",
      password: "Password123!",
      role: "admin",
      status: "approved",
      state: "CA",
    },
  ]);

  return {
    attorney,
    paralegal,
    otherParalegal,
    admin,
    cookies: {
      attorney: authCookieFor(attorney),
      paralegal: authCookieFor(paralegal),
      otherParalegal: authCookieFor(otherParalegal),
      admin: authCookieFor(admin),
    },
  };
}

async function createPhase3OpenMatter({
  actors,
  title = "Phase 3 stale opportunity",
  applicantIds = [],
  invitedParalegalIds = [],
} = {}) {
  const caseDoc = await Case.create({
    attorney: actors.attorney._id,
    attorneyId: actors.attorney._id,
    title,
    details: "Characterize stale opportunity actions after authoritative access changes.",
    practiceArea: "Immigration",
    state: "CA",
    locationState: "CA",
    status: "open",
    totalAmount: 40_000,
    currency: "usd",
    deadline: new Date("2026-10-15T00:00:00.000Z"),
    deadlineDate: "2026-10-15",
    tasks: [{ title: "Prepare lifecycle evidence", completed: false }],
    applicants: applicantIds.map((paralegalId) => ({
      paralegalId,
      status: "pending",
      appliedAt: PHASE2_CLOCK.applied,
      note: "Phase 3 deterministic application evidence.",
    })),
    invites: invitedParalegalIds.map((paralegalId) => ({
      paralegalId,
      status: "pending",
      invitedAt: PHASE2_CLOCK.applied,
    })),
    pendingParalegalId: invitedParalegalIds[0] || null,
    pendingParalegalInvitedAt: invitedParalegalIds.length ? PHASE2_CLOCK.applied : null,
  });
  const job = await Job.create({
    attorneyId: actors.attorney._id,
    caseId: caseDoc._id,
    title,
    description: caseDoc.details,
    practiceArea: "Immigration",
    state: "CA",
    budget: 400,
    status: "open",
    requiredExperience: 5,
    applicationsCount: applicantIds.length,
  });
  caseDoc.jobId = job._id;
  await caseDoc.save();
  const applications = [];
  for (const paralegalId of applicantIds) {
    applications.push(await Application.create({
      jobId: job._id,
      paralegalId,
      status: "submitted",
      coverLetter: "Phase 3 deterministic application cover letter.",
      syncStatus: "synced",
      syncedAt: PHASE2_CLOCK.applied,
    }));
  }
  return { caseDoc, job, applications };
}

async function createPhase3ActiveMatter({
  actors,
  title = "Phase 3 active workspace",
  paralegal = actors.paralegal,
} = {}) {
  const caseDoc = await Case.create({
    attorney: actors.attorney._id,
    attorneyId: actors.attorney._id,
    paralegal: paralegal._id,
    paralegalId: paralegal._id,
    title,
    details: "Confidential Phase 3 workspace evidence.",
    practiceArea: "Immigration",
    state: "CA",
    locationState: "CA",
    status: "in progress",
    totalAmount: 40_000,
    lockedTotalAmount: 40_000,
    remainingAmount: 40_000,
    currency: "usd",
    escrowStatus: "funded",
    escrowIntentId: `pi_${String(paralegal._id)}`,
    paymentIntentId: `pi_${String(paralegal._id)}`,
    fundingIntegrityStatus: "verified",
    hiredAt: PHASE2_CLOCK.hired,
    deadline: new Date("2026-10-15T00:00:00.000Z"),
    deadlineDate: "2026-10-15",
    tasksLocked: true,
    tasks: [{ title: "Confidential lifecycle task", completed: false }],
  });
  const job = await Job.create({
    attorneyId: actors.attorney._id,
    caseId: caseDoc._id,
    title,
    description: caseDoc.details,
    practiceArea: "Immigration",
    state: "CA",
    budget: 400,
    status: "assigned",
    requiredExperience: 5,
    applicationsCount: 0,
  });
  caseDoc.jobId = job._id;
  await caseDoc.save();
  const application = await Application.create({
    jobId: job._id,
    paralegalId: paralegal._id,
    status: "accepted",
    coverLetter: "Phase 3 accepted application evidence.",
    syncStatus: "synced",
    syncedAt: PHASE2_CLOCK.hired,
  });
  const message = await Message.create({
    caseId: caseDoc._id,
    sender: actors.attorney._id,
    senderId: actors.attorney._id,
    senderRole: "attorney",
    text: "Confidential Phase 3 message evidence.",
  });
  const file = await CaseFile.create({
    caseId: caseDoc._id,
    userId: paralegal._id,
    uploadedByRole: "paralegal",
    originalName: "phase3-confidential.pdf",
    storageKey: `phase3/${caseDoc._id}/confidential.pdf`,
    mimeType: "application/pdf",
    size: 128,
    status: "approved",
    securityStatus: "clean",
  });
  const notification = await Notification.create({
    userId: paralegal._id,
    userRole: "paralegal",
    type: "case_update",
    message: `Open ${title}`,
    link: `/case-detail.html?caseId=${caseDoc._id}`,
    payload: { caseId: caseDoc._id, caseTitle: title },
  });
  return { caseDoc, job, application, message, file, notification };
}

module.exports = {
  PHASE2_CLOCK,
  PHASE3_BROWSER_CLIENTS,
  authCookieFor,
  createPhase2Actors,
  createPhase3DeferredResponse,
  createPhase3ActiveMatter,
  createPhase3OpenMatter,
};
