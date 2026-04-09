const { INCIDENT_TERMINAL_STATES } = require("../../utils/incidentConstants");

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "help",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "with",
  "you",
  "your",
]);

function compactText(value, max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value = "") {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token && token.length > 2 && !STOP_WORDS.has(token));
}

function uniqueStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function countKeywordHits(text = "", keywords = []) {
  const haystack = normalizeText(text);
  return (keywords || []).reduce((count, keyword) => (haystack.includes(normalizeText(keyword)) ? count + 1 : count), 0);
}

function overlaps(tokensA = [], tokensB = []) {
  const b = new Set(tokensB);
  return tokensA.filter((token) => b.has(token));
}

function buildPatternKey({ category = "", subject = "", message = "", routePath = "", role = "" } = {}) {
  const tokens = uniqueStrings([
    ...tokenize(subject).slice(0, 3),
    ...tokenize(message).slice(0, 4),
    ...tokenize(routePath).slice(0, 2),
  ]).slice(0, 5);
  return [category || "general_support", role || "unknown", ...tokens].filter(Boolean).join("__");
}

function isOpenIncident(incident = {}) {
  return !INCIDENT_TERMINAL_STATES.includes(String(incident.state || ""));
}

function isResolvedIncident(incident = {}) {
  return INCIDENT_TERMINAL_STATES.includes(String(incident.state || ""));
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${Number(count) || 0} ${Number(count) === 1 ? singular : plural}`;
}

function toSentenceCase(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = {
  buildPatternKey,
  compactText,
  countKeywordHits,
  isOpenIncident,
  isResolvedIncident,
  normalizeText,
  overlaps,
  pluralize,
  tokenize,
  toSentenceCase,
  uniqueStrings,
};
