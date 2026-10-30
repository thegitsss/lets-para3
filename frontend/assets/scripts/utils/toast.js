(function (global) {
  const STORAGE_KEY = "lpDashboardToast";
  let hideTimer;
  const AUTO_TOAST_DISABLED = Boolean(global && global.__toastDisableAutoFetch);
  const STATUS_MESSAGES = {
    401: "Your session expired. Please sign in again.",
    403: "You don’t have permission to perform this action.",
    404: "Item not found.",
    409: "This action has already been taken.",
    413: "File too large. Max size is 20MB.",
    415: "Unsupported file type. Allowed: PDF, DOCX, JPG, PNG.",
  };
  const SERVER_ERRORS = new Set([500, 502, 503]);

  function mapStatusToMessage(status) {
    if (!status && status !== 0) return "";
    if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
    if (SERVER_ERRORS.has(status)) return "Something went wrong. Please try again.";
    return "";
  }

  function stage(message, type = "info") {
    if (!message) return;
    const payload = { message, type };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function consume() {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("Invalid toast payload, returning raw string.", err);
      return { message: raw, type: "info" };
    }
  }

  function show(message, options = {}) {
    const { targetId = "toastBanner", type = "info", duration = 0 } = options;
    const words = String(message || "").trim().split(/\s+/).filter(Boolean).length;
    const readingTime = Math.max(type === "err" || type === "error" ? 15000 : 10000, 3000 + words * 500);
    const displayTime = Math.max(readingTime, Number(duration) || 0);
    const el = typeof targetId === "string" ? document.getElementById(targetId) : targetId;
    if (!el) return;
    el.textContent = message;
    el.dataset.toastType = type;
    el.classList.add("show");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.classList.remove("show"), displayTime);
  }

  function showStatus(status) {
    const msg = mapStatusToMessage(status);
    if (msg) show(msg, { targetId: "toastBanner", type: "err" });
  }

  const toastUtils = {
    STORAGE_KEY,
    stage,
    consume,
    show,
    mapStatusToMessage,
    showStatus,
  };

  global.toastUtils = toastUtils;

  const originalFetch =
    typeof global.fetch === "function" ? global.fetch.bind(global) : null;
  if (originalFetch && !global.__toastFetchPatched && !AUTO_TOAST_DISABLED) {
    global.fetch = async (...args) => {
      const response = await originalFetch(...args);
      try {
        const request = args[0];
        const options = args[1] || {};
        const suppressToast = Boolean(
          (options && options.suppressToast) ||
            (typeof request === "object" && request && request.suppressToast)
        );
        const url =
          typeof request === "string"
            ? request
            : typeof request === "object" && request
            ? request.url
            : "";
        const method =
          String(
            (options && options.method) ||
              (typeof request === "object" && request ? request.method : "") ||
              "GET"
          ).toUpperCase();
        const isReadRequest = method === "GET" || method === "HEAD";
        if (
          !suppressToast &&
          response &&
          !response.ok &&
          typeof url === "string" &&
          url.includes("/api/") &&
          !(isReadRequest && response.status === 404)
        ) {
          showStatus(response.status);
        }
      } catch {
        /* noop */
      }
      return response;
    };
    global.__toastFetchPatched = true;
  }
})(window);
