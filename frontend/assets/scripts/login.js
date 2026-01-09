const API_BASE = "/api";
const RECAPTCHA_SITE_KEY = window.RECAPTCHA_SITE_KEY || "";

function getRecaptchaToken(action) {
  if (!RECAPTCHA_SITE_KEY || !window.grecaptcha) return Promise.resolve("");
  return new Promise((resolve) => {
    try {
      window.grecaptcha.ready(() => {
        window.grecaptcha
          .execute(RECAPTCHA_SITE_KEY, { action })
          .then((token) => resolve(token))
          .catch(() => resolve(""));
      });
    } catch {
      resolve("");
    }
  });
}

const clearLocalSession = () => {
  if (window.clearStoredSession) window.clearStoredSession();
  try {
    localStorage.removeItem("lpc_user");
  } catch {}
};

let skipInit = false;
try {
  const rawUser = localStorage.getItem("lpc_user");
  const parsedUser = rawUser ? JSON.parse(rawUser) : null;
  const role = (parsedUser?.role || "").toLowerCase();
  const status = (parsedUser?.status || "").toLowerCase();
  if (role && status === "approved") {
    if (window.redirectUserDashboard) {
      window.redirectUserDashboard(role);
    } else {
      window.location.href =
        role === "admin"
          ? "admin-dashboard.html"
          : role === "paralegal"
          ? "dashboard-paralegal.html"
          : "dashboard-attorney.html";
    }
    skipInit = true;
  } else {
    clearLocalSession();
  }
} catch {
  clearLocalSession();
}

const toastHelper = window.toastUtils;
const stagedSignupToast = sessionStorage.getItem("signupToast");
if (stagedSignupToast) {
  sessionStorage.removeItem("signupToast");
  if (toastHelper) {
    toastHelper.show(stagedSignupToast, { targetId: "toastBanner", type: "info" });
  } else {
    alert(stagedSignupToast);
  }
}

const disabledMsg = sessionStorage.getItem("disabledAccountMsg");
if (disabledMsg) {
  sessionStorage.removeItem("disabledAccountMsg");
  if (toastHelper) {
    toastHelper.show(disabledMsg, { targetId: "toastBanner", type: "err" });
  } else {
    alert(disabledMsg);
  }
}

async function fetchCsrfToken() {
  try {
    const res = await fetch(`${API_BASE}/csrf`, { credentials: "include" });
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    return data?.csrfToken || "";
  } catch {
    return "";
  }
}

if (!skipInit) {
  clearLocalSession();

  const loginForm = document.getElementById("loginForm");
  const loginButton = loginForm?.querySelector("button[type=\"submit\"]");
  loginForm?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value.trim();
    const originalLabel = loginButton?.textContent || "Log In";
    let shouldRestoreButton = true;

    try {
      if (loginButton) {
        loginButton.disabled = true;
        loginButton.textContent = "Logging in…";
      }
      const csrfToken = await fetchCsrfToken();
      const recaptchaToken = await getRecaptchaToken("login");
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ email, password, recaptchaToken }),
      });

      let data = {};
      try {
        data = await res.json();
      } catch {}

      if (!res.ok) {
        clearLocalSession();
        const msg = data?.error || data?.msg || data?.message || "Login failed";
        if (toastHelper) {
          toastHelper.show(msg, { targetId: "toastBanner", type: "err" });
        } else {
          alert(msg);
        }
        return;
      }

      shouldRestoreButton = false;
      localStorage.setItem("lpc_user", JSON.stringify(data.user || {}));

      if (data.user.role === "admin") {
        window.location.href = "admin-dashboard.html";
      } else if (data.user.role === "paralegal") {
        window.location.href = "dashboard-paralegal.html";
      } else {
        window.location.href = "dashboard-attorney.html";
      }
    } catch (err) {
      console.error(err);
      clearLocalSession();
      if (toastHelper) {
        toastHelper.show("Network error during login", { targetId: "toastBanner", type: "err" });
      } else {
        alert("Network error during login");
      }
    } finally {
      if (shouldRestoreButton && loginButton) {
        loginButton.disabled = false;
        loginButton.textContent = originalLabel;
      }
    }
  });
}
