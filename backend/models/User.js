// backend/models/User.js
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Schema, Types } = mongoose;

const uniqueStrings = (arr = []) =>
  [...new Set((arr || []).map((s) => String(s || "").trim()).filter(Boolean))];

/** ----------------------------------------
 * Enums
 * -----------------------------------------*/
const ROLE_ENUM = ["attorney", "paralegal", "admin"];
const STATUS_ENUM = ["pending", "approved", "denied", "rejected"];
const KYC_STATUS = ["unverified", "pending_review", "verified", "rejected"];

/** ----------------------------------------
 * Subschemas
 * -----------------------------------------*/
const auditEntrySchema = new Schema(
  {
    adminId: { type: Types.ObjectId, ref: "User" },
    action: { type: String, enum: ["approved", "denied", "rejected"], required: true },
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

const notificationSettingsSchema = new Schema(
  {
    inAppMessages: { type: Boolean, default: true },
    inAppCase: { type: Boolean, default: true },
    emailMessages: { type: Boolean, default: true },
    emailCase: { type: Boolean, default: true },
    smsMessages: { type: Boolean, default: false },
    smsCase: { type: Boolean, default: false },
  },
  { _id: false }
);

const writingSampleSchema = new Schema(
  {
    title: { type: String, trim: true, maxlength: 400 },
    content: { type: String, trim: true, maxlength: 10_000 },
  },
  { _id: false }
);

const experienceEntrySchema = new Schema(
  {
    title: { type: String, trim: true, maxlength: 300 },
    years: { type: String, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 5_000 },
  },
  { _id: false }
);

const educationEntrySchema = new Schema(
  {
    degree: { type: String, trim: true, maxlength: 200 },
    school: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false }
);

/** ----------------------------------------
 * Main schema
 * -----------------------------------------*/
const userSchema = new Schema(
  {
    // Core identity
    firstName: { type: String, required: true, trim: true, maxlength: 150 },
    lastName: { type: String, required: true, trim: true, maxlength: 150 },
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
    emailVerified: { type: Boolean, default: false },
    phoneNumber: { type: String, default: null },
    phoneVerified: { type: Boolean, default: false },

    // Role
    role: { type: String, enum: ROLE_ENUM, required: true, index: true },

    // Role-specific profile fields
    barNumber: { type: String, default: "", trim: true },         // attorneys
    resumeURL: { type: String, default: null },
    certificateURL: { type: String, default: "", trim: true },    // paralegals

    // Status
    status: { type: String, enum: STATUS_ENUM, default: "pending", index: true },

    // Optional profile
    bio: { type: String, default: "", trim: true, maxlength: 20_000 },
    about: { type: String, default: "", trim: true, maxlength: 20_000 },
    availability: { type: String, default: "Available Now", trim: true, maxlength: 200 },
    avatarURL: { type: String, default: "", trim: true },
    profileImage: { type: String, default: null },
    timezone: { type: String, default: "America/New_York", trim: true },
    location: { type: String, default: "", trim: true }, // City, State
    practiceAreas: { type: [String], default: [], set: uniqueStrings },

    // Expertise (improves browse/search)
    specialties: { type: [String], default: [], set: uniqueStrings },
    jurisdictions: { type: [String], default: [], set: uniqueStrings },
    skills: { type: [String], default: [], set: uniqueStrings },
    yearsExperience: { type: Number, min: 0, max: 80, default: 0 },
    languages: { type: [String], default: [], set: uniqueStrings },
    writingSamples: { type: [writingSampleSchema], default: [] },
    experience: { type: [experienceEntrySchema], default: [] },
    education: { type: [educationEntrySchema], default: [] },

    // Security / housekeeping
    termsAccepted: { type: Boolean, default: false },
    lastLoginAt: { type: Date },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    disabled: { type: Boolean, default: false },
    notificationsLastViewedAt: { type: Date, default: null },
    messageLastViewedAt: {
      type: Map,
      of: Date,
      default: () => ({}),
    },

    // KYC / payouts (non-sensitive markers; do NOT store secrets)
    kycStatus: { type: String, enum: KYC_STATUS, default: "unverified", index: true },
    stripeCustomerId: { type: String, default: null, index: true },
    stripeAccountId: { type: String, default: null, index: true }, // for Connect payouts
    stripeOnboarded: { type: Boolean, default: false },

    // Notifications
    notifications: { type: notificationPrefsSchema, default: () => ({}) },
    notificationPrefs: { type: notificationSettingsSchema, default: () => ({}) },
    emailPref: {
      marketing: { type: Boolean, default: true },
      product: { type: Boolean, default: true },
    },

    // Audit trail of admin actions
    audit: { type: [auditEntrySchema], default: [] },

    // Soft-delete
    deleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    linkedInURL: { type: String, default: null },
    ref1Name: { type: String, default: null },
    ref1Email: { type: String, default: null },
    ref2Name: { type: String, default: null },
    ref2Email: { type: String, default: null },
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
userSchema.index(
  { firstName: "text", lastName: "text", bio: "text", specialties: "text", skills: "text", jurisdictions: "text" },
  { name: "user_text_idx" }
);

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

userSchema.virtual("name").get(function () {
  return `${this.firstName || ""} ${this.lastName || ""}`.trim();
});

/** ----------------------------------------
 * Validation & Hooks
 * -----------------------------------------*/
userSchema.pre("validate", function (next) {
  if (this.email) this.email = String(this.email).trim().toLowerCase();
  if (this.firstName) this.firstName = String(this.firstName).trim();
  if (this.lastName) this.lastName = String(this.lastName).trim();
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
