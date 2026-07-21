const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const OUTREACH_STAGES = Object.freeze([
  "outreach_sent",
  "attorney_registered",
  "follow_up_needed",
  "follow_up_sent",
  "follow_up_failed",
  "matter_posted",
  "matter_completed",
  "commission_complete",
  "founder_attention",
  "suppressed",
]);

const directorOutreachRecordSchema = new Schema(
  {
    directorUserId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    directorEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    attorneyEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    attorneyName: { type: String, trim: true, default: "", maxlength: 240 },
    firmName: { type: String, trim: true, default: "", maxlength: 240 },
    state: { type: String, trim: true, uppercase: true, default: "", maxlength: 2, index: true },
    stage: { type: String, enum: OUTREACH_STAGES, default: "outreach_sent", index: true },
    firstOutreachSentAt: { type: Date, default: null, index: true },
    followUpSentAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
    lastReplyAt: { type: Date, default: null, index: true },
    founderAttentionAt: { type: Date, default: null },
    registeredUserId: { type: Types.ObjectId, ref: "User", default: null, index: true },
    registeredAt: { type: Date, default: null },
    firstMatterPostedAt: { type: Date, default: null },
    firstMatterCompletedAt: { type: Date, default: null },
    commissionableMatterCount: { type: Number, min: 0, default: 0 },
    commissionEarnedCents: { type: Number, min: 0, default: 0 },
    commissionStatus: { type: String, enum: ["none", "accruing", "cap_reached"], default: "none", index: true },
    commissionPayoutStatus: { type: String, enum: ["unpaid", "paid"], default: "unpaid", index: true },
    commissionPaidAt: { type: Date, default: null },
    commissionPaidByAdminId: { type: Types.ObjectId, ref: "User", default: null },
    commissionPayoutNote: { type: String, trim: true, default: "", maxlength: 500 },
    source: { type: String, trim: true, default: "zoho_import", maxlength: 120 },
    suppressedAt: { type: Date, default: null },
    suppressedReason: { type: String, trim: true, default: "", maxlength: 500 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "director_outreach_records",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

directorOutreachRecordSchema.index({ directorUserId: 1, attorneyEmail: 1 }, { unique: true });
directorOutreachRecordSchema.index({ directorUserId: 1, state: 1, stage: 1, updatedAt: -1 });
directorOutreachRecordSchema.index({ stage: 1, founderAttentionAt: -1 });
directorOutreachRecordSchema.index({ commissionPayoutStatus: 1, commissionEarnedCents: -1, commissionPaidAt: -1 });

module.exports =
  mongoose.models.DirectorOutreachRecord ||
  mongoose.model("DirectorOutreachRecord", directorOutreachRecordSchema);
module.exports.OUTREACH_STAGES = OUTREACH_STAGES;
