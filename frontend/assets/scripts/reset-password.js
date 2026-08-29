document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("resetForm");
  const panel = document.getElementById("resetPanel");
  const eyebrow = document.getElementById("resetEyebrow");
  const title = document.getElementById("resetTitle");
  const lead = document.getElementById("resetLead");
  const message = document.getElementById("message");
  const backLink = document.querySelector(".back-link");
  const submitBtn = form?.querySelector('button[type="submit"]');
  const defaultText = submitBtn?.textContent || "Reset password";
  const token = (new URLSearchParams(window.location.search).get("token") || "").trim();
  const tokenHasExpectedShape = /^[a-f\d]{24}\.[A-Za-z0-9_-]{43}$/i.test(token);

  const setMessage = (text, state = "") => {
    if (!message) return;
    message.textContent = text;
    message.dataset.state = state;
    message.setAttribute("role", state === "error" ? "alert" : "status");
  };

  const showTerminalState = ({ state, eyebrowText, titleText, leadText, messageText, actionText, actionHref }) => {
    if (panel) panel.dataset.state = state;
    if (eyebrow) eyebrow.textContent = eyebrowText;
    if (title) title.textContent = titleText;
    if (lead) lead.textContent = leadText;
    if (form) form.hidden = true;
    setMessage(messageText, state);
    if (backLink) {
      backLink.textContent = actionText;
      backLink.href = actionHref;
    }
  };

  const showUnusableLink = () => {
    showTerminalState({
      state: "error",
      eyebrowText: "Reset link unavailable",
      titleText: "This reset link can’t be used.",
      leadText: "It may be incomplete, expired, or already used. Request a new link and try again.",
      messageText: "Your password has not been changed.",
      actionText: "Request another reset link",
      actionHref: "forgot-password.html",
    });
  };

  if (!tokenHasExpectedShape) {
    showUnusableLink();
    return;
  }

  document.querySelectorAll(".toggle-password").forEach((button) => {
    const targetId = button.getAttribute("data-target");
    const field = targetId ? document.getElementById(targetId) : null;
    if (!field) return;
    button.textContent = "Show password";
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Show password");
    button.addEventListener("click", () => {
      const showPassword = field.type === "password";
      field.type = showPassword ? "text" : "password";
      button.textContent = showPassword ? "Hide password" : "Show password";
      button.setAttribute("aria-pressed", String(showPassword));
      button.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
    });
  });

  async function fetchCsrfToken() {
    try {
      const response = await fetch("/api/csrf", { credentials: "include" });
      if (!response.ok) return "";
      const payload = await response.json().catch(() => ({}));
      return payload?.csrfToken || "";
    } catch {
      return "";
    }
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const newPassword = document.getElementById("newPassword")?.value || "";
    const confirmPassword = document.getElementById("confirmPassword")?.value || "";

    if (newPassword.length < 15 || newPassword.length > 128) {
      setMessage("Use a password between 15 and 128 characters.", "error");
      return;
    }

    if (newPassword !== confirmPassword) {
      setMessage("Passwords do not match.", "error");
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
    }
    setMessage("", "");

    try {
      const csrfToken = await fetchCsrfToken();
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ token, newPassword }),
      });

      const payload = await response.json().catch(() => ({}));

      if (response.ok) {
        showTerminalState({
          state: "success",
          eyebrowText: "Password updated",
          titleText: "Your password is reset.",
          leadText: "Your new password is ready to use.",
          messageText: "Taking you to sign in…",
          actionText: "Sign in now",
          actionHref: "login.html",
        });
        window.setTimeout(() => {
          window.location.href = "login.html";
        }, 3000);
        return;
      }

      const responseMessage = payload.msg || payload.error || "We couldn’t reset your password. Please try again.";
      if (/token|expired|invalid|already used/i.test(responseMessage)) {
        showUnusableLink();
        return;
      }

      setMessage(responseMessage, "error");
    } catch {
      setMessage("We couldn’t reach the server. Please try again.", "error");
    } finally {
      if (!form?.hidden && submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = defaultText;
      }
    }
  });
});
