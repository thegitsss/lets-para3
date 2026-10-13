// backend/models/Case.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;
const { dateOnlyToUtcDate, normalizeDateOnly } = require("../utils/businessDate");
const {
  CASE_STATUS_ENUM,
  CASE_TRANSITIONS,
  STATUS_IN_PROGRESS,
  assertCaseLifecycleInvariants,
  canTransitionCaseStatus,
  normalizeCaseStatus,
} = require("../utils/caseState");

/** ----------------------------------------
 * Enums & Helpers
 * -----------------------------------------*/
const DISPUTE_STATUS = ["open", "resolved", "rejected"];
const APPLICANT_STATUS = ["pending", "accepted", "rejected", "withdrawn"];
const FILE_STATUS = ["pending_review", "approved", "attorney_revision"];

function validZoomLink(value) {
  if (!value) return true;
  if (typeof value !== 'string' || value.length > 2000 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'zoom.us' || url.hostname.endsWith('.zoom.us')) && url.pathname.length > 1;
  } catch { return false; }
}
const {
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
  DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
} = require("../services/platformFeePolicy");
const DEFAULT_ATTORNEY_FEE_PCT = DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT;
const DEFAULT_PARALEGAL_FEE_PCT = DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;

function cents(n) {
  if (n == null) return 0;
  // Ensure integer cents (avoid floats)
  return Math.max(0, Math.round(Number(n)));
}

function referenceId(value) {
  const resolved = value?._id || value?.id || value || "";
  return resolved ? String(resolved) : "";
}

/** ----------------------------------------
 * Subschemas
 * -----------------------------------------*/
