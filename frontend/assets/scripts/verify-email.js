document.addEventListener("DOMContentLoaded", async () => {
  const panel = document.getElementById("verificationPanel");
  const eyebrow = document.getElementById("verificationEyebrow");
  const title = document.getElementById("verificationTitle");
  const status = document.getElementById("verificationStatus");
  const action = document.getElementById("verificationAction");
  const token = (new URLSearchParams(window.location.search).get("token") || "").trim();

  const finish = ({ state, eyebrowText, titleText, message, pageTitle }) => {
    if (panel) panel.dataset.state = state;
    if (eyebrow) eyebrow.textContent = eyebrowText;
    if (title) title.textContent = titleText;
    if (status) {
      status.textContent = message;
      status.setAttribute("role", state === "error" ? "alert" : "status");
    }
    if (action) {
      action.textContent = "Return home";
      action.href = "index.html";
      action.hidden = false;
    }
    document.title = pageTitle;
    if (window.history?.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  };

  const showError = (message) => finish({
    state: "error",
    eyebrowText: "Verification unavailable",
    titleText: "We couldn’t verify this email.",
    message,
    pageTitle: "Email verification unavailable – Let’s-ParaConnect",
  });

  if (!token) {
    showError("This verification link is missing or invalid.");
    return;
  }

  try {
    const csrfResponse = await fetch("/api/csrf", { credentials: "include" });
    const csrfPayload = await csrfResponse.json().catch(() => ({}));
    const response = await fetch("/api/auth/verify-email", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(csrfPayload?.csrfToken ? { "X-CSRF-Token": csrfPayload.csrfToken } : {}),
      },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.msg || payload?.error || "This verification link is invalid or expired.");
    }
    finish({
      state: "success",
      eyebrowText: "Email confirmed",
      titleText: "Your email is verified.",
      message: "Your application is under review, and we’ll contact you when your LPC account is ready.",
      pageTitle: "Email verified – Let’s-ParaConnect",
    });
  } catch (error) {
    showError(error?.message || "We couldn’t verify this email. Request a new link and try again.");
  }
});
