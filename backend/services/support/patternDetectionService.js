const Incident = require("../../models/Incident");
const SupportInsight = require("../../models/SupportInsight");
const SupportTicket = require("../../models/SupportTicket");
const { pluralize, uniqueStrings } = require("./shared");

function insightTypeForCategory(category = "") {
  if (["payments_risk", "fees"].includes(category)) return "confusion_pattern";
  if (["admissions", "platform_explainer"].includes(category)) return "confusion_pattern";
  return "friction_pattern";
}

function titleForCategory(category = "") {
  const text = String(category || "support").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function refreshSupportInsights() {
  const tickets = await SupportTicket.find({
    "classification.patternKey": { $ne: "" },
    status: { $in: ["open", "in_review", "waiting_on_user", "waiting_on_info", "resolved", "closed"] },
  }).lean();

  const groups = new Map();
  for (const ticket of tickets) {
    const key = ticket.classification?.patternKey;
    if (!key) continue;
    const existing = groups.get(key) || {
      key,
      category: ticket.classification?.category || "general_support",
      tickets: [],
      ticketIds: [],
      incidentIds: [],
      roles: [],
      openCount: 0,
      latestSeenAt: ticket.updatedAt || ticket.createdAt || new Date(),
    };
    existing.tickets.push(ticket);
    existing.ticketIds.push(ticket._id);
    existing.incidentIds.push(...(ticket.linkedIncidentIds || []));
    existing.roles.push(ticket.requesterRole || "unknown");
    if (["open", "in_review", "waiting_on_user", "waiting_on_info"].includes(ticket.status)) {
      existing.openCount += 1;
    }
    const latest = ticket.updatedAt || ticket.createdAt || new Date();
    if (latest > existing.latestSeenAt) existing.latestSeenAt = latest;
    groups.set(key, existing);
  }

  const results = [];
  for (const group of groups.values()) {
    if (group.ticketIds.length < 2) continue;
    const incidentCount = await Incident.countDocuments({ _id: { $in: uniqueStrings(group.incidentIds.map(String)) } });
    const priority = group.openCount >= 2 || incidentCount > 0 ? "needs_review" : "watch";
    const insight = await SupportInsight.findOneAndUpdate(
      { patternKey: group.key, category: group.category },
      {
        $set: {
          insightType: insightTypeForCategory(group.category),
          title: `${titleForCategory(group.category)} signal`,
          summary: `${pluralize(group.ticketIds.length, "ticket")} show a repeated ${titleForCategory(group.category).toLowerCase()} theme${incidentCount ? ` with ${pluralize(incidentCount, "linked incident")}` : ""}.`,
          state: "active",
          repeatCount: group.ticketIds.length,
          affectedRoles: uniqueStrings(group.roles),
          sourceTicketIds: uniqueStrings(group.ticketIds.map(String)),
          sourceIncidentIds: uniqueStrings(group.incidentIds.map(String)),
          lastSeenAt: group.latestSeenAt || new Date(),
          priority,
        },
        $setOnInsert: {
          surfacedAt: new Date(),
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).lean();
    results.push(insight);
  }

  return results;
}

async function listSupportInsights({ limit = 20 } = {}) {
  return SupportInsight.find({ state: "active" })
    .sort({ priority: -1, updatedAt: -1, createdAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 20)))
    .lean();
}

module.exports = {
  listSupportInsights,
  refreshSupportInsights,
};
