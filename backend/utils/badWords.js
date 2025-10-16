// backend/utils/badWords.js

/**
 * Profanity filtering utilities
 * - Explicit base list (expandable)
 * - Unicode-safe regex (word boundaries)
 * - Handles common suffixes (s, ed, ing, er, ers)
 * - Normalizes matches back to base word
 * - Masking preserves surrounding punctuation/spacing
 *
 * ⚠️ Not exhaustive: this is meant as a light layer, not full moderation AI.
 */

// Base list — keep explicit and transparent (expand if needed).
const BASE = ["damn", "hell", "shit", "fuck"];

// Allow runtime extension (e.g. from config or DB).
const EXTRA = (process.env.EXTRA_PROFANITY || "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);

// Merge + dedupe
const WORDS = Array.from(new Set([...BASE, ...EXTRA]));

// Build regex once
const escaped = WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const suffix = "(?:s|ed|ing|er|ers)?";
const wordGroup = `(?:${escaped.join("|")})${suffix}`;
const RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${wordGroup})(?![\\p{L}\\p{N}_])`,
  "giu"
);

// Normalize a matched word back to its base form (strip simple suffixes)
function toBase(w) {
  return String(w).toLowerCase().replace(/(?:s|ed|ing|ers|er)$/i, "");
}

/**
 * Check if text contains profanity.
 * @param {string} text
 * @returns {{isProfane: boolean, matches: string[]}}
 */
function containsProfanity(text) {
  if (!text) return { isProfane: false, matches: [] };
  const found = new Set();
  let m;
  RE.lastIndex = 0;
  while ((m = RE.exec(text))) {
    found.add(toBase(m[1]));
  }
  return { isProfane: found.size > 0, matches: [...found] };
}

/**
 * Mask profanities in text with asterisks (or custom maskChar).
 * Preserves surrounding punctuation/spacing.
 * @param {string} text
 * @param {string} [maskChar='*']
 * @returns {string}
 */
function maskProfanity(text, maskChar = "*") {
  if (!text) return text;
  return text.replace(RE, (full, word) => {
    return full.replace(word, maskChar.repeat(word.length));
  });
}

/**
 * Extend profanity list at runtime (useful for admin tools).
 * @param {string[]} words
 */
function addProfanity(words = []) {
  for (const w of words) {
    if (typeof w === "string" && w.trim()) {
      WORDS.push(w.trim().toLowerCase());
    }
  }
}

module.exports = {
  containsProfanity,
  maskProfanity,
  addProfanity,
  PROFANITY_LIST: WORDS,
};
