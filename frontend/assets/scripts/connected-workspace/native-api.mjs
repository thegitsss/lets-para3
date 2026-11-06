// The portal owns navigation and session cleanup. Connected features only own
// requests made during the current route and never replace the portal shell.
export function createConnectedApi({ ownerId, role, signal, onAccessLost = () => {}, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const allowed = /^\/api\/(?:practice-tools|matter-preparation|paralegal-matching|document-collaboration|text-notifications|integrations\/(?:clio|calendars))(?:\/|$)/;
  let lost = false;
  function inactive() { if (signal?.aborted || lost) throw new DOMException("This view is no longer active.", "AbortError"); }
  function lose() { if (!lost && !signal?.aborted) { lost = true; onAccessLost(); } }
  async function request(path, options = {}, binary = false) {
    inactive();
    const transfer = options.method === "POST" && /^\/api\/integrations\/clio\/matters\/[a-f0-9]{24}\/(?:import|export)$/.test(path);
    const timeout = AbortSignal.timeout(transfer ? 600000 : 65000);
    const response = await fetchImpl(path, { ...options, ...(/^\/api\/(practice-tools|text-notifications)(\/|$)/.test(path) ? { suppressToast: true } : {}), credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, options.signal, timeout].filter(Boolean)), headers: { Accept: binary ? 'image/png' : "application/json", "X-LPC-Owner-Id": ownerId, ...options.headers } });
    let value;
    if (binary && response.ok) {
      if (response.headers.get('content-type')?.split(';')[0] !== 'image/png') throw new Error('The source page could not be verified.');
      const blob = await response.blob(), pageCount = Number(response.headers.get('x-lpc-page-count'));
      if (!blob.size || blob.size > 16 * 1024 * 1024 || !Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 80) throw new Error('The source page could not be verified.');
      value = { blob, pageCount };
    } else value = await response.json().catch(() => null);
    inactive();
    if (options.signal?.aborted) throw new DOMException('This request was canceled.', 'AbortError');
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
    async readBlob(path, options = {}) { checkPath(path); await verify(); const result = await request(path, options, true); await verify(); if (options.signal?.aborted) throw new DOMException('This request was canceled.', 'AbortError'); return result; },
    async write(path, body = {}, method = "POST") {
      checkPath(path); if (!["POST", "DELETE", "PATCH", "PUT"].includes(method)) throw new Error("Invalid workspace action.");
      await verify(); const csrf = await request("/api/csrf");
      if (!csrf.csrfToken) throw new Error("Refresh your session before continuing.");
      const result = await request(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken } });
      await verify(); return result;
    },
    async writeForm(path, form) {
      checkPath(path); if (!(form instanceof FormData)) throw new Error('Choose a supported upload.');
      await verify(); const csrf = await request('/api/csrf');
      if (!csrf.csrfToken) throw new Error('Refresh your session before continuing.');
      const result = await request(path, { method: 'POST', body: form, headers: { 'X-CSRF-Token': csrf.csrfToken } });
      await verify(); return result;
    },
  });
}
