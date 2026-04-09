const MarketingBrief = require("../../models/MarketingBrief");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const { serializeConnection, getChannelConnectionDoc } = require("./channelConnectionService");
const { buildIntentSnapshot } = require("./publishService");
const { getPacketPublishReadiness } = require("./publishReadinessService");

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "user",
    userId: actor.userId || actor._id || actor.id || null,
    label: actor.label || actor.email || "Admin",
  };
}

function buildChecks({ packet = {}, readiness = {}, connection = null } = {}) {
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
  const hasBlocker = (pattern) => blockers.some((entry) => pattern.test(String(entry || "")));

  return [
    {
      key: "approval",
      label: "Approved packet",
      ok: packet.approvalState === "approved" && !hasBlocker(/approved before it can be published/i),
    },
    {
      key: "connection",
      label: "Validated LinkedIn company connection",
      ok: connection?.status === "connected_validated" && !hasBlocker(/connection is not ready|not validated/i),
    },
    {
      key: "copy",
      label: "Publishable LinkedIn copy",
      ok: Boolean(readiness.publishText) && Number(readiness.publishTextLength || 0) <= 3000,
    },
    {
      key: "duplicate",
      label: "No in-flight or published duplicate",
      ok: !hasBlocker(/already in progress|already been published/i),
    },
  ];
}

async function simulatePacketPublish({ packetId = "", actor = {} } = {}) {
  const [packet, readiness] = await Promise.all([
    MarketingDraftPacket.findById(packetId).lean(),
    getPacketPublishReadiness({ packetId }),
  ]);

  if (!packet) {
    const error = new Error("Marketing draft packet not found.");
    error.statusCode = 404;
    throw error;
  }

  const [brief, connectionDoc] = await Promise.all([
    MarketingBrief.findById(packet.briefId).lean(),
    getChannelConnectionDoc(packet.channelKey || "linkedin_company", { includeSecret: false }),
  ]);

  const connection = connectionDoc ? serializeConnection(connectionDoc, { includeSecret: false }) : readiness.connection;
  const checks = buildChecks({ packet, readiness, connection });
  const wouldPublish = readiness.isReady === true;

  return {
    dryRunOnly: true,
    simulatedAt: new Date().toISOString(),
    actor: toActor(actor),
    status: wouldPublish ? "ready" : "blocked",
    wouldPublish,
    blockers: readiness.blockers || [],
    checks,
    readiness,
    executionPlan: wouldPublish
      ? {
          provider: "linkedin",
          channelKey: packet.channelKey || "",
          workflowType: packet.workflowType || "",
          endpoint: "https://api.linkedin.com/rest/posts",
          organizationUrn: connection?.organizationUrn || "",
          apiVersion: connection?.apiVersion || "202503",
          publishTextLength: readiness.publishTextLength || 0,
        }
      : null,
    simulatedIntent: buildIntentSnapshot({ packet, brief }),
  };
}

module.exports = {
  simulatePacketPublish,
};
