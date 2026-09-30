const mongoose = require("mongoose");
const { Schema } = mongoose;
// Private retained evidence. Public responses must use the removal service's
// explicit shape; stored document keys and earlier metadata are never sent.
const schema = new Schema({
  caseId: { type: Schema.Types.ObjectId, required: true, index: true },
  fileId: { type: Schema.Types.ObjectId, required: true },
  ownerId: { type: Schema.Types.ObjectId, required: true },
  requestId: { type: String, required: true },
  reviewedRevision: { type: String, required: true, select: false },
  snapshot: { type: Schema.Types.Mixed, required: true, select: false },
  removedMirrors: { type: [Schema.Types.Mixed], default: [], select: false },
  retirementIds: { type: [Schema.Types.ObjectId], default: [] },
  storageNeedsReview: { type: Boolean, default: false },
  removedAt: { type: Date, required: true },
}, { timestamps: true, minimize: false });
schema.index({ caseId: 1, fileId: 1 }, { unique: true });
schema.index({ ownerId: 1, requestId: 1 }, { unique: true });
module.exports = mongoose.model("MatterFileRemoval", schema);
