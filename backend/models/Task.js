const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const TASK_STATUS_IN_PROGRESS = "in progress";
const TASK_STATUS_ENUM = ["todo", TASK_STATUS_IN_PROGRESS, "in_progress", "review"];

const taskSchema = new Schema(
  {
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true },
    paralegalId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, default: "", trim: true, maxlength: 5000 },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: TASK_STATUS_ENUM, default: "todo", index: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

taskSchema.pre("validate", function (next) {
  if (typeof this.status === "string") {
    const normalized = this.status.trim().toLowerCase();
    if (normalized === "in_progress") {
      this.status = TASK_STATUS_IN_PROGRESS;
    } else if (normalized === TASK_STATUS_IN_PROGRESS || TASK_STATUS_ENUM.includes(normalized)) {
      this.status = normalized;
    }
  }
  next();
});

module.exports = mongoose.model("Task", taskSchema);
