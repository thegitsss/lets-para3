import { classifySession } from "./session-boundary.mjs";

export class AccountError extends Error {
  constructor(kind, status = 0, code = "") {
    super(kind === "conflict" ? "This information changed in another session. Review the latest values before saving." : "The account request could not be completed.");
    this.name = "AccountError"; this.kind = kind; this.status = status;
    this.code = /^ACCOUNT_[A-Z_]{1,60}$/.test(code) ? code : "";
  }
}

const objectId = value => /^[a-f\d]{24}$/i.test(value || "");
export function accountPhoto(value, ownerId) {
  if (typeof value !== "string" || !objectId(ownerId)) return "";
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && url.pathname === `/api/users/profile-photo/${ownerId}` && !url.hash ? `${url.pathname}${url.search}` : "";
  } catch { return ""; }
}
export function accountProfile(payload, ownerId) {
  if (!payload || Array.isArray(payload) || String(payload._id || payload.id) !== ownerId || typeof payload.firstName !== "string" || typeof payload.lastName !== "string" || typeof payload.email !== "string" || typeof payload.barNumber !== "string" || typeof payload.timezone !== "string" || !/^[a-f\d]{64}$/.test(payload.profilePhotoRevision || "") || !payload.preferences || !["light","dark","mountain","mountain-dark"].includes(payload.preferences.theme) || !["xs","sm","md","lg","xl"].includes(payload.preferences.fontSize)) throw new AccountError("invalid_response");
  return { ...payload, profileImage: accountPhoto(payload.profileImage, ownerId), avatarURL: accountPhoto(payload.avatarURL, ownerId) };
}

// Account operations have their own bounded transport so multipart/photo errors
// cannot widen the Matter API's permitted writes or binary response types.
export function createAccountApi({ fetchImpl = window.fetch.bind(window), onAuthenticationLost } = {}) {
  const pending = new Set(); let generation = 0;
  async function request(path, { signal, method = "GET", body, headers = {}, image = false } = {}) {
    const controller = new AbortController(), ticket = generation, abort = () => controller.abort();
    const timer = setTimeout(abort, 30000); pending.add(controller);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    try {
      const response = await fetchImpl(path, { method, body, headers: { Accept: image ? "image/jpeg, image/png" : "application/json", ...headers }, credentials: "include", redirect: "error", cache: "no-store", signal: controller.signal });
      let payload;
      if (image && response.ok) {
        const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (!["image/jpeg", "image/png"].includes(type)) throw new AccountError("invalid_response");
        payload = await response.blob();
        if (!payload.size || payload.size > 5 * 1024 * 1024) throw new AccountError("invalid_response");
        const bytes = new Uint8Array(await payload.slice(0, 8).arrayBuffer());
        if (type === "image/png" ? ![137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b) : !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) throw new AccountError("invalid_response");
      } else payload = await response.json().catch(() => null);
      if (controller.signal.aborted || ticket !== generation) throw new DOMException("Canceled", "AbortError");
      if (!response.ok) {
        const lost = response.status === 401 || response.status === 403 && (payload?.code === "ACCOUNT_CHANGED" || /session expired|invalid token|account has been (?:deactivated|disabled)/i.test(String(payload?.error || payload?.msg || "")));
        if (lost) onAuthenticationLost?.();
        throw new AccountError(lost ? "authentication" : response.status === 409 ? "conflict" : response.status === 403 ? "authorization" : "request", response.status, payload?.code);
      }
      if (!payload || typeof payload !== "object") throw new AccountError("invalid_response");
      return payload;
    } catch (error) {
      if (error.name === "AbortError" || error instanceof AccountError) throw error;
      throw new AccountError("network");
    } finally { clearTimeout(timer); pending.delete(controller); signal?.removeEventListener("abort", abort); }
  }
  async function owner(options) {
    if (!objectId(options?.ownerId)) throw new AccountError("authentication");
    const session = classifySession(await request("/api/auth/me", options));
    if (session.state !== "ready" || session.identity.id !== options.ownerId) { onAuthenticationLost?.(); throw new AccountError("authentication"); }
  }
  async function read(path, options, { query = true, image = false } = {}) {
    await owner(options);
    const params = new URLSearchParams({ expectedOwnerId: options.ownerId });
    if (options.expectedPhotoRevision) params.set("expectedPhotoRevision", options.expectedPhotoRevision);
    const result = await request(query ? `${path}?${params}` : path, { ...options, image });
    await owner(options); return result;
  }
  async function write(path, method, values, options, multipart = false) {
    await owner(options);
    const csrf = await request("/api/csrf", options);
    if (typeof csrf.csrfToken !== "string" || !csrf.csrfToken) throw new AccountError("invalid_response");
    let body;
    if (multipart) { body = values; body.set("expectedOwnerId", options.ownerId); }
    else body = JSON.stringify({ ...values, expectedOwnerId: options.ownerId });
    const result = await request(path, { ...options, method, body, headers: { "X-CSRF-Token": csrf.csrfToken, ...(!multipart ? { "Content-Type": "application/json" } : {}) } });
    await owner(options); return result;
  }
  return Object.freeze({
    async readProfile(options) { return accountProfile(await read("/api/users/me", options), options.ownerId); },
    async saveProfile(values, expectedValues, options) { return accountProfile(await write("/api/users/me", "PATCH", { ...values, expectedValues }, options), options.ownerId); },
    async readPublicProfile(options) {
      const result = await read(`/api/users/attorneys/${options.ownerId}`, options, { query: false });
      if (String(result.id || result._id) !== options.ownerId || typeof result.name !== "string" || "email" in result || "phoneNumber" in result) throw new AccountError("invalid_response");
      return result;
    },
    readPreferences: options => read("/api/account/preferences", options),
    savePreferences: (values, expectedValues, options) => write("/api/account/preferences", "POST", { ...values, expectedValues }, options),
    saveNotificationPreferences: (values, expectedValues, options) => write("/api/users/me/notification-prefs", "PATCH", { ...values, expectedValues }, options),
    readOriginal: options => read("/api/uploads/profile-photo/original", options, { image: true }),
    uploadPhoto: (body, options) => write("/api/uploads/profile-photo", "POST", body, options, true),
    clear() { generation += 1; pending.forEach(controller => controller.abort()); pending.clear(); },
  });
}
