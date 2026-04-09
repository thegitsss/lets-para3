const mongoose = require("mongoose");

const { Schema } = mongoose;

const SALES_ACCOUNT_STATUSES = ["active", "archived"];
const SALES_ACCOUNT_SOURCE_TYPES = ["manual", "public_contact", "waitlist_signal", "linked_user"];
const SALES_AUDIENCE_TYPES = ["attorney", "paralegal", "firm", "general"];

const salesAccountSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 240 },
    companyName: { type: String, trim: true, default: "", maxlength: 240 },
    primaryEmail: { type: String, trim: true, lowercase: true, default: "", maxlength: 320, index: true },
    audienceType: { type: String, enum: SALES_AUDIENCE_TYPES, default: "general", index: true },
    roleLabel: { type: String, trim: true, default: "", maxlength: 120 },
    status: { type: String, enum: SALES_ACCOUNT_STATUSES, default: "active", index: true },
    sourceType: { type: String, enum: SALES_ACCOUNT_SOURCE_TYPES, default: "manual", index: true },
    sourceFingerprint: { type: String, trim: true, default: "", maxlength: 320 },
    linkedUserId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    accountSummary: { type: String, trim: true, default: "", maxlength: 4000 },
    notes: { type: String, trim: true, default: "", maxlength: 8000 },
    tags: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "sales_accounts",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

salesAccountSchema.index(
  { sourceFingerprint: 1 },
  { unique: true, partialFilterExpression: { sourceFingerprint: { $type: "string", $ne: "" } } }
);
salesAccountSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.models.SalesAccount || mongoose.model("SalesAccount", salesAccountSchema);
