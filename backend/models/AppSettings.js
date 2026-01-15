const mongoose = require("mongoose");

const { Schema } = mongoose;

const appSettingsSchema = new Schema(
  {
    allowSignups: { type: Boolean, default: true },
    maintenanceMode: { type: Boolean, default: false },
    supportEmail: { type: String, default: "", trim: true, maxlength: 320 },
    taxRate: { type: Number, default: 0.22, min: 0, max: 1 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("AppSettings", appSettingsSchema);
