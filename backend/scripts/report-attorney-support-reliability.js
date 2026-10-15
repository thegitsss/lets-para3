const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const SupportConversation = require("../models/SupportConversation");
const SupportMessage = require("../models/SupportMessage");
const {
  SUPPORT_TELEMETRY_RETENTION_DAYS,
  buildSyntheticAttorneyReliabilityMessages,
  getAttorneySupportOperationalMode,
  summarizeAttorneyReliability,
} = require("../services/support/attorneyReliabilityService");
const {
  evaluateAttorneyRolloutStageGate,
} = require("../services/support/attorneyRolloutService");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");

const MAX_REPORT_RECORDS = Math.max(
  100,
  Math.min(50_000, Number(process.env.SUPPORT_RELIABILITY_MAX_RECORDS || 10_000))
);

const RELIABILITY_PROJECTION = [
  "_id",
  "conversationId",
  "createdAt",
  "metadata.provider",
  "metadata.feedback.rating",
  "metadata.reliability",
  "metadata.telemetry.managerAvailable",
  "metadata.telemetry.latencyMs",
  "metadata.telemetry.rollout.contractVersion",
  "metadata.telemetry.rollout.rolloutStage",
  "metadata.telemetry.rollout.rolloutPercent",
  "metadata.telemetry.rollout.rolloutBucket",
  "metadata.telemetry.rollout.enrollmentReason",
  "metadata.telemetry.toolCalls.name",
  "metadata.telemetry.toolCalls.capabilityId",
  "metadata.telemetry.toolCalls.ok",
  "metadata.telemetry.toolCalls.evidenceState",
  "metadata.telemetry.toolCalls.failureClass",
  "metadata.telemetry.toolCalls.durationMs",
].join(" ");

function parseOptions(argv = process.argv.slice(2)) {
  const requestedDays = Number(argv.find((arg) => /^--days=\d+$/.test(arg))?.split("=")[1] || 30);
  const value = (name) => String(argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || "").trim();
  const openIncidents = value("open-incidents");
  return {
    days: Math.max(1, Math.min(requestedDays, SUPPORT_TELEMETRY_RETENTION_DAYS)),
    synthetic: argv.includes("--synthetic"),
    stage: value("stage").toLowerCase(),
    since: value("since"),
    completedStageIds: value("completed-stages").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    openIncidentCount: openIncidents && Number.isFinite(Number(openIncidents)) && Number(openIncidents) >= 0
      ? Number(openIncidents)
      : null,
    curatedAcceptancePassed: argv.includes("--curated-acceptance-passed"),
    package7Passed: argv.includes("--package7-passed"),
    productOwnerConfirmed: argv.includes("--product-owner-confirmed"),
    releaseOwner: value("release-owner"),
    technicalOwner: value("technical-owner"),
    enforceStageGate: argv.includes("--enforce-stage-gate"),
  };
}

async function loadMessages({ days, since = "" }) {
  const sinceDate = since ? new Date(since) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(sinceDate.getTime())) throw new Error("--since must be a valid ISO-8601 date-time.");
  await mongoose.connect(requireMongoUri(process.env.MONGO_URI), MONGO_OPERATION_OPTIONS);
  const conversations = await SupportConversation.find({ role: "attorney", updatedAt: { $gte: sinceDate } })
    .select("_id")
    .sort({ _id: 1 })
    .limit(MAX_REPORT_RECORDS + 1)
    .lean();
  if (conversations.length > MAX_REPORT_RECORDS) {
    throw new Error(`Attorney reliability report exceeds ${MAX_REPORT_RECORDS} conversations; use a narrower --since window.`);
  }
  const conversationIds = conversations.map((conversation) => conversation._id);
  if (!conversationIds.length) return [];
  const messages = await SupportMessage.find({
    conversationId: { $in: conversationIds },
    sender: "assistant",
    createdAt: { $gte: sinceDate },
  })
    .select(RELIABILITY_PROJECTION)
    .sort({ createdAt: 1, _id: 1 })
    .limit(MAX_REPORT_RECORDS + 1)
    .lean();
  if (messages.length > MAX_REPORT_RECORDS) {
    throw new Error(`Attorney reliability report exceeds ${MAX_REPORT_RECORDS} messages; use a narrower --since window.`);
  }
  return messages;
}

async function main() {
  const options = parseOptions();
  if (options.enforceStageGate && !options.stage) {
    throw new Error("--stage is required with --enforce-stage-gate.");
  }
  if (options.stage && !options.since) {
    throw new Error("--since is required when evaluating a rollout stage.");
  }
  const messages = options.synthetic
    ? buildSyntheticAttorneyReliabilityMessages()
    : await loadMessages(options);
  const report = summarizeAttorneyReliability(messages, {
    windowDays: options.days,
    operationalMode: getAttorneySupportOperationalMode(process.env),
  });
  const stageGate = options.stage
    ? evaluateAttorneyRolloutStageGate({
        stageId: options.stage,
        stageStartedAt: options.since,
        reliabilityReport: report,
        completedStageIds: options.completedStageIds,
        openIncidentCount: options.openIncidentCount,
        curatedAcceptancePassed: options.curatedAcceptancePassed,
        package7Passed: options.package7Passed,
        productOwnerConfirmed: options.productOwnerConfirmed,
        releaseOwner: options.releaseOwner,
        technicalOwner: options.technicalOwner,
      })
    : null;
  const output = {
    ...report,
    dataSource: options.synthetic ? "synthetic" : "production_read_only",
    projection: options.synthetic ? "synthetic_fixture" : RELIABILITY_PROJECTION,
    observation: options.stage ? { stageId: options.stage, startedAt: options.since } : null,
    stageGate,
  };
  console.log(JSON.stringify(output, null, 2));
  if (options.enforceStageGate && stageGate?.passed !== true) process.exitCode = 1;
  return output;
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  RELIABILITY_PROJECTION,
  loadMessages,
  main,
  parseOptions,
};