const commentSchema = new Schema(
  {
    by: { type: Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, required: true, trim: true, maxlength: 10_000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const disputeSchema = new Schema(
  {
    // Give each embedded dispute its own stable ID for admin tooling
    disputeId: { type: String, default: () => new Types.ObjectId().toString(), index: true },
    message: { type: String, required: true, trim: true, maxlength: 20_000 },
    amountRequestedCents: { type: Number, min: 0, default: null },
    raisedBy: { type: Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: DISPUTE_STATUS, default: "open", index: true },
    adminNotes: { type: String, trim: true, maxlength: 4000, default: "" },
    adminNotesUpdatedAt: { type: Date, default: null },
    adminNotesUpdatedBy: { type: Types.ObjectId, ref: "User", default: null },
    comments: [commentSchema],
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

const fileSchema = new Schema(
  {
    filename: { type: String, trim: true },
    original: { type: String, trim: true },
    key: { type: String, trim: true }, // storage key/path
    mime: { type: String, trim: true },
    size: { type: Number, min: 0 },
    uploadedBy: { type: Types.ObjectId, ref: "User", index: true },
    uploadedByRole: { type: String, enum: ["attorney", "paralegal", "admin"], default: "attorney" },
    status: { type: String, enum: FILE_STATUS, default: "pending_review", index: true },
    version: { type: Number, default: 1 },
    revisionNotes: { type: String, trim: true, maxlength: 2000, default: "" },
    revisionRequestedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    replacedAt: { type: Date, default: null },
    history: [
      {
        key: { type: String, trim: true },
        replacedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const profileSnapshotSchema = new Schema(
  {
    location: { type: String, trim: true, maxlength: 300, default: "" },
    availability: { type: String, trim: true, maxlength: 200, default: "" },
    yearsExperience: { type: Number, min: 0, max: 80, default: null },
    languages: [{ type: String, trim: true }],
    specialties: [{ type: String, trim: true }],
    bio: { type: String, trim: true, maxlength: 1_000, default: "" },
    profileImage: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const applicantSchema = new Schema(
  {
    paralegalId: { type: Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: APPLICANT_STATUS, default: "pending", index: true },
    starredBy: [{ type: Types.ObjectId, ref: "User" }],
    appliedAt: { type: Date, default: Date.now },
    withdrawnAt: { type: Date },
    withdrawalRevision: { type: String, match: /^[a-f0-9]{64}$/ },
    statusHistory: { type: [new Schema({ from: String, to: String, reason: String, actorId: { type: Types.ObjectId, ref: "User" }, at: Date }, { _id: false })], default: undefined },
    note: { type: String, trim: true, maxlength: 10_000 }, // optional cover note
    resumeURL: { type: String, trim: true, default: "" },
    linkedInURL: { type: String, trim: true, default: "" },
    profileSnapshot: { type: profileSnapshotSchema, default: () => ({}) },
    requirementConfirmations: {type:[new Schema({requirement:String,meets:Boolean},{_id:false})],default:[]},
  },
  { _id: false }
);

const inviteSchema = new Schema(
  {
    paralegalId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["pending", "accepted", "declined", "expired"], default: "pending", index: true },
    invitedAt: { type: Date, default: Date.now },
    respondedAt: { type: Date, default: null },
    syncStatus: {
      type: String,
      enum: ["pending", "synced", "needs_reconciliation"],
      default: "synced",
    },
    syncedAt: { type: Date, default: null },
    syncError: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { _id: false }
);

const scopeTaskSchema = new Schema(
  {
    title: { type: String, trim: true, maxlength: 200 },
    completed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const flagSchema = new Schema(
  {
    by: { type: Types.ObjectId, ref: "User", required: true, index: true },
    reason: { type: String, trim: true, maxlength: 200, required: true },
    details: { type: String, trim: true, maxlength: 2000, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const preEngagementDocumentSchema = new Schema(
  {
    key: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    mimeType: { type: String, trim: true, default: "" },
    size: { type: Number, default: 0, min: 0 },
    uploadedAt: { type: Date, default: null },
  },
  { _id: false }
);

const preEngagementSchema = new Schema(
  {
    revision: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["requested", "submitted", "approved", "changes_requested"], default: "requested" },
    requestedParalegalId: { type: Types.ObjectId, ref: "User", default: null },
    confidentialityAgreementRequired: { type: Boolean, default: false },
    conflictsCheckRequired: { type: Boolean, default: false },
    conflictsDetails: { type: String, trim: true, maxlength: 5000, default: "" },
    confidentialityDocument: { type: preEngagementDocumentSchema, default: null },
    paralegalConfidentialityDocument: { type: preEngagementDocumentSchema, default: null },
    requestedAt: { type: Date, default: null },
    requestedBy: { type: Types.ObjectId, ref: "User", default: null },
    confidentialityAcknowledged: { type: Boolean, default: false },
    confidentialityAcknowledgedAt: { type: Date, default: null },
    confidentialityAcknowledgedBy: { type: Types.ObjectId, ref: "User", default: null },
    conflictsResponseType: {
      type: String,
      enum: ["none_known", "disclosure", ""],
      default: "",
    },
    conflictsDisclosureText: { type: String, trim: true, maxlength: 5000, default: "" },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

/** ----------------------------------------
 * Main Case Schema
 * -----------------------------------------*/
const caseSchema = new Schema(
  {
    // Parties (aligned with access control)
    jobId: { type: Types.ObjectId, ref: "Job", default: null, index: true },
    attorney: { type: Types.ObjectId, ref: "User", required: true, index: true }, // creator / owner
    attorneyId: { type: Types.ObjectId, ref: "User", required: true, index: true }, // alias for compatibility
    paralegal: { type: Types.ObjectId, ref: "User", default: null, index: true }, // accepted paralegal
    paralegalId: { type: Types.ObjectId, ref: "User", default: null, index: true }, // alias for compatibility
    pendingParalegalId: { type: Types.ObjectId, ref: "User", default: null, index: true },
    pendingParalegalInvitedAt: { type: Date, default: null },
    invites: [inviteSchema],

    // Core
    title: { type: String, required: true, trim: true, index: true, maxlength: 300 },
    practiceArea: { type: String, default: "", trim: true, maxlength: 200 },
    details: { type: String, required: true, trim: true, maxlength: 100_000 },
    state: { type: String, trim: true, maxlength: 200, default: "" },
    locationState: { type: String, trim: true, maxlength: 200, default: "" },
    experiencePreference: { type: String, trim: true, maxlength: 200, default: "" },
    minimumYearsExperience: { type: Number, min: 0, max: 80, default: 0 },
    tasks: { type: [scopeTaskSchema], default: [] },
    requirements: { type: [{ type: String, trim: true, maxlength: 200 }], default: [], validate: value => value.length <= 12 },
    tasksLocked: { type: Boolean, default: false, index: true },
    // Task order/content is locked during an assignment. Preserve earlier
    // approvals without treating them as work done by a replacement.
    assignmentCompletedTaskIndexes: { type: [Number], default: undefined },
    status: { type: String, enum: CASE_STATUS_ENUM, default: "open", index: true },

    // Timeline
    // deadlineDate is authoritative because a Matter deadline is a calendar date,
    // not a timezone-specific instant. deadline remains an indexed compatibility
    // mirror while existing consumers and records are migrated.
    deadlineDate: {
      type: String,
      default: "",
      trim: true,
      validate: {
        validator: (value) => !value || normalizeDateOnly(value) === value,
        message: "Deadline must use YYYY-MM-DD.",
      },
      index: true,
    },
    deadline: { type: Date, default: null },
    hiredAt: { type: Date, default: null },  // when a paralegal was hired
    completedAt: { type: Date, default: null },
    pausedReason: {
      type: String,
      enum: ["paralegal_withdrew", "attorney_paused", "dispute", null],
      default: null,
    },
    pausedAt: { type: Date, default: null },
    disputeDeadlineAt: { type: Date, default: null },
    adminDisputeDeadlineAt: { type: Date, default: null },
    adminDisputeOverdueNotifiedAt: { type: Date, default: null },
    partialPayoutAmount: { type: Number, default: null, min: 0 }, // cents (gross before paralegal fee)
    withdrawalClaimToken: { type: String, default: "", trim: true, select: false },
    withdrawalClaimStatus: { type: String, enum: ["claimed", "needs_reconciliation", null], default: null, select: false },
    withdrawalClaimedAt: { type: Date, default: null, select: false },
    withdrawalClaimTransferId: { type: String, default: "", trim: true, select: false },
    withdrawalClaimAmount: { type: Number, default: null, min: 0, select: false },
    payoutFinalizedAt: { type: Date, default: null },
    payoutFinalizedType: {
      type: String,
      enum: ["zero_auto", "partial_attorney", "full", "admin", "expired_zero", null],
      default: null,
    },
    withdrawnParalegalId: { type: Types.ObjectId, ref: "User", default: null },
    withdrawalHistory: {
      type: [new Schema({
        withdrawnParalegalId: { type: Types.ObjectId, ref: "User", required: true },
        paralegalNameSnapshot: String,
        payoutFinalizedAt: Date,
        payoutFinalizedType: String,
        partialPayoutAmount: Number,
        remainingAmount: Number,
        feeParalegalPct: Number,
        feeAttorneyPct: Number,
        payoutTransferId: String,
        pausedAt: Date,
      }, { _id: false })],
      default: [],
    },
    relistRequestedAt: { type: Date, default: null },
    relistPending: { type: Boolean, default: false },
    remainingAmount: { type: Number, default: null, min: 0 }, // cents remaining for relist
    briefSummary: { type: String, trim: true, maxlength: 1000, default: "" },
    archived: { type: Boolean, default: false, index: true },
    archiveReceipt: { type: Schema.Types.Mixed, default: null, select: false },
    downloadUrl: [{ type: String, trim: true }],
    readOnly: { type: Boolean, default: false, index: true },
    paralegalAccessRevokedAt: { type: Date, default: null },
    archiveZipKey: { type: String, trim: true, default: "" },
    archiveReadyAt: { type: Date, default: null },
    archiveDownloadedAt: { type: Date, default: null },
    purgeScheduledFor: { type: Date, default: null, index: true },
    purgedAt: { type: Date, default: null },
    fundingRequestKey: { type: String, default: "" },
    fundingRequestFingerprint: { type: String, default: "" },
    postingSyncStatus: {
      type: String,
      enum: ["synced", "needs_reconciliation"],
      default: "synced",
      index: true,
    },
    postingSyncedAt: { type: Date, default: null },
    postingSyncError: { type: String, default: "", trim: true, maxlength: 1000 },
    hiringClaimToken: { type: String, default: "", trim: true },
    hiringClaimParalegalId: { type: Types.ObjectId, ref: "User", default: null },
    hiringClaimedAt: { type: Date, default: null },
    hiringClaimStatus: {
      type: String,
      enum: ["claimed", "needs_reconciliation", null],
      default: null,
      index: true,
    },
    hiringClaimPaymentIntentId: { type: String, default: "", trim: true },
    hiringClaimAmount: { type: Number, default: 0, min: 0 },
    hiringClaimError: { type: String, default: "", trim: true, maxlength: 1000 },
    completionClaimToken: { type: String, default: "", trim: true },
    completionClaimedAt: { type: Date, default: null },
    completionClaimStatus: {
      type: String,
      enum: ["claimed", "needs_reconciliation", null],
      default: null,
      index: true,
    },
    completionClaimTransferId: { type: String, default: "", trim: true },
    completionClaimError: { type: String, default: "", trim: true, maxlength: 1000 },
    paralegalNameSnapshot: { type: String, trim: true, default: "" },
    attorneyNameSnapshot: { type: String, trim: true, default: "" },
    taskRevision: { type: Number, default: 0, min: 0 },
    preEngagement: { type: preEngagementSchema, default: null },
    terminationReason: { type: String, trim: true, maxlength: 2000, default: "" },
    terminationStatus: { type: String, enum: ["none", "auto_cancelled", "disputed", "resolved"], default: "none", index: true },
    terminationRequestedAt: { type: Date, default: null },
    terminationRequestedBy: { type: Types.ObjectId, ref: "User", default: null },
    terminationDisputeId: { type: String, default: null },
    terminatedAt: { type: Date, default: null },
    internalNotes: {
      text: { type: String, trim: true, maxlength: 10_000, default: "" },
      updatedBy: { type: Types.ObjectId, ref: "User", default: null },
      updatedAt: { type: Date, default: null },
    },

    // Zoom / meeting info
    zoomLink: {
      type: String,
      default: "",
      trim: true,
      validate: {
        validator: validZoomLink,
        message: "zoomLink must be a valid https://*.zoom.us/... URL",
      },
    },

    // Applications & files
    applicants: [applicantSchema],
    // Retains a withdrawal interlock while the canonical Application is synchronizing.
    withdrawnApplicantIds: { type: [Types.ObjectId], default: undefined, select: false },
    files: [fileSchema],
    disputes: [disputeSchema],
    flags: { type: [flagSchema], default: [] },
    moderationStatus: {
      type: String,
      enum: ["none", "flagged", "resolution_requested"],
      default: "none",
      index: true,
    },
    moderationPostingBaseline: { type: String, default: null },
    moderationEditRequest: { type: String, maxlength: 2000, default: "" },
    moderationReviewReceipt: { type: Schema.Types.Mixed, default: null },
    moderationFlaggedAt: { type: Date, default: null },
    moderationFlaggedBy: { type: Types.ObjectId, ref: "User", default: null },
    moderationResolutionRequestedAt: { type: Date, default: null },
    moderationResolutionRequestedBy: { type: Types.ObjectId, ref: "User", default: null },

    // Lightweight progress updates/changelog
    updates: [
      {
        date: { type: Date, default: Date.now },
        text: { type: String, trim: true, maxlength: 10_000 },
        by: { type: Types.ObjectId, ref: "User" },
      },
    ],

    // Escrow / payments (Stripe)
    currency: { type: String, default: "usd", lowercase: true, trim: true },
    totalAmount: { type: Number, default: 0, min: 0 }, // in cents
    lockedTotalAmount: { type: Number, default: null, min: 0 }, // in cents; immutable once set
    amountLockedAt: { type: Date, default: null },
    escrowIntentId: { type: String, default: null, index: true },
    escrowSessionId: { type: String, default: null, index: true }, // if using Checkout
    paymentIntentId: { type: String, default: null, index: true },
    stripeMode: { type: String, enum: ["live", "test", "unknown"], default: "unknown", index: true },
    escrowStatus: { type: String, default: null, index: true }, // awaiting_funding, funded
    paymentReleased: { type: Boolean, default: false }, // Matter payment release recorded
    paidOutAt: { type: Date, default: null },
    paymentStatus: { type: String, default: "pending", trim: true },
    fundingIntegrityStatus: {
      type: String,
      enum: ["pending", "verified", "failed"],
      default: "pending",
      index: true,
    },
    fundingIntegrityFailure: { type: String, default: "", trim: true, maxlength: 500 },
    fundingVerifiedAt: { type: Date, default: null },
    payoutStatus: {
      type: String,
      enum: ["not_started", "pending", "paid", "failed", "reversed", "needs_reconciliation"],
      default: "not_started",
      index: true,
    },
    payoutFailureReason: { type: String, default: "", trim: true, maxlength: 500 },

    // Platform fee snapshots (computed at funding time)
    feeAttorneyPct: { type: Number, default: DEFAULT_ATTORNEY_FEE_PCT, min: 0, max: 100 }, // %
    feeParalegalPct: { type: Number, default: DEFAULT_PARALEGAL_FEE_PCT, min: 0, max: 100 }, // %
    feeAttorneyAmount: { type: Number, default: 0, min: 0 }, // cents
    feeParalegalAmount: { type: Number, default: 0, min: 0 }, // cents

    // Dispute settlement snapshots (optional)
    disputeSettlement: {
      action: { type: String, enum: ["refund", "release_full", "release_partial"], default: null },
      grossAmount: { type: Number, default: null, min: 0 }, // cents
      feeAttorneyAmount: { type: Number, default: null, min: 0 }, // cents
      feeParalegalAmount: { type: Number, default: null, min: 0 }, // cents
      feeAttorneyPct: { type: Number, default: null, min: 0, max: 100 }, // %
      feeParalegalPct: { type: Number, default: null, min: 0, max: 100 }, // %
      payoutAmount: { type: Number, default: null, min: 0 }, // cents (net paid)
      refundAmount: { type: Number, default: null, min: 0 }, // cents
      refundId: { type: String, default: "", trim: true },
      transferId: { type: String, default: "", trim: true },
      resolvedAt: { type: Date, default: null },
      disputeId: { type: String, default: null },
    },

    // Transfer ID when funds are paid out to paralegal
    payoutTransferId: { type: String, default: null, index: true },
  },
  {
    timestamps: true,
    versionKey: false,
    minimize: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/** ----------------------------------------
 * Indexes
 * -----------------------------------------*/
caseSchema.index({ createdAt: -1 });
caseSchema.index({ attorney: 1, createdAt: -1 });
caseSchema.index({ attorneyId: 1, createdAt: -1 });
caseSchema.index({ paralegal: 1, createdAt: -1 });
caseSchema.index({ paralegalId: 1, createdAt: -1 });
caseSchema.index({ pendingParalegalId: 1, createdAt: -1 });
caseSchema.index({ "invites.paralegalId": 1, "invites.status": 1, createdAt: -1 });
caseSchema.index({ "invites.syncStatus": 1, updatedAt: 1 });
caseSchema.index({ postingSyncStatus: 1, updatedAt: 1 });
caseSchema.index({ completionClaimStatus: 1, completionClaimedAt: 1 });
caseSchema.index({ status: 1, createdAt: -1 });
caseSchema.index({ job: 1 }); // Retained reverse posting links used by discovery.
caseSchema.index({ "applicants.paralegalId": 1, createdAt: -1 }); // helpful when showing "my applications"

/** ----------------------------------------
 * Virtuals (aliases for legacy/front-end naming)
 * -----------------------------------------*/
caseSchema.virtual("createdBy").get(function () { return this.attorney || this.attorneyId; });
caseSchema.virtual("acceptedParalegal").get(function () { return this.paralegal || this.paralegalId; });

// Counts for quick UI badges (not persisted)
caseSchema.virtual("disputeCount").get(function () { return (this.disputes || []).length; });
caseSchema.virtual("fileCount").get(function () { return (this.files || []).length; });

/** ----------------------------------------
 * Validation & Hooks
 * -----------------------------------------*/
// Prevent duplicate applicants for the same paralegal
caseSchema.pre("validate", function () {
  if (!this.attorney && this.attorneyId) this.attorney = this.attorneyId;
  if (!this.attorneyId && this.attorney) this.attorneyId = this.attorney;
  if (!this.paralegal && this.paralegalId) this.paralegal = this.paralegalId;
  if (!this.paralegalId && this.paralegal) this.paralegalId = this.paralegal;
  if (this.attorney && this.attorneyId && referenceId(this.attorney) !== referenceId(this.attorneyId)) {
    throw new Error("attorney and attorneyId must reference the same user.");
  }
  if (this.paralegal && this.paralegalId && referenceId(this.paralegal) !== referenceId(this.paralegalId)) {
    throw new Error("paralegal and paralegalId must reference the same user.");
  }
  if (this.isNew || this.isSelected("status") || this.isModified("status")) {
    this.status = normalizeCaseStatus(this.status);
  }
  // A partial read cannot establish an omitted deadline alias. Keep the
  // existing normalization for new/full reads and explicit deadline edits.
  if (
    this.isNew ||
    (this.isSelected("deadlineDate") && this.isSelected("deadline")) ||
    this.isModified("deadlineDate") ||
    this.isModified("deadline")
  ) {
    const normalizedDeadline = normalizeDateOnly(this.deadlineDate || this.deadline);
    this.deadlineDate = normalizedDeadline;
    this.deadline = normalizedDeadline ? dateOnlyToUtcDate(normalizedDeadline) : null;
  }

  if (Array.isArray(this.applicants) && this.applicants.length > 1) {
    const seen = new Set();
    for (const a of this.applicants) {
      const key = String(a.paralegalId);
      if (key && seen.has(key)) throw new Error("Duplicate applicant for the same paralegalId.");
      if (key) seen.add(key);
    }
  }
  if (Array.isArray(this.invites) && this.invites.length > 1) {
    const seen = new Set();
    for (const invite of this.invites) {
      const key = String(invite.paralegalId);
      if (key && seen.has(key)) throw new Error("Duplicate invite for the same paralegalId.");
      if (key) seen.add(key);
    }
  }
});

// Normalize loaded or explicitly assigned money fields to integer cents.
// A partial Case document must not replace unselected persisted amounts with zero.
caseSchema.pre("save", function () {
  const normalizeAmount = (path, { optional = false } = {}) => {
    if (!this.isSelected(path) && !this.isModified(path)) return;
    const value = this.get(path);
    if (optional && value == null) return;
    this.set(path, cents(value));
  };
  for (const path of ["totalAmount", "feeAttorneyAmount", "feeParalegalAmount"]) {
    normalizeAmount(path);
  }
  for (const path of ["lockedTotalAmount", "partialPayoutAmount", "remainingAmount"]) {
    normalizeAmount(path, { optional: true });
  }
  if (this.disputeSettlement) {
    for (const field of ["grossAmount", "feeAttorneyAmount", "feeParalegalAmount", "payoutAmount", "refundAmount"]) {
      normalizeAmount(`disputeSettlement.${field}`);
    }
  }
});

/** ----------------------------------------
 * Methods & Statics
 * -----------------------------------------*/
caseSchema.methods.canTransitionTo = function (nextStatus) {
  return canTransitionCaseStatus(this.status, nextStatus);
};

caseSchema.methods.transitionTo = function (nextStatus, { enforceInvariants = true } = {}) {
  const target = normalizeCaseStatus(nextStatus);
  if (!this.canTransitionTo(target)) {
    const current = normalizeCaseStatus(this.status);
    const allowed = CASE_TRANSITIONS[current] || [];
    throw new Error(`Invalid status transition from '${this.status}' to '${target}'. Allowed: ${allowed.join(", ") || "none"}`);
  }
  if (enforceInvariants) assertCaseLifecycleInvariants(this, { status: target });
  this.status = target;
  return this;
};

caseSchema.methods.ensureLifecycleStatus = function (nextStatus, { enforceInvariants = true } = {}) {
  const target = normalizeCaseStatus(nextStatus);
  const current = normalizeCaseStatus(this.status);
  if (current === target) {
    if (enforceInvariants) assertCaseLifecycleInvariants(this, { status: target });
    this.status = target;
    return this;
  }
  return this.transitionTo(target, { enforceInvariants });
};

caseSchema.methods.assertLifecycleInvariants = function () {
  assertCaseLifecycleInvariants(this);
  return this;
};

// Snapshot platform fees based on current totalAmount & pct
caseSchema.methods.snapshotFees = function () {
  const total = cents(this.lockedTotalAmount ?? this.totalAmount);
  const atty = Math.floor((total * (this.feeAttorneyPct ?? 0)) / 100);
  const para = Math.floor((total * (this.feeParalegalPct ?? 0)) / 100);
  this.feeAttorneyAmount = cents(atty);
  this.feeParalegalAmount = cents(para);
  return this;
};

// Add an applicant (safe-guarded)
caseSchema.methods.addApplicant = function (paralegalId, note, extras = {}) {
  const exists = (this.applicants || []).some(a => String(a.paralegalId) === String(paralegalId));
  if (exists) throw new Error("This paralegal has already applied.");
  this.applicants.push({
    paralegalId,
    note,
    status: "pending",
    resumeURL: extras.resumeURL || "",
    linkedInURL: extras.linkedInURL || "",
    profileSnapshot: extras.profileSnapshot || {},
  });
  return this;
};

// Accept an applicant and set paralegal & status
caseSchema.methods.acceptApplicant = function (paralegalId) {
  const idx = (this.applicants || []).findIndex(a => String(a.paralegalId) === String(paralegalId));
  if (idx === -1) throw new Error("Applicant not found.");
  this.applicants[idx].status = "accepted";
  this.paralegal = paralegalId;
  return this;
};

// Create a dispute embedded record
caseSchema.methods.createDispute = function ({ message, raisedBy, amountRequestedCents }) {
  if (!message || !raisedBy) throw new Error("message and raisedBy are required to create a dispute.");
  if ((this.disputes || []).some((dispute) => String(dispute?.status || "open").toLowerCase() === "open")) {
    const error = new Error("An open dispute already exists for this case.");
    error.code = "OPEN_DISPUTE_EXISTS";
    throw error;
  }
  if (!this.canTransitionTo("disputed")) {
    const error = new Error(`A dispute cannot be opened while the case is '${normalizeCaseStatus(this.status)}'.`);
    error.code = "DISPUTE_STATE_INVALID";
    throw error;
  }
  const payload = { message: String(message).trim(), raisedBy, status: "open" };
  if (Number.isFinite(amountRequestedCents) && amountRequestedCents > 0) {
    const amount = Math.round(amountRequestedCents);
    const available = cents(this.remainingAmount ?? this.lockedTotalAmount ?? this.totalAmount);
    if (amount > available) {
      const error = new Error("Requested amount exceeds the funded matter balance.");
      error.code = "DISPUTE_AMOUNT_EXCEEDS_BALANCE";
      throw error;
    }
    payload.amountRequestedCents = amount;
  }
  this.disputes.push(payload);
  this.pausedReason = "dispute";
  this.transitionTo("disputed");
  return this;
};

// Convenience markers
caseSchema.methods.markInProgress = function () { return this.ensureLifecycleStatus(STATUS_IN_PROGRESS); };
caseSchema.methods.markCompleted  = function () { return this.ensureLifecycleStatus("completed"); };
caseSchema.methods.markClosed     = function () { return this.ensureLifecycleStatus("closed"); };

/** ----------------------------------------
 * Model
 * -----------------------------------------*/
module.exports = mongoose.model("Case", caseSchema);
