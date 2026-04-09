const FAQCandidate = require("../../models/FAQCandidate");
const Incident = require("../../models/Incident");
const SupportTicket = require("../../models/SupportTicket");
const { ensureFAQCandidateApprovalTask } = require("./reviewService");
const { compactText, uniqueStrings } = require("./shared");

function normalizeReply(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function buildQuestionFromGroup(group = {}) {
  const category = String(group.category || "support").replace(/_/g, " ");
  const sample = group.subjects.find(Boolean);
  if (sample) return compactText(sample, 180).replace(/\?*$/, "?");
  return `What should support say about ${category}?`;
}

function buildTitleFromGroup(group = {}) {
  const category = String(group.category || "support").replace(/_/g, " ");
  return compactText(`FAQ candidate: ${category}`, 120);
}

function buildAnswerFromGroup(group = {}) {
  const replies = group.tickets
    .map((ticket) => ticket.latestResponsePacket?.recommendedReply)
    .filter(Boolean);
  if (replies.length) return replies[0];
  return "Review the linked tickets and approved knowledge before promoting this to a public-facing FAQ.";
}

function hasStableSupportSafeAnswerPath(group = {}) {
  const replies = (group.tickets || [])
    .map((ticket) => ticket.latestResponsePacket?.recommendedReply)
    .map(normalizeReply)
    .filter(Boolean);
  if (!replies.length) return false;

  const uniqueReplies = uniqueStrings(replies);
  if (uniqueReplies.length > 1) return false;

  return (group.tickets || []).some(
    (ticket) =>
      (ticket.latestResponsePacket?.citations || []).length > 0 ||
      (ticket.classification?.matchedKnowledgeKeys || []).length > 0
  );
}

async function generateFAQCandidates() {
  const resolvedTickets = await SupportTicket.find({
    status: { $in: ["resolved", "closed"] },
    resolutionIsStable: true,
    "classification.patternKey": { $ne: "" },
  })
    .sort({ resolvedAt: -1, updatedAt: -1 })
    .lean();

  const groups = new Map();
  for (const ticket of resolvedTickets) {
    const key = ticket.classification?.patternKey;
    if (!key) continue;
    const existing = groups.get(key) || {
      key,
      category: ticket.classification?.category || "general_support",
      tickets: [],
      ticketIds: [],
      incidentIds: [],
      citations: [],
      subjects: [],
      latestEvidenceAt: ticket.resolvedAt || ticket.updatedAt || ticket.createdAt,
    };
    existing.tickets.push(ticket);
    existing.ticketIds.push(ticket._id);
    existing.incidentIds.push(...(ticket.linkedIncidentIds || []));
    existing.citations.push(...(ticket.latestResponsePacket?.citations || []));
    existing.subjects.push(ticket.subject);
    const latest = ticket.resolvedAt || ticket.updatedAt || ticket.createdAt;
    if (latest && (!existing.latestEvidenceAt || latest > existing.latestEvidenceAt)) {
      existing.latestEvidenceAt = latest;
    }
    groups.set(key, existing);
  }

  const createdOrUpdated = [];
  for (const group of groups.values()) {
    if (group.ticketIds.length < 2) continue;
    if (!hasStableSupportSafeAnswerPath(group)) continue;

    const openIncidentCount = await Incident.countDocuments({
      _id: { $in: uniqueStrings(group.incidentIds.map(String)) },
      state: { $nin: ["resolved", "closed_duplicate", "closed_no_repro", "closed_not_actionable", "closed_rejected", "closed_rolled_back"] },
    });
    if (openIncidentCount > 0) continue;

    const candidate = await FAQCandidate.findOneAndUpdate(
      { key: `faq__${group.key}` },
      {
        $set: {
          title: buildTitleFromGroup(group),
          question: buildQuestionFromGroup(group),
          draftAnswer: buildAnswerFromGroup(group),
          summary: `${group.ticketIds.length} stable resolved tickets point to the same support-safe explanation.`,
          approvalState: "pending_review",
          patternKey: group.key,
          category: group.category,
          repeatCount: group.ticketIds.length,
          sourceTicketIds: uniqueStrings(group.ticketIds.map(String)),
          sourceIncidentIds: uniqueStrings(group.incidentIds.map(String)),
          citations: uniqueStrings(group.citations.map((citation) => JSON.stringify(citation))).map((citation) =>
            JSON.parse(citation)
          ),
          latestEvidenceAt: group.latestEvidenceAt || new Date(),
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    await ensureFAQCandidateApprovalTask(candidate, {
      actorType: "system",
      label: "FAQ Candidate Service",
    });

    createdOrUpdated.push(candidate);
  }

  return createdOrUpdated;
}

async function listFAQCandidates({ approvalState, limit = 50 } = {}) {
  const query = {};
  if (approvalState) query.approvalState = approvalState;
  return FAQCandidate.find(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 50)))
    .lean();
}

module.exports = {
  generateFAQCandidates,
  listFAQCandidates,
};
