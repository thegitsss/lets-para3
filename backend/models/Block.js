const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const blockSchema = new Schema({
  blockerId: {
    type: Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  blockedId: {
    type: Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  reason: { type: String, trim: true, maxlength: 2000, default: "" },
  createdAt: { type: Date, default: Date.now },
});

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

module.exports = mongoose.model("Block", blockSchema);
