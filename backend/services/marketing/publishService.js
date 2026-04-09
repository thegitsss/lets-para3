const MarketingBrief = require("../../models/MarketingBrief");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const MarketingPublishAttempt = require("../../models/MarketingPublishAttempt");
const MarketingPublishIntent = require("../../models/MarketingPublishIntent");
const { getChannelConnectionDoc, markConnectionPublishResult, serializeConnection } = require("./channelConnectionService");
const { publishLinkedInCompanyPost, buildPublishText } = require("./linkedinPublisher");
const { getPacketPublishReadiness } = require("./publishReadinessService");
const {
  createPublishAttempt,
  markPublishAttemptFailure,
  markPublishAttemptSuccess,
} = require("./publishAttemptService");

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "user",
    userId: actor.userId || actor._id || actor.id || null,
    label: actor.label || actor.email || "Admin",
  };
}

function buildIntentSnapshot({ packet, brief }) {
  const publishText = buildPublishText(packet);
  return {
    workflowType: packet.workflowType,
    channelKey: packet.channelKey,
    packetVersion: packet.packetVersion,
    briefId: String(packet.briefId),
    cycleId: brief?.cycleId ? String(brief.cycleId) : "",
    title: brief?.title || "",
    targetAudience: packet.targetAudience || "",
    packetSummary: packet.packetSummary || "",
    channelDraft: {
      channel: packet.channelDraft?.channel || "",
      format: packet.channelDraft?.format || "",
      openingHook: packet.channelDraft?.openingHook || "",
      body: packet.channelDraft?.body || "",
      closingCta: packet.channelDraft?.closingCta || "",
    },
    publishText,
  };
}

async function createPublishIntent({ packet, brief, connection, actor = {} } = {}) {
  return MarketingPublishIntent.create({
    packetId: packet._id,
    briefId: brief?._id || null,
    cycleId: brief?.cycleId || null,
    channelKey: packet.channelKey,
    provider: "linkedin",
    status: "queued",
    requestedBy: toActor(actor),
    publishSnapshot: buildIntentSnapshot({ packet, brief }),
    connectionSnapshot: {
      channelKey: connection.channelKey,
      provider: connection.provider,
      organizationId: connection.organizationId || "",
      organizationUrn: connection.organizationUrn || "",
      organizationName: connection.organizationName || "",
      apiVersion: connection.apiVersion || "202503",
      status: connection.status || "",
    },
  });
}

async function publishPacketNow({ packetId = "", actor = {} } = {}) {
  const packet = await MarketingDraftPacket.findById(packetId);
  if (!packet) {
    throw new Error("Marketing draft packet not found.");
  }

  const readiness = await getPacketPublishReadiness({ packetId });
  if (!readiness.isReady) {
    const error = new Error(readiness.blockers[0] || "Packet is not ready to publish.");
    error.statusCode = 409;
    error.readiness = readiness;
    throw error;
  }

  const [brief, connectionDoc] = await Promise.all([
    MarketingBrief.findById(packet.briefId).lean(),
    getChannelConnectionDoc("linkedin_company", { includeSecret: true }),
  ]);
  if (!connectionDoc) {
    const error = new Error("LinkedIn company connection is not configured.");
    error.statusCode = 409;
    throw error;
  }

  const connection = {
    ...serializeConnection(connectionDoc, { includeSecret: true }),
    accessToken: connectionDoc.accessToken || "",
  };

  const intent = await createPublishIntent({ packet, brief, connection, actor });
  intent.status = "publishing";
  await intent.save();

  const attempt = await createPublishAttempt({
    intent,
    packet,
    actor,
    requestSnapshot: {
      endpoint: "https://api.linkedin.com/rest/posts",
      provider: "linkedin",
      channelKey: packet.channelKey,
      publishText: buildPublishText(packet),
      apiVersion: connection.apiVersion || "202503",
      organizationUrn: connection.organizationUrn || (connection.organizationId ? `urn:li:organization:${connection.organizationId}` : ""),
    },
  });

  try {
    const providerResult = await publishLinkedInCompanyPost({
      connection,
      packet,
      intent,
    });

    await markPublishAttemptSuccess({
      attempt,
      intent,
      responseSnapshot: providerResult.responseSnapshot,
      providerResourceId: providerResult.providerResourceId,
      providerResourceUrn: providerResult.providerResourceUrn,
      permalink: providerResult.permalink,
    });
    await markConnectionPublishResult({ channelKey: "linkedin_company", success: true });

    return {
      intent: await MarketingPublishIntent.findById(intent._id).lean(),
      attempt: await MarketingPublishAttempt.findById(attempt._id).lean(),
      readiness: await getPacketPublishReadiness({ packetId }),
    };
  } catch (error) {
    const result = await markPublishAttemptFailure({
      attempt,
      intent,
      error,
      responseSnapshot: {
        status: Number(error?.statusCode || error?.response?.status || 0),
        data: error?.response?.data || {},
      },
    });
    await markConnectionPublishResult({
      channelKey: "linkedin_company",
      success: false,
      errorMessage: result.classified.message,
    });

    const failure = new Error(result.classified.message);
    failure.statusCode = result.classified.statusCode || 502;
    failure.intent = await MarketingPublishIntent.findById(intent._id).lean();
    failure.attempt = await MarketingPublishAttempt.findById(attempt._id).lean();
    failure.readiness = await getPacketPublishReadiness({ packetId });
    throw failure;
  }
}

module.exports = {
  buildIntentSnapshot,
  createPublishIntent,
  publishPacketNow,
};
