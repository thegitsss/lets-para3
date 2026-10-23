function normalizeHttpUrl(value, { fieldLabel = "URL", requiredHost = "", maxLength = 500 } = {}) {
  const raw = value === null || value === undefined ? "" : String(value).trim();
  if (!raw) return { ok: true, value: "" };
  if (raw.length > maxLength || /[\u0000-\u001F\u007F]/.test(raw)) {
    return { ok: false, error: `${fieldLabel} is invalid.` };
  }
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { ok: false, error: `${fieldLabel} must use http:// or https://.` };
    }
    const required = String(requiredHost || "").trim().toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    if (required && hostname !== required && !hostname.endsWith(`.${required}`)) {
      return { ok: false, error: `${fieldLabel} must use ${required}.` };
    }
    return { ok: true, value: parsed.toString() };
  } catch {
    return { ok: false, error: `${fieldLabel} must be a valid web address.` };
  }
}

module.exports = { normalizeHttpUrl };
