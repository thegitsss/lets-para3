import { persistSession } from "./auth.js";
import { showAlert } from "./utils/dialogs.js";

const API_BASE = "/api";

const clearLocalSession = () => {
  if (window.clearStoredSession) window.clearStoredSession();
  try {
    localStorage.removeItem("lpc_user");
  } catch {}
};

const resolveDashboardTarget = (userOrRole) => {
  const user = userOrRole && typeof userOrRole === "object" ? userOrRole : null;
  const normalizedRole = String(user?.role || userOrRole || "").toLowerCase();
  if (normalizedRole === "admin") return "admin-dashboard.html";
  if (normalizedRole === "director") return "director-portal.html";
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
    } catch (error) {
      console.warn("[login] existing-session check failed", error);
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
      void showAlert(stagedSignupToast, { title: "Account update" });
    }
  }

  const disabledMsg = sessionStorage.getItem("disabledAccountMsg");
  if (disabledMsg) {
    sessionStorage.removeItem("disabledAccountMsg");
    if (toastHelper) {
      toastHelper.show(disabledMsg, { targetId: "toastBanner", type: "err" });
    } else {
      void showAlert(disabledMsg, { title: "Account unavailable" });
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
  const passkeyLoginBtn = document.getElementById("passkeyLoginBtn");
  const twoFactorPasskeyAction = document.getElementById("twoFactorPasskeyAction");
  const twoFactorPasskeyBtn = document.getElementById("twoFactorPasskeyBtn");
  const webAuthnBrowser = window.SimpleWebAuthnBrowser;
  const passkeysSupported = Boolean(webAuthnBrowser?.browserSupportsWebAuthn?.());
  let pendingTwoFactorChallenge = "";
  let useBackupCode = false;

  const notify = (message, type = "err") => {
    if (toastHelper) {
      toastHelper.show(message, { targetId: "toastBanner", type });
    } else {
      void showAlert(message, { title: type === "err" ? "Sign-in unavailable" : "Notice" });
    }
  };

  const checkHealth = async () => {
    try {
      const res = await fetch(`${API_BASE}/health`, { credentials: "include" });
      if (!res.ok) return;
    } catch {
      notify("Unable to reach the server. Please check your connection.");
    }
  };

  checkHealth();

  if (!passkeysSupported && passkeyLoginBtn) passkeyLoginBtn.hidden = true;

  const performPasskeyAuthentication = async (challengeToken = "", { useBrowserAutofill = false } = {}) => {
    if (!passkeysSupported) throw new Error("Passkeys are not supported by this browser or device.");
    const csrfToken = await fetchCsrfToken();
    const headers = {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    };
    const optionsRes = await fetchWithTimeout(`${API_BASE}/auth/passkeys/authentication-options`, {
      method: "POST",
      credentials: "include",
      suppressToast: useBrowserAutofill,
      headers,
      body: JSON.stringify(challengeToken ? { challengeToken } : {}),
    });
    const optionsData = await optionsRes.json().catch(() => ({}));
    if (!optionsRes.ok) throw new Error(optionsData?.error || "No passkey is available for this sign-in.");
    const response = await webAuthnBrowser.startAuthentication({
      optionsJSON: optionsData.options,
      useBrowserAutofill,
    });
    const verifyRes = await fetchWithTimeout(`${API_BASE}/auth/passkeys/authenticate`, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({
        challengeId: optionsData.challengeId,
        response,
        ...(challengeToken ? { challengeToken } : {}),
      }),
    });
    const data = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) throw new Error(data?.error || "Passkey sign-in failed.");
    persistSession({ user: data.user || null });
    window.location.href = resolveDashboardTarget(data.user);
  };

  passkeyLoginBtn?.addEventListener("click", async () => {
    passkeyLoginBtn.disabled = true;
    try {
      await performPasskeyAuthentication();
    } catch (err) {
      if (err?.name !== "NotAllowedError") notify(err?.message || "Passkey sign-in was cancelled or failed.");
    } finally {
      passkeyLoginBtn.disabled = false;
    }
  });

  const startPasskeyAutofill = async () => {
    if (!passkeysSupported || !window.PublicKeyCredential?.isConditionalMediationAvailable) return;
    try {
      const available = await window.PublicKeyCredential.isConditionalMediationAvailable();
      if (!available) return;
      await performPasskeyAuthentication("", { useBrowserAutofill: true });
    } catch (err) {
      // Conditional UI stays silent unless the user deliberately selects a passkey.
      // Explicit passkey-button errors continue to use the visible notification above.
      if (err?.name !== "AbortError" && err?.name !== "NotAllowedError") {
        console.warn("[login] passkey autofill unavailable", err);
      }
    }
  };

  void startPasskeyAutofill();

  twoFactorPasskeyBtn?.addEventListener("click", async () => {
    twoFactorPasskeyBtn.disabled = true;
    try {
      await performPasskeyAuthentication(pendingTwoFactorChallenge);
    } catch (err) {
      if (err?.name !== "NotAllowedError") notify(err?.message || "Passkey verification was cancelled or failed.");
    } finally {
      twoFactorPasskeyBtn.disabled = false;
    }
  });

  const showTwoFactorPanel = ({ challengeToken = "", destination = "", method = "email", passkeyAvailable = false } = {}) => {
    pendingTwoFactorChallenge = challengeToken || pendingTwoFactorChallenge;
    if (twoFactorMessage) {
      twoFactorMessage.textContent = method === "authenticator"
        ? "Enter the current six-digit code from your authenticator app."
        : destination
          ? `Enter the verification code sent to ${destination}.`
          : "Enter the verification code we just sent you.";
    }
    if (twoFactorPasskeyAction) twoFactorPasskeyAction.hidden = !(passkeysSupported && passkeyAvailable);
    if (loginPanel) loginPanel.classList.add("hidden");
    if (twoFactorPanel) twoFactorPanel.classList.remove("hidden");
    if (twoFactorCode) twoFactorCode.focus();
  };

  const resetTwoFactorPanel = () => {
    pendingTwoFactorChallenge = "";
    useBackupCode = false;
    if (twoFactorCode) {
      twoFactorCode.value = "";
      twoFactorCode.placeholder = "6-digit code";
    }
    if (twoFactorBackupToggle) {
      twoFactorBackupToggle.textContent = "Use a backup code";
    }
    if (twoFactorPasskeyAction) twoFactorPasskeyAction.hidden = true;
    if (twoFactorPanel) twoFactorPanel.classList.add("hidden");
    if (loginPanel) loginPanel.classList.remove("hidden");
  };

  const restoreLoginButton = (label) => {
    if (!loginButton) return;
    loginButton.disabled = false;
    loginButton.textContent = label || "Sign in";
  };

  const handleGoogleReturn = async () => {
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get("google_error");
    if (errorCode) {
      const messages = {
        invalid_state: "Google sign-in expired. Please try again.",
        cancelled: "Google sign-in was cancelled.",
        oauth_failed: "Google could not verify your account. Please try again.",
        identity_invalid: "Google did not return a verified identity.",
        matching_email_unlinked:
          "An LPC account already uses that email. Sign in with your email and password to link Google sign-in.",
        pending: "Your account is still under review. We’ll email you when the review is complete.",
        not_approved: "Your application was not approved. Contact support if you have questions.",
        disabled: "This account has been deactivated.",
        maintenance: "The platform is in maintenance mode. Please try again soon.",
        email_unverified: "Please verify your email before signing in.",
        two_factor_unavailable: "Unable to send a verification code. Please try again.",
        unavailable: "Google sign-in is temporarily unavailable.",
      };
      notify(messages[errorCode] || "Google sign-in could not be completed.");
    }

    if (params.get("google_2fa") !== "1") return;
    try {
      const response = await fetch(`${API_BASE}/auth/google/2fa-context`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.challengeToken) {
        throw new Error(payload?.msg || "Google sign-in session expired. Please try again.");
      }
      showTwoFactorPanel(payload);
    } catch (err) {
      notify(err.message || "Google sign-in session expired. Please try again.");
    }
  };

  handleGoogleReturn();

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
      } catch (error) {
        console.warn("[login] response was not valid JSON", error);
      }

      if (!res.ok) {
        clearLocalSession();
        const msg = data?.error || data?.msg || data?.message || "Login failed";
        notify(msg);
        return;
      }

      if (data?.twoFactorRequired) {
        shouldRestoreButton = true;
        showTwoFactorPanel(data);
        return;
      }

      shouldRestoreButton = false;
      persistSession({ user: data.user || null });

      window.location.href = resolveDashboardTarget(data.user);
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
    const password = document.getElementById("password").value;
    const originalLabel = loginButton?.textContent || "Sign in";

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
          void showAlert("Enter your verification code.", { title: "Verification required" });
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
          body: JSON.stringify({ challengeToken: pendingTwoFactorChallenge, code }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = payload?.error || payload?.msg || payload?.message || "Verification failed.";
          if (toastHelper) {
            toastHelper.show(msg, { targetId: "toastBanner", type: "err" });
          } else {
            void showAlert(msg, { title: "Verification unsuccessful" });
          }
          return;
        }
        persistSession({ user: payload.user || null });
        window.location.href = resolveDashboardTarget(payload.user);
      } catch (err) {
        if (err?.name === "AbortError") {
          if (toastHelper) {
            toastHelper.show("Verification timed out. Try again.", { targetId: "toastBanner", type: "err" });
          } else {
            void showAlert("Verification timed out. Try again.", { title: "Verification timed out" });
          }
          return;
        }
        if (toastHelper) {
          toastHelper.show("Verification error. Try again.", { targetId: "toastBanner", type: "err" });
        } else {
          void showAlert("Verification error. Try again.", { title: "Verification unsuccessful" });
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
