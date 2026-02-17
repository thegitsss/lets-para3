const API_BASE = "/api";

const clearLocalSession = () => {
  if (window.clearStoredSession) window.clearStoredSession();
  try {
    localStorage.removeItem("lpc_user");
  } catch {}
};

const resolveDashboardTarget = (role) => {
  const normalizedRole = String(role || "").toLowerCase();
  if (normalizedRole === "admin") return "admin-dashboard.html";
  if (normalizedRole === "paralegal") return "dashboard-paralegal.html";
  return "dashboard-attorney.html";
};

const maybeRedirectFromStoredUser = async () => {
  let parsedUser = null;
  try {
    const rawUser = localStorage.getItem("lpc_user");
    parsedUser = rawUser ? JSON.parse(rawUser) : null;
  } catch {
    clearLocalSession();
    return false;
  }
  const role = (parsedUser?.role || "").toLowerCase();
  const status = (parsedUser?.status || "").toLowerCase();
  if (!role || status !== "approved") {
    clearLocalSession();
    return false;
  }

  if (typeof window.checkSession === "function") {
    try {
      const session = await window.checkSession(undefined, { redirectOnFail: false });
      if (session?.user) {
        const targetRole = session.role || role;
        if (window.redirectUserDashboard) {
          window.redirectUserDashboard(targetRole);
        } else {
          window.location.href = resolveDashboardTarget(targetRole);
        }
        return true;
      }
    } catch {
      // fall through to clear local session
    }
  }

  clearLocalSession();
  return false;
};

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

function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal || controller.signal;
  return fetch(url, { ...options, signal }).finally(() => clearTimeout(id));
}

