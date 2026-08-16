const mongoose = require("mongoose");

const WebVitalSampleSchema = new mongoose.Schema(
  {
    metric: { type: String, enum: ["CLS", "INP", "LCP"], required: true, index: true },
    value: { type: Number, required: true, min: 0 },
    rating: { type: String, enum: ["good", "needs-improvement", "poor"], required: true },
    page: { type: String, required: true, maxlength: 200, index: true },
    deviceClass: { type: String, enum: ["mobile", "desktop"], required: true, index: true },
    navigationType: { type: String, maxlength: 40, default: "navigate" },
    connectionType: { type: String, maxlength: 20, default: "unknown" },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

WebVitalSampleSchema.index({ createdAt: 1 }, { expireAfterSeconds: 35 * 24 * 60 * 60 });
WebVitalSampleSchema.index({ createdAt: -1, metric: 1, page: 1, deviceClass: 1 });

module.exports = mongoose.model("WebVitalSample", WebVitalSampleSchema);
