const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export function normalizeHttpNavigationUrl(
  value,
  {
    sameOrigin = false,
    allowedHosts = [],
    allowSubdomains = false,
    returnRelative = false,
    baseOrigin = globalThis.location?.origin || "",
  } = {}
) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 4096 || CONTROL_CHARACTERS.test(raw) || !baseOrigin) return "";
  try {
    const url = new URL(raw, baseOrigin);
    if (!['http:', 'https:'].includes(url.protocol.toLowerCase())) return "";
    if (url.username || url.password) return "";
    if (sameOrigin && url.origin !== baseOrigin) return "";
    const hosts = (Array.isArray(allowedHosts) ? allowedHosts : [allowedHosts])
      .map((host) => String(host || "").trim().toLowerCase())
      .filter(Boolean);
    if (
      hosts.length &&
      !hosts.some(
        (host) => url.hostname.toLowerCase() === host || (allowSubdomains && url.hostname.toLowerCase().endsWith(`.${host}`))
      )
    ) {
      return "";
    }
    if (returnRelative && url.origin === baseOrigin) return `${url.pathname}${url.search}${url.hash}`;
    return url.href;
  } catch {
    return "";
  }
}

export function normalizeSameOriginPath(value, options = {}) {
  return normalizeHttpNavigationUrl(value, {
    ...options,
    sameOrigin: true,
    returnRelative: true,
  });
}
