const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  userRole: { type: String, default: "" },
  type: { type: String, required: true }, // e.g., "message", "case_invite"
  message: { type: String, default: "" },
  link: { type: String, default: "" },
  payload: { type: Object, default: {} }, // flexible metadata
  read: { type: Boolean, default: false },
  isRead: { type: Boolean, default: false },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  actorFirstName: { type: String, default: "" },
  actorProfileImage: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});

NotificationSchema.index({ userId: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model("Notification", NotificationSchema);
