const roles = new Set(["attorney", "paralegal", "admin"]);
const validId = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const plain = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export const SUPPORT_READ_TIMEOUT_MS = 30_000;
// Preserve the existing six-step model pipeline and SDK retry allowance. This
// is a maximum recovery deadline, not an acceptable response-time target.
export const SUPPORT_MUTATION_TIMEOUT_MS = 600_000;
const IDENTITY_TIMEOUT_MS = 12_000;

export class SupportError extends Error {
  constructor(kind, { status = 0, dispatched = false } = {}) {
    super(kind === "authentication" ? "Your signed-in account changed."
      : kind === "uncertain" ? "The result could not be confirmed. Check the conversation before trying again."
      : kind === "invalid_request" ? "Verify your account before using LPC Assistant."
      : "LPC Assistant is temporarily unavailable. Try again.");
    this.name = "SupportError"; this.kind = kind; this.status = status; this.dispatched = dispatched;
  }
}

function identity(ownerId, role) {
  if (!validId(ownerId) || !roles.has(role)) throw new SupportError("invalid_request");
  return { ownerId: ownerId.toLowerCase(), role };
}
function endpoint(path) {
  if (typeof path !== "string" || !path.startsWith("/api/") || path.startsWith("//")) throw new SupportError("invalid_request");
  const url = new URL(path, "https://lpc.invalid");
  if (url.origin !== "https://lpc.invalid" || url.hash || !(url.pathname.startsWith("/api/support/") || ["/api/users/me", "/api/auth/request-password-reset", "/api/payments/connect"].includes(url.pathname))) throw new SupportError("invalid_request");
  return url;
}
function bind(path, { ownerId, role, method = "GET", body } = {}) {
  const expected = identity(ownerId, role), url = endpoint(path);
  if (!["GET", "POST"].includes(method)) throw new SupportError("invalid_request");
  if (method === "GET") {
    url.searchParams.set("expectedOwnerId", expected.ownerId);
    if (url.pathname !== "/api/users/me") url.searchParams.set("expectedRole", expected.role);
    return { path: `${url.pathname}${url.search}`, body: undefined };
  }
  if (!plain(body)) throw new SupportError("invalid_request");
  return { path: `${url.pathname}${url.search}`, body: { ...body, expectedOwnerId: expected.ownerId, expectedRole: expected.role } };
}

