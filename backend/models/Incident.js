const mongoose = require("mongoose");

const {
  INCIDENT_SOURCES,
  INCIDENT_REPORTER_ROLES,
  INCIDENT_SURFACES,
  INCIDENT_STATES,
  INCIDENT_TERMINAL_STATES,
  INCIDENT_DOMAINS,
  INCIDENT_SEVERITIES,
  INCIDENT_RISK_LEVELS,
  INCIDENT_CONFIDENCE_LEVELS,
  INCIDENT_APPROVAL_STATES,
  INCIDENT_AUTONOMY_MODES,
  INCIDENT_USER_VISIBLE_STATUSES,
  INCIDENT_ADMIN_VISIBLE_STATUSES,
  INCIDENT_JOB_TYPES,
  INCIDENT_RESOLUTION_CODES,
  INCIDENT_RISK_FLAG_KEYS,
} = require("../utils/incidentConstants");

const { Schema, Types } = mongoose;

const reporterSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", default: null },
    role: {
      type: String,
      enum: INCIDENT_REPORTER_ROLES,
      required: true,
      default: "system",
      immutable: true,
    },
    email: { type: String, trim: true, lowercase: true, default: "" },
    accessTokenHash: { type: String, trim: true, default: "" },
    accessTokenIssuedAt: { type: Date, default: null },
  },
  { _id: false, strict: true }
);

const contextSchema = new Schema(
  {
    surface: {
      type: String,
      enum: INCIDENT_SURFACES,
      required: true,
      default: "system",
      immutable: true,
    },
    pageUrl: { type: String, trim: true, default: "" },
    featureKey: { type: String, trim: true, default: "" },
    caseId: { type: Types.ObjectId, ref: "Case", default: null },
    jobId: { type: Types.ObjectId, ref: "Job", default: null },
    applicationId: { type: Types.ObjectId, ref: "Application", default: null },
    browser: { type: String, trim: true, default: "" },
    device: { type: String, trim: true, default: "" },
    routePath: { type: String, trim: true, default: "" },
  },
  { _id: false, strict: true }
);

const riskFlagsShape = INCIDENT_RISK_FLAG_KEYS.reduce((acc, key) => {
  acc[key] = { type: Boolean, default: false };
  return acc;
}, {});

const riskFlagsSchema = new Schema(riskFlagsShape, { _id: false, strict: true });

const classificationSchema = new Schema(
  {
    domain: {
      type: String,
      enum: INCIDENT_DOMAINS,
      required: true,
      default: "unknown",
    },
    severity: {
      type: String,
      enum: INCIDENT_SEVERITIES,
      required: true,
      default: "low",
    },
    riskLevel: {
      type: String,
      enum: INCIDENT_RISK_LEVELS,
      required: true,
      default: "low",
    },
    confidence: {
      type: String,
      enum: INCIDENT_CONFIDENCE_LEVELS,
      required: true,
      default: "low",
    },
    issueFingerprint: { type: String, trim: true, default: "" },
    clusterKey: { type: String, trim: true, default: "" },
    riskFlags: { type: riskFlagsSchema, default: () => ({}) },
    suspectedRoutes: { type: [String], default: [] },
    suspectedFiles: { type: [String], default: [] },
  },
  { _id: false, strict: true }
);

const stageAttemptsSchema = new Schema(
  {
    intakeValidation: { type: Number, default: 0, min: 0 },
    classification: { type: Number, default: 0, min: 0 },
    investigation: { type: Number, default: 0, min: 0 },
    patchPlanning: { type: Number, default: 0, min: 0 },
    patchExecution: { type: Number, default: 0, min: 0 },
    verification: { type: Number, default: 0, min: 0 },
    deployment: { type: Number, default: 0, min: 0 },
    postDeployVerification: { type: Number, default: 0, min: 0 },
    rollback: { type: Number, default: 0, min: 0 },
    notifications: { type: Number, default: 0, min: 0 },
  },
  { _id: false, strict: true }
);

const orchestrationSchema = new Schema(
  {
    nextJobType: {
      type: String,
      enum: INCIDENT_JOB_TYPES,
      required: true,
      default: "none",
    },
    nextJobRunAt: { type: Date, required: true, default: Date.now },
    stageAttempts: { type: stageAttemptsSchema, default: () => ({}) },
    lockToken: { type: String, trim: true, default: "" },
    lockOwner: { type: String, trim: true, default: "" },
    lockExpiresAt: { type: Date, default: null },
    lastWorkerAt: { type: Date, default: null },
  },
  { _id: false, strict: true }
);

