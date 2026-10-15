const mongoose = require("mongoose");

const storageDeletionTaskSchema = new mongoose.Schema(
  {
    bucket: { type: String, required: true, trim: true, maxlength: 255 },
    key: { type: String, required: true, trim: true, maxlength: 500 },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    reason: { type: String, required: true, trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ["held", "pending", "processing", "retrying", "blocked", "deleted", "cancelled"],
      default: "held",
      index: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    eligibleAt: { type: Date, required: true, index: true },
    lockedAt: { type: Date, default: null },
    lockToken: { type: String, default: "", trim: true, maxlength: 100 },
    lastErrorCode: { type: String, default: "", trim: true, maxlength: 160 },
    deletedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: { expires: 0 } },
  },
  { timestamps: true }
);

storageDeletionTaskSchema.index({ bucket: 1, key: 1 }, { unique: true });
storageDeletionTaskSchema.index({ status: 1, eligibleAt: 1, lockedAt: 1 });

module.exports =
  mongoose.models.StorageDeletionTask ||
  mongoose.model("StorageDeletionTask", storageDeletionTaskSchema);
