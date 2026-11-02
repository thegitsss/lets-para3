// The portal owns navigation and session cleanup. Connected features only own
// requests made during the current route and never replace the portal shell.
export function createConnectedApi({ ownerId, role, signal, onAccessLost = () => {}, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const allowed = /^\/api\/(?:matter-preparation|paralegal-matching|document-collaboration|integrations\/clio)(?:\/|$)/;
  let lost = false;
  function inactive() { if (signal?.aborted || lost) throw new DOMException("This view is no longer active.", "AbortError"); }
  function lose() { if (!lost && !signal?.aborted) { lost = true; onAccessLost(); } }
  async function request(path, options = {}) {
    inactive();
    const timeout = AbortSignal.timeout(65000);
    const response = await fetchImpl(path, { ...options, credentials: "include", cache: "no-store", redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Accept: "application/json", "X-LPC-Owner-Id": ownerId, ...options.headers } });
    const value = await response.json().catch(() => null);
    inactive();
    if (response.status === 401 || /ACCOUNT_CHANGED$/.test(value?.code || "")) lose();
    if (!response.ok) throw Object.assign(new Error(value?.error || value?.msg || "This request could not be confirmed. Refresh before trying again."), { status: response.status, code: value?.code });
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("This response could not be read. Please try again.");
    return value;
  }
  async function verify() {
    const result = await request("/api/auth/me"), user = result.user;
    if (String(user?.id || user?._id || "") !== ownerId || user?.role !== role || user?.status !== "approved" || user?.disabled || user?.deleted) {
      lose(); throw Object.assign(new Error("Your account changed. Sign in again to continue."), { status: 403, code: "CONNECTED_ACCOUNT_CHANGED" });
    }
  }
  function checkPath(path) {
    if (typeof path !== "string" || !allowed.test(path) || /[\\\u0000-\u0020#]/.test(path)) throw new Error("Invalid workspace request.");
    const url = new URL(path, location.origin), rawPath = path.split("?")[0];
    if (url.origin !== location.origin || url.pathname !== rawPath || /%(?:2e|2f|5c)/i.test(rawPath) || !allowed.test(url.pathname)) throw new Error("Invalid workspace request.");
  }
  return Object.freeze({
    async read(path) { checkPath(path); await verify(); const result = await request(path); await verify(); return result; },
    async write(path, body = {}, method = "POST") {
      checkPath(path); if (!["POST", "DELETE", "PATCH", "PUT"].includes(method)) throw new Error("Invalid workspace action.");
      await verify(); const csrf = await request("/api/csrf");
      if (!csrf.csrfToken) throw new Error("Refresh your session before continuing.");
      const result = await request(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken } });
      await verify(); return result;
    },
  });
}
