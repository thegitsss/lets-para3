const SUPPORTED_ACCOUNT_THEMES = Object.freeze([
  "light",
  "dark",
  "system",
]);

const supportedAccountThemeSet = new Set(SUPPORTED_ACCOUNT_THEMES);

function parseAccountTheme(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return supportedAccountThemeSet.has(normalized) ? normalized : null;
}

function normalizeAccountTheme(value, fallback = "light") {
  const parsed = parseAccountTheme(value);
  if (parsed) return parsed;
  const normalizedFallback = parseAccountTheme(fallback) || "light";
  return /dark$/i.test(String(value || "").trim()) ? "dark" : normalizedFallback;
}

module.exports = {
  SUPPORTED_ACCOUNT_THEMES,
  normalizeAccountTheme,
  parseAccountTheme,
};
