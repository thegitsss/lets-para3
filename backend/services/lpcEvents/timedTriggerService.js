const User = require("../../models/User");
const KnowledgeItem = require("../../models/KnowledgeItem");
const { publishEvent } = require("./publishEventService");

const PROFILE_INCOMPLETE_WINDOW_HOURS = Number(process.env.LPC_PROFILE_INCOMPLETE_WINDOW_HOURS || 24);

function buildAdmissionsMissingFields(user = {}) {
  const role = String(user.role || "").toLowerCase();
  const missing = [];
  if (!user.emailVerified) missing.push("email verification");
  if (!user.termsAccepted) missing.push("accepted terms");

  if (role === "attorney") {
    if (!String(user.barNumber || "").trim()) missing.push("bar number");
    if (!String(user.state || "").trim()) missing.push("licensed state");
    if (!String(user.lawFirm || "").trim() && !String(user.firmWebsite || "").trim()) {
      missing.push("firm identity");
    }
  }

  if (role === "paralegal") {
    if (!String(user.resumeURL || "").trim()) missing.push("resume");
    if (!String(user.certificateURL || "").trim()) missing.push("certificate");
    if (!Number.isFinite(Number(user.yearsExperience)) || Number(user.yearsExperience) <= 0) {
      missing.push("experience history");
    }
  }

  return missing;
}

function hoursSince(value) {
  if (!value) return 0;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (60 * 60 * 1000)));
}

async function emitIncompleteProfileWindowEvents() {
  const users = await User.find({
    role: { $in: ["attorney", "paralegal"] },
    status: "pending",
    deleted: { $ne: true },
    disabled: { $ne: true },
  })
    .select("email role status createdAt emailVerified termsAccepted barNumber lawFirm firmWebsite state resumeURL certificateURL yearsExperience")
    .lean();

  const emitted = [];
  for (const user of users) {
    const missingFields = buildAdmissionsMissingFields(user);
    const ageHours = hoursSince(user.createdAt);
    if (!missingFields.length || ageHours < PROFILE_INCOMPLETE_WINDOW_HOURS) continue;

    const idempotencyKey = `user:${user._id}:profile-incomplete-window-elapsed`;
    const { event, created } = await publishEvent(
      {
        eventType: "user.profile.incomplete_window_elapsed",
        eventFamily: "timed_trigger",
        idempotencyKey,
        correlationId: `user:${user._id}`,
        actor: { actorType: "system", role: "system", label: "Timed Trigger Service" },
        subject: {
          entityType: "user",
          entityId: String(user._id),
        },
        related: {
          userId: user._id,
        },
        source: {
          surface: "system",
          route: "",
          service: "lifecycle",
          producer: "scheduler",
        },
        facts: {
          summary: `${user.email || "Pending user"} is still missing required profile fields after the follow-up window elapsed.`,
          missingFields,
          ageHours,
          after: {
            email: user.email || "",
            role: user.role || "",
            status: user.status || "",
          },
        },
        signals: {
          confidence: "high",
          priority: ageHours >= 72 ? "high" : "normal",
          founderVisible: false,
        },
      },
      { routeNow: true }
    );

    if (created && event?._id) emitted.push(String(event._id));
  }

  return { emittedCount: emitted.length, eventIds: emitted };
}

async function emitKnowledgeStaleDueEvents() {
  const items = await KnowledgeItem.find({
    isActive: true,
    nextReviewAt: { $ne: null, $lte: new Date() },
  })
    .select("title approvalState audienceScopes nextReviewAt ownerLabel")
    .lean();

  const emitted = [];
  for (const item of items) {
    const dueKey = item.nextReviewAt ? new Date(item.nextReviewAt).toISOString().slice(0, 10) : "unknown";
    const { event, created } = await publishEvent(
      {
        eventType: "knowledge.item.stale_due",
        eventFamily: "knowledge",
        idempotencyKey: `knowledge-item:${item._id}:stale-due:${dueKey}`,
        correlationId: `knowledge:${item._id}`,
        actor: { actorType: "system", role: "system", label: "Timed Trigger Service" },
        subject: {
          entityType: "knowledge_item",
          entityId: String(item._id),
        },
        related: {
          knowledgeItemId: item._id,
        },
        source: {
          surface: "system",
          route: "",
          service: "knowledge",
          producer: "scheduler",
        },
        facts: {
          title: item.title || "Knowledge item",
          summary: `${item.title || "Knowledge item"} is due for review.`,
          approvalState: item.approvalState || "",
          audienceScopes: item.audienceScopes || [],
          nextReviewAt: item.nextReviewAt || null,
          ownerLabel: item.ownerLabel || "Samantha",
          after: {
            approvalState: item.approvalState || "",
            audienceScopes: item.audienceScopes || [],
            nextReviewAt: item.nextReviewAt || null,
            ownerLabel: item.ownerLabel || "Samantha",
          },
        },
        signals: {
          confidence: "high",
          priority: (item.audienceScopes || []).includes("public_approved") ? "high" : "normal",
          founderVisible: (item.audienceScopes || []).includes("public_approved"),
          publicFacing: (item.audienceScopes || []).includes("public_approved"),
        },
      },
      { routeNow: true }
    );

    if (created && event?._id) emitted.push(String(event._id));
  }

  return { emittedCount: emitted.length, eventIds: emitted };
}

async function runTimedTriggers() {
  const incompleteProfiles = await emitIncompleteProfileWindowEvents();
  const knowledgeStale = await emitKnowledgeStaleDueEvents();
  return {
    ok: true,
    incompleteProfiles,
    knowledgeStale,
  };
}

module.exports = {
  PROFILE_INCOMPLETE_WINDOW_HOURS,
  buildAdmissionsMissingFields,
  emitIncompleteProfileWindowEvents,
  emitKnowledgeStaleDueEvents,
  runTimedTriggers,
};
