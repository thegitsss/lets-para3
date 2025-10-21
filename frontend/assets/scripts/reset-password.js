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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const newPassword = document.getElementById("newPassword").value.trim();
    const confirmPassword = document.getElementById("confirmPassword").value.trim();

    if (newPassword !== confirmPassword) {
      message.textContent = "Passwords do not match.";
      return;
    }

    try {
      const res = await fetch("/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword })
      });

      const data = await res.json();

      if (res.ok) {
        message.textContent = "✅ Password reset successful! Redirecting...";
        setTimeout(() => {
          window.location.href = "/frontend/login.html"; // or modal open
        }, 3000);
      } else {
        message.textContent = data.error || "❌ Error resetting password.";
      }
    } catch (err) {
      message.textContent = "❌ Network error. Please try again.";
    }
  });
});
