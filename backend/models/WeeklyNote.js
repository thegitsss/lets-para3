const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const weeklyNoteSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    weekStart: { type: Date, required: true, index: true },
    calendarWeek: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    revision: { type: Number, default: 0, min: 0 },
    notes: { type: [String], default: () => Array(7).fill("") },
  },
  { timestamps: true, versionKey: false }
);

weeklyNoteSchema.index({ userId: 1, weekStart: 1 }, { unique: true });
weeklyNoteSchema.index({ userId: 1, calendarWeek: 1 }, { unique: true, partialFilterExpression: { calendarWeek: { $type: "string" } } });

module.exports = mongoose.model("WeeklyNote", weeklyNoteSchema);
