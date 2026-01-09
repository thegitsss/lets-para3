const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const platformIncomeSchema = new Schema(
  {
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true, unique: true },
    attorneyId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    paralegalId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    feeAmount: { type: Number, required: true, min: 0 },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

module.exports = mongoose.model("PlatformIncome", platformIncomeSchema);
