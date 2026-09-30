const mongoose = require("mongoose");

const profileSnapshotSchema = new mongoose.Schema(
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

const ApplicationSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Job",
    required: true,
  },

  paralegalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  requirementConfirmations: [{ _id:false, requirement:String, meets:Boolean }],
  coverLetter: { type: String, required: true, trim: true, maxlength: 2000 },
  resumeURL: { type: String, trim: true, default: "" },
  linkedInURL: { type: String, trim: true, default: "" },
  profileSnapshot: { type: profileSnapshotSchema, default: () => ({}) },
  scopeSnapshot: {
    type: new mongoose.Schema({
      title: String, description: String, practiceArea: String, state: String,
      caseId: String, totalAmount: Number, currency: String, deadlineDate: String,
      tasks: [String], requirements:[String], capturedAt: Date,
    }, { _id: false }),
    default: undefined,
  },

  status: {
    type: String,
    enum: ["submitted", "viewed", "shortlisted", "accepted", "rejected", "withdrawn"],
    default: "submitted",
  },
  withdrawnAt: { type: Date, default: null },
  syncStatus: {
    type: String,
    enum: ["pending", "synced", "needs_reconciliation"],
    default: "pending",
  },
  syncedAt: { type: Date, default: null },
  syncError: { type: String, trim: true, maxlength: 1000, default: "" },
  statusHistory: [
    {
      _id: false,
      from: { type: String, trim: true, maxlength: 40, default: "" },
      to: { type: String, trim: true, maxlength: 40, required: true },
      reason: { type: String, trim: true, maxlength: 120, default: "" },
      actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      at: { type: Date, default: Date.now },
    },
  ],
  starredBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
}, {
  timestamps: true,
  versionKey: false,
});

ApplicationSchema.index({ jobId: 1, paralegalId: 1 }, { unique: true });
ApplicationSchema.index({ paralegalId: 1, status: 1, createdAt: -1 });
ApplicationSchema.index({ jobId: 1, status: 1, createdAt: -1 });
ApplicationSchema.index({ syncStatus: 1, updatedAt: 1 });

// Match the inventory's comparison rules so mixed BSON/string identity joins
// retain their ambiguity checks without scanning the full application history.
ApplicationSchema.index({ jobId: 1, _id: 1 }, { name: 'inventory_application_job_en', collation: { locale: 'en', strength: 3 } });
ApplicationSchema.index({ _id: 1, jobId: 1 }, { name: 'inventory_application_identity_en', collation: { locale: 'en', strength: 3 } });

ApplicationSchema.pre("validate", function () {
  if (Array.isArray(this.starredBy) && this.starredBy.length > 1) {
    const unique = [];
    const seen = new Set();
    for (const value of this.starredBy) {
      const key = String(value || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(value);
    }
    this.starredBy = unique;
  }
  if (Array.isArray(this.statusHistory) && this.statusHistory.length > 50) {
    this.statusHistory = this.statusHistory.slice(-50);
  }
});

module.exports = mongoose.model("Application", ApplicationSchema);
