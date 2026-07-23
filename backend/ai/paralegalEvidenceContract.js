const PARALEGAL_EVIDENCE_CAPABILITIES = Object.freeze({
  CASE_OVERVIEW: "P01_assigned_overview",
  WORKSPACE: "P02_matter_details",
  APPLICATIONS: "P06_applications",
  INVITATIONS: "P08_invitations",
  ATTENTION: "P01_assigned_overview",
  PAYOUT_SETUP: "P14_payout_setup",
  PAYOUT_HISTORY: "P16_payout_history",
  MATTER_FINANCIALS: "P17_matter_financials",
  ACCOUNT: "P23_profile",
  DEACTIVATION: "P28_deactivation",
  WORKFLOW: "P21_completion_release",
  MESSAGES: "P13_message_activity",
  NAVIGATION: "P30_navigation",
  KNOWLEDGE: "P31_product_knowledge",
});

const TOOL_CAPABILITIES = Object.freeze({
  get_paralegal_case_overview: PARALEGAL_EVIDENCE_CAPABILITIES.CASE_OVERVIEW,
  get_paralegal_case_workspace: PARALEGAL_EVIDENCE_CAPABILITIES.WORKSPACE,
  get_paralegal_application_activity: PARALEGAL_EVIDENCE_CAPABILITIES.APPLICATIONS,
  get_paralegal_invitation_activity: PARALEGAL_EVIDENCE_CAPABILITIES.INVITATIONS,
  get_paralegal_attention_summary: PARALEGAL_EVIDENCE_CAPABILITIES.ATTENTION,
  get_paralegal_payout_setup: PARALEGAL_EVIDENCE_CAPABILITIES.PAYOUT_SETUP,
  get_paralegal_payout_history: PARALEGAL_EVIDENCE_CAPABILITIES.PAYOUT_HISTORY,
  get_paralegal_case_financials: PARALEGAL_EVIDENCE_CAPABILITIES.MATTER_FINANCIALS,
  get_paralegal_account_snapshot: PARALEGAL_EVIDENCE_CAPABILITIES.ACCOUNT,
  get_paralegal_deactivation_eligibility: PARALEGAL_EVIDENCE_CAPABILITIES.DEACTIVATION,
  get_paralegal_workflow_readiness: PARALEGAL_EVIDENCE_CAPABILITIES.WORKFLOW,
  get_paralegal_messaging_state: PARALEGAL_EVIDENCE_CAPABILITIES.MESSAGES,
  find_paralegal_navigation_destination: PARALEGAL_EVIDENCE_CAPABILITIES.NAVIGATION,
  search_lpc_knowledge: PARALEGAL_EVIDENCE_CAPABILITIES.KNOWLEDGE,
});

const FAILURE_CLASSES = Object.freeze({
  EVIDENCE_MISSING_REQUIRED_FACT: "evidence_missing_required_fact",
  EVIDENCE_UNAUTHORIZED: "evidence_unauthorized",
  EVIDENCE_TEMPORARILY_UNAVAILABLE: "evidence_temporarily_unavailable",
  EVIDENCE_CONTRADICTION: "evidence_contradiction",
});

function capabilityIdForParalegalTool(toolName = "") {
  return TOOL_CAPABILITIES[String(toolName || "")] || "";
}

function flattenFacts(value, prefix = "", facts = [], depth = 0) {
  if (depth > 5 || value === undefined) return facts;
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    facts.push({ key: prefix, value });
    return facts;
  }
  if (value instanceof Date) {
    facts.push({ key: prefix, value: value.toISOString() });
    return facts;
  }
  if (Array.isArray(value)) {
    value.slice(0, 25).forEach((entry, index) => flattenFacts(entry, `${prefix}[${index}]`, facts, depth + 1));
    return facts;
  }
  if (typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => {
      if (["caseDoc", "raw", "accountId", "stripeAccountId", "transferId", "storageKey"].includes(key)) return;
      flattenFacts(entry, prefix ? `${prefix}.${key}` : key, facts, depth + 1);
    });
  }
  return facts;
}

