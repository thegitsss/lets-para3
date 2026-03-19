const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const platformIncomeSchema = new Schema(
  {
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true, unique: true },
    attorneyId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    paralegalId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    feeAmount: { type: Number, required: true, min: 0 },
    stripeMode: { type: String, enum: ["live", "test", "unknown"], default: "unknown", index: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

module.exports = mongoose.model("PlatformIncome", platformIncomeSchema);
