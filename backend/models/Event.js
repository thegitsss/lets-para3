// backend/models/Event.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

/** ----------------------------------------
 * Enums & Helpers
 * -----------------------------------------*/
const EVENT_TYPES = ["deadline", "meeting", "call", "court", "misc"];
const REMINDER_METHODS = ["email", "push", "none"]; // adaptable to your notifier
const VISIBILITY = ["private", "case_team", "public"]; // access control hint
const ZOOM_REGEX = /^https:\/\/.*zoom\.us\/[^\s]+$/i;

function clampDate(d) {
  return d ? new Date(d) : d;
}

/** ----------------------------------------
 * Subschemas
 * -----------------------------------------*/
const attendeeSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: "User" }, // optional for guests
    name: { type: String, trim: true, maxlength: 300 }, // fallback label for external attendees
    email: { type: String, trim: true, lowercase: true, maxlength: 320 },
    response: { type: String, enum: ["needsAction", "accepted", "declined", "tentative"], default: "needsAction" },
    role: { type: String, enum: ["attorney", "paralegal", "admin", "guest"], default: "guest" },
    required: { type: Boolean, default: true },
  },
  { _id: false }
);

const reminderSchema = new Schema(
  {
    minutesBefore: { type: Number, min: 0, max: 60 * 24 * 14, default: 30 }, // up to 14 days early
    method: { type: String, enum: REMINDER_METHODS, default: "email" },
  },
  { _id: false }
);

/** ----------------------------------------
 * Main schema
 * -----------------------------------------*/
const eventSchema = new Schema(
  {
    title:   { type: String, required: true, trim: true, maxlength: 500 },
    start:   { type: Date, required: true },
    end:     { type: Date }, // optional; defaults to = start in hook
    isAllDay:{ type: Boolean, default: false },

    type:    { type: String, enum: EVENT_TYPES, default: "misc", index: true },
    where:   { type: String, default: "", trim: true, maxlength: 2000 }, // zoom link or location
    notes:   { type: String, trim: true, maxlength: 20_000 },

    // Case linkage (for auto-sharing with case participants)
    caseId:  { type: Types.ObjectId, ref: "Case", default: null, index: true },

    // Ownership & visibility
    owner:   { type: Types.ObjectId, ref: "User", required: true, index: true }, // creator
    visibility: { type: String, enum: VISIBILITY, default: "private", index: true },

    // Timezone & recurrence (minimal viable)
    timezone: { type: String, default: "UTC", trim: true }, // e.g. "America/New_York"
    rrule: { type: String, trim: true, default: "" }, // RFC5545 RRULE string if you add recurrence later

    // Attendees & reminders
    attendees: { type: [attendeeSchema], default: [] },
    reminders: { type: [reminderSchema], default: [] },

    // System bookkeeping
    source: { type: String, enum: ["user", "system"], default: "user", index: true },
    color:  { type: String, trim: true, default: "" }, // allow UI-color tagging (e.g., "#8c7864")
  },
  { timestamps: true, versionKey: false, minimize: false }
);

/** ----------------------------------------
 * Indexes
 * -----------------------------------------*/
eventSchema.index({ owner: 1, start: 1 });
eventSchema.index({ caseId: 1, start: 1 });
eventSchema.index({ type: 1, start: 1 });
eventSchema.index({ visibility: 1, start: 1 });
// Lightweight text search for quick find
eventSchema.index({ title: "text", where: "text", notes: "text" }, { name: "event_text_idx" });

/** ----------------------------------------
 * Virtuals
 * -----------------------------------------*/
eventSchema.virtual("durationMinutes").get(function () {
  if (!this.start) return 0;
  const end = this.end || this.start;
  return Math.max(0, Math.round((end - this.start) / 60000));
});

/** ----------------------------------------
 * Validation & Hooks
 * -----------------------------------------*/
eventSchema.pre("validate", function (next) {
  // Normalize dates
  this.start = clampDate(this.start);
  this.end = clampDate(this.end);

  // Default end to start for single-point events
  if (!this.end) this.end = this.start;

  // end >= start
  if (this.end < this.start) {
    return next(new Error("Event 'end' must be greater than or equal to 'start'."));
  }

  // If where looks like a zoom link, validate it
  if (this.where && this.where.includes("zoom.us") && !ZOOM_REGEX.test(this.where)) {
    return next(new Error("If specifying a Zoom link, it must be a valid https://*.zoom.us/... URL."));
  }

  // Basic all-day normalization (optional: keep times as-is but mark flag)
  if (this.isAllDay) {
    // Convention: represent all-day as start 00:00 and end 23:59:59 in its timezone (left as-is here)
    // You can transform in the controller when rendering to clients.
  }

  next();
});

/** ----------------------------------------
 * Methods (developer ergonomics)
 * -----------------------------------------*/
eventSchema.methods.addAttendee = function (att) {
  this.attendees = this.attendees || [];
  // Basic de-dup by user/email
  const key = (att.user && String(att.user)) || (att.email && att.email.toLowerCase());
  const exists = this.attendees.some(a =>
    (a.user && key && String(a.user) === key) ||
    (a.email && key && a.email.toLowerCase() === key)
  );
  if (exists) return this;
  this.attendees.push(att);
  return this;
};

eventSchema.methods.addReminder = function (minutesBefore = 30, method = "email") {
  this.reminders = this.reminders || [];
  this.reminders.push({ minutesBefore, method });
  return this;
};

eventSchema.methods.overlaps = function (start, end) {
  const s = new Date(start);
  const e = new Date(end || start);
  const aStart = this.start;
  const aEnd = this.end || this.start;
  return aStart < e && s < aEnd;
};

module.exports = mongoose.model("Event", eventSchema);