function normalizeParalegalToolEvidence({ toolName = "", result = {} } = {}) {
  const evidenceState = String(result.evidenceState || result.evidence?.state || (
    result.ok === false ? "temporarily_unavailable" : result.available === false ? "absent" : "verified"
  ));
  const authorized = result.authorized !== false && evidenceState !== "unauthorized";
  const embeddedFacts = Array.isArray(result.evidence?.facts)
    ? result.evidence.facts.flatMap((fact) =>
        flattenFacts(fact?.value, String(fact?.key || ""), [], 0)
      )
    : [];
  const facts = (embeddedFacts.length
    ? embeddedFacts
    : flattenFacts(
        Object.fromEntries(
          Object.entries(result).filter(([key]) => key !== "evidence")
        )
      ))
    .filter((fact) =>
      fact.key &&
      !/(?:^|\.)(?:ok|authorized|evidenceState|error|reason)$/i.test(fact.key) &&
      !/(?:^|\.)(?:accountId|stripeAccountId|transferId|storageKey|clientSecret|paymentIntentId|attorneyId|paralegalId|caseDoc|raw|internalNotes?|fraudSignals?)(?:\.|$)/i.test(
        fact.key
      )
    )
    .slice(0, 200);
  const missingFacts = Array.isArray(result.missingFacts) ? result.missingFacts.map(String) : [];
  return {
    capabilityId: String(result.evidence?.capabilityId || capabilityIdForParalegalTool(toolName)),
    toolName: String(toolName || ""),
    state: evidenceState,
    authorized,
    subjectType: String(result.evidence?.subjectType || (result.matterId || result.caseId ? "matter" : "account")),
    subjectId: String(result.evidence?.subjectId || result.matterId || result.caseId || ""),
    matterId: String(result.evidence?.matterId || result.matterId || result.caseId || ""),
    policyOrLiveState: String(result.evidence?.policyOrLiveState || "live_state"),
    facts,
    missingFacts,
  };
}

function factValue(evidence = {}, suffix = "") {
  const normalized = String(suffix || "").toLowerCase();
  const match = (evidence.facts || []).find((fact) =>
    String(fact.key || "").toLowerCase() === normalized ||
    String(fact.key || "").toLowerCase().endsWith(`.${normalized}`)
  );
  return match?.value;
}

