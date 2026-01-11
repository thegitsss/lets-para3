// /frontend/assets/scripts/reset-password.js

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("resetForm");
  const message = document.getElementById("message");

  // Get token from URL
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get("token");

  if (!token) {
    message.textContent = "Invalid or missing reset token.";
    form.style.display = "none";
    return;
  }

  const toggleButtons = document.querySelectorAll(".toggle-password");
  toggleButtons.forEach((button) => {
    const targetId = button.getAttribute("data-target");
    const field = targetId ? document.getElementById(targetId) : null;
    if (!field) return;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Show password");
    button.addEventListener("click", () => {
      const isHidden = field.type === "password";
      field.type = isHidden ? "text" : "password";
      button.textContent = isHidden ? "hide" : "show";
      button.setAttribute("aria-pressed", String(isHidden));
      button.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    });
  });

  async function fetchCsrfToken() {
    try {
      const res = await fetch("/api/csrf", { credentials: "include" });
      if (!res.ok) return "";
      const data = await res.json().catch(() => ({}));
      return data?.csrfToken || "";
    } catch {
      return "";
    }
  }

  const submitBtn = form?.querySelector('button[type="submit"]');
  const defaultText = submitBtn?.textContent || "Reset Password";

  const scheduleReset = () => {
    if (!form || !submitBtn) return;
    const handler = () => {
      submitBtn.disabled = false;
      submitBtn.textContent = defaultText;
      form.removeEventListener("input", handler);
    };
    form.addEventListener("input", handler, { once: true });
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const newPassword = document.getElementById("newPassword").value.trim();
    const confirmPassword = document.getElementById("confirmPassword").value.trim();

    if (newPassword !== confirmPassword) {
      message.textContent = "Passwords do not match.";
      return;
    }

    const buttonLabel = submitBtn?.textContent || defaultText;
    let restoreButton = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
    }

    try {
      const csrfToken = await fetchCsrfToken();
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
        credentials: "include",
        body: JSON.stringify({ token, newPassword })
      });

      const data = await res.json();

      if (res.ok) {
        message.textContent = "✅ Password reset successful! Redirecting...";
        scheduleReset();
        restoreButton = false;
        setTimeout(() => {
          window.location.href = "login.html";
        }, 3000);
      } else {
        message.textContent = data.error || "❌ Error resetting password.";
      }
    } catch (err) {
      message.textContent = "❌ Network error. Please try again.";
    } finally {
      if (restoreButton && submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = buttonLabel;
      }
    }
  });
});
