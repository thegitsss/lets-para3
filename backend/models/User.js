// backend/models/User.js
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const argon2 = require("argon2");

const { Schema, Types } = mongoose;
const { normalizePassword } = require("../utils/passwordPolicy");
const { normalizeHttpUrl } = require("../utils/httpUrl");

const uniqueStrings = (arr = []) =>
  [...new Set((arr || []).map((s) => String(s || "").trim()).filter(Boolean))];

/** ----------------------------------------
 * Enums
 * -----------------------------------------*/
const ROLE_ENUM = ["attorney", "paralegal", "admin", "director"];
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

const notificationCategorySettingsSchema = new Schema(
  {
    messages: { type: Boolean, default: true },
    invites: { type: Boolean, default: true },
    caseUpdates: { type: Boolean, default: true },
    payouts: { type: Boolean, default: true },
    system: { type: Boolean, default: true },
  },
  { _id: false }
);

const notificationSettingsSchema = new Schema(
  {
    email: { type: Boolean, default: true },
    emailMessages: { type: Boolean, default: true },
    emailCase: { type: Boolean, default: true },
    inApp: { type: Boolean, default: true },
    inAppMessages: { type: Boolean, default: true },
    inAppCase: { type: Boolean, default: true },
    browser: { type: Boolean, default: false },
    categories: { type: notificationCategorySettingsSchema, default: () => ({}) },
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

const ARGON2_OPTIONS = process.env.NODE_ENV === "test"
  ? { type: argon2.argon2id, memoryCost: 4096, timeCost: 1, parallelism: 1 }
  : { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const BCRYPT_PREFIX = /^\$2[aby]?\$/;
const ARGON2_PREFIX = /^\$argon2(id|i|d)\$/;

function isBcryptHash(value) {
  return typeof value === "string" && BCRYPT_PREFIX.test(value);
}

function isArgon2Hash(value) {
  return typeof value === "string" && ARGON2_PREFIX.test(value);
}

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
    school: { type: String, trim: true, maxlength: 200 },
    degree: { type: String, trim: true, maxlength: 200 },
    fieldOfStudy: { type: String, trim: true, maxlength: 200 },
    grade: { type: String, trim: true, maxlength: 120 },
    activities: { type: String, trim: true, maxlength: 1000 },
    startMonth: { type: String, trim: true, maxlength: 20 },
    startYear: { type: String, trim: true, maxlength: 10 },
    endMonth: { type: String, trim: true, maxlength: 20 },
    endYear: { type: String, trim: true, maxlength: 10 },
  },
  { _id: false }
);

const sanitizeLanguageEntries = (value = []) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === "string") {
        const clean = entry.trim().slice(0, 120);
        return clean ? { name: clean, proficiency: "" } : null;
      }
      const name = String(entry.name || entry.language || "").trim().slice(0, 120);
      const proficiency = String(entry.proficiency || entry.level || "").trim().slice(0, 120);
      if (!name) return null;
      return { name, proficiency };
    })
    .filter(Boolean);
};

const languageEntrySchema = new Schema(
  {
    name: { type: String, trim: true, maxlength: 120 },
    proficiency: { type: String, trim: true, maxlength: 120 },
  },
  { _id: false }
);

