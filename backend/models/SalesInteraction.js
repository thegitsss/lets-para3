const mongoose = require("mongoose");

const { Schema } = mongoose;

const SALES_INTERACTION_TYPES = [
  "public_contact_signal",
  "waitlist_signal",
  "manual_note",
  "call_note",
  "email_note",
  "objection_note",
  "meeting_note",
];

const SALES_INTERACTION_DIRECTIONS = ["inbound", "outbound", "internal"];

const salesInteractionSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: "SalesAccount", required: true, index: true },
    interactionType: { type: String, enum: SALES_INTERACTION_TYPES, default: "manual_note", index: true },
    direction: { type: String, enum: SALES_INTERACTION_DIRECTIONS, default: "internal", index: true },
    summary: { type: String, required: true, trim: true, maxlength: 2000 },
    rawText: { type: String, trim: true, default: "", maxlength: 12000 },
    objections: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "sales_interactions",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

salesInteractionSchema.index({ accountId: 1, createdAt: -1 });

module.exports = mongoose.models.SalesInteraction || mongoose.model("SalesInteraction", salesInteractionSchema);
