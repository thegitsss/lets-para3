const crypto = require("crypto");

const ApprovalTask = require("../../models/ApprovalTask");
const AutonomousAction = require("../../models/AutonomousAction");
const FAQCandidate = require("../../models/FAQCandidate");
const Incident = require("../../models/Incident");
const IncidentApproval = require("../../models/IncidentApproval");
const { LpcAction } = require("../../models/LpcAction");
const MarketingBrief = require("../../models/MarketingBrief");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const SalesAccount = require("../../models/SalesAccount");
const SalesDraftPacket = require("../../models/SalesDraftPacket");
const SupportConversation = require("../../models/SupportConversation");
const SupportMessage = require("../../models/SupportMessage");
const SupportTicket = require("../../models/SupportTicket");
const User = require("../../models/User");
const { logAction } = require("./autonomousActionService");
const { assertControlRoomE2eHarnessEnabled } = require("../../utils/controlRoomE2eHarnessAccess");

const DEFAULT_ADMIN_EMAIL = "control-room.e2e.admin@lets-paraconnect.dev";
const DEFAULT_ADMIN_PASSWORD = "ControlRoomHarness123!";
const DEFAULT_SUPPORT_ATTORNEY_EMAIL = "support.cr.e2e.attorney@lets-paraconnect.dev";
const SUPPORT_USER_PASSWORD = "ControlRoomSupport123!";
const APPLICANT_PASSWORD = "ControlRoomApplicant123!";
const HARNESS_RUN_KEY_PATTERN = /^cr-e2e-/i;
const HARNESS_INCIDENT_FEATURE_PATTERN = /^control-room-e2e-/i;
const HARNESS_ACTION_DEDUPE_PATTERN = /^control-room-e2e:/i;
const HARNESS_SUPPORT_SUBJECT_PATTERN = /^Control Room autonomous reopen cr-e2e-/i;
const HARNESS_MARKETING_BRIEF_PATTERN = /^Control Room marketing brief cr-e2e-/i;
const HARNESS_USER_EMAIL_PATTERN = /^(support|admissions)\.cr\.e2e\..*@lets-paraconnect\.dev$/i;

