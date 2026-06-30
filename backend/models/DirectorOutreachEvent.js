const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const directorOutreachEventSchema = new Schema(
  {
    recordId: { type: Types.ObjectId, ref: "DirectorOutreachRecord", required: true, index: true },
    directorUserId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    directorEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    attorneyEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    eventType: {
      type: String,
      enum: ["outreach_sent", "follow_up_sent", "reply_received", "registration_matched", "matter_posted", "matter_completed", "commission_recorded"],
      required: true,
      index: true,
    },
    subject: { type: String, trim: true, default: "", maxlength: 300 },
    summary: { type: String, trim: true, default: "", maxlength: 2000 },
    provider: { type: String, trim: true, default: "zoho", maxlength: 60 },
    providerMessageId: { type: String, trim: true, default: "", maxlength: 240, index: true },
    providerThreadId: { type: String, trim: true, default: "", maxlength: 240, index: true },
    occurredAt: { type: Date, default: Date.now, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "director_outreach_events",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

directorOutreachEventSchema.index(
  { directorUserId: 1, providerMessageId: 1, eventType: 1 },
  {
    unique: true,
    partialFilterExpression: { providerMessageId: { $type: "string", $ne: "" } },
  }
);

module.exports =
  mongoose.models.DirectorOutreachEvent ||
  mongoose.model("DirectorOutreachEvent", directorOutreachEventSchema);
