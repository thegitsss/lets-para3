// backend/models/AuditLog.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const ROLE_ENUM = ["attorney", "paralegal", "admin", "system"];
const TARGET_ENUM = ["user", "case", "message", "payment", "dispute", "document", "other"];

const AuditLogSchema = new Schema(
  {
    // Who did it
    actor: { type: Types.ObjectId, ref: "User", required: false, index: true },
    actorRole: { type: String, enum: ROLE_ENUM, required: true },

    // What happened
    action: { type: String, required: true, index: true }, // e.g. "case.create", "case.status.update", "payment.intent.create"

    // What it was about (optional polymorphic target)
    targetType: { type: String, enum: TARGET_ENUM, default: "other", index: true },
    targetId: { type: Types.ObjectId, index: true },

    // Convenience link to a case if applicable (speeds up admin queries)
    case: { type: Types.ObjectId, ref: "Case", index: true },

    // Request context (optional but very useful)
    ip: { type: String },
    ua: { type: String },
    method: { type: String },
    path: { type: String },

    // Free-form extra data (kept minimal and safe; do NOT store secrets)
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false, // keep empty meta as {}
    toJSON: {
      transform: (_doc, ret) => {
        // present consistent ids
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  }
);

// Helpful indexes (tune later as data grows)
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ actor: 1, createdAt: -1 });
AuditLogSchema.index({ case: 1, createdAt: -1 });

// Simple helper to write logs from a request context
AuditLogSchema.statics.logFromReq = async function logFromReq(req, action, opts = {}) {
  const { targetType, targetId, caseId, meta } = opts;
  const actorId = req.user?.id || req.user?._id;
  const actorRole = req.user?.role || "system";

  return this.create({
    actor: actorId,
    actorRole,
    action,
    targetType: targetType || "other",
    targetId: targetId || undefined,
    case: caseId || undefined,
    ip: req.ip,
    ua: req.headers["user-agent"],
    method: req.method,
    path: req.originalUrl,
    meta: meta || {},
  });
};

module.exports = mongoose.model("AuditLog", AuditLogSchema);
