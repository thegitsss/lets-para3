document.addEventListener("DOMContentLoaded", async () => {
  const status = document.getElementById("verificationStatus");
  const action = document.getElementById("verificationAction");
  const token = new URLSearchParams(window.location.search).get("token") || "";

  const finish = (message, { success = false } = {}) => {
    if (status) status.textContent = message;
    if (action) {
      action.textContent = success ? "Continue to sign in" : "Request a new verification email";
      action.href = success ? "login.html" : "login.html";
      action.hidden = false;
    }
    if (window.history?.replaceState) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  };

  if (!token) {
    finish("This verification link is missing or invalid.");
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
    if (!response.ok) throw new Error(payload?.msg || payload?.error || "This verification link is invalid or expired.");
    finish("Your email is verified. For security, please sign in again.", { success: true });
  } catch (error) {
    finish(error?.message || "We could not verify this email. Request a new link and try again.");
  }
});
