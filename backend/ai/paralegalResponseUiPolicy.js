const SUPPORTED_EXECUTED_ESCALATION_REASONS = Object.freeze(new Set([
  "request_human_help",
  "payout_issue_reported",
  "workspace_access_issue_reported",
  "messaging_issue_reported",
]));

function normalize(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function meaningfulTokens(value = "") {
  const ignored = new Set([
    "about", "again", "assistant", "check", "help", "open", "please", "show", "that", "the",
    "this", "view", "what", "where", "with", "your",
  ]);
  return new Set(normalize(value).split(" ").filter((token) => token.length > 2 && !ignored.has(token)));
}

function suggestionIsRelevant(suggestion = "", context = "") {
  const suggestionTokens = meaningfulTokens(suggestion);
  const contextTokens = meaningfulTokens(context);
  if (!suggestionTokens.size) return false;
  return [...suggestionTokens].some((token) => contextTokens.has(token));
}

function verifiedNavigationFrom(toolOutputs = []) {
  const entry = (Array.isArray(toolOutputs) ? toolOutputs : []).find((item) =>
    item?.name === "find_paralegal_navigation_destination" &&
    item?.result?.ok === true &&
    item?.result?.available === true &&
    typeof item?.result?.ctaLabel === "string" &&
    typeof item?.result?.ctaHref === "string"
  );
  return entry
    ? {
        ctaLabel: String(entry.result.ctaLabel).trim().slice(0, 80),
        ctaHref: String(entry.result.ctaHref).trim().slice(0, 240),
      }
    : null;
}

function stripLinks(reply = "", buttonNavigation = null) {
  let text = String(reply || "");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, "");
  if (buttonNavigation?.ctaHref) {
    const escaped = buttonNavigation.ctaHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "gi"), "");
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
}

function sanitizeParalegalResponseUi({
  reply = "",
  messageText = "",
  toolOutputs = [],
  navigation = null,
  suggestions = [],
  clarification = null,
  escalation = null,
} = {}) {
  const warnings = [];
  const verifiedNavigation = verifiedNavigationFrom(toolOutputs);
  const requestedNavigation = navigation && typeof navigation === "object"
    ? {
        ctaLabel: String(navigation.ctaLabel || "").trim(),
        ctaHref: String(navigation.ctaHref || "").trim(),
      }
    : null;
  const safeNavigation =
    verifiedNavigation &&
    requestedNavigation &&
    requestedNavigation.ctaLabel === verifiedNavigation.ctaLabel &&
    requestedNavigation.ctaHref === verifiedNavigation.ctaHref
      ? verifiedNavigation
      : null;
  if (requestedNavigation && !safeNavigation) warnings.push("unsupported_navigation_removed");

  const candidates = Array.isArray(suggestions)
    ? suggestions.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const clarificationChoices = Array.isArray(clarification?.choices)
    ? clarification.choices.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
    : [];
  const clarificationNeedsChoices =
    clarification?.required === true &&
    clarificationChoices.length > 1 &&
    /\?$/.test(String(clarification?.question || "").trim());
  let safeSuggestions = [];
  if (clarificationNeedsChoices) {
    safeSuggestions = clarificationChoices;
  } else if (!safeNavigation) {
    const context = `${messageText} ${reply}`;
    const accepted = candidates.find((item) => suggestionIsRelevant(item, context));
    if (accepted) safeSuggestions = [accepted];
  }
  if (candidates.length !== safeSuggestions.length) warnings.push("suggestions_filtered");

  const executedEscalation =
    escalation?.executed === true &&
    Boolean(String(escalation?.referenceId || "").trim()) &&
    SUPPORTED_EXECUTED_ESCALATION_REASONS.has(
      String(escalation?.reason || "").trim().toLowerCase()
    );
  const reviewCard = executedEscalation
    ? {
        reason: String(escalation.reason).trim().toLowerCase(),
        referenceId: String(escalation.referenceId).trim().slice(0, 120),
      }
    : null;
  if (escalation && !reviewCard) warnings.push("unverified_review_card_suppressed");

  return {
    reply: stripLinks(reply, safeNavigation),
    navigation: safeNavigation,
    suggestions: safeSuggestions,
    reviewCard,
    warnings: [...new Set(warnings)],
  };
}

module.exports = {
  SUPPORTED_EXECUTED_ESCALATION_REASONS,
  sanitizeParalegalResponseUi,
  stripLinks,
  suggestionIsRelevant,
  verifiedNavigationFrom,
};
