// backend/models/Case.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

/** ----------------------------------------
 * Enums & Helpers
 * -----------------------------------------*/
const CASE_STATUS = [
  "open",                // posted and visible
  "assigned",            // paralegal chosen, not started
  "active",              // work started (legacy alias)
  "awaiting_documents",  // pending uploads/info
  "reviewing",           // under review
  "in_progress",         // work underway
  "completed",           // work marked complete
  "disputed",            // dispute opened
  "cancelled",           // cancelled matter
  "closed",              // final closed state
];

const DISPUTE_STATUS = ["open", "resolved", "rejected"];
const APPLICANT_STATUS = ["pending", "accepted", "rejected"];
const FILE_STATUS = ["pending_review", "approved", "attorney_revision"];

const ZOOM_REGEX = /^https:\/\/.*zoom\.us\/[^\s]+$/i;

function cents(n) {
  if (n == null) return 0;
  // Ensure integer cents (avoid floats)
  return Math.max(0, Math.round(Number(n)));
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
    raisedBy: { type: Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: DISPUTE_STATUS, default: "open", index: true },
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
    appliedAt: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 10_000 }, // optional cover note
    resumeURL: { type: String, trim: true, default: "" },
    linkedInURL: { type: String, trim: true, default: "" },
    profileSnapshot: { type: profileSnapshotSchema, default: () => ({}) },
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

    // Core
    title: { type: String, required: true, trim: true, index: true, maxlength: 300 },
    practiceArea: { type: String, default: "", trim: true, maxlength: 200 },
    details: { type: String, required: true, trim: true, maxlength: 100_000 },
    state: { type: String, trim: true, maxlength: 200, default: "" },
    locationState: { type: String, trim: true, maxlength: 200, default: "" },
    status: { type: String, enum: CASE_STATUS, default: "open", index: true },

    // Timeline
    deadline: { type: Date, default: null }, // optional target date
    hiredAt: { type: Date, default: null },  // when a paralegal was hired
    completedAt: { type: Date, default: null },
    briefSummary: { type: String, trim: true, maxlength: 1000, default: "" },
    archived: { type: Boolean, default: false, index: true },
    downloadUrl: [{ type: String, trim: true }],
    readOnly: { type: Boolean, default: false, index: true },
    paralegalAccessRevokedAt: { type: Date, default: null },
    archiveZipKey: { type: String, trim: true, default: "" },
    archiveReadyAt: { type: Date, default: null },
    archiveDownloadedAt: { type: Date, default: null },
    purgeScheduledFor: { type: Date, default: null, index: true },
    purgedAt: { type: Date, default: null },
    paralegalNameSnapshot: { type: String, trim: true, default: "" },
    attorneyNameSnapshot: { type: String, trim: true, default: "" },
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
        validator: (v) => !v || ZOOM_REGEX.test(v),
        message: "zoomLink must be a valid https://*.zoom.us/... URL",
      },
    },

    // Applications & files
    applicants: [applicantSchema],
    files: [fileSchema],
    disputes: [disputeSchema],

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
    escrowIntentId: { type: String, default: null, index: true },
    escrowSessionId: { type: String, default: null, index: true }, // if using Checkout
    paymentIntentId: { type: String, default: null, index: true },
    paymentReleased: { type: Boolean, default: false }, // funds released to paralegal
    paidOutAt: { type: Date, default: null },
    paymentStatus: { type: String, default: "pending", trim: true },

    // Platform fee snapshots (computed at funding time)
    feeAttorneyPct: { type: Number, default: 15, min: 0, max: 100 }, // %
    feeParalegalPct: { type: Number, default: 15, min: 0, max: 100 }, // %
    feeAttorneyAmount: { type: Number, default: 0, min: 0 }, // cents
    feeParalegalAmount: { type: Number, default: 0, min: 0 }, // cents

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
caseSchema.index({ status: 1, createdAt: -1 });
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
caseSchema.pre("validate", function (next) {
  if (!this.attorney && this.attorneyId) this.attorney = this.attorneyId;
  if (!this.attorneyId && this.attorney) this.attorneyId = this.attorney;
  if (!this.paralegal && this.paralegalId) this.paralegal = this.paralegalId;
  if (!this.paralegalId && this.paralegal) this.paralegalId = this.paralegal;

  if (Array.isArray(this.applicants) && this.applicants.length > 1) {
    const seen = new Set();
    for (const a of this.applicants) {
      const key = String(a.paralegalId);
      if (key && seen.has(key)) return next(new Error("Duplicate applicant for the same paralegalId."));
      if (key) seen.add(key);
    }
  }
  next();
});

// Normalize money fields to integer cents and non-negative
caseSchema.pre("save", function (next) {
  this.totalAmount = cents(this.totalAmount);
  this.feeAttorneyAmount = cents(this.feeAttorneyAmount);
  this.feeParalegalAmount = cents(this.feeParalegalAmount);
  next();
});

/** ----------------------------------------
 * Methods & Statics
 * -----------------------------------------*/
// Enforce simple status transitions to avoid accidental jumps
const ALLOWED_TRANSITIONS = {
  open: ["assigned", "active", "awaiting_documents", "reviewing", "in_progress", "cancelled", "closed"],
  assigned: ["active", "awaiting_documents", "reviewing", "in_progress", "cancelled", "closed"],
  active: ["awaiting_documents", "reviewing", "in_progress", "cancelled", "closed"],
  awaiting_documents: ["reviewing", "in_progress", "completed", "cancelled", "closed"],
  reviewing: ["in_progress", "completed", "cancelled", "closed"],
  in_progress: ["completed", "disputed", "cancelled", "closed"],
  completed: ["disputed", "closed"],
  disputed: ["closed"],
  cancelled: [],
  closed: [],
};

caseSchema.methods.canTransitionTo = function (nextStatus) {
  if (!CASE_STATUS.includes(nextStatus)) return false;
  const allowed = ALLOWED_TRANSITIONS[this.status] || [];
  return allowed.includes(nextStatus);
};

caseSchema.methods.transitionTo = function (nextStatus) {
  if (!this.canTransitionTo(nextStatus)) {
    const allowed = ALLOWED_TRANSITIONS[this.status] || [];
    throw new Error(`Invalid status transition from '${this.status}' to '${nextStatus}'. Allowed: ${allowed.join(", ") || "none"}`);
  }
  this.status = nextStatus;
  return this;
};

// Snapshot platform fees based on current totalAmount & pct
caseSchema.methods.snapshotFees = function () {
  const total = cents(this.totalAmount);
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
  // Move to assigned if not already beyond
  if (["open"].includes(this.status)) this.status = "assigned";
  return this;
};

// Create a dispute embedded record
caseSchema.methods.createDispute = function ({ message, raisedBy }) {
  if (!message || !raisedBy) throw new Error("message and raisedBy are required to create a dispute.");
  this.disputes.push({ message: String(message).trim(), raisedBy });
  // Surface status to disputed if not closed
  if (this.status !== "closed") this.status = "disputed";
  return this;
};

// Convenience markers
caseSchema.methods.markInProgress = function () { return this.transitionTo("in_progress"); };
caseSchema.methods.markCompleted  = function () { return this.transitionTo("completed"); };
caseSchema.methods.markClosed     = function () { return this.transitionTo("closed"); };

/** ----------------------------------------
 * Model
 * -----------------------------------------*/
module.exports = mongoose.model("Case", caseSchema);