export function createSupportTransport({ fetchImpl = globalThis.fetch.bind(globalThis), onAuthenticationLost } = {}) {
  let generation = 0; const pending = new Set();
  async function request(path, { ownerId, role, signal, isCurrent = () => true, method = "GET", body, headers, timeoutMs } = {}) {
    const expected = identity(ownerId, role); method = String(method).toUpperCase();
    const bound = bind(path, { ...expected, method, body });
    const mutation = method !== "GET";
    const maximum = mutation && endpoint(path).pathname.startsWith("/api/support/") ? SUPPORT_MUTATION_TIMEOUT_MS : SUPPORT_READ_TIMEOUT_MS;
    const duration = timeoutMs === undefined ? maximum : timeoutMs;
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > SUPPORT_MUTATION_TIMEOUT_MS) throw new SupportError("invalid_request");
    const ticket = generation, controller = new AbortController();
    let dispatched = false, requestStarted = false, timedOut = false, verifiedAfterRequest = false, notified = false, responseStatus = 0;
    const abort = () => controller.abort();
    const timer = setTimeout(() => { timedOut = true; abort(); }, duration);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    pending.add(controller);
    const canceled = () => Object.assign(new DOMException("Canceled", "AbortError"), { dispatched });
    const failure = status => new SupportError(mutation && dispatched ? "uncertain" : "unavailable", { status: responseStatus || status, dispatched });
    function current() {
      if (signal?.aborted || ticket !== generation || !isCurrent()) throw canceled();
      if (timedOut) throw failure();
      if (controller.signal.aborted) throw canceled();
    }
    function lost(status = 0) {
      current();
      const error = new SupportError("authentication", { status, dispatched });
      if (!notified) { notified = true; try { onAuthenticationLost?.({ ...expected, status, dispatched }); } catch { /* The authentication outcome remains authoritative. */ } }
      throw error;
    }
    async function read(url, options = {}, stageTimeout = 0, captureStatus = false) {
      current();
      const stage = new AbortController(); let stageTimedOut = false;
      const stop = () => stage.abort(); controller.signal.addEventListener("abort", stop, { once: true });
      if (controller.signal.aborted) stop();
      const stageTimer = stageTimeout ? setTimeout(() => { stageTimedOut = true; stage.abort(); }, stageTimeout) : null;
      let rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = () => reject(canceled()); stage.signal.addEventListener("abort", rejectAbort, { once: true }); if (stage.signal.aborted) rejectAbort(); });
      try {
        const work = (async () => {
          const response = await fetchImpl(url, { ...options, credentials: "include", cache: "no-store", redirect: "error", signal: stage.signal });
          if (captureStatus) responseStatus = response.status;
          let value, decoded = true;
          try { value = await response.json(); } catch { decoded = false; }
          return { response, value, decoded };
        })();
        const result = await Promise.race([work, aborted]); current();
        if (stageTimedOut) throw failure(result.response?.status);
        return result;
      } catch (error) {
        current();
        if (stageTimedOut) throw failure();
        throw error;
      } finally {
        if (stageTimer) clearTimeout(stageTimer);
        controller.signal.removeEventListener("abort", stop); stage.signal.removeEventListener("abort", rejectAbort);
      }
    }
    async function verify() {
      if (requestStarted) verifiedAfterRequest = true;
      const { response, value, decoded } = await read("/api/auth/me", { method: "GET", headers: { Accept: "application/json" } }, IDENTITY_TIMEOUT_MS);
      if ([401, 403].includes(response.status)) lost(response.status);
      if (!response.ok || !decoded || !plain(value)) throw failure(response.status);
      if (value.user === null) lost(response.status);
      const user = value.user;
      if (!plain(user) || !validId(user.id || user._id) || typeof user.role !== "string" || !user.role || typeof user.status !== "string" || !user.status) throw failure(response.status);
      const actual = String(user.id || user._id).toLowerCase();
      if (user.id !== undefined && user._id !== undefined && (!validId(user._id) || String(user._id).toLowerCase() !== actual)) throw failure(response.status);
      if (actual !== expected.ownerId || user.role !== expected.role || user.status !== "approved" || user.disabled === true || user.deleted === true) lost(response.status);
    }
    try {
      await verify();
      const requestHeaders = new Headers(headers || {}); requestHeaders.set("Accept", "application/json");
      if (mutation) {
        const csrf = await read("/api/csrf", { method: "GET", headers: { Accept: "application/json" } }, IDENTITY_TIMEOUT_MS);
        if ([401, 403].includes(csrf.response.status)) lost(csrf.response.status);
        if (!csrf.response.ok || !csrf.decoded || typeof csrf.value?.csrfToken !== "string" || !csrf.value.csrfToken) throw failure(csrf.response.status);
        requestHeaders.set("Content-Type", "application/json"); requestHeaders.set("X-CSRF-Token", csrf.value.csrfToken);
      }
      current(); requestStarted = true; dispatched = mutation;
      const { response, value, decoded } = await read(bound.path, { method, headers: requestHeaders, ...(mutation ? { body: JSON.stringify(bound.body) } : {}) }, 0, true);
      if (response.status === 401 || response.status === 403 && (value?.code === "SUPPORT_ACCOUNT_CHANGED" || value?.code === "ACCOUNT_CHANGED" || /session expired|invalid token|not authenticated|account has been (?:disabled|deactivated)|account deactivated/i.test(String(value?.error || value?.msg || value?.message || "")))) lost(response.status);
      await verify(); current();
      if (!decoded || !plain(value) || mutation && response.status >= 500) throw failure(response.status);
      return Object.freeze({ ok: response.ok, status: response.status, headers: response.headers, json: async () => { current(); return value; } });
    } catch (error) {
      if (error instanceof SupportError && error.kind === "authentication") throw error;
      current();
      // A lost/rejected request may coincide with a cookie change. Only a
      // confirmed loss clears identity; an unavailable check keeps recovery.
      if (requestStarted && !verifiedAfterRequest && !controller.signal.aborted) {
        try { await verify(); }
        catch (verificationError) {
          if (verificationError instanceof SupportError && verificationError.kind === "authentication") throw verificationError;
          current(); throw failure(error.status || verificationError.status);
        }
      }
      current();
      if (error instanceof SupportError) throw error;
      throw failure(error.status);
    } finally {
      clearTimeout(timer); pending.delete(controller); signal?.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    request,
    boundEventsUrl(path, options) {
      if (!/^\/api\/support\/conversation\/[a-f\d]{24}\/events$/i.test(path)) throw new SupportError("invalid_request");
      return bind(path, { ...options, method: "GET" }).path;
    },
    clear() { generation++; pending.forEach(controller => controller.abort()); pending.clear(); },
  });
}
