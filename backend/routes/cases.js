const presignedUploads = require("../services/matterPresignedUploads");
const matterRetirement = require("../services/matterStorageRetirement"), fileRemoval = require("../services/attorneyMatterFileRemoval");
const matterFileWrites = require("../services/matterFileWrites");
const attorneyCompletion = require("../services/attorneyCompletion");
const attorneyWithdrawal = require("../services/attorneyWithdrawal");
const completionPayoutEvidence = require("../services/completionPayoutEvidence");
const matterExports = require("../services/matterExports");
const { createReadStream: createExportReadStream } = require("fs");
const { pipeline: exportPipeline } = require("stream/promises");
const { projectRevisionResolutions } = require("../utils/revisionResolution");
// backend/routes/cases.js
const router = require("express").Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const multer = require("multer");
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole, requireCaseAccess } = require("../utils/authz");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const { createS3Client } = require("../utils/s3Client");
const { createLogger, logPromiseFailure } = require("../utils/logger");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const Case = require("../models/Case");
const matterModeration = require("../services/matterModeration");
const postingNotices = require("../services/matterPostingNotifications");
const matterNotes = require("../services/matterNotes");
const Job = require("../models/Job");
const Application = require("../models/Application");
const createApplicationForJob = require("./applications").createApplicationForJob;
const { captureResumeReference } = require("../utils/resumeReferenceWrite");
const CaseFile = require("../models/CaseFile");
const User = require("../models/User");
const withdrawalNotices = require("../services/matterWithdrawalNotifications");
const { withActiveAccountWrite, lockActiveAccounts } = require("../utils/activeAccountWrite");
const { deletePostingRecords } = require("../services/matterDeletion");
const PaymentOperation = require("../models/PaymentOperation");
const logger = createLogger("cases");
const { notifyUser } = require("../utils/notifyUser");
const reviewNotices = require("../services/matterReviewNotifications");
const { reportOperationalFailure } = require("../utils/operationalFailure");
const stripe = require("../utils/stripe");
const { cleanText, cleanTitle, cleanMessage, cleanPlainText } = require("../utils/sanitize");
const { logAction } = require("../utils/audit");
const AuditLog = require("../models/AuditLog");
const { generateArchiveZip, buildReceiptPdfBuffer, uploadPdfToS3, getReceiptKey } = require("../services/caseLifecycle");
const { shapeParalegalSnapshot } = require("../utils/profileSnapshots");
const legacyApplications = require("../services/legacyApplicationProjections");
const { refs: applicationRefs } = require("../services/applicationIdentity");
const { PENDING_STATUSES: pendingApplicationStatuses } = require("../services/accountApplicationProjections");
const { parseMinimumYears } = require("../services/experienceRequirement");
const { buildAuthenticatedProfilePhotoUrl } = require("../services/profilePhotoDelivery");
const { currentStripeMode, pickStripeMode, stripeModeFromLivemode } = require("../utils/stripeMode");
const { validatePaymentIntentForCase } = require("../utils/paymentIntegrity");
const {
  claimPaymentOperation,
  failPaymentOperation,
  recordPaymentOperationEvidence,
  succeedPaymentOperation,
} = require("../services/paymentOperationService");
const {
  upsertPayoutLedger,
  upsertPlatformIncomeLedger,
  withPayoutTransaction,
} = require("../services/paymentLedgerService");
const {
} = require("../services/applicationService");
const {
  respondToInvitation,
  revokeAcceptedInvitation,
  sendInvitation,
} = require("../services/invitationService");
const {
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
  DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
} = require("../services/platformFeePolicy");
const {
  BLOCKED_MESSAGE,
  buildBlockLookup,
  getBlockedUserIds,
  getBlocksForUser,
  getCaseInteractionBlockStatus,
  isBlockedBetween,
  normalizeId,
} = require("../utils/blocks");
const { addSubscriber, publishCaseEvent } = require("../utils/caseEvents");
const { publishMatterDiscoveryEvent } = require("../utils/matterDiscoveryEvents");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const {
  SEARCH_QUERY_MIN,
  SEARCH_QUERY_MAX,
  normalizeSearchQuery,
  parseSearchTypes,
  validateSearchRead,
  presentMatterContext,
  searchAuthorizedObjects,
} = require("../services/authenticatedSearch");
const { createAuthenticatedSearchRateLimiter } = require("../services/authenticatedSearchRateLimit");
const { buildMatterExperience } = require("../services/matterExperience");
const { buildObjectDeepLink } = require("../services/objectDeepLinks");
const {
  ATTORNEY_WORKFLOW_STAGES,
  calculateArchivePurgeAt,
  MIN_MATTER_AMOUNT_CENTS,
  WITHDRAWAL_REVIEW_WINDOW_MS,
  evaluateCompletionEligibility,
  evaluateHiringEligibility,
  evaluateInvitationEligibility,
  evaluateMatterPosting,
  evaluatePreEngagementRequest,
  evaluateTerminationEligibility,
  isAttorneyPaymentMethodRequired,
} = require("../services/attorneyWorkflowPolicy");
const {
  evaluateInvitationEligibility: evaluateParalegalInvitationAcceptance,
  evaluatePreEngagementSubmission,
  evaluateWithdrawalEligibility,
  hasPredecessorWithdrawalSettlement,
  currentAssignmentScopeProgress,
} = require("../services/paralegalWorkflowPolicy");
const {
  decryptCaseFilePayload,
  decryptString,
  buildCaseFileNameQuery,
  buildCaseFileKeyQuery,
} = require("../utils/dataEncryption");
const { createDevOnlyEmailSet } = require("../utils/devOnlyEmailSet");
const { buildFundingFingerprint, ensureFundingRequestKey } = require("../utils/funding");
const { reconcileFundingEvidence } = require("../services/fundingEvidenceBackfillService");
const { createPayoutTransfer } = require("../services/payoutHoldService");
const {
  assertObjectMalwareSafe,
  getObjectMalwareScan,
  malwareScanRequired,
  validateMatterFileBuffer,
  validateStoredMatterFile,
} = require("../utils/fileSecurity");
const {
  parseMatterDeadline,
  resolveMatterDeadlineDate,
} = require("../utils/businessDate");
const {
  ensureCaseJobOpen,
  finalizeExpiredDisputeWindow,
  generateWithdrawalReceipts,
} = require("../services/withdrawalLifecycle");
const {
  applyAssignmentVisibility,
  isRecordVisibleToCurrentAssignment,
  resolveCurrentParalegalAssignmentBoundary,
} = require("../utils/matterAssignmentVisibility");

const STRIPE_BYPASS_PARALEGAL_EMAILS = createDevOnlyEmailSet([
  "samanthasider+11@gmail.com",
  "samanthasider+paralegal@gmail.com",
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);
const STRIPE_BYPASS_ATTORNEY_EMAILS = createDevOnlyEmailSet([
  "game4funwithme1+1@gmail.com",
  "game4funwithme1@gmail.com",
]);

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const FILE_STATUS = ["pending_review", "approved", "attorney_revision"];
const PRE_ENGAGEMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MIN_CASE_AMOUNT_CENTS = MIN_MATTER_AMOUNT_CENTS;
const MIN_CASE_AMOUNT_MESSAGE = "Budget must be at least $400.";
const DISPUTE_WINDOW_MS = WITHDRAWAL_REVIEW_WINDOW_MS;
const PRACTICE_AREAS = [
  "administrative law",
  "antitrust law",
  "bankruptcy",
  "business law",
  "civil litigation",
  "commercial litigation",
  "contract law",
  "corporate law",
  "criminal defense",
  "employment law",
  "estate planning",
  "trusts & estates",
  "family law",
  "immigration",
  "intellectual property",
  "labor law",
  "personal injury",
  "real estate",
  "tax law",
  "technology",
];

async function claimCaseHire(reviewedCase, paralegalId, strictReview = null, req = null) {
  return withActiveAccountWrite([req?.user?.id, reviewedCase.attorney, reviewedCase.attorneyId, paralegalId], async session => {
  const caseId = reviewedCase._id;
  // Application decisions increment the Matter version in their transaction.
  // Bind the claim to the Matter examined before payment-method lookup so a
  // decision committed during that lookup cannot be overwritten by this hire.
  const reviewedVersion = reviewedCase.get("__v") ?? 0;
  const versionClause = reviewedVersion === 0
    ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] }
    : { __v: reviewedVersion };
  const token = crypto.randomUUID();
  const claimedAt = new Date();
  if (strictReview) {
    const raw = await Case.collection.findOneAndUpdate(strictReview.filter, { $set: {
      hiringClaimToken: token, hiringClaimParalegalId: new mongoose.Types.ObjectId(paralegalId), hiringClaimedAt: claimedAt, hiringClaimStatus: "claimed",
      hiringClaimPaymentIntentId: strictReview.dto.canResume ? strictReview.facts.hiringClaimPaymentIntentId : "",
      hiringClaimAmount: strictReview.dto.canResume ? strictReview.facts.hiringClaimAmount : 0, hiringClaimError: "", updatedAt: claimedAt,
    }, $inc: { __v: 1 } }, { returnDocument: "after", session });
    return { acquired: !!raw, caseDoc: raw ? Case.hydrate(raw) : null, replacementSource: raw, token, claimedAt };
  }
  let caseDoc = await Case.findOneAndUpdate(
    {
      _id: caseId,
      archived: { $ne: true },
      $and: [
        versionClause,
        { $or: [{ paralegal: null }, { paralegal: { $exists: false } }] },
        { $or: [{ paralegalId: null }, { paralegalId: { $exists: false } }] },
        {
          $or: [
            { hiringClaimStatus: null },
            { hiringClaimStatus: { $exists: false } },
          ],
        },
      ],
    },
    {
      $set: {
        hiringClaimToken: token,
        hiringClaimParalegalId: paralegalId,
        hiringClaimedAt: claimedAt,
        hiringClaimStatus: "claimed",
        hiringClaimPaymentIntentId: "",
        hiringClaimAmount: 0,
        hiringClaimError: "",
      },
    },
    { returnDocument: "after", session }
  );
  if (!caseDoc) {
    caseDoc = await Case.findOneAndUpdate(
      {
        _id: caseId,
        archived: { $ne: true },
        $and: [
          versionClause,
          { $or: [{ paralegal: null }, { paralegal: { $exists: false } }] },
          { $or: [{ paralegalId: null }, { paralegalId: { $exists: false } }] },
        ],
        hiringClaimStatus: "needs_reconciliation",
        hiringClaimParalegalId: paralegalId,
        hiringClaimPaymentIntentId: { $nin: [null, ""] },
      },
      {
        $set: {
          hiringClaimToken: token,
          hiringClaimedAt: claimedAt,
          hiringClaimStatus: "claimed",
          hiringClaimError: "",
        },
      },
      { returnDocument: "after", session }
    );
  }
  const replacementSource = caseDoc?.status === "paused" && caseDoc.pausedReason === "paralegal_withdrew"
    ? await Case.collection.findOne({ _id: caseId, hiringClaimToken: token }, { session }) : null;
  return { acquired: Boolean(caseDoc), caseDoc, replacementSource, token, claimedAt };
  }, { ownerId: req?.user?.id, authVersion: req?.auth?.payload?.av });
}

async function recordCaseHirePaymentEvidence(caseId, token, paymentIntent, amount) {
  if (!paymentIntent?.id) return null;
  return Case.updateOne(
    { _id: caseId, hiringClaimToken: token, hiringClaimStatus: "claimed" },
    {
      $set: {
        hiringClaimPaymentIntentId: String(paymentIntent.id),
        hiringClaimAmount: Math.max(0, Math.round(Number(amount) || 0)),
      },
    }
  );
}

async function releaseCaseHireClaim(caseId, token) {
  return Case.updateOne(
    { _id: caseId, hiringClaimToken: token },
    {
      $set: {
        hiringClaimToken: "",
        hiringClaimParalegalId: null,
        hiringClaimedAt: null,
        hiringClaimStatus: null,
        hiringClaimPaymentIntentId: "",
        hiringClaimAmount: 0,
        hiringClaimError: "",
      },
    }
  );
}

async function markCaseHireNeedsReconciliation(caseId, token, err, paymentIntent, amount) {
  return Case.updateOne(
    { _id: caseId, hiringClaimToken: token },
    {
      $set: {
        hiringClaimStatus: "needs_reconciliation",
        hiringClaimPaymentIntentId: String(paymentIntent?.id || ""),
        hiringClaimAmount: Math.max(0, Math.round(Number(amount) || 0)),
        hiringClaimError: String(err?.message || err || "Hire persistence failed").slice(0, 1000),
      },
    }
  );
}

function clearCaseHireClaim(caseDoc) {
  caseDoc.hiringClaimToken = "";
  caseDoc.hiringClaimParalegalId = null;
  caseDoc.hiringClaimedAt = null;
  caseDoc.hiringClaimStatus = null;
  caseDoc.hiringClaimPaymentIntentId = "";
  caseDoc.hiringClaimAmount = 0;
  caseDoc.hiringClaimError = "";
}

async function claimCaseCompletion(caseId, actorId, { isAdmin = false } = {}) {
  const token = crypto.randomUUID();
  const claimedAt = new Date();
  const ownerClause = isAdmin
    ? {}
    : { $or: [{ attorney: actorId }, { attorneyId: actorId }] };
  const caseDoc = await Case.findOneAndUpdate(
    {
      _id: caseId,
      status: { $in: ["in progress", "in_progress"] },
      archived: { $ne: true },
      readOnly: { $ne: true },
      escrowIntentId: { $nin: [null, ""] },
      escrowStatus: "funded",
      tasks: { $elemMatch: { completed: true } },
      $and: [
        { tasks: { $not: { $elemMatch: { completed: { $ne: true } } } } },
        { disputes: { $not: { $elemMatch: { status: "open" } } } },
        { $or: [{ paralegal: { $ne: null } }, { paralegalId: { $ne: null } }] },
        {
          $or: [
            { completionClaimStatus: null },
            { completionClaimStatus: { $exists: false } },
            { completionClaimStatus: "needs_reconciliation" },
            {
              completionClaimStatus: "claimed",
              completionClaimedAt: { $lte: new Date(claimedAt.getTime() - 10 * 60 * 1000) },
            },
          ],
        },
      ],
      ...ownerClause,
    },
    {
      $set: {
        completionClaimToken: token,
        completionClaimedAt: claimedAt,
        completionClaimStatus: "claimed",
        completionClaimTransferId: "",
        completionClaimError: "",
      },
    },
    { returnDocument: "after" }
  );
  return { acquired: Boolean(caseDoc), caseDoc, token, claimedAt };
}

async function recordCaseCompletionTransferEvidence(caseId, token, transferId) {
  if (!transferId) return null;
  const result = await Case.updateOne(
    { _id: caseId, completionClaimToken: token, completionClaimStatus: { $in: ["claimed", "needs_reconciliation"] }, completionClaimTransferId: { $in: ["", null, String(transferId)] } },
    { $set: { completionClaimTransferId: String(transferId) } },
    { writeConcern: { w: "majority" } }
  );
  if (!result.matchedCount) throw new Error("The completion claim changed before its transfer could be recorded.");
  return result;
}

async function releaseCaseCompletionClaim(caseId, token) {
  return Case.updateOne(
    { _id: caseId, completionClaimToken: token },
    {
      $set: {
        completionClaimToken: "",
        completionClaimedAt: null,
        completionClaimStatus: null,
        completionClaimTransferId: "",
        completionClaimError: "",
      },
    }
  );
}

async function markCaseCompletionFailure(caseId, token, err, knownTransferId = "") {
  const operation = await PaymentOperation.findOne({
    operationKey: `case_payout:${String(caseId)}`,
  })
    .select("stripeTransferId stripeObjectId status")
    .lean();
  const transferId = knownTransferId || operation?.stripeTransferId || operation?.stripeObjectId || "";
  const externalOutcomeUncertain = ["pending", "needs_reconciliation"].includes(operation?.status);
  if (!transferId && !externalOutcomeUncertain) {
    return releaseCaseCompletionClaim(caseId, token);
  }
  return Case.updateOne(
    { _id: caseId, completionClaimToken: token },
    {
      $set: {
        completionClaimStatus: "needs_reconciliation",
        completionClaimTransferId: String(transferId),
        completionClaimError: String(err?.message || err || "Completion persistence failed").slice(0, 1000),
      },
    }
  );
}

const PRACTICE_AREA_LOOKUP = PRACTICE_AREAS.reduce((acc, name) => {
  acc[name.toLowerCase()] = name;
  return acc;
}, {});
const preEngagementUpload = multer({
  storage: multer.memoryStorage(),
  // Multipart forms use flat fields; reject oversized numeric bracket indexes.
  limits: { fileSize: PRE_ENGAGEMENT_MAX_FILE_BYTES, fieldArrayIndexLimit: 0 },
});

function preEngagementSseParams() {
  if (process.env.S3_SSE_KMS_KEY_ID) {
    return {
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: process.env.S3_SSE_KMS_KEY_ID,
    };
  }
  return { ServerSideEncryption: "AES256" };
}

function validatePreEngagementUpload(file) {
  validateMatterFileBuffer({
    buffer: file?.buffer,
    mimeType: file?.mimetype,
    filename: file?.originalname || "confidentiality-agreement.pdf",
  });
}

async function assertPreEngagementDocumentsSafe(preEngagement) {
  const documents = [
    preEngagement?.confidentialityDocument,
    preEngagement?.paralegalConfidentialityDocument,
  ].filter((document) => document?.key);
  for (const document of documents) {
    // Security approval is a prerequisite for legal-workflow approval.
    // eslint-disable-next-line no-await-in-loop
    await assertObjectMalwareSafe({ s3, bucket: S3_BUCKET, key: document.key });
  }
}

function normalizeEmail(value) {
  return String(value || "").toLowerCase().trim();
}

function parseBooleanField(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function normalizeUploadedFileName(value = "", fallback = "") {
  const cleaned = String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (cleaned) return cleaned.slice(0, 500);
  return fallback || `pre-engagement-${Date.now()}`;
}

function safeStorageSegment(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildPreEngagementDocumentKey(caseId, filename) {
  const safeName = safeStorageSegment(filename) || `document-${Date.now()}`;
  return `cases/${String(caseId || "")}/pre-engagement/${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeName}`;
}

function buildPreEngagementResponseDocumentKey(caseId, filename) {
  const safeName = safeStorageSegment(filename) || `signed-document-${Date.now()}`;
  return `cases/${String(caseId || "")}/pre-engagement/responses/${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeName}`;
}

function shapePreEngagement(value) {
  if (!value) return null;
  return {
    revision: Math.max(0, Number(value.revision || 0)),
    status: String(value.status || "requested").toLowerCase(),
    requestedParalegalId: value.requestedParalegalId ? String(value.requestedParalegalId) : null,
    confidentialityAgreementRequired: !!value.confidentialityAgreementRequired,
    conflictsCheckRequired: !!value.conflictsCheckRequired,
    conflictsDetails: value.conflictsDetails || "",
    confidentialityDocument: value.confidentialityDocument || null,
    paralegalConfidentialityDocument: value.paralegalConfidentialityDocument || null,
    requestedAt: value.requestedAt || null,
    requestedBy: value.requestedBy ? String(value.requestedBy) : null,
    confidentialityAcknowledged: !!value.confidentialityAcknowledged,
    confidentialityAcknowledgedAt: value.confidentialityAcknowledgedAt || null,
    confidentialityAcknowledgedBy: value.confidentialityAcknowledgedBy
      ? String(value.confidentialityAcknowledgedBy)
      : null,
    conflictsResponseType: value.conflictsResponseType || "",
    conflictsDisclosureText: value.conflictsDisclosureText || "",
    submittedAt: value.submittedAt || null,
    submittedBy: value.submittedBy ? String(value.submittedBy) : null,
    reviewedAt: value.reviewedAt || null,
    reviewedBy: value.reviewedBy ? String(value.reviewedBy) : null,
  };
}

function preEngagementRevisionClause(preEngagement) {
  const revision = Math.max(0, Number(preEngagement?.revision || 0));
  if (revision > 0) return { "preEngagement.revision": revision };
  return {
    $or: [
      { "preEngagement.revision": 0 },
      { "preEngagement.revision": { $exists: false } },
    ],
  };
}

async function deletePreEngagementObject(key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey || !S3_BUCKET) return;
  await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: normalizedKey }));
}

async function findPreEngagementApplicationId(caseId, paralegalId) {
  if (!isObjId(caseId) || !isObjId(paralegalId)) return "";
  const jobs = await Job.find({ caseId }).select("_id").lean();
  const jobIds = jobs.map((job) => job?._id).filter(Boolean);
  if (!jobIds.length) return "";
  const application = await Application.findOne({
    jobId: { $in: jobIds },
    paralegalId,
    status: { $ne: "withdrawn" },
  })
    .select("_id")
    .lean();
  return application?._id ? String(application._id) : "";
}

async function hasActiveCaseCandidate(caseDoc, paralegalId) {
  if (!caseDoc?._id || !isObjId(paralegalId)) return false;
  let jobId = resolveCaseJobId(caseDoc);
  if (!jobId) {
    const jobs = await Job.collection.find({ caseId: { $in: [caseDoc._id, String(caseDoc._id)] } }, { projection: { _id: 1 } }).limit(2).toArray();
    if (jobs.length > 1) return false;
    jobId = jobs[0]?._id || null;
  }
  if (jobId && !isObjId(String(jobId))) return false;
  const refs = applicationRefs;
  const [canonical, candidateCase] = await Promise.all([
    jobId ? Application.collection.find({ jobId: { $in: refs(jobId) }, paralegalId: { $in: refs(paralegalId) } }, { projection: { status: 1 } }).limit(2).toArray() : [],
    Case.collection.findOne({ _id: caseDoc._id }, { projection: { applicants: 1, invites: 1, withdrawnApplicantIds: 1 } }),
  ]);
  if (!candidateCase) return false;
  const activeStatuses = ["pending", "submitted", "viewed", "shortlisted", "accepted"];
  const embeddedCandidate = candidateCase.applicants?.some(entry => String(entry.paralegalId) === String(paralegalId) && activeStatuses.includes(entry.status));
  const acceptedInvite = candidateCase.invites?.some(entry => String(entry.paralegalId) === String(paralegalId) && entry.status === "accepted");
  const withdrawn = candidateCase.withdrawnApplicantIds?.some(ref => String(ref) === String(paralegalId));
  if (canonical.length > 1) return false;
  // Earlier canonical-only applications remain valid; a removed mirror cannot revive one mid-withdrawal.
  if (canonical.length) return (embeddedCandidate || !withdrawn) && ["submitted", "viewed", "shortlisted", "accepted"].includes(String(canonical[0].status || "").toLowerCase());
  return Boolean(embeddedCandidate || acceptedInvite);
}

async function resolveFundingIdempotencyKey(
  caseDoc,
  amount,
  { mode, forceNew = false, targetId = "" } = {}
) {
  const fingerprint = buildFundingFingerprint({
    caseId: caseDoc?._id,
    amount,
    currency: caseDoc?.currency || "usd",
    mode,
    targetId,
  });
  return ensureFundingRequestKey(caseDoc?._id, fingerprint, { forceNew });
}

function isStripeBypassPair(req, caseDoc, paralegal) {
  const paralegalEmail = normalizeEmail(paralegal?.email || caseDoc?.paralegal?.email);
  const attorneyEmail = normalizeEmail(caseDoc?.attorney?.email || req?.user?.email);
  return (
    STRIPE_BYPASS_PARALEGAL_EMAILS.has(paralegalEmail) &&
    STRIPE_BYPASS_ATTORNEY_EMAILS.has(attorneyEmail)
  );
}

async function ensureBypassConnectAccount(paralegal) {
  if (!paralegal || paralegal.stripeAccountId) return;
  if (!paralegal.email) return;
  const account = await stripe.accounts.create(
    {
      type: "express",
      country: process.env.STRIPE_CONNECT_COUNTRY || "US",
      email: paralegal.email,
      business_type: "individual",
      capabilities: { transfers: { requested: true } },
      metadata: { userId: String(paralegal._id || "") },
    },
    { idempotencyKey: stripe.stripeIdempotencyKey("connect_account", paralegal._id) }
  );
  paralegal.stripeAccountId = account.id;
  paralegal.stripeOnboarded = false;
  paralegal.stripeChargesEnabled = false;
  paralegal.stripePayoutsEnabled = false;
  await paralegal.save();
}
const IN_PROGRESS_STATUS = "in progress";
const LEGACY_IN_PROGRESS_STATUS = "in_progress";
const PLATFORM_FEE_ATTORNEY_PERCENT = DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT;
const PLATFORM_FEE_PARALEGAL_PERCENT = DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;

const S3_BUCKET = process.env.S3_BUCKET || "";
const s3 = createS3Client();
if (!S3_BUCKET) {
  logger.warn("[cases] S3_BUCKET not set; signed file downloads will fail.");
}

function cleanString(value, { len = 400 } = {}) {
  if (!value || typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, len);
}

const MAX_SCOPE_TASKS = 25;
const MAX_SCOPE_TASK_TITLE = 200;

function normalizeTaskCompletion(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return false;
}

function normalizeTaskTitle(value) {
  return cleanString(String(value || ""), { len: MAX_SCOPE_TASK_TITLE });
}

function normalizeScopeTasks(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const item of value) {
    const rawTitle = typeof item === "string" ? item : item?.title;
    const title = normalizeTaskTitle(rawTitle);
    if (!title) continue;
    const completed = normalizeTaskCompletion(
      typeof item === "object" ? item?.completed ?? item?.done ?? item?.isCompleted : false
    );
    normalized.push({ title, completed });
    if (normalized.length >= MAX_SCOPE_TASKS) break;
  }
  return normalized;
}

function hasScopeTasks(caseDoc) {
  if (!caseDoc) return false;
  const list = Array.isArray(caseDoc.tasks) ? caseDoc.tasks : [];
  return list.some((task) => {
    const title = typeof task === "string" ? task : task?.title;
    return Boolean(String(title || "").trim());
  });
}

function areAllScopeTasksComplete(caseDoc) {
  if (!caseDoc) return false;
  const list = Array.isArray(caseDoc.tasks) ? caseDoc.tasks : [];
  if (!list.length) return false;
  return list.every((task) => {
    if (!task) return false;
    const completed = normalizeTaskCompletion(
      typeof task === "object" ? task?.completed ?? task?.done ?? task?.isCompleted : false
    );
    return completed;
  });
}

function countCompletedScopeTasks(caseDoc) {
  return currentAssignmentScopeProgress(caseDoc || {}).completedTaskCount;
}

function serializeScopeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((task) => {
      if (typeof task === "string") {
        const title = normalizeTaskTitle(task);
        return title ? { title, completed: false } : null;
      }
      const title = normalizeTaskTitle(task?.title || "");
      const completed = normalizeTaskCompletion(task?.completed ?? task?.done ?? task?.isCompleted);
      return title ? { title, completed } : null;
    })
    .filter(Boolean);
}

function scopeTaskTitleKey(task) {
  if (!task) return "";
  const rawTitle = typeof task === "string" ? task : task?.title;
  return normalizeTaskTitle(rawTitle).toLowerCase();
}

function isCompletionOnlyTaskUpdate(existingTasks, incomingTasks) {
  if (!Array.isArray(existingTasks) || !Array.isArray(incomingTasks)) return false;
  if (existingTasks.length !== incomingTasks.length) return false;
  for (let index = 0; index < existingTasks.length; index += 1) {
    const existingTitle = scopeTaskTitleKey(existingTasks[index]);
    const incomingTitle = scopeTaskTitleKey(incomingTasks[index]);
    if (!existingTitle || existingTitle !== incomingTitle) return false;
  }
  return true;
}

function hasCompletedTaskReversal(existingTasks, incomingTasks) {
  if (!Array.isArray(existingTasks) || !Array.isArray(incomingTasks)) return false;
  const count = Math.min(existingTasks.length, incomingTasks.length);
  for (let index = 0; index < count; index += 1) {
    const wasCompleted = normalizeTaskCompletion(
      existingTasks[index]?.completed ?? existingTasks[index]?.done ?? existingTasks[index]?.isCompleted
    );
    const nextCompleted = normalizeTaskCompletion(
      incomingTasks[index]?.completed ?? incomingTasks[index]?.done ?? incomingTasks[index]?.isCompleted
    );
    if (wasCompleted && !nextCompleted) return true;
  }
  return false;
}

function mergeTaskCompletion(existingTasks, incomingTasks) {
  if (!Array.isArray(existingTasks)) return [];
  return existingTasks.map((task, index) => {
    const incoming = incomingTasks[index] || {};
    const completed = normalizeTaskCompletion(
      incoming?.completed ?? incoming?.done ?? incoming?.isCompleted
    );
    if (typeof task === "string") {
      const title = normalizeTaskTitle(task);
      return { title, completed };
    }
    return {
      title: normalizeTaskTitle(task?.title || ""),
      completed,
      createdAt: task?.createdAt,
    };
  });
}

const DOLLARS_RX = /[^0-9.\-]/g;
function dollarsToCents(input) {
  if (input === null || typeof input === "undefined") return null;
  const value =
    typeof input === "number"
      ? input
      : parseFloat(String(input).replace(DOLLARS_RX, ""));
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.max(0, Math.round(value * 100));
}

function parseListField(value) {
  if (!value && value !== 0) return [];
  const source = Array.isArray(value)
    ? value
    : String(value)
        .split(/\r?\n|,/)
        .map((entry) => entry.trim());
  return source
    .map((entry) => cleanString(entry, { len: 500 }))
    .filter(Boolean);
}

function formatCurrency(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents) || cents <= 0) return "$0.00";
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildPersonDisplay(user, fallback) {
  const name = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
  if (name) return name;
  return fallback || "";
}

async function resolvePaymentMethodLabel(caseDoc) {
  const intentId = caseDoc?.paymentIntentId || caseDoc?.escrowIntentId;
  if (!intentId || !stripe?.paymentIntents?.retrieve) {
    return "Card on file";
  }
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId, {
      expand: ["latest_charge", "payment_method"],
    });
    const charge = intent?.latest_charge && typeof intent.latest_charge === "object"
      ? intent.latest_charge
      : null;
    const card = charge?.payment_method_details?.card || intent?.payment_method?.card || null;
    if (card?.last4) {
      const brand = card?.brand ? String(card.brand).replace(/_/g, " ") : "Card";
      return `${brand} ending ${card.last4}`;
    }
  } catch (err) {
    logger.warn("[cases] payment method lookup failed", err?.message || err);
  }
  return "Card on file";
}

function resolveAttorneyFeePct(doc = {}) {
  return typeof doc.feeAttorneyPct === "number" && Number.isFinite(doc.feeAttorneyPct)
    ? doc.feeAttorneyPct
    : PLATFORM_FEE_ATTORNEY_PERCENT;
}

function resolveParalegalFeePct(doc = {}) {
  return typeof doc.feeParalegalPct === "number" && Number.isFinite(doc.feeParalegalPct)
    ? doc.feeParalegalPct
    : PLATFORM_FEE_PARALEGAL_PERCENT;
}

function calculateAttorneyFeeAmount(baseAmount, pct = PLATFORM_FEE_ATTORNEY_PERCENT) {
  return Math.max(0, Math.round(Number(baseAmount || 0) * ((Number(pct) || 0) / 100)));
}

function calculateParalegalFeeAmount(baseAmount, pct = PLATFORM_FEE_PARALEGAL_PERCENT) {
  return Math.max(0, Math.round(Number(baseAmount || 0) * ((Number(pct) || 0) / 100)));
}

function computeAttorneyFeeAmount(baseAmount, doc = {}) {
  if (Number.isFinite(doc.feeAttorneyAmount) && doc.feeAttorneyAmount > 0) {
    return doc.feeAttorneyAmount;
  }
  return calculateAttorneyFeeAmount(baseAmount, resolveAttorneyFeePct(doc));
}

function computeParalegalFeeAmount(baseAmount, doc = {}) {
  if (Number.isFinite(doc.feeParalegalAmount) && doc.feeParalegalAmount > 0) {
    return doc.feeParalegalAmount;
  }
  return calculateParalegalFeeAmount(baseAmount, resolveParalegalFeePct(doc));
}

function resolveDisputeSettlement(doc = {}) {
  const settlement = doc.disputeSettlement || {};
  const action = String(settlement.action || "");
  if (!["release_full", "release_partial"].includes(action)) return null;
  const grossAmount = Number(settlement.grossAmount);
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) return null;
  const feeAttorneyPct = Number.isFinite(settlement.feeAttorneyPct)
    ? settlement.feeAttorneyPct
    : resolveAttorneyFeePct(doc);
  const feeParalegalPct = Number.isFinite(settlement.feeParalegalPct)
    ? settlement.feeParalegalPct
    : resolveParalegalFeePct(doc);
  const feeAttorneyAmount =
    Number.isFinite(settlement.feeAttorneyAmount) && settlement.feeAttorneyAmount > 0
      ? settlement.feeAttorneyAmount
      : calculateAttorneyFeeAmount(grossAmount, feeAttorneyPct);
  const feeParalegalAmount =
    Number.isFinite(settlement.feeParalegalAmount) && settlement.feeParalegalAmount > 0
      ? settlement.feeParalegalAmount
      : calculateParalegalFeeAmount(grossAmount, feeParalegalPct);
  const payoutAmount = Number.isFinite(settlement.payoutAmount)
    ? settlement.payoutAmount
    : Math.max(0, grossAmount - feeParalegalAmount);
  return {
    grossAmount,
    feeAttorneyAmount,
    feeParalegalAmount,
    feeAttorneyPct,
    feeParalegalPct,
    payoutAmount,
  };
}

async function generateReceiptDocuments(caseDoc, { payoutAmount, paymentMethodLabel } = {}) {
  if (!caseDoc?._id) return;
  const settlement = resolveDisputeSettlement(caseDoc);
  const remainingAmount =
    caseDoc?.payoutFinalizedType === "partial_attorney" && Number.isFinite(caseDoc?.remainingAmount)
      ? Number(caseDoc.remainingAmount)
      : null;
  const baseAmount =
    settlement?.grossAmount ??
    (remainingAmount != null ? remainingAmount : Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0));
  const attorneyFee = settlement?.feeAttorneyAmount ?? computeAttorneyFeeAmount(baseAmount, caseDoc);
  const paralegalFee = settlement?.feeParalegalAmount ?? computeParalegalFeeAmount(baseAmount, caseDoc);
  const computedNet = settlement?.payoutAmount ?? Math.max(0, baseAmount - paralegalFee);
  const payout =
    Number.isFinite(payoutAmount) && payoutAmount >= 0
      ? Math.min(payoutAmount, computedNet)
      : computedNet;
  const issuedAt = caseDoc.completedAt || caseDoc.paidOutAt || new Date();
  const attorneyPct = settlement?.feeAttorneyPct ?? resolveAttorneyFeePct(caseDoc);
  const paralegalPct = settlement?.feeParalegalPct ?? resolveParalegalFeePct(caseDoc);

  const attorneyName =
    caseDoc.attorneyNameSnapshot ||
    buildPersonDisplay(caseDoc.attorney, "") ||
    buildPersonDisplay(caseDoc.attorneyId, "Attorney") ||
    "Attorney";
  const paralegalName =
    caseDoc.paralegalNameSnapshot ||
    buildPersonDisplay(caseDoc.paralegal, "") ||
    buildPersonDisplay(caseDoc.paralegalId, "Paralegal") ||
    "Paralegal";

  const attorneyPayload = {
    title: "Receipt",
    receiptId: caseDoc.paymentIntentId || caseDoc.escrowIntentId || String(caseDoc._id),
    issuedAt: new Date(issuedAt).toLocaleDateString("en-US"),
    partyLabel: "Billed to",
    partyName: attorneyName,
    caseTitle: caseDoc.title || "Untitled Matter",
    lineItems: [
      { label: "Matter amount", value: formatCurrency(baseAmount) },
      { label: `Platform fee (${attorneyPct}%)`, value: formatCurrency(attorneyFee) },
    ],
    totalLabel: "Total paid",
    totalAmount: formatCurrency(baseAmount + attorneyFee),
    paymentMethod: paymentMethodLabel || "Card on file",
    paymentStatus: "Paid in full",
  };

  const paralegalPayload = {
    title: "Payout Receipt",
    receiptId: caseDoc.payoutTransferId || String(caseDoc._id),
    issuedAt: new Date(issuedAt).toLocaleDateString("en-US"),
    partyLabel: "Payee",
    partyName: paralegalName,
    attorneyName,
    caseTitle: caseDoc.title || "Untitled Matter",
    lineItems: [
      { label: "Gross amount", value: formatCurrency(baseAmount) },
      { label: `Platform fee (${paralegalPct}%)`, value: formatCurrency(paralegalFee) },
    ],
    totalLabel: "Net paid",
    totalAmount: formatCurrency(payout),
    paymentMethod: "Stripe release",
    paymentStatus: "Paid",
  };

  const attorneyKey = getReceiptKey(caseDoc._id, "attorney");
  const paralegalKey = getReceiptKey(caseDoc._id, "paralegal");
  const [attorneyPdf, paralegalPdf] = await Promise.all([
    buildReceiptPdfBuffer(attorneyPayload),
    buildReceiptPdfBuffer(paralegalPayload),
  ]);

  await Promise.all([
    uploadPdfToS3({ key: attorneyKey, buffer: attorneyPdf }),
    uploadPdfToS3({ key: paralegalKey, buffer: paralegalPdf }),
  ]);
}

function normalizePracticeArea(value) {
  const cleaned = cleanString(value || "", { len: 200 }).toLowerCase();
  if (!cleaned) return "";
  return PRACTICE_AREA_LOOKUP[cleaned] || "";
}

function normalizeCaseStatusValue(status) {
  const value = String(status || "").trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (lower === LEGACY_IN_PROGRESS_STATUS) return IN_PROGRESS_STATUS;
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing"].includes(lower)) return IN_PROGRESS_STATUS;
  return lower;
}

const CLOSED_CASE_STATUSES = new Set(["completed", "closed", "disputed"]);
const ATTORNEY_ARCHIVED_BUCKET_STATUSES = ["completed", "closed", "paused", "cancelled", "canceled"];

function isFinalCaseDoc(doc) {
  if (!doc) return false;
  if (doc.paymentReleased === true) return true;
  return normalizeCaseStatusValue(doc.status) === "completed";
}

function isCaseClosedForFiles(doc) {
  if (!doc) return false;
  if (doc.paymentReleased === true) return true;
  return CLOSED_CASE_STATUSES.has(normalizeCaseStatusValue(doc.status));
}


function resolveCaseJobId(caseDoc) {
  if (!caseDoc) return null;
  const raw = caseDoc.jobId || caseDoc.job || null;
  if (!raw) return null;
  if (typeof raw === "object") {
    return raw._id || raw.id || raw;
  }
  return raw;
}

function resolveCaseAttorneyIds(caseDoc) {
  if (!caseDoc) return [];
  const rawValues = [
    caseDoc.attorney?._id,
    caseDoc.attorneyId?._id,
    caseDoc.attorney,
    caseDoc.attorneyId,
  ].filter(Boolean);
  return [...new Set(rawValues.map((value) => String(value)).filter(Boolean))];
}

function isCaseAttorneyUser(caseDoc, userId) {
  const normalizedUserId = String(userId || "");
  if (!normalizedUserId) return false;
  return resolveCaseAttorneyIds(caseDoc).includes(normalizedUserId);
}

function resolveRemainingAmount(caseDoc) {
  if (!caseDoc) return null;
  if (Number.isFinite(caseDoc.remainingAmount)) return caseDoc.remainingAmount;
  const base = Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0);
  if (!Number.isFinite(base) || base <= 0) return null;
  const paid = Number(caseDoc.partialPayoutAmount ?? 0);
  if (!Number.isFinite(paid) || paid <= 0) return base;
  return Math.max(0, Math.round(base - paid));
}

function countPendingApplicants(caseDoc) {
  if (!caseDoc || !Array.isArray(caseDoc.applicants)) return 0;
  return caseDoc.applicants.filter((applicant) => {
    const status = String(applicant?.status || "pending").toLowerCase();
    return status === "pending";
  }).length;
}

function computeParalegalFeeFromGross(grossCents, caseDoc) {
  const gross = Math.max(0, Math.round(Number(grossCents || 0)));
  const pct = resolveParalegalFeePct(caseDoc);
  const fee = Math.max(0, Math.round((gross * (Number(pct) || 0)) / 100));
  const net = Math.max(0, gross - fee);
  return { gross, feePct: pct, feeAmount: fee, net };
}

function isDisputeWindowActive(caseDoc, now = new Date()) {
  if (!caseDoc?.disputeDeadlineAt) return false;
  if (caseDoc.payoutFinalizedAt) return false;
  if (String(caseDoc.status || "").toLowerCase() === "disputed") return false;
  return now.getTime() < new Date(caseDoc.disputeDeadlineAt).getTime();
}

async function markJobAssigned(caseDoc, jobId, session) {
  if (!session?.inTransaction()) throw new Error("Hiring synchronization requires a transaction.");
  if (!jobId) return;
  const job = await Job.collection.updateOne(
    { _id: { $in: applicationRefs(jobId) } },
    { $set: { status: "assigned", updatedAt: new Date() } },
    { session }
  );
  if (job.matchedCount !== 1) throw new Error("The Matter posting could not be assigned.");
  const synced = await Case.collection.updateOne(
    { _id: caseDoc._id },
    { $set: { postingSyncStatus: "synced", postingSyncedAt: new Date(), postingSyncError: "" } },
    { session }
  );
  if (synced.matchedCount !== 1) throw new Error("The Matter posting result could not be recorded.");
}

async function stageHiredApplications(req, caseDoc, hiredParalegalId) {
  // Reuse the authoritative identity join: canonical retained outcomes take
  // precedence over earlier mirrors, including raw string references.
  const snapshot = await legacyApplications.begin(req, [caseDoc]);
  const rows = snapshot.rows.get(String(caseDoc._id).toLowerCase()) || [];
  const byPerson = new Map(rows.map(row => [row.personId, row]));
  const hiredId = String(hiredParalegalId).toLowerCase();
  const rejectedApplicantIds = new Set();
  for (const mirror of caseDoc.applicants || []) {
    const personId = String(mirror.paralegalId || "").toLowerCase();
    const row = byPerson.get(personId);
    if (!row) continue;
    const status = String(row.record.status || "").toLowerCase();
    if (personId === hiredId) mirror.status = "accepted";
    else if (row.canonical ? pendingApplicationStatuses.has(status) : status === "pending") {
      mirror.status = "rejected";
      rejectedApplicantIds.add(personId);
    }
  }
  for (const row of rows) {
    if (row.personId !== hiredId && row.canonical && pendingApplicationStatuses.has(String(row.record.status || "").toLowerCase())) rejectedApplicantIds.add(row.personId);
  }
  return { rejectedApplicantIds, jobId: snapshot.postings.get(String(caseDoc._id).toLowerCase())?._id || null };
}

async function rejectJobApplications(jobId, hiredParalegalId, session) {
  if (!session?.inTransaction()) throw new Error("Hiring synchronization requires a transaction.");
  if (!jobId || !hiredParalegalId) return;
  const refs = applicationRefs, now = new Date();
  const jobFilter = { jobId: { $in: refs(jobId) } };
  await Application.collection.updateOne(
    { ...jobFilter, paralegalId: { $in: refs(hiredParalegalId) }, status: { $in: [...pendingApplicationStatuses] } },
    {
      $set: { status: "accepted", syncStatus: "synced", syncedAt: now, syncError: "", updatedAt: now },
      $push: { statusHistory: { $each: [{ to: "accepted", reason: "paralegal_hired", at: now }], $slice: -50 } },
    },
    { session }
  );
  await Application.collection.updateMany(
    { ...jobFilter, paralegalId: { $nin: refs(hiredParalegalId) }, status: { $in: [...pendingApplicationStatuses] } },
    {
      $set: { status: "rejected", syncStatus: "synced", syncedAt: now, syncError: "", updatedAt: now },
      $push: { statusHistory: { $each: [{ to: "rejected", reason: "matter_filled", at: now }], $slice: -50 } },
    },
    { session }
  );
  const count = await Application.collection.countDocuments({ ...jobFilter, status: { $in: [...pendingApplicationStatuses] } }, { session });
  const counted = await Job.collection.updateOne({ _id: { $in: refs(jobId) } }, { $set: { applicantsCount: count, updatedAt: now } }, { session });
  if (counted.matchedCount !== 1) throw new Error("The Matter posting count could not be updated.");
}

function parseDeadline(raw) {
  return parseMatterDeadline(raw);
}

function buildDetails(description, questions = []) {
  const parts = [];
  const base = cleanPlainText(description || "", { max: 100_000 });
  if (base) parts.push(base);
  if (questions.length) {
    parts.push(`Screening questions:\n- ${questions.join("\n- ")}`);
  }
  return parts.join("\n\n").trim();
}

function buildBriefSummary({ state, employmentType, experience }) {
  const bits = [];
  const safeState = cleanString(state || "", { len: 200 });
  const safeEmployment = cleanString(employmentType || "", { len: 200 });
  const safeExperience = cleanString(experience || "", { len: 200 });
  if (safeState) bits.push(`State: ${safeState}`);
  if (safeEmployment) bits.push(`Engagement: ${safeEmployment}`);
  if (safeExperience) bits.push(`Experience: ${safeExperience}`);
  return bits.join(" • ");
}

function summarizeUser(person) {
  if (!person || typeof person !== "object") return null;
  const name = `${person.firstName || ""} ${person.lastName || ""}`.trim() || null;
  return {
    id: String(person._id || person.id),
    firstName: person.firstName || null,
    lastName: person.lastName || null,
    name,
    email: person.email || null,
    role: person.role || null,
    profileImage:
      person.profileImage || person.avatarURL
        ? buildAuthenticatedProfilePhotoUrl(person)
        : null,
  };
}

function formatPersonName(person) {
  if (!person || typeof person !== "object") return "";
  return `${person.firstName || ""} ${person.lastName || ""}`.trim();
}

async function ensureStripeCustomer(user) {
  if (!user) throw new Error("User not found");
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe.customers.create(
    {
      email: user.email || undefined,
      name: formatPersonName(user) || undefined,
      metadata: { userId: user._id ? String(user._id) : "", role: user.role || "" },
    },
    { idempotencyKey: stripe.stripeIdempotencyKey("customer", user._id) }
  );
  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}

async function fetchDefaultPaymentMethodId(customerId) {
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId);
  return customer?.invoice_settings?.default_payment_method || null;
}

function buildCaseChargeDescription(caseDoc, paralegalDoc) {
  const caseName = caseDoc?.title || caseDoc?.caseTitle || `Case ${caseDoc?._id || ""}`;
  const paralegalName = formatPersonName(paralegalDoc) || "Paralegal";
  return `Case: ${caseName} — Paralegal: ${paralegalName}`;
}

function shapeInternalNote(note) {
  if (!note) {
    return { note: "", updatedAt: null, updatedBy: null };
  }
  const base = typeof note === "string" ? { text: note } : note;
  return {
    note: base.text || "",
    updatedAt: base.updatedAt || null,
    updatedBy: summarizeUser(base.updatedBy) || (base.updatedBy ? { id: String(base.updatedBy) } : null),
  };
}

const INVITE_STATUSES = new Set(["pending", "accepted", "declined", "expired"]);

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

function listCaseInvites(caseDoc, { includeLegacy = true } = {}) {
  const invites = Array.isArray(caseDoc?.invites) ? caseDoc.invites : [];
  const normalized = invites
    .map((invite) => ({
      paralegalId: normalizeInviteParalegalId(invite?.paralegalId),
      status: normalizeInviteStatus(invite?.status),
      invitedAt: invite?.invitedAt || null,
      respondedAt: invite?.respondedAt || null,
    }))
    .filter((invite) => invite.paralegalId);

  if (!normalized.length && includeLegacy && caseDoc?.pendingParalegalId) {
    normalized.push({
      paralegalId: String(caseDoc.pendingParalegalId),
      status: "pending",
      invitedAt: caseDoc.pendingParalegalInvitedAt || null,
      respondedAt: null,
    });
  }
  return normalized;
}

function hasPendingInvites(caseDoc) {
  return listCaseInvites(caseDoc).some((invite) => invite.status === "pending");
}

function findInviteIndex(caseDoc, paralegalId) {
  if (!Array.isArray(caseDoc.invites)) {
    caseDoc.invites = [];
  }
  const target = String(paralegalId || "");
  return caseDoc.invites.findIndex((invite) => normalizeInviteParalegalId(invite?.paralegalId) === target);
}

function upsertInvite(caseDoc, paralegalId, { status = "pending", invitedAt = new Date(), respondedAt = null } = {}) {
  const idx = findInviteIndex(caseDoc, paralegalId);
  const payload = {
    paralegalId,
    status: normalizeInviteStatus(status),
    invitedAt: invitedAt || new Date(),
    respondedAt: respondedAt || null,
  };
  if (idx >= 0) {
    caseDoc.invites[idx].paralegalId = payload.paralegalId;
    caseDoc.invites[idx].status = payload.status;
    caseDoc.invites[idx].invitedAt = payload.invitedAt;
    caseDoc.invites[idx].respondedAt = payload.respondedAt;
    caseDoc.markModified("invites");
    return caseDoc.invites[idx];
  }
  caseDoc.invites.push(payload);
  caseDoc.markModified("invites");
  return caseDoc.invites[caseDoc.invites.length - 1];
}

function markOtherInvites(caseDoc, excludeParalegalId, status = "declined") {
  if (!Array.isArray(caseDoc.invites)) return;
  const target = String(excludeParalegalId || "");
  const normalizedStatus = normalizeInviteStatus(status);
  caseDoc.invites.forEach((invite) => {
    if (String(invite.paralegalId) !== target && normalizeInviteStatus(invite.status) === "pending") {
      invite.status = normalizedStatus;
      invite.respondedAt = new Date();
    }
  });
}


function syncLegacyPendingFields(caseDoc) {
  if (!Array.isArray(caseDoc.invites) || !caseDoc.invites.length) {
    caseDoc.set("pendingParalegalId", null);
    caseDoc.set("pendingParalegalInvitedAt", null);
    return;
  }
  const pending = caseDoc.invites
    .filter((invite) => normalizeInviteStatus(invite.status) === "pending")
    .sort((a, b) => {
      const aTime = a.invitedAt ? new Date(a.invitedAt).getTime() : 0;
      const bTime = b.invitedAt ? new Date(b.invitedAt).getTime() : 0;
      return aTime - bTime;
    });
  const first = pending[0] || null;
  caseDoc.set("pendingParalegalId", first ? first.paralegalId : null);
  caseDoc.set("pendingParalegalInvitedAt", first ? first.invitedAt || null : null);
}

function seedLegacyInvite(caseDoc) {
  if (!caseDoc?.pendingParalegalId) return;
  if (!Array.isArray(caseDoc.invites)) caseDoc.invites = [];
  const pendingId = normalizeInviteParalegalId(caseDoc.pendingParalegalId);
  const exists = caseDoc.invites.some((invite) => normalizeInviteParalegalId(invite?.paralegalId) === pendingId);
  if (!exists) {
    caseDoc.invites.push({
      paralegalId: caseDoc.pendingParalegalId,
      status: "pending",
      invitedAt: caseDoc.pendingParalegalInvitedAt || new Date(),
      respondedAt: null,
    });
  }
}

function caseSummary(doc, { includeFiles = false, viewerRole = "", viewerId = "", applicationCount } = {}) {
  const isAdmin = String(viewerRole || "").toLowerCase() === "admin";
  const paralegal = summarizeUser(doc.paralegal || doc.paralegalId);
  const pendingParalegal = summarizeUser(doc.pendingParalegal || doc.pendingParalegalId);
  const attorney = summarizeUser(doc.attorney || doc.attorneyId);
  const flags = Array.isArray(doc.flags) ? doc.flags : [];
  const lastFlag = flags.length ? flags[flags.length - 1] : null;
  const stateValue = doc.state || doc.locationState || "";
  const normalizedStatus = normalizeCaseStatusValue(doc.status);
  const invites = listCaseInvites(doc);
  const visibleEmbeddedFiles = Array.isArray(doc.files)
    ? doc.files.filter((file) => isRecordVisibleToCurrentAssignment(file, doc, {
        role: viewerRole,
        userId: viewerId,
        isParalegal: String(viewerRole || "").toLowerCase() === "paralegal",
      }))
    : [];
  const replacementAssignmentBoundary = resolveCurrentParalegalAssignmentBoundary(doc, {
    role: viewerRole,
    userId: viewerId,
    isParalegal: String(viewerRole || "").toLowerCase() === "paralegal",
  });
  const summary = {
    _id: doc._id,
    id: String(doc._id),
    title: doc.title,
    details: doc.details || "",
    practiceArea: doc.practiceArea || "",
    state: stateValue,
    locationState: doc.locationState || stateValue,
    experience: doc.experiencePreference || "",
    experiencePreference: doc.experiencePreference || "",
    minimumYearsExperience: Number(doc.minimumYearsExperience || 0),
    requirements: doc.requirements || [],
    tasks: serializeScopeTasks(doc.tasks),
    taskRevision: Number(doc.taskRevision || 0),
    tasksLocked: !!doc.tasksLocked,
    status: normalizedStatus,
    pausedReason: doc.pausedReason || null,
    pausedAt: doc.pausedAt || null,
    disputeDeadlineAt: doc.disputeDeadlineAt || null,
    partialPayoutAmount: typeof doc.partialPayoutAmount === "number" ? doc.partialPayoutAmount : null,
    payoutFinalizedAt: doc.payoutFinalizedAt || null,
    payoutFinalizedType: doc.payoutFinalizedType || null,
    withdrawnParalegalId: doc.withdrawnParalegalId || null,
    relistRequestedAt: doc.relistRequestedAt || null,
    relistPending: !!doc.relistPending,
    deadlineDate: resolveMatterDeadlineDate(doc),
    deadline: resolveMatterDeadlineDate(doc) || null,
    zoomLink: doc.zoomLink || "",
    paymentReleased: doc.paymentReleased || false,
    escrowIntentId: doc.escrowIntentId || null,
    escrowStatus: doc.escrowStatus || null,
    totalAmount: typeof doc.totalAmount === "number" ? doc.totalAmount : 0,
    lockedTotalAmount: typeof doc.lockedTotalAmount === "number" ? doc.lockedTotalAmount : null,
    remainingAmount: resolveRemainingAmount(doc),
    currency: doc.currency || "usd",
    assignedTo: paralegal,
    acceptedParalegal: !!paralegal,
    applicants: applicationCount ?? countPendingApplicants(doc),
    applicantsCount: applicationCount ?? countPendingApplicants(doc),
    filesCount: !isAdmin ? visibleEmbeddedFiles.length : 0,
    jobId: doc.jobId || null,
    attorney,
    paralegal,
    pendingParalegal,
    pendingParalegalId:
      pendingParalegal?.id || (doc.pendingParalegalId ? String(doc.pendingParalegalId) : null),
    pendingParalegalInvitedAt: doc.pendingParalegalInvitedAt || null,
    invites,
    hiredAt: doc.hiredAt || null,
    completedAt: doc.completedAt || null,
    briefSummary: doc.briefSummary || "",
    archived: !!doc.archived,
    downloadUrl: !isAdmin && !replacementAssignmentBoundary && Array.isArray(doc.downloadUrl)
      ? doc.downloadUrl
      : [],
    readOnly: !!doc.readOnly,
    paralegalAccessRevokedAt: doc.paralegalAccessRevokedAt || null,
    archiveReadyAt: doc.archiveReadyAt || null,
    archiveDownloadedAt: doc.archiveDownloadedAt || null,
    purgeScheduledFor: doc.purgeScheduledFor || null,
    purgedAt: doc.purgedAt || null,
    paralegalNameSnapshot: doc.paralegalNameSnapshot || "",
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    ...(isAdmin || String(viewerRole).toLowerCase() === "attorney" ? { internalNotes: shapeInternalNote(doc.internalNotes) } : {}),
    termination: {
      status: doc.terminationStatus || "none",
      reason: doc.terminationReason || "",
      requestedAt: doc.terminationRequestedAt || null,
      requestedBy: doc.terminationRequestedBy
        ? summarizeUser(doc.terminationRequestedBy) || { id: String(doc.terminationRequestedBy) }
        : null,
      disputeId: doc.terminationDisputeId || null,
      terminatedAt: doc.terminatedAt || null,
    },
  };
  if (isAdmin) {
    summary.flagCount = flags.length;
    summary.flagReasons = flags.map((flag) => flag?.reason).filter(Boolean);
    summary.flagDetails = lastFlag?.details || "";
    summary.flaggedAt = lastFlag?.createdAt || null;
  }
  summary.moderationStatus = doc.moderationStatus || "none";
  summary.moderationFlaggedAt = doc.moderationFlaggedAt || null;
  summary.moderationResolutionRequestedAt = doc.moderationResolutionRequestedAt || null;
  summary.canMarkFlagResolved = String(doc.moderationStatus || "none") === "flagged" && hasModerationRevision(doc);
  if (doc.preEngagement) {
    summary.preEngagement = {
      status: doc.preEngagement.status || "requested",
      requestedParalegalId: doc.preEngagement.requestedParalegalId
        ? String(doc.preEngagement.requestedParalegalId)
        : null,
      confidentialityAgreementRequired: !!doc.preEngagement.confidentialityAgreementRequired,
      conflictsCheckRequired: !!doc.preEngagement.conflictsCheckRequired,
      conflictsDetails: doc.preEngagement.conflictsDetails || "",
      confidentialityDocument: doc.preEngagement.confidentialityDocument || null,
      paralegalConfidentialityDocument: doc.preEngagement.paralegalConfidentialityDocument || null,
      requestedAt: doc.preEngagement.requestedAt || null,
      requestedBy: doc.preEngagement.requestedBy ? String(doc.preEngagement.requestedBy) : null,
      confidentialityAcknowledged: !!doc.preEngagement.confidentialityAcknowledged,
      confidentialityAcknowledgedAt: doc.preEngagement.confidentialityAcknowledgedAt || null,
      confidentialityAcknowledgedBy: doc.preEngagement.confidentialityAcknowledgedBy
        ? String(doc.preEngagement.confidentialityAcknowledgedBy)
        : null,
      conflictsResponseType: doc.preEngagement.conflictsResponseType || "",
      conflictsDisclosureText: doc.preEngagement.conflictsDisclosureText || "",
      submittedAt: doc.preEngagement.submittedAt || null,
      submittedBy: doc.preEngagement.submittedBy ? String(doc.preEngagement.submittedBy) : null,
      reviewedAt: doc.preEngagement.reviewedAt || null,
      reviewedBy: doc.preEngagement.reviewedBy ? String(doc.preEngagement.reviewedBy) : null,
    };
  }
  if (includeFiles && !isAdmin) {
    summary.files = visibleEmbeddedFiles.map(normalizeFile);
  }
  return summary;
}

const CASE_LIST_FIELDS = "title details practiceArea status pausedReason pausedAt disputeDeadlineAt partialPayoutAmount payoutFinalizedAt payoutFinalizedType withdrawnParalegalId relistRequestedAt relistPending remainingAmount escrowStatus deadline deadlineDate zoomLink paymentReleased escrowIntentId applicants files jobId createdAt updatedAt attorney attorneyId paralegal paralegalId pendingParalegalId pendingParalegalInvitedAt invites hiredAt completedAt briefSummary archived downloadUrl internalNotes totalAmount lockedTotalAmount currency tasks taskRevision tasksLocked moderationStatus moderationFlaggedAt moderationFlaggedBy moderationResolutionRequestedAt moderationResolutionRequestedBy moderationPostingBaseline moderationEditRequest title details practiceArea state locationState experiencePreference minimumYearsExperience totalAmount deadline deadlineDate tasks";

// Raw owner-reference reads preserve the ObjectId/string aliases already
// supported by the application feeds; presentation still uses the same fields.
async function readCaseList(query, { select, sort = { updatedAt: -1 }, limit, skip = 0, populate = [] } = {}) {
  const projection = select ? Object.fromEntries(select.split(' ').filter(Boolean).map(key => [key, 1])) : undefined;
  const cursor = Case.collection.find(query, { projection, maxTimeMS: 15000 }).sort(sort).skip(skip);
  if (limit) cursor.limit(limit);
  const docs = await cursor.toArray();
  if (populate.length) await Case.populate(docs, populate);
  return docs;
}

async function presentCaseList(docs, { role, viewerId, includeFiles, fileDetails = true, req }) {
  const applications = await legacyApplications.begin(req, docs);
  let filesByCase = new Map();
  if (includeFiles && docs.length) {
    const caseIds = docs.map((doc) => doc._id);
    const fileQuery = CaseFile.find({ caseId: { $in: caseIds } }).sort({ createdAt: -1 });
    if (!fileDetails) fileQuery.select('caseId createdAt');
    const files = await fileQuery.lean();
    const caseById = new Map(docs.map((doc) => [String(doc._id), doc]));
    files.forEach((file) => {
      const key = String(file.caseId);
      if (!isRecordVisibleToCurrentAssignment(file, caseById.get(key), {
        role,
        userId: viewerId,
        isParalegal: role === "paralegal",
      })) return;
      if (!filesByCase.has(key)) filesByCase.set(key, []);
      filesByCase.get(key).push(fileDetails ? normalizeFile(file) : file);
    });
  }

  const result = docs.map((doc) => {
    const summary = caseSummary(doc, {
      includeFiles: false,
      viewerRole: role,
      viewerId,
      applicationCount: applications.counts.get(String(doc._id).toLowerCase()),
    });
    if (includeFiles) {
      const files = filesByCase.get(String(doc._id)) || [];
      if (fileDetails) summary.files = files;
      summary.filesCount = files.length;
    }
    return summary;
  });
  await applications.verify();
  return result;
}

function normalizeFile(file) {
  const originalRaw = file.original || file.filename || file.originalName || "";
  const keyRaw = file.key || file.storageKey || "";
  const original = decryptString(originalRaw);
  const key = decryptString(keyRaw);
  return {
    id: file._id ? String(file._id) : undefined,
    key,
    storageKey: key,
    previewKey: decryptString(file.previewKey || ""),
    original,
    filename: decryptString(file.filename || original),
    mime: file.mime || file.mimeType || null,
    previewMime: file.previewMime || file.previewMimeType || null,
    size: file.size || null,
    previewSize: file.previewSize || null,
    securityStatus: file.securityStatus || (malwareScanRequired() ? "pending" : "not_required"),
    securityScanResult: file.securityScanResult || (malwareScanRequired() ? "PENDING" : "NOT_REQUIRED"),
    securityScannedAt: file.securityScannedAt || null,
    uploadedBy: file.uploadedBy ? String(file.uploadedBy) : file.userId ? String(file.userId) : null,
    uploadedByRole: file.uploadedByRole || null,
    uploadedAt: file.createdAt || file.updatedAt || file.uploadedAt || null,
    status: file.status || "pending_review",
    version: typeof file.version === "number" ? file.version : 1,
    revisionResolution: file.revisionResolution || null,
    revisionNotes: decryptString(file.revisionNotes || ""),
    revisionRequestedAt: file.revisionRequestedAt || null,
    approvedAt: file.approvedAt || null,
    replacedAt: file.replacedAt || null,
  };
}

function hasModerationRevision(doc) { return matterModeration.hasRevision(doc); }

async function sendInvitationWithNotices(res, options) {
  try { return await sendInvitation(options); }
  catch (error) {
    if (!['ACCOUNT_WRITE_UNCONFIRMED', 'INVITATION_NOTICE_UNAVAILABLE'].includes(error.publicCode)) throw error;
    logger.warn('[cases] invitation write needs review', { caseId: options.caseDoc?._id, code: error.publicCode });
    res.status(503).json({
      code: error.publicCode,
      error: error.publicCode === 'ACCOUNT_WRITE_UNCONFIRMED'
        ? 'The invitation result could not be confirmed. Check its saved status before sending another invitation.'
        : 'The invitation could not be saved with its notices. Review the Matter before trying again.',
    });
    return null;
  }
}

async function dispatchPostingNotice(dispatch) {
  try { await dispatch?.(); } catch (error) { logger.warn('[cases] saved posting notice dispatch failed', error?.name); }
}
async function retainModerationChange(work) {
  // Preserve the existing bounded append-to-latest-note behavior. Each fresh
  // transaction still checks the original posting/moderation snapshot; only a
  // private note change can be absorbed without accepting a stale review.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await withActiveAccountWrite([], work); }
    catch (error) { if (error.publicCode !== 'ACCOUNT_WRITE_CHANGED' || attempt === 2) throw error; }
  }
}
function postingUpdateRecipients(doc, isAdmin = false, exactStatus = false) {
  if (isAdmin || doc.paralegalId || doc.hiredAt) return [];
  return [...new Set((doc.applicants || []).filter(item => (exactStatus ? String(item.status || 'pending') : String(item.status || 'pending').toLowerCase()) === 'pending').map(item => String(item.paralegalId?._id || item.paralegalId || '')).filter(Boolean))];
}

function publishCaseParticipantRefresh(caseDoc, type = "case_refresh", additionalUserIds = []) {
  publishCaseProjectionRefresh(caseDoc, type, { additionalUserIds, discovery: true, caseEvent: "" });
}

function buildCaseLink(caseDoc) {
  const id = caseDoc?._id || caseDoc?.id;
  return id ? `case-detail.html?caseId=${encodeURIComponent(id)}` : "";
}

async function ensureStripeOnboardedUser(paralegal) {
  if (!paralegal?.stripeAccountId) return false;
  if (paralegal.stripeOnboarded && paralegal.stripePayoutsEnabled) return true;
  try {
    const account = await stripe.accounts.retrieve(paralegal.stripeAccountId);
    const submitted = !!account?.details_submitted;
    const chargesEnabled = !!account?.charges_enabled;
    const payoutsEnabled = !!account?.payouts_enabled;
    paralegal.stripeChargesEnabled = chargesEnabled;
    paralegal.stripePayoutsEnabled = payoutsEnabled;
    paralegal.stripeOnboarded = submitted && payoutsEnabled;
    await paralegal.save();
    return paralegal.stripeOnboarded;
  } catch (err) {
    logger.warn("[cases] stripe onboarding status check failed", err?.message || err);
  }
  return false;
}




async function nextCaseFileVersion(caseId, filename) {
  if (!caseId || !filename) return 1;
  const recent = await CaseFile.find(buildCaseFileNameQuery({ caseId, originalName: filename }))
    .sort({ version: -1, createdAt: -1 })
    .limit(1)
    .lean();
  const latest = recent[0];
  const prev = Number(latest?.version || 0);
  return prev > 0 ? prev + 1 : 1;
}

async function signDownload(key) {
  if (!S3_BUCKET) throw new Error("S3 bucket not configured");
  const head = new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key });
  try {
    await s3.send(head);
  } catch (err) {
    const code = err?.name || err?.Code || err?.code;
    const missing = code === "NoSuchKey" || code === "NotFound" || err?.$metadata?.httpStatusCode === 404;
    if (missing) {
      const notFound = new Error("S3 object not found");
      notFound.code = "NoSuchKey";
      throw notFound;
    }
    throw err;
  }
  const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: 60 });
}

function normalizeCaseStorageKey(value) {
  return String(value || "").trim().replace(/^\/+/, "");
}

function isCaseDocumentStorageKey(caseId, key) {
  const normalizedCaseId = String(caseId || "").toLowerCase();
  const normalizedKey = normalizeCaseStorageKey(key);
  return (
    /^[a-f0-9]{24}$/i.test(normalizedCaseId) &&
    normalizedKey.startsWith(`cases/${normalizedCaseId}/documents/`) &&
    !normalizedKey.includes("..") &&
    !/[\u0000-\u001f\u007f\\]/.test(normalizedKey)
  );
}

function isMatterDocumentWorkspaceReady(caseDoc) {
  const status = normalizeCaseStatusValue(caseDoc?.status);
  return Boolean(
    status === "in progress" &&
    (caseDoc?.paralegal || caseDoc?.paralegalId) &&
    caseDoc?.escrowIntentId &&
    String(caseDoc?.escrowStatus || "").toLowerCase() === "funded" &&
    caseDoc?.archived !== true &&
    caseDoc?.readOnly !== true &&
    caseDoc?.paralegalAccessRevokedAt == null
  );
}

function requireMatterDocumentWorkspace(caseDoc, res) {
  if (isMatterDocumentWorkspaceReady(caseDoc)) return true;
  res.status(403).json({
    error: "Documents are available only while the funded Matter workspace is active.",
    code: "MATTER_WORKSPACE_REQUIRED",
  });
  return false;
}

async function verifyCaseDocumentObject({ caseId, key, declaredSize, declaredMime }) {
  const normalizedKey = normalizeCaseStorageKey(key);
  if (!isCaseDocumentStorageKey(caseId, normalizedKey)) {
    const err = new Error("The document key does not belong to this Matter.");
    err.code = "INVALID_CASE_FILE_KEY";
    throw err;
  }
  if (!S3_BUCKET) return null;
  const head = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: normalizedKey }));
  const actualSize = Number(head?.ContentLength);
  const requestedSize = Number(declaredSize);
  if (
    Number.isFinite(requestedSize) &&
    requestedSize >= 0 &&
    Number.isFinite(actualSize) &&
    requestedSize !== actualSize
  ) {
    const err = new Error("The uploaded document size does not match its stored object.");
    err.code = "CASE_FILE_METADATA_MISMATCH";
    throw err;
  }
  const actualMime = String(head?.ContentType || "").trim().toLowerCase();
  const requestedMime = String(declaredMime || "").trim().toLowerCase();
  if (requestedMime && actualMime && requestedMime !== actualMime) {
    const err = new Error("The uploaded document type does not match its stored object.");
    err.code = "CASE_FILE_METADATA_MISMATCH";
    throw err;
  }
  await validateStoredMatterFile({
    s3,
    bucket: S3_BUCKET,
    key: normalizedKey,
    mimeType: actualMime || requestedMime,
    filename: normalizedKey.split("/").pop(),
  });
  return head || null;
}

async function refreshMatterFileScan(file, key) {
  const stored = file?._id ? await CaseFile.collection.findOne({ _id: file._id }, { projection: { storageKey: 1, version: 1 } }) : null;
  if (file?._id && (!stored || stored.storageKey !== file.storageKey || Number(stored.version || 1) !== Number(file.version || 1))) throw Object.assign(new Error("The document changed before its security check."), { status: 409, publicCode: "DOWNLOAD_CHANGED" });
  const scan = await getObjectMalwareScan({ s3, bucket: S3_BUCKET, key });
  if (file?._id) {
    try { await matterFileWrites.persistScan(file, key, scan); }
    catch (error) { throw Object.assign(new Error("The document changed during its security check."), { status: error.status || 503, publicCode: "DOWNLOAD_CHANGED" }); }
  }
  return scan;
}

async function ensureFundsReleased(req, caseDoc, options = {}) {
  await options.beforeTransfer?.();
  const evidence = await completionPayoutEvidence.inspect(caseDoc);
  if (evidence.state === "needs_review") throw completionPayoutEvidence.reconciliationError();
  if (evidence.state === "recorded") {
    const payout = evidence.payout;
    caseDoc.paymentReleased = true;
    caseDoc.payoutTransferId = payout.transferId;
    caseDoc.payoutStatus = "paid";
    caseDoc.payoutFailureReason = "";
    caseDoc.paidOutAt = caseDoc.paidOutAt || payout.createdAt;
    return { payout: payout.amountPaid, transferId: payout.transferId, alreadyReleased: true };
  }
  const paralegal = caseDoc.paralegal;
  const bypassStripe = isStripeBypassPair(req, caseDoc, paralegal);
  if (!paralegal || !paralegal.stripeAccountId) {
    if (bypassStripe) {
      await ensureBypassConnectAccount(paralegal);
    }
    if (!paralegal || !paralegal.stripeAccountId) {
      throw new Error("Paralegal cannot be paid until onboarding completes.");
    }
  }
  if (!bypassStripe) {
    if (!paralegal.stripeOnboarded || !paralegal.stripePayoutsEnabled) {
      const refreshed = await ensureStripeOnboardedUser(paralegal);
      if (!refreshed) {
        throw new Error("Payment method needs to be updated before the payment can be released.");
      }
    }
    if (!paralegal.stripeOnboarded || !paralegal.stripePayoutsEnabled) {
      throw new Error("Payment method needs to be updated before the payment can be released.");
    }
  }
  const intentId = caseDoc.paymentIntentId || caseDoc.escrowIntentId;
  if (!intentId) {
    throw new Error("Matter has no funded payment intent.");
  }

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(intentId, {
      expand: ["latest_charge.balance_transaction"],
    });
  } catch (err) {
    logger.error("[cases] payment intent lookup failed", err?.message || err);
    throw new Error("Unable to verify Matter funding. Please try again.");
  }
  // Compare with the retained mode before assigning provider projections. A
  // missing or contradictory mode cannot authorize a new transfer.
  if (typeof paymentIntent?.livemode !== "boolean" || !require("../services/retainedPayoutMode").inspect(caseDoc, null, { livemode: paymentIntent.livemode })) {
    throw Object.assign(new Error("The payment provider mode could not be verified for this Matter."), { code: "PAYOUT_RECONCILIATION_REQUIRED", statusCode: 409 });
  }
  if (!caseDoc.paymentIntentId) caseDoc.paymentIntentId = paymentIntent.id;
  if (!caseDoc.escrowIntentId) caseDoc.escrowIntentId = paymentIntent.id;
  if (!caseDoc.currency) caseDoc.currency = paymentIntent.currency || caseDoc.currency || "usd";
  caseDoc.stripeMode = pickStripeMode(
    stripeModeFromLivemode(paymentIntent?.livemode),
    caseDoc.stripeMode,
    currentStripeMode()
  );

  const { transferable, charge } = stripe.isTransferablePaymentIntent(paymentIntent, {
    caseId: caseDoc._id,
  });
  const fundingIntegrity = validatePaymentIntentForCase(paymentIntent, caseDoc);
  if (!transferable || !fundingIntegrity.valid) {
    caseDoc.fundingIntegrityStatus = fundingIntegrity.valid ? "pending" : "failed";
    caseDoc.fundingIntegrityFailure = fundingIntegrity.reasons.join(",");
    throw new Error("Matter funding is not ready to release yet.");
  }
  caseDoc.fundingIntegrityStatus = "verified";
  caseDoc.fundingIntegrityFailure = "";
  caseDoc.fundingVerifiedAt = new Date();
  caseDoc.escrowStatus = "funded";
  caseDoc.paymentStatus = paymentIntent.status || caseDoc.paymentStatus || "succeeded";

  const budgetCents = Number(caseDoc.remainingAmount ?? caseDoc.lockedTotalAmount ?? (caseDoc.totalAmount || 0));
  if (!Number.isFinite(budgetCents) || budgetCents <= 0) {
    throw new Error("Matter total amount is invalid.");
  }
  const attorneyFee = computeAttorneyFeeAmount(budgetCents, caseDoc);
  const paralegalFeePct = resolveParalegalFeePct(caseDoc);
  const paralegalFee = Math.max(0, Math.round((budgetCents * paralegalFeePct) / 100));
  const payout = Math.max(0, budgetCents - paralegalFee);
  if (payout <= 0) {
    throw new Error("Calculated payout must be positive.");
  }

  const payoutClaim = await claimPaymentOperation({
    operationKey: `case_payout:${String(caseDoc._id)}`,
    caseId: caseDoc._id,
    kind: "case_payout",
    fingerprint: {
      paymentIntentId: paymentIntent.id,
      paralegalId: String(paralegal._id || caseDoc.paralegalId || ""),
      destination: paralegal.stripeAccountId,
      amount: payout,
      currency: caseDoc.currency || "usd",
    },
    amount: payout,
    currency: caseDoc.currency || "usd",
  });
  if (payoutClaim.conflict) {
    throw new Error("Payout details conflict with an existing payment operation. Admin review is required.");
  }
  if (payoutClaim.needsReconciliation) {
    throw new Error("This payout needs payment review before another release can be requested.");
  }
  if (payoutClaim.inProgress) {
    throw new Error("This payout is already being processed. Please wait before trying again.");
  }
  if (payoutClaim.completed || payoutClaim.operation.stripeTransferId || payoutClaim.operation.stripeObjectId) {
    // A competing request may have recorded a transfer after the initial read.
    // Require its paid ledger; never synthesize success from its identifier.
    const recorded = await completionPayoutEvidence.requireRecorded(caseDoc);
    caseDoc.paymentReleased = true;
    caseDoc.payoutTransferId = recorded.payout.transferId;
    caseDoc.payoutStatus = "paid";
    caseDoc.payoutFailureReason = "";
    caseDoc.paidOutAt = caseDoc.paidOutAt || recorded.payout.createdAt;
    return { payout: recorded.payout.amountPaid, transferId: recorded.payout.transferId, alreadyReleased: true };
  }
  caseDoc.payoutStatus = "pending";

  const transferPayload = {
    amount: payout,
    currency: caseDoc.currency || "usd",
    destination: paralegal.stripeAccountId,
    transfer_group: `case_${caseDoc._id}`,
    metadata: {
      caseId: String(caseDoc._id),
      attorneyId: String(caseDoc.attorney?._id || caseDoc.attorneyId || ""),
      paralegalId: String(paralegal._id || caseDoc.paralegalId || ""),
      operationKey: payoutClaim.operation.operationKey,
      description: "Matter completion payout",
    },
  };
  if (charge?.id) {
    transferPayload.source_transaction = charge.id;
  }

  if (options.beforeTransfer) {
    try { await options.beforeTransfer(); }
    catch (error) { await failPaymentOperation(payoutClaim.operation, error); throw error; }
  }
  let transfer;
  try {
    if (payoutClaim.operation.stripeTransferId) {
      transfer = { id: payoutClaim.operation.stripeTransferId };
    } else {
      transfer = await createPayoutTransfer({
        caseId: caseDoc._id,
        stripeClient: stripe,
        payload: transferPayload,
        operation: payoutClaim.operation,
        stripeMode: pickStripeMode(stripeModeFromLivemode(paymentIntent.livemode), caseDoc.stripeMode, currentStripeMode()),
        onTransfer: async known => { transfer = known; await options.afterTransfer?.(known.id); },
        stripeOptions: {
          idempotencyKey: stripe.stripeIdempotencyKey(
            "case_completion_payout",
            caseDoc._id,
            paralegal._id || caseDoc.paralegalId,
            payout,
            paymentIntent.id
          ),
        },
        bypassTransfer: bypassStripe ? { id: `bypass_${caseDoc._id}` } : null,
      });
    }
  } catch (err) {
    const needsReconciliation = Boolean(transfer?.id || err?.payoutTransferAttempted);
    await failPaymentOperation(payoutClaim.operation, err, { needsReconciliation, stripeObjectId: transfer?.id || "" }).catch(
      logPromiseFailure(logger, "[cases] failed payout operation could not be marked", { caseId: caseDoc._id })
    );
    await Case.updateOne(
      { _id: caseDoc._id, paymentReleased: { $ne: true }, payoutStatus: { $nin: ["failed", "reversed", "needs_reconciliation"] }, payoutTransferId: { $in: ["", null, caseDoc.payoutTransferId || "", transfer?.id || ""] } },
      { $set: { payoutStatus: needsReconciliation ? "needs_reconciliation" : "failed", payoutFailureReason: String(err?.message || err).slice(0, 500) } }
    ).catch(logPromiseFailure(logger, "[cases] payout failure state persistence failed", { caseId: caseDoc._id }));
    logger.error("Payout transfer failed.", {
      name: String(err?.name || "Error").slice(0, 80),
      code: String(err?.code || err?.type || "PAYOUT_TRANSFER_FAILED").slice(0, 100),
    });
    if (err?.publicCode) throw err;
    const message = stripe.sanitizeStripeError(
      err,
      needsReconciliation ? "This payout needs payment review before another release can be requested." : "We couldn't release the payment right now. Please try again shortly."
    );
    const failure = new Error(message);
    if (needsReconciliation) failure.code = "PAYOUT_RECONCILIATION_REQUIRED";
    throw failure;
  }
  try {
    await recordPaymentOperationEvidence(payoutClaim.operation, {
      transferId: transfer.id,
      transferAmount: payout,
    });
  } catch (err) {
    await failPaymentOperation(payoutClaim.operation, err, {
      needsReconciliation: true,
      stripeObjectId: transfer.id,
    }).catch(logPromiseFailure(logger, "[cases] payout evidence reconciliation operation marker failed", {
      caseId: caseDoc._id,
    }));
    await Case.updateOne(
      { _id: caseDoc._id, payoutStatus: { $nin: ["reversed", "failed"] }, payoutFailureReason: { $in: [null, ""] }, payoutTransferId: { $in: [null, "", transfer.id] } },
      {
        $set: {
          payoutTransferId: transfer.id,
          payoutStatus: "needs_reconciliation",
          payoutFailureReason: "The transfer was created, but its records require reconciliation before completion.",
        },
      }
    ).catch(logPromiseFailure(logger, "[cases] payout evidence reconciliation case marker failed", {
      caseId: caseDoc._id,
    }));
    if (err.publicCode) throw err;
    throw new Error("The transfer was created, but its evidence requires reconciliation before completion.");
  }

  const completedAt = caseDoc.completedAt || new Date();
  const paralegalName = `${paralegal.firstName || ""} ${paralegal.lastName || ""}`.trim() || "Paralegal";
  caseDoc.paymentReleased = true;
  caseDoc.payoutTransferId = transfer.id;
  caseDoc.payoutStatus = "paid";
  caseDoc.payoutFailureReason = "";
  caseDoc.paidOutAt = completedAt;
  caseDoc.completedAt = caseDoc.completedAt || completedAt;
  caseDoc.briefSummary = `${caseDoc.title} – ${paralegalName} – completed ${completedAt.toISOString().split("T")[0]}`;
  caseDoc.feeAttorneyPct = resolveAttorneyFeePct(caseDoc);
  caseDoc.feeAttorneyAmount = attorneyFee;
  caseDoc.feeParalegalPct = paralegalFeePct;
  caseDoc.feeParalegalAmount = paralegalFee;

  const attorneyObjectId = caseDoc.attorney?._id || caseDoc.attorneyId || caseDoc.attorney;
  const paralegalObjectId = paralegal._id || caseDoc.paralegalId || caseDoc.paralegal;
  const stripeMode = pickStripeMode(caseDoc.stripeMode, currentStripeMode());

  try {
    await withPayoutTransaction(async session => {
      await upsertPayoutLedger({
        operationKey: `case_payout:${String(caseDoc._id)}`,
        paralegalId: paralegalObjectId,
        caseId: caseDoc._id,
        amountPaid: payout,
        transferId: transfer.id,
        stripeMode,
      }, { session });
      await upsertPlatformIncomeLedger({
        operationKey: `case_payout:${String(caseDoc._id)}`,
        caseId: caseDoc._id,
        attorneyId: attorneyObjectId,
        paralegalId: paralegalObjectId,
        feeAmount: Math.max(0, (caseDoc.feeAttorneyAmount || attorneyFee || 0) + (paralegalFee || 0)),
        stripeMode,
      }, { session });
      await succeedPaymentOperation(payoutClaim.operation, transfer.id, { session });
    });
  } catch (err) {
    await failPaymentOperation(payoutClaim.operation, err, {
      needsReconciliation: true,
      stripeObjectId: transfer.id,
    }).catch(logPromiseFailure(logger, "[cases] payout ledger reconciliation operation marker failed", {
      caseId: caseDoc._id,
    }));
    await Case.updateOne(
      { _id: caseDoc._id, payoutStatus: { $nin: ["reversed", "failed"] }, payoutFailureReason: { $in: [null, ""] }, payoutTransferId: { $in: [null, "", transfer.id] } },
      {
        $set: {
          payoutTransferId: transfer.id,
          payoutStatus: "needs_reconciliation",
          payoutFailureReason: "Stripe transfer succeeded but the local payout ledger did not finalize.",
        },
      }
    ).catch(logPromiseFailure(logger, "[cases] payout ledger reconciliation case marker failed", {
      caseId: caseDoc._id,
    }));
    throw new Error("The transfer was created, but payout records need reconciliation before completion.");
  }

  await logAction(req, "case.release", {
    targetType: "case",
    targetId: caseDoc._id,
    caseId: caseDoc._id,
    meta: { payout, feeParalegalAmount: paralegalFee, transferId: transfer.id },
  });

  return { payout, transferId: transfer.id };
}

async function createPartialPayoutTransfer(req, caseDoc, paralegal, grossAmount, review = null) {
  const { gross, feePct, feeAmount, net } = computeParalegalFeeFromGross(grossAmount, caseDoc);
  if (gross <= 0 || net <= 0) {
    return { transferId: null, payout: 0, feePct, feeAmount, pending: false };
  }
  const bypassStripe = isStripeBypassPair(req, caseDoc, paralegal);
  if (!paralegal || !paralegal.stripeAccountId) {
    if (bypassStripe) {
      await ensureBypassConnectAccount(paralegal);
    }
    if (!paralegal || !paralegal.stripeAccountId) {
      return { transferId: null, payout: net, feePct, feeAmount, pending: true };
    }
  }
  if (!bypassStripe) {
    if (!paralegal.stripeOnboarded || !paralegal.stripePayoutsEnabled) {
      const refreshed = await ensureStripeOnboardedUser(paralegal);
      if (!refreshed) {
        return { transferId: null, payout: net, feePct, feeAmount, pending: true };
      }
    }
  }
  const intentId = caseDoc.paymentIntentId || caseDoc.escrowIntentId;
  if (!intentId) {
    throw new Error("Matter has no funded payment intent.");
  }
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(intentId, {
      expand: ["latest_charge.balance_transaction"],
    });
  } catch (err) {
    logger.error("[cases] payment intent lookup failed", err?.message || err);
    throw new Error("Unable to verify Matter funding. Please try again.");
  }
  if (review && (typeof paymentIntent?.livemode !== "boolean" || ["live", "test"].includes(caseDoc.stripeMode) && caseDoc.stripeMode !== (paymentIntent.livemode ? "live" : "test"))) throw new Error("The payment provider mode does not match this Matter.");
  if (!caseDoc.paymentIntentId) caseDoc.paymentIntentId = paymentIntent.id;
  if (!caseDoc.escrowIntentId) caseDoc.escrowIntentId = paymentIntent.id;
  if (!caseDoc.currency) caseDoc.currency = paymentIntent.currency || caseDoc.currency || "usd";
  caseDoc.stripeMode = pickStripeMode(
    stripeModeFromLivemode(paymentIntent?.livemode),
    caseDoc.stripeMode,
    currentStripeMode()
  );

  const { transferable, charge } = stripe.isTransferablePaymentIntent(paymentIntent, {
    caseId: caseDoc._id,
  });
  const fundingIntegrity = validatePaymentIntentForCase(paymentIntent, caseDoc);
  if (!transferable || !fundingIntegrity.valid) {
    caseDoc.fundingIntegrityStatus = fundingIntegrity.valid ? "pending" : "failed";
    caseDoc.fundingIntegrityFailure = fundingIntegrity.reasons.join(",");
    throw new Error("Matter funding is not ready to release yet.");
  }
  caseDoc.fundingIntegrityStatus = "verified";
  caseDoc.fundingIntegrityFailure = "";
  caseDoc.fundingVerifiedAt = new Date();
  caseDoc.escrowStatus = "funded";
  caseDoc.paymentStatus = paymentIntent.status || caseDoc.paymentStatus || "succeeded";

  const partialClaim = await claimPaymentOperation({
    operationKey: review?.operationKey || `partial_payout:${String(caseDoc._id)}:${String(paralegal._id || caseDoc.withdrawnParalegalId || "")}`,
    caseId: caseDoc._id,
    kind: "partial_payout",
    fingerprint: {
      paymentIntentId: paymentIntent.id,
      paralegalId: String(paralegal._id || caseDoc.withdrawnParalegalId || ""),
      destination: paralegal.stripeAccountId,
      gross,
      net,
      currency: caseDoc.currency || "usd",
    },
    amount: net,
    currency: caseDoc.currency || "usd",
  });
  if (partialClaim.conflict) {
    throw new Error("Partial payout details conflict with an existing payment operation. Admin review is required.");
  }
  if (partialClaim.needsReconciliation) {
    throw new Error("This payout needs payment review before another release can be requested.");
  }
  if (partialClaim.inProgress) {
    throw new Error("This partial payout is already being processed. Please wait before trying again.");
  }
  if (partialClaim.completed) {
    if (review) throw new Error("A prior payout operation requires review before another decision.");
    return {
      transferId: partialClaim.operation.stripeObjectId,
      payout: partialClaim.operation.amount,
      feePct,
      feeAmount,
      pending: false,
      reconciled: true,
      paymentOperationId: partialClaim.operation._id,
      paymentOperationKey: partialClaim.operation.operationKey,
    };
  }

  const transferPayload = {
    amount: net,
    currency: caseDoc.currency || "usd",
    destination: paralegal.stripeAccountId,
    transfer_group: `case_${caseDoc._id}`,
    metadata: {
      caseId: String(caseDoc._id),
      attorneyId: String(caseDoc.attorney?._id || caseDoc.attorneyId || ""),
      paralegalId: String(paralegal._id || ""),
      operationKey: partialClaim.operation.operationKey,
      description: "Matter withdrawal partial payout",
    },
  };
  if (charge?.id) {
    transferPayload.source_transaction = charge.id;
  }

  let transfer;
  try {
    if (review) { await review.beforeTransfer(); if (partialClaim.operation.stripeTransferId) throw new Error("An earlier transfer requires review."); }
    if (partialClaim.operation.stripeTransferId) {
      transfer = { id: partialClaim.operation.stripeTransferId };
    } else {
      review?.onAttempt();
      transfer = await createPayoutTransfer({
        caseId: caseDoc._id,
        stripeClient: stripe,
        payload: transferPayload,
        operation: partialClaim.operation,
        stripeMode: pickStripeMode(stripeModeFromLivemode(paymentIntent.livemode), caseDoc.stripeMode, currentStripeMode()),
        onTransfer: async known => { transfer = known; await review?.afterTransfer(known.id); },
        stripeOptions: {
          idempotencyKey: stripe.stripeIdempotencyKey(
            "withdrawal_partial_payout",
            caseDoc._id,
            paralegal._id,
            net,
            paymentIntent.id,
            ...(review ? [review.operationKey] : [])
          ),
        },
        bypassTransfer: bypassStripe ? { id: `bypass_${caseDoc._id}_${paralegal._id}` } : null,
      });
    }
    if (review) {
      if (!/^tr_[A-Za-z0-9_]+$/.test(transfer?.id || "")) throw new Error("The transfer result could not be verified.");
      if (transfer.object !== "transfer" || transfer.amount !== net || transfer.currency !== caseDoc.currency || String(transfer.destination?.id || transfer.destination || "") !== paralegal.stripeAccountId || transfer.transfer_group !== transferPayload.transfer_group || transfer.metadata?.caseId !== String(caseDoc._id) || transfer.metadata?.paralegalId !== String(paralegal._id) || String(transfer.source_transaction?.id || transfer.source_transaction || "") !== String(charge?.id || "") || transfer.livemode !== paymentIntent.livemode || transfer.reversed !== false || transfer.amount_reversed !== 0) throw new Error("The returned transfer does not match the reviewed withdrawal payout.");
    }
  } catch (err) {
    await failPaymentOperation(partialClaim.operation, err, { needsReconciliation: Boolean(review || transfer?.id || err?.payoutTransferAttempted), stripeObjectId: transfer?.id || "" }).catch(
      logPromiseFailure(logger, "[cases] failed partial payout operation could not be marked", {
        caseId: caseDoc._id,
      })
    );
    logger.error("[cases] partial payout transfer failed", err?.message || err);
    if (err?.publicCode) throw err;
    const message = stripe.sanitizeStripeError(
      err,
      transfer?.id || err?.payoutTransferAttempted ? "This payout needs payment review before another release can be requested." : "We couldn't release the payment right now. Please try again shortly."
    );
    throw new Error(message);
  }
  await recordPaymentOperationEvidence(partialClaim.operation, {
    transferId: transfer?.id || "",
    transferAmount: net,
  });
  return {
    transferId: transfer?.id || null,
    payout: net,
    feePct,
    feeAmount,
    pending: false,
    paymentOperationId: partialClaim.operation._id,
    paymentOperationKey: partialClaim.operation.operationKey,
    stripeMode: caseDoc.stripeMode,
    funding: { paymentIntentId: caseDoc.paymentIntentId, escrowIntentId: caseDoc.escrowIntentId, currency: caseDoc.currency, stripeMode: caseDoc.stripeMode, fundingIntegrityStatus: caseDoc.fundingIntegrityStatus, fundingIntegrityFailure: caseDoc.fundingIntegrityFailure, fundingVerifiedAt: caseDoc.fundingVerifiedAt, escrowStatus: caseDoc.escrowStatus, paymentStatus: caseDoc.paymentStatus },
  };
}

function withdrawalOptions(req) {
  return {
    transfer: (doc, person, amount, review) => createPartialPayoutTransfer(req, doc, person, amount, review),
    async afterCommit(raw, outcome) {
      const doc = Case.hydrate(raw), withdrawnId = raw.withdrawnParalegalId;
      publishCaseEvent(raw._id, "case", { at: new Date().toISOString() });
      publishCaseParticipantRefresh(doc, outcome.action === "reject" ? "matter_withdrawal_review_refresh" : outcome.action === "relist" ? "matter_relisted_refresh" : "matter_payout_refresh", [withdrawnId]);
      if (outcome.action === "partial") {
        try { await Case.populate(doc, [{ path: "attorney", select: "firstName lastName" }, { path: "withdrawnParalegalId", select: "firstName lastName" }]); await generateWithdrawalReceipts(doc, { grossAmount: outcome.amountCents }); } catch (error) { logger.warn("[cases] withdrawal receipt generation failed", error?.message || error); }
      }
    },
  };
}

// ----------------------------------------
// All case routes require auth + platform roles
// ----------------------------------------
router.use("/search", (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("admin", "attorney", "paralegal"));
router.use("/assigned-choices", require("./paralegalMatterChoices"));
router.use("/workspace-choices", require("./workspaceMatterChoices"));
router.use("/inventory", require("./attorneyMatterInventory")({
  presentCases: (docs, req) => presentCaseList(docs, { role: "attorney", viewerId: req.user.id, includeFiles: true, fileDetails: false, req }),
  caseProjection: Object.fromEntries(CASE_LIST_FIELDS.split(' ').filter(field => !['files', 'downloadUrl', 'internalNotes'].includes(field)).map(field => [field, 1])),
}));

router.use("/posting", require("./matterPostings")({
  practiceAreas: PRACTICE_AREAS, normalizePracticeArea, normalizeStatus: normalizeCaseStatusValue,
  parseDeadline, hasPendingInvites, buildBriefSummary,
  beforeCommit(req, type, doc, session) {
    return postingNotices.retain(req, { create: 'created', update: 'updated', delete: 'deleted' }[type], doc, session, { recipients: type === 'update' ? postingUpdateRecipients(doc, false, true) : [] });
  },
  async afterCommit(_req, type, doc, recipients = []) {
    const event = type === "create" ? "matter_published_refresh" : type === "delete" ? "matter_deleted_refresh" : "matter_updated_refresh";
    publishMatterDiscoveryEvent(event);
    publishCaseEvent(doc._id, "case", { at: new Date().toISOString(), type: event });
    publishCaseParticipantRefresh(doc, event, recipients);
    if (type === "update") publishCaseEvent(doc._id, "tasks", { at: new Date().toISOString() });
  },
}));

const authenticatedSearchRateLimit = createAuthenticatedSearchRateLimiter();

router.get(
  "/search",
  authenticatedSearchRateLimit,
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const viewerRole = String(req.user?.role || "").toLowerCase();
    if (!["attorney", "paralegal"].includes(viewerRole)) {
      return res.status(403).json({ error: "Search is available to attorneys and paralegals." });
    }
    const guard = validateSearchRead(req.query, req.user);
    if (guard.error) {
      const { status, ...body } = guard.error;
      return res.status(status).json(body);
    }
    const query = normalizeSearchQuery(req.query.q);
    if (query.length < SEARCH_QUERY_MIN) {
      return res.status(400).json({ error: `Enter at least ${SEARCH_QUERY_MIN} characters.` });
    }
    if (query.length > SEARCH_QUERY_MAX) {
      return res.status(400).json({ error: `Search is limited to ${SEARCH_QUERY_MAX} characters.` });
    }
    const types = parseSearchTypes(req.query.types);
    if (!types) return res.status(400).json({ error: "Unsupported search type." });

    const blockedIds = await getBlockedUserIds(req.user.id);
    const results = await searchAuthorizedObjects({
      query,
      types,
      viewer: req.user,
      blockedIds,
      Case,
      User,
    });
    return res.json({ query, types, results, ...(guard.ownerId ? { ownerId: guard.ownerId } : {}) });
  })
);

// ----------------------------------------
// Server-Sent Events for case updates
// ----------------------------------------
router.get(
  "/:caseId/status-history",
  verifyToken,
  requireCaseAccess("caseId", {
    project:
      "title status archived createdAt updatedAt hiredAt completedAt paymentReleased pausedReason pausedAt disputeDeadlineAt payoutFinalizedAt payoutFinalizedType relistRequestedAt disputes",
  }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only attorneys can view Matter history." });
    }
    const caseDoc = req.case;
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });

    const STATUS_LABELS = {
      open: "Posted",
      "in progress": "In Progress",
      completed: "Completed",
      disputed: "Disputed",
      archived: "Archived",
      closed: "Closed",
      paused: "Paused",
      withdrawn: "Withdrawn",
      hold: "24 Hour Hold",
      payout_finalized: "Payout Finalized",
      relisted: "Relisted",
    };
    const formatStatusLabel = (status) => {
      if (!status) return "";
      const key = normalizeCaseStatusValue(status);
      if (!key) return "";
      return (
        STATUS_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
      );
    };

    const actionMap = {
      "case.create": { label: "Posted", statusKey: "open" },
      "case.release": { label: "Payment Released", statusKey: "completed" },
      // This action happens after funds release as the case is locked and archived.
      "case.complete.archive": { label: "Archived", statusKey: "archived" },
      "case.withdrawal.requested": { label: "Withdrawn", statusKey: "withdrawn" },
      "case.withdrawal.reject": { label: "24 Hour Hold", statusKey: "hold" },
      "case.withdrawal.payout": { label: "Payout Finalized", statusKey: "payout_finalized" },
      "case.archive": { label: "Archived", statusKey: "archived" },
      "case.restore": { label: "Restored", statusKey: "open" },
      "case.terminate": { label: "Closed", statusKey: "closed" },
      "case.delete": { label: "Deleted", statusKey: "closed" },
    };
    const auditActions = Object.keys(actionMap);
    let logs = [];
    let complete = true;
    try {
      logs = await AuditLog.find({ case: caseDoc._id, action: { $in: auditActions } })
        .sort({ createdAt: 1 })
        .populate("actor", "firstName lastName")
        .lean();
    } catch (err) {
      logs = [];
      complete = false;
    }

    const items = [];
    const addedEntries = new Set();
    const hasLabel = (label) => items.some((item) => item.label === label);
    const hasStatusKey = (statusKey) => items.some((item) => item.statusKey === statusKey);
    const pushItem = (label, at, statusKey, actorName = "") => {
      if (!label || !at) return;
      const date = new Date(at);
      if (Number.isNaN(date.getTime())) return;
      const iso = date.toISOString();
      const sig = `${label}|${iso}`;
      if (addedEntries.has(sig)) return;
      items.push({ label, at: iso, statusKey: statusKey || null, ...(actorName ? { actorName } : {}) });
      addedEntries.add(sig);
    };

    logs.forEach((entry) => {
      const mapping = actionMap[entry.action];
      if (!mapping) return;
      const actorName = [entry.actor?.firstName, entry.actor?.lastName].filter(Boolean).join(" ");
      pushItem(mapping.label, entry.createdAt, mapping.statusKey, actorName);
    });

    if (!hasStatusKey("open")) {
      pushItem("Posted", caseDoc.createdAt, "open");
    }
    if (caseDoc.hiredAt) {
      if (!hasStatusKey("in progress")) {
        pushItem("In Progress", caseDoc.hiredAt, "in progress");
      }
    }

    if (caseDoc.pausedReason === "paralegal_withdrew") {
      if (!hasStatusKey("withdrawn")) {
        pushItem("Withdrawn", caseDoc.pausedAt, "withdrawn");
      }
      if (caseDoc.disputeDeadlineAt && !caseDoc.payoutFinalizedAt) {
        const holdStart = new Date(caseDoc.disputeDeadlineAt).getTime() - DISPUTE_WINDOW_MS;
        if (holdStart > 0 && !hasStatusKey("hold")) {
          pushItem("24 Hour Hold", new Date(holdStart), "hold");
        }
      }
    } else if (String(caseDoc.status || "").toLowerCase() === "paused" && caseDoc.pausedAt && !hasStatusKey("paused")) {
      pushItem("Paused", caseDoc.pausedAt, "paused");
    }

    const disputes = Array.isArray(caseDoc.disputes) ? caseDoc.disputes : [];
    if (disputes.length) {
      const latest = disputes
        .map((d) => d?.createdAt)
        .filter(Boolean)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
        .pop();
      if (latest && !hasStatusKey("disputed")) {
        pushItem("Disputed", latest, "disputed");
      }
    }

    if (!hasStatusKey("payout_finalized")) {
      pushItem("Payout Finalized", caseDoc.payoutFinalizedAt, "payout_finalized");
    }
    if (!hasStatusKey("relisted")) {
      pushItem("Relisted", caseDoc.relistRequestedAt, "relisted");
    }
    if ((caseDoc.completedAt || caseDoc.paymentReleased) && !hasLabel("Completed")) {
      pushItem("Completed", caseDoc.completedAt || caseDoc.updatedAt, "completed");
    }
    if (caseDoc.archived && !hasLabel("Archived")) {
      pushItem("Archived", caseDoc.updatedAt, "archived");
    }

    const currentStatus = normalizeCaseStatusValue(caseDoc.status);
    if (currentStatus) {
      const label = formatStatusLabel(currentStatus);
      if (!hasLabel(label || currentStatus)) {
        pushItem(label || currentStatus, caseDoc.updatedAt, currentStatus);
      }
    }

    items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    res.json({
      caseId: String(caseDoc._id),
      caseTitle: caseDoc.title || "Untitled Matter",
      items,
      complete,
    });
  })
);

router.get(
  "/:caseId/applicants",
  requireCaseAccess("caseId", {
    allowApplicants: true,
    alsoAllow: (req, caseDoc) => {
      if (String(req.user.role).toLowerCase() !== "paralegal") return false;
      const isOpen = caseDoc.status === "open" && !caseDoc.archived;
      const hasHire = !!caseDoc.paralegal;
      if (isOpen && !hasHire) return true;
      if (caseDoc.status === "paused" && caseDoc.relistRequestedAt) return true;
      return false;
    },
    project:
      "status paralegal paralegalId attorney applicants archived withdrawnParalegalId paralegalNameSnapshot pausedReason disputeDeadlineAt payoutFinalizedAt relistRequestedAt relistPending readOnly totalAmount lockedTotalAmount remainingAmount paymentReleased practiceArea jobId job preEngagement invites pendingParalegalId pendingParalegalInvitedAt",
  }),
  asyncHandler(async (req, res) => {
    const doc = await Case.findById(req.params.caseId)
      .select(
        "title status practiceArea paymentReleased totalAmount lockedTotalAmount remainingAmount readOnly paralegal paralegalId applicants jobId job relistRequestedAt relistPending payoutFinalizedAt disputeDeadlineAt preEngagement invites pendingParalegalId pendingParalegalInvitedAt"
      )
      .populate("paralegal", "firstName lastName email role profileImage avatarURL")
      .populate("applicants.paralegalId", "firstName lastName email role profileImage avatarURL");
    if (!doc) return res.status(404).json({ error: "Matter not found" });


    const applicationSnapshot = await legacyApplications.begin(req, [doc], { detailed: true });
    const applicants = legacyApplications.present(applicationSnapshot, doc._id, req.user, { withPreEngagement: true });

    await applicationSnapshot.verify();
    res.set("Cache-Control", "private, no-store");
    res.json({
      id: String(doc._id),
      _id: doc._id,
      title: doc.title,
      status: normalizeCaseStatusValue(doc.status),
      practiceArea: doc.practiceArea || "",
      paymentReleased: doc.paymentReleased || false,
      totalAmount: doc.totalAmount || 0,
      lockedTotalAmount: typeof doc.lockedTotalAmount === "number" ? doc.lockedTotalAmount : null,
      remainingAmount: resolveRemainingAmount(doc),
      readOnly: !!doc.readOnly,
      relistRequestedAt: doc.relistRequestedAt || null,
      relistPending: !!doc.relistPending,
      payoutFinalizedAt: doc.payoutFinalizedAt || null,
      disputeDeadlineAt: doc.disputeDeadlineAt || null,
      paralegal: doc.paralegal || null,
      paralegalId: doc.paralegalId || null,
      applicants,
    });
  })
);

router.get(
  "/:caseId/stream",
  ensureCaseParticipant(),
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId;
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }
    if (req.socket) {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true);
    }
    res.write(`event: ready\ndata: ${JSON.stringify({ caseId, at: new Date().toISOString() })}\n\n`);

    const unsubscribe = addSubscriber(caseId, res);
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: ping\ndata: {}\n\n`);
      } catch {
        /* ignore */
      }
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("error", cleanup);
  })
);

// Invitations (must run before ensureCaseParticipant to allow pending paralegals)
const matterInvitationActions = require("../services/matterInvitationActions");
function invitationReviewNoStore(_req, res, next) { res.set("Cache-Control", "private, no-store"); next(); }
function invitationReviewError(res, error) { return res.status(error.status || 503).json({ code: error.publicCode || "INVITATION_UNAVAILABLE", error: "The invitation could not be verified. Review the Matter and invitation status before trying again." }); }
router.get("/invitation-options/:paralegalId", invitationReviewNoStore, async (req, res) => {
  try { return res.json(await matterInvitationActions.options(req)); } catch (error) { return invitationReviewError(res, error); }
});
router.get("/:caseId/invitation-review/:paralegalId", invitationReviewNoStore, async (req, res) => {
  try { return res.json(await matterInvitationActions.read(req, STRIPE_BYPASS_PARALEGAL_EMAILS)); } catch (error) { return invitationReviewError(res, error); }
});
async function reviewedInvitation(req, res, paralegalId) {
  if (req.body?.reviewedRevision === undefined) return undefined;
  try { return await matterInvitationActions.reviewed(req, paralegalId, STRIPE_BYPASS_PARALEGAL_EMAILS); }
  catch (error) { invitationReviewError(res, error); return null; }
}
router.post(
  "/:caseId/invite/:paralegalId",
  csrfProtection,
  asyncHandler(async (req, res, next) => {
    const role = String(req.user?.role || "").toLowerCase();
    const { caseId, paralegalId } = req.params;

    // Avoid catching the accept/decline routes below
    if (["accept", "decline", "revoke"].includes(String(paralegalId || "").toLowerCase())) {
      return next("route");
    }

    if (!["attorney", "admin"].includes(role)) {
      return res.status(403).json({ error: "Only attorneys can invite paralegals" });
    }
    if (!isObjId(caseId) || !isObjId(paralegalId)) {
      return res.status(400).json({ error: "Invalid caseId or paralegalId" });
    }

    const [caseDoc, paralegal] = await Promise.all([
      Case.findById(caseId),
      User.findById(paralegalId).select(
        "role status firstName lastName email stripeAccountId stripeOnboarded stripePayoutsEnabled stripeChargesEnabled"
      ),
    ]);
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }
    if (role !== "admin" && !isCaseAttorneyUser(caseDoc, req.user.id)) {
      return res.status(403).json({ error: "You are not the attorney for this Matter" });
    }
    if (!paralegal || String(paralegal.role).toLowerCase() !== "paralegal" || String(paralegal.status).toLowerCase() !== "approved") {
      return res.status(400).json({ error: "Paralegal is not available for invitation" });
    }
    const paralegalEmail = normalizeEmail(paralegal.email);
    const bypassStripe = STRIPE_BYPASS_PARALEGAL_EMAILS.has(paralegalEmail);
    if (!bypassStripe) {
      if (!paralegal.stripeAccountId) {
        return res.status(403).json({ error: "Paralegal must connect Stripe before being invited." });
      }
      if (!paralegal.stripeOnboarded || !paralegal.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboardedUser(paralegal);
        if (!refreshed) {
          return res.status(403).json({ error: "Paralegal must complete Stripe onboarding before being invited." });
        }
      }
    }
    const caseAttorneyId = resolveCaseAttorneyIds(caseDoc)[0] || null;
    const partiesBlocked = Boolean(caseAttorneyId && (await isBlockedBetween(caseAttorneyId, paralegal._id)));
    if (partiesBlocked) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    if (caseDoc.paralegalId) {
      return res.status(400).json({ error: "A paralegal is already assigned to this Matter" });
    }

    seedLegacyInvite(caseDoc);
    const existingInvite = listCaseInvites(caseDoc).find(
      (invite) => String(invite.paralegalId) === String(paralegal._id)
    );
    if (existingInvite) {
      if (existingInvite.status === "pending") {
        return res.status(400).json({ error: "An invitation is already pending for this paralegal." });
      }
      if (existingInvite.status === "accepted") {
        return res.status(400).json({ error: "This paralegal has already accepted." });
      }
    }
    const invitationPolicy = evaluateInvitationEligibility({
      caseDoc,
      ownerAuthorized: role === "admin" || isCaseAttorneyUser(caseDoc, req.user.id),
      targetSelected: true,
      paralegalApproved:
        String(paralegal.role || "").toLowerCase() === "paralegal" &&
        String(paralegal.status || "").toLowerCase() === "approved",
      payoutSetupReady:
        bypassStripe || Boolean(paralegal.stripeAccountId && paralegal.stripeOnboarded && paralegal.stripePayoutsEnabled),
      partiesBlocked,
      existingInviteStatus: String(existingInvite?.status || "").toLowerCase(),
    });
    if (!invitationPolicy.ready) {
      return res.status(400).json({ error: "This invitation is not ready to send.", blockers: invitationPolicy.blockers });
    }

    const reviewed = await reviewedInvitation(req, res, paralegal._id);
    if (reviewed === null) return;
    const invitationResult = await sendInvitationWithNotices(res, { caseDoc, paralegalId: paralegal._id, reviewed, actorId: req.user.id, authVersion: req.authVersion });
    if (!invitationResult) return;
    if (!invitationResult.sent) {
      const messages = {
        already_pending: "An invitation is already pending for this paralegal.",
        already_accepted: "This paralegal has already accepted.",
        already_assigned: "A paralegal is already assigned to this Matter.",
        matter_closed: "This Matter is no longer accepting invitations.",
        ownership_conflict: "Matter ownership needs review before invitations can be sent.",
      };
      return res.status(409).json({
        error: messages[invitationResult.reason] || "The invitation could not be sent because the matter changed.",
        code: "INVITATION_CONFLICT",
      });
    }
    const updatedCase = await Case.findById(caseDoc._id);
    publishCaseEvent(caseDoc._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(updatedCase || caseDoc, "matter_invitation_sent_refresh", [paralegal._id]);

    await invitationResult.dispatch?.().catch(error => logger.warn("[cases] saved invitation refresh deferred", { caseId: caseDoc._id, error }));

    return res.json({ ...caseSummary(updatedCase || caseDoc, { viewerRole: req.user?.role }), ...(invitationResult.confirmation ? { invitationConfirmation: invitationResult.confirmation } : {}) });
  })
);

router.post(
  "/:caseId/respond-invite",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const role = String(req.user?.role || "").toLowerCase();
    if (role !== "paralegal" && role !== "admin") {
      return res.status(403).json({ error: "Only the invited paralegal may respond" });
    }
    const { caseId } = req.params;
    const decision = String(req.body?.decision || "").toLowerCase();
    if (!["accept", "decline"].includes(decision)) {
      return res.status(400).json({ error: "Decision must be accept or decline" });
    }
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid Matter ID" });

    const { caseDoc, legacyInvitation } = await require("../services/legacyInvitationResponse").load(caseId, role === "admin" && isObjId(req.body?.paralegalId) ? req.body.paralegalId : req.user.id);
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }
    const attorneyId = caseDoc.attorneyId || caseDoc.attorney;
    const paralegalId = role === "admin" && req.body?.paralegalId && isObjId(req.body.paralegalId)
      ? req.body.paralegalId
      : req.user.id;
    const inviteRecord = listCaseInvites(caseDoc).find(
      (invite) => String(invite.paralegalId) === String(paralegalId)
    );
    const expectedInviteStatus = decision === "accept" ? "accepted" : "declined";
    if (!inviteRecord || !["pending", expectedInviteStatus].includes(inviteRecord.status)) {
      return res.status(400).json({ error: "No pending invitation for this paralegal." });
    }
    if (role !== "admin" && String(paralegalId) !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not the invited paralegal" });
    }
    const assignedParalegalId = caseDoc.paralegalId || caseDoc.paralegal;
    if (assignedParalegalId && String(assignedParalegalId) !== String(paralegalId)) {
      return res.status(400).json({ error: "This Matter is already assigned to another paralegal." });
    }
    const paralegalProfile = await User.findById(paralegalId).select(
      "firstName lastName email stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled resumeURL linkedInURL availability availabilityDetails location languages specialties yearsExperience bio profileImage avatarURL"
    );
    const resumeReference = paralegalProfile ? captureResumeReference(paralegalProfile) : null;

    if (decision === "accept" && inviteRecord.status === "pending") {
      if (!hasScopeTasks(caseDoc)) {
        return res.status(400).json({
          error: "Add at least one task before hiring a paralegal for this Matter.",
        });
      }
      if (attorneyId && (await isBlockedBetween(attorneyId, paralegalId))) {
        return res.status(403).json({ error: BLOCKED_MESSAGE });
      }
      if (!paralegalProfile?.stripeAccountId) {
        return res.status(403).json({ error: "Connect Stripe before accepting invitations." });
      }
      if (!paralegalProfile?.stripeOnboarded || !paralegalProfile?.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboardedUser(paralegalProfile);
        if (!refreshed) {
          return res.status(403).json({ error: "Complete Stripe onboarding before accepting invitations." });
        }
      }
    }

    const respondedAt = new Date();
    const invitationResult = await respondToInvitation({
      caseId,
      legacyInvitation,
      actorId: req.user.id,
      authVersion: req.authVersion,
      paralegalId,
      decision,
      resumeReference,
      requirementAnswers: req.body?.requirementAnswers,
      respondedAt,
      lockedTotalAmount: caseDoc.lockedTotalAmount ?? caseDoc.totalAmount,
      amountLockedAt: caseDoc.amountLockedAt || respondedAt,
      paralegalProfile: {
        resumeURL: paralegalProfile?.resumeURL || "",
        linkedInURL: paralegalProfile?.linkedInURL || "",
        profileSnapshot: shapeParalegalSnapshot(paralegalProfile),
      },
    });
    if (!invitationResult.updated && !invitationResult.idempotent) {
      return res.status(409).json({
        error:
          invitationResult.reason === "already_assigned"
            ? "This Matter is already assigned to another paralegal."
            : "This invitation has already changed.",
        code: "INVITATION_CONFLICT",
      });
    }

    const updatedCase = await Case.findById(caseId);
    if (invitationResult.updated) {
      publishCaseEvent(caseDoc._id, "case", { at: new Date().toISOString() });
      publishCaseParticipantRefresh(updatedCase || caseDoc, "matter_invitation_response_refresh", [paralegalId]);
    }
    await invitationResult.dispatch?.().catch(error => logger.warn("[cases] saved invitation response refresh deferred", { caseId, error }));

    return res.json({
      ...caseSummary(updatedCase || caseDoc, { viewerRole: req.user?.role }),
      alreadyProcessed: invitationResult.idempotent === true,
      reconciliationPending: invitationResult.reconciliationPending === true,
    });
  })
);

router.get(
  "/:caseId/invites",
  (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); },
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const actorId = String(req.user.id || req.user._id);
    if (req.query.expectedOwnerId !== undefined && req.query.expectedOwnerId !== actorId) {
      return res.status(403).json({ error: "The signed-in account changed.", code: "INVITATION_ACCOUNT_CHANGED" });
    }
    if (!req.acl?.isAttorney && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the Matter attorney can view invited paralegals." });
    }
    try { return res.json(await require("../services/matterInvitations").read(req)); }
    catch (error) { return invitationReviewError(res, error); }
  })
);

router.get(
  "/:caseId/application-inventory",
  (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); },
  requireCaseAccess("caseId"),
  async (req, res) => {
    try { return res.json(await require("../services/applicationInventory").read(req)); }
    catch (error) {
      return res.status(error.status || 503).json({ code: error.publicCode || "APPLICATION_REVIEW_UNAVAILABLE", error: error.publicCode ? error.message : "Applications could not be loaded. Refresh to try again." });
    }
  }
);

router.get(
  "/:caseId/application-review",
  (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); },
  requireCaseAccess("caseId"),
  async (req, res) => {
    try { return res.json(await require("../services/matterApplications").read(req)); }
    catch (error) {
      return res.status(error.status || 503).json({ code: error.publicCode || "APPLICATION_REVIEW_UNAVAILABLE", error: error.publicCode ? error.message : "Applications could not be loaded. Refresh to try again." });
    }
  }
);

const ensureCaseParticipantMiddleware = ensureCaseParticipant();
router.use((req, res, next) => {
  const caseId = req.params?.caseId;
  if (!caseId || !isObjId(caseId)) {
    return next();
  }
  return ensureCaseParticipantMiddleware(req, res, next);
});

/**
 * POST /api/cases
 * Create a new case/job posting (attorney or admin only).
 */
router.post(
  "/",
  requireRole("admin", "attorney"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const {
      title,
      practiceArea,
      description,
      details,
      questions,
      employmentType,
      experience,
      instructions,
      deadline,
      tasks,
    } = req.body || {};
    const safeTitle = cleanTitle(title || "", 300);
    const questionList = parseListField(questions);
    const combinedDetails = [details || description, instructions]
      .filter(Boolean)
      .map((entry) => cleanText(entry, { max: 100_000 }))
      .join("\n\n");
    const narrative = cleanText(buildDetails(combinedDetails, questionList), { max: 100_000 });
    if (!safeTitle || !narrative) {
      return res.status(400).json({ error: "Title and a short description are required." });
    }
    const normalizedPractice = normalizePracticeArea(practiceArea);
    if (!normalizedPractice) {
      return res.status(400).json({ error: "Select a valid practice area." });
    }

    const currency = cleanString(req.body?.currency || "usd", { len: 8 }).toLowerCase() || "usd";
    const stateInput = req.body?.state || req.body?.locationState || "";
    const normalizedState = cleanString(stateInput, { len: 200 });
    const amountInput =
      req.body?.totalAmount ??
      req.body?.budget ??
      req.body?.compensationAmount ??
      req.body?.compAmount ??
      req.body?.compensation;
    const amountCents = dollarsToCents(amountInput);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: "Budget must be greater than $0." });
    }
    if (amountCents < MIN_CASE_AMOUNT_CENTS) {
      return res.status(400).json({ error: MIN_CASE_AMOUNT_MESSAGE });
    }

    const parsedDeadline = parseDeadline(deadline);
    if (deadline && !parsedDeadline) {
      return res.status(400).json({ error: "Invalid deadline provided." });
    }

    const normalizedTasks = normalizeScopeTasks(tasks);
    const postingPolicy = evaluateMatterPosting({
      title: safeTitle,
      details: narrative,
      practiceArea: normalizedPractice,
      amountCents,
      deadlineProvided: Boolean(deadline),
      deadlineValid: !deadline || Boolean(parsedDeadline),
      attorneyStateRequired: false,
    });
    if (!postingPolicy.ready) {
      return res.status(400).json({ error: "This matter is not ready to publish.", blockers: postingPolicy.blockers });
    }
    let created, publicationDispatch;
    try {
      created = await withActiveAccountWrite([req.user.id], async session => {
        const [created] = await Case.create([{
      title: safeTitle,
      practiceArea: normalizedPractice,
      details: narrative,
      attorney: req.user.id,
      attorneyId: req.user.id,
      status: "open",
      totalAmount: amountCents,
      currency,
      deadlineDate: parsedDeadline?.dateOnly || "",
      deadline: parsedDeadline?.legacyDate || null,
      state: normalizedState,
      locationState: normalizedState,
      experiencePreference: cleanString(experience || "", { len: 200 }),
      minimumYearsExperience: parseMinimumYears(experience),
      tasks: normalizedTasks,
      briefSummary: buildBriefSummary({ state: normalizedState, employmentType, experience }),
      updates: [
        {
          date: new Date(),
          text: "Case posted",
          by: req.user.id,
        },
      ],
        }], { session });

      const budgetDollars = Math.max(1, Math.round((amountCents || 0) / 100) || 0);
        const [createdJob] = await Job.create([{
        caseId: created._id,
        attorneyId: req.user.id,
        title: created.title,
        practiceArea: created.practiceArea,
        description: created.details,
        budget: budgetDollars,
        status: "open",
        state: normalizedState,
        locationState: normalizedState,
        experiencePreference: created.experiencePreference || "",
        minimumYearsExperience: Number(created.minimumYearsExperience || 0),
        }], { session });
      created.jobId = createdJob._id;
      await created.save({ session });
        publicationDispatch = await postingNotices.retain(req, "created", created, session);
        return created;
      }, { ownerId: req.user.id, authVersion: req.auth?.payload?.av });
    } catch (jobErr) {
      if (jobErr.publicCode) throw jobErr;
      logger.error("[cases] posting creation rolled back", jobErr?.message || jobErr);
      return res.status(503).json({ error: "Unable to publish this matter right now. No posting was created; please try again.", code: "POSTING_CREATION_FAILED" });
    }
    await created.populate([
      { path: "paralegal", select: "firstName lastName email role avatarURL" },
      { path: "attorney", select: "firstName lastName email role avatarURL" },
    ]);

    await dispatchPostingNotice(publicationDispatch);

    publishMatterDiscoveryEvent("matter_published_refresh");
    res.status(201).json(caseSummary(created, { viewerRole: req.user?.role }));
  })
);

/**
 * GET /api/cases/posted
 * List open/active postings for the authenticated attorney (or all if admin).
 */
router.get(
  "/posted",
  requireRole("admin", "attorney"),
  asyncHandler(async (req, res) => {
    const filter = {
      archived: { $ne: true },
      status: {
        $in: [
          "open",
          IN_PROGRESS_STATUS,
          LEGACY_IN_PROGRESS_STATUS,
          "paused",
          "assigned",
          "awaiting_funding",
          "active",
          "awaiting_documents",
          "reviewing",
        ],
      },
    };
    if (req.user.role !== "admin") {
      filter.$or = [{ attorney: { $in: applicationRefs(req.user.id) } }, { attorneyId: { $in: applicationRefs(req.user.id) } }];
    }

    const docs = await readCaseList(filter, { select: "title practiceArea status pausedReason pausedAt disputeDeadlineAt partialPayoutAmount payoutFinalizedAt payoutFinalizedType withdrawnParalegalId relistRequestedAt relistPending remainingAmount totalAmount lockedTotalAmount currency applicants paralegal hiredAt createdAt briefSummary details escrowStatus escrowIntentId", sort: { createdAt: -1 }, populate: [] });

    const applications = await legacyApplications.begin(req, docs);
    const items = docs.map((doc) => ({
      id: doc._id,
      title: doc.title,
      practiceArea: doc.practiceArea,
      status: normalizeCaseStatusValue(doc.status),
      totalAmount: doc.totalAmount || 0,
      remainingAmount: resolveRemainingAmount(doc),
      currency: doc.currency || "usd",
      applicants: doc.applicants || [],
      applicantsCount: applications.counts.get(String(doc._id).toLowerCase()),
      paralegal: doc.paralegal || null,
      hiredAt: doc.hiredAt || null,
      escrowStatus: doc.escrowStatus || null,
      escrowIntentId: doc.escrowIntentId || null,
      createdAt: doc.createdAt,
      briefSummary: doc.briefSummary || "",
    }));

    await applications.verify();
    res.set("Cache-Control", "private, no-store");
    res.json({ items });
  })
);

/**
 * GET /api/cases/admin
 * Admin overview of recent cases for the posts dashboard.
 */
router.get(
  "/admin",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 250, 1, 1000);
    const page = clamp(parseInt(req.query.page, 10) || 1, 1, 100000);
    const skip = (page - 1) * limit;
    const statusFilter = String(req.query.status || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const query = {};
    if (statusFilter.length) {
      query.status = { $in: statusFilter };
    }
    if (req.query.attorney && isObjId(req.query.attorney)) {
      query.$or = [{ attorney: { $in: applicationRefs(req.query.attorney) } }, { attorneyId: { $in: applicationRefs(req.query.attorney) } }];
    }

    const scopedCount = (condition) =>
      Case.collection.countDocuments(Object.keys(query).length ? { $and: [query, condition] } : condition);
    const activePostCondition = {
      archived: { $ne: true },
      paymentReleased: { $ne: true },
      $or: [
        { status: "open" },
        { status: "paused", relistRequestedAt: { $ne: null }, payoutFinalizedAt: { $ne: null } },
      ],
    };
    const moderationCondition = {
      $or: [
        { "flags.0": { $exists: true } },
        { moderationStatus: { $in: ["flagged", "resolution_requested"] } },
      ],
    };

    const [docs, total, active, archived, flagged] = await Promise.all([
      readCaseList(query, { sort: { createdAt: -1 }, limit, skip, populate: [{ path: "attorney", select: "firstName lastName email role" }] }),
      Case.collection.countDocuments(query),
      scopedCount(activePostCondition),
      scopedCount({ archived: true }),
      scopedCount(moderationCondition),
    ]);

    const summaries = await presentCaseList(docs, { role: req.user.role, viewerId: req.user.id, includeFiles: false, req });
    const cases = summaries.map((summary) => {
      const attorney = summary.attorney;
      const authorName =
        attorney?.name ||
        [attorney?.firstName, attorney?.lastName].filter(Boolean).join(" ") ||
        attorney?.email ||
        "Unknown";
      return {
        ...summary,
        authorName,
        category: summary.practiceArea || "",
      };
    });

    res.json({ cases, total, summary: { total, active, archived, flagged } });
  })
);

/**
 * GET /api/cases/my
 * Returns the most recent cases relevant to the authenticated user.
 */
router.get(
  "/my",
  verifyToken.optional,
  asyncHandler(async (req, res) => {
    const user = req.user;
    const limit = clamp(parseInt(req.query.limit, 10) || 12, 1, 100);
    if (!user || !user.role) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const role = user.role;
    const userId = user.id;

    const includeFiles = role !== "admin" && String(req.query.withFiles || "").toLowerCase() === "true";
    const userObjectId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : null;
    const filter = {};
    const ownershipFilters = [];
    const allVariants = userObjectId ? applicationRefs(userId) : [userId];
    const includeAttorneyFilters = () => {
      allVariants.forEach((value) => {
        ownershipFilters.push({ attorney: value }, { attorneyId: value });
      });
    };
    includeAttorneyFilters();
    const includeParalegalFilters = () => {
      allVariants.forEach((value) => {
        ownershipFilters.push(
          { paralegal: value },
          { paralegalId: value },
          { "applicants.paralegalId": value }
        );
      });
    };
    includeParalegalFilters();

    if (role === "attorney") {
      filter.$or = ownershipFilters.filter((entry) => entry.attorney !== undefined || entry.attorneyId !== undefined);
    } else if (role === "paralegal") {
      filter.$or = ownershipFilters.filter(
        (entry) =>
          entry.paralegal !== undefined ||
          entry.paralegalId !== undefined ||
          entry["applicants.paralegalId"] !== undefined
      );
    } else {
      // admin: optional filter by attorney/paralegal query params
      if (req.query.attorney && isObjId(req.query.attorney)) filter.attorney = { $in: applicationRefs(req.query.attorney) };
      if (req.query.paralegal && isObjId(req.query.paralegal)) filter.paralegal = { $in: applicationRefs(req.query.paralegal) };
    }

    if (role === "attorney" || role === "admin") {
      const wantArchived = String(req.query.archived || "").toLowerCase() === "true";
      if (wantArchived) {
        filter.$and = [
          ...(filter.$and || []),
          {
            $or: [
              { archived: true },
              { paymentReleased: true },
              { status: { $in: ATTORNEY_ARCHIVED_BUCKET_STATUSES.filter((status) => status !== "paused") } },
              {
                status: "paused",
                $or: [{ relistRequestedAt: null }, { relistRequestedAt: { $exists: false } }],
              },
            ],
          },
        ];
      } else {
        filter.archived = { $ne: true };
        filter.$and = [
          ...(filter.$and || []),
          { paymentReleased: { $ne: true } },
          {
            $or: [
              { status: { $nin: ATTORNEY_ARCHIVED_BUCKET_STATUSES } },
              { status: "paused", relistRequestedAt: { $ne: null } },
            ],
          },
        ];
      }
    } else if (typeof req.query.archived !== "undefined") {
      const wantArchived = String(req.query.archived).toLowerCase() === "true";
      filter.archived = wantArchived ? true : { $ne: true };
    } else {
      filter.archived = { $ne: true };
    }
    if (role === "paralegal") {
      filter.$and = [
        ...(filter.$and || []),
        { status: { $ne: "completed" } },
        { paymentReleased: { $ne: true } },
      ];
    }

    const docs = await readCaseList(filter, { select: CASE_LIST_FIELDS, sort: { updatedAt: -1 }, limit: limit, populate: [{ path: 'paralegalId', select: 'firstName lastName email role avatarURL' }, { path: 'attorneyId', select: 'firstName lastName email role avatarURL' }, { path: 'paralegal', select: 'firstName lastName email role avatarURL' }, { path: 'attorney', select: 'firstName lastName email role avatarURL' }, { path: 'internalNotes.updatedBy', select: 'firstName lastName email role avatarURL' }] });

    const payload = await presentCaseList(docs, { role, viewerId: req.user?.id, includeFiles, req });

    res.json(payload);
  })
);

router.get(
  "/my-active",
  requireRole("attorney"),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 50, 1, 200);
    const filter = {
      $or: [{ attorney: { $in: applicationRefs(req.user.id) } }, { attorneyId: { $in: applicationRefs(req.user.id) } }],
      archived: { $ne: true },
      status: { $nin: ["completed", "closed", "cancelled"] },
    };
    const docs = await readCaseList(filter, { select: "title practiceArea status pausedReason pausedAt disputeDeadlineAt partialPayoutAmount payoutFinalizedAt payoutFinalizedType withdrawnParalegalId relistRequestedAt relistPending remainingAmount escrowStatus deadline deadlineDate zoomLink paymentReleased escrowIntentId jobId createdAt updatedAt attorney attorneyId paralegal paralegalId pendingParalegalId pendingParalegalInvitedAt invites moderationStatus moderationFlaggedAt moderationFlaggedBy moderationResolutionRequestedAt moderationResolutionRequestedBy moderationPostingBaseline moderationEditRequest title details practiceArea state locationState experiencePreference minimumYearsExperience totalAmount deadline deadlineDate tasks", sort: { updatedAt: -1 }, limit: limit, populate: [{ path: 'attorney', select: 'firstName lastName email role avatarURL' }, { path: 'attorneyId', select: 'firstName lastName email role avatarURL' }, { path: 'paralegal', select: 'firstName lastName email role avatarURL' }, { path: 'paralegalId', select: 'firstName lastName email role avatarURL' }, { path: 'pendingParalegalId', select: 'firstName lastName email role avatarURL' }] });

    const items = await presentCaseList(docs, { role: req.user.role, viewerId: req.user.id, includeFiles: false, req });
    res.json({ items });
  })
);

router.get(
  "/my-withdrawn",
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const now = new Date();
    const docs = await Case.find({
      withdrawnParalegalId: req.user.id,
      archived: { $ne: true },
      $or: [
        { status: "disputed" },
        { pausedReason: "dispute" },
        { disputeDeadlineAt: { $gt: now }, payoutFinalizedAt: null },
      ],
    })
      .sort({ updatedAt: -1 })
      .select(
        "title status pausedReason disputeDeadlineAt payoutFinalizedAt payoutFinalizedType partialPayoutAmount currency withdrawnParalegalId attorney attorneyId updatedAt createdAt"
      )
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("attorneyId", "firstName lastName email role avatarURL")
      .lean();

    const items = docs.map((doc) => {
      const disputeActive =
        doc.disputeDeadlineAt &&
        !doc.payoutFinalizedAt &&
        now.getTime() < new Date(doc.disputeDeadlineAt).getTime();
      const statusKey = normalizeCaseStatusValue(doc.status);
      const isDisputed = statusKey === "disputed" || doc.pausedReason === "dispute";
      const attorneyRef = doc.attorney || doc.attorneyId || {};
      return {
        caseId: doc._id,
        title: doc.title || "Untitled Matter",
        status: doc.status,
        pausedReason: doc.pausedReason || null,
        disputeDeadlineAt: doc.disputeDeadlineAt || null,
        payoutFinalizedAt: doc.payoutFinalizedAt || null,
        payoutFinalizedType: doc.payoutFinalizedType || null,
        partialPayoutAmount:
          typeof doc.partialPayoutAmount === "number" ? doc.partialPayoutAmount : null,
        currency: doc.currency || "usd",
        attorneyName: formatPersonName(attorneyRef),
        canDispute: !!disputeActive && !isDisputed,
        isDisputed,
      };
    });

    res.json({ items });
  })
);

router.get(
  "/invited-to",
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try { return res.json(await require("../services/receivedInvitationInventory").read(req, caseSummary)); }
    catch (error) { return invitationReviewError(res, error); }
  })
);

router.get(
  "/my-assigned",
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const limit = clamp(parseInt(req.query.limit, 10) || 100, 1, 500);
    const docs = await Case.find({
      paralegal: req.user.id,
      status: { $ne: "completed" },
      paymentReleased: { $ne: true },
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select("title caseNumber status escrowStatus escrowIntentId createdAt updatedAt attorney attorneyId archived paymentReleased paralegal paralegalId")
      .populate("attorney", "firstName lastName")
      .populate("attorneyId", "firstName lastName")
      .lean();

    const items = docs.map((doc) => ({
      _id: doc._id,
      title: doc.title,
      caseNumber: doc.caseNumber || null,
      attorneyName:
        formatPersonName(doc.attorney || doc.attorneyId) ||
        (doc.attorneyNameSnapshot || ""),
      status: normalizeCaseStatusValue(doc.status),
      escrowStatus: doc.escrowStatus || null,
      escrowIntentId: doc.escrowIntentId || null,
      archived: doc.archived,
      paymentReleased: doc.paymentReleased,
      paralegalId: doc.paralegalId || doc.paralegal || null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }));
    res.json({ items });
  })
);

router.get(
  "/my-completed",
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const account = require("../services/financialAccountBoundary"), { fingerprint } = require("../services/matterDraftRevision");
      await account.read(req, "paralegal", req.query.expectedOwnerId);
      const invalid = () => { throw Object.assign(new Error("Invalid history page."), { status: 400, code: "PAYOUT_HISTORY_INVALID" }); };
      const changed = () => { throw Object.assign(new Error("History changed. Refresh to load the current records."), { status: 409, code: "PAYOUT_PROJECTION_CHANGED" }); };
      if (req.query.reviewContexts !== undefined && req.query.reviewContexts !== "1") invalid();
      const reviewContexts = req.query.reviewContexts === "1";
      if (req.query.limit !== undefined && (typeof req.query.limit !== "string" || !/^[1-9]\d{0,2}$/.test(req.query.limit) || Number(req.query.limit) > 500)) invalid();
      const limit = Number(req.query.limit || 100), cursor = req.query.cursor;
      if (cursor !== undefined && (typeof cursor !== "string" || !/^[a-f0-9]{64}:[1-9]\d{0,3}$/.test(cursor))) invalid();
      const [expectedRevision, rawOffset] = cursor ? cursor.split(":") : [], offset = Number(rawOffset || 0);
      const userId = String(req.user.id), variants = [new mongoose.Types.ObjectId(userId), userId];
      const filter = { $or: [
        { $and: [{ $or: [{ paralegal: { $in: variants } }, { paralegalId: { $in: variants } }] }, { $or: [{ status: { $in: ["completed", "closed"] } }, { paymentReleased: true }] }] },
        { $and: [{ $or: [{ paralegal: { $in: variants } }, { paralegalId: { $in: variants } }] }, { status: "disputed", pausedReason: "dispute", terminationStatus: "disputed", terminationDisputeId: { $type: "string" }, paralegalAccessRevokedAt: { $type: "date" } }] },
        { withdrawnParalegalId: { $in: variants } }, { "withdrawalHistory.withdrawnParalegalId": { $in: variants } },
      ] };
      // Use the raw collection so supported retained string IDs remain visible.
      // The bounded full scope also detects insertions/removals between pages.
      const readScope = () => Case.collection.find(filter, { projection: { _id: 1, completedAt: 1, paidOutAt: 1, updatedAt: 1 } }).sort({ completedAt: -1, paidOutAt: -1, updatedAt: -1, _id: -1 }).limit(10001).toArray();
      let docs = await readScope();
      if (docs.length > 10000) throw Object.assign(new Error("History is too large to verify in this view. Contact LPC support."), { status: 503, code: "PAYOUT_HISTORY_LIMIT" });
      if (offset && offset >= docs.length) changed();
      // Keep the existing expiry behavior on the requested initial page only.
      // Cursor reads are read-only and never expand automatic financial writes.
      if (!cursor) {
        let refresh = false;
        for (const selected of docs.slice(0, limit)) {
          const doc = await Case.findById(selected._id);
          if (!doc?.withdrawnParalegalId || String(doc.withdrawnParalegalId) !== userId) continue;
          try { if (await finalizeExpiredDisputeWindow(doc)) refresh = true; }
          catch (error) { logger.warn("[cases] withdrawal expiry finalize failed", error?.message || error); }
        }
        if (refresh) docs = await readScope();
      }
      if (docs.length > 10000) throw Object.assign(new Error("History is too large to verify in this view. Contact LPC support."), { status: 503, code: "PAYOUT_HISTORY_LIMIT" });
      const scopeRevision = fingerprint(docs), report = await require("../services/paralegalHistoryProjection").read(req, docs);
      const revision = fingerprint([scopeRevision, report.revision, ...(reviewContexts ? ["review-contexts-v1"] : [])]);
      if (expectedRevision && expectedRevision !== revision) changed();
      const blockLookup = buildBlockLookup(userId, await getBlocksForUser(userId));
      const byId = new Map(report.items.map(item => [String(item.caseId), item]));
      const items = await Promise.all(docs.slice(offset, offset + limit).map(async record => {
        const { source, ...item } = byId.get(String(record._id));
        const counterpartyId = normalizeId(source.attorney || source.attorneyId);
        const blockStatus = await getCaseInteractionBlockStatus(source, req.user, counterpartyId ? blockLookup.get(counterpartyId) || null : null);
        // Cached clients know only withdrawal review wording. They retain the
        // record without receiving a state they would incorrectly label.
        const compatible = !reviewContexts && item.reviewKind === "termination" ? { ...item, reviewState: null, reviewKind: null } : item;
        return { ...compatible, blockStatus };
      }));
      await report.verify();
      if (scopeRevision !== fingerprint(await readScope())) changed();
      await account.read(req, "paralegal", req.query.expectedOwnerId);
      const end = offset + items.length;
      res.json({ ownerId: report.ownerId, revision, items, page: { total: docs.length, limit, offset, hasMore: end < docs.length, nextCursor: end < docs.length ? `${revision}:${end}` : null } });
    } catch (error) {
      res.status(error.status || error.statusCode || 503).json({ code: error.publicCode || error.code || "PAYOUT_HISTORY_UNAVAILABLE", error: error.publicCode || error.code ? error.message : "Work history could not be verified. Refresh to try again." });
    }
  })
);

router.get("/:caseId/work-review", requireCaseAccess("caseId"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  const work = require("../services/attorneyMatterWork");
  try { return res.json(await work.read(req)); } catch (error) { return work.sendError(res, error); }
}));
router.post("/:caseId/work-review", csrfProtection, requireCaseAccess("caseId"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  const work = require("../services/attorneyMatterWork");
  try { return res.json(await work.update(req)); } catch (error) { return work.sendError(res, error); }
}));

router.patch(
  "/:caseId",
  csrfProtection,
  requireCaseAccess(
    "caseId",
    { project: "title details practiceArea state locationState deadline deadlineDate totalAmount lockedTotalAmount currency status briefSummary experiencePreference minimumYearsExperience invites pendingParalegalId pendingParalegalInvitedAt applicants tasks taskRevision tasksLocked hiredAt paralegalId completionClaimStatus jobId withdrawnParalegalId" }
  ),
  asyncHandler(async (req, res) => {
    const isAdmin = !!req.acl?.isAdmin;
    if (!req.acl?.isAttorney && !isAdmin) {
      return res.status(403).json({ error: "Only the Matter attorney can update this Matter" });
    }
    let doc = req.case;
    const body = req.body || {};
    const tasksInputProvided = Object.prototype.hasOwnProperty.call(body, "tasks");
    const normalizedTasks = tasksInputProvided ? normalizeScopeTasks(body.tasks) : null;
    const tasksOnlyUpdate =
      tasksInputProvided && Object.keys(body).every((key) => ["tasks", "expectedTaskRevision"].includes(key));
    // Read earlier string/alias task formats without allowing Mongoose defaults
    // or a cast failure to turn a retained scope into an empty array.
    if (tasksOnlyUpdate) {
      const storedWork = await Case.collection.findOne({ _id: doc._id }, { projection: { tasks: 1 } });
      if (!storedWork) return res.status(404).json({ error: "Matter not found" });
      doc.tasks = serializeScopeTasks(storedWork.tasks);
    }
    const completionOnlyUpdate =
      tasksOnlyUpdate && isCompletionOnlyTaskUpdate(doc.tasks, normalizedTasks);
    if (body.expectedTaskRevision !== undefined && (!Number.isSafeInteger(body.expectedTaskRevision) || body.expectedTaskRevision < 0)) return res.status(400).json({ error: "Invalid task revision." });
    const matterWork = require("../services/attorneyMatterWork");
    let workSnapshot = null;
    if (completionOnlyUpdate) {
      try { workSnapshot = await matterWork.legacySnapshot(doc, body.expectedTaskRevision); }
      catch (error) { return res.status(error.status || 503).json({ code: "TASK_UPDATE_CONFLICT", error: "The task list or Matter access changed. Refresh before trying again." }); }
      if (!isAdmin && (workSnapshot.readOnly || workSnapshot.archived)) return res.status(403).json({ error: "This Matter's work cannot be modified." });
    }
    const amountInput =
      body.totalAmount ?? body.budget ?? body.compensationAmount ?? body.compAmount;
    if (typeof amountInput !== "undefined" && amountInput !== null && doc.lockedTotalAmount != null) {
      return res.status(403).json({ error: "Matter amount is locked and cannot be modified." });
    }
    const normalizedStatus = normalizeCaseStatusValue(doc.status);
    const statusKey = normalizedStatus;
    const caseClosed = CLOSED_CASE_STATUSES.has(normalizedStatus);
    if (normalizedStatus === IN_PROGRESS_STATUS && !completionOnlyUpdate) {
      return res.status(403).json({ error: "Matter edits are locked once work is in progress." });
    }
    if (!isAdmin) {
      if (completionOnlyUpdate && caseClosed) {
        return res.status(403).json({ error: "Closed Matters cannot be modified." });
      }
      if (!completionOnlyUpdate) {
        if (doc.paralegalId || doc.hiredAt) {
          return res.status(403).json({ error: "Matter edits are locked once a paralegal is hired." });
        }
        if (!["open"].includes(statusKey)) {
          return res.status(403).json({ error: "Matter edits are limited to posted Matters." });
        }
      }
    }
    const forbiddenKeys = ["applicants", "paralegal", "paralegalId", "attorney", "attorneyId", "tasksLocked"];
    if (forbiddenKeys.some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
      return res.status(400).json({ error: "One or more fields cannot be modified." });
    }
    if (tasksInputProvided && (doc.tasksLocked || doc.hiredAt || doc.paralegal || doc.paralegalId) && !completionOnlyUpdate) {
      return res.status(403).json({
        error: "Tasks are locked once a paralegal is hired. Create a new Matter for additional work.",
      });
    }
    if (
      tasksInputProvided &&
      completionOnlyUpdate &&
      doc.withdrawnParalegalId &&
      (doc.paralegalId || doc.paralegal) &&
      hasCompletedTaskReversal(doc.tasks, normalizedTasks)
    ) {
      return res.status(403).json({
        error: "Completed tasks cannot be unchecked after a withdrawal and rehire.",
      });
    }
    let touched = false;

    if (typeof body.title === "string" && body.title.trim()) {
      const nextTitle = cleanString(body.title, { len: 300 });
      doc.title = nextTitle;
      touched = true;
    }
    const updatedDetails = typeof body.details === "string" ? body.details : typeof body.description === "string" ? body.description : null;
    if (updatedDetails) {
      const sanitizedDetails = cleanPlainText(updatedDetails, { max: 100_000 });
      doc.details = sanitizedDetails;
      touched = true;
    }
    if (tasksInputProvided) {
      doc.tasks = completionOnlyUpdate
        ? mergeTaskCompletion(doc.tasks, normalizedTasks)
        : normalizedTasks || [];
      touched = true;
    }
    if (typeof body.practiceArea === "string") {
      const nextPractice = normalizePracticeArea(body.practiceArea);
      if (!nextPractice) {
        return res.status(400).json({ error: "Select a valid practice area." });
      }
      doc.practiceArea = nextPractice;
      touched = true;
    }
    if (typeof body.briefSummary === "string") {
      doc.briefSummary = cleanString(body.briefSummary, { len: 1000 });
      touched = true;
    }
    if (typeof body.experience === "string" || typeof body.experiencePreference === "string") {
      const preference = cleanString(body.experience ?? body.experiencePreference ?? "", { len: 200 });
      doc.experiencePreference = preference;
      doc.minimumYearsExperience = parseMinimumYears(preference);
      touched = true;
    }
    if (typeof body.deadline !== "undefined") {
      if (!body.deadline) {
        doc.deadlineDate = "";
        doc.deadline = null;
        touched = true;
      } else {
        const nextDeadline = parseDeadline(body.deadline);
        if (!nextDeadline) {
          return res.status(400).json({ error: "Invalid deadline provided." });
        }
        doc.deadlineDate = nextDeadline.dateOnly;
        doc.deadline = nextDeadline.legacyDate;
        touched = true;
      }
    }
    const beforeAmount = doc.totalAmount;
    if (typeof amountInput !== "undefined" && amountInput !== null) {
      const cents = dollarsToCents(amountInput);
      if (!Number.isFinite(cents) || cents <= 0) {
        return res.status(400).json({ error: "Budget must be greater than $0." });
      }
      if (cents < MIN_CASE_AMOUNT_CENTS) {
        return res.status(400).json({ error: MIN_CASE_AMOUNT_MESSAGE });
      }
      if (cents > 0) {
        if (!doc.paralegalId && !hasPendingInvites(doc)) {
          doc.totalAmount = cents;
          touched = true;
        }
      }
    }
    if (typeof body.currency === "string" && body.currency.trim()) {
      doc.currency = cleanString(body.currency, { len: 8 }).toLowerCase();
       touched = true;
    }

    if (!touched) {
      return res.status(400).json({ error: "No valid changes provided." });
    }

    const postingSaved = await withActiveAccountWrite([], async session => {
    if (completionOnlyUpdate) {
      const saved = await Case.collection.updateOne(
        { ...matterWork.snapshotFilter(workSnapshot), $and: [{ $or: [{ completionClaimStatus: null }, { completionClaimStatus: { $exists: false } }] }] },
        { $set: { tasks: matterWork.preserveCompletion(workSnapshot.tasks, normalizedTasks.map(task => task.completed)), updatedAt: new Date() }, $inc: { taskRevision: 1, __v: 1 } }, { session }
      );
      if (saved.modifiedCount !== 1) {
        throw Object.assign(new Error("The task list changed or completion has started. Refresh before trying again."), { status: 409, publicCode: "TASK_UPDATE_CONFLICT" });
      }
      doc = await Case.findById(doc._id).session(session);
      if (!doc || !isAdmin && ![doc.attorney, doc.attorneyId].some(id => String(id || "") === String(req.user.id))) throw Object.assign(new Error("Matter access changed."), { status: 403 });
    } else {
      await doc.save({ session });
    }
    if (!completionOnlyUpdate && doc.jobId) {
      await Job.updateOne(
        { _id: doc.jobId },
        {
          $set: {
            title: doc.title,
            practiceArea: doc.practiceArea || "",
            description: doc.details || "",
            budget: Math.round(Number(doc.totalAmount || 0) / 100),
            state: doc.state || doc.locationState || "",
            locationState: doc.locationState || doc.state || "",
            experiencePreference: doc.experiencePreference || "",
            minimumYearsExperience: Number(doc.minimumYearsExperience || 0),
          },
        }, { session }
      );
    }
      const dispatch = await postingNotices.retain(req, 'updated', doc, session, { recipients: postingUpdateRecipients(doc, isAdmin), auditMeta: isAdmin && beforeAmount !== doc.totalAmount ? { amountOverride: { from: beforeAmount, to: doc.totalAmount }, adminId: req.user.id } : undefined });
      return { caseDoc: doc, dispatch };
    });
    doc = postingSaved.caseDoc;
    await doc.populate([
      { path: "paralegal", select: "firstName lastName email role avatarURL" },
      { path: "attorney", select: "firstName lastName email role avatarURL" },
    ]);

    await dispatchPostingNotice(postingSaved.dispatch);

    publishCaseEvent(doc._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(doc, "matter_updated_refresh");

    if (tasksInputProvided) {
      publishCaseEvent(doc._id, "tasks", { at: new Date().toISOString() });
    }

    res.json(caseSummary(doc, { viewerRole: req.user?.role }));
  })
);

router.delete(
  "/:caseId",
  csrfProtection,
  (req, res, next) => {
    if (Object.keys(req.body || {}).some(key => key.startsWith("expectedOwnerId") && key !== "expectedOwnerId")) {
      return res.status(400).json({ code: "MATTER_DELETE_INVALID", error: "Reload Matters before deleting this posting." });
    }
    if (req.body?.expectedOwnerId !== undefined && req.body.expectedOwnerId !== String(req.user?.id || req.user?._id || "")) {
      return res.status(403).json({ code: "MATTER_DELETE_ACCOUNT_CHANGED", error: "The signed-in account changed. Reload Matters before continuing." });
    }
    next();
  },
  requireCaseAccess("caseId", {
    project: "status archived paralegal paralegalId attorney attorneyId title escrowStatus escrowIntentId paymentIntentId paymentReleased payoutTransferId payoutFinalizedAt disputes hiredAt jobId job applicants.paralegalId invites.paralegalId pendingParalegalId",
  }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the Matter attorney can delete this Matter" });
    }
    let doc = req.case;
    const statusKey = normalizeCaseStatusValue(doc.status);
    const hasParalegal = !!(doc.paralegal || doc.paralegalId);
    if (hasParalegal || doc.hiredAt) {
      return res.status(409).json({ error: "Cannot delete a Matter after hiring a paralegal" });
    }
    const escrowStatus = String(doc.escrowStatus || "").toLowerCase();
    const escrowFunded = escrowStatus === "funded" || doc.paymentReleased === true;
    const hasFinancialHistory = Boolean(
      escrowFunded ||
      doc.escrowIntentId ||
      doc.paymentIntentId ||
      doc.payoutTransferId ||
      doc.payoutFinalizedAt
    );
    if (hasFinancialHistory) {
      return res.status(400).json({ error: "Cannot delete a Matter after Stripe is funded" });
    }
    if (Array.isArray(doc.disputes) && doc.disputes.length) {
      return res.status(409).json({ error: "Matters with dispute history must be retained." });
    }
    if (statusKey !== "open") {
      return res.status(409).json({ error: "Only open, never-engaged postings can be permanently deleted." });
    }
    const deletionFields = "attorney attorneyId status archived paralegal paralegalId hiredAt escrowStatus escrowIntentId paymentIntentId paymentReleased payoutTransferId payoutFinalizedAt disputes hiringClaimToken hiringClaimStatus fundingRequestKey __v".split(" ");
    const deletionFacts = await Case.collection.findOne({ _id: doc._id }, { projection: Object.fromEntries(deletionFields.map(key => [key, 1])) });
    if (!deletionFacts || deletionFacts.hiringClaimToken || deletionFacts.hiringClaimStatus || deletionFacts.fundingRequestKey || deletionFacts.paralegal || deletionFacts.paralegalId || deletionFacts.hiredAt || deletionFacts.escrowIntentId || deletionFacts.paymentIntentId || deletionFacts.paymentReleased || deletionFacts.escrowStatus === "funded" || deletionFacts.payoutTransferId || deletionFacts.payoutFinalizedAt || deletionFacts.disputes?.length || normalizeCaseStatusValue(deletionFacts.status) !== "open" || String(deletionFacts.attorney || "") !== String(doc.attorney || "") || String(deletionFacts.attorneyId || "") !== String(doc.attorneyId || "")) {
      return res.status(409).json({ error: "This Matter changed or has a funding attempt that must be resolved before deletion." });
    }

    const reasonRaw = typeof req.body?.reason === "string" ? req.body.reason : "";
    const messageRaw = typeof req.body?.message === "string" ? req.body.message : "";
    const reason = cleanText(reasonRaw, { max: 2000 });
    const message = cleanText(messageRaw, { max: 4000 });
    const attorneyRef = doc.attorneyId || doc.attorney || null;

    let deletionResult;
    try {
      deletionResult = await withActiveAccountWrite([req.user.id], async session => {
        const source = await Case.collection.findOne({ _id: doc._id, ...Object.fromEntries(deletionFields.map(key => [key, deletionFacts[key] === undefined ? { $exists: false } : { $eq: deletionFacts[key] }])) }, { session });
        if (!source) throw Object.assign(new Error("This Matter changed. Refresh before trying to delete it."), { status: 409, publicCode: "MATTER_DELETE_CHANGED" });
        const result = await deletePostingRecords(source, session);
        const dispatch = await postingNotices.retain(req, 'deleted', result.doc, session, { notifyOwner: !!req.acl?.isAdmin && !!attorneyRef && !!(reason || message), reason, message });
        return { ...result, dispatch };
      }, { ownerId: req.user.id, authVersion: req.auth?.payload?.av });
    } catch (error) {
      if (!error.publicCode) logger.error("[cases] posting deletion could not be confirmed", { caseId: doc._id, error: error.name });
      return res.status(error.status || 503).json({ code: error.publicCode || "MATTER_DELETE_UNCONFIRMED", error: error.publicCode ? error.message : "Deletion could not be confirmed. Check this Matter before trying again." });
    }
    doc = deletionResult.doc;
    const affectedParalegalIds = deletionResult.recipients;
    await dispatchPostingNotice(deletionResult.dispatch);
    publishCaseEvent(doc._id, "case", { at: new Date().toISOString(), type: "matter_deleted_refresh" });
    publishCaseParticipantRefresh(doc, "matter_deleted_refresh", [...affectedParalegalIds]);
    res.json({ ok: true });
  })
);

/**
 * PATCH /api/cases/:caseId/zoom
 * Body: { zoomLink }
 * Only attorneys on the case or admins may update the link.
 */
router.patch(
  "/:caseId/zoom",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAdmin && !req.acl?.isAttorney) {
      return res.status(403).json({ error: "Only the Matter attorney or an administrator may update the meeting link" });
    }
    const { zoomLink } = req.body || {};
    if (typeof zoomLink !== 'string' || zoomLink.length > 2000) {
      return res.status(400).json({ error: "Enter a valid Zoom meeting link, or leave it empty to remove it." });
    }
    const doc = await Case.findById(req.params.caseId).select("zoomLink title");
    if (!doc) return res.status(404).json({ error: "Matter not found" });

    doc.zoomLink = cleanString(zoomLink || "", { len: 2000 });
    try { await doc.validate(['zoomLink']); }
    catch (error) {
      if (error.name !== 'ValidationError') throw error;
      return res.status(400).json({ error: "Enter a valid HTTPS Zoom meeting link." });
    }
    await doc.save();

    try {
      await logAction(req, "case.zoom.update", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { zoomLink: doc.zoomLink },
      });
    } catch (auditError) {
      logger.error("[cases] meeting-link audit persistence failed", { caseId: doc._id, error: auditError });
    }

    publishCaseEvent(doc._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(doc, "matter_meeting_refresh");
    res.json({ ok: true, zoomLink: doc.zoomLink });
  })
);

/**
 * POST /api/cases/:caseId/terminate
 * End the attorney/paralegal engagement. If work has begun, open a dispute for admin review.
 * Body: { reason? }
 */
router.post(
  "/:caseId/terminate",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the attorney or an administrator can terminate this Matter." });
    }

    const doc = await Case.findById(req.params.caseId)
      .populate("paralegal", "firstName lastName email role avatarURL")
      .populate("attorney", "firstName lastName email role avatarURL")
      .populate("terminationRequestedBy", "firstName lastName email role");
    if (!doc) return res.status(404).json({ error: "Matter not found." });
    const terminationPolicy = evaluateTerminationEligibility({
      caseDoc: doc,
      ownerAuthorized: req.acl?.isAttorney === true,
      adminAuthorized: req.acl?.isAdmin === true,
    });
    if (!terminationPolicy.ready) {
      const existingTerminationDispute = (doc.disputes || []).find(
        (entry) =>
          String(entry?.status || "open").toLowerCase() === "open" &&
          String(entry?.disputeId || entry?._id || "") === String(doc.terminationDisputeId || "")
      );
      if (doc.terminationStatus === "disputed" && existingTerminationDispute) {
        return res.status(202).json({
          ok: true,
          alreadyRequested: true,
          requiresAdmin: true,
          case: caseSummary(doc, { viewerRole: req.user?.role }),
        });
      }
      return res.status(400).json({
        error: "This matter is not ready for a termination request.",
        blockers: terminationPolicy.blockers,
      });
    }

    const reason = cleanMessage(req.body?.reason || "", 2000);
    const now = new Date();
    const disputeId = new mongoose.Types.ObjectId().toString();
    const requester = req.acl?.isAdmin ? "Administrator" : "Attorney";
    const message = reason
      ? `${requester} requested termination: ${reason}`
      : `${requester} requested termination of this Matter.`;
    const ownerClause = req.acl?.isAdmin
      ? {}
      : {
          $or: [
            { attorney: req.user.id },
            { attorneyId: req.user.id },
          ],
        };
    let updatedCase, dispatchers = [];
    const session = await mongoose.startSession();
    try {
      await reviewNotices.ready();
      await session.withTransaction(async () => {
        dispatchers = [];
        await lockActiveAccounts([req.user.id], session, { ownerId: req.user.id, authVersion: req.authVersion });
        const actor = await User.findById(req.user.id).select("role").session(session).lean();
        if (actor?.role !== (req.acl?.isAdmin ? "admin" : "attorney")) throw Object.assign(new Error("This account changed. Sign in again before continuing."), { status: 403 });
        updatedCase = await Case.findOneAndUpdate(
          {
            _id: doc._id,
            attorney: doc.attorney?._id || doc.attorney || null,
            attorneyId: doc.attorneyId || null,
            paralegal: doc.paralegal?._id || doc.paralegal || null,
            paralegalId: doc.paralegalId || null,
            hiredAt: doc.hiredAt || null,
            status: { $in: ["in progress", "in_progress"] },
            archived: { $ne: true },
            readOnly: { $ne: true },
            completionClaimStatus: { $nin: ["claimed", "needs_reconciliation"] },
            $and: [
              { $or: [{ paralegal: { $ne: null } }, { paralegalId: { $ne: null } }] },
              { disputes: { $not: { $elemMatch: { status: "open" } } } },
              { terminationStatus: { $in: [null, "", "none", "resolved"] } },
            ],
            ...ownerClause,
          },
          {
            $push: {
              disputes: {
                disputeId,
                message,
                raisedBy: req.user.id,
                status: "open",
                comments: [],
                createdAt: now,
                updatedAt: now,
              },
            },
            $set: {
              status: "disputed",
              pausedReason: "dispute",
              disputeDeadlineAt: null,
              terminationRequestedAt: now,
              terminationRequestedBy: req.user.id,
              terminationReason: reason,
              terminationStatus: "disputed",
              terminationDisputeId: disputeId,
              terminatedAt: null,
              paralegalAccessRevokedAt: now,
            },
          },
          { returnDocument: "after", runValidators: true, session }
        );
        if (!updatedCase) return;
        await AuditLog.logFromReq(req, "case.terminate", {
          targetType: "case", targetId: updatedCase._id, caseId: updatedCase._id,
          meta: { mode: "disputed", disputeId }, session,
        });
        // Preserve termination's existing single-recipient policy.
        const affectedParalegalId = updatedCase.paralegal || updatedCase.paralegalId;
        if (!affectedParalegalId) throw new Error("The affected paralegal could not be verified.");
        const dispatch = await notifyUser(affectedParalegalId, "dispute_opened", {
          caseId: String(updatedCase._id), caseTitle: updatedCase.title || "Untitled Matter",
          title: "Matter review opened",
          message: `A termination review has been opened for the Matter: ${updatedCase.title || "Untitled Matter"}.`,
          disputeId,
        }, { actorUserId: req.user.id, session, deferDispatch: true, reviewOpened: true });
        if (typeof dispatch !== "function") throw new Error("The review notification recipient is unavailable.");
        dispatchers.push(dispatch);
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    } catch (error) {
      reportOperationalFailure("routes.cases.termination_review")(error);
      return res.status(error.status || 503).json({
        code: error.status ? "TERMINATION_ACCOUNT_CHANGED" : "TERMINATION_REVIEW_UNAVAILABLE",
        error: error.status ? error.message : "The termination request could not be confirmed. Refresh to check its status.",
      });
    } finally {
      updatedCase?.$session(null);
      await session.endSession();
    }
    if (!updatedCase) {
      const latest = await Case.findById(doc._id)
        .populate("paralegal", "firstName lastName email role avatarURL")
        .populate("attorney", "firstName lastName email role avatarURL")
        .populate("terminationRequestedBy", "firstName lastName email role");
      const existingTerminationDispute = (latest?.disputes || []).find(
        (entry) =>
          String(entry?.status || "open").toLowerCase() === "open" &&
          String(entry?.disputeId || entry?._id || "") === String(latest?.terminationDisputeId || "")
      );
      if (latest?.terminationStatus === "disputed" && existingTerminationDispute) {
        return res.status(202).json({
          ok: true,
          alreadyRequested: true,
          requiresAdmin: true,
          case: caseSummary(latest, { viewerRole: req.user?.role }),
        });
      }
      return res.status(409).json({
        error: "The matter changed before the termination review could be opened. Refresh and try again.",
        code: "TERMINATION_CONFLICT",
      });
    }
    await updatedCase.populate([
      { path: "paralegal", select: "firstName lastName email role avatarURL" },
      { path: "attorney", select: "firstName lastName email role avatarURL" },
      { path: "terminationRequestedBy", select: "firstName lastName email role" },
    ]);

    const payload = {
      ok: true,
      requiresAdmin: true,
      case: caseSummary(updatedCase, { viewerRole: req.user?.role }),
    };
    for (const dispatch of dispatchers) await dispatch().catch(reportOperationalFailure("routes.cases.termination_refresh"));
    publishCaseEvent(updatedCase._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(updatedCase, "matter_termination_refresh");
    res.status(202).json(payload);
  })
);

/**
 * POST /api/cases/:caseId/files
 * Body: { key, original?, mime?, size? }
 * Attaches a file record (S3 key) to the case.
 */
router.post(
  "/:caseId/files",
  csrfProtection,
  requireCaseAccess("caseId", {
    project: "files status paralegal paralegalId escrowIntentId escrowStatus archived readOnly paralegalAccessRevokedAt withdrawnParalegalId hiredAt",
  }),
  asyncHandler(matterFileWrites.handle(async (req, res) => {
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Administrators can only access the Matter archive." });
    }
    const { key, original, mime, size } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key is required" });
    const doc = req.case;
    if (!requireMatterDocumentWorkspace(doc, res)) return;
    const writeReview = await matterFileWrites.read(req);
    const storageKey = normalizeCaseStorageKey(key);
    const exists = await CaseFile.findOne(applyAssignmentVisibility(
      buildCaseFileKeyQuery({ caseId: doc._id, storageKey }),
      doc,
      {
        role: req.user?.role,
        userId: req.user?.id,
        isParalegal: req.acl?.isParalegal === true,
      }
    ))
      .select("_id")
      .lean();
    if (exists) return res.status(200).json({ ok: true });
    let objectMetadata = null;
    try {
      objectMetadata = await verifyCaseDocumentObject({ caseId: doc._id, key: storageKey, declaredSize: size, declaredMime: mime });
    } catch (err) {
      if ([
        "INVALID_CASE_FILE_KEY",
        "CASE_FILE_METADATA_MISMATCH",
        "FILE_TYPE_NOT_ALLOWED",
        "FILE_EXTENSION_MISMATCH",
        "FILE_SIGNATURE_MISMATCH",
      ].includes(err?.code)) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: "The uploaded document was not found in storage." });
      }
      throw err;
    }
    const filename = cleanString(original || "", { len: 400 }) || storageKey.split("/").pop();
    const uploadRole = req.user.role || "attorney";
    const defaultStatus = "pending_review";
    const status = FILE_STATUS.includes(defaultStatus) ? defaultStatus : "pending_review";

    let created = false;
    const version = await nextCaseFileVersion(doc._id, filename);
    try {
      await matterFileWrites.run(req, writeReview, async session => {
        await matterRetirement.assertAttachable(doc._id, storageKey, session);
        const entries = await CaseFile.create([{
        caseId: doc._id,
        userId: req.user.id,
        originalName: filename,
        storageKey,
        mimeType: String(objectMetadata?.ContentType || mime || ""),
        size: Number.isFinite(Number(objectMetadata?.ContentLength))
          ? Number(objectMetadata.ContentLength)
          : Number.isFinite(Number(size)) ? Number(size) : 0,
        securityStatus: malwareScanRequired() ? "pending" : "not_required",
        securityScanResult: malwareScanRequired() ? "PENDING" : "NOT_REQUIRED",
        uploadedByRole: uploadRole,
        status,
        version,
      }], { session });
        await presignedUploads.attach(req, storageKey, entries[0]._id, session); return entries;
      });
      created = true;
    } catch (err) {
      if (Number(err?.code) !== 11000) {
        throw err;
      }
    }
    if (created) {
      try {
        await logAction(req, "case.file.attach", {
          targetType: "case",
          targetId: doc._id,
          caseId: doc._id,
          meta: { key: storageKey, name: filename },
        });
      } catch (auditError) {
        logger.error("[cases] document attachment audit persistence failed", { caseId: doc._id, error: auditError });
      }
      publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() });
      publishCaseParticipantRefresh(doc, "matter_documents_refresh");
    }

    await matterFileWrites.read(req);
    res.status(created ? 201 : 200).json({ ok: true });
  }))
);

/**
 * DELETE /api/cases/:caseId/files
 * Body: { key }
 * Removes the file metadata from the case.
 */
router.delete("/:caseId/files", csrfProtection, asyncHandler(async (req, res) => {
  try {
    if (req.user?.role !== "attorney") return res.status(403).json({ error: "Only the Matter attorney can remove documents." });
    const doc = await matterFileWrites.read(req), key = normalizeCaseStorageKey(req.body?.key);
    if (!isCaseDocumentStorageKey(doc._id, key)) return res.status(400).json({ error: "The document key does not belong to this Matter." });
    const record = await CaseFile.findOne(buildCaseFileKeyQuery({ caseId: doc._id, storageKey: key }));
    if (!record) return res.status(404).json({ error: "File not found on Matter" });
    res.json({ ok: true, ...await fileRemoval.legacy(req, record._id) });
  } catch (error) { fileRemoval.sendError(res, error); }
}));

const matterDownloads = require("../services/matterDownloads");
const downloadNoStore = (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); };
const downloadOperation = (writeResponse, readFile = matterDownloads.readFile, validateKey = isCaseDocumentStorageKey) => async (req, res) => {
  let object;
  try {
    if (!writeResponse) return res.json(await matterDownloads.list(req));
    const { record, file } = await readFile(req);
    const preview = req.query.preview === "true";
    const audio = req.query.play === "true" && file.inlineAudioMimeType;
    if (req.query.play !== undefined && !audio) return res.status(400).json({ code: "DOWNLOAD_AUDIO_UNAVAILABLE", error: "This attachment cannot be played here." });
    if (req.query.preview !== undefined && (!preview || file.mimeType !== "application/pdf")) return res.status(400).json({ code: "DOWNLOAD_PREVIEW_UNAVAILABLE", error: "This document cannot be previewed here. Download it to review its contents." });
    const key = normalizeCaseStorageKey(file.storageKey);
    if (!validateKey(req.params.caseId, key)) return res.status(409).json({ code: "DOWNLOAD_UNAVAILABLE", error: "This file's stored reference needs review." });
    if (!S3_BUCKET) return res.status(503).json({ code: "DOWNLOAD_STORAGE", error: "File storage is temporarily unavailable." });
    const scan = await refreshMatterFileScan(record, key);
    if (!scan.safe) return res.status(scan.status === "blocked" ? 422 : scan.status === "error" ? 503 : 423).json({ code: scan.status === "blocked" ? "DOWNLOAD_BLOCKED" : scan.status === "error" ? "DOWNLOAD_SCAN_ERROR" : "DOWNLOAD_SCAN_PENDING", error: "This file has not passed its current security check." });
    await readFile(req);
    object = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    // Ownership, lifecycle and the exact file can change while storage responds.
    await readFile(req);
    if (req.aborted || res.destroyed) { object.Body?.destroy?.(); return; }
    if (!object.Body || typeof object.Body.pipe !== "function") throw new Error("File stream unavailable");
    const name = String(file.originalName || "Matter file").replace(/[\u0000-\u001f\u007f\\/]/g, "-").slice(0, 180);
    res.set("Content-Type", preview ? "application/pdf" : audio || "application/octet-stream");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", `${preview || audio ? "inline" : "attachment"}; filename="matter-file"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, "%27")}`);
    if (Number.isSafeInteger(object.ContentLength) && object.ContentLength >= 0) res.set("Content-Length", String(object.ContentLength));
    res.on("close", () => object.Body?.destroy?.());
    object.Body.on("error", error => { logger.error("[cases] Matter file stream failed", { caseId: req.params.caseId, fileId: req.params.fileId, error }); res.destroy(error); });
    object.Body.on("end", () => {
      void logAction(req, preview || audio ? "file_viewed" : "file_downloaded", { targetType: "case", targetId: req.params.caseId, meta: { fileId: req.params.fileId, filename: name, ...(req.params.messageId ? { messageId: req.params.messageId } : {}), ...(req.params.index !== undefined ? { historyIndex: Number(req.params.index) } : {}) } }).catch(error => logger.warn("[cases] file download audit failed", { caseId: req.params.caseId, error }));
    });
    object.Body.pipe(res);
  } catch (error) {
    object?.Body?.destroy?.();
    if (res.headersSent) { res.destroy(error); return; }
    if (error.publicCode) return res.status(error.status).json({ code: error.publicCode, error: error.message });
    if (["NoSuchKey", "NotFound"].includes(error.name || error.code) || error?.$metadata?.httpStatusCode === 404) return res.status(404).json({ code: "DOWNLOAD_FILE_NOT_FOUND", error: "This file is no longer in storage." });
    logger.error("[cases] Matter file download unavailable", { caseId: req.params.caseId, error });
    return res.status(503).json({ code: "DOWNLOAD_UNAVAILABLE", error: "The file request could not be completed. Try again when your connection and file status are ready." });
  }
};
const attorneyEarlierFiles = require("../services/attorneyEarlierFiles");
router.get("/:caseId/earlier-files", downloadNoStore, requireCaseAccess("caseId"), async (req, res) => {
  try { res.json(await attorneyEarlierFiles.read(req)); }
  catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "DOCUMENT_EARLIER_UNAVAILABLE", error: "Earlier Matter files could not be verified. Refresh Files before continuing." }); }
});
router.get("/:caseId/earlier-files/:referenceId/download", downloadNoStore, requireCaseAccess("caseId"), downloadOperation(true, attorneyEarlierFiles.readDownload, attorneyEarlierFiles.isAllowedKey));
router.get("/:caseId/downloads", downloadNoStore, requireCaseAccess("caseId"), downloadOperation(false));
router.get("/:caseId/downloads/:fileId", downloadNoStore, requireCaseAccess("caseId"), downloadOperation(true));
router.get("/:caseId/message-attachments/:messageId", downloadNoStore, requireCaseAccess("caseId"), downloadOperation(true, require("../services/attorneyMessageAttachments").readDownload));
router.get("/:caseId/retained-messages", downloadNoStore, requireCaseAccess("caseId"), async (req, res) => {
  try { res.json(await require("../services/attorneyRetainedConversation").read(req)); }
  catch (error) { require("../services/attorneyConversation").sendError(res, error); }
});

const attorneyMatterFileHistory = require("../services/attorneyMatterFileHistory");
router.get("/:caseId/files/:fileId/history", downloadNoStore, requireCaseAccess("caseId"), async (req, res) => {
  try { res.json(await attorneyMatterFileHistory.list(req)); } catch (error) { res.status(error.status || 503).json({ code: error.publicCode || "DOCUMENT_HISTORY_UNAVAILABLE", error: "Document history could not be verified. Refresh Files before continuing." }); }
});
router.get("/:caseId/files/:fileId/history/:index/download", downloadNoStore, requireCaseAccess("caseId"), downloadOperation(true, attorneyMatterFileHistory.readDownload));

const attorneyMatterFiles = require("../services/attorneyMatterFiles");
router.get("/:caseId/files/review", downloadNoStore, requireCaseAccess("caseId"), async (req, res) => {
  try { res.json(await attorneyMatterFiles.list(req)); }
  catch (error) { attorneyMatterFiles.sendError(res, error); }
});
router.post("/:caseId/files/:fileId/review", downloadNoStore, csrfProtection, requireCaseAccess("caseId"), async (req, res) => {
  try {
    res.json(await attorneyMatterFiles.update(req, { verifySecurity: async record => {
      const file = decryptCaseFilePayload(record), key = normalizeCaseStorageKey(file.storageKey);
      if (!isCaseDocumentStorageKey(req.params.caseId, key)) return false;
      return (await refreshMatterFileScan(record, key)).safe;
    } }));
  } catch (error) { attorneyMatterFiles.sendError(res, error); }
});

/**
 * GET /api/cases/:caseId/files/signed-get?key=
 * Returns a signed download URL for the specified case file key.
 */
router.get(
  "/:caseId/files/signed-get",
  requireCaseAccess("caseId", {
    project: "files paymentReleased paralegal paralegalId withdrawnParalegalId hiredAt",
  }),
  asyncHandler(async (req, res) => {
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Administrators can only access the Matter archive." });
    }
    const { key } = req.query;
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key query param required" });
    const doc = req.case;
    const storageKey = normalizeCaseStorageKey(key);
    if (!isCaseDocumentStorageKey(doc._id, storageKey)) {
      return res.status(400).json({ error: "The document key does not belong to this Matter." });
    }
    if (!req.acl?.isAdmin && isCaseClosedForFiles(doc)) {
      return res.status(403).json({ error: "Files are no longer available. Download the archive instead." });
    }
    const file = await CaseFile.findOne(applyAssignmentVisibility(
      buildCaseFileKeyQuery({ caseId: doc._id, storageKey }),
      doc,
      {
        role: req.user?.role,
        userId: req.user?.id,
        isParalegal: req.acl?.isParalegal === true,
      }
    ));
    if (!file) return res.status(404).json({ error: "File not found" });

    try {
      const plainFile = decryptCaseFilePayload(file);
      const scan = await refreshMatterFileScan(file, plainFile.storageKey);
      if (!scan.safe) {
        const statusCode = scan.status === "blocked" ? 422 : scan.status === "error" ? 503 : 423;
        const code = scan.status === "blocked"
          ? "FILE_SECURITY_BLOCKED"
          : scan.status === "error"
            ? "FILE_SCAN_ERROR"
            : "FILE_SCAN_PENDING";
        return res.status(statusCode).json({
          error: scan.status === "blocked"
            ? "This file is unavailable because it did not pass security scanning."
            : scan.status === "error"
              ? "This file is unavailable because security scanning could not complete."
              : "This file is still undergoing security scanning. Try again shortly.",
          code,
        });
      }
      const url = await signDownload(plainFile.storageKey);
      res.json({ url, filename: plainFile.originalName || null });
    } catch (e) {
      logger.error("[cases] signed-get error:", e);
      if (e?.code === "NoSuchKey") {
        return res.status(404).json({ error: "File no longer available for download." });
      }
      res.status(500).json({ error: "Unable to sign file" });
    }
  })
);

router.patch(
  "/:caseId/files/:fileId/status",
  csrfProtection,
  requireCaseAccess("caseId", {
    project: "files status paralegal paralegalId escrowIntentId escrowStatus archived readOnly paralegalAccessRevokedAt",
  }),
  asyncHandler(matterFileWrites.handle(async (req, res) => {
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Administrators can only access the Matter archive." });
    }
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the Matter attorney can update file status" });
    }
    const doc = req.case;
    if (!requireMatterDocumentWorkspace(doc, res)) return;
    const writeReview = await matterFileWrites.read(req);
    const file = await CaseFile.findOne({ _id: req.params.fileId, caseId: doc._id });
    if (!file) return res.status(404).json({ error: "File not found" });

    const { status, notes } = req.body || {};
    const now = new Date();

    if (status) {
      if (!FILE_STATUS.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      file.status = status;
      if (status === "approved") file.approvedAt = now;
      else if (status !== "approved") file.approvedAt = null;
      if (status !== "pending_review") {
        file.revisionRequestedAt = null;
        file.revisionNotes = status === "approved" ? "" : file.revisionNotes;
      }
    }
    if (typeof notes === "string") {
      file.revisionNotes = cleanPlainText(notes, { max: 2000 });
      if (file.revisionNotes) file.revisionRequestedAt = now;
    }

    try {
      await matterFileWrites.run(req, writeReview, session => file.save({ session }));
    } catch (err) {
      if (err?.name === "VersionError") {
        return res.status(409).json({
          error: "This document was updated by another request. Refresh and try again.",
          code: "DOCUMENT_CONFLICT",
        });
      }
      throw err;
    }
    try {
      await logAction(req, "case.file.status.update", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { fileId: file._id, status: file.status },
      });
    } catch (auditError) {
      logger.error("[cases] document status audit persistence failed", { caseId: doc._id, error: auditError });
    }

    publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(doc, "matter_documents_refresh");
    await matterFileWrites.read(req);
    res.json({ file: normalizeFile(file.toObject ? file.toObject() : file) });
  }))
);

router.post(
  "/:caseId/files/:fileId/revision-request",
  csrfProtection,
  requireCaseAccess("caseId", {
    project: "files status paralegal paralegalId escrowIntentId escrowStatus archived readOnly paralegalAccessRevokedAt",
  }),
  asyncHandler(matterFileWrites.handle(async (req, res) => {
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Administrators can only access the Matter archive." });
    }
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the attorney can request revisions" });
    }
    const doc = req.case;
    if (!requireMatterDocumentWorkspace(doc, res)) return;
    const writeReview = await matterFileWrites.read(req);
    const file = await CaseFile.findOne({ _id: req.params.fileId, caseId: doc._id });
    if (!file) return res.status(404).json({ error: "File not found" });

    const note = cleanPlainText(req.body?.notes || "", { max: 2000 });
    file.revisionNotes = note;
    file.revisionRequestedAt = new Date();
    file.status = "pending_review";
    file.approvedAt = null;

    try {
      await matterFileWrites.run(req, writeReview, session => file.save({ session }));
    } catch (err) {
      if (err?.name === "VersionError") {
        return res.status(409).json({
          error: "This document was updated by another request. Refresh and try again.",
          code: "DOCUMENT_CONFLICT",
        });
      }
      throw err;
    }
    try {
      await logAction(req, "case.file.revision.request", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { fileId: file._id },
      });
    } catch (auditError) {
      logger.error("[cases] document approval audit persistence failed", { caseId: doc._id, error: auditError });
    }

    publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(doc, "matter_documents_refresh");
    await matterFileWrites.read(req);
    res.json({ file: normalizeFile(file.toObject ? file.toObject() : file) });
  }))
);

router.post(
  "/:caseId/files/:fileId/replace",
  csrfProtection,
  requireCaseAccess("caseId", {
    project: "files status paralegal paralegalId escrowIntentId escrowStatus archived readOnly paralegalAccessRevokedAt",
  }),
  asyncHandler(matterFileWrites.handle(async (req, res) => {
    if (req.acl?.isAdmin) {
      return res.status(403).json({ error: "Administrators can only access the Matter archive." });
    }
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the attorney can replace a document" });
    }
    const { key, original, mime, size } = req.body || {};
    if (!key || typeof key !== "string") return res.status(400).json({ error: "key is required" });
    const doc = req.case;
    if (!requireMatterDocumentWorkspace(doc, res)) return;
    const writeReview = await matterFileWrites.read(req);
    const storageKey = normalizeCaseStorageKey(key);
    const file = await CaseFile.findOne({ _id: req.params.fileId, caseId: doc._id });
    if (!file) return res.status(404).json({ error: "File not found" });
    let objectMetadata = null;
    try {
      objectMetadata = await verifyCaseDocumentObject({ caseId: doc._id, key: storageKey, declaredSize: size, declaredMime: mime });
    } catch (err) {
      if ([
        "INVALID_CASE_FILE_KEY",
        "CASE_FILE_METADATA_MISMATCH",
        "FILE_TYPE_NOT_ALLOWED",
        "FILE_EXTENSION_MISMATCH",
        "FILE_SIGNATURE_MISMATCH",
      ].includes(err?.code)) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      if (err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: "The uploaded document was not found in storage." });
      }
      throw err;
    }
    if (!Array.isArray(file.history)) file.history = [];
    if (file.storageKey) {
      file.history.push({ storageKey: file.storageKey, replacedAt: new Date() });
    }

    const filename = cleanString(original || "", { len: 400 }) || key.split("/").pop();
    file.storageKey = storageKey;
    file.originalName = filename;
    file.mimeType = String(objectMetadata?.ContentType || mime || "");
    file.size = Number.isFinite(Number(objectMetadata?.ContentLength))
      ? Number(objectMetadata.ContentLength)
      : Number.isFinite(Number(size)) ? Number(size) : 0;
    const retiredPreviewKey = decryptCaseFilePayload(file).previewKey;
    file.previewKey = ""; file.previewMimeType = ""; file.previewSize = 0;
    file.replacedAt = new Date();
    file.userId = req.user.id;
    file.uploadedByRole = req.user.role || "attorney";
    file.status = "attorney_revision";
    file.version = await nextCaseFileVersion(doc._id, filename);
    file.approvedAt = null;
    file.revisionRequestedAt = null;
    file.revisionNotes = "";
    file.securityStatus = malwareScanRequired() ? "pending" : "not_required";
    file.securityScanResult = malwareScanRequired() ? "PENDING" : "NOT_REQUIRED";
    file.securityScannedAt = null;
    file.securityCheckedAt = null;

    try {
      await matterFileWrites.run(req, writeReview, async session => {
        await matterRetirement.assertAttachable(doc._id, storageKey, session);
        await matterFileWrites.preserveUploadReceipt(await CaseFile.collection.findOne({ _id: file._id }, { session }), session);
        if (retiredPreviewKey) await matterRetirement.stage({ caseId: doc._id, key: retiredPreviewKey, reason: "preview_replaced", putOutcome: "unconfirmed" }, session);
        await presignedUploads.attach(req, storageKey, file._id, session);
        await file.save({ session });
      });
    } catch (err) {
      if (err?.name === "VersionError" || Number(err?.code) === 11000) {
        return res.status(409).json({
          error: "This document was replaced by another request. Refresh and try again.",
          code: "DOCUMENT_CONFLICT",
        });
      }
      throw err;
    }
    try {
      await logAction(req, "case.file.replace", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { fileId: file._id, key: file.storageKey },
      });
    } catch (auditError) {
      logger.error("[cases] document replacement audit persistence failed", { caseId: doc._id, error: auditError });
    }

    publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(doc, "matter_documents_refresh");
    await matterFileWrites.read(req);
    res.json({ file: normalizeFile(file.toObject ? file.toObject() : file) });
  }))
);

router.post(
  "/:caseId/apply",
  requireRole("paralegal"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid Matter ID" });

    const doc = await Case.findById(caseId).select(
      "status paralegal paralegalId applicants archived attorney attorneyId title practiceArea details briefSummary paymentReleased totalAmount lockedTotalAmount amountLockedAt remainingAmount relistRequestedAt payoutFinalizedAt payoutFinalizedType relistPending jobId job"
    );
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(doc)) {
      return res.status(400).json({ error: "This Matter is no longer accepting applications." });
    }
    if (doc.archived) return res.status(400).json({ error: "This Matter is not accepting applications" });
    if (doc.paralegal) return res.status(400).json({ error: "A paralegal has already been hired" });
    const statusKey = String(doc.status || "").toLowerCase();
    const autoRelistTypes = new Set(["zero_auto", "partial_attorney", "expired_zero", "admin"]);
    const autoRelistEligible =
      statusKey === "paused" &&
      !!doc.payoutFinalizedAt &&
      autoRelistTypes.has(String(doc.payoutFinalizedType || ""));
    const relisted = statusKey === "paused" && doc.relistRequestedAt && doc.payoutFinalizedAt;
    if (statusKey !== "open" && !relisted && !autoRelistEligible) {
      return res.status(400).json({ error: "Applications are closed for this Matter" });
    }
    if (autoRelistEligible && !doc.relistRequestedAt) {
      doc.relistRequestedAt = doc.payoutFinalizedAt || new Date();
      doc.relistPending = false;
      await doc.save();
    }
    const caseAttorneyId = doc.attorneyId || doc.attorney || null;
    if (caseAttorneyId && (await isBlockedBetween(req.user.id, caseAttorneyId))) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }

    let jobId = resolveCaseJobId(doc);
    if (!jobId) {
      jobId = await ensureCaseJobOpen(doc);
      await Case.updateOne({ _id: doc._id }, { $set: { jobId } });
    }
    const coverLetter = cleanPlainText(req.body?.note || req.body?.coverLetter || "", { max: 2000 });
    const application = await createApplicationForJob(jobId, req.user, coverLetter, req.body?.requirementAnswers);
    try {
      await logAction(req, "case.apply", {
        targetType: "case",
        targetId: doc._id,
        meta: { applicationId: application._id, canonical: true },
      });
    } catch (auditError) {
      logger.error("[cases] application creation audit persistence failed", { caseId: doc._id, error: auditError });
    }
    res.status(201).json(application);
  })
);

const applicationDecisions = require("../services/applicationDecisions");
const applicationDecisionNoStore = (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); };
async function recordApplicationDecision(req, res, legacyAction) {
  try {
    const result = await applicationDecisions.persist(req, { legacyAction });
    if (!result.repeated) {
      publishCaseProjectionRefresh(result.doc, result.receipt.action === "reject" ? "application_rejected_refresh" : "application_shortlist_refresh", { additionalUserIds: [result.receipt.applicantId], caseEvent: "case", discovery: result.receipt.action === "reject" });
    }
    return res.json({ ...(legacyAction ? { ok: true, updated: true, starred: result.receipt.starred } : {}), receipt: result.receipt });
  } catch (error) {
    return res.status(error.status || 503).json({ code: error.publicCode || "APPLICATION_REVIEW_DECISION_UNCONFIRMED", error: "The application decision was not confirmed. Check its saved result before trying again." });
  }
}
router.get("/:caseId/application-review/:applicantId/decision", applicationDecisionNoStore, requireCaseAccess("caseId"), async (req, res) => {
  try { return res.json(await applicationDecisions.review(req)); }
  catch (error) { return res.status(error.status || 503).json({ code: error.publicCode || "APPLICATION_REVIEW_DECISION_UNAVAILABLE", error: "Application decisions could not be loaded. Refresh the applications to try again." }); }
});
router.get("/:caseId/application-review/:applicantId/decision/:requestId", applicationDecisionNoStore, requireCaseAccess("caseId"), async (req, res) => {
  try { return res.json(await applicationDecisions.findReceipt(req)); }
  catch (error) { return res.status(error.status || 503).json({ code: error.publicCode || "APPLICATION_REVIEW_DECISION_UNAVAILABLE", error: "The saved application decision could not be checked." }); }
});
router.post("/:caseId/application-review/:applicantId/decision", applicationDecisionNoStore, csrfProtection, requireCaseAccess("caseId"), (req, res) => recordApplicationDecision(req, res));
router.post("/:caseId/applicants/:paralegalId/star", applicationDecisionNoStore, verifyToken, csrfProtection, requireCaseAccess("caseId"), (req, res) => recordApplicationDecision(req, res, "star"));
router.post("/:caseId/applicants/:paralegalId/reject", applicationDecisionNoStore, verifyToken, csrfProtection, requireCaseAccess("caseId"), (req, res) => recordApplicationDecision(req, res, "reject"));

router.post(
  "/:caseId/invite",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (req.user.role !== "attorney" || !req.acl?.isAttorney) {
      return res.status(403).json({ error: "Only the Matter attorney can invite paralegals." });
    }
    const { paralegalId } = req.body || {};
    if (!isObjId(paralegalId)) {
      return res.status(400).json({ error: "A valid paralegalId is required." });
    }
    const invitee = await User.findById(paralegalId).select(
      "firstName lastName role status email stripeAccountId stripeOnboarded stripePayoutsEnabled stripeChargesEnabled"
    );
    if (!invitee || invitee.role !== "paralegal" || invitee.status !== "approved") {
      return res.status(400).json({ error: "Select an approved paralegal to invite." });
    }
    const inviteeEmail = normalizeEmail(invitee.email);
    const bypassStripe = STRIPE_BYPASS_PARALEGAL_EMAILS.has(inviteeEmail);
    if (!bypassStripe) {
      if (!invitee.stripeAccountId) {
        return res.status(403).json({ error: "Paralegal must connect Stripe before being invited." });
      }
      if (!invitee.stripeOnboarded || !invitee.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboardedUser(invitee);
        if (!refreshed) {
          return res.status(403).json({ error: "Paralegal must complete Stripe onboarding before being invited." });
        }
      }
    }

    const caseDoc = await Case.findById(req.params.caseId)
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role")
      .populate("paralegal", "firstName lastName email role");
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }

    if (!isCaseAttorneyUser(caseDoc, req.user.id)) {
      return res.status(403).json({ error: "You are not the attorney for this Matter." });
    }
    const ownerId = String(req.user.id);
    const ownerAliases = { attorney: caseDoc.attorney?._id || caseDoc.attorney, attorneyId: caseDoc.attorneyId?._id || caseDoc.attorneyId };
    if (
      normalizeId(caseDoc.attorney) !== ownerId ||
      normalizeId(caseDoc.attorneyId) !== ownerId
    ) {
      caseDoc.attorney = req.user.id;
      caseDoc.attorneyId = req.user.id;
    }
    if (await isBlockedBetween(ownerId, invitee._id)) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    if (caseDoc.paralegal) {
      return res.status(400).json({ error: "A paralegal has already been assigned to this Matter." });
    }
    if (caseDoc.archived) {
      return res.status(400).json({ error: "This Matter is archived." });
    }

    seedLegacyInvite(caseDoc);
    const existingInvite = listCaseInvites(caseDoc).find(
      (invite) => String(invite.paralegalId) === String(invitee._id)
    );
    if (existingInvite) {
      if (existingInvite.status === "pending") {
        return res.status(400).json({ error: "An invitation is already pending for this paralegal." });
      }
      if (existingInvite.status === "accepted") {
        return res.status(400).json({ error: "This paralegal has already accepted." });
      }
    }

    const reviewed = await reviewedInvitation(req, res, invitee._id);
    if (reviewed === null) return;
    const invitationResult = await sendInvitationWithNotices(res, { caseDoc, paralegalId: invitee._id, reviewed, ownerAliases, actorId: req.user.id, authVersion: req.authVersion });
    if (!invitationResult) return;
    if (!invitationResult.sent) {
      const messages = {
        already_pending: "An invitation is already pending for this paralegal.",
        already_accepted: "This paralegal has already accepted.",
        already_assigned: "A paralegal has already been assigned to this Matter.",
        matter_closed: "This Matter is no longer accepting invitations.",
        ownership_conflict: "Matter ownership needs review before invitations can be sent.",
      };
      return res.status(409).json({
        error: messages[invitationResult.reason] || "The invitation could not be sent because the matter changed.",
        code: "INVITATION_CONFLICT",
      });
    }
    const updatedCase = await Case.findById(caseDoc._id)
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role");
    publishCaseEvent(caseDoc._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(updatedCase || caseDoc, "matter_invitation_sent_refresh", [invitee._id]);

    try {
      await logAction(req, "paralegal_invited", {
        targetType: "case",
        targetId: caseDoc._id,
        caseId: caseDoc._id,
        meta: { paralegalId: invitee._id },
      });
    } catch (auditError) {
      logger.error("[cases] paralegal invitation audit persistence failed", {
        caseId: caseDoc._id,
        error: auditError,
      });
    }

    await invitationResult.dispatch?.().catch(error => logger.warn("[cases] saved invitation refresh deferred", { caseId: caseDoc._id, error }));

    res.json({ success: true, ...(invitationResult.confirmation ? { invitationConfirmation: invitationResult.confirmation } : {}) });
  })
);

router.post("/:caseId/requirements/decline",csrfProtection,requireRole("paralegal"),asyncHandler(async(req,res)=>{
  try {res.json(await require('../services/matterRequirements').declineRequirements({caseId:req.params.caseId,userId:req.user.id,authVersion:req.authVersion,requirements:req.body?.requirements,confirmed:req.body?.confirmed}));}
  catch(error){res.status(error.status||503).json({error:error.status?error.message:'The decision could not be confirmed. Try again.'});}
}));

router.post(
  "/:caseId/invite/accept",
  csrfProtection,
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid Matter ID" });
    const { caseDoc, legacyInvitation } = await require("../services/legacyInvitationResponse").load(caseId, req.user.id);
    if (caseDoc) await caseDoc.populate([{ path: "attorney", select: "firstName lastName email role" }, { path: "attorneyId", select: "firstName lastName email role" }, { path: "pendingParalegalId", select: "firstName lastName email role" }]);
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }
    // If another paralegal is already assigned, block; otherwise allow the accept to repair state.
    if (caseDoc.paralegal && String(caseDoc.paralegal) !== String(req.user.id)) {
      return res.status(400).json({ error: "This Matter is already assigned to another paralegal." });
    }
    const caseAttorneyId = caseDoc.attorneyId?._id || caseDoc.attorneyId || caseDoc.attorney?._id || caseDoc.attorney;
    if (caseAttorneyId && (await isBlockedBetween(caseAttorneyId, req.user.id))) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }

    const inviteRecord = listCaseInvites(caseDoc).find(
      (invite) => String(invite.paralegalId) === String(req.user.id)
    );
    if (!inviteRecord || !["pending", "accepted"].includes(inviteRecord.status)) {
      return res.status(400).json({ error: "No pending invitation for this Matter." });
    }

    const paralegal = await User.findById(req.user.id).select(
      "firstName lastName email stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled resumeURL linkedInURL availability availabilityDetails location languages specialties yearsExperience bio profileImage avatarURL"
    );
    const resumeReference = paralegal ? captureResumeReference(paralegal) : null;
    if (inviteRecord.status === "pending" && !paralegal?.stripeAccountId) {
      return res.status(403).json({ error: "Connect Stripe before accepting invitations." });
    }
    if (
      inviteRecord.status === "pending" &&
      (!paralegal?.stripeOnboarded || !paralegal?.stripePayoutsEnabled)
    ) {
      const refreshed = await ensureStripeOnboardedUser(paralegal);
      if (!refreshed) {
        return res.status(403).json({ error: "Complete Stripe onboarding before accepting invitations." });
      }
    }
    if (inviteRecord.status === "pending" && !hasScopeTasks(caseDoc)) {
      return res.status(400).json({
        error: "Add at least one task before hiring a paralegal for this Matter.",
      });
    }
    const acceptancePolicy = inviteRecord.status === "pending" ? evaluateParalegalInvitationAcceptance({
      user: { ...req.user, _id: req.user.id, role: "paralegal", status: "approved" },
      caseDoc,
      inviteStatus: inviteRecord.status,
      stripeState: {
        accountId: paralegal.stripeAccountId,
        detailsSubmitted: paralegal.stripeOnboarded === true,
        payoutsEnabled: paralegal.stripePayoutsEnabled === true,
      },
      blockedRelationship: false,
    }) : { allowed: true, blockers: [] };
    if (!acceptancePolicy.allowed) {
      return res.status(400).json({
        error: "This invitation cannot be accepted right now.",
        blockers: acceptancePolicy.blockers,
      });
    }
    const respondedAt = new Date();
    const invitationResult = await respondToInvitation({
      caseId,
      legacyInvitation,
      actorId: req.user.id,
      authVersion: req.authVersion,
      paralegalId: req.user.id,
      decision: "accept",
      resumeReference,
      requirementAnswers: req.body?.requirementAnswers,
      respondedAt,
      lockedTotalAmount: caseDoc.lockedTotalAmount ?? caseDoc.totalAmount,
      amountLockedAt: caseDoc.amountLockedAt || respondedAt,
      paralegalProfile: {
        resumeURL: paralegal?.resumeURL || "",
        linkedInURL: paralegal?.linkedInURL || "",
        profileSnapshot: shapeParalegalSnapshot(paralegal),
      },
    });
    if (!invitationResult.updated && !invitationResult.idempotent) {
      return res.status(409).json({
        error:
          invitationResult.reason === "already_assigned"
            ? "This Matter is already assigned to another paralegal."
            : "This invitation has already changed.",
        code: "INVITATION_CONFLICT",
      });
    }
    const updatedCase = await Case.findById(caseId);
    if (invitationResult.updated) {
      publishCaseEvent(caseDoc._id, "case", { at: new Date().toISOString() });
      publishCaseParticipantRefresh(updatedCase || caseDoc, "matter_invitation_accepted_refresh", [req.user.id]);
    }

    if (invitationResult.updated) try {
      await logAction(req, "paralegal_invite_accepted", {
        targetType: "case",
        targetId: caseDoc._id,
        caseId: caseDoc._id,
      });
    } catch (auditError) {
      logger.error("[cases] invitation acceptance audit persistence failed", {
        caseId: caseDoc._id,
        error: auditError,
      });
    }

    await invitationResult.dispatch?.().catch(error => logger.warn("[cases] saved invitation response refresh deferred", { caseId, error }));

    res.json({
      success: true,
      alreadyProcessed: invitationResult.idempotent === true,
      reconciliationPending: invitationResult.reconciliationPending === true,
    });
  })
);

router.post(
  "/:caseId/invite/revoke",
  csrfProtection,
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid Matter ID" });
    const caseDoc = await Case.findById(caseId);
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }
    const assignedParalegalId = caseDoc.paralegalId || caseDoc.paralegal || null;
    if (assignedParalegalId) {
      return res.status(400).json({ error: "This Matter has already been hired." });
    }

    const invitationResult = await revokeAcceptedInvitation({
      caseId,
      paralegalId: req.user.id,
      actorId: req.user.id,
      authVersion: req.authVersion,
    });
    if (!invitationResult.revoked && !invitationResult.idempotent) {
      return res.status(409).json({
        error:
          invitationResult.reason === "already_assigned"
            ? "This Matter has already been hired."
            : "No accepted invitation is available to revoke.",
        code: "INVITATION_CONFLICT",
      });
    }
    if (invitationResult.revoked) {
      const updatedCase = await Case.findById(caseId);
      publishCaseEvent(caseDoc._id, "case", { at: new Date().toISOString() });
      publishCaseParticipantRefresh(updatedCase || caseDoc, "matter_invitation_revoked_refresh", [req.user.id]);
    }
    await invitationResult.dispatch?.().catch(error => logger.warn("[cases] saved invitation response refresh deferred", { caseId, error }));

    res.json({
      success: true,
      alreadyProcessed: invitationResult.idempotent === true,
      reconciliationPending: invitationResult.reconciliationPending === true,
    });
  })
);

router.post(
  "/:caseId/invite/decline",
  csrfProtection,
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid Matter ID" });
    const { caseDoc, legacyInvitation } = await require("../services/legacyInvitationResponse").load(caseId, req.user.id);
    if (caseDoc) await caseDoc.populate([{ path: "attorney", select: "firstName lastName email role" }, { path: "attorneyId", select: "firstName lastName email role" }, { path: "pendingParalegalId", select: "firstName lastName email role" }]);
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }
    const inviteRecord = listCaseInvites(caseDoc).find(
      (invite) => String(invite.paralegalId) === String(req.user.id)
    );
    if (!inviteRecord || !["pending", "declined"].includes(inviteRecord.status)) {
      return res.status(400).json({ error: "No pending invitation for this Matter." });
    }
    const respondedAt = new Date();
    const invitationResult = await respondToInvitation({
      caseId,
      legacyInvitation,
      actorId: req.user.id,
      authVersion: req.authVersion,
      paralegalId: req.user.id,
      decision: "decline",
      respondedAt,
    });
    if (!invitationResult.updated && !invitationResult.idempotent) {
      return res.status(409).json({
        error: "This invitation has already changed.",
        code: "INVITATION_CONFLICT",
      });
    }
    const updatedCase = await Case.findById(caseId);
    if (invitationResult.updated) {
      publishCaseEvent(caseDoc._id, "case", { at: new Date().toISOString() });
      publishCaseParticipantRefresh(updatedCase || caseDoc, "matter_invitation_declined_refresh", [req.user.id]);
    }

    if (invitationResult.updated) try {
      await logAction(req, "paralegal_declined", {
        targetType: "case",
        targetId: caseDoc._id,
        caseId: caseDoc._id,
      });
    } catch (auditError) {
      logger.error("[cases] invitation decline audit persistence failed", {
        caseId: caseDoc._id,
        error: auditError,
      });
    }

    await invitationResult.dispatch?.().catch(error => logger.warn("[cases] saved invitation response refresh deferred", { caseId, error }));

    res.json({
      success: true,
      alreadyProcessed: invitationResult.idempotent === true,
      reconciliationPending: invitationResult.reconciliationPending === true,
    });
  })
);

/**
 * POST /api/cases/:caseId/withdraw
 * Paralegal requests withdrawal from an active case.
 */
router.post(
  "/:caseId/withdraw",
  csrfProtection,
  requireRole("paralegal"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid Matter ID" });

    const caseDoc = await Case.findById(caseId)
      .populate("paralegal", "firstName lastName email role stripeAccountId stripeOnboarded stripePayoutsEnabled")
      .populate("withdrawnParalegalId", "firstName lastName")
      .populate("attorney", "firstName lastName email role");
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }

    const paralegalRef = normalizeId(caseDoc.paralegalId || caseDoc.paralegal);
    if (
      !paralegalRef &&
      normalizeId(caseDoc.withdrawnParalegalId) === String(req.user.id) &&
      caseDoc.pausedReason === "paralegal_withdrew"
    ) {
      return res.json({
        ok: true,
        alreadyProcessed: true,
        status: caseDoc.status,
        pausedReason: caseDoc.pausedReason,
        disputeDeadlineAt: caseDoc.disputeDeadlineAt,
        withdrawalOutcome: caseDoc.payoutFinalizedType === "zero_auto" ? "zero_auto" : "awaiting_attorney_decision",
      });
    }
    if (!paralegalRef || String(paralegalRef) !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not assigned to this Matter" });
    }
    if (caseDoc.attorney && caseDoc.attorneyId && normalizeId(caseDoc.attorney) !== normalizeId(caseDoc.attorneyId)) {
      return res.status(409).json({ error: "The Matter owner could not be verified. Refresh before withdrawing.", code: "WITHDRAWAL_CONFLICT" });
    }
    const normalizedStatus = normalizeCaseStatusValue(caseDoc.status);
    if (["disputed", "closed", "completed"].includes(normalizedStatus)) {
      return res.status(400).json({ error: "This Matter cannot be withdrawn right now." });
    }
    if (areAllScopeTasksComplete(caseDoc)) {
      return res.status(400).json({
        error: "All tasks are complete. Please coordinate with the attorney to release the payment.",
      });
    }
    const withdrawalPolicy = evaluateWithdrawalEligibility({
      user: { ...req.user, _id: req.user.id, role: "paralegal" },
      caseDoc,
    });
    if (!withdrawalPolicy.allowed) {
      return res.status(400).json({
        error: "This Matter cannot be withdrawn right now.",
        blockers: withdrawalPolicy.blockers,
      });
    }

    const now = new Date();
    const completedCount = countCompletedScopeTasks(caseDoc);
    const totalTasks = currentAssignmentScopeProgress(caseDoc).totalTaskCount;
    const withdrawingParalegal = caseDoc.paralegal;
    const updateFields = {
      paralegalNameSnapshot:
        caseDoc.paralegalNameSnapshot || formatPersonName(withdrawingParalegal || {}),
      withdrawnParalegalId: paralegalRef,
      paralegal: null,
      paralegalId: null,
      pendingParalegalId: null,
      pendingParalegalInvitedAt: null,
      status: "paused",
      pausedReason: "paralegal_withdrew",
      pausedAt: now,
      adminDisputeDeadlineAt: null,
      adminDisputeOverdueNotifiedAt: null,
      remainingAmount: resolveRemainingAmount(caseDoc),
    };
    if (completedCount === 0) {
      Object.assign(updateFields, {
        partialPayoutAmount: 0,
        payoutFinalizedType: "zero_auto",
        payoutFinalizedAt: now,
        disputeDeadlineAt: null,
        relistRequestedAt: caseDoc.relistRequestedAt || now,
        relistPending: false,
      });
    } else if (completedCount < totalTasks) {
      Object.assign(updateFields, {
        disputeDeadlineAt: null,
        partialPayoutAmount: null,
        payoutFinalizedType: null,
        payoutFinalizedAt: null,
        relistRequestedAt: null,
        relistPending: false,
      });
    }
    const expectedTaskRevision = Number(caseDoc.taskRevision || 0);
    const hasPredecessorSettlement = hasPredecessorWithdrawalSettlement(caseDoc);
    const predecessorSettlement = hasPredecessorSettlement ? {
      withdrawnParalegalId: caseDoc.withdrawnParalegalId?._id || caseDoc.withdrawnParalegalId,
      paralegalNameSnapshot: formatPersonName(caseDoc.withdrawnParalegalId),
      payoutFinalizedAt: caseDoc.payoutFinalizedAt,
      payoutFinalizedType: caseDoc.payoutFinalizedType,
      partialPayoutAmount: caseDoc.partialPayoutAmount,
      remainingAmount: caseDoc.remainingAmount,
      feeParalegalPct: caseDoc.feeParalegalPct,
      feeAttorneyPct: caseDoc.feeAttorneyPct,
      payoutTransferId: caseDoc.payoutTransferId,
      pausedAt: caseDoc.pausedAt,
    } : null;
    const taskRevisionClause = expectedTaskRevision === 0
      ? { $or: [{ taskRevision: 0 }, { taskRevision: { $exists: false } }] }
      : { taskRevision: expectedTaskRevision };
    let updatedCase, dispatchers = [];
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        dispatchers = [];
        await lockActiveAccounts([req.user.id], session, { ownerId: req.user.id, authVersion: req.authVersion });
        const actor = await User.findById(req.user.id).select("role").session(session).lean();
        if (actor?.role !== "paralegal") throw Object.assign(new Error("This account changed. Sign in again before continuing."), { status: 403 });
        updatedCase = await Case.findOneAndUpdate(
          {
            _id: caseDoc._id,
            status: { $in: ["in progress", "in_progress"] },
            paymentReleased: { $ne: true },
            hiredAt: caseDoc.hiredAt || null,
            attorney: caseDoc.attorney?._id || caseDoc.attorney || null,
            attorneyId: caseDoc.attorneyId || null,
            payoutFinalizedAt: hasPredecessorSettlement ? caseDoc.payoutFinalizedAt : null,
            ...(hasPredecessorSettlement ? { withdrawnParalegalId: predecessorSettlement.withdrawnParalegalId, hiredAt: caseDoc.hiredAt } : {}),
            completionClaimStatus: { $nin: ["claimed", "needs_reconciliation"] },
            disputes: { $not: { $elemMatch: { status: "open" } } },
            tasks: { $elemMatch: { completed: { $ne: true } } },
            ...taskRevisionClause,
            $and: [
              { $or: [{ paralegal: req.user.id }, { paralegalId: req.user.id }] },
              { $or: [{ paralegal: req.user.id }, { paralegal: null }] },
              { $or: [{ paralegalId: req.user.id }, { paralegalId: null }] },
            ],
          },
          { $set: updateFields, ...(predecessorSettlement ? { $push: { withdrawalHistory: predecessorSettlement } } : {}) },
          { returnDocument: "after", runValidators: true, session }
        );
        if (!updatedCase) return;
        if (completedCount === 0) await ensureCaseJobOpen(updatedCase, { session });
        await AuditLog.logFromReq(req, "case.withdrawal.requested", {
          targetType: "case", targetId: updatedCase._id, caseId: updatedCase._id,
          meta: { completedCount, totalTasks }, session,
        });
        const attorneyId = updatedCase.attorney?._id || updatedCase.attorneyId;
        const outcome = completedCount === 0 ? "zero_auto" : "awaiting_attorney_decision";
        for (const [userId, role] of [[attorneyId, "attorney"], [req.user.id, "paralegal"]]) {
          if (!userId) throw new Error("Withdrawal recipient could not be verified.");
          const dispatch = await notifyUser(userId, "case_update", {
            caseId: String(updatedCase._id), caseTitle: updatedCase.title || "Untitled Matter",
            outcome: "paralegal_withdrawn", summary: withdrawalNotices.withdrawalSummary(outcome, role),
          }, { actorUserId: req.user.id, session, deferDispatch: true, withdrawalRequest: true });
          if (!dispatch) throw new Error("Withdrawal recipient is unavailable.");
          dispatchers.push(dispatch);
        }
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    } finally {
      updatedCase?.$session(null);
      await session.endSession();
    }
    if (!updatedCase) {
      const latest = await Case.findById(caseId).lean();
      if (
        String(latest?.withdrawnParalegalId || "") === String(req.user.id) &&
        latest?.pausedReason === "paralegal_withdrew" &&
        !latest?.paralegal &&
        !latest?.paralegalId
      ) {
        return res.json({
          ok: true,
          alreadyProcessed: true,
          status: latest.status,
          pausedReason: latest.pausedReason,
          disputeDeadlineAt: latest.disputeDeadlineAt,
          withdrawalOutcome: latest.payoutFinalizedType === "zero_auto" ? "zero_auto" : "awaiting_attorney_decision",
        });
      }
      return res.status(409).json({
        error: "The matter changed before withdrawal could be recorded. Refresh before trying again.",
        code: "WITHDRAWAL_CONFLICT",
      });
    }
    if (completedCount === 0) {
      try {
        await updatedCase.populate("attorney", "firstName lastName role");
        await updatedCase.populate("withdrawnParalegalId", "firstName lastName role");
        await generateWithdrawalReceipts(updatedCase, { grossAmount: 0 });
      } catch (err) {
        logger.warn("[cases] withdrawal receipt generation failed", err?.message || err);
      }
    }
    publishCaseEvent(updatedCase._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(updatedCase, "matter_withdrawn_refresh", [req.user.id]);

    for (const dispatch of dispatchers) {
      try { await dispatch(); }
      catch (error) { logger.warn("[cases] Withdrawal refresh failed; saved notices remain available.", { caseId: updatedCase._id, error }); }
    }

    res.json({
      ok: true,
      status: updatedCase.status,
      pausedReason: updatedCase.pausedReason,
      disputeDeadlineAt: updatedCase.disputeDeadlineAt,
      withdrawalOutcome: completedCount === 0 ? "zero_auto" : "awaiting_attorney_decision",
      message:
        completedCount === 0
          ? "You withdrew from this Matter. No payout will be issued because no tasks were completed, and the Matter has been relisted."
          : "You withdrew from this Matter. The attorney will now decide whether to issue a partial payout based on completed work.",
    });
  })
);

/** Attorney withdrawal decisions share the same guarded operation in V1 and V2. */
router.post("/:caseId/reject-payout", csrfProtection, requireCaseAccess("caseId"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { const value = await attorneyWithdrawal.legacy(req, "reject", withdrawalOptions(req)); res.json({ ok: value.operation?.status === "recorded", disputeDeadlineAt: value.reviewDeadline, withdrawalReview: value }); } catch (error) { attorneyWithdrawal.sendError(res, error); }
}));

router.post("/:caseId/relist", csrfProtection, requireCaseAccess("caseId"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { const value = await attorneyWithdrawal.legacy(req, "relist", withdrawalOptions(req)); res.json({ ok: value.operation?.status === "recorded", relistPending: false, relistRequestedAt: value.relistedAt, withdrawalReview: value }); } catch (error) { attorneyWithdrawal.sendError(res, error); }
}));

const matterPreEngagement = require("../services/matterPreEngagement");
const preEngagementNotices = require("../services/matterPreEngagementNotifications");
router.get("/:caseId/pre-engagement/review/:applicantId", applicationDecisionNoStore, requireCaseAccess("caseId"), async (req, res) => {
  try { return res.json(await matterPreEngagement.read(req)); }
  catch (error) { return res.status(error.status || 503).json({ code: error.publicCode || "PRE_ENGAGEMENT_UNAVAILABLE", error: "Pre-engagement requirements could not be loaded. Refresh to review the saved request." }); }
});
async function reviewedPreEngagement(req, res, applicantId, operation) {
  // Existing clients keep their existing contract. V2 sends the exact reviewed
  // fingerprint and target; these requests must not fall back to a fresh write.
  if (req.body?.reviewedRevision === undefined) return { legacy: true };
  try {
    const review = await matterPreEngagement.reviewed(req, applicantId);
    if (!review.dto[operation === "request" ? "canRequest" : req.body?.action === "approve" ? "canApprove" : "canReview"]) {
      res.status(409).json({ code: "PRE_ENGAGEMENT_INELIGIBLE", error: "This application or Matter no longer permits that pre-engagement action." });
      return null;
    }
    return review;
  } catch (error) {
    res.status(error.status || 503).json({ code: error.publicCode || "PRE_ENGAGEMENT_UNAVAILABLE", error: "The pre-engagement request changed or could not be verified. Review the saved request before continuing." });
    return null;
  }
}
async function commitPreEngagement(review, filter, update, options) {
  if (review.legacy) return Case.findOneAndUpdate(filter, update, options);
  const values = {};
  for (const [field, input] of Object.entries(update.$set)) {
    const schemaType = Case.schema.path(field), value = schemaType.cast(input);
    await schemaType.doValidate(value, null);
    values[field] = value?.toObject ? value.toObject() : value;
  }
  // Use the raw reviewed filter to preserve BSON/text aliases and exact earlier
  // records. Only validated pre-engagement fields and the timestamp are written.
  return Case.collection.findOneAndUpdate(review.filter, { $set: { ...values, updatedAt: new Date() }, $inc: { __v: 1 } }, { returnDocument: "after", ...(options.session ? { session: options.session } : {}) });
}

/**
 * POST /api/cases/:caseId/pre-engagement/:paralegalId/request
 * Persists a pre-engagement draft for a case/paralegal pairing (attorney-only).
 */
router.post(
  "/:caseId/pre-engagement/:paralegalId/request",
  requireCaseAccess("caseId"),
  csrfProtection,
  preEngagementUpload.single("confidentialityFile"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney) {
      return res.status(403).json({ error: "Only the Matter attorney can request pre-engagement items" });
    }

    const { caseId, paralegalId } = req.params;
    if (!isObjId(caseId) || !isObjId(paralegalId)) {
      return res.status(400).json({ error: "Invalid caseId or paralegalId" });
    }

    let selectedCase = await Case.findById(caseId);
    if (!selectedCase) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(selectedCase)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }
    if (selectedCase.paralegalId || selectedCase.paralegal) {
      return res.status(400).json({ error: "A paralegal has already been hired" });
    }
    if (!hasScopeTasks(selectedCase)) {
      return res.status(400).json({
        error: "Add at least one task before requesting pre-engagement items for this Matter.",
      });
    }

    const rawAttorney = selectedCase.attorney || selectedCase.attorneyId;
    const attorneyOnCase =
      rawAttorney && typeof rawAttorney === "object" && rawAttorney._id
        ? String(rawAttorney._id)
        : String(rawAttorney || "");
    if (!attorneyOnCase || attorneyOnCase !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not the attorney for this Matter" });
    }

    const paralegal = await User.findById(paralegalId).select("firstName lastName email role");
    if (!paralegal) return res.status(404).json({ error: "Paralegal not found" });
    if (String(paralegal.role || "").toLowerCase() !== "paralegal") {
      return res.status(400).json({ error: "Pre-engagement items can only be requested from a paralegal." });
    }
    const initialReview = await reviewedPreEngagement(req, res, paralegalId, "request");
    if (!initialReview) return;
    if (initialReview.legacy && !(await hasActiveCaseCandidate(selectedCase, paralegalId))) {
      return res.status(400).json({ error: "Select an active applicant or accepted invite first." });
    }
    if (await isBlockedBetween(attorneyOnCase, paralegal._id)) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    const previousPreEngagement = (initialReview.legacy ? selectedCase.preEngagement : initialReview.facts.preEngagement) || null;
    const canReuseConfidentialityDocument = Boolean(
      previousPreEngagement?.confidentialityDocument?.key &&
      String(previousPreEngagement.requestedParalegalId || "") === String(paralegalId) &&
      String(previousPreEngagement.status || "").toLowerCase() === "requested"
    );

    const confidentialityAgreementRequired = parseBooleanField(req.body?.confidentialityAgreementRequired);
    const conflictsCheckRequired = parseBooleanField(req.body?.conflictsCheckRequired);
    if (!confidentialityAgreementRequired && !conflictsCheckRequired) {
      return res.status(400).json({ error: "Select at least one pre-engagement requirement." });
    }

    const conflictsDetails = conflictsCheckRequired
      ? cleanMessage(req.body?.conflictsDetails || "").slice(0, 5000)
      : "";
    if (conflictsCheckRequired && !conflictsDetails.trim()) {
      return res.status(400).json({ error: "Conflicts check details are required." });
    }
    if (confidentialityAgreementRequired && !req.file && !canReuseConfidentialityDocument) {
      return res.status(400).json({ error: "A confidentiality agreement file is required." });
    }
    const preEngagementPolicy = evaluatePreEngagementRequest({
      caseDoc: selectedCase,
      ownerAuthorized: attorneyOnCase === String(req.user.id),
      targetSelected: true,
      partiesBlocked: false,
      confidentialityRequired: confidentialityAgreementRequired,
      conflictsCheckRequired,
      conflictsDetails,
      confidentialityDocumentReady: Boolean(req.file || canReuseConfidentialityDocument),
    });
    if (!preEngagementPolicy.ready) {
      return res.status(400).json({
        error: "This pre-engagement request is not ready.",
        blockers: preEngagementPolicy.blockers,
      });
    }

    let confidentialityDocument = confidentialityAgreementRequired && canReuseConfidentialityDocument
      ? previousPreEngagement.confidentialityDocument
      : null;
    if (confidentialityAgreementRequired && req.file) {
      if (!S3_BUCKET) {
        return res.status(500).json({ error: "File uploads are unavailable right now." });
      }
      try {
        validatePreEngagementUpload(req.file);
      } catch (error) {
        return res.status(400).json({
          error: "The confidentiality agreement contents do not match its file type.",
          code: error?.code || "FILE_SIGNATURE_MISMATCH",
        });
      }
      const originalName = normalizeUploadedFileName(
        req.file.originalname,
        `pre-engagement-${Date.now()}`
      );
      const key = buildPreEngagementDocumentKey(caseId, originalName);
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype || "application/octet-stream",
          ContentLength: req.file.size,
          ACL: "private",
          ...preEngagementSseParams(),
        })
      );
      confidentialityDocument = {
        key,
        name: originalName,
        mimeType: req.file.mimetype || "",
        size: req.file.size || 0,
        uploadedAt: new Date(),
      };
    }

    const requestedAt = new Date();
    const nextRevision = Math.max(0, Number(previousPreEngagement?.revision || 0)) + 1;
    const nextPreEngagement = {
      revision: nextRevision,
      status: "requested",
      requestedParalegalId: paralegal._id,
      confidentialityAgreementRequired,
      conflictsCheckRequired,
      conflictsDetails,
      confidentialityDocument,
      requestedAt,
      requestedBy: req.user.id,
    };
    const finalReview = await reviewedPreEngagement(req, res, paralegalId, "request");
    if (!finalReview) {
      if (req.file && confidentialityDocument?.key && confidentialityDocument.key !== previousPreEngagement?.confidentialityDocument?.key) {
        await deletePreEngagementObject(confidentialityDocument.key).catch(error => logger.error("[cases] unconfirmed pre-engagement upload cleanup failed", error?.name));
      }
      return;
    }
    const savedRequest = await preEngagementNotices.save(session => commitPreEngagement(finalReview,
      {
        _id: caseId,
        archived: { $ne: true },
        paymentReleased: { $ne: true },
        status: { $nin: ["completed", "closed", "disputed"] },
        $and: [
          preEngagementRevisionClause(previousPreEngagement),
          {
            $or: [
              { preEngagement: null },
              { preEngagement: { $exists: false } },
              { "preEngagement.status": "requested" },
            ],
          },
          {
            $or: [
              { attorney: req.user.id },
              { attorneyId: req.user.id },
            ],
          },
          { $or: [{ paralegal: null }, { paralegal: { $exists: false } }] },
          { $or: [{ paralegalId: null }, { paralegalId: { $exists: false } }] },
        ],
      },
      { $set: { preEngagement: nextPreEngagement } },
      { returnDocument: "after", runValidators: true, session }
    ), { actorUserId: req.user.id, kind: "requested", applicationId: await findPreEngagementApplicationId(caseId, paralegalId) }).catch(async error => {
      if (error.publicCode === "PRE_ENGAGEMENT_NOTICE_UNAVAILABLE" && req.file && confidentialityDocument?.key && confidentialityDocument.key !== previousPreEngagement?.confidentialityDocument?.key) {
        await deletePreEngagementObject(confidentialityDocument.key).catch(cleanupError => logger.error("[cases] rolled-back pre-engagement upload cleanup failed", cleanupError?.name));
      }
      throw error;
    });
    selectedCase = savedRequest.matter;
    if (!selectedCase) {
      if (req.file && confidentialityDocument?.key && confidentialityDocument.key !== previousPreEngagement?.confidentialityDocument?.key) {
        await deletePreEngagementObject(confidentialityDocument.key).catch((err) => {
          logger.error("[cases] Failed to clean up superseded pre-engagement upload", err?.message || err);
        });
      }
      return res.status(409).json({
        error: "The pre-engagement request changed while you were editing it. Refresh and try again.",
        code: "PRE_ENGAGEMENT_CONFLICT",
      });
    }
    const previousDocumentKey = previousPreEngagement?.confidentialityDocument?.key || "";
    if (
      previousDocumentKey &&
      previousDocumentKey !== String(confidentialityDocument?.key || "")
    ) {
      await deletePreEngagementObject(previousDocumentKey).catch((err) => {
        logger.error("[cases] Failed to remove replaced pre-engagement upload", err?.message || err);
      });
    }

    publishCaseEvent(selectedCase._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(selectedCase, "pre_engagement_requested_refresh", [paralegal._id]);

    await savedRequest.dispatch?.().catch(error => logger.warn("[cases] saved pre-engagement request refresh deferred", error?.name));

    return res.json({
      success: true,
      preEngagement: shapePreEngagement(selectedCase.preEngagement),
    });
  })
);

router.post(
  "/:caseId/pre-engagement/respond",
  requireCaseAccess("caseId", {
    allowApplicants: true,
    alsoAllow: (req, caseDoc) => {
      if (String(req.user?.role || "").toLowerCase() !== "paralegal") return false;
      const requestedId = caseDoc?.preEngagement?.requestedParalegalId;
      return !!requestedId && String(requestedId) === String(req.user.id || "");
    },
    project: "status archived applicants preEngagement",
  }),
  csrfProtection,
  preEngagementUpload.single("paralegalConfidentialityFile"),
  asyncHandler(async (req, res) => {
    if (String(req.user?.role || "").toLowerCase() !== "paralegal") {
      return res.status(403).json({ error: "Only the requested paralegal can respond to pre-engagement items." });
    }

    const { caseId } = req.params;
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "Invalid caseId" });
    }

    const caseDoc = await Case.findById(caseId);
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }
    const preEngagement = caseDoc.preEngagement || null;
    if (!preEngagement || !preEngagement.requestedParalegalId) {
      return res.status(400).json({ error: "No pre-engagement request is available for this Matter." });
    }
    if (String(preEngagement.requestedParalegalId) !== String(req.user.id || "")) {
      return res.status(403).json({ error: "You are not the requested paralegal for this Matter." });
    }

    if (req.body?.expectedPreEngagementRevision !== undefined) {
      const displayed = String(req.body.expectedPreEngagementRevision);
      if (!/^(0|[1-9]\d*)$/.test(displayed) || !Number.isSafeInteger(Number(displayed))) {
        return res.status(400).json({ code: "PRE_ENGAGEMENT_REVISION_INVALID", error: "The displayed requirements could not be verified. Refresh and review them again." });
      }
      if (Number(displayed) !== Math.max(0, Number(preEngagement.revision || 0))) {
        return res.status(409).json({ code: "PRE_ENGAGEMENT_CONFLICT", error: "The requirements changed since you opened them. Review the updated request before submitting." });
      }
    }

    const confidentialityAcknowledged = parseBooleanField(req.body?.confidentialityAcknowledged);
    const conflictsResponseType = String(req.body?.conflictsResponseType || "").trim().toLowerCase();
    const conflictsDisclosureText = cleanMessage(req.body?.conflictsDisclosureText || "").slice(0, 5000);

    if (preEngagement.confidentialityAgreementRequired && !confidentialityAcknowledged) {
      return res.status(400).json({ error: "Review and acknowledge the confidentiality agreement to continue." });
    }
    if (preEngagement.conflictsCheckRequired) {
      if (!["none_known", "disclosure"].includes(conflictsResponseType)) {
        return res.status(400).json({ error: "Choose a conflicts check response." });
      }
      if (conflictsResponseType === "disclosure" && !conflictsDisclosureText.trim()) {
        return res.status(400).json({ error: "Enter your conflicts disclosure details." });
      }
    }
    const submissionPolicy = evaluatePreEngagementSubmission({
      user: { ...req.user, _id: req.user.id, role: "paralegal" },
      caseDoc,
    });
    if (!submissionPolicy.allowed) {
      return res.status(400).json({
        error: "These pre-engagement items cannot be submitted right now.",
        blockers: submissionPolicy.blockers,
      });
    }

    let paralegalConfidentialityDocument = preEngagement.paralegalConfidentialityDocument || null;
    if (preEngagement.confidentialityAgreementRequired && req.file) {
      if (!S3_BUCKET) {
        return res.status(500).json({ error: "File uploads are unavailable right now." });
      }
      try {
        validatePreEngagementUpload(req.file);
      } catch (error) {
        return res.status(400).json({
          error: "The signed confidentiality agreement contents do not match its file type.",
          code: error?.code || "FILE_SIGNATURE_MISMATCH",
        });
      }
      const originalName = normalizeUploadedFileName(
        req.file.originalname,
        `signed-confidentiality-${Date.now()}`
      );
      const key = buildPreEngagementResponseDocumentKey(caseId, originalName);
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype || "application/octet-stream",
          ContentLength: req.file.size,
          ACL: "private",
          ...preEngagementSseParams(),
        })
      );
      paralegalConfidentialityDocument = {
        key,
        name: originalName,
        mimeType: req.file.mimetype || "",
        size: req.file.size || 0,
        uploadedAt: new Date(),
      };
    }

    const submittedAt = new Date();
    const confidentialityWasAcknowledged = !!(
      preEngagement.confidentialityAgreementRequired ? confidentialityAcknowledged : false
    );
    const storedConflictsResponseType = preEngagement.conflictsCheckRequired ? conflictsResponseType : "";
    const storedConflictsDisclosureText =
      preEngagement.conflictsCheckRequired && conflictsResponseType === "disclosure"
        ? conflictsDisclosureText
        : "";
    const previousSignedDocumentKey = preEngagement.paralegalConfidentialityDocument?.key || "";
    const nextRevision = Math.max(0, Number(preEngagement.revision || 0)) + 1;
    const savedResponse = await preEngagementNotices.save(session => Case.findOneAndUpdate(
      {
        _id: caseId,
        archived: { $ne: true },
        paymentReleased: { $ne: true },
        status: { $nin: ["completed", "closed", "disputed"] },
        "preEngagement.requestedParalegalId": req.user.id,
        "preEngagement.status": String(preEngagement.status || "").toLowerCase(),
        ...preEngagementRevisionClause(preEngagement),
      },
      {
        $set: {
          "preEngagement.revision": nextRevision,
          "preEngagement.status": "submitted",
          "preEngagement.confidentialityAcknowledged": confidentialityWasAcknowledged,
          "preEngagement.confidentialityAcknowledgedAt": confidentialityWasAcknowledged ? submittedAt : null,
          "preEngagement.confidentialityAcknowledgedBy": confidentialityWasAcknowledged ? req.user.id : null,
          "preEngagement.paralegalConfidentialityDocument": paralegalConfidentialityDocument,
          "preEngagement.conflictsResponseType": storedConflictsResponseType,
          "preEngagement.conflictsDisclosureText": storedConflictsDisclosureText,
          "preEngagement.submittedAt": submittedAt,
          "preEngagement.submittedBy": req.user.id,
          "preEngagement.reviewedAt": null,
          "preEngagement.reviewedBy": null,
        },
      },
      { returnDocument: "after", runValidators: true, session }
    ), { actorUserId: req.user.id, kind: "submitted" }).catch(async error => {
      const uploadedKey = String(paralegalConfidentialityDocument?.key || "");
      if (error.publicCode === "PRE_ENGAGEMENT_NOTICE_UNAVAILABLE" && req.file && uploadedKey && uploadedKey !== previousSignedDocumentKey) {
        await deletePreEngagementObject(uploadedKey).catch(cleanupError => logger.error("[cases] rolled-back response upload cleanup failed", cleanupError?.name));
      }
      throw error;
    });
    const updatedCase = savedResponse.matter;
    if (!updatedCase) {
      const uploadedKey = String(paralegalConfidentialityDocument?.key || "");
      if (uploadedKey && uploadedKey !== String(previousSignedDocumentKey || "")) {
        await deletePreEngagementObject(uploadedKey).catch((err) => {
          logger.error("[cases] Failed to clean up superseded response upload", err?.message || err);
        });
      }
      return res.status(409).json({
        error: "This pre-engagement request changed before your response was saved. Refresh and try again.",
        code: "PRE_ENGAGEMENT_CONFLICT",
      });
    }
    if (
      previousSignedDocumentKey &&
      previousSignedDocumentKey !== String(paralegalConfidentialityDocument?.key || "")
    ) {
      await deletePreEngagementObject(previousSignedDocumentKey).catch((err) => {
        logger.error("[cases] Failed to remove replaced response upload", err?.message || err);
      });
    }
    const savedPreEngagement = updatedCase.preEngagement;

    publishCaseEvent(updatedCase._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(updatedCase, "pre_engagement_submitted_refresh", [req.user.id]);

    await savedResponse.dispatch?.().catch(error => logger.warn("[cases] saved pre-engagement response refresh deferred", error?.name));

    return res.json({
      success: true,
      preEngagement: shapePreEngagement(savedPreEngagement),
    });
  })
);

router.post(
  "/:caseId/pre-engagement/review",
  requireCaseAccess("caseId", {
    project: "status archived attorney attorneyId preEngagement",
  }),
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (String(req.user?.role || "").toLowerCase() !== "attorney") {
      return res.status(403).json({ error: "Only the Matter attorney can review pre-engagement items." });
    }

    const { caseId } = req.params;
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "Invalid caseId" });
    }

    const caseDoc = await Case.findById(caseId);
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(caseDoc)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }
    const initialReview = await reviewedPreEngagement(req, res, req.body?.applicantId, "review");
    if (!initialReview) return;
    const preEngagement = (initialReview.legacy ? caseDoc.preEngagement : initialReview.facts.preEngagement) || null;
    if (!preEngagement || !preEngagement.requestedParalegalId) {
      return res.status(400).json({ error: "No pre-engagement submission is available for review." });
    }

    const action = String(req.body?.action || "").trim().toLowerCase();
    if (!["approve", "request_changes"].includes(action)) {
      return res.status(400).json({ error: "Choose a valid review action." });
    }
    const desiredStatus = action === "approve" ? "approved" : "changes_requested";
    const currentStatus = String(preEngagement.status || "").toLowerCase();
    if (currentStatus === desiredStatus) {
      return res.json({
        success: true,
        alreadyProcessed: true,
        preEngagement: shapePreEngagement(preEngagement),
      });
    }
    if (currentStatus !== "submitted") {
      return res.status(409).json({
        error: "Pre-engagement is not ready for attorney review.",
        code: "PRE_ENGAGEMENT_CONFLICT",
      });
    }
    if (action === "approve") {
      try {
        await assertPreEngagementDocumentsSafe(preEngagement);
      } catch (error) {
        if (error?.statusCode) {
          return res.status(error.statusCode).json({ error: error.message, code: error.code });
        }
        throw error;
      }
    }

    const reviewedAt = new Date();
    const nextRevision = Math.max(0, Number(preEngagement.revision || 0)) + 1;
    const finalReview = await reviewedPreEngagement(req, res, req.body?.applicantId, "review");
    if (!finalReview) return;
    const savedReview = await preEngagementNotices.save(session => commitPreEngagement(finalReview,
      {
        _id: caseId,
        archived: { $ne: true },
        paymentReleased: { $ne: true },
        status: { $nin: ["completed", "closed", "disputed"] },
        "preEngagement.requestedParalegalId": preEngagement.requestedParalegalId,
        "preEngagement.status": "submitted",
        ...preEngagementRevisionClause(preEngagement),
        $and: [
          { $or: [{ attorney: req.user.id }, { attorneyId: req.user.id }] },
        ],
      },
      {
        $set: {
          "preEngagement.revision": nextRevision,
          "preEngagement.status": desiredStatus,
          "preEngagement.reviewedAt": reviewedAt,
          "preEngagement.reviewedBy": req.user.id,
        },
      },
      { returnDocument: "after", runValidators: true, session }
    ), { actorUserId: req.user.id, kind: desiredStatus === "changes_requested" ? desiredStatus : null, applicationId: await findPreEngagementApplicationId(caseId, preEngagement.requestedParalegalId) });
    const updatedCase = savedReview.matter;
    if (!updatedCase) {
      const latest = await Case.findById(caseId).select("preEngagement").lean();
      if (finalReview.legacy && String(latest?.preEngagement?.status || "").toLowerCase() === desiredStatus) {
        return res.json({
          success: true,
          alreadyProcessed: true,
          preEngagement: shapePreEngagement(latest.preEngagement),
        });
      }
      return res.status(409).json({
        error: "This pre-engagement submission was reviewed or changed by another request. Refresh to continue.",
        code: "PRE_ENGAGEMENT_CONFLICT",
      });
    }
    const savedPreEngagement = updatedCase.preEngagement;

    publishCaseEvent(updatedCase._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(updatedCase, "pre_engagement_reviewed_refresh", [savedPreEngagement.requestedParalegalId]);

    await savedReview.dispatch?.().catch(error => logger.warn("[cases] saved pre-engagement review refresh deferred", error?.name));

    return res.json({
      success: true,
      preEngagement: shapePreEngagement(savedPreEngagement),
    });
  })
);

const matterHiringReview = require("../services/matterHiringReview");
const hiringReviewOptions = () => ({ stripeClient: stripe, bypassEmails: STRIPE_BYPASS_PARALEGAL_EMAILS });
function hiringFailure(error, res) { return res.status(error.status || 503).json({ code: error.publicCode || "HIRING_UNAVAILABLE", error: "Hiring and funding could not be verified. Refresh the review before continuing." }); }
router.get("/:caseId/hiring-review/:applicantId", requireCaseAccess("caseId"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { return res.json(await matterHiringReview.read(req, hiringReviewOptions())); } catch (error) { return hiringFailure(error, res); }
}));
function hiringConfirmation(review) { return { caseId: review.dto.caseId, applicantId: review.dto.applicantId, reviewedRevision: review.dto.revision, mode: review.dto.canResume ? "finish_hire" : review.dto.relisted ? "replacement" : "hire_and_fund", chargeCents: review.dto.canResume ? 0 : review.dto.chargeCents, budgetCents: review.dto.budgetCents, remainingCents: review.dto.remainingCents }; }
async function stageHireNotifications(doc, { req, paralegalId, paralegalName, pendingInvitees, rejectedApplicantIds }, session) {
  const notices = [
    [paralegalId, "case_work_ready", { link: buildCaseLink(doc) }],
    ...[...rejectedApplicantIds].map(userId => [userId, "application_denied", { link: "dashboard-paralegal.html", outcome: "matter_filled" }]),
    ...pendingInvitees.map(userId => [userId, "case_invite_response", { response: "filled", paralegalId, paralegalName }]),
  ];
  const dispatchers = [], recipients = new Set();
  for (const [userId, type, payload] of notices) {
    const recipient = String(userId).toLowerCase();
    if (recipients.has(recipient)) continue;
    recipients.add(recipient);
    const dispatch = await notifyUser(userId, type, { caseId: doc._id, caseTitle: doc.title || "Untitled Matter", ...payload }, { actorUserId: req.user.id, session, deferDispatch: true, workReady: type === "case_work_ready" });
    if (dispatch) dispatchers.push(dispatch);
  }
  return dispatchers;
}
async function dispatchHireNotifications(dispatchers, caseId) {
  for (const dispatch of dispatchers) {
    try { await dispatch(); }
    catch (error) { logger.warn("[case-hire] committed notification dispatch failed", { caseId, error }); }
  }
}
async function saveReviewedHire(doc, review, claim, { req, jobId, paralegalId, replacementBefore = null, pendingInvitees = [], rejectedApplicantIds = new Set(), paralegalName = "" }) {
  if (review) {
    const where = { ...review.filter, __v: (review.facts.__v ?? 0) + 1, hiringClaimToken: claim.token, hiringClaimStatus: "claimed" };
    for (const key of Object.keys(where)) if ((key.startsWith("hiringClaim") && !["hiringClaimToken", "hiringClaimStatus"].includes(key)) || key.startsWith("fundingRequest")) delete where[key];
    doc.$where = where;
  }
  // The charge is already verified outside this transaction. Assignment,
  // posting and canonical outcomes commit together; a rollback leaves the
  // existing claim recovery able to finish using that charge without retrying it.
  let dispatchers = [];
  await withActiveAccountWrite([req.user.id, doc.attorney, doc.attorneyId, doc.paralegal, doc.paralegalId], async session => {
    if (replacementBefore) await require("../services/replacementWithdrawal").stage(doc, replacementBefore, claim.token, { session, reviewedRevision: review?.withdrawalRevision });
    await doc.save({ session });
    await markJobAssigned(doc, jobId, session);
    await rejectJobApplications(jobId, paralegalId, session);
    dispatchers = await stageHireNotifications(doc, { req, paralegalId, paralegalName, pendingInvitees, rejectedApplicantIds }, session);
    return doc;
  }, { ownerId: req.user.id, authVersion: req.auth?.payload?.av });
  return dispatchers;
}
async function releaseUnchargedReviewedHire(doc, review, claim, error) {
  if (review.dto.canResume) return markCaseHireNeedsReconciliation(doc._id, claim.token, error, { id: review.facts.hiringClaimPaymentIntentId }, review.dto.chargeCents);
  return releaseCaseHireClaim(doc._id, claim.token);
}
async function failedHiringCharge(req, doc, applicantId, claim, error, paymentIntent, totalCharge, customerId, res) {
  let intent = paymentIntent || error?.payment_intent || null;
  let canceled = false;
  try {
    if (typeof intent?.id === "string" && /^pi_[A-Za-z0-9_]+$/.test(intent.id)) {
      const requestedIntentId = intent.id;
      intent = await stripe.paymentIntents.retrieve(requestedIntentId);
      if (intent?.id !== requestedIntentId) throw new Error("The charge response did not match the attempted payment.");
      const matches = value => value?.metadata?.caseId === String(doc._id) && value.metadata?.attorneyId === String(req.user.id) && value.metadata?.paralegalId === String(applicantId) && String(value.customer?.id || value.customer || "") === customerId && value.amount === totalCharge && value.currency === (doc.currency || "usd") && Number(value.amount_received || 0) === 0;
      if (matches(intent)) {
        if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(intent.status)) intent = await stripe.paymentIntents.cancel(intent.id);
        canceled = intent.id === requestedIntentId && matches(intent) && intent.status === "canceled";
      }
      if (canceled) {
        await PaymentOperation.updateOne({ operationKey: `hire-card-failure:${intent.id}` }, { $setOnInsert: { operationKey: `hire-card-failure:${intent.id}`, caseId: doc._id, kind: "funding", fingerprint: buildFundingFingerprint({ caseId: doc._id, amount: totalCharge, currency: doc.currency || "usd", mode: "hire-card-failure", targetId: String(applicantId) }), status: "failed", amount: totalCharge, currency: doc.currency || "usd", stripeObjectId: intent.id, stripePaymentIntentId: intent.id, lastError: "The provider confirmed cancellation without a completed charge.", completedAt: new Date() } }, { upsert: true });
        const cleared = await Case.collection.updateOne({ _id: doc._id, hiringClaimToken: claim.token, hiringClaimStatus: "claimed" }, { $set: { fundingRequestKey: "", fundingRequestFingerprint: "" } });
        if (!cleared.matchedCount) throw new Error("Hire claim changed during charge cancellation.");
        await releaseCaseHireClaim(doc._id, claim.token);
        return res.status(402).json({ code: "HIRING_CARD_NOT_CHARGED", error: "The card charge did not complete. Review the saved card before trying again." });
      }
    }
  } catch (recoveryError) {
    logger.warn("[case-hire] reviewed charge outcome requires reconciliation", { caseId: doc._id, error: recoveryError });
  }
  await markCaseHireNeedsReconciliation(doc._id, claim.token, error || new Error("Charge outcome could not be verified."), intent, totalCharge);
  return res.status(409).json({ code: "HIRING_CHARGE_UNCONFIRMED", error: "The charge outcome needs verification before another hiring attempt." });
}

/**
 * POST /api/cases/:caseId/hire/:paralegalId
 * Assigns a paralegal to an existing case (attorney-only).
 */
router.post(
  "/:caseId/hire/:paralegalId",
  requireCaseAccess("caseId"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney) {
      return res.status(403).json({ error: "Only the Matter attorney can hire for this Matter" });
    }

    const { caseId, paralegalId } = req.params;
    if (!isObjId(caseId) || !isObjId(paralegalId)) {
      return res.status(400).json({ error: "Invalid caseId or paralegalId" });
    }

    res.set("Cache-Control", "private, no-store");
    let reviewedHire = null;
    if (req.body?.reviewedRevision !== undefined) {
      try { reviewedHire = await matterHiringReview.reviewed(req, hiringReviewOptions()); } catch (error) { return hiringFailure(error, res); }
    }
    let selectedCase = await Case.findById(caseId);
    if (!selectedCase) return res.status(404).json({ error: "Matter not found" });
    if (isFinalCaseDoc(selectedCase)) {
      return res.status(400).json({ error: "Completed Matters cannot be modified." });
    }
    if (selectedCase.paralegalId || selectedCase.paralegal) {
      return res.status(400).json({ error: "A paralegal has already been hired" });
    }
    if (!reviewedHire && !(await hasActiveCaseCandidate(selectedCase, paralegalId))) {
      return res.status(400).json({ error: "Select an active applicant or accepted invite to hire." });
    }
    if (!hasScopeTasks(selectedCase)) {
      return res.status(400).json({
        error: "Add at least one task before hiring a paralegal for this Matter.",
      });
    }

    const rawAttorney = selectedCase.attorney || selectedCase.attorneyId;
    const attorneyOnCase =
      rawAttorney && typeof rawAttorney === "object" && rawAttorney._id
        ? String(rawAttorney._id)
        : String(rawAttorney || "");
    if (!attorneyOnCase || attorneyOnCase !== String(req.user.id)) {
      return res.status(403).json({ error: "You are not the attorney for this Matter" });
    }

    try { await legacyApplications.begin(req, [selectedCase]); }
    catch (error) { return hiringFailure(error, res); }

    const relistEligible =
      normalizeCaseStatusValue(selectedCase.status) === "paused" &&
      selectedCase.pausedReason === "paralegal_withdrew" &&
      !!selectedCase.escrowIntentId &&
      String(selectedCase.escrowStatus || "").toLowerCase() === "funded";

    const paralegal = await User.findById(paralegalId).select(
      "firstName lastName email role status stripeAccountId stripeOnboarded stripePayoutsEnabled"
    );
    if (!paralegal) return res.status(404).json({ error: "Paralegal not found" });
    if (await isBlockedBetween(attorneyOnCase, paralegal._id)) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    const paralegalEmail = String(paralegal.email || "").toLowerCase().trim();
    const bypassStripe = STRIPE_BYPASS_PARALEGAL_EMAILS.has(paralegalEmail);
    if (!bypassStripe) {
      if (!paralegal.stripeAccountId) {
        return res.status(403).json({ error: "Connect Stripe before hiring a paralegal." });
      }
      if (!paralegal.stripeOnboarded || !paralegal.stripePayoutsEnabled) {
        const refreshed = await ensureStripeOnboardedUser(paralegal);
        if (!refreshed) {
          return res.status(403).json({ error: "Complete Stripe onboarding before hiring a paralegal." });
        }
      }
    }

    try {
      const expired = await finalizeExpiredDisputeWindow(selectedCase);
      if (expired) {
        selectedCase = await Case.findById(caseId);
        if (!selectedCase || String(selectedCase.attorney || selectedCase.attorneyId) !== attorneyOnCase || selectedCase.paralegal || selectedCase.paralegalId || isFinalCaseDoc(selectedCase)) return res.status(409).json({ error: "The Matter changed during withdrawal finalization. Review it before hiring." });
      }
    } catch (err) {
      logger.warn("[cases] dispute window finalize failed", err?.message || err);
    }

    if (relistEligible) {
      if (!selectedCase.payoutFinalizedAt) {
        return res.status(400).json({ error: "Payout must be finalized before hiring a new paralegal." });
      }
      if (String(selectedCase.fundingIntegrityStatus || "").toLowerCase() !== "verified") {
        let existingIntent;
        try {
          existingIntent = await stripe.paymentIntents.retrieve(selectedCase.escrowIntentId);
        } catch (err) {
          logger.error("[case-hire] Unable to verify relisted matter funding", err?.message || err);
          return res.status(502).json({ error: "Unable to verify matter funding. Please try again shortly." });
        }
        const { transferable } = stripe.isTransferablePaymentIntent(existingIntent, {
          caseId: selectedCase._id,
        });
        const integrity = validatePaymentIntentForCase(existingIntent, selectedCase);
        if (!transferable || !integrity.valid) {
          selectedCase.fundingIntegrityStatus = integrity.valid ? "pending" : "failed";
          selectedCase.fundingIntegrityFailure = integrity.reasons.join(",");
          await selectedCase.save();
          return res.status(409).json({
            error: "Matter funding must be verified before a new paralegal can be hired.",
            code: "FUNDING_VERIFICATION_REQUIRED",
          });
        }
        selectedCase.fundingIntegrityStatus = "verified";
        selectedCase.fundingIntegrityFailure = "";
        selectedCase.fundingVerifiedAt = new Date();
      }
      if (isDisputeWindowActive(selectedCase)) {
        return res.status(400).json({ error: "Hiring is locked until the payout is finalized." });
      }
      const relistBudgetCents = Number(resolveRemainingAmount(selectedCase) ?? 0);
      if (!Number.isFinite(relistBudgetCents) || relistBudgetCents <= 0) {
        return res.status(400).json({ error: "Remaining Matter amount is invalid." });
      }

      if (reviewedHire) {
        try { reviewedHire = await matterHiringReview.reviewed(req, hiringReviewOptions()); } catch (error) { return hiringFailure(error, res); }
      }
      const hireClaim = await claimCaseHire(selectedCase, paralegalId, reviewedHire, req);
      if (!hireClaim.acquired) {
        return res.status(409).json({
          error: "The Matter changed or another hire is being processed. Refresh the application before hiring.",
          code: "HIRE_IN_PROGRESS",
        });
      }
      selectedCase = hireClaim.caseDoc;
      if (reviewedHire) {
        try { await matterHiringReview.verifyParties(req, reviewedHire); } catch (error) { await releaseUnchargedReviewedHire(selectedCase, reviewedHire, hireClaim, error); return hiringFailure(error, res); }
      }

      const replacementBefore = hireClaim.replacementSource;
      seedLegacyInvite(selectedCase);
      const pendingInvitees = listCaseInvites(selectedCase)
        .filter((invite) => invite.status === "pending" && String(invite.paralegalId) !== String(paralegalId))
        .map((invite) => invite.paralegalId);
      const existingInvite = listCaseInvites(selectedCase).find(
        (invite) => String(invite.paralegalId) === String(paralegalId)
      );

      selectedCase.paralegal = paralegalId;
      selectedCase.paralegalId = paralegalId;
      if (existingInvite) {
        upsertInvite(selectedCase, paralegalId, { status: "accepted", respondedAt: new Date() });
      }
      markOtherInvites(selectedCase, paralegalId, "declined");
      syncLegacyPendingFields(selectedCase);
      selectedCase.hiredAt = new Date();
      selectedCase.assignmentCompletedTaskIndexes = selectedCase.tasks.flatMap((task, index) => task.completed ? [index] : []);
      selectedCase.tasksLocked = true;
      selectedCase.paralegalNameSnapshot = formatPersonName(paralegal);
      selectedCase.escrowStatus = "funded";
      selectedCase.transitionTo(IN_PROGRESS_STATUS);
      selectedCase.pausedReason = null;
      selectedCase.pausedAt = null;
      selectedCase.relistPending = false;
      clearCaseHireClaim(selectedCase);

      let rejectedApplicantIds, jobId, hireNotices;

      try {
        ({ rejectedApplicantIds, jobId } = await stageHiredApplications(req, selectedCase, paralegalId));
        hireNotices = await saveReviewedHire(selectedCase, reviewedHire, hireClaim, { replacementBefore, req, jobId, paralegalId, pendingInvitees, rejectedApplicantIds, paralegalName: formatPersonName(paralegal) });
      } catch (err) {
        await releaseCaseHireClaim(selectedCase._id, hireClaim.token).catch(
          logPromiseFailure(logger, "[case-hire] claim release after save failure failed", {
            caseId: selectedCase._id,
          })
        );
        if (err.publicCode) return hiringFailure(err, res);
        throw err;
      }
      await selectedCase.populate([
        { path: "paralegal", select: "firstName lastName email role avatarURL" },
        { path: "attorney", select: "firstName lastName email role avatarURL" },
      ]);

      publishCaseEvent(selectedCase._id, "case", { at: new Date().toISOString() });
      publishCaseParticipantRefresh(
        selectedCase,
        "matter_hired_refresh",
        [paralegalId, ...pendingInvitees, ...rejectedApplicantIds]
      );

      await dispatchHireNotifications(hireNotices, selectedCase._id);

      res.json({ success: true, relisted: true, ...(reviewedHire ? { hiringConfirmation: hiringConfirmation(reviewedHire) } : {}) });
      return;
    }

    const amountToCharge = selectedCase.lockedTotalAmount;
    const budgetCents = Math.round(Number(amountToCharge) || 0);
    if (!Number.isFinite(budgetCents) || budgetCents < MIN_CASE_AMOUNT_CENTS) {
      return res.status(400).json({ error: "Matter amount must be at least $400 before hiring." });
    }

    const attorney = await User.findById(req.user.id).select("firstName lastName email role stripeCustomerId");
    if (!attorney) return res.status(404).json({ error: "Attorney not found" });

    const attorneyFee = Math.max(0, Math.round(budgetCents * (resolveAttorneyFeePct(selectedCase) / 100)));
    const paralegalFee = Math.max(0, Math.round(budgetCents * (resolveParalegalFeePct(selectedCase) / 100)));
    const totalCharge = Math.round(budgetCents + attorneyFee);

    if (!attorney.email) {
      return res.status(400).json({ error: "Attorney email is required to fund Stripe." });
    }

    const customerId = await ensureStripeCustomer(attorney);
    const defaultPaymentMethodId = reviewedHire?.dto.canResume ? null : await fetchDefaultPaymentMethodId(customerId);
    if (
      isAttorneyPaymentMethodRequired(ATTORNEY_WORKFLOW_STAGES.HIRE_AND_FUND) &&
      !defaultPaymentMethodId && !reviewedHire?.dto.canResume
    ) {
      return res.status(400).json({ error: "Add a payment method before hiring." });
    }
    const hiringPolicy = evaluateHiringEligibility({
      caseDoc: selectedCase,
      ownerAuthorized: attorneyOnCase === String(req.user.id),
      targetSelected: true,
      partiesBlocked: false,
      paralegalApproved:
        String(paralegal.role || "").toLowerCase() === "paralegal" &&
        String(paralegal.status || "").toLowerCase() === "approved",
      paralegalPayoutSetupReady:
        bypassStripe || Boolean(paralegal.stripeAccountId && paralegal.stripeOnboarded && paralegal.stripePayoutsEnabled),
      paymentMethodSaved: Boolean(defaultPaymentMethodId) || !!reviewedHire?.dto.canResume,
    });
    if (!hiringPolicy.ready) {
      return res.status(400).json({ error: "This matter is not ready to hire and fund.", blockers: hiringPolicy.blockers });
    }

    if (reviewedHire) {
      try { reviewedHire = await matterHiringReview.reviewed(req, hiringReviewOptions()); } catch (error) { return hiringFailure(error, res); }
      if (reviewedHire.dto.chargeCents !== totalCharge || String(reviewedHire.user.stripeCustomerId || "") !== customerId || !reviewedHire.dto.canResume && reviewedHire.dto.card?.id !== defaultPaymentMethodId) return res.status(409).json({ code: "HIRING_CHANGED", error: "The reviewed charge or payment card changed." });
    }
    const hireClaim = await claimCaseHire(selectedCase, paralegalId, reviewedHire, req);
    if (!hireClaim.acquired) {
      return res.status(409).json({
        error: "The Matter changed or another hire is being processed. Refresh the application before hiring.",
        code: "HIRE_IN_PROGRESS",
      });
    }
    selectedCase = hireClaim.caseDoc;

    if (reviewedHire) {
      try { await matterHiringReview.verifyParties(req, reviewedHire); } catch (error) { await releaseUnchargedReviewedHire(selectedCase, reviewedHire, hireClaim, error); return hiringFailure(error, res); }
    }
    let paymentIntent = null;
    let forceNewFundingKey = false;
    const recoverableFundingIntentId =
      selectedCase.escrowIntentId || selectedCase.hiringClaimPaymentIntentId || "";
    if (recoverableFundingIntentId) {
      try {
        const existing = await stripe.paymentIntents.retrieve(recoverableFundingIntentId);
        if (existing?.status === "succeeded") {
          const transferCheck = stripe.isTransferablePaymentIntent(existing, {
            caseId: selectedCase._id,
          });
          const sameTarget =
            String(existing?.metadata?.paralegalId || "") === String(paralegalId);
          const sameAmount = Number(existing?.amount_received || existing?.amount || 0) === totalCharge;
          const sameCurrency =
            String(existing?.currency || "").toLowerCase() ===
            String(selectedCase.currency || "usd").toLowerCase();
          if (transferCheck?.transferable && sameTarget && sameAmount && sameCurrency) {
            paymentIntent = existing;
          } else {
            await markCaseHireNeedsReconciliation(
              selectedCase._id,
              hireClaim.token,
              new Error("Existing successful funding does not match the requested hire."),
              existing,
              Number(existing?.amount_received || existing?.amount || 0)
            ).catch(logPromiseFailure(logger, "[case-hire] mismatched funding reconciliation marker failed", {
              caseId: selectedCase._id,
            }));
            return res.status(409).json({
              error: "Existing matter funding needs reconciliation before another hire can proceed.",
              code: "HIRE_RECONCILIATION_REQUIRED",
            });
          }
        } else if (reviewedHire?.dto.canResume) {
          throw new Error("The reviewed funding is no longer a completed charge.");
        } else if (existing && !["succeeded", "canceled"].includes(existing.status)) {
          await stripe.paymentIntents.cancel(existing.id);
          forceNewFundingKey = true;
        } else if (existing?.status === "canceled") {
          forceNewFundingKey = true;
        }
      } catch (err) {
        await markCaseHireNeedsReconciliation(
          selectedCase._id,
          hireClaim.token,
          err,
          { id: recoverableFundingIntentId },
          totalCharge
        ).catch(logPromiseFailure(logger, "[case-hire] funding verification reconciliation marker failed", {
          caseId: selectedCase._id,
        }));
        logger.error("[case-hire] Unable to verify existing payment intent", err?.message || err);
        return res.status(502).json({
          error: "Unable to verify existing matter funding. No new charge was attempted.",
          code: "HIRE_RECONCILIATION_REQUIRED",
        });
      }
    }

    if (!paymentIntent && reviewedHire?.dto.canResume) {
      await markCaseHireNeedsReconciliation(selectedCase._id, hireClaim.token, new Error("Reviewed funding could not be reused."), { id: recoverableFundingIntentId }, totalCharge);
      return res.status(409).json({ code: "HIRING_RECONCILIATION", error: "The earlier funding needs review before the hire can be finished." });
    }
    if (!paymentIntent) {
      try {
        const idempotencyKey = await resolveFundingIdempotencyKey(selectedCase, totalCharge, {
          mode: "hire-charge",
          forceNew: forceNewFundingKey,
          targetId: paralegalId,
        });
        paymentIntent = await stripe.paymentIntents.create(
          {
            amount: totalCharge,
            currency: selectedCase.currency || "usd",
            customer: customerId,
            payment_method: defaultPaymentMethodId,
            off_session: true,
            confirm: true,
            receipt_email: attorney.email,
            transfer_group: stripe.caseTransferGroup
              ? stripe.caseTransferGroup(selectedCase._id)
              : `case_${selectedCase._id.toString()}`,
            metadata: {
              caseId: String(selectedCase._id),
              attorneyId: String(attorney._id),
              paralegalId: String(paralegal._id),
            },
            expand: ["latest_charge.balance_transaction"],
            description: buildCaseChargeDescription(selectedCase, paralegal),
          },
          { idempotencyKey }
        );
      } catch (err) {
        return failedHiringCharge(req, selectedCase, paralegalId, hireClaim, err, null, totalCharge, customerId, res);
      }
    }

    if (!paymentIntent || paymentIntent.status !== "succeeded") {
      return failedHiringCharge(req, selectedCase, paralegalId, hireClaim, null, paymentIntent, totalCharge, customerId, res);
    }

    const transferablePayment = stripe.isTransferablePaymentIntent(paymentIntent, {
      caseId: selectedCase._id,
    });
    if (!transferablePayment?.transferable) {
      const refunded =
        transferablePayment?.reason === "refunded" ||
        transferablePayment?.charge?.refunded === true ||
        (Number(transferablePayment?.charge?.amount || 0) > 0 &&
          Number(transferablePayment?.charge?.amount_refunded || 0) >=
            Number(transferablePayment?.charge?.amount || 0));
      if (refunded) {
        await resolveFundingIdempotencyKey(selectedCase, totalCharge, {
          mode: "hire-charge",
          forceNew: true,
          targetId: paralegalId,
        }).catch(logPromiseFailure(logger, "[case-hire] refunded funding key rotation failed", {
          caseId: selectedCase._id,
        }));
        await releaseCaseHireClaim(selectedCase._id, hireClaim.token).catch(
          logPromiseFailure(logger, "[case-hire] refunded funding claim release failed", {
            caseId: selectedCase._id,
          })
        );
        return res.status(409).json({
          error: "The previous charge was refunded. Please retry to create fresh funding.",
          code: "REFUNDED_FUNDING_RETRY_REQUIRED",
        });
      }
      await markCaseHireNeedsReconciliation(
        selectedCase._id,
        hireClaim.token,
        new Error(`Successful PaymentIntent is not transferable: ${transferablePayment?.reason || "unknown"}`),
        paymentIntent,
        totalCharge
      ).catch(logPromiseFailure(logger, "[case-hire] non-transferable funding reconciliation marker failed", {
        caseId: selectedCase._id,
      }));
      return res.status(409).json({
        error: "Matter funding needs reconciliation before the hire can proceed.",
        code: "HIRE_RECONCILIATION_REQUIRED",
      });
    }

    await recordCaseHirePaymentEvidence(
      selectedCase._id,
      hireClaim.token,
      paymentIntent,
      totalCharge
    );

    if (selectedCase.lockedTotalAmount == null) {
      selectedCase.lockedTotalAmount = selectedCase.totalAmount;
      selectedCase.amountLockedAt = new Date();
    }
    selectedCase.paymentIntentId = paymentIntent.id;
    selectedCase.escrowIntentId = paymentIntent.id;
    selectedCase.stripeMode = pickStripeMode(
      stripeModeFromLivemode(paymentIntent?.livemode),
      selectedCase.stripeMode,
      currentStripeMode()
    );
    selectedCase.paymentStatus = paymentIntent.status;
    selectedCase.currency = paymentIntent.currency || selectedCase.currency || "usd";
    selectedCase.feeAttorneyPct = resolveAttorneyFeePct(selectedCase);
    selectedCase.feeAttorneyAmount = attorneyFee;
    selectedCase.feeParalegalPct = resolveParalegalFeePct(selectedCase);
    selectedCase.feeParalegalAmount = paralegalFee;
    const fundingIntegrity = validatePaymentIntentForCase(paymentIntent, selectedCase);
    if (!fundingIntegrity.valid) {
      let compensated = false;
      try {
        await stripe.refunds.create(
          {
            payment_intent: paymentIntent.id,
            metadata: { caseId: String(selectedCase._id), action: "hire_integrity_compensation" },
          },
          {
            idempotencyKey: stripe.stripeIdempotencyKey(
              "hire_integrity_refund",
              selectedCase._id,
              paymentIntent.id
            ),
          }
        );
        compensated = true;
      } catch (refundErr) {
        logger.error("[case-hire] Unable to refund invalid funding intent", refundErr?.message || refundErr);
      }
      if (compensated) {
        await resolveFundingIdempotencyKey(selectedCase, totalCharge, {
          mode: "hire-charge",
          forceNew: true,
          targetId: paralegalId,
        }).catch(logPromiseFailure(logger, "[case-hire] compensated funding key rotation failed", {
          caseId: selectedCase._id,
        }));
        await releaseCaseHireClaim(selectedCase._id, hireClaim.token).catch(
          logPromiseFailure(logger, "[case-hire] compensated funding claim release failed", {
            caseId: selectedCase._id,
          })
        );
      } else {
        await markCaseHireNeedsReconciliation(
          selectedCase._id,
          hireClaim.token,
          new Error(`Funding integrity failed: ${fundingIntegrity.reasons.join(",")}`),
          paymentIntent,
          totalCharge
        ).catch(logPromiseFailure(logger, "[case-hire] invalid funding reconciliation marker failed", {
          caseId: selectedCase._id,
        }));
      }
      return res.status(502).json({
        error: compensated ? "The charge could not be verified. A refund was requested; check the payment status before continuing." : "The charge and attempted refund need verification before another hiring attempt.",
        ...(reviewedHire ? { code: "HIRING_RECONCILIATION" } : {}),
      });
    }
    selectedCase.fundingIntegrityStatus = "verified";
    selectedCase.fundingIntegrityFailure = "";
    selectedCase.fundingVerifiedAt = new Date();
    selectedCase.escrowStatus = "funded";

    seedLegacyInvite(selectedCase);
    const pendingInvitees = listCaseInvites(selectedCase)
      .filter((invite) => invite.status === "pending" && String(invite.paralegalId) !== String(paralegalId))
      .map((invite) => invite.paralegalId);
    const existingInvite = listCaseInvites(selectedCase).find(
      (invite) => String(invite.paralegalId) === String(paralegalId)
    );

    selectedCase.paralegal = paralegalId;
    selectedCase.paralegalId = paralegalId;
    if (existingInvite) {
      upsertInvite(selectedCase, paralegalId, { status: "accepted", respondedAt: new Date() });
    }
    markOtherInvites(selectedCase, paralegalId, "declined");
    syncLegacyPendingFields(selectedCase);
    selectedCase.hiredAt = new Date();
    selectedCase.assignmentCompletedTaskIndexes = selectedCase.tasks.flatMap((task, index) => task.completed ? [index] : []);
    selectedCase.tasksLocked = true;
    selectedCase.paralegalNameSnapshot = formatPersonName(paralegal);
    selectedCase.transitionTo(IN_PROGRESS_STATUS);
    clearCaseHireClaim(selectedCase);
    let rejectedApplicantIds, jobId, hireNotices;

    try {
      ({ rejectedApplicantIds, jobId } = await stageHiredApplications(req, selectedCase, paralegalId));
      hireNotices = await saveReviewedHire(selectedCase, reviewedHire, hireClaim, { req, jobId, paralegalId, pendingInvitees, rejectedApplicantIds, paralegalName: formatPersonName(paralegal) });
    } catch (err) {
      await markCaseHireNeedsReconciliation(
        selectedCase._id,
        hireClaim.token,
        err,
        paymentIntent,
        totalCharge
      ).catch(logPromiseFailure(logger, "[case-hire] failed finalization reconciliation marker failed", {
        caseId: selectedCase._id,
      }));
      return res.status(500).json({
        error: "The charge succeeded, but the hire has not been confirmed. Refresh the hiring review before continuing.",
        code: "HIRE_RECONCILIATION_REQUIRED",
      });
    }
    await reconcileFundingEvidence({
      caseDoc: selectedCase,
      paymentIntent,
      stripeClient: stripe,
      PaymentOperation,
    }).catch(logPromiseFailure(logger, "[case-hire] funding evidence reconciliation failed", {
      caseId: selectedCase._id,
      paymentIntentId: paymentIntent.id,
    }));
    await selectedCase.populate([
      { path: "paralegal", select: "firstName lastName email role avatarURL" },
      { path: "attorney", select: "firstName lastName email role avatarURL" },
    ]);

    publishCaseEvent(selectedCase._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(
      selectedCase,
      "matter_hired_refresh",
      [paralegalId, ...pendingInvitees, ...rejectedApplicantIds]
    );

    await dispatchHireNotifications(hireNotices, selectedCase._id);

    res.json({ ...caseSummary(selectedCase, { viewerRole: req.user?.role }), ...(reviewedHire ? { hiringConfirmation: hiringConfirmation(reviewedHire) } : {}) });
  })
);

// Archive is one reviewed visibility change, with a receipt for lost responses.
// It never runs the generic status editor or silently retries a client mutation.
const matterArchive = require("../services/matterArchive");
const archiveNoStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
const archiveOperation = (write) => async (req, res) => {
  try {
    const actorId = String(req.user.id);
    const expectedOwner = write ? req.body?.expectedOwnerId : req.query.expectedOwnerId;
    if ((write || expectedOwner !== undefined) && expectedOwner !== actorId) return res.status(403).json({ code: "ARCHIVE_ACCOUNT_CHANGED", error: "The signed-in account changed. Reload before continuing." });
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) return res.status(403).json({ error: "Only the Matter attorney can change its archive status." });
    const doc = await matterArchive.read(Case, req.params.caseId, actorId, req.acl.isAdmin);
    if (!write) return res.json(matterArchive.shape(doc, actorId));
    const result = await matterArchive.change(Case, doc, actorId, req.body);
    if (!result.replayed) {
      const type = result.doc.archived ? "case.archive" : "case.restore";
      publishCaseEvent(doc._id, "case", { at: new Date().toISOString() });
      publishCaseParticipantRefresh(result.doc, "matter_archive_refresh");
      try { await logAction(req, type, { targetType: "case", targetId: doc._id, caseId: doc._id }); }
      catch (error) { logger.error("[cases] archive audit persistence failed", { caseId: doc._id, error }); }
    }
    return res.json({ ok: true, archive: matterArchive.shape(result.doc, actorId), replayed: result.replayed });
  } catch (error) {
    if (error.publicCode) return res.status(error.status).json({ code: error.publicCode, error: error.message });
    logger.error("[cases] archive operation could not be confirmed", error);
    return res.status(503).json({ code: "ARCHIVE_UNCONFIRMED", error: "The archive result could not be confirmed. Check its current status before trying again." });
  }
};
router.get("/:caseId/archive", archiveNoStore, requireCaseAccess("caseId"), archiveOperation(false));
router.patch("/:caseId/archive", archiveNoStore, csrfProtection, requireCaseAccess("caseId"), archiveOperation(true));

/**
 * POST /api/cases/:caseId/flag
 * Paralegal-only. Flags a case posting for admin review.
 */
router.post(
  "/:caseId/flag",
  verifyToken,
  requireApproved,
  requireRole("paralegal"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "Invalid Matter ID" });
    }
    const allowedReasons = new Set([
      "inappropriate",
      "spam",
      "compensation",
      "duplicate",
      "other",
    ]);
    const rawReason = String(req.body?.reason || "").trim().toLowerCase();
    const reason = allowedReasons.has(rawReason) ? rawReason : "";
    if (!reason) {
      return res.status(400).json({ error: "Select a valid reason." });
    }
    const details = cleanText(req.body?.details || "", { max: 2000 });
    const doc = await Case.findById(caseId).select("flags status archived");
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    if (doc.archived || ["closed", "completed"].includes(String(doc.status || "").toLowerCase())) {
      return res.status(400).json({ error: "This Matter cannot be flagged." });
    }
    const reporterId = req.user?._id || req.user?.id;
    const existing = Array.isArray(doc.flags)
      ? doc.flags.find((entry) => String(entry.by) === String(reporterId))
      : null;
    if (existing) {
      existing.reason = reason;
      existing.details = details || "";
      existing.createdAt = new Date();
    } else {
      doc.flags = Array.isArray(doc.flags) ? doc.flags : [];
      doc.flags.push({
        by: reporterId,
        reason,
        details: details || "",
        createdAt: new Date(),
      });
    }
    await doc.save();
    try {
      await logAction(req, "case.flagged", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { reason, details: details || "" },
      });
    } catch (auditError) {
      logger.error("[cases] Matter flag audit persistence failed", { caseId: doc._id, error: auditError });
    }
    res.json({ ok: true, flagCount: doc.flags.length });
  })
);

/**
 * POST /api/cases/:caseId/flags/resolve
 * Admin-only. Clears flags and logs resolution.
 */
router.post(
  "/:caseId/flags/resolve",
  verifyToken,
  requireApproved,
  requireRole("admin"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "Invalid Matter ID" });
    }
    const note = cleanText(req.body?.note || "", { max: 2000 });
    const doc = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(caseId) });
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    const noteSnapshot = matterNotes.moderationSnapshot(doc);
    doc.flags = [];
    doc.moderationStatus = "none";
    doc.moderationPostingBaseline = null; doc.moderationEditRequest = "";
    doc.moderationFlaggedAt = null;
    doc.moderationFlaggedBy = null;
    doc.moderationResolutionRequestedAt = null;
    doc.moderationResolutionRequestedBy = null;
    const now = new Date();
    const stamp = now.toISOString();
    const entry = note
      ? `[${stamp}] Admin resolved flag: ${note}`
      : `[${stamp}] Admin resolved flag.`;
    const appended = await matterNotes.appendModerationNote(Case, doc, noteSnapshot, entry, new mongoose.Types.ObjectId(req.user.id), now);
    if (!appended.ok) return res.status(409).json({ error: appended.code === "NOTE_LIMIT" ? "The note has reached its limit. Review and shorten it before adding admin feedback." : "Matter changed. Reload and review before trying again.", code: appended.code });
    try {
      await logAction(req, "case.flag.resolved", {
        targetType: "case",
        targetId: doc._id,
        caseId: doc._id,
        meta: { note: note || "" },
      });
    } catch (auditError) {
      logger.error("[cases] flag resolution audit persistence failed", { caseId: doc._id, error: auditError });
    }
    res.json({ ok: true });
  })
);

/**
 * POST /api/cases/:caseId/flags/request-edits
 * Admin-only. Sends a case update to the attorney requesting edits.
 */
router.post(
  "/:caseId/flags/request-edits",
  verifyToken,
  requireApproved,
  requireRole("admin"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "Invalid Matter ID" });
    }
    const message = cleanText(req.body?.message || "", { max: 2000 });
    if (!message) {
      return res.status(400).json({ error: "Provide a request message." });
    }
    const doc = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(caseId) });
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    const noteSnapshot = matterNotes.moderationSnapshot(doc);
    if (doc.archived) return res.status(400).json({ error: "This Matter is archived." });
    const attorneyId = doc.attorneyId || doc.attorney || null;
    if (!attorneyId) return res.status(400).json({ error: "Attorney not found for this Matter." });

    const now = new Date();
    const stamp = now.toISOString();
    const entry = `[${stamp}] Admin requested edits: ${message}`;
    doc.moderationStatus = "flagged";
    doc.moderationPostingBaseline = matterModeration.postingFingerprint(doc);
    doc.moderationEditRequest = message;
    doc.moderationFlaggedAt = now;
    doc.moderationFlaggedBy = req.user?.id || req.user?._id || null;
    doc.moderationResolutionRequestedAt = null;
    doc.moderationResolutionRequestedBy = null;
    const appended = await retainModerationChange(async session => {
      const result = await matterNotes.appendModerationNote(Case, doc, noteSnapshot, entry, new mongoose.Types.ObjectId(req.user.id), now, { session });
      if (!result.ok) return result;
      return { ...result, dispatch: await postingNotices.retain(req, "edits_requested", doc, session) };
    });
    if (!appended.ok) return res.status(409).json({ error: appended.code === "NOTE_LIMIT" ? "The note has reached its limit. Review and shorten it before adding admin feedback." : "Matter changed. Reload and review before trying again.", code: appended.code });
    await dispatchPostingNotice(appended.dispatch);

    res.json({ ok: true });
  })
);

// This owner/admin projection excludes reporter identities and other private flags.
router.get(
  "/:caseId/flags/review",
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) return res.status(403).json({ error: "Only the Matter attorney may review this admin request." });
    if (req.query.expectedOwnerId && req.query.expectedOwnerId !== String(req.user.id)) return res.status(403).json({ error: "Verify your account.", code: "MODERATION_ACCOUNT_CHANGED" });
    const doc = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.caseId) });
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    const owner = doc.attorneyId || doc.attorney;
    if (!req.acl.isAdmin && String(owner) !== String(req.user.id)) return res.status(403).json({ error: "Matter access changed." });
    res.set("Cache-Control", "no-store");
    res.json(matterModeration.shape(doc, String(req.user.id)));
  })
);

/**
 * POST /api/cases/:caseId/flags/mark-resolved
 * Attorney-only. Marks an admin-flagged post as resolved and notifies admins for review.
 */
router.post(
  "/:caseId/flags/mark-resolved",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the Matter attorney may mark this flag as resolved." });
    }
    const { caseId } = req.params;
    res.set("Cache-Control", "no-store");
    if (req.body?.expectedOwnerId !== String(req.user.id)) return res.status(403).json({ error: "Verify your account before requesting review.", code: "MODERATION_ACCOUNT_CHANGED" });
    if (!/^[a-f0-9]{64}$/.test(req.body?.revision || "") || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(req.body?.requestId || "")) return res.status(428).json({ error: "Review the latest admin request before submitting.", code: "MODERATION_REVIEW_REQUIRED" });
    const doc = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(caseId) });
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    if (!req.acl.isAdmin && String(doc.attorneyId || doc.attorney) !== String(req.user.id)) return res.status(403).json({ error: "Matter access changed." });
    if (doc.moderationReviewReceipt?.requestId === req.body.requestId) {
      if (doc.moderationReviewReceipt.revision !== req.body.revision) return res.status(409).json({ error: "This request was already used for a different review.", code: "MODERATION_CONFLICT" });
      return res.json({ ok: true, review: matterModeration.shape(doc, String(req.user.id)), replayed: true });
    }
    if (matterModeration.revisionFor(doc) !== req.body.revision) return res.status(409).json({ error: "The Matter or admin request changed. Check and review it again.", code: "MODERATION_CONFLICT" });
    const noteSnapshot = matterNotes.moderationSnapshot(doc);
    if (doc.readOnly) return res.status(409).json({ error: "This Matter is read-only.", code: "MODERATION_INELIGIBLE" });
    if (doc.archived) return res.status(400).json({ error: "This Matter is archived." });
    if (String(doc.moderationStatus || "none") !== "flagged") {
      return res.status(400).json({ error: "This Matter is not currently flagged for edits." });
    }
    if (!hasModerationRevision(doc)) {
      return res.status(400).json({ error: "Edit the Matter before marking this flag as resolved." });
    }

    const now = new Date();
    doc.moderationStatus = "resolution_requested";
    doc.moderationReviewReceipt = { requestId: req.body.requestId, revision: req.body.revision, requestedAt: now };
    doc.moderationResolutionRequestedAt = now;
    doc.moderationResolutionRequestedBy = req.user?.id || req.user?._id || null;

    const stamp = now.toISOString();
    const entry = `[${stamp}] Attorney marked flag resolved and requested admin review.`;
    const appended = await retainModerationChange(async session => {
      const result = await matterNotes.appendModerationNote(Case, doc, noteSnapshot, entry, new mongoose.Types.ObjectId(req.user.id), now, { session });
      if (!result.ok) return result;
      return { ...result, dispatch: await postingNotices.retain(req, "review_requested", doc, session) };
    });
    if (!appended.ok) return res.status(409).json({ error: appended.code === "NOTE_LIMIT" ? "The note has reached its limit. Review and shorten it before adding admin feedback." : "Matter changed. Reload and review before trying again.", code: appended.code });
    await dispatchPostingNotice(appended.dispatch);

    res.json({ ok: true, moderationStatus: doc.moderationStatus, review: matterModeration.shape(doc, String(req.user.id)) });
  })
);

router.get("/:caseId/completion-review", requireRole("attorney"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await attorneyCompletion.read(req)); } catch (error) { attorneyCompletion.sendError(res, error); }
}));

/**
 * POST /api/cases/:caseId/complete
 * Attorney-only. Releases the payment, locks the Matter, generates an archive, and schedules purge.
 */
router.post(
  "/:caseId/complete",
  csrfProtection,
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && !req.acl?.isAdmin) {
      return res.status(403).json({ error: "Only the Matter attorney may close this Matter." });
    }
    const { caseId } = req.params;
    res.set("Cache-Control", "private, no-store");
    let strictReview = null;
    if (["expectedOwnerId", "requestId", "confirmation"].some(key => Object.hasOwn(req.body || {}, key))) {
      try { strictReview = await attorneyCompletion.prepare(req); } catch (error) { return attorneyCompletion.sendError(res, error); }
      if (strictReview.recovered) return res.json({ review: strictReview.recovered, recovered: true });
    }
    let doc = await Case.findById(caseId)
      .populate(
        "paralegal",
        "firstName lastName email role stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled"
      )
      .populate("attorney", "firstName lastName email role");
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    const statusKey = normalizeCaseStatusValue(doc.status);
    if (statusKey === "completed") {
      try { await completionPayoutEvidence.requireRecorded(doc); }
      catch { return res.status(409).json({ error: "This Matter is closed, but its payout records need administrative reconciliation.", code: "PAYOUT_RECONCILIATION_REQUIRED" }); }
      if (doc.completionClaimStatus || doc.completionClaimToken) {
        await Case.updateOne(
          { _id: doc._id, status: "completed" },
          {
            $set: {
              completionClaimToken: "",
              completionClaimedAt: null,
              completionClaimStatus: null,
              completionClaimTransferId: "",
              completionClaimError: "",
            },
          }
        ).catch(logPromiseFailure(logger, "[cases] stale completion claim cleanup failed", { caseId: doc._id }));
      }
      return res.json({
        ok: true,
        alreadyClosed: true,
        downloadPath: doc.archiveZipKey
          ? `/api/cases/${encodeURIComponent(doc._id)}/archive/download`
          : null,
        purgeScheduledFor: doc.purgeScheduledFor,
        archiveReadyAt: doc.archiveReadyAt,
      });
    }
    let releaseResult = null;
    const payoutOperation = await PaymentOperation.findOne({
      operationKey: `case_payout:${String(doc._id)}`,
      $or: [
        { stripeTransferId: { $nin: [null, ""] } },
        { stripeObjectId: { $nin: [null, ""] } },
      ],
    })
      .select("_id")
      .lean();
    const payoutEvidenceExists = Boolean(doc.paymentReleased || doc.payoutTransferId || payoutOperation);
    const completionPolicy = evaluateCompletionEligibility({
      caseDoc: doc,
      ownerAuthorized: req.acl?.isAttorney === true || req.acl?.isAdmin === true,
      reconcileReleasedPayout: payoutEvidenceExists,
    });
    if (completionPolicy.applicable && !completionPolicy.ready) {
      return res.status(400).json({
        error: "This matter is not ready to complete and release.",
        blockers: completionPolicy.blockers,
      });
    }
    const initialPayoutEvidence = await completionPayoutEvidence.inspect(doc);
    if (initialPayoutEvidence.state === "needs_review") return res.status(409).json({ error: completionPayoutEvidence.reconciliationError().message, code: "PAYOUT_RECONCILIATION_REQUIRED" });
    let completionClaim;
    try { completionClaim = strictReview ? await attorneyCompletion.claim(req, strictReview) : await claimCaseCompletion(caseId, req.user.id, { isAdmin: req.acl?.isAdmin === true }); }
    catch (error) { return attorneyCompletion.sendError(res, error); }
    if (!completionClaim.acquired) {
      const latest = await Case.findById(caseId)
        .select("status completionClaimStatus completionClaimedAt disputes")
        .lean();
      if ((latest?.disputes || []).some((entry) => String(entry?.status || "open").toLowerCase() === "open")) {
        return res.status(409).json({
          error: "A review opened before completion could begin. The payout was not released.",
          code: "COMPLETION_CONFLICT",
        });
      }
      return res.status(409).json({
        error:
          normalizeCaseStatusValue(latest?.status) === "completed"
            ? "Another completion request closed this Matter. Refresh to view the completed record."
            : "Completion is already running or the matter changed. Refresh before trying again.",
        code: "COMPLETION_CONFLICT",
      });
    }
    if (strictReview) {
      doc = completionClaim.caseDoc;
      await doc.populate("paralegal", "firstName lastName email role stripeAccountId stripeOnboarded stripeChargesEnabled stripePayoutsEnabled");
      await doc.populate("attorney", "firstName lastName email role");
    }
    const completionToken = completionClaim.token;
    const completionTime = new Date();
    const archiveCandidate = doc.toObject({ depopulate: false });
    archiveCandidate.status = "completed";
    archiveCandidate.completedAt = doc.completedAt || completionTime;
    archiveCandidate.archived = true;
    archiveCandidate.readOnly = true;
    archiveCandidate.paralegalAccessRevokedAt = doc.paralegalAccessRevokedAt || completionTime;
    archiveCandidate.paralegalNameSnapshot =
      doc.paralegalNameSnapshot || `${doc.paralegal?.firstName || ""} ${doc.paralegal?.lastName || ""}`.trim();
    archiveCandidate.attorneyNameSnapshot =
      doc.attorneyNameSnapshot || `${doc.attorney?.firstName || ""} ${doc.attorney?.lastName || ""}`.trim();
    let archiveMeta = null;
    try {
      archiveMeta = await generateArchiveZip(archiveCandidate);
    } catch (err) {
      await releaseCaseCompletionClaim(caseId, completionToken).catch(
        logPromiseFailure(logger, "[cases] archive-failure completion claim release failed", { caseId })
      );
      const statusCode = Number(err?.statusCode) || 503;
      return res.status(statusCode).json({
        error: err?.message || "The Matter archive could not be prepared. The payout was not released.",
        code: err?.code || "ARCHIVE_PREPARATION_FAILED",
      });
    }
    try {
      releaseResult = await ensureFundsReleased(req, doc, {
        ...(strictReview ? { beforeTransfer: () => attorneyCompletion.beforeRelease(req, strictReview, completionClaim) } : {}),
        afterTransfer: async transferId => {
          await recordCaseCompletionTransferEvidence(caseId, completionToken, transferId);
          if (strictReview) await attorneyCompletion.afterTransfer(req, transferId);
        },
      });
      await completionPayoutEvidence.requireRecorded(doc);
    } catch (err) {
      await markCaseCompletionFailure(caseId, completionToken, err, doc.payoutTransferId).catch(
        logPromiseFailure(logger, "[cases] payout-failure completion marker failed", { caseId })
      );
      if (strictReview && err.publicCode) return attorneyCompletion.sendError(res, err);
      if (payoutEvidenceExists || err.code === "PAYOUT_RECONCILIATION_REQUIRED") {
        return res.status(409).json({
          error: err.message || "Payout records require reconciliation before this matter can be completed.",
          code: "PAYOUT_RECONCILIATION_REQUIRED",
        });
      }
      return res.status(400).json({ error: err.message || "Unable to release the payment." });
    }
    if (!doc.paymentReleased || !doc.payoutTransferId || !doc.paidOutAt) {
      const err = new Error("Payout records require reconciliation before this matter can be completed.");
      await markCaseCompletionFailure(caseId, completionToken, err, doc.payoutTransferId).catch(
        logPromiseFailure(logger, "[cases] incomplete payout reconciliation marker failed", { caseId })
      );
      return res.status(409).json({
        error: err.message,
        code: "PAYOUT_RECONCILIATION_REQUIRED",
      });
    }
    try {
      await recordCaseCompletionTransferEvidence(caseId, completionToken, doc.payoutTransferId);
    } catch (err) {
      await markCaseCompletionFailure(caseId, completionToken, err, doc.payoutTransferId).catch(
        logPromiseFailure(logger, "[cases] transfer-evidence reconciliation marker failed", { caseId })
      );
      return res.status(503).json({
        error: "The payout was released, but completion evidence requires reconciliation.",
        code: "PAYOUT_RECONCILIATION_REQUIRED",
      });
    }

    const now = completionTime;
    doc.completedAt = doc.completedAt || now;
    doc.archived = true;
    doc.readOnly = true;
    doc.paralegalAccessRevokedAt = doc.paralegalAccessRevokedAt || now;
    doc.paralegalNameSnapshot =
      doc.paralegalNameSnapshot ||
      `${doc.paralegal?.firstName || ""} ${doc.paralegal?.lastName || ""}`.trim();
    doc.attorneyNameSnapshot =
      doc.attorneyNameSnapshot ||
      `${doc.attorney?.firstName || ""} ${doc.attorney?.lastName || ""}`.trim();
    doc.purgeScheduledFor = calculateArchivePurgeAt(now);
    doc.archiveDownloadedAt = null;
    doc.downloadUrl = [];
    doc.applicants = [];

    doc.archiveZipKey = archiveMeta.key;
    doc.archiveReadyAt = archiveMeta.readyAt;
    let completionDispatches = [];
    try {
      if (strictReview) completionDispatches = await attorneyCompletion.finish(req, strictReview, completionClaim, doc) || [];
      else {
        completionDispatches = await withPayoutTransaction(async session => {
          const current = await Case.findById(caseId).session(session).lean();
          if (!current || current.completionClaimToken !== completionToken || ["failed", "reversed", "needs_reconciliation"].includes(current.payoutStatus)) throw completionPayoutEvidence.reconciliationError();
          const evidence = await completionPayoutEvidence.requireRecorded(doc, { session });
          await upsertPayoutLedger({ operationKey: `case_payout:${caseId}`, caseId, paralegalId: evidence.payout.paralegalId, amountPaid: evidence.payout.amountPaid, transferId: evidence.payout.transferId, stripeMode: evidence.payout.stripeMode }, { session });
          doc.transitionTo("completed"); await doc.save({ session });
          return require("../services/matterPaymentNotifications").stageCompletion(doc, session, req.user.id);
        });
      }
    } catch (err) {
      await markCaseCompletionFailure(
        caseId,
        completionToken,
        err,
        releaseResult?.transferId || doc.payoutTransferId
      ).catch(logPromiseFailure(logger, "[cases] completion lifecycle reconciliation marker failed", { caseId }));
      await Case.updateOne(
        { _id: doc._id, completionClaimToken: completionToken, payoutStatus: { $nin: ["reversed", "failed"] }, payoutFailureReason: { $in: [null, ""] }, payoutTransferId: { $in: [null, "", releaseResult?.transferId || doc.payoutTransferId] } },
        {
          $set: {
            payoutTransferId: releaseResult?.transferId || doc.payoutTransferId || "",
            payoutStatus: "needs_reconciliation",
            payoutFailureReason: "Payout succeeded but the completed matter lifecycle did not finalize.",
          },
        }
      ).catch(logPromiseFailure(logger, "[cases] completion lifecycle payout marker failed", { caseId }));
      if (strictReview && err.publicCode === "WORKSPACE_COMPLETION_ACCOUNT_CHANGED") return attorneyCompletion.sendError(res, err);
      return res.status(503).json({
        error: "The payout was released, but completion records require reconciliation.",
        code: "PAYOUT_RECONCILIATION_REQUIRED",
      });
    }
    await releaseCaseCompletionClaim(caseId, completionToken).catch((err) => {
      logger.error("[cases] completion claim release failed", err?.message || err);
    });

    try {
      const paymentMethodLabel = await resolvePaymentMethodLabel(doc);
      await generateReceiptDocuments(doc, {
        payoutAmount: releaseResult?.payout,
        paymentMethodLabel,
      });
    } catch (err) {
      logger.warn("[cases] receipt generation failed", err?.message || err);
    }

    for (const dispatch of completionDispatches) await dispatch();

    await logAction(req, "case.complete.archive", {
      targetType: "case",
      targetId: doc._id,
      caseId: doc._id,
      meta: { purgeScheduledFor: doc.purgeScheduledFor },
    });
    publishCaseEvent(doc._id, "case", { at: new Date().toISOString() });
    publishCaseParticipantRefresh(doc, "matter_completed_refresh");

    if (strictReview) {
      try { await attorneyCompletion.actor(req); } catch (error) { return attorneyCompletion.sendError(res, error); }
    }
    res.json({
      ok: true,
      ...(strictReview ? { requestId: req.body.requestId, completionRecorded: true } : {}),
      downloadPath: `/api/cases/${encodeURIComponent(doc._id)}/archive/download`,
      purgeScheduledFor: doc.purgeScheduledFor,
      archiveReadyAt: doc.archiveReadyAt,
    });
  })
);

router.get("/:caseId/withdrawal-review", requireRole("attorney"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await attorneyWithdrawal.read(req)); } catch (error) { attorneyWithdrawal.sendError(res, error); }
}));
router.post("/:caseId/withdrawal-decision", requireRole("attorney"), csrfProtection, asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await attorneyWithdrawal.execute(req, withdrawalOptions(req))); } catch (error) { attorneyWithdrawal.sendError(res, error); }
}));
router.post("/:caseId/partial-payout", csrfProtection, requireCaseAccess("caseId"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { const value = await attorneyWithdrawal.legacy(req, "partial", withdrawalOptions(req)); res.json({ ok: value.operation?.status === "recorded", payout: value.decision?.netCents || 0, transferId: value.legacyTransferId, remainingAmount: value.remainingCents, relistPending: false, withdrawalReview: value }); } catch (error) { attorneyWithdrawal.sendError(res, error); }
}));

router.get(
  "/:caseId/applications/:applicantId/preview",
  asyncHandler(async (req, res) => {
    const caseId = String(req.params.caseId || "");
    const applicantId = String(req.params.applicantId || "").toLowerCase();
    if (!isObjId(caseId) || !isObjId(applicantId)) {
      return res.status(400).json({ error: "Invalid application reference" });
    }
    const role = String(req.user?.role || "").toLowerCase();
    if (!["attorney", "paralegal"].includes(role)) {
      return res.status(404).json({ error: "Application not found" });
    }
    let doc = await Case.findById(caseId)
      .select(
        "_id title attorney attorneyId applicants invites pendingParalegalId pendingParalegalInvitedAt preEngagement jobId"
      )
      .lean();
    if (!doc) return res.status(404).json({ error: "Application not found" });
    const viewerId = String(req.user?.id || req.user?._id || "");
    const attorneyIds = [doc.attorney, doc.attorneyId]
      .map((value) => String(value?._id || value || "").toLowerCase())
      .filter(Boolean);
    const attorneyId = attorneyIds[0] || "";
    const isOwner = role === "attorney" && attorneyIds.includes(viewerId);
    const isSelf = role === "paralegal" && viewerId === applicantId;
    if (!isOwner && !isSelf) return res.status(404).json({ error: "Application not found" });
    const applicationSnapshot = await legacyApplications.begin(req, [doc], { detailed: true });
    doc = applicationSnapshot.matters[0];
    if (await isBlockedBetween(attorneyId, applicantId)) {
      return res.status(404).json({ error: "Application not found" });
    }

    const selected = applicationSnapshot.rows.get(String(doc._id).toLowerCase())?.find(row => row.personId === applicantId);
    const application = selected?.canonical ? selected.record : null;
    const embedded = selected && !selected.canonical ? selected.record : null;
    const invite = (Array.isArray(doc.invites) ? doc.invites : []).find(entry => String(entry?.paralegalId || "").toLowerCase() === applicantId);
    const appStatus = String(selected?.record.status || "").toLowerCase();
    const inviteStatus = String(invite?.status || "").toLowerCase();
    if (selected?.blocked || appStatus === "withdrawn" || isSelf && selected && !["pending", "submitted", "viewed", "shortlisted", "accepted"].includes(appStatus)) return res.status(404).json({ error: "Application not found" });
    if (isSelf && !selected && inviteStatus !== "pending") return res.status(404).json({ error: "Application not found" });
    if (!selected && !invite && String(doc.pendingParalegalId || "").toLowerCase() !== applicantId) return res.status(404).json({ error: "Application not found" });
    const candidate = applicationSnapshot.people.find(person => String(person._id).toLowerCase() === applicantId && person.role === "paralegal" && person.status === "approved" && !person.disabled && !person.deleted);
    if (!candidate) return res.status(404).json({ error: "Application not found" });
    const preEngagement =
      doc.preEngagement && String(doc.preEngagement.requestedParalegalId || "").toLowerCase() === applicantId
        ? {
            status: String(doc.preEngagement.status || "requested").toLowerCase(),
            requestedAt: doc.preEngagement.requestedAt || null,
            submittedAt: doc.preEngagement.submittedAt || null,
            reviewedAt: doc.preEngagement.reviewedAt || null,
          }
        : null;
    const name = `${candidate.firstName || ""} ${candidate.lastName || ""}`.trim() || "Paralegal candidate";
    const submittedAt = application?.createdAt || embedded?.appliedAt || invite?.invitedAt || doc.pendingParalegalInvitedAt || null;
    const status = String(application?.status || embedded?.status || invite?.status || "pending").toLowerCase();
    await applicationSnapshot.verify();
    res.set("Cache-Control", "no-store");
    return res.json({
      application: {
        id: application?._id ? String(application._id).toLowerCase() : null,
        candidateId: applicantId,
        candidateName: name,
        matterTitle: doc.title || "Matter",
        source: application || embedded ? "application" : "invitation",
        status,
        submittedAt,
        coverLetter: String(application?.coverLetter || embedded?.coverLetter || embedded?.note || "").slice(0, 5000),
        preEngagement,
        profile: {
          id: applicantId,
          name,
          bio: String(candidate.bio || candidate.about || application?.profileSnapshot?.bio || "").slice(0, 1000),
          location: String(candidate.location || candidate.state || application?.profileSnapshot?.location || "").slice(0, 300),
          practiceAreas: Array.isArray(candidate.practiceAreas) ? candidate.practiceAreas.slice(0, 12) : [],
          specialties: Array.isArray(candidate.specialties) ? candidate.specialties.slice(0, 12) : [],
          skills: Array.isArray(candidate.skills) ? candidate.skills.slice(0, 16) : [],
          experience: String(candidate.experience || "").slice(0, 1000),
          yearsExperience: Number.isFinite(Number(candidate.yearsExperience)) ? Number(candidate.yearsExperience) : null,
        },
        fullReviewHref: isOwner
          ? `/dashboard-attorney.html?caseId=${encodeURIComponent(caseId)}&applicantId=${encodeURIComponent(applicantId)}&openApplicant=1#cases:inquiries`
          : buildObjectDeepLink({ type: "application", caseId, applicantId }),
        profileHref: buildObjectDeepLink({ type: "profile", profileId: applicantId }),
      },
    });
  })
);

router.get(
  "/:caseId/notes",
  verifyToken,
  requireCaseAccess("caseId", { project: "internalNotes" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only attorneys can view notes" });
    }
    const doc = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.case.id) });
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    if (req.user.role !== "admin" && ![doc.attorney, doc.attorneyId].some((id) => String(id) === String(req.user.id))) return res.status(403).json({ error: "Matter access changed." });
    res.set("Cache-Control", "no-store");
    return res.json(matterNotes.shapeNote(doc));
  })
);

router.put(
  "/:caseId/notes",
  verifyToken,
  csrfProtection,
  requireCaseAccess("caseId", { project: "internalNotes" }),
  asyncHandler(async (req, res) => {
    if (!req.acl?.isAttorney && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only attorneys can update notes" });
    }
    if (req.body?.expectedOwnerId !== String(req.user.id)) {
      return res.status(403).json({ error: "Verify your account before saving.", code: "NOTE_ACCOUNT_CHANGED" });
    }
    const text = matterNotes.normalizeNote(req.body?.note);
    if (text === null) return res.status(400).json({ error: "Provide a note of at most 10,000 characters.", code: "NOTE_INVALID" });
    if (typeof req.body?.revision !== "string" || !/^[a-f0-9]{64}$/.test(req.body.revision)) {
      return res.status(428).json({ error: "Reload notes before saving.", code: "NOTE_REVISION_REQUIRED" });
    }
    const doc = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.case.id) });
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    // ACL was read separately: protect a changed owner before using the raw snapshot.
    if (req.user.role !== "admin" && ![doc.attorney, doc.attorneyId].some((id) => String(id) === String(req.user.id))) {
      return res.status(403).json({ error: "Matter access changed." });
    }
    if (matterNotes.revisionFor(doc) !== req.body.revision) {
      return res.status(409).json({ error: "Notes changed. Review the saved version.", code: "NOTE_CONFLICT" });
    }
    const original = doc.internalNotes;
    const next = { ...(original && typeof original === "object" ? original : {}), text, updatedBy: new mongoose.Types.ObjectId(req.user.id), updatedAt: new Date() };
    // Notes have their own timestamp. A note save is not an edit of the public posting.
    const result = await Case.collection.updateOne({ _id: doc._id, ...matterNotes.ownerFilter(doc), internalNotes: matterNotes.exact(original) }, { $set: { internalNotes: next } });
    if (!result.matchedCount) return res.status(409).json({ error: "Notes changed. Review the saved version.", code: "NOTE_CONFLICT" });
    res.set("Cache-Control", "no-store");
    return res.json(matterNotes.shapeNote({ ...doc, internalNotes: next }));
  })
);

/**
 * GET /api/cases/:caseId
 * Returns case details needed by the Documents view (includes files array).
 */
router.get(
  "/:caseId",
  requireCaseAccess("caseId", {
    allowApplicants: { statuses: ["pending", "accepted"] },
    alsoAllow: (req, caseDoc) => {
      if (String(req.user.role).toLowerCase() !== "paralegal") return false;
      const isOpen = caseDoc.status === "open" && !caseDoc.archived;
      const hasHire = !!caseDoc.paralegal;
      if (isOpen && !hasHire) return true;
      if (caseDoc.status === "paused" && caseDoc.relistRequestedAt) return true;
      return false;
    },
    project:
      "status paralegal attorney applicants archived withdrawnParalegalId paralegalNameSnapshot pausedReason disputeDeadlineAt payoutFinalizedAt relistRequestedAt preEngagement",
  }),
  asyncHandler(async (req, res) => {
    const workspaceBoundary = require("../services/attorneyWorkspaceBoundary");
    const matterFinancials = require("../services/matterFinancials");
    let workspaceSnapshot;
    try {
      if (req.user.role === "paralegal") {
        await matterFinancials.actor(req);
        if (Object.keys(req.query).some(key => key !== "expectedOwnerId")) return res.status(400).json({ error: "Invalid Matter query." });
        workspaceSnapshot = null;
        res.set("Cache-Control", "private, no-store");
      } else workspaceSnapshot = await workspaceBoundary.begin(req, res);
    } catch (error) { return workspaceBoundary.sendError(res, error); }
    const readMatter = () => Case.findById(req.params.caseId)
      .select(
        "title status practiceArea details state locationState deadline deadlineDate zoomLink paymentReleased paidOutAt escrowIntentId escrowStatus totalAmount lockedTotalAmount amountLockedAt remainingAmount currency feeAttorneyAmount feeParalegalAmount feeAttorneyPct feeParalegalPct files attorney attorneyId paralegal paralegalId applicants invites pendingParalegalId pendingParalegalInvitedAt hiredAt completedAt createdAt updatedAt briefSummary archived downloadUrl terminationReason terminationStatus terminationRequestedAt terminationRequestedBy terminationDisputeId terminatedAt paralegalAccessRevokedAt archiveReadyAt archiveDownloadedAt purgeScheduledFor readOnly jobId job tasks taskRevision tasksLocked pausedReason pausedAt disputeDeadlineAt partialPayoutAmount payoutFinalizedAt payoutFinalizedType completionClaimStatus withdrawnParalegalId paralegalNameSnapshot relistRequestedAt relistPending disputes disputeSettlement moderationStatus moderationFlaggedAt moderationFlaggedBy moderationResolutionRequestedAt moderationResolutionRequestedBy preEngagement"
      )
      .populate("paralegal", "firstName lastName email role")
      .populate("attorney", "firstName lastName email role")
      .populate("invites.paralegalId", "firstName lastName role")
      .populate("withdrawnParalegalId", "firstName lastName email role")
      .populate("applicants.paralegalId", "firstName lastName email role")
      .populate("terminationRequestedBy", "firstName lastName email role");
    let doc = await readMatter();
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin";
    try {
      const expired = await finalizeExpiredDisputeWindow(doc);
      if (expired) doc = await readMatter();
    } catch (err) {
      logger.warn("[cases] dispute window finalize failed", err?.message || err);
    }
    if (!doc) return res.status(404).json({ error: "Matter not found" });
    const statusKey = String(doc.status || "").toLowerCase();
    if (role === "paralegal" && (statusKey === "completed" || doc.paymentReleased === true)) {
      return res.status(403).json({ code: "MATTER_COMPLETED", error: "Completed Matters are no longer accessible." });
    }

    const applicationSnapshot = await legacyApplications.begin(req, [doc], { detailed: true });
    const applicants = legacyApplications.present(applicationSnapshot, doc._id, req.user, {});

    const blockStatus = await getCaseInteractionBlockStatus(doc, req.user);
    const workspaceParticipant = !!req.acl?.isAttorney || !!req.acl?.isParalegal;
    const matterAttorneyId = normalizeId(doc.attorneyId || doc.attorney);
    const applicantPairBlocked =
      role === "paralegal" &&
      !workspaceParticipant &&
      matterAttorneyId &&
      (await isBlockedBetween(matterAttorneyId, req.user.id));
    if ((blockStatus.blocked || applicantPairBlocked) && !workspaceParticipant && !req.acl?.isAdmin) {
      return res.status(404).json({ error: "Matter not found" });
    }
    const storedWork = workspaceParticipant ? await Case.collection.findOne({ _id: doc._id }, { projection: { tasks: 1, taskRevision: 1 } }) : null;
    if (workspaceParticipant && !storedWork) return res.status(404).json({ error: "Matter not found" });
    const visibleTasks = workspaceParticipant ? serializeScopeTasks(storedWork.tasks) : [];
    const requestedPreEngagementId = doc.preEngagement?.requestedParalegalId
      ? String(doc.preEngagement.requestedParalegalId)
      : "";
    const viewerId = String(req.user?.id || req.user?._id || "");
    const canSeePreEngagement = !!req.acl?.isAttorney || (requestedPreEngagementId && requestedPreEngagementId === viewerId);
    const completionPolicy = req.acl?.isAttorney
      ? evaluateCompletionEligibility({ caseDoc: doc, ownerAuthorized: true })
      : null;
    const withdrawalPolicy = req.acl?.isParalegal
      ? evaluateWithdrawalEligibility({
          user: { ...req.user, _id: req.user.id, role: "paralegal" },
          caseDoc: doc,
        })
      : null;
    const currentFiles = projectRevisionResolutions(workspaceParticipant && !isAdmin
      ? await CaseFile.find(applyAssignmentVisibility({ caseId: doc._id }, doc, {
          role, userId: req.user.id, isParalegal: req.acl?.isParalegal === true,
        })).sort({ createdAt: -1 }).lean()
      : []);
    const submissions = currentFiles.filter((file) => file.uploadedByRole === "paralegal");
    const submissionSummary = workspaceParticipant && !isAdmin ? {
      totalFiles: currentFiles.length,
      awaitingReview: submissions.filter((file) => file.status === "pending_review").length,
      revisions: submissions.filter((file) => file.status === "attorney_revision" && !file.revisionResolution).length,
      approved: submissions.filter((file) => file.status === "approved").length,
    } : null;
    let financialView = null;
    try {
      if (workspaceParticipant && !isAdmin) {
        res.set("Cache-Control", "private, no-store");
        financialView = await matterFinancials.read(req, doc);
      }
    } catch (error) { return workspaceBoundary.sendError(res, error); }
    const matterExperience = buildMatterExperience({ ...doc.toObject(), tasks: workspaceParticipant ? visibleTasks : doc.tasks, files: currentFiles }, {
      viewer: req.user,
      acl: req.acl,
      applicants,
      pendingApplicationCount: role === "attorney" ? applicationSnapshot.counts.get(String(doc._id).toLowerCase()) : undefined,
      policies: { completion: completionPolicy, withdrawal: withdrawalPolicy },
      financials: financialView?.value || null,
    });
    const legacyMatterContext = presentMatterContext(doc, req.user);
    const matterContext = workspaceParticipant || isAdmin
      ? legacyMatterContext
      : {
          ...legacyMatterContext,
          attention: matterExperience.header.attention,
          nextAction: {
            label: matterExperience.header.primaryAction.label,
            href: `/case-detail.html?caseId=${encodeURIComponent(String(doc._id))}&tab=${encodeURIComponent(matterExperience.header.primaryAction.tab)}`,
          },
        };
    const safeAttorney = doc.attorney && typeof doc.attorney === "object"
      ? {
          id: String(doc.attorney._id || doc.attorney.id || ""),
          _id: doc.attorney._id || doc.attorney.id || null,
          firstName: doc.attorney.firstName || "",
          lastName: doc.attorney.lastName || "",
          role: doc.attorney.role || "attorney",
          ...(workspaceParticipant ? { email: doc.attorney.email || "" } : {}),
        }
      : doc.attorney || null;

    try {
      await workspaceBoundary.finish(req, workspaceSnapshot);
      await applicationSnapshot.verify();
      if (financialView) await financialView.verify();
      else if (role === "paralegal") await matterFinancials.actor(req);
    }
    catch (error) { return workspaceBoundary.sendError(res, error); }
    res.json({
      id: String(doc._id),
      _id: doc._id,
      title: doc.title,
      status: normalizeCaseStatusValue(doc.status),
      pausedReason: workspaceParticipant ? doc.pausedReason || null : null,
      pausedAt: workspaceParticipant ? doc.pausedAt || null : null,
      disputeDeadlineAt: workspaceParticipant ? doc.disputeDeadlineAt || null : null,
      partialPayoutAmount: workspaceParticipant && typeof doc.partialPayoutAmount === "number" ? doc.partialPayoutAmount : null,
      payoutFinalizedAt: workspaceParticipant ? doc.payoutFinalizedAt || null : null,
      payoutFinalizedType: workspaceParticipant ? doc.payoutFinalizedType || null : null,
      withdrawnParalegalId: workspaceParticipant ? doc.withdrawnParalegalId || null : null,
      relistRequestedAt: doc.relistRequestedAt || null,
      relistPending: !!doc.relistPending,
      practiceArea: doc.practiceArea || "",
      details: doc.details || "",
      state: doc.state || "",
      locationState: doc.locationState || doc.state || "",
      zoomLink: workspaceParticipant ? doc.zoomLink || "" : "",
      paymentReleased: workspaceParticipant ? doc.paymentReleased || false : false,
      escrowStatus: workspaceParticipant ? doc.escrowStatus || null : null,
      totalAmount: doc.totalAmount || 0,
      lockedTotalAmount: workspaceParticipant && typeof doc.lockedTotalAmount === "number" ? doc.lockedTotalAmount : null,
      remainingAmount: workspaceParticipant ? resolveRemainingAmount(doc) : null,
      currency: doc.currency || "usd",
      deadlineDate: resolveMatterDeadlineDate(doc),
      deadline: resolveMatterDeadlineDate(doc) || null,
      hiredAt: workspaceParticipant ? doc.hiredAt || null : null,
      completedAt: workspaceParticipant ? doc.completedAt || null : null,
      briefSummary: doc.briefSummary || "",
      tasks: visibleTasks,
      taskRevision: workspaceParticipant ? Number(storedWork.taskRevision || 0) : null,
      tasksLocked: workspaceParticipant ? !!doc.tasksLocked : false,
      archived: !!doc.archived,
      downloadUrl: isAdmin || !workspaceParticipant || resolveCurrentParalegalAssignmentBoundary(doc, {
        role,
        userId: req.user?.id,
        isParalegal: req.acl?.isParalegal === true,
      })
        ? []
        : Array.isArray(doc.downloadUrl) ? doc.downloadUrl : [],
      readOnly: !!doc.readOnly,
      paralegalAccessRevokedAt: workspaceParticipant ? doc.paralegalAccessRevokedAt || null : null,
      archiveReadyAt: workspaceParticipant ? doc.archiveReadyAt || null : null,
      archiveDownloadedAt: workspaceParticipant ? doc.archiveDownloadedAt || null : null,
      purgeScheduledFor: workspaceParticipant ? doc.purgeScheduledFor || null : null,
      attorney: safeAttorney,
      paralegal:
        workspaceParticipant || req.acl?.isAdmin
          ? summarizeUser(doc.paralegal) || (doc.paralegal ? { id: String(doc.paralegal) } : null)
          : null,
      paralegalNameSnapshot: workspaceParticipant ? doc.paralegalNameSnapshot || "" : "",
      files: currentFiles.map(normalizeFile)
        .map(({ key: _key, storageKey: _storageKey, previewKey: _previewKey, ...safeFile }) => safeFile),
      submissionSummary,
      applicants,
      blockStatus: workspaceParticipant || req.acl?.isAdmin
        ? blockStatus
        : { blocked: false, canBlock: false, reason: "", label: "" },
      matterContext,
      matterExperience,
      termination: workspaceParticipant || req.acl?.isAdmin ? {
        status: doc.terminationStatus || "none",
        reason: doc.terminationReason || "",
        requestedAt: doc.terminationRequestedAt || null,
        requestedBy: summarizeUser(doc.terminationRequestedBy) || (doc.terminationRequestedBy ? { id: String(doc.terminationRequestedBy) } : null),
        disputeId: doc.terminationDisputeId || null,
        terminatedAt: doc.terminatedAt || null,
      } : null,
      preEngagement: canSeePreEngagement && doc.preEngagement
        ? {
            status: doc.preEngagement.status || "requested",
            requestedParalegalId: doc.preEngagement.requestedParalegalId
              ? String(doc.preEngagement.requestedParalegalId)
              : null,
            confidentialityAgreementRequired: !!doc.preEngagement.confidentialityAgreementRequired,
            conflictsCheckRequired: !!doc.preEngagement.conflictsCheckRequired,
            conflictsDetails: doc.preEngagement.conflictsDetails || "",
            confidentialityDocument: doc.preEngagement.confidentialityDocument || null,
            paralegalConfidentialityDocument: doc.preEngagement.paralegalConfidentialityDocument || null,
            requestedAt: doc.preEngagement.requestedAt || null,
            requestedBy: doc.preEngagement.requestedBy ? String(doc.preEngagement.requestedBy) : null,
            confidentialityAcknowledged: !!doc.preEngagement.confidentialityAcknowledged,
            confidentialityAcknowledgedAt: doc.preEngagement.confidentialityAcknowledgedAt || null,
            confidentialityAcknowledgedBy: doc.preEngagement.confidentialityAcknowledgedBy
              ? String(doc.preEngagement.confidentialityAcknowledgedBy)
              : null,
            conflictsResponseType: doc.preEngagement.conflictsResponseType || "",
            conflictsDisclosureText: doc.preEngagement.conflictsDisclosureText || "",
            submittedAt: doc.preEngagement.submittedAt || null,
            submittedBy: doc.preEngagement.submittedBy ? String(doc.preEngagement.submittedBy) : null,
            reviewedAt: doc.preEngagement.reviewedAt || null,
            reviewedBy: doc.preEngagement.reviewedBy ? String(doc.preEngagement.reviewedBy) : null,
          }
        : null,
    });
  })
);

const applicationResumeOperation = download => async (req, res) => {
  const controller = new AbortController(); req.resumeSignal = controller.signal;
  const cancel = () => controller.abort(); res.once("close", cancel);
  const resumes = require("../services/applicationResumes");
  try {
    const result = await resumes.read(req, download);
    if (controller.signal.aborted || res.destroyed) return;
    if (!download) return res.json(result);
    res.set("Content-Type", "application/pdf"); res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", 'attachment; filename="Application resume.pdf"');
    return res.send(result.buffer);
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    const result = resumes.errorResponse(error); return res.status(result.status).json(result.body);
  } finally { res.removeListener("close", cancel); }
};
const applicationResumeNoStore = (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); };
router.get("/:caseId/application-review/:applicantId/resume", applicationResumeNoStore, requireCaseAccess("caseId"), applicationResumeOperation(false));
router.get("/:caseId/application-review/:applicantId/resume/download", applicationResumeNoStore, requireCaseAccess("caseId"), applicationResumeOperation(true));

const exportNoStore = (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); };
const exportOperation = download => async (req, res) => {
  const controller = new AbortController(); req.exportSignal = controller.signal;
  const cancel = () => controller.abort(); res.once("close", cancel);
  let artifact, stream;
  try {
    if (!download) return res.json((await matterExports.snapshot(req)).value);
    artifact = await matterExports.prepare(req);
    if (controller.signal.aborted || res.destroyed) return;
    res.set("Content-Type", "application/zip"); res.set("Content-Length", String(artifact.size)); res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", `attachment; filename="matter-archive.zip"; filename*=UTF-8''${encodeURIComponent(artifact.value.filename.toWellFormed()).replace(/'/g, "%27")}`);
    stream = createExportReadStream(artifact.path);
    await exportPipeline(stream, res, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (res.headersSent) { res.destroy(error); return; }
    const missing = ["NoSuchKey", "NotFound"].includes(error.name) || error.$metadata?.httpStatusCode === 404;
    const changed = error.name === "PreconditionFailed" || error.$metadata?.httpStatusCode === 412;
    const security = ({ FILE_SCAN_PENDING: "EXPORT_SCAN_PENDING", FILE_SECURITY_BLOCKED: "EXPORT_BLOCKED", FILE_SCAN_ERROR: "EXPORT_SCAN_ERROR" })[error.code];
    const code = error.publicCode || security || (missing ? "EXPORT_SOURCE_MISSING" : changed ? "EXPORT_SOURCE_CHANGED" : "EXPORT_UNAVAILABLE");
    const status = error.status || error.statusCode || (missing ? 404 : changed ? 409 : 503);
    if (status >= 500) logger.error("[cases] Matter archive unavailable", { caseId: req.params.caseId, error });
    return res.status(status).json({ code, error: "The Matter archive could not be prepared. Refresh its details before trying again." });
  } finally {
    res.removeListener("close", cancel); stream?.destroy();
    if (artifact) await artifact.cleanup().catch(error => logger.error("[cases] temporary archive cleanup failed", { error }));
  }
};
router.get("/:caseId/archive/export", exportNoStore, requireCaseAccess("caseId"), exportOperation(false));
router.get("/:caseId/archive/download", exportNoStore, requireCaseAccess("caseId"), exportOperation(true));

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  if (respondToCsrfError(err, res)) return;
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) logger.error("[cases] route error:", err);
  const noticeUnavailable = ["INVITATION_RESPONSE_NOTICE_UNAVAILABLE", "PRE_ENGAGEMENT_NOTICE_UNAVAILABLE", "POSTING_NOTICE_UNAVAILABLE"].includes(err?.publicCode);
  res.status(status).json({
    error: status < 500 || noticeUnavailable ? err.message : "Server error",
    ...(noticeUnavailable || err?.publicCode === "TASK_UPDATE_CONFLICT" ? { code: err.publicCode } : {}),
    ...(Array.isArray(err?.blockers) ? { blockers: err.blockers } : {}),
  });
});

module.exports = router;
