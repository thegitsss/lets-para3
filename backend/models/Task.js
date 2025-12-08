const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const taskSchema = new Schema(
  {
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true },
    paralegalId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, default: "", trim: true, maxlength: 5000 },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: ["todo", "in_progress", "review"], default: "todo", index: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

module.exports = mongoose.model("Task", taskSchema);
