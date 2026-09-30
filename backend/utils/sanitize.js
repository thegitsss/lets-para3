const SAFE_FILENAME_RX = /[^a-zA-Z0-9._-]/g;

function removeAngleMarkup(value, replacement = "") {
  const parts = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("<", cursor);
    if (open === -1) break;
    const close = value.indexOf(">", open + 1);
    if (close === -1) break;
    parts.push(value.slice(cursor, open), replacement);
    cursor = close + 1;
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

function stripHtml(value = "") {
  return removeAngleMarkup(String(value), " ")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

function normalizeTextControls(value) {
  return value.replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

// Plain-text fields retain literal angle brackets; their renderers own escaping.
function cleanPlainText(value, { max = 10000 } = {}) {
  if (typeof value !== "string") return "";
  return normalizeTextControls(value).replace(/\t/g, " ").trim().slice(0, max);
}

function cleanText(str, { max = 10000, allowNewlines = true } = {}) {
  if (typeof str !== "string") return "";
  const normalized = allowNewlines
    ? normalizeTextControls(removeAngleMarkup(str))
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
    : stripHtml(str);
  return normalized.trim().slice(0, max);
}

function cleanTitle(str, max = 150) {
  return cleanText(str, { max, allowNewlines: false });
}

function cleanMessage(str, max = 5000) {
  return cleanText(str, { max, allowNewlines: true });
}

function cleanFilename(str, max = 255) {
  if (!str) return "";
  const cleaned = String(str)
    .normalize("NFKD")
    .replace(/[\p{Diacritic}]/gu, "")
    .replace(SAFE_FILENAME_RX, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
  return cleaned.slice(0, max) || "file";
}

function cleanBudget(value, { min = 0.01, max = 30000 } = {}) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? parseFloat(value.replace(/[^0-9.]/g, ""))
      : NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error("Budget must be a number");
  }
  if (parsed < min || parsed > max) {
    const minLabel = Number.isInteger(min) ? String(min) : min.toFixed(2);
    throw new Error(`Budget must be between $${minLabel} and $${max}`);
  }
  return parsed;
}

module.exports = {
  removeAngleMarkup,
  cleanPlainText,
  cleanText,
  cleanTitle,
  cleanMessage,
  cleanFilename,
  cleanBudget,
};
