const SAFE_FILENAME_RX = /[^a-zA-Z0-9._-]/g;

function stripHtml(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
}

function cleanText(str, { max = 10000, allowNewlines = true } = {}) {
  if (typeof str !== "string") return "";
  const normalized = allowNewlines
    ? String(str).replace(/<[^>]*>/g, "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, (m) => (m.includes("\n") ? "\n" : " "))
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

function cleanBudget(value, { min = 400, max = 30000 } = {}) {
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
    throw new Error(`Budget must be between $${min} and $${max}`);
  }
  return parsed;
}

module.exports = {
  cleanText,
  cleanTitle,
  cleanMessage,
  cleanFilename,
  cleanBudget,
};