const resolutionSchema = new Schema(
  {
    code: { type: String, enum: INCIDENT_RESOLUTION_CODES, default: null },
    summary: { type: String, trim: true, default: "" },
    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { _id: false, strict: true }
);

// Write-once expectations that are not fully schema-enforced remain service-layer concerns.
const incidentSchema = new Schema(
  {
    publicId: { type: String, required: true, trim: true, unique: true, immutable: true },
    source: {
      type: String,
      enum: INCIDENT_SOURCES,
      required: true,
      immutable: true,
    },
    reporter: { type: reporterSchema, default: () => ({}) },
    context: { type: contextSchema, default: () => ({}) },
    summary: { type: String, required: true, trim: true },
    originalReportText: { type: String, required: true, immutable: true },
    state: {
      type: String,
      enum: INCIDENT_STATES,
      required: true,
      default: "reported",
    },
    classification: { type: classificationSchema, default: () => ({}) },
    approvalState: {
      type: String,
      enum: INCIDENT_APPROVAL_STATES,
      required: true,
      default: "not_needed",
    },
    autonomyMode: {
      type: String,
      enum: INCIDENT_AUTONOMY_MODES,
      required: true,
      default: "full_auto",
    },
    userVisibleStatus: {
      type: String,
      enum: INCIDENT_USER_VISIBLE_STATUSES,
      required: true,
      default: "received",
    },
    adminVisibleStatus: {
      type: String,
      enum: INCIDENT_ADMIN_VISIBLE_STATUSES,
      required: true,
      default: "new",
    },
    orchestration: { type: orchestrationSchema, default: () => ({}) },
    lastEventSeq: { type: Number, required: true, default: 0, min: 0 },
    duplicateOfIncidentId: { type: Types.ObjectId, ref: "Incident", default: null },
    currentInvestigationId: { type: Types.ObjectId, ref: "IncidentInvestigation", default: null },
    currentPatchId: { type: Types.ObjectId, ref: "IncidentPatch", default: null },
    currentVerificationId: { type: Types.ObjectId, ref: "IncidentVerification", default: null },
    currentReleaseId: { type: Types.ObjectId, ref: "IncidentRelease", default: null },
    currentApprovalId: { type: Types.ObjectId, ref: "IncidentApproval", default: null },
    latestNotificationId: { type: Types.ObjectId, ref: "IncidentNotification", default: null },
    resolution: { type: resolutionSchema, default: () => ({}) },
  },
  {
    collection: "incidents",
    strict: true,
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

incidentSchema.pre("save", async function captureLpcIncidentState(next) {
  this.$locals = this.$locals || {};
  this.$locals.lpcWasNew = this.isNew;
  this.$locals.lpcPreviousState = "";

  if (!this.isNew && this.isModified("state")) {
    const previous = await this.constructor.findById(this._id).select("state").lean();
    this.$locals.lpcPreviousState = String(previous?.state || "");
  }

  next();
});

incidentSchema.post("save", async function publishLpcIncidentEvents(doc) {
  const { publishEventSafe } = require("../services/lpcEvents/publishEventService");
  const previousState = String(this.$locals?.lpcPreviousState || "");
  const isTerminal = INCIDENT_TERMINAL_STATES.includes(String(doc.state || ""));
  const wasTerminal = INCIDENT_TERMINAL_STATES.includes(previousState);

  if (this.$locals?.lpcWasNew !== true && isTerminal && !wasTerminal) {
    await publishEventSafe({
      eventType: "incident.resolved",
      eventFamily: "incident",
      idempotencyKey: `incident:${doc._id}:resolved:${doc.state}`,
      correlationId: `incident:${doc._id}`,
      actor: {
        actorType: "system",
        userId: doc.reporter?.userId || null,
        role: doc.reporter?.role || "",
        email: doc.reporter?.email || "",
      },
      subject: {
        entityType: "incident",
        entityId: String(doc._id),
        publicId: doc.publicId || "",
      },
      related: {
        userId: doc.reporter?.userId || null,
        caseId: doc.context?.caseId || null,
        jobId: doc.context?.jobId || null,
        applicationId: doc.context?.applicationId || null,
        incidentId: doc._id,
      },
      source: {
        surface: doc.context?.surface || "system",
        route: doc.context?.routePath || "",
        service: "incidents",
        producer: "service",
      },
      facts: {
        summary: doc.resolution?.summary || doc.summary || "",
        before: {
          state: previousState,
        },
        after: {
          state: doc.state || "",
          publicId: doc.publicId || "",
          resolutionCode: doc.resolution?.code || "",
          routePath: doc.context?.routePath || "",
        },
      },
      signals: {
        confidence: doc.classification?.confidence || "medium",
        priority: doc.classification?.riskLevel === "high" ? "high" : "normal",
        moneyRisk: doc.classification?.riskFlags?.affectsMoney === true,
        authRisk: doc.classification?.riskFlags?.affectsAuth === true,
        caseProgressRisk: doc.classification?.riskFlags?.affectsCaseProgress === true,
      },
    });
  }
});

incidentSchema.index({ state: 1, updatedAt: -1 });
incidentSchema.index({ "classification.riskLevel": 1, state: 1, updatedAt: -1 });
incidentSchema.index({ approvalState: 1, state: 1, updatedAt: -1 });
incidentSchema.index({ "classification.clusterKey": 1, state: 1, createdAt: -1 });
incidentSchema.index({ "reporter.userId": 1, createdAt: -1 });
incidentSchema.index({ "context.caseId": 1, createdAt: -1 });
incidentSchema.index({ "context.jobId": 1, createdAt: -1 });
incidentSchema.index({ "orchestration.nextJobType": 1, "orchestration.nextJobRunAt": 1 });

module.exports = mongoose.models.Incident || mongoose.model("Incident", incidentSchema);
