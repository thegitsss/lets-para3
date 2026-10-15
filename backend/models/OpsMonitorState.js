const mongoose = require("mongoose");

const { Schema } = mongoose;

const opsMonitorStateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: "platform" },
    ok: { type: Boolean, required: true },
    fingerprint: { type: String, default: "", maxlength: 8000 },
    checkedAt: { type: Date, required: true },
    noticeRevision: { type: String, default: null },
    noticeKind: { type: String, enum: ["failure", "recovery", "fatal", null], default: null },
    noticeRequestedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model("OpsMonitorState", opsMonitorStateSchema);