function renderParalegalEvidenceAnswer(capabilityId = "", evidence = {}) {
  if (!evidence.authorized || evidence.state === "unauthorized") {
    return {
      ok: true,
      reply: "I can’t access that record from this paralegal account.",
      failureClass: FAILURE_CLASSES.EVIDENCE_UNAUTHORIZED,
      evidence,
    };
  }
  if (evidence.state === "temporarily_unavailable") {
    return {
      ok: true,
      reply: "I can’t verify that information right now. Please try again shortly.",
      failureClass: FAILURE_CLASSES.EVIDENCE_TEMPORARILY_UNAVAILABLE,
      evidence,
    };
  }

  let reply = "";
  const missingFacts = [...(evidence.missingFacts || [])];
  if (capabilityId === "P01_assigned_overview") {
    const active = factValue(evidence, "activeCount");
    const completed = factValue(evidence, "completedCount");
    if (Number.isFinite(Number(active)) && Number.isFinite(Number(completed))) {
      reply = `You have ${Number(active)} active matter${Number(active) === 1 ? "" : "s"} and ${Number(completed)} completed matter${Number(completed) === 1 ? "" : "s"}.`;
    }
  } else if (capabilityId === "P02_matter_details") {
    const title = factValue(evidence, "title");
    const status = factValue(evidence, "status");
    const attorneyName = factValue(evidence, "attorneyName");
    const deadline = factValue(evidence, "deadline");
    const subject = title ? `The ${title} matter` : "The matter";
    const details = [
      status ? `is ${status}` : "",
      attorneyName ? `has ${attorneyName} as the attorney` : "",
      deadline ? `has a recorded deadline of ${String(deadline).slice(0, 10)}` : "",
    ].filter(Boolean);
    reply = details.length ? `${subject} ${details.join(", and ")}.` : "";
  } else if (capabilityId === "P06_applications") {
    const total = factValue(evidence, "totalCount");
    const submitted = factValue(evidence, "counts.submitted");
    const viewed = factValue(evidence, "counts.viewed");
    const shortlisted = factValue(evidence, "counts.shortlisted");
    const selected = factValue(evidence, "counts.selected");
    if (Number.isFinite(Number(total))) {
      reply = `You have ${Number(total)} application${Number(total) === 1 ? "" : "s"} recorded${
        [submitted, viewed, shortlisted, selected].some((value) => Number(value) > 0)
          ? `: ${Number(submitted || 0)} submitted, ${Number(viewed || 0)} viewed, ${Number(shortlisted || 0)} shortlisted, and ${Number(selected || 0)} selected`
          : ""
      }.`;
    }
  } else if (capabilityId === "P08_invitations") {
    const total = factValue(evidence, "totalCount");
    const pending = factValue(evidence, "pendingCount");
    if (Number.isFinite(Number(total)) && Number.isFinite(Number(pending))) {
      reply = `You have ${Number(total)} invitation${Number(total) === 1 ? "" : "s"} recorded, including ${Number(pending)} pending.`;
    }
  } else if (capabilityId === "P14_payout_setup") {
    const ready = factValue(evidence, "ready");
    reply = ready === true
      ? "Your payout setup is ready."
      : ready === false
        ? "Your payout setup is not complete yet."
        : "";
  } else if (capabilityId === "P17_matter_financials") {
    const gross = factValue(evidence, "gross.formatted");
    const fee = factValue(evidence, "platformFee.formatted");
    const net = factValue(evidence, "net.formatted");
    const details = [
      gross ? `the matter gross amount is ${gross}` : "",
      fee ? `the paralegal platform fee is ${fee}` : "",
      net ? `the ${factValue(evidence, "finalized") === true ? "finalized" : "current estimated"} net payout is ${net}` : "",
    ].filter(Boolean);
    reply = details.length
      ? `${details.join(details.length > 1 ? ", and " : "")}.`.replace(/^the/, "The")
      : "";
  } else if (capabilityId === "P16_payout_history") {
    const count = factValue(evidence, "payoutCount");
    const total = factValue(evidence, "totalPaid");
    const latest = factValue(evidence, "latest.amount");
    const details = [
      Number.isFinite(Number(count)) ? `${Number(count)} recorded payout${Number(count) === 1 ? "" : "s"}` : "",
      total ? `${total} paid in total` : "",
      latest ? `${latest} in the latest payout` : "",
    ].filter(Boolean);
    reply = details.length ? `Your payout history shows ${details.join(", and ")}.` : "";
  } else if (capabilityId === "P15_payout_timing" || capabilityId === "P21_completion_release") {
    const released = factValue(evidence, "paymentReleased");
    const completed = factValue(evidence, "matterCompleted");
    const nextActor = factValue(evidence, "nextActor");
    const minimum = factValue(evidence, "bankDepositEstimateBusinessDays.minimum");
    const maximum = factValue(evidence, "bankDepositEstimateBusinessDays.maximum");
    reply = released === true
      ? "LPC records the funds as released. That does not by itself confirm they reached your bank."
      : released === false
        ? "The funds have not been released yet."
        : "";
    if (!reply && completed === false) {
      reply = "The matter is not recorded as completed yet.";
    }
    const nextParts = [];
    if (nextActor === "attorney") {
      nextParts.push("the attorney is the next recorded actor for completion or release");
    } else if (nextActor === "stripe") {
      nextParts.push("Stripe processing is the next recorded stage");
    }
    if (Number.isFinite(Number(minimum)) && Number.isFinite(Number(maximum))) {
      nextParts.push(
        `bank deposit is generally estimated at ${Number(minimum)}–${Number(maximum)} business days after release, depending on Stripe and your bank`
      );
    }
    if (nextParts.length) {
      reply += ` ${nextParts.join(", and ")}.`.replace(/^ ([a-z])/, (_match, letter) => ` ${letter.toUpperCase()}`);
    }
  } else if (capabilityId === "P13_message_activity") {
    const canSend = factValue(evidence, "canSend");
    const unread = factValue(evidence, "unreadCount");
    const awaitingMine = factValue(evidence, "awaitingMyReply");
    const awaitingAttorney = factValue(evidence, "awaitingAttorneyReply");
    const parts = [
      canSend === true ? "you can send messages" : canSend === false ? "messaging is not currently available" : "",
      Number.isFinite(Number(unread)) ? `you have ${Number(unread)} unread message${Number(unread) === 1 ? "" : "s"}` : "",
      awaitingMine === true ? "the latest message is awaiting your reply" : "",
      awaitingAttorney === true ? "the latest message is awaiting the attorney’s reply" : "",
    ].filter(Boolean);
    reply = parts.length ? `${parts.join(", and ")}.`.replace(/^you/, "You").replace(/^messaging/, "Messaging") : "";
  } else if (capabilityId === "P23_profile") {
    const approved = factValue(evidence, "approved");
    const hidden = factValue(evidence, "profile.hidden");
    const resume = factValue(evidence, "profile.resumePresent");
    const certificate = factValue(evidence, "profile.certificatePresent");
    const twoFactorEnabled = factValue(evidence, "security.twoFactorEnabled");
    const parts = [
      approved === true ? "your account is approved" : approved === false ? "your account is not approved" : "",
      hidden === true ? "your profile is hidden" : hidden === false ? "your profile is not marked hidden" : "",
      resume === true ? "a resume is recorded" : resume === false ? "no resume is recorded" : "",
      certificate === true ? "a certificate is recorded" : certificate === false ? "no certificate is recorded" : "",
      twoFactorEnabled === true ? "two-factor authentication is enabled" : twoFactorEnabled === false ? "two-factor authentication is not enabled" : "",
    ].filter(Boolean);
    reply = parts.length ? `${parts.join(", and ")}.`.replace(/^your/, "Your") : "";
  } else if (capabilityId === "P28_deactivation") {
    const allowed = factValue(evidence, "canDeactivate");
    reply = allowed === true
      ? "Your account is currently eligible for deactivation."
      : allowed === false
        ? "Your account cannot be deactivated yet because there are active blockers."
        : "";
  } else if (capabilityId === "P30_navigation") {
    const label = factValue(evidence, "ctaLabel");
    reply = label ? `You can use ${label} below.` : "";
  }

  if (!reply) {
    const natural = (evidence.facts || []).find((fact) =>
      /(?:^|\.)(?:answer|summary|message)$/.test(String(fact.key || "")) &&
      typeof fact.value === "string"
    );
    reply = String(natural?.value || "");
  }
  if (!reply) missingFacts.push("presentable_answer");
  return {
    ok: Boolean(reply),
    reply,
    missingFacts: [...new Set(missingFacts)],
    failureClass: reply ? "" : FAILURE_CLASSES.EVIDENCE_MISSING_REQUIRED_FACT,
    evidence,
  };
}

module.exports = {
  FAILURE_CLASSES,
  PARALEGAL_EVIDENCE_CAPABILITIES,
  capabilityIdForParalegalTool,
  factValue,
  normalizeParalegalToolEvidence,
  renderParalegalEvidenceAnswer,
};
