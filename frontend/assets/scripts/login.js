import { fetchCSRF, persistSession } from "./auth.js";
import "./utils/login-return-target.js";
import { showAlert } from "./utils/dialogs.js";
import { activateDialogFocus, deactivateDialogFocus } from "./utils/dialog-focus.js";
import { runPasskeyCeremony } from "./utils/passkey-ceremony.js";

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
  if (normalizedRole === "paralegal") return "paralegal-v2.html#/home";
  return "attorney-v2.html#/home";
};

const resolveRequestedMemberTarget = (userOrRole) => {
  const user = userOrRole && typeof userOrRole === "object" ? userOrRole : null;
  const normalizedRole = String(user?.role || userOrRole || "").toLowerCase();
  if (!["attorney", "paralegal"].includes(normalizedRole)) return "";

  const requested = new URLSearchParams(window.location.search).get("next");
  if (!requested) return "";
  return window.LPCLoginReturn.resolve(requested, normalizedRole, window.location.origin);
};

const googleReturnTarget = resolveRequestedMemberTarget("paralegal") || resolveRequestedMemberTarget("attorney");
const googleLoginLink = document.querySelector('a[href="/api/auth/google?intent=login"]');
if (googleReturnTarget && googleLoginLink) googleLoginLink.href = `/api/auth/google?intent=login&next=${encodeURIComponent(googleReturnTarget)}`;

