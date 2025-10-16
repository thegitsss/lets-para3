// backend/models/Case.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

/** ----------------------------------------
 * Enums & Helpers
 * -----------------------------------------*/
const CASE_STATUS = [
  "open",         // posted and visible
  "assigned",     // paralegal chosen, not started
  "in_progress",  // work underway
  "completed",    // work marked complete (awaiting release)
  "disputed",     // buyer/seller dispute opened
  "closed"        // funds released or refunded, case closed
];

const DISPUTE_STATUS = ["open", "resolved", "rejected"];
const APPLICANT_STATUS = ["pending", "accepted", "rejected"];

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
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const applicantSchema = new Schema(
  {
    paralegalId: { type: Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: APPLICANT_STATUS, default: "pending", index: true },
    appliedAt: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 10_000 }, // optional cover note
  },
  { _id: false }
);

/** ----------------------------------------
 * Main Case Schema
 * -----------------------------------------*/
const caseSchema = new Schema(
  {
    // Parties (aligned with access control)
    attorney: { type: Types.ObjectId, ref: "User", required: true, index: true }, // creator / owner
    paralegal: { type: Types.ObjectId, ref: "User", default: null, index: true }, // accepted paralegal

    // Core
    title: { type: String, required: true, trim: true, index: true, maxlength: 300 },
    details: { type: String, required: true, trim: true, maxlength: 100_000 },
    status: { type: String, enum: CASE_STATUS, default: "open", index: true },

    // Timeline
    deadline: { type: Date, default: null }, // optional target date

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
    paymentReleased: { type: Boolean, default: false }, // funds released to paralegal
    paidOutAt: { type: Date, default: null },

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
caseSchema.index({ paralegal: 1, createdAt: -1 });
caseSchema.index({ status: 1, createdAt: -1 });
caseSchema.index({ "applicants.paralegalId": 1, createdAt: -1 }); // helpful when showing "my applications"

/** ----------------------------------------
 * Virtuals (aliases for legacy/front-end naming)
 * -----------------------------------------*/
caseSchema.virtual("createdBy").get(function () { return this.attorney; });
caseSchema.virtual("acceptedParalegal").get(function () { return this.paralegal; });

// Counts for quick UI badges (not persisted)
caseSchema.virtual("disputeCount").get(function () { return (this.disputes || []).length; });
caseSchema.virtual("fileCount").get(function () { return (this.files || []).length; });

/** ----------------------------------------
 * Validation & Hooks
 * -----------------------------------------*/
// Prevent duplicate applicants for the same paralegal
caseSchema.pre("validate", function (next) {
  if (Array.isArray(this.applicants) && this.applicants.length > 1) {
    const seen = new Set();
    for (const a of this.applicants) {
      const key = String(a.paralegalId);
      if (seen.has(key)) return next(new Error("Duplicate applicant for the same paralegalId."));
      seen.add(key);
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
  open: ["assigned", "closed"],                 // close if canceled/refunded before work
  assigned: ["in_progress", "closed"],
  in_progress: ["completed", "disputed", "closed"],
  completed: ["disputed", "closed"],
  disputed: ["resolved", "closed"],            // "resolved" is not a case status; we treat resolution as → closed
  closed: [],                                   // terminal
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
caseSchema.methods.addApplicant = function (paralegalId, note) {
  const exists = (this.applicants || []).some(a => String(a.paralegalId) === String(paralegalId));
  if (exists) throw new Error("This paralegal has already applied.");
  this.applicants.push({ paralegalId, note, status: "pending" });
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
