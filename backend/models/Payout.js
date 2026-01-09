const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const payoutSchema = new Schema(
  {
    paralegalId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true, unique: true },
    amountPaid: { type: Number, required: true, min: 0 },
    transferId: { type: String, required: true, trim: true, index: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

module.exports = mongoose.model("Payout", payoutSchema);
