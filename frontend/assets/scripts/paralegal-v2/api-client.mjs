const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class LpcApiError extends Error {
  constructor(message, { status = 0, kind = "unknown", payload = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "LpcApiError";
    this.status = status;
    this.kind = kind;
    this.payload = payload;
  }
}

function classifyStatus(status) {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 422 || status === 400) return "validation";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "unavailable";
  return "request";
}

function authenticationLossResponse(status, payload) {
  if (status === 401) return true;
  if (status !== 403) return false;
  if (["ACCOUNT_CHANGED", "FINANCIAL_ACCOUNT_CHANGED"].includes(payload?.code)) return true;
  const message = payload && typeof payload === "object"
    ? String(payload.msg || payload.error || payload.message || "")
    : String(payload || "");
  return /^(?:session expired|invalid token|this account has been deactivated\.)$/i.test(message.trim());
}

function normalizeApiPath(path) {
  const value = String(path || "");
  if (!value.startsWith("/api/") || value.startsWith("//")) {
    throw new TypeError("LPC API requests must use a same-origin /api/ path.");
  }
  return value;
}

async function readPayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json().catch(() => null);
  return response.text().catch(() => "");
}

function errorMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    return String(payload.error || payload.msg || payload.message || fallback);
  }
  return typeof payload === "string" && payload.trim() ? payload.trim().slice(0, 500) : fallback;
}

export function createApiClient({
  fetchImpl = window.fetch.bind(window),
  onAuthenticationLost,
  onMutationCommitted,
} = {}) {
  let csrfPromise = null;

  function authenticationError(error) {
    if (error?.kind === "authentication") onAuthenticationLost?.(error);
    return error;
  }

  async function csrfToken(signal) {
    if (!csrfPromise) {
      csrfPromise = fetchImpl("/api/csrf", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal,
      })
        .then(async (response) => {
          const payload = await readPayload(response);
          if (!response.ok || !payload?.csrfToken) {
            const kind = authenticationLossResponse(response.status, payload)
              ? "authentication"
              : classifyStatus(response.status);
            throw authenticationError(new LpcApiError("We couldn’t complete this securely. Refresh the page and try again.", {
              status: response.status,
              kind,
              payload,
            }));
          }
          return String(payload.csrfToken);
        })
        .catch((error) => {
          csrfPromise = null;
          throw error;
        });
    }
    return csrfPromise;
  }

  async function request(path, options = {}) {
    const url = normalizeApiPath(path);
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (!SAFE_METHODS.has(method)) headers.set("X-CSRF-Token", await csrfToken(options.signal));
    if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        method,
        headers,
        credentials: "include",
        cache: options.cache || "no-store",
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new LpcApiError("We couldn’t connect to LPC. Please try again.", { kind: "network", cause: error });
    }

    const payload = response.status === 204 ? null : await readPayload(response);
    if (!response.ok) {
      const kind = authenticationLossResponse(response.status, payload)
        ? "authentication"
        : classifyStatus(response.status);
      const failure = new LpcApiError(errorMessage(payload, "The request could not be completed."), {
        status: response.status,
        kind,
        payload,
      });
      const retryAfter = Number(response.headers.get('retry-after'));
      if (response.status === 503 && Number.isFinite(retryAfter) && retryAfter > 0) failure.retryAfterMs = Math.min(5000, retryAfter * 1000);
      throw authenticationError(failure);
    }
    if (!SAFE_METHODS.has(method)) {
      try { onMutationCommitted?.({ url, method }); } catch {}
    }
    return payload;
  }

  async function blob(path, options = {}) {
    const url = normalizeApiPath(path);
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        method: "GET",
        credentials: "include",
        cache: options.cache || "no-store",
        headers: { Accept: "image/jpeg,image/png", ...(options.headers || {}) },
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new LpcApiError("We couldn’t connect to LPC. Please try again.", { kind: "network", cause: error });
    }
    if (!response.ok) {
      const payload = await readPayload(response);
      const kind = authenticationLossResponse(response.status, payload)
        ? "authentication"
        : classifyStatus(response.status);
      throw authenticationError(new LpcApiError(errorMessage(payload, "The file could not be opened."), {
        status: response.status,
        kind,
        payload,
      }));
    }
    return response.blob();
  }

  async function upload(path, formData, { signal, onProgress } = {}) {
    const url = normalizeApiPath(path);
    if (!(formData instanceof FormData)) throw new TypeError("LPC uploads require FormData.");
    const token = await csrfToken(signal);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => xhr.abort();
      xhr.open("POST", url);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader("X-CSRF-Token", token);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && typeof onProgress === "function") {
          onProgress(Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))));
        }
      });
      xhr.addEventListener("load", () => {
        let payload = null;
        try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { payload = xhr.responseText || null; }
        if (xhr.status >= 200 && xhr.status < 300) {
          try { onMutationCommitted?.({ url, method: "POST" }); } catch {}
          finish(resolve, payload);
          return;
        }
        const kind = authenticationLossResponse(xhr.status, payload)
          ? "authentication"
          : classifyStatus(xhr.status);
        finish(reject, authenticationError(new LpcApiError(errorMessage(payload, "The upload could not be completed."), {
          status: xhr.status,
          kind,
          payload,
        })));
      });
      xhr.addEventListener("error", () => finish(reject, new LpcApiError("We couldn’t connect to LPC. Please try again.", { kind: "network" })));
      xhr.addEventListener("abort", () => finish(reject, new DOMException("The upload was canceled.", "AbortError")));
      if (signal?.aborted) {
        finish(reject, new DOMException("The upload was canceled.", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      xhr.send(formData);
    });
  }

  return Object.freeze({
    get(path, options = {}) {
      return request(path, { ...options, method: "GET" });
    },
    post(path, body, options = {}) {
      return request(path, {
        ...options,
        method: "POST",
        body: body instanceof FormData ? body : JSON.stringify(body ?? {}),
      });
    },
    upload,
    blob,
    request,
  });
}
