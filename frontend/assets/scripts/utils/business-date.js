(function attachLpcBusinessDate(root) {
  "use strict";

  const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

  function parseParts(value) {
    if (value === null || value === undefined || value === "") return null;
    const text = value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString()
      : String(value).trim();
    const match = DATE_ONLY_PATTERN.exec(text.slice(0, 10));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      return null;
    }
    return { year, month, day, dateOnly: text.slice(0, 10) };
  }

  function normalize(value) {
    return parseParts(value)?.dateOnly || "";
  }

  function toLocalDate(value) {
    const parts = parseParts(value);
    if (!parts) return null;
    // Noon avoids browser/DST edge cases while preserving a calendar date.
    return new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0);
  }

  function format(value, options = {}, locale) {
    const date = toLocalDate(value);
    if (!date) return "";
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      ...options,
    }).format(date);
  }

  function today() {
    const now = new Date();
    const year = String(now.getFullYear()).padStart(4, "0");
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDays(value, days) {
    const date = toLocalDate(value);
    if (!date || !Number.isInteger(days)) return "";
    date.setDate(date.getDate() + days);
    const year = String(date.getFullYear()).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function compare(left, right) {
    const a = normalize(left);
    const b = normalize(right);
    if (!a || !b) return null;
    return a === b ? 0 : a < b ? -1 : 1;
  }

  function matterValue(matter = {}) {
    return normalize(matter.deadlineDate || matter.deadline);
  }

  const api = Object.freeze({ addDays, compare, format, matterValue, normalize, parseParts, toLocalDate, today });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LPCBusinessDate = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
