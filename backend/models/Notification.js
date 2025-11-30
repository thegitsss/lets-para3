// backend/models/Notification.js
const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const notificationSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    caseId: { type: Types.ObjectId, ref: "Case", default: null },
    messageId: { type: Types.ObjectId, ref: "Message", default: null },
    title: { type: String, trim: true, maxlength: 300 },
    body: { type: String, trim: true, maxlength: 2000 },
    type: { type: String, trim: true, default: "system", maxlength: 60 },
    meta: { type: Schema.Types.Mixed, default: null },
    read: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

module.exports = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
