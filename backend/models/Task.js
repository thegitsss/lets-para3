// backend/models/Task.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

/** ----------------------------------------
 * Enums & helpers
 * -----------------------------------------*/
const PRIORITIES = ["low", "normal", "high", "urgent"];
const REMINDER_METHODS = ["email", "push", "none"];

function clampDate(d) {
  return d ? new Date(d) : d;
}

/** ----------------------------------------
 * Subschemas
 * -----------------------------------------*/
const checklistItemSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 500 },
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
    doneBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  { _id: true }
);

const reminderSchema = new Schema(
  {
    minutesBefore: { type: Number, min: 0, max: 60 * 24 * 14, default: 60 }, // up to 14 days early
    method: { type: String, enum: REMINDER_METHODS, default: "email" },
  },
  { _id: false }
);

/** ----------------------------------------
 * Main schema
 * -----------------------------------------*/
const taskSchema = new Schema(
  {
    title:  { type: String, required: true, trim: true, maxlength: 200 },
    notes:  { type: String, default: "", trim: true, maxlength: 20_000 },

    // Dates & completion
    due:    { type: Date, default: null },
    done:   { type: Boolean, default: false },
    completedAt: { type: Date, default: null },

    // Ownership / relations
    owner:  { type: Types.ObjectId, ref: "User", required: true, index: true }, // creator
    assignee: { type: Types.ObjectId, ref: "User", default: null, index: true }, // who should do it (can be same as owner)
    caseId: { type: Types.ObjectId, ref: "Case", default: null, index: true },

    // Organization
    priority: { type: String, enum: PRIORITIES, default: "normal", index: true },
    labels:   { type: [String], default: [], set: arr => [...new Set((arr || []).map(s => String(s).trim()).filter(Boolean))] },
    order:    { type: Number, default: 0 }, // for manual sorting in a list

    // Checklists & reminders
    checklist: { type: [checklistItemSchema], default: [] },
    reminders: { type: [reminderSchema], default: [] },

    // Soft delete & pinning (nice for UI)
    pinned: { type: Boolean, default: false, index: true },
    deleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    minimize: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/** ----------------------------------------
 * Indexes
 * -----------------------------------------*/
taskSchema.index({ owner: 1, done: 1, due: 1 });
taskSchema.index({ assignee: 1, done: 1, due: 1 });
taskSchema.index({ caseId: 1, due: 1 });
taskSchema.index({ priority: 1, due: 1 });
// quick text search
taskSchema.index({ title: "text", notes: "text", labels: "text" }, { name: "task_text_idx" });

/** ----------------------------------------
 * Virtuals
 * -----------------------------------------*/
taskSchema.virtual("isOverdue").get(function () {
  return Boolean(this.due && !this.done && new Date() > this.due);
});
taskSchema.virtual("isToday").get(function () {
  if (!this.due) return false;
  const now = new Date();
  const due = new Date(this.due);
  return (
    now.getFullYear() === due.getFullYear() &&
    now.getMonth() === due.getMonth() &&
    now.getDate() === due.getDate()
  );
});

/** ----------------------------------------
 * Validation & Hooks
 * -----------------------------------------*/
taskSchema.pre("validate", function (next) {
  this.due = clampDate(this.due);
  // If toggled done without timestamp, set it
  if (this.done && !this.completedAt) this.completedAt = new Date();
  // If marked not done, clear completedAt
  if (!this.done) this.completedAt = null;
  next();
});

/** ----------------------------------------
 * Methods (ergonomics)
 * -----------------------------------------*/
taskSchema.methods.markDone = function (byUserId, at = new Date()) {
  this.done = true;
  this.completedAt = at;
  // Also close all checklist items if they exist
  if (Array.isArray(this.checklist)) {
    this.checklist = this.checklist.map(item => ({
      ...item.toObject?.() ?? item,
      done: true,
      doneAt: item.done ? item.doneAt || at : at,
      doneBy: item.doneBy || byUserId || this.assignee || this.owner,
    }));
  }
  return this;
};

taskSchema.methods.markUndone = function () {
  this.done = false;
  this.completedAt = null;
  return this;
};

taskSchema.methods.addChecklistItem = function (label) {
  if (!label || !String(label).trim()) return this;
  this.checklist.push({ label: String(label).trim() });
  return this;
};

taskSchema.methods.toggleChecklistItem = function (itemId, byUserId, when = new Date()) {
  const item = (this.checklist || []).id(itemId);
  if (!item) return this;
  item.done = !item.done;
  item.doneAt = item.done ? when : null;
  item.doneBy = item.done ? (byUserId || this.assignee || this.owner) : null;
  return this;
};

taskSchema.methods.addLabel = function (label) {
  const val = String(label || "").trim();
  if (!val) return this;
  if (!this.labels.includes(val)) this.labels.push(val);
  return this;
};

taskSchema.methods.addReminder = function (minutesBefore = 60, method = "email") {
  this.reminders.push({ minutesBefore, method });
  return this;
};

module.exports = mongoose.model("Task", taskSchema);
