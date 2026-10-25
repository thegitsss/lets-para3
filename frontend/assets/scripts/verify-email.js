import { secureFetch } from './auth.js';

document.addEventListener("DOMContentLoaded", () => {
  const panel = document.getElementById("verificationPanel");
  const eyebrow = document.getElementById("verificationEyebrow");
  const title = document.getElementById("verificationTitle");
  const status = document.getElementById("verificationStatus");
  const action = document.getElementById("verificationAction");
  const confirmForm = document.getElementById("verificationConfirmForm");
  const confirmButton = confirmForm.querySelector("button");
  const token = (new URLSearchParams(window.location.search).get("token") || "").trim();
  // Keep the proof in this page's memory, out of subsequent URLs and referrers.
  window.history?.replaceState({}, document.title, window.location.pathname);
  let busy = false;

  const finish = ({ state, eyebrowText, titleText, message, pageTitle, approved = false, retry = false }) => {
    if (panel) panel.dataset.state = state;
    if (eyebrow) eyebrow.textContent = eyebrowText;
    if (title) title.textContent = titleText;
    if (status) {
      status.textContent = message;
      status.setAttribute("role", state === "error" ? "alert" : "status");
    }
    document.getElementById("verificationRecovery").hidden = state !== "error";
    confirmForm.hidden = !retry;
    if (action) {
      action.textContent = approved ? "Sign in" : "Return home";
      action.href = approved ? "login.html" : "index.html";
      action.hidden = false;
    }
    document.title = pageTitle;
    title?.focus();
  };

  const showError = (message, retry = false) => finish({
    state: "error",
    eyebrowText: "Verification unavailable",
    titleText: "We couldn’t verify this email.",
    message,
    pageTitle: "Email verification unavailable – Let’s-ParaConnect",
    retry,
  });

  if (!token) {
    showError("This verification link is missing or invalid.");
    return;
  }

  // Merely opening this page (including an email scanner opening it) must not
  // consume the link. Only the applicant's explicit confirmation submits it.
  panel.dataset.state = "ready";
  confirmForm.hidden = false;
  confirmForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    confirmButton.disabled = true;
    confirmButton.textContent = "Verifying…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let retry = true;
    try {
      const response = await secureFetch("/api/auth/verify-email", {
        method: "POST",
        body: { token },
        noRedirect: true,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        retry = response.status >= 500 || response.status === 429;
        throw new Error(payload?.msg || payload?.error || "This verification link is invalid or expired.");
      }
      if (payload.ok !== true) throw new Error("We couldn’t confirm verification yet. Please try again.");
      finish({
        state: "success",
        eyebrowText: "Email confirmed",
        titleText: payload.alreadyVerified ? "Your email is already verified." : "Your email is verified.",
        message: payload.accountStatus === "approved"
          ? "Your account is ready. You can sign in."
          : payload.accountStatus === "denied"
            ? "Please contact LPC about your application."
            : "We’ll review your application and email you when your account is ready.",
        pageTitle: "Email verified – Let’s-ParaConnect",
        approved: payload.accountStatus === "approved",
      });
    } catch (error) {
      showError(error.name === "AbortError" ? "We couldn’t confirm verification yet. Please try again." : error?.message || "We couldn’t verify this email. Request a new link and try again.", retry);
    } finally {
      clearTimeout(timeout);
      busy = false;
      confirmButton.disabled = false;
      confirmButton.textContent = "Verify email";
    }
  });
});
