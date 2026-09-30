const Case = require("../models/Case");
const { publishCaseEvent } = require("./caseEvents");
const { publishMatterDiscoveryEvent } = require("./matterDiscoveryEvents");
const { publishNotificationEvent } = require("./notificationEvents");

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id || value.id || "");
  return String(value);
}

function pairMemberFilter(field, firstId, secondId) {
  return { [field]: { $in: [firstId, secondId] } };
}

// Blocking and unblocking are intentionally private. These are opaque cache
// invalidation signals only; they do not create Notification records or email.
async function publishInteractionAccessRefresh({ requesterId, targetId, sourceCaseId = null }) {
  const ids = [normalizeId(requesterId), normalizeId(targetId)].filter(Boolean);
  if (ids.length !== 2) return;
  const at = new Date().toISOString();
  ids.forEach((userId) => {
    publishNotificationEvent(userId, "notifications", { at, type: "authorization_refresh" });
  });
  publishMatterDiscoveryEvent("matter_visibility_refresh");

  const pairCases = await Case.find({
    $or: [
      {
        $and: [
          { $or: [pairMemberFilter("attorney", ids[0], ids[1]), pairMemberFilter("attorneyId", ids[0], ids[1])] },
          { $or: [pairMemberFilter("paralegal", ids[0], ids[1]), pairMemberFilter("paralegalId", ids[0], ids[1])] },
        ],
      },
      { _id: sourceCaseId || null },
    ],
  }).select("_id").lean();
  pairCases.forEach((caseDoc) => {
    publishCaseEvent(caseDoc._id, "case", { at, type: "authorization_refresh" });
  });
}

module.exports = { publishInteractionAccessRefresh };
