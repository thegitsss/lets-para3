const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const directorProfileSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
    zohoEmail: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true },
    displayName: { type: String, trim: true, default: "", maxlength: 160 },
    activeState: { type: String, trim: true, uppercase: true, default: "TX", maxlength: 2, index: true },
    status: { type: String, enum: ["active", "paused"], default: "active", index: true },
    commissionCapMatterCount: { type: Number, min: 1, default: 50 },
    commissionSharePctOfAttorneyFee: { type: Number, min: 0, max: 100, default: 50 },
    outreachSubject: { type: String, trim: true, default: "for matters that need an extra hand next", maxlength: 200 },
    outreachTemplateText: { type: String, default: "", maxlength: 20000 },
    outreachTemplateHtml: { type: String, default: "", maxlength: 150000 },
    notes: { type: String, trim: true, default: "", maxlength: 4000 },
  },
  {
    collection: "director_profiles",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

module.exports = mongoose.models.DirectorProfile || mongoose.model("DirectorProfile", directorProfileSchema);
