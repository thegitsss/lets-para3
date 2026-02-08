const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const weeklyNoteSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    weekStart: { type: Date, required: true, index: true },
    notes: { type: [String], default: () => Array(7).fill("") },
  },
  { timestamps: true, versionKey: false }
);

weeklyNoteSchema.index({ userId: 1, weekStart: 1 }, { unique: true });

module.exports = mongoose.model("WeeklyNote", weeklyNoteSchema);
