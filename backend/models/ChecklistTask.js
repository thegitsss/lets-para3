const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const checklistTaskSchema = new Schema(
  {
    owner: { type: Types.ObjectId, ref: "User", required: true, index: true },
    caseId: { type: Types.ObjectId, ref: "Case", default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    notes: { type: String, default: "", trim: true, maxlength: 4000 },
    due: { type: Date, default: null, index: true },
    done: { type: Boolean, default: false, index: true },
    completedAt: { type: Date, default: null },
    completedBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

checklistTaskSchema.index({ owner: 1, done: 1, due: 1 });
checklistTaskSchema.index({ owner: 1, caseId: 1, createdAt: -1 });

checklistTaskSchema.methods.markDone = function markDone(actorId, now = new Date()) {
  this.done = true;
  this.completedAt = now;
  this.completedBy = actorId || null;
};

checklistTaskSchema.methods.markUndone = function markUndone() {
  this.done = false;
  this.completedAt = null;
  this.completedBy = null;
};

module.exports = mongoose.model("ChecklistTask", checklistTaskSchema);
