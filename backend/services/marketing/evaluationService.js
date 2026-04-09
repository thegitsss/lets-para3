const MarketingBrief = require("../../models/MarketingBrief");
const MarketingEvaluation = require("../../models/MarketingEvaluation");

function compactText(value = "", max = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function uniqueList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => compactText(value, 500))
        .filter(Boolean)
    )
  );
}

function laneLabel(contentLane = "") {
  if (contentLane === "standards_positioning") return "standards / positioning";
  if (contentLane === "updates_momentum") return "updates / momentum";
  return "platform explanation";
}

function noteSignals(note = "") {
  const text = String(note || "").toLowerCase();
  return {
    vague: /\b(vague|generic|thin|unclear|bland|too broad)\b/.test(text),
    hype: /\b(hype|hyped|overclaim|overstated|too strong|too salesy|too promotional)\b/.test(text),
    cta: /\b(cta|call to action|follow|ask)\b/.test(text),
    facts: /\b(fact|specific|concrete|evidence|grounded)\b/.test(text),
  };
}

function scoreForOutcome(decision = "", note = "") {
  const signals = noteSignals(note);
  if (decision === "approved") {
    return signals.facts ? 80 : 70;
  }
  let score = -55;
  if (signals.vague) score -= 10;
  if (signals.hype) score -= 10;
  return Math.max(-100, score);
}

function findingsForOutcome({ packet = {}, brief = {}, decision = "", note = "" } = {}) {
  const findings = [
    `Outcome: ${decision}.`,
    `Workflow: ${packet.workflowType || brief.workflowType || "marketing draft"}.`,
  ];
  if (packet.contentLane) findings.push(`Lane: ${laneLabel(packet.contentLane)}.`);
  if (note) findings.push(`Reviewer note: ${compactText(note, 400)}.`);
  return uniqueList(findings);
}

function recommendationsForOutcome({ packet = {}, decision = "", note = "" } = {}) {
  const signals = noteSignals(note);
  const recommendations = [];

  if (decision === "approved") {
    recommendations.push(
      packet.contentLane
        ? `Keep using ${laneLabel(packet.contentLane)} when the Jr. CMO can support it with approved facts.`
        : "Keep using this pattern when the Jr. CMO can support it with approved facts."
    );
    if (packet.growthObjective) {
      recommendations.push(`Preserve the growth objective framing: ${compactText(packet.growthObjective, 220)}`);
    }
  } else {
    if (signals.vague || signals.facts) {
      recommendations.push("Future prompts should anchor the draft in 1-2 concrete approved facts before expanding the message.");
    }
    if (signals.hype) {
      recommendations.push("Future prompts should stay more restrained and avoid promotional or over-claiming language.");
    }
    if (signals.cta) {
      recommendations.push("Future prompts should keep the follow-oriented CTA softer and more grounded in why the page is worth returning to.");
    }
    if (!recommendations.length) {
      recommendations.push("Future prompts should tighten the hook, core message, and evidence before reattempting this topic.");
    }
  }

  if (packet.contentLane === "updates_momentum") {
    recommendations.push("Only use updates / momentum when there are at least two concrete, approved update facts.");
  }

  return uniqueList(recommendations).slice(0, 4);
}