const resolvePostLoginTarget = async (userOrRole) => {
  const requested = resolveRequestedMemberTarget(userOrRole);
  if (requested) return requested;
  if (userOrRole && typeof userOrRole === "object" && ["attorney", "paralegal"].includes(userOrRole.role)) {
    const { defaultWorkspaceDestination } = await import("./utils/workspace-release.mjs");
    return await defaultWorkspaceDestination(userOrRole) || resolveDashboardTarget(userOrRole);
  }
  return resolveDashboardTarget(userOrRole);
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
        window.location.href = await resolvePostLoginTarget({ ...session.user, role: session.user.role || session.role || role });
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

async function fetchCsrfToken(force = false) {
  try {
    return await fetchCSRF(force);
  } catch {
    return "";
  }
}

// The deadline covers CSRF, the credential request and its response body.
// A late CSRF response must never start a credential request after timeout.
async function postSignIn(endpoint, body, { suppressToast = endpoint === "/auth/login" } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("Sign-in timed out.", "AbortError"));
    }, 12000);
  });
  try {
    return await Promise.race([(async () => {
      const csrfToken = await fetchCsrfToken(true);
      controller.signal.throwIfAborted();
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        suppressToast,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(error => {
        if (controller.signal.aborted) throw error;
        return {};
      });
      controller.signal.throwIfAborted();
      return { res, data };
    })(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const consumeSessionNotice = (key) => {
  try {
    const value = sessionStorage.getItem(key);
    if (value) sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
};

const initLogin = () => {
  if (new URLSearchParams(window.location.search).get("reason") === "session-expired") {
    const title = document.querySelector(".login-title");
    if (title) {
      title.textContent = "Please sign in again";
      const notice = document.createElement("p");
      notice.className = "login-session-notice";
      notice.textContent = "Your session has expired.";
      notice.setAttribute("role", "status");
      title.after(notice);
    }
  }
  const toastHelper = window.toastUtils;
  const stagedSignupToast = consumeSessionNotice("signupToast");
  if (stagedSignupToast) {
    if (toastHelper) {
      toastHelper.show(stagedSignupToast, { targetId: "toastBanner", type: "info" });
    } else {
      void showAlert(stagedSignupToast, { title: "Account update" });
    }
  }

  const disabledMsg = consumeSessionNotice("disabledAccountMsg");
  if (disabledMsg) {
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
  let loginPending = false;
  let factorPending = false;

  const verificationDialog = document.getElementById("loginVerificationDialog");
  const verificationEmail = document.getElementById("loginVerificationEmail");
  const verificationDescription = document.getElementById("loginVerificationDescription");
  const showVerificationRecovery = (email = "", message = "") => {
    if (!verificationDialog) return;
    document.getElementById("toastBanner")?.classList.remove("show");
    if (email && verificationEmail) verificationEmail.value = email;
    if (verificationDescription) verificationDescription.textContent = message || "Please verify your email address before signing in.";
    if (verificationDialog.open) return;
    verificationDialog.showModal();
    activateDialogFocus(verificationDialog, {
      initialFocus: verificationEmail?.value
        ? verificationDialog.querySelector('button[type="submit"]:not([disabled])') || verificationEmail
        : verificationEmail,
      returnFocus: loginButton,
      onEscape: () => verificationDialog.close(),
    });
  };
  verificationDialog?.querySelector("[data-verification-close]")?.addEventListener("click", () => verificationDialog.close());
  verificationDialog?.addEventListener("close", () => deactivateDialogFocus(verificationDialog));

  const applicationStatus = document.createElement('p');
  applicationStatus.className='login-application-status'; applicationStatus.hidden=true;
  applicationStatus.setAttribute('role','status'); applicationStatus.setAttribute('aria-live','polite');
  loginButton?.parentElement?.insertBefore(applicationStatus,loginButton);
  const showApplicationStatus = message => {applicationStatus.textContent=message;applicationStatus.hidden=false;};
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

  const passkeyPreparations = new Map();
  function preparePasskeySignIn(challengeToken = "") {
    const cached = passkeyPreparations.get(challengeToken);
    if (cached && Date.now() - cached.createdAt < 240000) return cached.promise;
    const record = { createdAt: Date.now(), data: null, promise: null };
    record.promise = (async () => {
      const { res, data } = await postSignIn("/auth/passkeys/authentication-options", challengeToken ? { challengeToken } : {}, { suppressToast: true });
      if (!res.ok) throw new Error(res.status >= 500
        ? "Passkey sign-in is temporarily unavailable. Please sign in with your password and try again."
        : data?.error || data?.msg || "Unable to start passkey sign-in. Please try again.");
      if (!data?.challengeId || !data?.options?.challenge) throw new Error("Unable to prepare passkey sign-in. Please try again.");
      record.data = data;
      return data;
    })().catch(error => { if (passkeyPreparations.get(challengeToken) === record) passkeyPreparations.delete(challengeToken); throw error; });
    passkeyPreparations.set(challengeToken, record);
    return record.promise;
  }
  const performPasskeyAuthentication = async (challengeToken = "") => {
    if (!passkeysSupported) throw new Error("Passkeys are not supported by this browser or device.");
    const cached = passkeyPreparations.get(challengeToken);
    if (!cached?.data || Date.now() - cached.createdAt >= 240000) {
      await preparePasskeySignIn(challengeToken);
      notify("Passkey sign-in is ready. Select the passkey button again to continue.", "ok");
      return;
    }
    passkeyPreparations.delete(challengeToken);
    const optionsData = cached.data;
    // Options are ready before the click: the browser call starts immediately.
    const response = await runPasskeyCeremony(() => webAuthnBrowser.startAuthentication({ optionsJSON: optionsData.options }), {
      action: "sign-in", cancel: () => webAuthnBrowser.WebAuthnAbortService?.cancelCeremony(),
    });
    const { res, data } = await postSignIn("/auth/passkeys/authenticate", {
      challengeId: optionsData.challengeId, response, ...(challengeToken ? { challengeToken } : {}),
    }, { suppressToast: true });
    if (!res.ok) throw new Error(data?.error || data?.msg || "Passkey sign-in failed.");
    persistSession({ user: data.user || null });
    window.location.href = await resolvePostLoginTarget(data.user);
  };
  passkeyLoginBtn?.addEventListener("click", async () => {
    passkeyLoginBtn.disabled = true;
    try { await performPasskeyAuthentication(); }
    catch (error) {
      notify(error?.name === "NotAllowedError" || error?.name === "AbortError" ? "Passkey sign-in was canceled. You can try again or use your password." : error?.message || "Passkey sign-in failed.");
      void preparePasskeySignIn().catch(() => {});
    } finally { passkeyLoginBtn.disabled = false; }
  });
  if (passkeysSupported && passkeyLoginBtn) {
    passkeyLoginBtn.disabled = true;
    void preparePasskeySignIn().catch(() => {}).finally(() => { passkeyLoginBtn.disabled = false; });
  }
  twoFactorPasskeyBtn?.addEventListener("click", async () => {
    if (factorPending || !pendingTwoFactorChallenge) return;
    factorPending = true;
    const controls = [document.getElementById("twoFactorVerifyBtn"), twoFactorBackupToggle, twoFactorBackBtn, twoFactorPasskeyBtn].filter(Boolean);
    const disabledBefore = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    try { await performPasskeyAuthentication(pendingTwoFactorChallenge); }
    catch (error) {
      notify(error?.name === "NotAllowedError" || error?.name === "AbortError" ? "Passkey verification was canceled. You can try again." : error?.message || "Passkey verification failed.");
      void preparePasskeySignIn(pendingTwoFactorChallenge).catch(() => {});
    } finally {
      factorPending = false;
      controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
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
    if (passkeysSupported && passkeyAvailable && twoFactorPasskeyBtn) {
      twoFactorPasskeyBtn.disabled = true;
      void preparePasskeySignIn(challengeToken).catch(() => {}).finally(() => { twoFactorPasskeyBtn.disabled = false; });
    }
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
        pending: "We’re reviewing your application. We’ll email you when your account is ready.",
        not_approved: "Your application was not approved. Contact support if you have questions.",
        disabled: "This account has been deactivated.",
        maintenance: "The platform is in maintenance mode. Please try again soon.",
        email_unverified: "Please verify your email before signing in.",
        two_factor_unavailable: "Unable to send a verification code. Please try again.",
        unavailable: "Google sign-in is temporarily unavailable.",
      };
      if (errorCode === "pending") {
        showApplicationStatus(messages.pending);
      } else if (errorCode === "email_unverified") {
        showVerificationRecovery("", messages[errorCode]);
      } else {
        notify(messages[errorCode] || "Google sign-in could not be completed.");
      }
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
    if (loginPending) return;
    loginPending = true;
    let shouldRestoreButton = true;

    try {
      if (loginButton) {
        loginButton.disabled = true;
        loginButton.textContent = "Signing in…";
      }
      applicationStatus.hidden=true;
      const { res, data } = await postSignIn("/auth/login", { email, password });

      if (!res.ok) {
        clearLocalSession();
        const msg = res.status === 401 && [data?.error, data?.msg, data?.message].includes("Invalid email or password.")
          ? "Your email and password don’t match. Please try again."
          : data?.error || data?.msg || data?.message || "Sign-in failed";
        if (data?.emailVerificationRequired === true) {
          showVerificationRecovery(email, msg);
        } else if (res.status === 403 && msg === "We’re reviewing your application. We’ll email you when your account is ready.") {
          showApplicationStatus(msg);
        } else {
          applicationStatus.hidden=true;
          notify(msg);
        }
        return;
      }

      if (data?.twoFactorRequired) {
        shouldRestoreButton = true;
        showTwoFactorPanel(data);
        return;
      }

      persistSession({ user: data.user || null });
      const target = await resolvePostLoginTarget(data.user);
      shouldRestoreButton = false;
      window.location.href = target;
    } catch (err) {
      console.error(err);
      clearLocalSession();
      if (err?.name === "AbortError") {
        notify("Sign-in timed out. Please try again.");
      } else {
        notify("A network error interrupted sign-in. Please try again.");
      }
    } finally {
      if (shouldRestoreButton) {
        loginPending = false;
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
      if (factorPending) return;
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
      if (factorPending) return;
      resetTwoFactorPanel();
    });
  }

  if (twoFactorForm) {
    twoFactorForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (factorPending) return;
      const code = String(twoFactorCode?.value || "").trim();
      if (!code) {
        if (toastHelper) {
          toastHelper.show("Enter your verification code.", { targetId: "toastBanner", type: "err" });
        } else {
          void showAlert("Enter your verification code.", { title: "Verification required" });
        }
        return;
      }
      factorPending = true;
      const controls = [document.getElementById("twoFactorVerifyBtn"), twoFactorBackupToggle, twoFactorBackBtn, twoFactorPasskeyBtn].filter(Boolean);
      const disabledBefore = controls.map(control => control.disabled);
      controls.forEach(control => { control.disabled = true; });
      let completed = false;
      try {
        const endpoint = useBackupCode ? "/auth/2fa-backup" : "/auth/2fa-verify";
        const { res, data: payload } = await postSignIn(endpoint, { challengeToken: pendingTwoFactorChallenge, code });
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
        const target = await resolvePostLoginTarget(payload.user);
        completed = true;
        window.location.href = target;
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
      } finally {
        if (!completed) {
          factorPending = false;
          controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
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
