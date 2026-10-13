function uniqueList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function compactText(value = "", max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function sentenceCase(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function collectCitations(cards = []) {
  return uniqueList(
    cards.flatMap((card) =>
      (card.citations || []).map((citation) =>
        JSON.stringify({
          sourceKey: citation.sourceKey,
          label: citation.label,
          filePath: citation.filePath,
          excerpt: citation.excerpt,
          locator: citation.locator,
        })
      )
    )
  ).map((serialized) => JSON.parse(serialized));
}

function summarizeBlocks(cards = [], limit = 6) {
  return cards.slice(0, limit).map((card) => ({
    title: card.title,
    domain: card.domain,
    recordType: card.recordType,
    summary: card.summary || card.statement || card.approvedResponse || "",
    statement: card.statement || card.approvedResponse || "",
  }));
}

function flattenClaims(cards = []) {
  return uniqueList(cards.flatMap((card) => card.claimsToAvoid || []));
}

module.exports = {
  collectCitations,
  compactText,
  flattenClaims,
  sentenceCase,
  summarizeBlocks,
  uniqueList,
};