const initLogin = () => {
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

  clearLocalSession();

  const loginForm = document.getElementById("loginForm");
  const loginButton = loginForm?.querySelector("button[type=\"submit\"]");
  const loginPanel = document.getElementById("loginPanel");
  const twoFactorPanel = document.getElementById("twoFactorPanel");
  const twoFactorForm = document.getElementById("twoFactorForm");
  const twoFactorCode = document.getElementById("twoFactorCode");
  const twoFactorMessage = document.getElementById("twoFactorMessage");
  const twoFactorBackupToggle = document.getElementById("twoFactorBackupToggle");
  const twoFactorBackBtn = document.getElementById("twoFactorBackBtn");
  let pendingTwoFactorEmail = "";
  let useBackupCode = false;

  const notify = (message, type = "err") => {
    if (toastHelper) {
      toastHelper.show(message, { targetId: "toastBanner", type });
    } else {
      alert(message);
    }
  };

  const checkHealth = async () => {
    try {
      const res = await fetch(`${API_BASE}/health`, { credentials: "include" });
      if (!res.ok) {
        notify("Service is temporarily unavailable. Please try again shortly.");
      }
    } catch {
      notify("Unable to reach the server. Please check your connection.");
    }
  };

  checkHealth();

  const showTwoFactorPanel = (email) => {
    pendingTwoFactorEmail = email || pendingTwoFactorEmail;
    if (twoFactorMessage) {
      twoFactorMessage.textContent = pendingTwoFactorEmail
        ? `Enter the verification code sent to ${pendingTwoFactorEmail}.`
        : "Enter the verification code we just sent you.";
    }
    if (loginPanel) loginPanel.classList.add("hidden");
    if (twoFactorPanel) twoFactorPanel.classList.remove("hidden");
    if (twoFactorCode) twoFactorCode.focus();
  };

  const resetTwoFactorPanel = () => {
    pendingTwoFactorEmail = "";
    useBackupCode = false;
    if (twoFactorCode) {
      twoFactorCode.value = "";
      twoFactorCode.placeholder = "6-digit code";
    }
    if (twoFactorBackupToggle) {
      twoFactorBackupToggle.textContent = "Use a backup code";
    }
    if (twoFactorPanel) twoFactorPanel.classList.add("hidden");
    if (loginPanel) loginPanel.classList.remove("hidden");
  };

  const restoreLoginButton = (label) => {
    if (!loginButton) return;
    loginButton.disabled = false;
    loginButton.textContent = label || "Log In";
  };

  const submitLogin = async ({ email, password, originalLabel }) => {
    let shouldRestoreButton = true;

    try {
      if (loginButton) {
        loginButton.disabled = true;
        loginButton.textContent = "Logging in…";
      }
      const csrfToken = await fetchCsrfToken();
      const res = await fetchWithTimeout(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });

      let data = {};
      try {
        data = await res.json();
      } catch {}

      if (!res.ok) {
        clearLocalSession();
        const msg = data?.error || data?.msg || data?.message || "Login failed";
        notify(msg);
        return;
      }

      if (data?.twoFactorRequired) {
        shouldRestoreButton = true;
        showTwoFactorPanel(data.email || email);
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
      if (err?.name === "AbortError") {
        notify("Login timed out. Please try again.");
      } else {
        notify("Network error during login");
      }
    } finally {
      if (shouldRestoreButton) {
        restoreLoginButton(originalLabel);
      }
    }
  };

  loginForm?.addEventListener("submit", (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value.trim();
    const originalLabel = loginButton?.textContent || "Log In";

    submitLogin({ email, password, originalLabel });
  });

  if (twoFactorBackupToggle) {
    twoFactorBackupToggle.addEventListener("click", () => {
      useBackupCode = !useBackupCode;
      if (twoFactorBackupToggle) {
        twoFactorBackupToggle.textContent = useBackupCode ? "Use a verification code" : "Use a backup code";
      }
      if (twoFactorCode) {
        twoFactorCode.value = "";
        twoFactorCode.placeholder = useBackupCode ? "Backup code" : "6-digit code";
        twoFactorCode.focus();
      }
    });
  }

  if (twoFactorBackBtn) {
    twoFactorBackBtn.addEventListener("click", () => {
      resetTwoFactorPanel();
    });
  }

  if (twoFactorForm) {
    twoFactorForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = String(twoFactorCode?.value || "").trim();
      if (!code) {
        if (toastHelper) {
          toastHelper.show("Enter your verification code.", { targetId: "toastBanner", type: "err" });
        } else {
          alert("Enter your verification code.");
        }
        return;
      }
      try {
        const csrfToken = await fetchCsrfToken();
        const endpoint = useBackupCode ? "/auth/2fa-backup" : "/auth/2fa-verify";
        const res = await fetchWithTimeout(`${API_BASE}${endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
          },
          credentials: "include",
          body: JSON.stringify({ email: pendingTwoFactorEmail, code }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = payload?.error || payload?.msg || payload?.message || "Verification failed.";
          if (toastHelper) {
            toastHelper.show(msg, { targetId: "toastBanner", type: "err" });
          } else {
            alert(msg);
          }
          return;
        }
        localStorage.setItem("lpc_user", JSON.stringify(payload.user || {}));
        if (payload.user?.role === "admin") {
          window.location.href = "admin-dashboard.html";
        } else if (payload.user?.role === "paralegal") {
          window.location.href = "dashboard-paralegal.html";
        } else {
          window.location.href = "dashboard-attorney.html";
        }
      } catch (err) {
        if (err?.name === "AbortError") {
          if (toastHelper) {
            toastHelper.show("Verification timed out. Try again.", { targetId: "toastBanner", type: "err" });
          } else {
            alert("Verification timed out. Try again.");
          }
          return;
        }
        if (toastHelper) {
          toastHelper.show("Verification error. Try again.", { targetId: "toastBanner", type: "err" });
        } else {
          alert("Verification error. Try again.");
        }
      }
    });
  }
};

(async () => {
  const redirected = await maybeRedirectFromStoredUser();
  if (!redirected) {
    initLogin();
  }
})();
