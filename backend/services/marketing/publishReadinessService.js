const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const MarketingPublishIntent = require("../../models/MarketingPublishIntent");
const { getChannelConnection, getChannelReadinessSummary } = require("./channelConnectionService");
const { listPublishHistoryForPacket } = require("./publishAttemptService");
const { buildPublishText } = require("./linkedinPublisher");

function buildReadinessResponse({
  packet,
  blockers = [],
  connection = null,
  inFlightIntent = null,
  publishedIntent = null,
} = {}) {
  const readinessStatus = blockers.length ? "blocked" : "ready";
  const publishText = buildPublishText(packet);
  return {
    status: readinessStatus,
    isReady: blockers.length === 0,
    channelKey: packet?.channelKey || "",
    workflowType: packet?.workflowType || "",
    blockers,
    publishText,
    publishTextLength: publishText.length,
    connection,
    inFlightIntent: inFlightIntent
      ? {
          id: String(inFlightIntent._id),
          status: inFlightIntent.status,
          createdAt: inFlightIntent.createdAt || null,
        }
      : null,
    publishedIntent: publishedIntent
      ? {
          id: String(publishedIntent._id),
          status: publishedIntent.status,
          publishedAt: publishedIntent.publishedAt || null,
          providerResourceUrn: publishedIntent.providerResourceUrn || "",
          permalink: publishedIntent.permalink || "",
        }
      : null,
  };
}

async function getPacketPublishReadiness({ packetId = "" } = {}) {
  const packet = await MarketingDraftPacket.findById(packetId).lean();
  if (!packet) {
    const error = new Error("Marketing draft packet not found.");
    error.statusCode = 404;
    throw error;
  }

  const blockers = [];
  let connection = await getChannelConnection(packet.channelKey || "linkedin_company");
  let inFlightIntent = null;
  let publishedIntent = null;

  if (packet.workflowType !== "linkedin_company_post" || packet.channelKey !== "linkedin_company") {
    blockers.push("Publish execution is only implemented for approved LinkedIn company packets in Phase 2.");
    connection = await getChannelReadinessSummary(packet.channelKey || "");
    return buildReadinessResponse({ packet, blockers, connection });
  }

  if (packet.approvalState !== "approved") {
    blockers.push("Packet must be approved before it can be published.");
  }

  if (connection.status !== "connected_validated") {
    blockers.push(connection.lastValidationNote || "LinkedIn company connection is not ready.");
  }

  const publishText = buildPublishText(packet);
  if (!publishText) {
    blockers.push("Packet does not contain publishable LinkedIn company copy.");
  } else if (publishText.length > 3000) {
    blockers.push("LinkedIn company publish copy exceeds the current 3000 character limit.");
  }

  [inFlightIntent, publishedIntent] = await Promise.all([
    MarketingPublishIntent.findOne({
      packetId: packet._id,
      channelKey: "linkedin_company",
      status: { $in: ["queued", "publishing"] },
    })
      .sort({ createdAt: -1 })
      .lean(),
    MarketingPublishIntent.findOne({
      packetId: packet._id,
      channelKey: "linkedin_company",
      status: "published",
    })
      .sort({ publishedAt: -1, createdAt: -1 })
      .lean(),
  ]);

  if (inFlightIntent) {
    blockers.push("A LinkedIn company publish is already in progress for this packet.");
  }
  if (publishedIntent) {
    blockers.push("This packet has already been published to LinkedIn company.");
  }

  return buildReadinessResponse({
    packet,
    blockers,
    connection,
    inFlightIntent,
    publishedIntent,
  });
}

async function getPacketPublishingContext({ packetId = "" } = {}) {
  const packet = await MarketingDraftPacket.findById(packetId).lean();
  if (!packet) {
    const error = new Error("Marketing draft packet not found.");
    error.statusCode = 404;
    throw error;
  }

  const [publishReadiness, publishHistory] = await Promise.all([
    getPacketPublishReadiness({ packetId }),
    listPublishHistoryForPacket(packetId),
  ]);

  return {
    packet: {
      ...packet,
      id: String(packet._id),
      publishReadiness,
      publishHistory,
    },
  };
}

module.exports = {
  getPacketPublishReadiness,
  getPacketPublishingContext,
};