function compactText(value = "", max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function createRunKey() {
  const datePart = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const randomPart = crypto.randomBytes(3).toString("hex");
  return `cr-e2e-${datePart}-${randomPart}`;
}

function resolveAdminCredentials() {
  return {
    email: String(process.env.CONTROL_ROOM_E2E_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).trim().toLowerCase(),
    password: String(process.env.CONTROL_ROOM_E2E_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD),
  };
}

function resolveSupportAttorneyCredentials() {
  return {
    email: String(process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_EMAIL || DEFAULT_SUPPORT_ATTORNEY_EMAIL)
      .trim()
      .toLowerCase(),
    password: String(process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_PASSWORD || SUPPORT_USER_PASSWORD),
  };
}

function buildHarnessEmail(localPart = "") {
  const safe = String(localPart || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".");
  return `${safe}@lets-paraconnect.dev`;
}

function buildActor(user = {}) {
  return {
    actorType: "user",
    userId: user?._id || user?.id || null,
    label: user?.email || "Admin",
  };
}

async function stampDocument(Model, id, date, { createdAt = true, updatedAt = true } = {}) {
  if (!Model?.collection || !id || !(date instanceof Date) || Number.isNaN(date.getTime())) return;
  const update = {};
  if (createdAt) update.createdAt = date;
  if (updatedAt) update.updatedAt = date;
  if (!Object.keys(update).length) return;
  await Model.collection.updateOne({ _id: id }, { $set: update });
}

async function upsertHarnessAdmin() {
  assertControlRoomE2eHarnessEnabled();
  const credentials = resolveAdminCredentials();
  process.env.CONTROL_ROOM_E2E_ADMIN_EMAIL = credentials.email;
  process.env.INCIDENT_FOUNDER_APPROVER_EMAILS = credentials.email;
  let admin = await User.findOne({ email: credentials.email });

  if (!admin) {
    admin = new User({
      firstName: "Samantha",
      lastName: "Harness",
      email: credentials.email,
      password: credentials.password,
      role: "admin",
      status: "approved",
      state: "CA",
      location: "California",
      emailVerified: true,
      termsAccepted: true,
      approvedAt: new Date(),
      twoFactorEnabled: false,
    });
  } else {
    admin.firstName = admin.firstName || "Samantha";
    admin.lastName = admin.lastName || "Harness";
    admin.password = credentials.password;
    admin.role = "admin";
    admin.status = "approved";
    admin.state = admin.state || "CA";
    admin.location = admin.location || "California";
    admin.emailVerified = true;
    admin.termsAccepted = true;
    admin.approvedAt = admin.approvedAt || new Date();
    admin.disabled = false;
    admin.deleted = false;
    admin.twoFactorEnabled = false;
  }

  await admin.save();
  return {
    admin,
    credentials,
  };
}

async function upsertHarnessSupportAttorney(options = {}) {
  assertControlRoomE2eHarnessEnabled();
  const forceFreshApproval = Boolean(options?.forceFreshApproval);
  const credentials = resolveSupportAttorneyCredentials();
  let attorney = await User.findOne({ email: credentials.email });

  if (!attorney) {
    attorney = new User({
      firstName: "Avery",
      lastName: "Harness",
      email: credentials.email,
      password: credentials.password,
      role: "attorney",
      status: "approved",
      state: "CA",
      location: "California",
      emailVerified: true,
      termsAccepted: true,
      approvedAt: new Date(),
      twoFactorEnabled: false,
    });
  } else {
    attorney.firstName = attorney.firstName || "Avery";
    attorney.lastName = attorney.lastName || "Harness";
    attorney.password = credentials.password;
    attorney.role = "attorney";
    attorney.status = "approved";
    attorney.state = attorney.state || "CA";
    attorney.location = attorney.location || "California";
    attorney.emailVerified = true;
    attorney.termsAccepted = true;
    attorney.approvedAt = attorney.approvedAt || new Date();
    attorney.disabled = false;
    attorney.deleted = false;
    attorney.twoFactorEnabled = false;
  }

  if (forceFreshApproval) {
    attorney.approvedAt = new Date();
    attorney.lastLoginAt = null;
    attorney.onboarding = {
      ...(attorney.onboarding || {}),
      attorneyTourCompleted: false,
    };
  }

  await attorney.save();
  return {
    attorney,
    credentials,
  };
}

async function cleanupHarnessFixtures() {
  const [incidentDocs, supportUsers] = await Promise.all([
    Incident.find({ "context.featureKey": HARNESS_INCIDENT_FEATURE_PATTERN }).select("_id").lean(),
    User.find({ email: HARNESS_USER_EMAIL_PATTERN }).select("_id").lean(),
  ]);

  const incidentIds = incidentDocs.map((doc) => doc._id);
  const supportUserIds = supportUsers.map((doc) => doc._id);
  const conversationDocs = await SupportConversation.find({
    $or: [
      { userId: { $in: supportUserIds } },
      { "metadata.harnessRunKey": HARNESS_RUN_KEY_PATTERN },
    ],
  })
    .select("_id")
    .lean();
  const conversationIds = conversationDocs.map((doc) => doc._id);

  await Promise.all([
    ApprovalTask.deleteMany({ "metadata.harnessRunKey": { $regex: HARNESS_RUN_KEY_PATTERN } }),
    FAQCandidate.deleteMany({ key: HARNESS_RUN_KEY_PATTERN }),
    MarketingDraftPacket.deleteMany({ "metadata.harnessRunKey": { $regex: HARNESS_RUN_KEY_PATTERN } }),
    MarketingBrief.deleteMany({ title: HARNESS_MARKETING_BRIEF_PATTERN }),
    SalesDraftPacket.deleteMany({ "metadata.harnessRunKey": { $regex: HARNESS_RUN_KEY_PATTERN } }),
    SalesAccount.deleteMany({ "metadata.harnessRunKey": { $regex: HARNESS_RUN_KEY_PATTERN } }),
    IncidentApproval.deleteMany({ incidentId: { $in: incidentIds } }),
    Incident.deleteMany({ _id: { $in: incidentIds } }),
    LpcAction.deleteMany({ dedupeKey: HARNESS_ACTION_DEDUPE_PATTERN }),
    SupportMessage.deleteMany({
      $or: [
        { conversationId: { $in: conversationIds } },
        { "metadata.harnessRunKey": { $regex: HARNESS_RUN_KEY_PATTERN } },
      ],
    }),
    SupportTicket.deleteMany({
      $or: [
        { conversationId: { $in: conversationIds } },
        { subject: HARNESS_SUPPORT_SUBJECT_PATTERN },
      ],
    }),
    SupportConversation.deleteMany({
      $or: [
        { _id: { $in: conversationIds } },
        { "metadata.harnessRunKey": { $regex: HARNESS_RUN_KEY_PATTERN } },
      ],
    }),
    User.deleteMany({ email: HARNESS_USER_EMAIL_PATTERN }),
  ]);
}

async function createSupportUser({ runKey }) {
  const nameKey = runKey.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return User.create({
    firstName: "Avery",
    lastName: `Support ${nameKey.slice(-8)}`,
    email: buildHarnessEmail(`support.${nameKey}`),
    password: SUPPORT_USER_PASSWORD,
    role: "attorney",
    status: "approved",
    approvedAt: new Date(),
    emailVerified: true,
    termsAccepted: true,
    state: "CA",
    location: "California",
  });
}

async function createAdmissionsApplicant({ runKey }) {
  return User.create({
    firstName: "Adriana",
    lastName: "Lane",
    email: buildHarnessEmail(`admissions.${runKey}`),
    password: APPLICANT_PASSWORD,
    role: "attorney",
    status: "pending",
    emailVerified: true,
    termsAccepted: true,
    barNumber: `BAR-${runKey.slice(-8).toUpperCase()}`,
    lawFirm: "Lane Legal Group",
    state: "CA",
    location: "California",
  });
}

async function seedCcoDecision({ runKey, admin, now }) {
  const candidate = await FAQCandidate.create({
    key: `${runKey}-faq`,
    title: `Control Room FAQ review ${runKey}`,
    question: `How should support answer the ${runKey} account question?`,
    draftAnswer: `Use the governed support answer for ${runKey}.`,
    summary: `Founder approval is needed before this FAQ language can enter governed support use for ${runKey}.`,
    approvalState: "pending_review",
    patternKey: `${runKey}-faq-pattern`,
    category: "platform_explainer",
    repeatCount: 3,
    ownerLabel: "Samantha",
    latestEvidenceAt: now,
  });

  const task = await ApprovalTask.create({
    taskType: "support_review",
    targetType: "faq_candidate",
    targetId: String(candidate._id),
    parentType: "FAQCandidate",
    parentId: String(candidate._id),
    title: `Review FAQ candidate: Control Room FAQ review ${runKey}`,
    summary: candidate.summary,
    approvalState: "pending",
    requestedBy: buildActor(admin),
    assignedOwnerLabel: "Samantha",
    metadata: {
      harnessRunKey: runKey,
      lane: "cco",
    },
  });

  await Promise.all([
    stampDocument(FAQCandidate, candidate._id, new Date(now.getTime() + 10_000)),
    stampDocument(ApprovalTask, task._id, new Date(now.getTime() + 10_000)),
  ]);

  return {
    candidateId: String(candidate._id),
    workKey: `faq_candidate:${candidate._id}`,
    title: "Use this support answer",
  };
}

async function seedCmoDecision({ runKey, admin, now, count = 1 }) {
  const results = [];

  for (let index = 1; index <= count; index += 1) {
    const suffix = count > 1 ? ` ${index}` : "";
    const brief = await MarketingBrief.create({
      workflowType: "linkedin_company_post",
      channelKey: "linkedin_company",
      title: `Control Room marketing brief ${runKey}${suffix}`,
      briefSummary: `Draft a founder-reviewed LinkedIn company post for ${runKey}${suffix}.`,
      targetAudience: "Attorneys considering platform adoption",
      objective: "Explain current platform momentum without over-claiming.",
      contentLane: "updates_momentum",
      updateFacts: [`Harness fact for ${runKey}${suffix}`],
      ctaPreference: "Invite readers to learn more about the platform.",
      requestedBy: buildActor(admin),
      approvalState: "draft",
    });

    const packet = await MarketingDraftPacket.create({
      briefId: brief._id,
      workflowType: "linkedin_company_post",
      channelKey: "linkedin_company",
      packetVersion: index,
      approvalState: "pending_review",
      briefSummary: brief.briefSummary,
      targetAudience: brief.targetAudience,
      contentLane: brief.contentLane,
      growthObjective: "Keep the company feed fresh and credible.",
      whyThisHelpsPageGrowth: "This post grounds platform momentum in a concrete internal update.",
      messageHierarchy: [`Lead with the founder-approved update for ${runKey}${suffix}.`],
      claimsToAvoid: ["Do not imply guaranteed outcomes."],
      channelDraft: {
        headline: `Founder review post ${runKey}${suffix}`,
        body: `This is the public-facing draft for ${runKey}${suffix}.`,
      },
      whatStillNeedsSamantha: ["Approve or reject the final public-facing post."],
      generatedBy: { actorType: "system", label: "Marketing Draft Service" },
      packetSummary: `Founder approval is needed before the ${runKey}${suffix} marketing draft can move into outbound use.`,
      metadata: {
        harnessRunKey: runKey,
      },
    });

    const task = await ApprovalTask.create({
      taskType: "marketing_review",
      targetType: "marketing_draft_packet",
      targetId: String(packet._id),
      parentType: "MarketingBrief",
      parentId: String(brief._id),
      title: `Review marketing packet: ${runKey}${suffix}`,
      summary: packet.packetSummary,
      approvalState: "pending",
      requestedBy: buildActor(admin),
      assignedOwnerLabel: "Samantha",
      metadata: {
        harnessRunKey: runKey,
        lane: "cmo",
      },
    });

    results.push({
      brief,
      packet,
      task,
    });
  }

  const stampAt = new Date(now.getTime() + 20_000);
  await Promise.all(
    results.flatMap(({ brief, packet, task }) => [
      stampDocument(MarketingBrief, brief._id, stampAt),
      stampDocument(MarketingDraftPacket, packet._id, stampAt),
      stampDocument(ApprovalTask, task._id, stampAt),
    ])
  );

  const first = results[0];
  return {
    briefId: first ? String(first.brief._id) : "",
    packetId: first ? String(first.packet._id) : "",
    workKey: first ? `marketing_draft_packet:${first.packet._id}` : "",
    workKeys: results.map(({ packet }) => `marketing_draft_packet:${packet._id}`),
    count,
    title: count > 1 ? `${count} posts ready to publish` : "Publish LinkedIn post",
    packetSummary: first?.packet?.packetSummary || "",
  };
}

async function seedCsoDecision({ runKey, admin, now }) {
  const account = await SalesAccount.create({
    name: `Control Room sales account ${runKey}`,
    companyName: "Founders Advisory LLP",
    primaryEmail: buildHarnessEmail(`sales.${runKey}`),
    audienceType: "firm",
    roleLabel: "Managing partner",
    status: "active",
    sourceType: "manual",
    sourceFingerprint: `${runKey}-sales-account`,
    accountSummary: `Founder-visible sales account memory for ${runKey}.`,
    metadata: {
      harnessRunKey: runKey,
    },
  });

  const packet = await SalesDraftPacket.create({
    accountId: account._id,
    packetType: "outreach_draft",
    packetVersion: 1,
    approvalState: "pending_review",
    accountSummary: account.accountSummary,
    audienceSummary: "A law firm partner evaluating the platform.",
    approvedPositioningBlocks: [{ label: "Founder-approved positioning" }],
    whatStillNeedsSamantha: ["Approve or reject the outbound draft before external use."],
    recommendedNextStep: "Decide whether the outbound draft can enter governed outreach.",
    channelDraft: {
      subject: `Founder review outreach ${runKey}`,
      body: `This outbound draft is waiting on founder approval for ${runKey}.`,
    },
    packetSummary: `Founder approval is needed before the ${runKey} outreach draft can be used externally.`,
    generatedBy: { actorType: "system", label: "Sales Draft Service" },
    metadata: {
      harnessRunKey: runKey,
    },
  });

  const task = await ApprovalTask.create({
    taskType: "sales_review",
    targetType: "sales_draft_packet",
    targetId: String(packet._id),
    parentType: "SalesAccount",
    parentId: String(account._id),
    title: `Review sales packet: ${runKey}`,
    summary: packet.packetSummary,
    approvalState: "pending",
    requestedBy: buildActor(admin),
    assignedOwnerLabel: "Samantha",
    metadata: {
      harnessRunKey: runKey,
      lane: "cso",
    },
  });

  const stampAt = new Date(now.getTime() + 30_000);
  await Promise.all([
    stampDocument(SalesAccount, account._id, stampAt),
    stampDocument(SalesDraftPacket, packet._id, stampAt),
    stampDocument(ApprovalTask, task._id, stampAt),
  ]);

  return {
    accountId: String(account._id),
    packetId: String(packet._id),
    workKey: `sales_draft_packet:${packet._id}`,
    title: "Send outreach message",
    packetSummary: packet.packetSummary,
  };
}

async function seedCtoDecision({ runKey, now }) {
  const incident = await Incident.create({
    publicId: `INC-${runKey.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 18)}`,
    source: "admin_created",
    summary: `Control Room release decision for ${runKey}`,
    originalReportText: `A founder approval decision is required for the ${runKey} engineering release path.`,
    state: "awaiting_founder_approval",
    approvalState: "pending",
    autonomyMode: "approval_required",
    userVisibleStatus: "awaiting_internal_review",
    adminVisibleStatus: "awaiting_approval",
    classification: {
      domain: "ui",
      severity: "medium",
      riskLevel: "medium",
      confidence: "high",
      issueFingerprint: `${runKey}-incident`,
      clusterKey: `${runKey}-cluster`,
      riskFlags: {},
      suspectedRoutes: ["/admin-dashboard.html#section-ai-control-room"],
      suspectedFiles: ["frontend/assets/scripts/admin-dashboard.js"],
    },
    context: {
      surface: "admin",
      routePath: "/admin-dashboard.html",
      featureKey: `control-room-e2e-${runKey}`,
    },
    orchestration: {
      nextJobType: "none",
      nextJobRunAt: now,
      stageAttempts: {},
      lockToken: "",
      lockOwner: "",
      lockExpiresAt: null,
      lastWorkerAt: null,
    },
  });

  const approval = await IncidentApproval.create({
    incidentId: incident._id,
    attemptNumber: 1,
    approvalType: "production_deploy",
    status: "pending",
    requiredByPolicy: true,
    requestedAt: now,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  });

  incident.currentApprovalId = approval._id;
  await incident.save();

  const stampAt = new Date(now.getTime() + 40_000);
  await Promise.all([
    stampDocument(IncidentApproval, approval._id, stampAt),
    stampDocument(Incident, incident._id, stampAt),
  ]);

  return {
    incidentId: String(incident._id),
    incidentPublicId: incident.publicId,
    approvalId: String(approval._id),
    title: "Approve engineering fix for incident",
  };
}

async function seedCaoDecision({ runKey }) {
  const applicant = await createAdmissionsApplicant({ runKey });
  await stampDocument(User, applicant._id, new Date(Date.now() + 45_000));
  return {
    userId: String(applicant._id),
    title: "Approve applicant for admissions",
    email: applicant.email,
  };
}

async function seedAutonomousSupportItem({ runKey, admin, now }) {
  const user = await createSupportUser({ runKey });
  const conversation = await SupportConversation.create({
    userId: user._id,
    role: user.role,
    status: "open",
    sourceSurface: "attorney",
    sourcePage: "/help.html",
    pageContext: {
      pathname: "/help.html",
      viewName: "help",
    },
    lastMessageAt: now,
    lastCategory: "general_support",
    metadata: {
      harnessRunKey: runKey,
      source: "control_room_e2e",
    },
  });

  await SupportMessage.create({
    conversationId: conversation._id,
    sender: "user",
    text: `The issue is still broken for ${runKey}.`,
    sourcePage: "/help.html",
    pageContext: {
      pathname: "/help.html",
      viewName: "help",
    },
    metadata: {
      harnessRunKey: runKey,
      kind: "user_message",
    },
  });

  const ticket = await SupportTicket.create({
    subject: `Control Room autonomous reopen ${runKey}`,
    message: `Resolved support issue reopened for ${runKey}.`,
    status: "open",
    urgency: "medium",
    requesterRole: user.role,
    sourceSurface: "attorney",
    sourceLabel: "Control Room e2e harness",
    userId: user._id,
    requesterUserId: user._id,
    requesterEmail: user.email,
    conversationId: conversation._id,
    routePath: "/help.html",
    latestUserMessage: `It's still broken for ${runKey}.`,
    assistantSummary: `The customer clearly said the ${runKey} issue is still broken.`,
    supportFactsSnapshot: {
      harnessRunKey: runKey,
    },
    classification: {
      category: "general_support",
      confidence: "high",
      patternKey: `${runKey}-autonomous`,
      matchedKnowledgeKeys: [],
    },
    routingSuggestion: {
      ownerKey: "support_ops",
      priority: "normal",
      queueLabel: "Support Ops",
      reason: "Harness auto-handled support action.",
    },
    resolutionSummary: "The prior ticket had been marked resolved.",
    resolutionIsStable: true,
    resolvedAt: new Date(now.getTime() - 30 * 60 * 1000),
  });

  const action = await logAction({
    agentRole: "CCO",
    actionType: "ticket_reopened",
    confidenceScore: 0.93,
    confidenceReason: `The customer explicitly said the ${runKey} issue was still broken and the ticket moved safely back into the active queue.`,
    targetModel: "SupportTicket",
    targetId: ticket._id,
    changedFields: {
      status: "open",
      resolutionIsStable: false,
      resolvedAt: null,
    },
    previousValues: {
      status: "resolved",
      resolutionIsStable: true,
      resolvedAt: ticket.resolvedAt,
    },
    actionTaken: `Support reopened the ${runKey} ticket automatically after the customer clearly said the issue was still broken.`,
    safetyContext: {
      involvesPayment: false,
      involvesPayout: false,
      involvesBillingPromise: false,
      legalOrDisputeContext: false,
    },
  });

  await Promise.all([
    stampDocument(SupportConversation, conversation._id, new Date(now.getTime() + 50_000)),
    stampDocument(SupportTicket, ticket._id, new Date(now.getTime() + 50_000)),
    stampDocument(AutonomousAction, action._id, new Date(now.getTime() + 50_000), {
      createdAt: true,
      updatedAt: false,
    }),
  ]);

  return {
    ticketId: String(ticket._id),
    actionId: String(action._id),
    title: "Support reopened a ticket automatically",
    actionType: action.actionType,
  };
}

async function seedOperationalInfoItem({ runKey, now }) {
  const action = await LpcAction.create({
    actionType: "founder_alert",
    status: "open",
    dedupeKey: `control-room-e2e:${runKey}:info-alert`,
    ownerLabel: "Samantha",
    title: `Control Room informational alert ${runKey}`,
    summary: `A non-blocking operational note is visible for ${runKey}.`,
    recommendedAction: "Open the source workflow if you want to inspect this informational note.",
    priority: "high",
    subject: {
      entityType: "control_room",
      entityId: runKey,
      publicId: runKey,
    },
    firstSeenAt: now,
    lastSeenAt: now,
    dueAt: now,
    openedBy: {
      actorType: "system",
      label: "Control Room e2e harness",
    },
    metadata: {
      harnessRunKey: runKey,
    },
  });

  await stampDocument(LpcAction, action._id, new Date(now.getTime() + 60_000));

  return {
    actionId: String(action._id),
    title: action.title,
  };
}

function describeExpectedUi({ seeded = {} } = {}) {
  return {
    decisionTitles: {
      cco: seeded.ccoDecision?.title || "",
      cmo: seeded.cmoDecision?.title || "",
      cso: seeded.csoDecision?.title || "",
      cto: seeded.ctoDecision?.title || "",
      cao: seeded.caoDecision?.title || "",
    },
    blockedTitles: {
      cco: "Support language is blocked waiting on your decision",
      cmo: "Marketing drafts are blocked waiting on your approval",
      cso: "Sales drafts are blocked waiting on your approval",
      cto: "Engineering release work is blocked waiting on your approval",
      cao: "Admissions review is blocked waiting on your decision",
    },
    autonomousTitle: seeded.autonomousItem?.title || "",
    infoMarker: seeded.infoItem?.title || "",
    cfoLaneTitle: "CFO",
  };
}

async function seedControlRoomFixtureSet({ adminUser = {}, decisionCounts = {} } = {}) {
  assertControlRoomE2eHarnessEnabled();
  await cleanupHarnessFixtures();
  const now = new Date();
  const runKey = createRunKey();
  const admin = adminUser?._id ? adminUser : (await upsertHarnessAdmin()).admin;
  const cmoCount = Math.max(1, Number.parseInt(decisionCounts?.cmo, 10) || 1);

  const [ccoDecision, cmoDecision, csoDecision, ctoDecision, caoDecision, autonomousItem, infoItem] =
    await Promise.all([
      seedCcoDecision({ runKey, admin, now }),
      seedCmoDecision({ runKey, admin, now, count: cmoCount }),
      seedCsoDecision({ runKey, admin, now }),
      seedCtoDecision({ runKey, now }),
      seedCaoDecision({ runKey }),
      seedAutonomousSupportItem({ runKey, admin, now }),
      seedOperationalInfoItem({ runKey, now }),
    ]);

  const seeded = {
    runKey,
    ccoDecision,
    cmoDecision,
    csoDecision,
    ctoDecision,
    caoDecision,
    autonomousItem,
    infoItem,
  };

  return {
    runKey,
    seeded,
    expectedUi: describeExpectedUi({ seeded }),
  };
}

module.exports = {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  resolveAdminCredentials,
  resolveSupportAttorneyCredentials,
  seedControlRoomFixtureSet,
  upsertHarnessAdmin,
  upsertHarnessSupportAttorney,
};
