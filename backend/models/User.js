// backend/models/User.js
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Schema, Types } = mongoose;

/** ----------------------------------------
 * Enums
 * -----------------------------------------*/
const ROLE_ENUM = ["attorney", "paralegal", "admin"];
const STATUS_ENUM = ["pending", "approved", "rejected"];
const KYC_STATUS = ["unverified", "pending_review", "verified", "rejected"];

/** ----------------------------------------
 * Subschemas
 * -----------------------------------------*/
const auditEntrySchema = new Schema(
  {
    adminId: { type: Types.ObjectId, ref: "User" },
    action: { type: String, enum: ["approved", "rejected"], required: true },
    date: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 10_000 },
  },
  { _id: false }
);

const notificationPrefsSchema = new Schema(
  {
    // toggle channels by event type as you expand
    system: { type: Boolean, default: true },
    messages: { type: Boolean, default: true },
    caseUpdates: { type: Boolean, default: true },
    disputes: { type: Boolean, default: true },
    marketing: { type: Boolean, default: false },
  },
  { _id: false }
);

/** ----------------------------------------
 * Main schema
 * -----------------------------------------*/
const userSchema = new Schema(
  {
    // Core identity
    name: { type: String, required: true, trim: true, maxlength: 300 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      maxlength: 320,
    },
    password: { type: String, required: true, select: false }, // never returned by default

    // Role
    role: { type: String, enum: ROLE_ENUM, required: true, index: true },

    // Role-specific profile fields
    barNumber: { type: String, default: "", trim: true },         // attorneys
    resumeURL: { type: String, default: "", trim: true },         // paralegals
    certificateURL: { type: String, default: "", trim: true },    // paralegals

    // Status
    status: { type: String, enum: STATUS_ENUM, default: "pending", index: true },

    // Optional profile
    bio: { type: String, default: "", trim: true, maxlength: 20_000 },
    availability: { type: Boolean, default: true },
    avatarURL: { type: String, default: "", trim: true },
    timezone: { type: String, default: "America/New_York", trim: true },
    location: { type: String, default: "", trim: true }, // City, State

    // Expertise (improves browse/search)
    specialties: { type: [String], default: [], set: arr => [...new Set((arr || []).map(s => String(s).trim()).filter(Boolean))] },
    jurisdictions: { type: [String], default: [], set: arr => [...new Set((arr || []).map(s => String(s).trim()).filter(Boolean))] },
    skills: { type: [String], default: [], set: arr => [...new Set((arr || []).map(s => String(s).trim()).filter(Boolean))] },
    yearsExperience: { type: Number, min: 0, max: 80, default: 0 },
    languages: { type: [String], default: [], set: arr => [...new Set((arr || []).map(s => String(s).trim()).filter(Boolean))] },

    // Security / housekeeping
    emailVerified: { type: Boolean, default: false },
    lastLoginAt: { type: Date },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date },

    // KYC / payouts (non-sensitive markers; do NOT store secrets)
    kycStatus: { type: String, enum: KYC_STATUS, default: "unverified", index: true },
    stripeCustomerId: { type: String, default: null, index: true },
    stripeAccountId: { type: String, default: null, index: true }, // for Connect payouts

    // Notifications
    notifications: { type: notificationPrefsSchema, default: () => ({}) },

    // Audit trail of admin actions
    audit: { type: [auditEntrySchema], default: [] },

    // Soft-delete
    deleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
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
        delete ret.password; // double-safety
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/** ----------------------------------------
 * Indexes
 * -----------------------------------------*/
userSchema.index({ role: 1, status: 1, createdAt: -1 });
userSchema.index({ specialties: 1 });
userSchema.index({ jurisdictions: 1 });
userSchema.index({ skills: 1 });
userSchema.index({ name: "text", bio: "text", specialties: "text", skills: "text", jurisdictions: "text" }, { name: "user_text_idx" });

/** ----------------------------------------
 * Virtuals
 * -----------------------------------------*/
userSchema.virtual("profileCompleteness").get(function () {
  let score = 0;
  const checks = [
    !!this.avatarURL,
    !!this.bio && this.bio.length > 50,
    (this.specialties || []).length > 0,
    (this.skills || []).length > 0,
    (this.jurisdictions || []).length > 0,
    this.emailVerified === true,
  ];
  checks.forEach(ok => { if (ok) score += 1; });
  return Math.round((score / checks.length) * 100); // 0..100
});

userSchema.virtual("isLocked").get(function () {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
});

/** ----------------------------------------
 * Validation & Hooks
 * -----------------------------------------*/
userSchema.pre("validate", function (next) {
  if (this.email) this.email = String(this.email).trim().toLowerCase();
  if (this.name) this.name = String(this.name).trim();
  next();
});

// Hash password on create/update
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

/** ----------------------------------------
 * Methods
 * -----------------------------------------*/
userSchema.methods.comparePassword = async function (plain) {
  // password field is select:false by default; ensure it's loaded when calling this
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.recordLoginSuccess = function () {
  this.lastLoginAt = new Date();
  this.failedLogins = 0;
  this.lockedUntil = null;
  return this;
};

userSchema.methods.recordLoginFailure = function (maxAttempts = 5, lockMinutes = 15) {
  this.failedLogins = (this.failedLogins || 0) + 1;
  if (this.failedLogins >= maxAttempts) {
    const until = new Date(Date.now() + lockMinutes * 60 * 1000);
    this.lockedUntil = until;
    this.failedLogins = 0; // reset after lock
  }
  return this;
};

userSchema.methods.markEmailVerified = function () {
  this.emailVerified = true;
  return this;
};

module.exports = mongoose.model("User", userSchema);
