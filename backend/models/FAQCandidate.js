const mongoose = require("mongoose");

const { FAQ_CANDIDATE_STATES } = require("../services/support/constants");
const { KNOWLEDGE_AUDIENCE_SCOPES } = require("../services/knowledge/constants");

const { Schema } = mongoose;

const citationSchema = new Schema(
  {
    sourceKey: { type: String, trim: true, default: "" },
    label: { type: String, trim: true, default: "", maxlength: 240 },
    filePath: { type: String, trim: true, default: "" },
    excerpt: { type: String, trim: true, default: "", maxlength: 4000 },
    locator: { type: String, trim: true, default: "", maxlength: 240 },
  },
  { _id: false, strict: true }
);

const faqCandidateSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    question: { type: String, required: true, trim: true, maxlength: 2000 },
    draftAnswer: { type: String, trim: true, default: "", maxlength: 12000 },
    summary: { type: String, trim: true, default: "", maxlength: 2000 },
    approvalState: { type: String, enum: FAQ_CANDIDATE_STATES, default: "pending_review", index: true },
    patternKey: { type: String, trim: true, default: "", index: true },
    category: { type: String, trim: true, default: "", maxlength: 120 },
    audienceScopes: {
      type: [String],
      enum: KNOWLEDGE_AUDIENCE_SCOPES,
      default: ["support_safe", "public_approved"],
    },
    repeatCount: { type: Number, min: 1, default: 1 },
    sourceTicketIds: { type: [Schema.Types.ObjectId], ref: "SupportTicket", default: [] },
    sourceIncidentIds: { type: [Schema.Types.ObjectId], ref: "Incident", default: [] },
    citations: { type: [citationSchema], default: [] },
    ownerLabel: { type: String, trim: true, default: "Samantha", maxlength: 120 },
    latestEvidenceAt: { type: Date, default: null },
  },
  {
    collection: "faq_candidates",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

faqCandidateSchema.index({ approvalState: 1, updatedAt: -1 });

module.exports = mongoose.models.FAQCandidate || mongoose.model("FAQCandidate", faqCandidateSchema);