const availabilityDetailsSchema = new Schema(
  {
    status: {
      type: String,
      enum: ["available", "unavailable"],
      default: "available",
      lowercase: true,
      trim: true,
    },
    nextAvailable: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const onboardingSchema = new Schema(
  {
    paralegalTourCompleted: { type: Boolean, default: false },
    paralegalProfileTourCompleted: { type: Boolean, default: false },
    attorneyTourCompleted: { type: Boolean, default: false },
    attorneyProfileCompleted: { type: Boolean, default: false },
  },
  { _id: false }
);

const pendingHireSchema = new Schema(
  {
    caseId: { type: Types.ObjectId, ref: "Case", default: null },
    paralegalName: { type: String, default: "", trim: true, maxlength: 200 },
    fundUrl: { type: String, default: "", trim: true, maxlength: 2000 },
    message: { type: String, default: "", trim: true, maxlength: 2000 },
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const dashboardSavedViewSchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 80 },
    scope: {
      type: String,
      required: true,
      enum: ["attorney_matters", "paralegal_applications"],
      index: false,
    },
    name: { type: String, required: true, trim: true, maxlength: 48 },
    filters: { type: Schema.Types.Mixed, default: () => ({}) },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false, strict: true }
);

const providerIdentitySchema = new Schema(
  {
    provider: {
      type: String,
      enum: ["google"],
      required: true,
      lowercase: true,
      trim: true,
    },
    providerAccountId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    linkedAt: { type: Date, default: Date.now },
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
    pendingEmail: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
      maxlength: 320,
    },
    pendingEmailRequestedAt: { type: Date, default: null },
    password: { type: String, required: true, select: false }, // never returned by default
    authVersion: { type: Number, default: 0, min: 0, select: false },
    resetPasswordTokenHash: { type: String, default: null, select: false, index: true },
    resetPasswordExpiresAt: { type: Date, default: null, select: false },
    resetPasswordRequestedAt: { type: Date, default: null, select: false },
    emailVerified: { type: Boolean, default: false },
    phoneNumber: { type: String, default: null },
    phoneVerified: { type: Boolean, default: false },

    // Role
    role: { type: String, enum: ROLE_ENUM, required: true, index: true },

    // Role-specific profile fields
    barNumber: { type: String, default: "", trim: true },         // attorneys
    resumeURL: { type: String, default: null },
    certificateURL: { type: String, default: "", trim: true },    // paralegals
    writingSampleURL: { type: String, default: "", trim: true },

    // Status
    status: { type: String, enum: STATUS_ENUM, default: "pending", index: true },
    approvedAt: { type: Date, default: null },

    // Optional profile
    bio: { type: String, default: "", trim: true, maxlength: 20_000 },
    about: { type: String, default: "", trim: true, maxlength: 20_000 },
    availability: { type: String, default: "Available Now", trim: true, maxlength: 200 },
    availabilityDetails: {
      type: availabilityDetailsSchema,
      default: () => ({ status: "available", nextAvailable: null, updatedAt: null }),
    },
    avatarURL: { type: String, default: "", trim: true },
    profileImage: { type: String, default: null },
    profileImageKey: { type: String, default: "", trim: true, select: false },
    profileImageOriginal: { type: String, default: "", trim: true },
    profileImageOriginalKey: { type: String, default: "", trim: true, select: false },
    pendingProfileImage: { type: String, default: "", trim: true },
    pendingProfileImageKey: { type: String, default: "", trim: true, select: false },
    pendingProfileImageOriginal: { type: String, default: "", trim: true },
    pendingProfileImageOriginalKey: { type: String, default: "", trim: true, select: false },
    profilePhotoStatus: {
      type: String,
      enum: ["unsubmitted", "pending_review", "approved", "rejected"],
      default: "unsubmitted",
      index: true,
    },
    lawFirm: { type: String, default: "", trim: true, maxlength: 300 },
    firmWebsite: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
      validate: {
        validator: (value) => normalizeHttpUrl(value, { fieldLabel: "Firm website" }).ok,
        message: "Firm website must be a valid HTTP(S) URL without embedded credentials.",
      },
    },
    state: { type: String, default: "", trim: true, maxlength: 120 },
    timezone: { type: String, default: "America/New_York", trim: true },
    location: { type: String, default: "", trim: true }, // City, State
    practiceAreas: { type: [String], default: [], set: uniqueStrings },
    primaryPracticeArea: { type: String, default: "", trim: true, maxlength: 200 },
    preferredPracticeAreas: { type: [String], default: [], set: uniqueStrings },
    collaborationStyle: { type: String, default: "", trim: true, maxlength: 500 },

    // Expertise (improves browse/search)
    bestFor: { type: [String], default: [], set: uniqueStrings },
    specialties: { type: [String], default: [], set: uniqueStrings },
    jurisdictions: { type: [String], default: [], set: uniqueStrings },
    stateExperience: { type: [String], default: [], set: uniqueStrings },
    skills: { type: [String], default: [], set: uniqueStrings },
    yearsExperience: { type: Number, min: 0, max: 80, default: 0 },
    languages: { type: [languageEntrySchema], default: [], set: sanitizeLanguageEntries },
    writingSamples: { type: [writingSampleSchema], default: [] },
    experience: { type: [experienceEntrySchema], default: [] },
    education: { type: [educationEntrySchema], default: [] },
    publications: { type: [String], default: [], set: uniqueStrings },

    // Security / housekeeping
    termsAccepted: { type: Boolean, default: false },
    termsVersion: { type: String, default: "", trim: true, maxlength: 32 },
    termsAcceptedAt: { type: Date, default: null },
    privacyVersion: { type: String, default: "", trim: true, maxlength: 32 },
    privacyAcknowledgedAt: { type: Date, default: null },
    legalAcceptanceSource: {
      type: String,
      enum: ["signup", "reacceptance"],
      default: undefined,
    },
    attorneyPricingAccepted: { type: Boolean, default: false },
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
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorMethod: {
      type: String,
      enum: ["authenticator", "sms", "email"],
      default: "email",
    },
    twoFactorTempCode: { type: String, default: null, select: false },
    twoFactorExpiresAt: { type: Date, default: null, select: false },
    twoFactorChallengeHash: { type: String, default: null, select: false, index: true },
    twoFactorFailedAttempts: { type: Number, default: 0, select: false },
    twoFactorBackupCodes: { type: [String], default: [], select: false },
    totpSecretEncrypted: { type: String, default: null, select: false },
    totpLastUsedTimeStep: { type: Number, default: null, select: false },
    authProviders: {
      type: [providerIdentitySchema],
      default: [],
      select: false,
    },
    blockedUsers: {
      type: [{ type: Types.ObjectId, ref: "User" }],
      default: [],
    },

    // KYC / payouts (non-sensitive markers; do NOT store secrets)
    kycStatus: { type: String, enum: KYC_STATUS, default: "unverified", index: true },
    stripeCustomerId: { type: String, default: null, index: true },
    stripeAccountId: { type: String, default: null, index: true }, // for Connect payouts
    stripeOnboarded: { type: Boolean, default: false },
    stripeChargesEnabled: { type: Boolean, default: false },
    stripePayoutsEnabled: { type: Boolean, default: false },

    // Notifications
    notifications: { type: notificationPrefsSchema, default: () => ({}) },
    notificationPrefs: { type: notificationSettingsSchema, default: () => ({}) },
    preferences: {
      theme: {
        type: String,
        enum: ["light", "dark", "mountain", "mountain-dark"],
        default: "mountain",
      },
      fontSize: {
        type: String,
        enum: ["xs", "sm", "md", "lg", "xl"],
        default: "md",
      },
      hideProfile: { type: Boolean, default: false },
      dashboardViews: { type: [dashboardSavedViewSchema], default: [] },
    },
    onboarding: { type: onboardingSchema, default: () => ({}) },
    pendingHire: { type: pendingHireSchema, default: null },
    digestFrequency: { type: String, enum: ["off", "daily", "weekly"], default: "daily" },
    emailPref: {
      marketing: { type: Boolean, default: true },
      product: { type: Boolean, default: true },
    },

    // Audit trail of admin actions
    audit: { type: [auditEntrySchema], default: [] },

    // Soft-delete
    deleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    personalDataStatus: {
      type: String,
      enum: ["active", "minimized"],
      default: "active",
      index: true,
    },
    personalDataMinimizedAt: { type: Date, default: null },
    linkedInURL: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
      validate: {
        validator: (value) =>
          normalizeHttpUrl(value, { fieldLabel: "LinkedIn URL", requiredHost: "linkedin.com" }).ok,
        message: "LinkedIn URL must be a valid linkedin.com HTTP(S) URL without embedded credentials.",
      },
    },
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
        delete ret.authVersion;
        delete ret.resetPasswordTokenHash;
        delete ret.resetPasswordExpiresAt;
        delete ret.resetPasswordRequestedAt;
        delete ret.twoFactorTempCode;
        delete ret.twoFactorChallengeHash;
        delete ret.twoFactorFailedAttempts;
        delete ret.twoFactorBackupCodes;
        delete ret.totpSecretEncrypted;
        delete ret.totpLastUsedTimeStep;
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
  { "authProviders.provider": 1, "authProviders.providerAccountId": 1 },
  {
    name: "user_auth_provider_unique",
    unique: true,
    partialFilterExpression: {
      "authProviders.providerAccountId": { $type: "string" },
    },
  }
);
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
userSchema.pre("validate", function () {
  if (this.email) this.email = String(this.email).trim().toLowerCase();
  if (this.firstName) this.firstName = String(this.firstName).trim();
  if (this.lastName) this.lastName = String(this.lastName).trim();
});

// Hash password on create/update
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const raw = this.password;
  if (isArgon2Hash(raw) || isBcryptHash(raw)) return;
  this.password = await argon2.hash(normalizePassword(raw), ARGON2_OPTIONS);
});

/** ----------------------------------------
 * Methods
 * -----------------------------------------*/
userSchema.methods.comparePassword = async function (plain) {
  // password field is select:false by default; ensure it's loaded when calling this
  const hash = this.password;
  if (!hash || !plain) return false;
  const candidate = normalizePassword(plain);
  if (isArgon2Hash(hash)) {
    return argon2.verify(hash, candidate);
  }
  if (isBcryptHash(hash)) {
    const ok = await bcrypt.compare(candidate, hash);
    if (ok) this._passwordNeedsRehash = true;
    return ok;
  }
  return false;
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