async function recordPacketOutcomeEvaluation({ packet, brief = null, decision = "", note = "", actor = {}, decidedAt = new Date() } = {}) {
  if (!packet?._id) {
    throw new Error("Packet is required to record a marketing evaluation.");
  }

  const briefDoc = brief || (packet.briefId ? await MarketingBrief.findById(packet.briefId).lean() : null);
  const safeDecision = decision === "approved" ? "approved" : "rejected";
  const evaluationKey = `packet:${String(packet._id)}:v${Number(packet.packetVersion || 1)}:${safeDecision}`;
  const title = `Packet outcome · ${safeDecision} · ${packet.workflowType || "marketing draft"}`;
  const summary =
    safeDecision === "approved"
      ? "This packet cleared review and can inform future CMO planning."
      : "This packet was rejected and should inform tighter future prompting.";

  return MarketingEvaluation.findOneAndUpdate(
    { evaluationKey },
    {
      $set: {
        evaluationType: "packet_outcome",
        windowStartAt: packet.createdAt || null,
        windowEndAt: decidedAt,
        packetId: packet._id,
        briefId: briefDoc?._id || packet.briefId || null,
        workflowType: packet.workflowType || briefDoc?.workflowType || "",
        channelKey: packet.channelKey || briefDoc?.channelKey || "",
        contentLane: packet.contentLane || briefDoc?.contentLane || "",
        outcome: safeDecision,
        score: scoreForOutcome(safeDecision, note),
        decisionNote: compactText(note, 2000),
        title,
        summary,
        findings: findingsForOutcome({ packet, brief: briefDoc || {}, decision: safeDecision, note }),
        recommendations: recommendationsForOutcome({ packet, decision: safeDecision, note }),
        metadata: {
          actorLabel: actor?.label || "",
          packetVersion: Number(packet.packetVersion || 1),
          growthObjective: packet.growthObjective || "",
          whyThisHelpsPageGrowth: packet.whyThisHelpsPageGrowth || "",
        },
        status: "active",
        expiresAt: new Date(new Date(decidedAt).setDate(new Date(decidedAt).getDate() + 180)),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
}

function buildWeeklyEvaluation({ packets = [], outcomeEvaluations = [] } = {}) {
  const total = packets.length;
  const approved = packets.filter((packet) => packet.approvalState === "approved").length;
  const pending = packets.filter((packet) => packet.approvalState === "pending_review").length;
  const rejected = packets.filter((packet) => packet.approvalState === "rejected").length;
  const findings = [];
  const recommendations = [];

  const approvedOutcomes = outcomeEvaluations.filter((entry) => entry.outcome === "approved");
  const rejectedOutcomes = outcomeEvaluations.filter((entry) => entry.outcome === "rejected");
  const laneStats = outcomeEvaluations.reduce((acc, entry) => {
    const lane = entry.contentLane || "platform_explanation";
    acc[lane] = acc[lane] || { approved: 0, rejected: 0 };
    if (entry.outcome === "approved") acc[lane].approved += 1;
    if (entry.outcome === "rejected") acc[lane].rejected += 1;
    return acc;
  }, {});

  if (!total) {
    findings.push("No marketing packets were created during the current weekly window.");
    recommendations.push("Keep the Jr. CMO library current so the CMO can draft from fresher internal signals.");
  } else {
    findings.push(`${approved} approved, ${pending} pending review, and ${rejected} rejected packets were observed this week.`);
    if (pending > 0) {
      recommendations.push("Do not add more autonomous draft volume while Samantha still has pending marketing review work.");
    }
    if (approvedOutcomes.length) {
      const bestLane = Object.entries(laneStats)
        .sort((left, right) => right[1].approved - left[1].approved)[0]?.[0];
      if (bestLane && laneStats[bestLane]?.approved > 0) {
        recommendations.push(`Recent approvals favor ${laneLabel(bestLane)} when the support facts are strong.`);
      }
    }
    if (rejectedOutcomes.some((entry) => noteSignals(entry.decisionNote).vague || noteSignals(entry.decisionNote).facts)) {
      recommendations.push("Prompts that feel thin or generic should be rebuilt around concrete approved facts before they re-enter the queue.");
    }
    if (rejectedOutcomes.some((entry) => noteSignals(entry.decisionNote).hype)) {
      recommendations.push("Prompts that drift promotional should be rewritten in a more restrained, premium tone.");
    }
    if ((laneStats.updates_momentum?.rejected || 0) > (laneStats.updates_momentum?.approved || 0)) {
      recommendations.push("Updates / momentum should only run when there are at least two concrete, approved update facts.");
    }
    if (!recommendations.length) {
      recommendations.push("Keep rotating explanation and standards lanes while the queue quality remains stable.");
    }
  }

  findings.push(
    approvedOutcomes.length || rejectedOutcomes.length
      ? `${approvedOutcomes.length} packet outcome evaluations were positive and ${rejectedOutcomes.length} were negative this week.`
      : "No packet outcome evaluations were recorded during the current weekly window."
  );

  return {
    title: "Weekly Jr. CMO evaluation",
    summary: findings[0] || "Weekly marketing evaluation generated.",
    findings: uniqueList(findings).slice(0, 6),
    recommendations: uniqueList(recommendations).slice(0, 6),
  };
}

module.exports = {
  buildWeeklyEvaluation,
  recordPacketOutcomeEvaluation,
};
